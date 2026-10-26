// Windows 自动更新宿主模块（tauri-plugin-updater 官方方案的命令包装）。
//
// 设计边界（与 docs/public-ipc-contract-v1.md 保持一致）：
// - 信任链：端点与公钥默认读取嵌入配置，编译期 option_env! 可覆盖；release 不接受
//   运行时环境变量覆盖，插件在 release 下对非 HTTPS 端点直接拒绝。测试
//   构建（debug 断言或 test-hooks feature）允许 127.0.0.1 HTTP 端点做本地闭环。
// - 取消语义：下载运行在可中止的 tokio 任务上，abort 会真正中断底层
//   HTTP 流（官方 JS/Rust API 均无显式取消，这里以丢弃 future 实现真取消）。
// - 安装语义：Windows 上插件 spawn NSIS 安装器（passive + /R 重启）后
//   `std::process::exit(0)`，install 命令不会有响应返回；启动安装器不
//   等于更新成功，成功以重启后版本号变化为准。安装前等待在途导出收束
//   （ExportFlightGuard 计数），置 installing 后新导出被拒；哈希重校验
//   失败清缓存回到 available（前端即有"重新下载"入口）。
// - 跨重启缓存：下载字节经下载期验签后落盘到数据目录 updater-cache/；
//   重启后若清单版本仍新于当前版本则作为离线缓存回到 Available。安装
//   仍需一次在线 check 重建 Update 上下文（插件 API 限制，诚实保留），
//   缓存复用与安装前均以当前清单签名、受信公钥验证实际字节及签名版本；
//   本地 meta 哈希只作损坏提示（插件 install(bytes) 不做二次验签）。
// - 并发互斥：check/download/install 的"判断与置位"在 phase 锁内一次
//   完成（transition_from），双击与并发动作不会穿透产生重复任务；
//   installing 是单向前摇，仅 retract_installing 可以回退（安装器
//   spawn 失败时恢复可重试）。
// - 状态推进只描述阶段；动作失败经 invoke 的 AppError 返回，前端负责呈现。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::domain::{AppError, ErrorCode, UpdaterStatus, UpdaterTargetInfo};

const STATE_EVENT: &str = "updater-state-changed";
const CACHE_DIR_NAME: &str = "updater-cache";
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// 进度事件节流间隔：下载期间每 120ms 至多广播一次状态。
const PROGRESS_THROTTLE: Duration = Duration::from_millis(120);
/// phase 进入 Installing 后给 WebView 渲染"正在安装"留出的短暂窗口。
const INSTALL_EXIT_GRACE: Duration = Duration::from_millis(250);
/// 安装前等待在途导出收束的轮询节奏与上限（30 秒）。
const EXPORT_SETTLE_POLL_INTERVAL: Duration = Duration::from_millis(100);
const EXPORT_SETTLE_POLL_LIMIT: u32 = 300;

const COMPILE_TIME_ENDPOINT: Option<&str> = option_env!("ZINECV_UPDATER_ENDPOINT");
const COMPILE_TIME_PUBKEY: Option<&str> = option_env!("ZINECV_UPDATER_PUBKEY");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedUpdateMeta {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    file: String,
    received: u64,
    /// Download-time digest is a corruption hint, never a trust anchor.
    /// Reuse/install also authenticate actual bytes against the current online
    /// signature, configured public key and signed version; metadata is untrusted.
    sha256: String,
    saved_at: String,
}

struct UpdaterManagerInner {
    /// 状态与任务句柄的锁序固定为 phase → download_task。
    phase: Mutex<UpdaterStatus>,
    /// check 得到的官方 Update 上下文（install 必需；Arc 供下载任务共享）。
    pending: Mutex<Option<Arc<Update>>>,
    download_task: Mutex<Option<(u64, tokio::task::AbortHandle)>>,
    download_generation: AtomicU64,
    export_flight: AtomicUsize,
    cache_dir: PathBuf,
}

/// Rust 侧权威更新器状态。内部 Arc 以便下载任务与宿主命令共享同一实例。
pub struct UpdaterManager(Arc<UpdaterManagerInner>);

impl UpdaterManager {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self(Arc::new(UpdaterManagerInner {
            phase: Mutex::new(UpdaterStatus::Unconfigured {
                current_version: String::new(),
            }),
            pending: Mutex::new(None),
            download_task: Mutex::new(None),
            download_generation: AtomicU64::new(0),
            export_flight: AtomicUsize::new(0),
            cache_dir: data_dir.join(CACHE_DIR_NAME),
        }))
    }

    /// 见 UpdaterManagerInner::set_status。外层仅转发的公共启动入口。
    pub fn restore_cached_update(&self, app: &AppHandle) {
        let current = app.package_info().version.to_string();
        let Some(meta) = self.0.read_cached_meta() else {
            self.0.clear_cache();
            // 已配置构建在无缓存时同样是可用状态；若保持 Unconfigured，
            // 面板会误报"更新功能不可用"且没有手动检查入口（后台自动检查
            // 关闭时无自愈路径）。
            if configured_endpoint_and_pubkey(app).is_some() {
                self.0.set_status(
                    app,
                    UpdaterStatus::Idle {
                        current_version: current,
                    },
                );
            }
            return;
        };
        if !remote_is_newer(&meta.version, &current) {
            self.0.clear_cache();
            self.0.set_status(
                app,
                UpdaterStatus::Idle {
                    current_version: current,
                },
            );
            return;
        }
        self.0.set_status(
            app,
            UpdaterStatus::Available {
                current_version: current,
                target: UpdaterTargetInfo {
                    version: meta.version,
                    notes: meta.notes,
                    pub_date: meta.pub_date,
                    cached: true,
                },
            },
        );
    }
}

impl UpdaterManagerInner {
    fn build_updater(
        &self,
        app: &AppHandle,
    ) -> Result<Option<tauri_plugin_updater::Updater>, AppError> {
        let Some((endpoint, pubkey)) = configured_endpoint_and_pubkey(app) else {
            return Ok(None);
        };
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|error| updater_error(format!("更新端点不可用：{error}"), false))?
            .pubkey(pubkey)
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|error| updater_error(format!("更新器初始化失败：{error}"), false))?;
        Ok(Some(updater))
    }

    fn take_pending_update(&self) -> Option<Arc<Update>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn status(&self) -> UpdaterStatus {
        self.phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_status(&self, app: &AppHandle, next: UpdaterStatus) {
        {
            let mut phase = self
                .phase
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Installing 是单向前摇：进程即将退出，拒绝一切回退覆盖。
            if matches!(&*phase, UpdaterStatus::Installing { .. }) {
                return;
            }
            *phase = next.clone();
        }
        let _ = app.emit(STATE_EVENT, &next);
    }

    fn download_is_current(&self, generation: u64, phase: &UpdaterStatus) -> bool {
        self.download_generation.load(Ordering::SeqCst) == generation
            && matches!(phase, UpdaterStatus::Downloading { .. })
    }

    fn set_download_status(&self, app: &AppHandle, generation: u64, next: UpdaterStatus) -> bool {
        let mut phase = self
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.download_is_current(generation, &phase) {
            return false;
        }
        *phase = next.clone();
        drop(phase);
        let _ = app.emit(STATE_EVENT, &next);
        true
    }

    fn register_download(&self, generation: u64, abort: tokio::task::AbortHandle) {
        let phase = self
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.download_is_current(generation, &phase) {
            *self
                .download_task
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((generation, abort));
        } else {
            // Cancellation before task registration invalidates the generation;
            // the task is aborted rather than silently starting after cancel.
            abort.abort();
        }
    }

    fn retire_download(&self, generation: u64) {
        let mut task = self
            .download_task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if task
            .as_ref()
            .is_some_and(|(active, _)| *active == generation)
        {
            task.take();
        }
    }

    fn cancel_download_locked(
        &self,
        phase: &mut UpdaterStatus,
        current: String,
    ) -> Option<(UpdaterStatus, Option<tokio::task::AbortHandle>)> {
        let UpdaterStatus::Downloading { target, .. } = phase else {
            return None;
        };
        let abort = self
            .download_task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
            .map(|(_, abort)| abort);
        let next = UpdaterStatus::Available {
            current_version: current,
            target: target.clone(),
        };
        // This also invalidates operations that have not published a handle yet.
        self.download_generation.fetch_add(1, Ordering::SeqCst);
        *phase = next.clone();
        Some((next, abort))
    }

    fn complete_download(
        &self,
        app: &AppHandle,
        generation: u64,
        meta: &CachedUpdateMeta,
        bytes: &[u8],
        write_cache: bool,
    ) -> Result<UpdaterStatus, AppError> {
        let mut phase = self
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.download_is_current(generation, &phase) {
            return Err(AppError::new(ErrorCode::Cancelled, "更新下载已取消", false));
        }
        if write_cache {
            if let Err(error) = self.write_cached(meta, bytes) {
                let next = UpdaterStatus::Available {
                    current_version: current_version(app),
                    target: UpdaterTargetInfo {
                        version: meta.version.clone(),
                        notes: meta.notes.clone(),
                        pub_date: meta.pub_date.clone(),
                        cached: false,
                    },
                };
                *phase = next.clone();
                drop(phase);
                let _ = app.emit(STATE_EVENT, &next);
                return Err(updater_error(
                    format!("更新包无法写入本地缓存：{error}"),
                    true,
                ));
            }
        }
        let next = UpdaterStatus::ReadyToInstall {
            current_version: current_version(app),
            target: UpdaterTargetInfo {
                version: meta.version.clone(),
                notes: meta.notes.clone(),
                pub_date: meta.pub_date.clone(),
                cached: true,
            },
            received: bytes.len() as f64,
        };
        *phase = next.clone();
        drop(phase);
        let _ = app.emit(STATE_EVENT, &next);
        Ok(next)
    }

    /// "判断并置位"在同一 phase 锁块内完成：并发动作（双击下载/安装、
    /// 后台检查与手动检查竞争）不会在读后写窗口里穿透。decide 返回
    /// Some(next) 表示允许并已置位；None 表示当前状态不允许，Err 带回
    /// 当前状态快照供调用方区分语义（ReadyToInstall 幂等、Installing
    /// 前摇等）。Installing 前摇期间一切转换被拒。
    #[allow(clippy::result_large_err)]
    fn transition_from(
        &self,
        app: &AppHandle,
        decide: impl FnOnce(&UpdaterStatus) -> Option<UpdaterStatus>,
    ) -> Result<UpdaterStatus, UpdaterStatus> {
        let next = {
            let mut phase = self
                .phase
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            transition_phase_locked(&mut phase, decide)?
        };
        let _ = app.emit(STATE_EVENT, &next);
        Ok(next)
    }

    /// Installing 的唯一回退通道：安装器 spawn 失败等终局错误恢复到
    /// 可重试状态。其余路径维持 set_status 的单向保护。
    fn retract_installing(&self, app: &AppHandle, next: UpdaterStatus) {
        let restored = {
            let mut phase = self
                .phase
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            retract_phase_locked(&mut phase, next.clone())
        };
        if restored {
            let _ = app.emit(STATE_EVENT, &next);
        }
    }

    fn metadata_path(&self, version: &str) -> Option<PathBuf> {
        let safe = sanitized_version(version);
        if safe.is_empty() {
            return None;
        }
        Some(self.cache_dir.join(format!("{safe}.json")))
    }

    fn payload_path(&self, file: &str) -> Option<PathBuf> {
        let name = std::path::Path::new(file).file_name()?.to_str()?;
        if name.contains("..") || name.contains('/') || name.contains('\\') || name.is_empty() {
            return None;
        }
        Some(self.cache_dir.join(name))
    }

    /// 读取当前缓存元数据（不读载荷字节，启动恢复路径保持轻量）。
    fn read_cached_meta(&self) -> Option<CachedUpdateMeta> {
        let entries = std::fs::read_dir(&self.cache_dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<CachedUpdateMeta>(&bytes).ok())
            {
                Some(meta) if self.payload_path(&meta.file).is_some() => return Some(meta),
                _ => {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        None
    }

    fn read_cached_bytes(&self, meta: &CachedUpdateMeta) -> Option<Vec<u8>> {
        std::fs::read(self.payload_path(&meta.file)?).ok()
    }

    fn write_cached(&self, meta: &CachedUpdateMeta, bytes: &[u8]) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.cache_dir)?;
        let meta_path = self
            .metadata_path(&meta.version)
            .ok_or_else(|| std::io::Error::other("unsafe cache version string"))?;
        let payload_path = self
            .payload_path(&meta.file)
            .ok_or_else(|| std::io::Error::other("unsafe cache file name"))?;
        // 载荷与元数据都走临时文件 + rename 原子落盘：中断不会留下指向
        // 半截载荷的元数据。写毕后清掉其他版本的残留缓存。
        let payload_tmp = payload_path.with_extension("payload-tmp");
        std::fs::write(&payload_tmp, bytes)?;
        std::fs::rename(&payload_tmp, &payload_path)?;
        let meta_tmp = meta_path.with_extension("json-tmp");
        let encoded =
            serde_json::to_vec(meta).map_err(|error| std::io::Error::other(error.to_string()))?;
        std::fs::write(&meta_tmp, encoded)?;
        std::fs::rename(&meta_tmp, &meta_path)?;
        if let Ok(entries) = std::fs::read_dir(&self.cache_dir) {
            let keep = payload_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string);
            let keep_meta = meta_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string);
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy().to_string();
                if Some(&name) == keep.as_ref() || Some(&name) == keep_meta.as_ref() {
                    continue;
                }
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    fn clear_cache(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.cache_dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let _ = std::fs::remove_dir(&self.cache_dir);
    }
}

/// 在途导出的 RAII 计数：导出命令（渲染/写盘/PDF）全程持有。acquire
/// 时拒绝 installing 前摇（安装器即将退出进程，新导出必然被截断）。
pub(crate) struct ExportFlightGuard(Arc<UpdaterManagerInner>);

impl ExportFlightGuard {
    pub(crate) fn acquire(manager: &UpdaterManager) -> Result<Self, AppError> {
        {
            let phase = manager
                .0
                .phase
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(&*phase, UpdaterStatus::Installing { .. }) {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "正在安装更新，新的导出已暂停，请稍后重试",
                    true,
                ));
            }
            // Admission and the increment share the installation gate's lock.
            manager.0.export_flight.fetch_add(1, Ordering::SeqCst);
        }
        Ok(ExportFlightGuard(Arc::clone(&manager.0)))
    }
}

impl Drop for ExportFlightGuard {
    fn drop(&mut self) {
        self.0.export_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "app_update/tests.rs"]
mod tests;

#[path = "app_update/trust.rs"]
mod trust;
pub(crate) use trust::*;
#[path = "app_update/download.rs"]
mod download;
pub(crate) use download::*;

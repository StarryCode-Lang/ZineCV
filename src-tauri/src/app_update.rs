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

fn updater_error(message: impl Into<String>, retryable: bool) -> AppError {
    AppError::new(ErrorCode::IpcFailure, message, retryable)
}

/// 测试构建（debug 断言或 test-hooks feature）允许运行时环境变量覆盖
/// 端点/公钥并使用 HTTP 端点；生产 release 构建只认编译期注入的 HTTPS 值。
fn test_overrides_allowed() -> bool {
    cfg!(debug_assertions) || cfg!(feature = "test-hooks")
}

fn configured_endpoint_and_pubkey(app: &AppHandle) -> Option<(Url, String)> {
    let updater_config = app.config().plugins.0.get("updater");
    let config_endpoint = updater_config
        .and_then(|config| config.get("endpoints"))
        .and_then(serde_json::Value::as_array)
        .and_then(|endpoints| endpoints.first())
        .and_then(serde_json::Value::as_str);
    let config_pubkey = updater_config
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str);
    let read = |runtime: Option<String>, compile: Option<&str>| -> Option<String> {
        if test_overrides_allowed() {
            if let Some(value) = runtime {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
        compile
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let endpoint = read(
        std::env::var("ZINECV_UPDATER_ENDPOINT").ok(),
        COMPILE_TIME_ENDPOINT.or(config_endpoint),
    )?;
    let pubkey = read(
        std::env::var("ZINECV_UPDATER_PUBKEY").ok(),
        COMPILE_TIME_PUBKEY.or(config_pubkey),
    )?;
    let url = Url::parse(&endpoint).ok()?;
    let scheme_ok = url.scheme().eq_ignore_ascii_case("https")
        || (test_overrides_allowed() && url.scheme().eq_ignore_ascii_case("http"));
    if !scheme_ok {
        return None;
    }
    Some((url, pubkey))
}

fn remote_is_newer(remote: &str, current: &str) -> bool {
    // 解析失败的版本不参与升级（两侧任一无效都不安装），宁可保守。
    match (
        semver::Version::parse(remote),
        semver::Version::parse(current),
    ) {
        (Ok(remote), Ok(current)) => remote > current,
        _ => false,
    }
}

/// Cached metadata is untrusted local input: its hash can be replaced together
/// with the payload. Authenticate the actual bytes against the current online
/// Update and the configured trust anchor, including the signed version.
fn verify_cached_signature(
    bytes: &[u8],
    signature: &str,
    pubkey: &str,
    announced_version: &str,
) -> Result<(), AppError> {
    let invalid = || updater_error("更新包签名或版本校验失败，请重新下载", false);
    let decode = |value: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(invalid)
    };
    let key = PublicKey::decode(&decode(pubkey)?).map_err(|_| invalid())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|_| invalid())?;
    key.verify(bytes, &signature, true).map_err(|_| invalid())?;
    // Read the trusted comment only after its global signature was verified.
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or_else(invalid)?;
    let signed =
        semver::Version::parse(signed_version.trim_start_matches('v')).map_err(|_| invalid())?;
    let announced =
        semver::Version::parse(announced_version.trim_start_matches('v')).map_err(|_| invalid())?;
    if signed != announced {
        return Err(invalid());
    }
    Ok(())
}

fn authenticate_cached_update(
    app: &AppHandle,
    update: &Update,
    bytes: &[u8],
) -> Result<(), AppError> {
    let (_, pubkey) = configured_endpoint_and_pubkey(app)
        .ok_or_else(|| updater_error("更新器信任配置缺失，请重新检查更新", false))?;
    verify_cached_signature(bytes, &update.signature, &pubkey, &update.version)
}

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

fn sanitized_version(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .collect()
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

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// transition_from 的锁内纯逻辑，独立出来供单元测试直接断言原子语义。
#[allow(clippy::result_large_err)]
fn transition_phase_locked(
    phase: &mut UpdaterStatus,
    decide: impl FnOnce(&UpdaterStatus) -> Option<UpdaterStatus>,
) -> Result<UpdaterStatus, UpdaterStatus> {
    if matches!(phase, UpdaterStatus::Installing { .. }) {
        return Err(phase.clone());
    }
    match decide(phase) {
        Some(next) => {
            *phase = next.clone();
            Ok(next)
        }
        None => Err(phase.clone()),
    }
}

/// retract_installing 的锁内纯逻辑：仅当当前确为 Installing 时回退。
fn retract_phase_locked(phase: &mut UpdaterStatus, next: UpdaterStatus) -> bool {
    if matches!(phase, UpdaterStatus::Installing { .. }) {
        *phase = next;
        true
    } else {
        false
    }
}

fn install_phase(
    phase: &UpdaterStatus,
    target: &UpdaterTargetInfo,
    current: &str,
    exports_in_flight: usize,
) -> Option<UpdaterStatus> {
    match phase {
        UpdaterStatus::ReadyToInstall { target: ready, .. }
            if ready.version == target.version && exports_in_flight == 0 =>
        {
            Some(UpdaterStatus::Installing {
                current_version: current.to_string(),
                target: target.clone(),
            })
        }
        _ => None,
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

/// 安装前等待在途导出归零；超时不改状态（保持 readyToInstall），
/// 错误经返回值呈现，用户可在导出结束后重试安装。
async fn wait_for_export_settle(manager: &UpdaterManagerInner) -> Result<(), AppError> {
    for _ in 0..EXPORT_SETTLE_POLL_LIMIT {
        if manager.export_flight.load(Ordering::SeqCst) == 0 {
            return Ok(());
        }
        tokio::time::sleep(EXPORT_SETTLE_POLL_INTERVAL).await;
    }
    Err(AppError::new(
        ErrorCode::Conflict,
        "导出仍在进行，请等待导出完成后再安装更新",
        true,
    ))
}

fn map_plugin_error(error: tauri_plugin_updater::Error) -> AppError {
    let retryable = matches!(
        &error,
        tauri_plugin_updater::Error::Network(_)
            | tauri_plugin_updater::Error::Reqwest(_)
            | tauri_plugin_updater::Error::Io(_)
    );
    updater_error(format!("更新操作失败：{error}"), retryable)
}

#[tauri::command]
pub(crate) fn app_update_state(
    window: WebviewWindow,
    manager: State<'_, UpdaterManager>,
) -> Result<UpdaterStatus, AppError> {
    crate::require_main_window(&window, "Updater state")?;
    let status = manager.0.status();
    Ok(match status {
        // 未配置的初始占位在命令层替换为真实版本号。
        UpdaterStatus::Unconfigured { current_version } if current_version.is_empty() => {
            UpdaterStatus::Unconfigured {
                current_version: window.app_handle().package_info().version.to_string(),
            }
        }
        other => other,
    })
}

#[tauri::command]
pub(crate) async fn app_update_check(
    app: AppHandle,
    window: WebviewWindow,
    manager: State<'_, UpdaterManager>,
) -> Result<UpdaterStatus, AppError> {
    crate::require_main_window(&window, "Updater check")?;
    let current = current_version(&app);
    let mut cached_target = None;
    {
        // 判断与置 Checking 在同一锁块内完成（transition_from），并发
        // 检查在入口即被拒绝，不留下读后写窗口。
        let checking = |phase: &UpdaterStatus| match phase {
            UpdaterStatus::Checking { .. }
            | UpdaterStatus::Downloading { .. }
            | UpdaterStatus::Installing { .. } => None,
            UpdaterStatus::ReadyToInstall { target, .. } => {
                let next = UpdaterStatus::Checking {
                    current_version: current.clone(),
                };
                cached_target = Some(target.clone());
                Some(next)
            }
            _ => Some(UpdaterStatus::Checking {
                current_version: current.clone(),
            }),
        };
        manager
            .0
            .transition_from(&app, checking)
            .map_err(|_| AppError::new(ErrorCode::Conflict, "更新器正忙，请稍后重试", true))?;
    }
    let updater = match manager.0.build_updater(&app) {
        Ok(updater) => updater,
        Err(error) => {
            manager.0.set_status(
                &app,
                UpdaterStatus::Idle {
                    current_version: current,
                },
            );
            return Err(error);
        }
    };
    let Some(updater) = updater else {
        let status = UpdaterStatus::Unconfigured {
            current_version: current,
        };
        manager.0.set_status(&app, status.clone());
        return Ok(status);
    };
    manager.0.set_status(
        &app,
        UpdaterStatus::Checking {
            current_version: current.clone(),
        },
    );
    match updater.check().await {
        Ok(Some(update)) => {
            let mut update = update;
            // 下载是长传输，不能用检查的超时预算。
            update.timeout = Some(DOWNLOAD_TIMEOUT);
            let target = UpdaterTargetInfo {
                version: update.version.clone(),
                notes: update.body.clone(),
                pub_date: update.date.and_then(|date| {
                    date.format(&time::format_description::well_known::Rfc3339)
                        .ok()
                }),
                cached: false,
            };
            let status = if cached_target.as_ref() == Some(&target) {
                // 清单与已验证缓存指向同一版本：保持待安装，不回退到待下载。
                UpdaterStatus::ReadyToInstall {
                    current_version: current,
                    target,
                    received: manager
                        .0
                        .read_cached_meta()
                        .map(|meta| meta.received as f64)
                        .unwrap_or(0.0),
                }
            } else {
                UpdaterStatus::Available {
                    current_version: current,
                    target,
                }
            };
            *manager
                .0
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(update));
            manager.0.set_status(&app, status.clone());
            Ok(status)
        }
        Ok(None) => {
            *manager
                .0
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            let status = UpdaterStatus::UpToDate {
                current_version: current,
            };
            manager.0.set_status(&app, status.clone());
            Ok(status)
        }
        Err(error) => {
            // 检查失败回到 Idle；错误本身经 Err 返回给动作调用方。
            manager.0.set_status(
                &app,
                UpdaterStatus::Idle {
                    current_version: current,
                },
            );
            Err(map_plugin_error(error))
        }
    }
}

#[tauri::command]
pub(crate) async fn app_update_download(
    app: AppHandle,
    window: WebviewWindow,
    manager: State<'_, UpdaterManager>,
) -> Result<UpdaterStatus, AppError> {
    crate::require_main_window(&window, "Updater download")?;
    let current = current_version(&app);
    let mut generation = 0;
    let target = {
        // 判断与置 Downloading 在同一锁块内完成：并发双击下载只有一个
        // 能置位，另一个被拒绝（或走 readyToInstall 幂等返回）。
        let begin_download = |phase: &UpdaterStatus| match phase {
            UpdaterStatus::ReadyToInstall { .. } => None,
            UpdaterStatus::Available { target, .. } => {
                generation = manager.0.download_generation.fetch_add(1, Ordering::SeqCst) + 1;
                Some(UpdaterStatus::Downloading {
                    current_version: current.clone(),
                    target: target.clone(),
                    received: 0.0,
                    total: None,
                })
            }
            _ => None,
        };
        match manager.0.transition_from(&app, begin_download) {
            Ok(UpdaterStatus::Downloading { target, .. }) => target,
            Ok(_) => unreachable!("begin_download only yields Downloading"),
            Err(UpdaterStatus::ReadyToInstall {
                target, received, ..
            }) => {
                // 已有待安装包：幂等返回，不重复下载。received 用锁内
                // 快照，避免在 gate 锁内做缓存文件 IO。
                return Ok(UpdaterStatus::ReadyToInstall {
                    current_version: current,
                    target,
                    received,
                });
            }
            Err(UpdaterStatus::Installing { .. }) => {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "安装正在进行，无法下载更新",
                    false,
                ));
            }
            Err(_) => {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "当前状态没有可下载的更新",
                    true,
                ));
            }
        }
    };

    let Some(update) = manager.0.take_pending_update() else {
        manager.0.set_download_status(
            &app,
            generation,
            UpdaterStatus::Available {
                current_version: current.clone(),
                target,
            },
        );
        return Err(AppError::new(
            ErrorCode::Conflict,
            "更新上下文缺失，请先检查更新",
            true,
        ));
    };

    // Disk metadata and its hash are only corruption hints. The current online
    // Update signature and configured public key must authenticate cached bytes.
    if let Some(meta) = manager.0.read_cached_meta() {
        if meta.version == target.version {
            if let Some(bytes) = manager.0.read_cached_bytes(&meta) {
                if format!("{:x}", Sha256::digest(&bytes)) == meta.sha256
                    && authenticate_cached_update(&app, &update, &bytes).is_ok()
                {
                    return manager
                        .0
                        .complete_download(&app, generation, &meta, &bytes, false);
                }
            }
        }
    }

    let manager_for_task = UpdaterManager(Arc::clone(&manager.0));
    let app_for_task = app.clone();
    let target_for_task = target.clone();
    let received_counter = Arc::new(AtomicU64::new(0));
    // 0 表示服务器未报告总长（未知下载长度的进度语义由前端呈现）。
    let total_counter = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(Mutex::new(std::time::Instant::now() - PROGRESS_THROTTLE));
    let received_for_chunk = Arc::clone(&received_counter);
    let total_for_chunk = Arc::clone(&total_counter);
    let last_emit_for_chunk = Arc::clone(&last_emit);
    let app_for_chunk = app_for_task.clone();
    let manager_for_chunk = UpdaterManager(Arc::clone(&manager.0));
    let target_for_chunk = target_for_task.clone();
    let task = tokio::spawn(async move {
        let bytes = update
            .download(
                move |chunk, total| {
                    received_for_chunk.fetch_add(chunk as u64, Ordering::Relaxed);
                    if let Some(total) = total {
                        total_for_chunk.store(total, Ordering::Relaxed);
                    }
                    let mut last = last_emit_for_chunk
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if last.elapsed() >= PROGRESS_THROTTLE {
                        *last = std::time::Instant::now();
                        let total_flag = {
                            let value = total_for_chunk.load(Ordering::Relaxed);
                            (value > 0).then_some(value as f64)
                        };
                        manager_for_chunk.0.set_download_status(
                            &app_for_chunk,
                            generation,
                            UpdaterStatus::Downloading {
                                current_version: app_for_chunk.package_info().version.to_string(),
                                target: target_for_chunk.clone(),
                                received: received_for_chunk.load(Ordering::Relaxed) as f64,
                                total: total_flag,
                            },
                        );
                    }
                },
                || {},
            )
            .await;
        match bytes {
            Ok(bytes) => {
                let meta = CachedUpdateMeta {
                    version: target_for_task.version.clone(),
                    notes: target_for_task.notes.clone(),
                    pub_date: target_for_task.pub_date.clone(),
                    file: format!("{}.exe", sanitized_version(&target_for_task.version)),
                    received: bytes.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    saved_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_secs().to_string())
                        .unwrap_or_else(|_| "0".into()),
                };
                manager_for_task
                    .0
                    .complete_download(&app_for_task, generation, &meta, &bytes, true)
            }
            Err(error) => {
                manager_for_task.0.set_download_status(
                    &app_for_task,
                    generation,
                    UpdaterStatus::Available {
                        current_version: app_for_task.package_info().version.to_string(),
                        target: target_for_task.clone(),
                    },
                );
                Err(map_plugin_error(error))
            }
        }
    });
    manager.0.register_download(generation, task.abort_handle());
    let result = task
        .await
        .map_err(|join_error| {
            if join_error.is_cancelled() {
                AppError::new(ErrorCode::Cancelled, "更新下载已取消", false)
            } else {
                updater_error("更新下载任务异常终止", true)
            }
        })
        .and_then(|inner| inner);
    // A cancelled older command cannot clear a newer download's abort handle.
    manager.0.retire_download(generation);
    if manager.0.download_generation.load(Ordering::SeqCst) != generation {
        return Err(AppError::new(ErrorCode::Cancelled, "更新下载已取消", false));
    }
    if result.is_err() {
        // A task panic/abnormal join also has a retryable terminal state.
        manager.0.set_download_status(
            &app,
            generation,
            UpdaterStatus::Available {
                current_version: current,
                target,
            },
        );
    }
    result
}

#[tauri::command]
pub(crate) fn app_update_cancel_download(
    app: AppHandle,
    window: WebviewWindow,
    manager: State<'_, UpdaterManager>,
) -> Result<UpdaterStatus, AppError> {
    crate::require_main_window(&window, "Updater cancel")?;
    let current = current_version(&app);
    // 锁序 phase → download_task：判断与回退在同一 phase 锁块内完成。
    let mut phase = manager
        .0
        .phase
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*phase {
        UpdaterStatus::ReadyToInstall {
            target, received, ..
        } => {
            // 下载已自然完成：取消无意义，如实返回当前待安装状态。
            Ok(UpdaterStatus::ReadyToInstall {
                current_version: current,
                target: target.clone(),
                received: *received,
            })
        }
        UpdaterStatus::Downloading { .. } => {
            let (next, abort) = manager
                .0
                .cancel_download_locked(&mut phase, current)
                .expect("Downloading branch checked while holding phase lock");
            drop(phase);
            if let Some(abort) = abort {
                abort.abort();
            }
            let _ = app.emit(STATE_EVENT, &next);
            Ok(next)
        }
        _ => Err(AppError::new(
            ErrorCode::Conflict,
            "当前没有正在进行的下载",
            false,
        )),
    }
}

#[tauri::command]
pub(crate) async fn app_update_install(
    app: AppHandle,
    window: WebviewWindow,
    manager: State<'_, UpdaterManager>,
) -> Result<(), AppError> {
    crate::require_main_window(&window, "Updater install")?;
    let current = current_version(&app);
    // 初步 gate：只接受 readyToInstall（此处不置位；收束与完整性校验后的
    // 二次原子置位才是双击穿透的闭点）。
    let target = {
        let phase = manager
            .0
            .phase
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*phase {
            UpdaterStatus::ReadyToInstall { target, .. } => target.clone(),
            UpdaterStatus::Installing { .. } => {
                return Err(AppError::new(ErrorCode::Conflict, "安装已在进行", false));
            }
            _ => {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "没有已下载待安装的更新",
                    true,
                ));
            }
        }
    };
    // 收束：等待在途导出完成，exit(0) 不得截断正在写入的导出文件。
    wait_for_export_settle(&manager.0).await?;
    // 完整性重校验（P2-1）：插件 install(bytes) 不做二次验签，缓存字节
    // 必须与下载期验签后记录的哈希一致；不一致清缓存回到 available，
    // 前端在 available 状态即有"重新下载"入口。
    let verify_cache = |meta: Option<CachedUpdateMeta>,
                        bytes: Option<Vec<u8>>|
     -> Result<(CachedUpdateMeta, Vec<u8>), AppError> {
        let Some(meta) = meta else {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "更新缓存丢失，请重新下载",
                true,
            ));
        };
        if meta.version != target.version {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "更新缓存与清单版本不一致，请重新下载",
                true,
            ));
        }
        let Some(bytes) = bytes else {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "更新缓存丢失，请重新下载",
                true,
            ));
        };
        if format!("{:x}", Sha256::digest(&bytes)) != meta.sha256 {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "更新包完整性校验失败，已清除本地缓存，请重新下载",
                true,
            ));
        }
        Ok((meta, bytes))
    };
    let meta = manager.0.read_cached_meta();
    let bytes = meta
        .as_ref()
        .and_then(|meta| manager.0.read_cached_bytes(meta));
    let cache = verify_cache(meta, bytes).and_then(|(meta, bytes)| {
        let update = manager.0.take_pending_update().ok_or_else(|| {
            AppError::new(ErrorCode::Conflict, "更新上下文缺失，请先检查更新", true)
        })?;
        if update.version != target.version {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "更新上下文已变化，请重新检查更新",
                true,
            ));
        }
        authenticate_cached_update(&app, &update, &bytes)?;
        Ok((meta, bytes, update))
    });
    let (_meta, bytes, update) = match cache {
        Ok(cache) => cache,
        Err(error) => {
            // Missing, mismatched and tampered caches all expose redownload.
            // Do not erase a different operation's cache after a concurrent check.
            let mut phase = manager
                .0
                .phase
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(&*phase, UpdaterStatus::ReadyToInstall { target: ready, .. }
                if ready.version == target.version)
            {
                manager.0.clear_cache();
                let next = UpdaterStatus::Available {
                    current_version: current.clone(),
                    target: target.clone(),
                };
                *phase = next.clone();
                drop(phase);
                let _ = app.emit(STATE_EVENT, &next);
            }
            return Err(error);
        }
    };
    // 二次 gate + 原子置位 installing：判断与置位同锁块，双击安装的第
    // 二个请求在此被拒绝。
    // Export admission increments while holding this same phase lock. Recheck
    // after the potentially slow cache read/hash/signature work, not only before it.
    let begin_install = |phase: &UpdaterStatus| {
        install_phase(
            phase,
            &target,
            &current,
            manager.0.export_flight.load(Ordering::SeqCst),
        )
    };
    manager
        .0
        .transition_from(&app, begin_install)
        .map_err(|phase| match phase {
            UpdaterStatus::Installing { .. } => {
                AppError::new(ErrorCode::Conflict, "安装已在进行", false)
            }
            _ => AppError::new(
                ErrorCode::Conflict,
                "更新状态已变化或导出尚未完成，请稍后重试",
                true,
            ),
        })?;
    // 给 WebView 渲染 Installing 状态留出短暂窗口；随后插件 spawn NSIS
    // 安装器（passive + 重启）并 std::process::exit(0)，本命令不再返回。
    tokio::time::sleep(INSTALL_EXIT_GRACE).await;
    match update.install(&bytes) {
        Ok(()) => Ok(()),
        Err(error) => {
            // 安装器 spawn 失败：进程未退出，从 installing 回退到
            // readyToInstall 保持可重试（set_status 的单向保护不放行，
            // 这里是唯一回退通道）。
            manager.0.retract_installing(
                &app,
                UpdaterStatus::ReadyToInstall {
                    current_version: current,
                    target,
                    received: bytes.len() as f64,
                },
            );
            Err(map_plugin_error(error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_target() -> UpdaterTargetInfo {
        UpdaterTargetInfo {
            version: "9.9.9".into(),
            notes: None,
            pub_date: None,
            cached: true,
        }
    }

    fn test_downloading() -> UpdaterStatus {
        UpdaterStatus::Downloading {
            current_version: "1.0.0".into(),
            target: test_target(),
            received: 0.0,
            total: None,
        }
    }

    #[test]
    fn install_gate_rechecks_exports_admitted_after_initial_settle() {
        let manager = UpdaterManager::new(&std::env::temp_dir());
        *manager.0.phase.lock().unwrap() = UpdaterStatus::ReadyToInstall {
            current_version: "1.0.0".into(),
            target: test_target(),
            received: 42.0,
        };
        // The initial settle observed zero, then a new export was admitted
        // while cache verification ran. The final locked gate must refuse it.
        assert_eq!(manager.0.export_flight.load(Ordering::SeqCst), 0);
        let export = ExportFlightGuard::acquire(&manager).unwrap();
        {
            let mut phase = manager.0.phase.lock().unwrap();
            assert!(transition_phase_locked(&mut phase, |phase| install_phase(
                phase,
                &test_target(),
                "1.0.0",
                manager.0.export_flight.load(Ordering::SeqCst),
            ))
            .is_err());
        }
        drop(export);
        {
            let mut phase = manager.0.phase.lock().unwrap();
            assert!(transition_phase_locked(&mut phase, |phase| install_phase(
                phase,
                &test_target(),
                "1.0.0",
                manager.0.export_flight.load(Ordering::SeqCst),
            ))
            .is_ok());
        }
        assert!(ExportFlightGuard::acquire(&manager).is_err());
        assert_eq!(manager.0.export_flight.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancel_before_download_handle_publication_aborts_the_late_task() {
        let manager = UpdaterManager::new(&std::env::temp_dir());
        manager.0.download_generation.store(1, Ordering::SeqCst);
        *manager.0.phase.lock().unwrap() = test_downloading();
        {
            let mut phase = manager.0.phase.lock().unwrap();
            let (_, abort) = manager
                .0
                .cancel_download_locked(&mut phase, "1.0.0".into())
                .unwrap();
            assert!(abort.is_none());
        }
        let task = tokio::spawn(std::future::pending::<()>());
        manager.0.register_download(1, task.abort_handle());
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(manager.0.download_task.lock().unwrap().is_none());
        assert!(!manager.0.download_is_current(1, &test_downloading()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retired_cancelled_download_cannot_clear_new_download_handle() {
        let manager = UpdaterManager::new(&std::env::temp_dir());
        manager.0.download_generation.store(1, Ordering::SeqCst);
        *manager.0.phase.lock().unwrap() = test_downloading();
        let old = tokio::spawn(std::future::pending::<()>());
        manager.0.register_download(1, old.abort_handle());
        let abort = {
            let mut phase = manager.0.phase.lock().unwrap();
            manager
                .0
                .cancel_download_locked(&mut phase, "1.0.0".into())
                .unwrap()
                .1
                .unwrap()
        };
        abort.abort();
        assert!(old.await.unwrap_err().is_cancelled());
        manager.0.download_generation.store(3, Ordering::SeqCst);
        *manager.0.phase.lock().unwrap() = test_downloading();
        let new = tokio::spawn(std::future::pending::<()>());
        manager.0.register_download(3, new.abort_handle());
        manager.0.retire_download(1);
        assert_eq!(
            manager.0.download_task.lock().unwrap().as_ref().unwrap().0,
            3
        );
        assert!(!manager.0.download_is_current(1, &test_downloading()));
        assert!(manager.0.download_is_current(3, &test_downloading()));
        new.abort();
        assert!(new.await.unwrap_err().is_cancelled());
        manager.0.retire_download(3);
    }

    #[test]
    fn cached_payload_and_matching_rewritten_hash_still_require_a_trusted_signature() {
        // Public fixture signed with an isolated test key, never a production key.
        const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVDQzZBNkUyQkFEQUJGMUIKUldRYnY5cTY0cWJHN0l6cEFrUG1zN2RXWExWMDJPM2tFcS9Mc3VrcnpiS3ErRzhKQzNlb3AzMTQK";
        const SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRYnY5cTY0cWJHN0M0MENEbG8vQ01PcFJZeGFGV2ZwSGlpbE1rc0xQYjEyN3ZkSytEZWs0eERnSVdhVU1NVVB6R3JjWGd3RWx5THFSUEdoMDVRb0VFcXR6K1Y5Wm1ndXdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODQ4NjMxCWZpbGU6Y2FjaGUtc2lnbmF0dXJlLWZpeHR1cmUuYmluCXZlcnNpb246OS45LjkKeXBXdWxLVnBZa3duVW9keldncFhCZjlmVHM2aU5XL2NsY1Y1SDZKNXkvejBVdmRpTEplaE85Q0swWnlMeHZOemMzVWlIMmt3NUpZZkU4cVVSRE94Q3c9PQo=";
        let original = b"ZineCV cache authentication regression fixture";
        verify_cached_signature(original, SIGNATURE, PUBKEY, "9.9.9").unwrap();
        assert!(verify_cached_signature(original, SIGNATURE, PUBKEY, "10.0.0").is_err());
        let tampered = b"attacker replaced executable and metadata together";
        let mut meta = CachedUpdateMeta {
            version: "9.9.9".into(),
            notes: None,
            pub_date: None,
            file: "9.9.9.exe".into(),
            received: original.len() as u64,
            sha256: format!("{:x}", Sha256::digest(original)),
            saved_at: "1".into(),
        };
        meta.sha256 = format!("{:x}", Sha256::digest(tampered));
        meta.received = tampered.len() as u64;
        assert_eq!(format!("{:x}", Sha256::digest(tampered)), meta.sha256);
        assert!(verify_cached_signature(tampered, SIGNATURE, PUBKEY, &meta.version).is_err());
    }
    #[test]
    fn cache_meta_roundtrip_and_path_safety() {
        let dir = std::env::temp_dir().join(format!("zinecv-updater-test-{}", std::process::id()));
        let manager = UpdaterManager::new(&dir);
        let meta = CachedUpdateMeta {
            version: "2.0.0-alpha.2".into(),
            notes: Some("说明".into()),
            pub_date: None,
            file: "2.0.0-alpha.2.exe".into(),
            received: 42,
            sha256: format!("{:x}", Sha256::digest(b"payload")),
            saved_at: "1".into(),
        };
        manager.0.write_cached(&meta, b"payload").unwrap();
        let loaded = manager.0.read_cached_meta().expect("cache restored");
        assert_eq!(loaded.version, "2.0.0-alpha.2");
        assert_eq!(
            manager.0.read_cached_bytes(&loaded).as_deref(),
            Some(b"payload".as_slice())
        );
        // 新版本缓存写入后旧缓存被清理，目录里只剩一份。
        let newer = CachedUpdateMeta {
            version: "2.0.0-alpha.3".into(),
            notes: None,
            pub_date: None,
            file: "2.0.0-alpha.3.exe".into(),
            received: 7,
            sha256: format!("{:x}", Sha256::digest(b"next")),
            saved_at: "2".into(),
        };
        manager.0.write_cached(&newer, b"next").unwrap();
        assert_eq!(
            manager.0.read_cached_meta().unwrap().version,
            "2.0.0-alpha.3"
        );
        // file_name() 剥掉目录组件后一切输入都被限制在缓存目录内，不可逃逸。
        let confined = manager.0.payload_path("../escape.exe");
        assert_eq!(
            confined.as_ref().and_then(|path| path.parent()),
            Some(manager.0.cache_dir.as_path())
        );
        let nested = manager.0.payload_path("sub/dir/file.exe");
        assert_eq!(
            nested.as_ref().and_then(|path| path.parent()),
            Some(manager.0.cache_dir.as_path())
        );
        assert!(manager.0.metadata_path("").is_none());
        manager.0.clear_cache();
        assert!(manager.0.read_cached_meta().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn semver_newer_respects_prerelease_order() {
        assert!(remote_is_newer("2.0.0-alpha.1", "2.0.0-alpha.0"));
        assert!(remote_is_newer("2.0.0", "2.0.0-alpha.9"));
        assert!(!remote_is_newer("2.0.0-alpha.0", "2.0.0-alpha.0"));
        assert!(!remote_is_newer("2.0.0-alpha.0", "2.0.0-alpha.1"));
        assert!(!remote_is_newer("not-a-version", "2.0.0-alpha.0"));
    }

    #[test]
    fn gate_transition_is_atomic_and_single_shot() {
        // check/download/install 的"判断并置位"共用 transition_phase_locked：
        // 置位后第二个并发请求看到的是新状态，读后写窗口不存在。
        let target = UpdaterTargetInfo {
            version: "2.0.0-alpha.2".into(),
            notes: None,
            pub_date: None,
            cached: true,
        };
        let mut phase = UpdaterStatus::Available {
            current_version: "2.0.0-alpha.1".into(),
            target: target.clone(),
        };
        let begin_download = |phase: &UpdaterStatus| match phase {
            UpdaterStatus::Available { target, .. } => Some(UpdaterStatus::Downloading {
                current_version: "2.0.0-alpha.1".into(),
                target: target.clone(),
                received: 0.0,
                total: None,
            }),
            _ => None,
        };
        // 第一次置位成功；紧随其后的第二个请求（已置 Downloading）被拒。
        assert!(matches!(
            transition_phase_locked(&mut phase, begin_download),
            Ok(UpdaterStatus::Downloading { .. })
        ));
        assert!(matches!(
            transition_phase_locked(&mut phase, begin_download),
            Err(UpdaterStatus::Downloading { .. })
        ));
        // installing 前摇期间一切常规转换被拒（回退只能走 retract）。
        let begin_install = |phase: &UpdaterStatus| match phase {
            UpdaterStatus::ReadyToInstall { target, .. } if target.version == "2.0.0-alpha.2" => {
                Some(UpdaterStatus::Installing {
                    current_version: "2.0.0-alpha.1".into(),
                    target: target.clone(),
                })
            }
            _ => None,
        };
        phase = UpdaterStatus::ReadyToInstall {
            current_version: "2.0.0-alpha.1".into(),
            target,
            received: 42.0,
        };
        assert!(matches!(
            transition_phase_locked(&mut phase, begin_install),
            Ok(UpdaterStatus::Installing { .. })
        ));
        assert!(matches!(
            transition_phase_locked(&mut phase, begin_install),
            Err(UpdaterStatus::Installing { .. })
        ));
        // 非 installing 状态经 set_status 语义的常规转换不受 retract 影响；
        // retract 只从 installing 回退。
        let ready = UpdaterStatus::ReadyToInstall {
            current_version: "2.0.0-alpha.1".into(),
            target: UpdaterTargetInfo {
                version: "2.0.0-alpha.2".into(),
                notes: None,
                pub_date: None,
                cached: true,
            },
            received: 42.0,
        };
        assert!(retract_phase_locked(&mut phase, ready.clone()));
        assert!(matches!(phase, UpdaterStatus::ReadyToInstall { .. }));
        // 已经回退后再 retract 不生效，避免覆盖后续新状态。
        assert!(!retract_phase_locked(
            &mut phase,
            UpdaterStatus::Idle {
                current_version: "2.0.0-alpha.1".into()
            }
        ));
        assert!(matches!(phase, UpdaterStatus::ReadyToInstall { .. }));
    }

    #[test]
    fn status_serializes_camel_case_with_phase_tag() {
        let payload = serde_json::to_value(UpdaterStatus::UpToDate {
            current_version: "2.0.0-alpha.0".into(),
        })
        .unwrap();
        assert_eq!(payload["phase"], "upToDate");
        assert_eq!(payload["currentVersion"], "2.0.0-alpha.0");
        let downloading = serde_json::to_value(UpdaterStatus::Downloading {
            current_version: "2.0.0-alpha.0".into(),
            target: UpdaterTargetInfo {
                version: "2.0.0-alpha.1".into(),
                notes: None,
                pub_date: None,
                cached: false,
            },
            received: 128.0,
            total: None,
        })
        .unwrap();
        assert_eq!(downloading["phase"], "downloading");
        assert_eq!(downloading["total"], serde_json::Value::Null);
    }
}

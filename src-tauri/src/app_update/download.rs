use super::*;

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

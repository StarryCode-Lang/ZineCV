use super::*;

pub(super) fn updater_error(message: impl Into<String>, retryable: bool) -> AppError {
    AppError::new(ErrorCode::IpcFailure, message, retryable)
}

/// 测试构建（debug 断言或 test-hooks feature）允许运行时环境变量覆盖
/// 端点/公钥并使用 HTTP 端点；生产 release 构建只认编译期注入的 HTTPS 值。
pub(super) fn test_overrides_allowed() -> bool {
    cfg!(debug_assertions) || cfg!(feature = "test-hooks")
}

pub(super) fn configured_endpoint_and_pubkey(app: &AppHandle) -> Option<(Url, String)> {
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

pub(super) fn remote_is_newer(remote: &str, current: &str) -> bool {
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
pub(super) fn verify_cached_signature(
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

pub(super) fn authenticate_cached_update(
    app: &AppHandle,
    update: &Update,
    bytes: &[u8],
) -> Result<(), AppError> {
    let (_, pubkey) = configured_endpoint_and_pubkey(app)
        .ok_or_else(|| updater_error("更新器信任配置缺失，请重新检查更新", false))?;
    verify_cached_signature(bytes, &update.signature, &pubkey, &update.version)
}

pub(super) fn sanitized_version(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        .collect()
}

pub(super) fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// transition_from 的锁内纯逻辑，独立出来供单元测试直接断言原子语义。
#[allow(clippy::result_large_err)]
pub(super) fn transition_phase_locked(
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
pub(super) fn retract_phase_locked(phase: &mut UpdaterStatus, next: UpdaterStatus) -> bool {
    if matches!(phase, UpdaterStatus::Installing { .. }) {
        *phase = next;
        true
    } else {
        false
    }
}

pub(super) fn install_phase(
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

/// 安装前等待在途导出归零；超时不改状态（保持 readyToInstall），
/// 错误经返回值呈现，用户可在导出结束后重试安装。
pub(super) async fn wait_for_export_settle(manager: &UpdaterManagerInner) -> Result<(), AppError> {
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

pub(super) fn map_plugin_error(error: tauri_plugin_updater::Error) -> AppError {
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

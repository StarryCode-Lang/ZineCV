use super::*;

#[tauri::command]
pub(super) fn store_avatar_asset(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    data_url: String,
    previous_hash: Option<String>,
) -> Result<AvatarAsset, AppError> {
    require_main_window(&window, "Avatar asset store")?;
    let (mime, payload) = data_url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(|| validation_error("Avatar must be a base64 data URL"))?;
    if !mime.starts_with("image/") || mime.len() > 64 {
        return Err(validation_error("Unsupported avatar media type"));
    }
    if payload.len() > 8 * 1024 * 1024 {
        return Err(resource_limit_error("Avatar asset exceeds the 8 MiB limit"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| {
            validation_error(format!("Avatar payload is not valid base64: {error}"))
        })?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    {
        let store = lock_store(&store)?;
        require_active_document(&cursor.document_id)?;
        store
            .validate_active_cursor(&cursor)
            .map_err(|error| AppError::from(error).with_context("Avatar document target failed"))?;
        store
            .put_resource(&hash, mime, &bytes, None)
            .map_err(|error| AppError::from(error).with_context("Avatar asset store failed"))?;
        store
            .create_resource_lease(std::slice::from_ref(&hash), 10 * 60)
            .map_err(|error| AppError::from(error).with_context("Avatar asset lease failed"))?;
        if let Some(previous) = previous_hash {
            if previous != hash {
                let _ = store.unlink_resource(&previous, "document-avatar", &cursor.document_id);
            }
        }
    }
    Ok(AvatarAsset {
        hash,
        mime: mime.to_string(),
        data_url,
    })
}

#[tauri::command]
pub(super) fn read_avatar_asset(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    hash: String,
) -> Result<AvatarAsset, AppError> {
    require_main_window(&window, "Avatar asset read")?;
    let store = lock_store(&store)?;
    let (mime, bytes) = store
        .read_resource_bytes(&hash)
        .map_err(|error| AppError::from(error).with_context("Avatar asset read failed"))?
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::NotFound,
                format!("Avatar asset {hash} is missing"),
                false,
            )
        })?;
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    store
        .create_resource_lease(std::slice::from_ref(&hash), 5 * 60)
        .map_err(|error| AppError::from(error).with_context("Asset preview lease failed"))?;
    Ok(AvatarAsset {
        hash,
        mime,
        data_url,
    })
}

#[tauri::command]
pub(super) async fn fit_document_one_page(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
) -> Result<crate::domain::FitResult, AppError> {
    require_main_window(&window, "Fit")?;
    require_active_document(&cursor.document_id)?;
    let manager = render_manager.inner().clone();
    run_frozen_render(
        &store,
        &cursor,
        "Fit snapshot failed",
        "Fit asset lease failed",
        "Typst fit task failed",
        "Fit asset lease cleanup failed",
        move |cursor, document, avatar| manager.fit_document(cursor, document, avatar),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(super) async fn render_document_export(
    store: State<'_, Mutex<Store>>,
    export_sessions: State<'_, crate::export_sessions::ExportSessions>,
    render_manager: State<'_, render_worker::WorkerManager>,
    updater: State<'_, app_update::UpdaterManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    product: Option<crate::domain::ExportProduct>,
    selected_pages: Option<Vec<u32>>,
    dpi: Option<u16>,
) -> Result<crate::domain::NativeExportResult, AppError> {
    require_main_window(&window, "Export render")?;
    // 安装更新器进入退出前摇时不接受新导出；在途导出由安装前收束等待。
    let _export_flight = app_update::ExportFlightGuard::acquire(updater.inner())?;
    if dpi.is_some_and(|dpi| !(72..=300).contains(&dpi)) {
        return Err(AppError::new(
            ErrorCode::Validation,
            "Export DPI must be between 72 and 300",
            false,
        ));
    }
    let (generation, branch_name) = {
        let store = lock_store(&store)?;
        require_active_document(&cursor.document_id)?;
        let graph = store
            .load_version_graph(&cursor.document_id)
            .map_err(AppError::from)?;
        if graph.cursor != cursor {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "导出目标修订已变化",
                false,
            ));
        }
        let branch_name = graph
            .branches
            .iter()
            .find(|branch| branch.id == cursor.branch_id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "导出目标分支不存在", false))?
            .name
            .clone();
        (export_sessions.generation()?, branch_name)
    };
    let manager = render_manager.inner().clone();
    let (export, source) = run_frozen_render(
        &store,
        &cursor,
        "Export bundle snapshot failed",
        "Export bundle asset lease failed",
        "Typst export bundle task failed",
        "Export bundle asset lease cleanup failed",
        move |cursor, document, avatar| {
            let source = crate::export_sessions::frozen_source(&document, branch_name);
            manager
                .render_export_selection(cursor, document, avatar, product, selected_pages, dpi)
                .map(|export| (export, source))
        },
    )
    .await?;
    export_sessions.register(&generation, export, source)
}

#[tauri::command]
pub(super) async fn pick_export_path(
    app: tauri::AppHandle,
    window: WebviewWindow,
    kind: String,
    default_name: String,
) -> Result<Option<String>, AppError> {
    require_main_window(&window, "Export path picking")?;
    let default_name = crate::export_io::sanitize_export_file_name(&default_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::export_io::show_save_dialog(&app, &kind, default_name)
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("保存对话框任务失败：{error}"),
            false,
        )
    })?
}

#[tauri::command]
pub(super) async fn pick_export_directory(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, AppError> {
    require_main_window(&window, "Export directory picking")?;
    tauri::async_runtime::spawn_blocking(move || crate::export_io::show_folder_dialog(&app))
        .await
        .map_err(|error| {
            AppError::new(
                ErrorCode::EngineFailure,
                format!("文件夹选择任务失败：{error}"),
                false,
            )
        })?
}

/// 导出写入的兜底边界。理想方案是把每次写入绑定到本会话保存对话框
/// 批准的路径集合，但现有验证结构不允许：tests/native/webview-export
/// 测试必须绕过交互式对话框直接调用写入（原生 IFileDialog 只能被自动
/// 化取消），绑定会破坏既有测试语义。因此至少拒绝两类与导出会话无关
/// 的高危覆写：携带 `..` 的路径遍历，以及应用数据目录（zinecv.sqlite3、
/// 自动备份与加密密文所在，评审点名的覆写目标）。Windows 路径大小写
/// 不敏感，按小写比较并检查边界分隔符，避免 "data" 误匹配 "data2"。
pub(super) fn export_target_in_data_dir(target: &Path, data_dir: &Path) -> bool {
    let data_prefix = data_dir
        .to_string_lossy()
        .to_lowercase()
        .trim_end_matches(['\\', '/'])
        .to_string();
    let target_text = target.to_string_lossy().to_lowercase();
    if !target_text.starts_with(&data_prefix) {
        return false;
    }
    target_text.len() == data_prefix.len()
        || target_text[data_prefix.len()..].starts_with('\\')
        || target_text[data_prefix.len()..].starts_with('/')
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(super) async fn write_export_file(
    store: State<'_, Mutex<Store>>,
    export_sessions: State<'_, crate::export_sessions::ExportSessions>,
    data_dir: State<'_, DataDir>,
    updater: State<'_, app_update::UpdaterManager>,
    window: WebviewWindow,
    path: String,
    data_base64: String,
    export_id: Option<String>,
    artifact_id: Option<String>,
    write_id: Option<String>,
) -> Result<crate::export_io::ExportWriteOutcome, AppError> {
    require_main_window(&window, "Export write")?;
    // 安装更新器进入退出前摇时不接受新导出；在途导出由安装前收束等待。
    let _export_flight = app_update::ExportFlightGuard::acquire(updater.inner())?;
    if Path::new(&path)
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(validation_error(
            "Export path must not contain '..' components",
        ));
    }
    if export_target_in_data_dir(Path::new(&path), &data_dir.0) {
        return Err(AppError::new(
            ErrorCode::Permission,
            "Export target must stay outside the application data directory",
            false,
        ));
    }
    let bytes = crate::export_io::decode_export_payload(&data_base64)?;
    let prepared = match (export_id, artifact_id, write_id) {
        (None, None, None) => None,
        (Some(export_id), Some(artifact_id), Some(write_id)) => {
            Some(export_sessions.prepare_write(
                &export_id,
                &artifact_id,
                &write_id,
                Path::new(&path),
                &bytes,
            )?)
        }
        _ => {
            return Err(validation_error(
                "exportId、artifactId、writeId 必须同时提供",
            ))
        }
    };
    let io_prepared = prepared.clone();
    let written = tauri::async_runtime::spawn_blocking(move || {
        let target = crate::export_io::validate_export_target(&path)?;
        if let Some(prepared) = io_prepared {
            prepared.write_file(&bytes)
        } else {
            crate::export_io::write_export_bytes(target, &bytes)
        }
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("导出写入任务失败：{error}"),
            false,
        )
    })
    .and_then(|result| result);
    let mut outcome = match written {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Some(prepared) = prepared.as_ref() {
                export_sessions.abandon_write(prepared);
            }
            return Err(error);
        }
    };
    if let Some(prepared) = prepared {
        match lock_store(&store) {
            Ok(mut store) => outcome = export_sessions.finish_write(&mut store, &prepared, outcome),
            Err(error) => {
                export_sessions.abandon_write(&prepared);
                outcome.recording_error = Some(error.message);
            }
        }
    }
    Ok(outcome)
}

#[tauri::command]
pub(super) async fn render_document_preview(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
) -> Result<crate::domain::PreviewResult, AppError> {
    require_main_window(&window, "Preview render")?;
    require_active_document(&cursor.document_id)?;
    let manager = render_manager.inner().clone();
    run_frozen_render(
        &store,
        &cursor,
        "Preview snapshot failed",
        "Preview asset lease failed",
        "Typst preview task failed",
        "Preview asset lease cleanup failed",
        move |cursor, document, avatar| manager.render_preview(cursor, document, avatar),
    )
    .await
}

#[tauri::command]
pub(super) async fn export_document_pdf(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    updater: State<'_, app_update::UpdaterManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
) -> Result<Vec<u8>, AppError> {
    require_main_window(&window, "PDF export")?;
    // 安装更新器进入退出前摇时不接受新导出；在途导出由安装前收束等待。
    let _export_flight = app_update::ExportFlightGuard::acquire(updater.inner())?;
    require_active_document(&cursor.document_id)?;
    let manager = render_manager.inner().clone();
    run_frozen_render(
        &store,
        &cursor,
        "Export snapshot failed",
        "Export asset lease failed",
        "Typst export task failed",
        "Export asset lease cleanup failed",
        move |cursor, document, avatar| manager.render_pdf(cursor, document, avatar),
    )
    .await
}

use super::*;

#[tauri::command]
pub(super) fn document_state(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
) -> Result<ActiveDocumentState, AppError> {
    require_main_window(&window, "Document state")?;
    let store = lock_store(&store)?;
    let active_id = active_document_id()?
        .ok_or_else(|| AppError::new(ErrorCode::Conflict, "文档宿主尚未就绪", false))?;
    let (cursor, document) = store
        .load_active_document(&active_id)
        .map_err(|error| AppError::from(error).with_context("Document load failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Active document is missing", false))?;
    let meta = store
        .document_meta(&active_id)
        .map_err(|error| AppError::from(error).with_context("Document meta load failed"))?
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::NotFound,
                "Active document meta is missing",
                false,
            )
        })?;
    let epoch = require_active_document(&active_id)?;
    Ok(ActiveDocumentState {
        cursor,
        document,
        meta,
        epoch,
        recent_exports: store
            .recent_export_receipts(&active_id)
            .map_err(AppError::from)?,
        pending_import_count: store
            .pending_import_count(&active_id)
            .map_err(AppError::from)?,
    })
}

/// M2：列表页按需载入；默认不含归档。
#[tauri::command]
pub(super) fn document_list(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    include_archived: bool,
) -> Result<DocumentListResult, AppError> {
    require_main_window(&window, "Document list")?;
    let store = lock_store(&store)?;
    Ok(DocumentListResult {
        documents: store
            .list_documents(include_archived)
            .map_err(|error| AppError::from(error).with_context("Document list failed"))?,
        active_document_id: active_document_id()?,
    })
}

#[tauri::command]
pub(super) fn switch_editing_context(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    request: SwitchEditingContextRequest,
) -> Result<SwitchEditingContextResult, AppError> {
    require_main_window(&window, "Editing context switch")?;
    let mut store = lock_store(&store)?;
    require_active_document(&request.expected_cursor.document_id)?;
    if request.source_kind == EditingContextSourceKind::ImportedTemplate
        && !store
            .contains_imported_template(&request.source_id)
            .map_err(|error| AppError::from(error).with_context("Template source check failed"))?
    {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "Imported template source was not found",
            false,
        ));
    }
    store
        .switch_editing_context(
            &request.expected_cursor,
            request.source_kind,
            &request.source_id,
            request.initial_document.as_ref(),
        )
        .map_err(|error| AppError::from(error).with_context("Editing context switch failed"))
}

#[tauri::command]
pub(super) fn version_graph_detailed(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
) -> Result<VersionGraphDetailed, AppError> {
    require_main_window(&window, "Version graph")?;
    let active_id = active_document_id()?
        .ok_or_else(|| AppError::new(ErrorCode::Conflict, "文档宿主尚未就绪", false))?;
    let store = lock_store(&store)?;
    store
        .load_version_graph_detailed(&active_id)
        .map_err(|error| AppError::from(error).with_context("Version graph load failed"))
}

#[tauri::command]
pub(super) fn version_commit_detail(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    commit_id: String,
) -> Result<VersionCommitDetailed, AppError> {
    require_main_window(&window, "Version detail")?;
    let active_id = active_document_id()?
        .ok_or_else(|| AppError::new(ErrorCode::Conflict, "文档宿主尚未就绪", false))?;
    let store = lock_store(&store)?;
    store
        .load_commit_detail(&active_id, &commit_id)
        .map_err(|error| AppError::from(error).with_context("Version detail load failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Version commit was not found", false))
}

#[tauri::command]
pub(super) fn apply_document_command(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    envelope: CommandEnvelope,
) -> Result<CommandResult, AppError> {
    let mut store = lock_store(&store)?;
    require_active_document(&envelope.document_id)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    store
        .apply_command(&actor, envelope)
        .map_err(|error| AppError::from(error).with_context("Document command failed"))
}

/// M2：切换 active 文档。expected_epoch 防双窗口竞态；目标必须存在且未归档。
/// 前端调用前已完成 flush（编辑缓冲 + 草稿 + 客户端队列）。
#[tauri::command]
pub(super) fn switch_active_document(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    request: SwitchActiveDocumentRequest,
) -> Result<SwitchActiveDocumentResult, AppError> {
    require_main_window(&window, "Document switch")?;
    let mut store = lock_store(&store)?;
    switch_active_document_in_store(&mut store, &request)
}

/// The caller owns the Store lock across compare, durable transition and reply.
pub(super) fn switch_active_document_in_store(
    store: &mut Store,
    request: &SwitchActiveDocumentRequest,
) -> Result<SwitchActiveDocumentResult, AppError> {
    let (current_id, current_epoch) = {
        let active = ACTIVE_DOCUMENT
            .lock()
            .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "文档宿主锁失败", false))?;
        (
            active.as_ref().map(|inner| inner.document_id.clone()),
            active.as_ref().map(|inner| inner.epoch).unwrap_or(0),
        )
    };
    if current_id != request.expected_current_id || current_epoch != request.expected_epoch {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "文档状态已变化，请刷新后重试",
            false,
        ));
    }
    let meta = store
        .document_meta(&request.target_document_id)
        .map_err(|error| AppError::from(error).with_context("Document meta load failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Target document is missing", false))?;
    if meta.archived {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "目标文档已归档，请先恢复再切换",
            false,
        ));
    }
    store
        .load_active_document(&request.target_document_id)
        .map_err(|error| AppError::from(error).with_context("Document load failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Target document is missing", false))?;
    let epoch = advance_active_document(store, &request.target_document_id)?;
    let (cursor, document) = store
        .load_active_document(&request.target_document_id)
        .map_err(|error| AppError::from(error).with_context("Document load failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Target document is missing", false))?;
    Ok(SwitchActiveDocumentResult {
        document_id: request.target_document_id.clone(),
        cursor,
        document,
        meta,
        epoch,
    })
}

/// Creation receipts survive retries without reselecting their original target.
#[tauri::command]
pub(super) fn document_create(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: CreateDocumentRequest,
) -> Result<CreateDocumentResult, AppError> {
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    create_document_in_store(&mut store, &actor, &request)
}

pub(super) fn create_document_in_store(
    store: &mut Store,
    actor: &str,
    request: &CreateDocumentRequest,
) -> Result<CreateDocumentResult, AppError> {
    let receipt = match store
        .find_document_creation_receipt(actor, request)
        .map_err(AppError::from)?
    {
        Some(receipt) => receipt,
        None => {
            let mut active = ACTIVE_DOCUMENT
                .lock()
                .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "文档宿主锁失败", false))?;
            let previous = active
                .as_ref()
                .ok_or_else(|| AppError::new(ErrorCode::Conflict, "文档宿主尚未就绪", false))?;
            if previous.document_id != request.expected_current_id
                || previous.epoch != request.expected_epoch
            {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "文档状态已变化，请重新发起创建",
                    false,
                ));
            }
            let epoch = previous
                .epoch
                .checked_add(1)
                .ok_or_else(|| resource_limit_error("Document epoch exhausted"))?;
            let receipt = store
                .create_document_with_receipt(actor, request)
                .map_err(AppError::from)?;
            *active = Some(crate::ActiveDocumentInner {
                document_id: receipt.document_id.clone(),
                epoch,
            });
            receipt
        }
    };
    let active_state = if active_document_id()?.as_deref() == Some(receipt.document_id.as_str()) {
        let (cursor, document) = store
            .load_active_document(&receipt.document_id)
            .map_err(AppError::from)?
            .ok_or_else(|| {
                AppError::new(ErrorCode::NotFound, "Created document is missing", false)
            })?;
        let meta = store
            .document_meta(&receipt.document_id)
            .map_err(AppError::from)?
            .ok_or_else(|| {
                AppError::new(
                    ErrorCode::NotFound,
                    "Created document metadata is missing",
                    false,
                )
            })?;
        Some(ActiveDocumentState {
            cursor,
            document,
            meta,
            epoch: require_active_document(&receipt.document_id)?,
            recent_exports: store
                .recent_export_receipts(&receipt.document_id)
                .map_err(AppError::from)?,
            pending_import_count: store
                .pending_import_count(&receipt.document_id)
                .map_err(AppError::from)?,
        })
    } else {
        None
    };
    Ok(CreateDocumentResult {
        receipt,
        active_state,
    })
}

/// M2：归档/恢复——列表层概念，零资源回收；active 文档不可归档。
#[tauri::command]
pub(super) fn document_archive(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: ArchiveDocumentRequest,
) -> Result<DocumentListResult, AppError> {
    require_main_window(&window, "Document archive")?;
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    let active = active_document_id()?;
    store
        .set_document_archived_with_receipt(
            &actor,
            &request,
            &request.command_id,
            &request.target_document_id,
            (request.expected_archived, true),
            active.as_deref(),
        )
        .map_err(|error| AppError::from(error).with_context("Document archive failed"))?;
    Ok(DocumentListResult {
        documents: store
            .list_documents(true)
            .map_err(|error| AppError::from(error).with_context("Document list failed"))?,
        active_document_id: active_document_id()?,
    })
}

#[tauri::command]
pub(super) fn document_restore(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: RestoreDocumentRequest,
) -> Result<DocumentListResult, AppError> {
    require_main_window(&window, "Document restore")?;
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    let active = active_document_id()?;
    store
        .set_document_archived_with_receipt(
            &actor,
            &request,
            &request.command_id,
            &request.target_document_id,
            (request.expected_archived, false),
            active.as_deref(),
        )
        .map_err(|error| AppError::from(error).with_context("Document restore failed"))?;
    Ok(DocumentListResult {
        documents: store
            .list_documents(true)
            .map_err(|error| AppError::from(error).with_context("Document list failed"))?,
        active_document_id: active_document_id()?,
    })
}

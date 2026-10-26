use super::*;

#[tauri::command]
pub(super) fn document_state(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
) -> Result<DocumentState, AppError> {
    require_main_window(&window, "Document state")?;
    let store = lock_store(&store)?;
    let (cursor, document) = store
        .load_active_document(DEFAULT_DOCUMENT_ID)
        .map_err(|error| AppError::from(error).with_context("Document load failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Default document is missing", false))?;
    Ok(DocumentState { cursor, document })
}

#[tauri::command]
pub(super) fn switch_editing_context(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    request: SwitchEditingContextRequest,
) -> Result<SwitchEditingContextResult, AppError> {
    require_main_window(&window, "Editing context switch")?;
    verify_default_document(&request.expected_cursor)?;
    let mut store = lock_store(&store)?;
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
    let store = lock_store(&store)?;
    store
        .load_version_graph_detailed(DEFAULT_DOCUMENT_ID)
        .map_err(|error| AppError::from(error).with_context("Version graph load failed"))
}

#[tauri::command]
pub(super) fn version_commit_detail(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    commit_id: String,
) -> Result<VersionCommitDetailed, AppError> {
    require_main_window(&window, "Version detail")?;
    let store = lock_store(&store)?;
    store
        .load_commit_detail(DEFAULT_DOCUMENT_ID, &commit_id)
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
    if envelope.document_id != DEFAULT_DOCUMENT_ID {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "Document editing target was not found",
            false,
        ));
    }
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    store
        .apply_command(&actor, envelope)
        .map_err(|error| AppError::from(error).with_context("Document command failed"))
}

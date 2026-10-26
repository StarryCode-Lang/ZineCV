use super::*;

#[tauri::command]
pub(super) fn create_import_draft(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    request: CreateImportDraftRequest,
) -> Result<crate::domain::ImportDraft, AppError> {
    require_main_window(&window, "Import")?;
    let mut store = lock_store(&store)?;
    store
        .create_import_draft(&request)
        .map_err(|error| AppError::from(error).with_context("Import draft creation failed"))
}

#[tauri::command]
pub(super) fn inspect_legacy_migration(
    window: WebviewWindow,
    request: migration::InspectLegacyMigrationRequest,
) -> Result<migration::LegacyMigrationReport, AppError> {
    require_main_window(&window, "Migration inspection")?;
    Ok(migration::inspect(&request))
}

#[tauri::command]
pub(super) fn dry_run_legacy_migration(
    window: WebviewWindow,
    request: migration::DryRunLegacyMigrationRequest,
) -> Result<migration::LegacyMigrationDryRun, AppError> {
    require_main_window(&window, "Migration dry-run")?;
    Ok(migration::dry_run(&request))
}

#[tauri::command]
pub(super) fn inspect_legacy_identity_conflicts(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    request: migration::InspectLegacyIdentityConflictsRequest,
) -> Result<Vec<migration::LegacyMigrationIdentityConflict>, AppError> {
    if window.label() != "main" || request.target_document_id != DEFAULT_DOCUMENT_ID {
        return Err(AppError::new(
            ErrorCode::Permission,
            "Migration identity review is not available for this target",
            false,
        ));
    }
    let store = lock_store(&store)?;
    store
        .inspect_legacy_identity_conflicts(&request)
        .map_err(|error| AppError::from(error).with_context("Legacy identity review failed"))
}

#[tauri::command]
pub(super) fn commit_legacy_migration(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: migration::CommitLegacyMigrationRequest,
) -> Result<migration::LegacyMigrationCommitReceipt, AppError> {
    verify_default_document(&request.cursor)?;
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    store
        .commit_legacy_migration(&actor, &request)
        .map_err(|error| AppError::from(error).with_context("Legacy migration commit failed"))
}

#[tauri::command]
pub(super) fn get_import_draft(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    draft_id: String,
) -> Result<Option<crate::domain::ImportDraft>, AppError> {
    require_main_window(&window, "Import")?;
    let store = lock_store(&store)?;
    store
        .read_import_draft(&draft_id)
        .map_err(|error| AppError::from(error).with_context("Import draft read failed"))
}

#[tauri::command]
pub(super) fn transition_import_draft(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    request: TransitionImportDraftRequest,
) -> Result<crate::domain::ImportDraft, AppError> {
    require_main_window(&window, "Import")?;
    let mut store = lock_store(&store)?;
    store
        .transition_import_draft(&request)
        .map_err(|error| AppError::from(error).with_context("Import draft transition failed"))
}

#[tauri::command]
pub(super) fn apply_import(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: ApplyImportRequest,
) -> Result<CommandResult, AppError> {
    verify_default_document(&request.cursor)?;
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    store
        .apply_import(&actor, &request)
        .map_err(|error| AppError::from(error).with_context("Import commit failed"))
}

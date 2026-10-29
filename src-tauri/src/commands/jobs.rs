use super::*;

#[tauri::command]
pub(super) fn job_material_save(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: UpsertJobMaterialRequest,
) -> Result<JobMaterial, AppError> {
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    if !store
        .has_mutation_receipt(&actor, "job_material_save", &request.command_id, &request)
        .map_err(AppError::from)?
    {
        require_active_document_epoch(&request.document_id, request.expected_epoch)?;
    }
    store
        .save_job_material(&actor, &request)
        .map_err(AppError::from)
}

#[tauri::command]
pub(super) fn job_material_list(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    document_id: String,
) -> Result<JobMaterialListResult, AppError> {
    require_main_window(&window, "Job material list")?;
    lock_store(&store)?
        .list_job_materials(&document_id)
        .map_err(AppError::from)
}

#[tauri::command]
pub(super) fn job_material_delete(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: DeleteJobMaterialRequest,
) -> Result<(), AppError> {
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    if !store
        .has_mutation_receipt(&actor, "job_material_delete", &request.command_id, &request)
        .map_err(AppError::from)?
    {
        require_active_document_epoch(&request.document_id, request.expected_epoch)?;
    }
    store
        .delete_job_material(&actor, &request)
        .map_err(AppError::from)
}

#[tauri::command]
pub(super) fn job_material_link(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: LinkJobMaterialRequest,
) -> Result<DocumentJobLink, AppError> {
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    if !store
        .has_mutation_receipt(&actor, "job_material_link", &request.command_id, &request)
        .map_err(AppError::from)?
    {
        require_active_document(&request.cursor.document_id)?;
    }
    store
        .link_job_material(&actor, &request)
        .map_err(AppError::from)
}

#[tauri::command]
pub(super) fn job_material_unlink(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    window: WebviewWindow,
    request: UnlinkJobMaterialRequest,
) -> Result<(), AppError> {
    let mut store = lock_store(&store)?;
    let actor = trusted_document_actor(&store, &session, &window)?;
    if !store
        .has_mutation_receipt(&actor, "job_material_unlink", &request.command_id, &request)
        .map_err(AppError::from)?
    {
        require_active_document_epoch(&request.document_id, request.expected_epoch)?;
    }
    store
        .unlink_job_material(&actor, &request)
        .map_err(AppError::from)
}

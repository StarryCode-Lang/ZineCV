use super::*;

#[tauri::command]
pub(super) fn commit_version(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    message: String,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "Version commit")?;
    verify_default_document(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .commit_draft(&cursor, &message)
        .map_err(|error| AppError::from(error).with_context("Version commit failed"))
}

#[tauri::command]
pub(super) fn create_version_branch(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    name: String,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "Branch creation")?;
    verify_default_document(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .create_branch_from_current(&cursor, &name)
        .map_err(|error| AppError::from(error).with_context("Branch creation failed"))
}

#[tauri::command]
pub(super) fn switch_version_branch(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    branch_id: String,
    discard_uncommitted: bool,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "Branch switch")?;
    verify_default_document(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .switch_branch(&cursor, &branch_id, discard_uncommitted)
        .map_err(|error| AppError::from(error).with_context("Branch switch failed"))
}

#[tauri::command]
pub(super) fn load_history_commit(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    commit_id: String,
    confirmed: bool,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "History load")?;
    verify_default_document(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .load_commit_into_draft(&cursor, &commit_id, confirmed)
        .map_err(|error| AppError::from(error).with_context("History load failed"))
}

#[tauri::command]
pub(super) fn delete_version_commit(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    commit_id: String,
    confirmed: bool,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "Commit deletion")?;
    verify_default_document(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .delete_commit(&cursor, &commit_id, confirmed)
        .map_err(|error| AppError::from(error).with_context("Commit deletion failed"))
}

#[tauri::command]
pub(super) fn delete_version_branch(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    branch_id: String,
    confirmed: bool,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "Branch deletion")?;
    verify_default_document(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .delete_branch(&cursor, &branch_id, confirmed)
        .map_err(|error| AppError::from(error).with_context("Branch deletion failed"))
}

#[tauri::command]
pub(super) fn replace_version_store(
    store: State<'_, Mutex<Store>>,
    data_dir: State<'_, DataDir>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    replacement: VersionStoreReplacement,
) -> Result<AuthorityCursor, AppError> {
    require_main_window(&window, "Version store replacement")?;
    verify_default_document(&cursor)?;
    // 旧版语义：替换前保留现有版本备份；SQLite 层用 Backup API 生成候选并校验。
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| validation_error(error.to_string()))?
        .as_nanos();
    let backup_path = data_dir
        .0
        .join(format!("zinecv.sqlite3.pre-replace-{suffix}.bak"));
    {
        let store = lock_store(&store)?;
        store
            .backup_to(&backup_path)
            .map_err(|error| AppError::from(error).with_context("Pre-replace backup failed"))?;
    }
    let mut store = lock_store(&store)?;
    store
        .replace_version_store(
            &cursor,
            &replacement.current_branch_id,
            &replacement.branches,
            &replacement.commits,
        )
        .map_err(|error| AppError::from(error).with_context("Version store replacement failed"))
}

#[tauri::command]
pub(super) fn export_database_backup(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
) -> Result<DatabaseBackupPayload, AppError> {
    require_main_window(&window, "Database backup")?;
    lock_store(&store)?
        .export_database_backup()
        .map_err(|error| AppError::from(error).with_context("Full database backup failed"))
}

#[tauri::command]
pub(super) fn restore_database_backup(
    store: State<'_, Mutex<Store>>,
    data_dir: State<'_, DataDir>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
    window: WebviewWindow,
    payload: DatabaseBackupPayload,
) -> Result<DatabaseRestoreResult, AppError> {
    require_main_window(&window, "Database restore")?;
    let active_runs = runs
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorCode::StorageCorrupt, "Agent run lock failed", false))?;
    if !active_runs.is_empty() {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "请先结束正在运行的 Agent，再恢复完整数据库",
            false,
        ));
    }
    runs.1.fetch_add(1, Ordering::AcqRel);
    let mut store = lock_store(&store)?;
    let mut active_session = session.0.lock().map_err(|_| {
        AppError::new(
            ErrorCode::StorageCorrupt,
            "Account session lock failed",
            false,
        )
    })?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| validation_error(error.to_string()))?
        .as_nanos();
    let backup_path = data_dir
        .0
        .join(format!("zinecv.sqlite3.pre-restore-{suffix}.bak"));
    let restore_result = store.restore_database_backup(&payload, &backup_path);
    runs.1.fetch_add(1, Ordering::Release);
    let (schema_version, unavailable_secret_count) = restore_result
        .map_err(|error| AppError::from(error).with_context("Full database restore failed"))?;
    *active_session = None;
    Ok(DatabaseRestoreResult {
        schema_version,
        unavailable_secret_count,
        requires_relogin: true,
        pre_restore_backup_path: backup_path.to_string_lossy().into_owned(),
    })
}

use super::*;

#[tauri::command]
pub(super) fn read_setting(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    key: String,
) -> Result<Option<String>, AppError> {
    require_main_window(&window, "Setting read")?;
    let store = lock_store(&store)?;
    store
        .read_setting(&key)
        .map_err(|error| AppError::from(error).with_context("Setting read failed"))
}

#[tauri::command]
pub(super) fn write_setting(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    key: String,
    value: Option<String>,
) -> Result<(), AppError> {
    require_main_window(&window, "Setting write")?;
    if key.trim().is_empty() || key.len() > 256 {
        return Err(validation_error("Invalid setting key"));
    }
    if let Some(value) = value.as_deref() {
        if value.len() > 4 * 1024 * 1024 {
            return Err(resource_limit_error(
                "Setting value exceeds the 4 MiB limit",
            ));
        }
    }
    let store = lock_store(&store)?;
    store
        .write_setting(&key, value.as_deref())
        .map_err(|error| AppError::from(error).with_context("Setting write failed"))
}

#[tauri::command]
pub(super) fn read_imported_template_catalog(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
) -> Result<Option<storage::ImportedTemplateCatalog>, AppError> {
    require_main_window(&window, "Template catalog read")?;
    let store = lock_store(&store)?;
    store
        .read_imported_template_catalog()
        .map_err(|error| AppError::from(error).with_context("Template catalog read failed"))
}

#[tauri::command]
pub(super) fn write_imported_template_catalog(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    payload_json: String,
    expected_revision: i64,
) -> Result<i64, AppError> {
    require_main_window(&window, "Template catalog write")?;
    if payload_json.len() > 256 * 1024 * 1024 {
        return Err(resource_limit_error(
            "Template catalog exceeds the 256 MiB limit",
        ));
    }
    let mut store = lock_store(&store)?;
    store
        .write_imported_template_catalog(&payload_json, expected_revision)
        .map_err(|error| AppError::from(error).with_context("Template catalog write failed"))
}

#[tauri::command]
pub(super) fn bootstrap_template_activity(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    legacy_json: String,
) -> Result<Vec<storage::TemplateActivity>, AppError> {
    require_main_window(&window, "Template activity bootstrap")?;
    if legacy_json.len() > 4 * 1024 * 1024 {
        return Err(resource_limit_error(
            "Legacy template activity exceeds the 4 MiB limit",
        ));
    }
    let mut store = lock_store(&store)?;
    store
        .bootstrap_template_activity(&legacy_json)
        .map_err(|error| AppError::from(error).with_context("Template activity load failed"))
}

#[tauri::command]
pub(super) fn update_template_activity(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    id: String,
    action: String,
) -> Result<Option<storage::TemplateActivity>, AppError> {
    require_main_window(&window, "Template activity update")?;
    let mut store = lock_store(&store)?;
    store
        .update_template_activity(&id, &action)
        .map_err(|error| AppError::from(error).with_context("Template activity update failed"))
}

#[tauri::command]
pub(super) fn bootstrap_agent_sessions(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    legacy_json: String,
) -> Result<storage::AgentSessionState, AppError> {
    if legacy_json.len() > 8 * 1024 * 1024 {
        return Err(resource_limit_error(
            "Agent session import exceeds the 8 MiB limit",
        ));
    }
    let token = active_token(&session)?;
    let mut store = lock_store(&store)?;
    let account = store
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| "请先登录本机账户".to_string())?;
    store
        .bootstrap_agent_sessions(&account.id, &legacy_json)
        .map_err(|error| AppError::from(error).with_context("Agent session load failed"))
}

#[tauri::command]
pub(super) fn replace_agent_sessions(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    expected_revision: i64,
    payload_json: String,
) -> Result<i64, AppError> {
    if payload_json.len() > 8 * 1024 * 1024 {
        return Err(resource_limit_error(
            "Agent sessions exceed the 8 MiB limit",
        ));
    }
    let token = active_token(&session)?;
    let mut store = lock_store(&store)?;
    let account = store
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| "请先登录本机账户".to_string())?;
    store
        .replace_agent_sessions(&account.id, expected_revision, &payload_json)
        .map_err(|error| AppError::from(error).with_context("Agent session save failed"))
}

#[tauri::command]
pub(super) fn agent_selected_context(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    expected_cursor: AuthorityCursor,
    reference_ids: Vec<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    verify_default_document(&expected_cursor)?;
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    if store
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .is_none()
    {
        return Err("请先登录本机账户".into());
    }
    agent_context::selected_context(&store, &expected_cursor, &reference_ids)
        .map_err(|error| AppError::from(error).with_context("Agent context selection failed"))
}

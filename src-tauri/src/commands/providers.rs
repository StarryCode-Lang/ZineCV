use super::*;

#[tauri::command]
pub(super) fn register_account(
    store: State<'_, Mutex<Store>>,
    email: String,
    password: String,
) -> Result<identity::AccountProfile, AppError> {
    let store = lock_store(&store)?;
    store
        .register_account(&email, &password)
        .map_err(|error| AppError::from(error).with_context("Account register failed"))
}

#[tauri::command]
pub(super) fn login_account(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
    email: String,
    password: String,
) -> Result<identity::AccountProfile, AppError> {
    let store = lock_store(&store)?;
    let token = store
        .login_account(&email, &password)
        .map_err(|error| AppError::from(error).with_context("Account login failed"))?;
    let account = store
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| "Account session was not created".to_string())?;
    let old_token = session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone();
    if let Some(old_token) = &old_token {
        store.logout_account(old_token).map_err(|error| {
            AppError::from(error).with_context("Previous account logout failed")
        })?;
    }
    // Drop the store guard before touching the agent run registry: agent_chat
    // nests lock_store inside the run lock, so acquiring the run lock while
    // holding the store lock can deadlock during login-while-agent-startup.
    drop(store);
    if let Some(old_token) = old_token {
        cancel_runs_for_token(&runs, &old_token)?;
    }
    *session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())? = Some(token);
    Ok(account)
}

#[tauri::command]
pub(super) fn logout_account(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
) -> Result<(), AppError> {
    let token = active_token(&session)?;
    cancel_runs_for_token(&runs, &token)?;
    let store = lock_store(&store)?;
    store
        .logout_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account logout failed"))?;
    drop(store);
    *session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub(super) fn current_account(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<Option<identity::AccountProfile>, AppError> {
    let Some(token) = session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone()
    else {
        return Ok(None);
    };
    lock_store(&store)?
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))
}

#[tauri::command]
pub(super) fn store_provider_key(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    name: String,
    base_url: String,
    model: String,
    key: String,
) -> Result<(), AppError> {
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    store
        .store_provider_key(&token, DEFAULT_PROVIDER_ID, &name, &base_url, &model, &key)
        .map_err(|error| AppError::from(error).with_context("Provider key store failed"))
}

#[tauri::command]
pub(super) fn provider_profile(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<Option<identity::ProviderProfileStatus>, AppError> {
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    store
        .provider_profile(&token, DEFAULT_PROVIDER_ID)
        .map_err(|error| AppError::from(error).with_context("Provider profile failed"))
}

#[tauri::command]
pub(super) fn clear_provider(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<(), AppError> {
    let token = active_token(&session)?;
    lock_store(&store)?
        .clear_provider(&token, DEFAULT_PROVIDER_ID)
        .map_err(|error| AppError::from(error).with_context("Provider clear failed"))
}

pub(super) fn draft_provider_config(
    store: &State<'_, Mutex<Store>>,
    token: &str,
    base_url: String,
    model: String,
    key: String,
) -> Result<gateway::ProviderConfig, AppError> {
    gateway::chat_endpoint(&base_url).map_err(validation_error)?;
    if key.len() > 16 * 1024 || model.len() > 256 {
        return Err(resource_limit_error("模型配置超出长度限制"));
    }
    let store = lock_store(store)?;
    let account = store
        .session_account(token)
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::new(ErrorCode::Permission, "请先登录本机账户", false))?;
    let secret = if key.trim().is_empty() {
        let profile = store
            .provider_profile(token, DEFAULT_PROVIDER_ID)
            .map_err(AppError::from)?;
        if profile
            .as_ref()
            .is_some_and(|profile| profile.base_url == base_url)
        {
            store
                .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
                .map_err(|error| sanitized_storage_error(error, "模型 Key 无法解密，请重新输入"))?
        } else {
            None
        }
    } else {
        Some(key.trim().to_string())
    };
    if base_url.starts_with("https://") && secret.is_none() {
        return Err(validation_error("远程连接需要 API Key"));
    }
    Ok(gateway::ProviderConfig {
        base_url,
        model,
        key: secret,
    })
}

#[tauri::command]
pub(super) async fn provider_models(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    base_url: String,
    key: String,
) -> Result<gateway::ModelDiscovery, AppError> {
    let token = active_token(&session)?;
    let config = draft_provider_config(&store, &token, base_url, String::new(), key)?;
    let result = gateway::discover_models(config)
        .await
        .map_err(|message| AppError::new(ErrorCode::ProviderFailure, message, true))?;
    if !active_token_matches(session.inner(), &token) {
        return Err(AppError::new(ErrorCode::Permission, "账户已切换", false));
    }
    Ok(result)
}

#[tauri::command]
pub(super) async fn provider_test(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    base_url: String,
    model: String,
    key: String,
) -> Result<gateway::ConnectionTest, AppError> {
    if model.trim().is_empty() {
        return Err(AppError::new(ErrorCode::Validation, "请填写模型 ID", false));
    }
    let token = active_token(&session)?;
    let supplied_key_is_blank = key.trim().is_empty();
    let config = draft_provider_config(&store, &token, base_url, model, key)?;
    let tested_base_url = config.base_url.clone();
    let tested_model = config.model.clone();
    let tested_key = config.key.clone();
    let uses_saved_key = {
        let store = lock_store(&store)?;
        let profile = store
            .provider_profile(&token, DEFAULT_PROVIDER_ID)
            .map_err(AppError::from)?;
        profile.is_some_and(|profile| {
            profile.base_url == tested_base_url && profile.model == tested_model
        }) && supplied_key_is_blank
    };
    let result = gateway::test_connection(config)
        .await
        .map_err(|message| AppError::new(ErrorCode::ProviderFailure, message, false))?;
    if !active_token_matches(session.inner(), &token) {
        return Err(AppError::new(ErrorCode::Permission, "账户已切换", false));
    }
    if uses_saved_key {
        let store = lock_store(&store)?;
        let account = store
            .session_account(&token)
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::new(ErrorCode::Permission, "请先登录本机账户", false))?;
        let current_key = store
            .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
            .map_err(|error| sanitized_storage_error(error, "模型 Key 无法解密，请重新输入"))?;
        if current_key == tested_key {
            store
                .set_provider_capability(
                    &token,
                    DEFAULT_PROVIDER_ID,
                    &tested_base_url,
                    &tested_model,
                    result.structured_output,
                )
                .map_err(AppError::from)?;
        }
    }
    Ok(result)
}

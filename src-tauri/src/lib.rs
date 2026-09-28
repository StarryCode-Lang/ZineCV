pub mod domain;
pub mod engine;
pub mod gateway;
pub mod identity;
pub mod storage;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::watch;

use crate::domain::{
    default_resume_document, AuthorityCursor, CommandEnvelope, CommandResult, ResumeDocument,
};
use crate::storage::{ReplaceBranch, ReplaceCommit, Store, VersionGraphDetailed};

const DEFAULT_DOCUMENT_ID: &str = "workspace-default-document";
const DEFAULT_CONTEXT_ID: &str = "workspace-default-context";
const DEFAULT_PROVIDER_ID: &str = "primary";

#[derive(Default)]
struct ActiveSession(Mutex<Option<String>>);

#[derive(Default)]
struct AgentRuns(Mutex<HashMap<String, (String, watch::Sender<bool>)>>);

fn cancel_runs_for_token(runs: &State<'_, AgentRuns>, token: &str) -> Result<(), String> {
    let active = runs
        .0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?;
    for (owner, sender) in active.values() {
        if owner == token {
            let _ = sender.send(true);
        }
    }
    Ok(())
}

fn active_token(session: &State<'_, ActiveSession>) -> Result<String, String> {
    session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone()
        .ok_or_else(|| "请先登录本机账户".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentState {
    cursor: AuthorityCursor,
    document: ResumeDocument,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AvatarAsset {
    hash: String,
    mime: String,
    data_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionStoreReplacement {
    current_branch_id: String,
    branches: Vec<ReplaceBranch>,
    commits: Vec<ReplaceCommit>,
    draft: ResumeDocument,
}

fn lock_store<'a>(
    store: &'a State<'_, Mutex<Store>>,
) -> Result<std::sync::MutexGuard<'a, Store>, String> {
    store
        .lock()
        .map_err(|_| "Document store lock failed".into())
}

#[tauri::command]
fn document_state(store: State<'_, Mutex<Store>>) -> Result<DocumentState, String> {
    let store = lock_store(&store)?;
    let (_, document) = store
        .load_current(DEFAULT_DOCUMENT_ID, DEFAULT_CONTEXT_ID)
        .map_err(|error| format!("Document load failed: {error:?}"))?
        .ok_or_else(|| "Default document is missing".to_string())?;
    let cursor = store
        .load_cursor(DEFAULT_DOCUMENT_ID, DEFAULT_CONTEXT_ID)
        .map_err(|error| format!("Document cursor failed: {error:?}"))?
        .ok_or_else(|| "Default document cursor is missing".to_string())?;
    Ok(DocumentState { cursor, document })
}

#[tauri::command]
fn version_graph_detailed(store: State<'_, Mutex<Store>>) -> Result<VersionGraphDetailed, String> {
    let store = lock_store(&store)?;
    store
        .load_version_graph_detailed(DEFAULT_DOCUMENT_ID)
        .map_err(|error| format!("Version graph load failed: {error:?}"))
}

#[tauri::command]
fn apply_document_command(
    store: State<'_, Mutex<Store>>,
    envelope: CommandEnvelope,
) -> Result<CommandResult, String> {
    if envelope.document_id != DEFAULT_DOCUMENT_ID || envelope.context_id != DEFAULT_CONTEXT_ID {
        return Err("Unsupported document target".into());
    }
    let mut store = lock_store(&store)?;
    store
        .apply_command("local-anonymous", envelope)
        .map_err(|error| format!("Document command failed: {error:?}"))
}

#[tauri::command]
fn commit_version(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    message: String,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .commit_draft(&cursor, &message)
        .map_err(|error| format!("Version commit failed: {error:?}"))
}

#[tauri::command]
fn create_version_branch(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    name: String,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .create_branch_from_current(&cursor, &name)
        .map_err(|error| format!("Branch creation failed: {error:?}"))
}

#[tauri::command]
fn switch_version_branch(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    branch_id: String,
    discard_uncommitted: bool,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .switch_branch(&cursor, &branch_id, discard_uncommitted)
        .map_err(|error| format!("Branch switch failed: {error:?}"))
}

#[tauri::command]
fn load_history_commit(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    commit_id: String,
    confirmed: bool,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .load_commit_into_draft(&cursor, &commit_id, confirmed)
        .map_err(|error| format!("History load failed: {error:?}"))
}

#[tauri::command]
fn delete_version_commit(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    commit_id: String,
    confirmed: bool,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .delete_commit(&cursor, &commit_id, confirmed)
        .map_err(|error| format!("Commit deletion failed: {error:?}"))
}

#[tauri::command]
fn delete_version_branch(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    branch_id: String,
    confirmed: bool,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    let mut store = lock_store(&store)?;
    store
        .delete_branch(&cursor, &branch_id, confirmed)
        .map_err(|error| format!("Branch deletion failed: {error:?}"))
}

#[tauri::command]
fn replace_version_store(
    store: State<'_, Mutex<Store>>,
    data_dir: State<'_, DataDir>,
    cursor: AuthorityCursor,
    replacement: VersionStoreReplacement,
) -> Result<AuthorityCursor, String> {
    verify_default_target(&cursor)?;
    // 旧版语义：替换前保留现有版本备份；SQLite 层用 Backup API 生成候选并校验。
    let backup_path = data_dir.0.join("zinecv.sqlite3.pre-replace.bak");
    {
        let store = lock_store(&store)?;
        store
            .backup_to(&backup_path)
            .map_err(|error| format!("Pre-replace backup failed: {error:?}"))?;
    }
    let mut store = lock_store(&store)?;
    store
        .replace_version_store(
            &cursor,
            &replacement.current_branch_id,
            &replacement.branches,
            &replacement.commits,
            &replacement.draft,
        )
        .map_err(|error| format!("Version store replacement failed: {error:?}"))
}

#[tauri::command]
fn store_avatar_asset(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
    data_url: String,
    previous_hash: Option<String>,
) -> Result<AvatarAsset, String> {
    verify_default_target(&cursor)?;
    let (mime, payload) = data_url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(|| "Avatar must be a base64 data URL".to_string())?;
    if !mime.starts_with("image/") || mime.len() > 64 {
        return Err("Unsupported avatar media type".into());
    }
    if payload.len() > 8 * 1024 * 1024 {
        return Err("Avatar asset exceeds the 8 MiB limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| format!("Avatar payload is not valid base64: {error}"))?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    {
        let store = lock_store(&store)?;
        store
            .put_resource(&hash, mime, &bytes, None)
            .map_err(|error| format!("Avatar asset store failed: {error:?}"))?;
        store
            .set_document_avatar(DEFAULT_DOCUMENT_ID, Some(&hash))
            .map_err(|error| format!("Avatar asset link failed: {error:?}"))?;
        if let Some(previous) = previous_hash {
            if previous != hash {
                let _ = store.unlink_resource(&previous, "document-avatar", DEFAULT_DOCUMENT_ID);
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
fn read_avatar_asset(store: State<'_, Mutex<Store>>, hash: String) -> Result<AvatarAsset, String> {
    let store = lock_store(&store)?;
    let (mime, bytes) = store
        .read_resource_bytes(&hash)
        .map_err(|error| format!("Avatar asset read failed: {error:?}"))?
        .ok_or_else(|| format!("Avatar asset {hash} is missing"))?;
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    Ok(AvatarAsset {
        hash,
        mime,
        data_url,
    })
}

#[tauri::command]
fn export_document_pdf(
    store: State<'_, Mutex<Store>>,
    cursor: AuthorityCursor,
) -> Result<Vec<u8>, String> {
    verify_default_target(&cursor)?;
    let store = lock_store(&store)?;
    let (_, document) = store
        .load_current(DEFAULT_DOCUMENT_ID, DEFAULT_CONTEXT_ID)
        .map_err(|error| format!("Document load failed: {error:?}"))?
        .ok_or_else(|| "Default document is missing".to_string())?;
    engine::render_document_pdf(&document).map_err(|error| format!("Typst export failed: {error}"))
}

#[tauri::command]
fn read_setting(store: State<'_, Mutex<Store>>, key: String) -> Result<Option<String>, String> {
    let store = lock_store(&store)?;
    store
        .read_setting(&key)
        .map_err(|error| format!("Setting read failed: {error:?}"))
}

#[tauri::command]
fn write_setting(
    store: State<'_, Mutex<Store>>,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    if key.trim().is_empty() || key.len() > 256 {
        return Err("Invalid setting key".into());
    }
    if let Some(value) = value.as_deref() {
        if value.len() > 4 * 1024 * 1024 {
            return Err("Setting value exceeds the 4 MiB limit".into());
        }
    }
    let store = lock_store(&store)?;
    store
        .write_setting(&key, value.as_deref())
        .map_err(|error| format!("Setting write failed: {error:?}"))
}

#[tauri::command]
fn register_account(
    store: State<'_, Mutex<Store>>,
    email: String,
    password: String,
) -> Result<identity::AccountProfile, String> {
    let store = lock_store(&store)?;
    store
        .register_account(&email, &password)
        .map_err(|error| format!("Account register failed: {error:?}"))
}

#[tauri::command]
fn login_account(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
    email: String,
    password: String,
) -> Result<identity::AccountProfile, String> {
    let store = lock_store(&store)?;
    let token = store
        .login_account(&email, &password)
        .map_err(|error| format!("Account login failed: {error:?}"))?;
    let account = store
        .session_account(&token)
        .map_err(|error| format!("Account session failed: {error:?}"))?
        .ok_or_else(|| "Account session was not created".to_string())?;
    let old_token = session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone();
    if let Some(old_token) = old_token {
        cancel_runs_for_token(&runs, &old_token)?;
        store
            .logout_account(&old_token)
            .map_err(|error| format!("Previous account logout failed: {error:?}"))?;
    }
    drop(store);
    *session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())? = Some(token);
    Ok(account)
}

#[tauri::command]
fn logout_account(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
) -> Result<(), String> {
    let token = active_token(&session)?;
    cancel_runs_for_token(&runs, &token)?;
    let store = lock_store(&store)?;
    store
        .logout_account(&token)
        .map_err(|error| format!("Account logout failed: {error:?}"))?;
    drop(store);
    *session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn current_account(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<Option<identity::AccountProfile>, String> {
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
        .map_err(|error| format!("Account session failed: {error:?}"))
}

#[tauri::command]
fn store_provider_key(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    name: String,
    base_url: String,
    model: String,
    key: String,
) -> Result<(), String> {
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    store
        .store_provider_key(&token, DEFAULT_PROVIDER_ID, &name, &base_url, &model, &key)
        .map_err(|error| format!("Provider key store failed: {error:?}"))
}

#[tauri::command]
fn provider_profile(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<Option<identity::ProviderProfileStatus>, String> {
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    store
        .provider_profile(&token, DEFAULT_PROVIDER_ID)
        .map_err(|error| format!("Provider profile failed: {error:?}"))
}

#[tauri::command]
fn clear_provider(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<(), String> {
    let token = active_token(&session)?;
    lock_store(&store)?
        .clear_provider(&token, DEFAULT_PROVIDER_ID)
        .map_err(|error| format!("Provider clear failed: {error:?}"))
}

fn draft_provider_config(
    store: &State<'_, Mutex<Store>>,
    token: &str,
    base_url: String,
    model: String,
    key: String,
) -> Result<gateway::ProviderConfig, String> {
    gateway::chat_endpoint(&base_url)?;
    if key.len() > 16 * 1024 || model.len() > 256 {
        return Err("模型配置超出长度限制".into());
    }
    let store = lock_store(store)?;
    let account = store
        .session_account(token)
        .map_err(|_| "账户会话不可用".to_string())?
        .ok_or_else(|| "请先登录本机账户".to_string())?;
    let secret = if key.trim().is_empty() {
        let profile = store
            .provider_profile(token, DEFAULT_PROVIDER_ID)
            .map_err(|_| "模型配置不可用".to_string())?;
        if profile
            .as_ref()
            .is_some_and(|profile| profile.base_url == base_url)
        {
            store
                .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
                .map_err(|_| "模型 Key 无法解密，请重新输入".to_string())?
        } else {
            None
        }
    } else {
        Some(key.trim().to_string())
    };
    if base_url.starts_with("https://") && secret.is_none() {
        return Err("远程连接需要 API Key".into());
    }
    Ok(gateway::ProviderConfig {
        base_url,
        model,
        key: secret,
    })
}

#[tauri::command]
async fn provider_models(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    base_url: String,
    key: String,
) -> Result<gateway::ModelDiscovery, String> {
    let token = active_token(&session)?;
    let config = draft_provider_config(&store, &token, base_url, String::new(), key)?;
    let result = gateway::discover_models(config).await?;
    if active_token(&session).ok().as_deref() != Some(token.as_str()) {
        return Err("账户已切换".into());
    }
    Ok(result)
}

#[tauri::command]
async fn provider_test(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    base_url: String,
    model: String,
    key: String,
) -> Result<gateway::ConnectionTest, String> {
    if model.trim().is_empty() {
        return Err("请填写模型 ID".into());
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
            .map_err(|_| "模型配置不可用".to_string())?;
        profile.is_some_and(|profile| {
            profile.base_url == tested_base_url && profile.model == tested_model
        }) && supplied_key_is_blank
    };
    let result = gateway::test_connection(config).await?;
    if active_token(&session).ok().as_deref() != Some(token.as_str()) {
        return Err("账户已切换".into());
    }
    if uses_saved_key {
        let store = lock_store(&store)?;
        let account = store
            .session_account(&token)
            .map_err(|_| "账户会话不可用".to_string())?
            .ok_or_else(|| "请先登录本机账户".to_string())?;
        let current_key = store
            .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
            .map_err(|_| "模型 Key 无法解密，请重新输入".to_string())?;
        if current_key == tested_key {
            store
                .set_provider_capability(
                    &token,
                    DEFAULT_PROVIDER_ID,
                    &tested_base_url,
                    &tested_model,
                    result.structured_output,
                )
                .map_err(|_| "模型能力状态保存失败".to_string())?;
        }
    }
    Ok(result)
}

#[tauri::command]
async fn agent_chat(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
    run_id: String,
    messages: Vec<gateway::ChatMessage>,
    on_delta: Channel<gateway::ChatDelta>,
) -> Result<gateway::ChatReply, String> {
    if run_id.len() < 8
        || run_id.len() > 80
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid agent run ID".into());
    }
    let token = active_token(&session)?;
    let config = {
        let store = lock_store(&store)?;
        let account = store
            .session_account(&token)
            .map_err(|error| format!("Account session failed: {error:?}"))?
            .ok_or_else(|| "请先登录本机账户".to_string())?;
        let profile = store
            .provider_profile(&token, DEFAULT_PROVIDER_ID)
            .map_err(|error| format!("Provider profile failed: {error:?}"))?
            .ok_or_else(|| "请先配置模型连接".to_string())?;
        let key = store
            .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
            .map_err(|_| "模型 Key 无法解密，请重新输入".to_string())?;
        gateway::ProviderConfig {
            base_url: profile.base_url,
            model: profile.model,
            key,
        }
    };
    let (sender, receiver) = watch::channel(false);
    {
        let mut active = runs
            .0
            .lock()
            .map_err(|_| "Agent run lock failed".to_string())?;
        if active.contains_key(&run_id) {
            return Err("Agent run ID already active".into());
        }
        active.insert(run_id.clone(), (token.clone(), sender));
    }
    let result = gateway::stream_chat(config, messages, receiver, |delta| {
        let _ = on_delta.send(delta);
    })
    .await;
    runs.0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?
        .remove(&run_id);
    if active_token(&session).ok().as_deref() != Some(token.as_str()) {
        return Err("模型请求所属账户已切换".into());
    }
    result
}

#[tauri::command]
fn cancel_agent_run(runs: State<'_, AgentRuns>, run_id: String) -> Result<(), String> {
    let active = runs
        .0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?;
    if let Some((_, sender)) = active.get(&run_id) {
        let _ = sender.send(true);
    }
    Ok(())
}

fn verify_default_target(cursor: &AuthorityCursor) -> Result<(), String> {
    if cursor.document_id != DEFAULT_DOCUMENT_ID || cursor.context_id != DEFAULT_CONTEXT_ID {
        return Err("Unsupported document target".into());
    }
    Ok(())
}

#[derive(Clone)]
struct DataDir(PathBuf);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = if let Some(override_dir) = std::env::var_os("ZINECV_DATA_DIR") {
                let path = std::path::PathBuf::from(override_dir);
                if !path.is_absolute() {
                    return Err(std::io::Error::other("ZINECV_DATA_DIR must be absolute").into());
                }
                path
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_dir)?;
            let mut store = Store::open(&data_dir.join("zinecv.sqlite3")).map_err(|error| {
                std::io::Error::other(format!("Document store open failed: {error:?}"))
            })?;
            let document = default_resume_document(DEFAULT_DOCUMENT_ID).map_err(|error| {
                std::io::Error::other(format!("Default document failed: {error:?}"))
            })?;
            store
                .initialize_document(&document, DEFAULT_CONTEXT_ID)
                .map_err(|error| {
                    std::io::Error::other(format!(
                        "Default document initialization failed: {error:?}"
                    ))
                })?;
            app.manage(Mutex::new(store));
            app.manage(ActiveSession::default());
            app.manage(AgentRuns::default());
            app.manage(DataDir(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            document_state,
            version_graph_detailed,
            apply_document_command,
            commit_version,
            create_version_branch,
            switch_version_branch,
            load_history_commit,
            delete_version_commit,
            delete_version_branch,
            replace_version_store,
            store_avatar_asset,
            read_avatar_asset,
            export_document_pdf,
            read_setting,
            write_setting,
            register_account,
            login_account,
            logout_account,
            current_account,
            store_provider_key,
            provider_profile,
            clear_provider,
            provider_models,
            provider_test,
            agent_chat,
            cancel_agent_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZineCV desktop");
}

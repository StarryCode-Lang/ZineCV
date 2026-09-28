pub mod domain;
pub mod storage;

use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

use crate::domain::{
    default_resume_document, AuthorityCursor, CommandEnvelope, CommandResult, ResumeDocument,
};
use crate::storage::{ReplaceBranch, ReplaceCommit, Store, VersionGraphDetailed};

const DEFAULT_DOCUMENT_ID: &str = "workspace-default-document";
const DEFAULT_CONTEXT_ID: &str = "workspace-default-context";

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
            read_avatar_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZineCV desktop");
}

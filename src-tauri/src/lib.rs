// engine.rs 的版式参数表用单条 serde_json::json! 展开 ~50 个字段，
// 超过宏默认递归深度；此处仅放宽宏展开上限，不改变运行时行为。
#![recursion_limit = "512"]

// C+ P3b/P4：领域五 crate 的模块再出口——宿主 IPC 与 worker 经既有
// `crate::<name>::*` 路径透明使用；实现与测试见 crates/ 内各 crate。
pub use zinecv_agent::{agent, agent_context, gateway};
pub use zinecv_storage::{identity, migration, storage};
mod app_update;
mod clipboard;
pub mod domain;
pub mod engine;
pub mod export_io;
mod font_protocol;
pub mod render_scheduler;
pub mod render_worker;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};
use tokio::sync::watch;

use crate::domain::{
    default_resume_document, AgentProposalInbox, AgentProposalReceipt, AppError,
    ApplyImportRequest, AuthorityCursor, CommandEnvelope, CommandResult, ConfirmProposalRequest,
    CreateImportDraftRequest, DatabaseBackupPayload, DatabaseRestoreResult,
    EditingContextSourceKind, ErrorCode, RejectAgentProposalRequest, ResumeDocument,
    SwitchEditingContextRequest, SwitchEditingContextResult, TransitionImportDraftRequest,
    UndoConfirmedProposalRequest,
};
use crate::storage::{
    ReplaceBranch, ReplaceCommit, StorageError, Store, VersionCommitDetailed, VersionGraphDetailed,
};

const DEFAULT_DOCUMENT_ID: &str = "workspace-default-document";
const DEFAULT_CONTEXT_ID: &str = "workspace-default-context";
const DEFAULT_PROVIDER_ID: &str = "primary";

fn validation_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Validation, message, false)
}

fn resource_limit_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::ResourceLimit, message, false)
}

fn sanitized_storage_error(error: StorageError, message: &str) -> AppError {
    let mut app_error = AppError::from(error);
    app_error.message = message.into();
    app_error
}

#[derive(Default)]
struct ActiveSession(Mutex<Option<String>>);

#[derive(Default)]
struct AgentRuns(
    Mutex<HashMap<String, (String, watch::Sender<bool>)>>,
    AtomicU64,
    AtomicU64,
);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeEvent {
    run_id: String,
    seq: u64,
    epoch: u64,
    kind: String,
    text: Option<String>,
}

#[derive(Default)]
struct AgentRunProgress {
    seq: u64,
    model_calls: u8,
    tool_calls: u8,
    // 流式 delta 聚合缓冲：每 delta 一次 SQLite 整行重写在长回复下是 O(n²)
    // 写放大，改为按 4KB/200ms 阈值批量落库。pending_seq 是缓冲内最大序号；
    // 锁序恒为 progress→store，不反向。
    pending_text: String,
    pending_seq: u64,
    last_flush: Option<std::time::Instant>,
}

// 将聚合缓冲落库。返回 Ok(false) 表示未到阈值无需写入。取走缓冲后发生
// Conflict（lifecycle 已把状态推离 running，或取消已终结 status）说明这批
// 内容所属的运行已不在可持久化状态，交给调用方按语义容忍或记录。
fn flush_agent_delta_buffer(
    progress: &Mutex<AgentRunProgress>,
    store_ref: &std::sync::Mutex<Store>,
    account_id: &str,
    run_id: &str,
    epoch: u64,
    force: bool,
) -> Result<bool, AppError> {
    let (text, seq) = {
        let mut current = progress.lock().map_err(|_| {
            AppError::new(
                ErrorCode::StorageCorrupt,
                "Agent run progress lock failed",
                false,
            )
        })?;
        if current.pending_text.is_empty() {
            return Ok(false);
        }
        if !force
            && current.pending_text.len() < 4096
            && current
                .last_flush
                .map(|at| at.elapsed() < std::time::Duration::from_millis(200))
                .unwrap_or(false)
        {
            return Ok(false);
        }
        current.last_flush = Some(std::time::Instant::now());
        (
            std::mem::take(&mut current.pending_text),
            current.pending_seq,
        )
    };
    lock_store_mutex(store_ref).and_then(|mut store| {
        store
            .persist_agent_run_delta(account_id, run_id, epoch, seq, &text)
            .map_err(|error| AppError::from(error).with_context("Agent stream persistence failed"))
    })?;
    Ok(true)
}

fn cancel_runs_for_token(runs: &State<'_, AgentRuns>, token: &str) -> Result<(), AppError> {
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

fn active_token(session: &State<'_, ActiveSession>) -> Result<String, AppError> {
    session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone()
        .ok_or_else(|| AppError::new(ErrorCode::Permission, "请先登录本机账户", false))
}

fn active_token_matches(session: &ActiveSession, expected: &str) -> bool {
    session
        .0
        .lock()
        .map(|active| active.as_deref() == Some(expected))
        .unwrap_or(false)
}

fn document_actor_for_token(store: &Store, token: Option<&str>) -> Result<String, AppError> {
    let Some(token) = token else {
        return Ok("local-anonymous".into());
    };
    let account = store
        .session_account(token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::Permission,
                "Active account session is invalid",
                false,
            )
        })?;
    Ok(format!("account:{}", account.id))
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionStoreReplacement {
    current_branch_id: String,
    branches: Vec<ReplaceBranch>,
    commits: Vec<ReplaceCommit>,
    // Backward-compatible field for older webviews; never trusted as draft authority.
    #[serde(rename = "draft", default)]
    _draft: Option<ResumeDocument>,
}

fn require_main_window(window: &WebviewWindow, action: &str) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            ErrorCode::Permission,
            format!("{action} is not available in this window"),
            false,
        ));
    }
    Ok(())
}

#[tauri::command]
fn write_clipboard_text(window: WebviewWindow, text: String) -> Result<bool, AppError> {
    require_main_window(&window, "Clipboard write")?;
    if text.len() > 16 * 1024 * 1024 || text.contains('\0') {
        return Err(validation_error(
            "Clipboard text is too large or contains NUL",
        ));
    }
    clipboard::write_text(&window, &text)
}

fn lock_store<'a>(
    store: &'a State<'_, Mutex<Store>>,
) -> Result<std::sync::MutexGuard<'a, Store>, AppError> {
    lock_store_mutex(store)
}

fn lock_store_mutex(store: &Mutex<Store>) -> Result<std::sync::MutexGuard<'_, Store>, AppError> {
    store.lock().map_err(|_| {
        AppError::new(
            ErrorCode::StorageCorrupt,
            "Document store lock failed",
            false,
        )
    })
}

// 冻结快照 → 资源租约 → worker 渲染 → 租约释放的共享骨架；四个渲染命令仅
// 上下文文案与 worker 入口不同，错误码与文案保持与原实现逐字一致。
async fn run_frozen_render<T, F>(
    store: &State<'_, Mutex<Store>>,
    cursor: &AuthorityCursor,
    snapshot_context: &'static str,
    lease_context: &'static str,
    task_failure: &'static str,
    cleanup_context: &'static str,
    render: F,
) -> Result<T, AppError>
where
    F: FnOnce(AuthorityCursor, ResumeDocument, Option<(String, Vec<u8>)>) -> Result<T, String>
        + Send
        + 'static,
    T: Send + 'static,
{
    let (document, avatar, lease_id) = {
        let store = lock_store(store)?;
        let (document, avatar) = store
            .freeze_export(cursor)
            .map_err(|error| AppError::from(error).with_context(snapshot_context))?;
        let lease_id = document
            .basic
            .avatar_asset_id
            .as_ref()
            .map(|hash| store.create_resource_lease(std::slice::from_ref(hash), 15 * 60))
            .transpose()
            .map_err(|error| AppError::from(error).with_context(lease_context))?;
        (document, avatar, lease_id)
    };
    let cursor = cursor.clone();
    let rendered = tauri::async_runtime::spawn_blocking(move || render(cursor, document, avatar))
        .await
        .map_err(|error| {
            AppError::new(
                ErrorCode::EngineFailure,
                format!("{task_failure}: {error}"),
                false,
            )
        })
        .and_then(|result| {
            result.map_err(|message| AppError::new(ErrorCode::EngineFailure, message, false))
        });
    let release = lease_id
        .as_deref()
        .map(|lease_id| {
            lock_store(store)?
                .release_resource_lease(lease_id)
                .map_err(|error| AppError::from(error).with_context(cleanup_context))
        })
        .transpose();
    match (rendered, release) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(result), Ok(_)) => Ok(result),
    }
}

fn agent_proposal_command<T>(
    store: &Mutex<Store>,
    session: &State<'_, ActiveSession>,
    run: impl FnOnce(&mut Store, &str) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let token = active_token(session)?;
    let mut guard = lock_store_mutex(store)?;
    let account = guard
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| AppError::new(ErrorCode::Permission, "请先登录本机账户", false))?;
    run(&mut guard, &account.id)
}

#[tauri::command]
fn document_state(
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
fn switch_editing_context(
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
fn version_graph_detailed(
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
fn version_commit_detail(
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
fn apply_document_command(
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

#[tauri::command]
fn create_import_draft(
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
fn inspect_legacy_migration(
    window: WebviewWindow,
    request: migration::InspectLegacyMigrationRequest,
) -> Result<migration::LegacyMigrationReport, AppError> {
    require_main_window(&window, "Migration inspection")?;
    Ok(migration::inspect(&request))
}

#[tauri::command]
fn dry_run_legacy_migration(
    window: WebviewWindow,
    request: migration::DryRunLegacyMigrationRequest,
) -> Result<migration::LegacyMigrationDryRun, AppError> {
    require_main_window(&window, "Migration dry-run")?;
    Ok(migration::dry_run(&request))
}

#[tauri::command]
fn inspect_legacy_identity_conflicts(
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
fn commit_legacy_migration(
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
fn get_import_draft(
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
fn transition_import_draft(
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
fn apply_import(
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

#[tauri::command]
fn commit_version(
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
fn create_version_branch(
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
fn switch_version_branch(
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
fn load_history_commit(
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
fn delete_version_commit(
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
fn delete_version_branch(
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
fn replace_version_store(
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
fn export_database_backup(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
) -> Result<DatabaseBackupPayload, AppError> {
    require_main_window(&window, "Database backup")?;
    lock_store(&store)?
        .export_database_backup()
        .map_err(|error| AppError::from(error).with_context("Full database backup failed"))
}

#[tauri::command]
fn restore_database_backup(
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

#[tauri::command]
fn store_avatar_asset(
    store: State<'_, Mutex<Store>>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    data_url: String,
    previous_hash: Option<String>,
) -> Result<AvatarAsset, AppError> {
    require_main_window(&window, "Avatar asset store")?;
    verify_default_document(&cursor)?;
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
fn read_avatar_asset(
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
async fn fit_document_one_page(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
) -> Result<crate::domain::FitResult, AppError> {
    require_main_window(&window, "Fit")?;
    verify_default_document(&cursor)?;
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
async fn render_document_export(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    updater: State<'_, app_update::UpdaterManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
    product: Option<crate::domain::ExportProduct>,
    selected_pages: Option<Vec<u32>>,
    dpi: Option<u16>,
) -> Result<crate::domain::ExportResult, AppError> {
    require_main_window(&window, "Export render")?;
    // 安装更新器进入退出前摇时不接受新导出；在途导出由安装前收束等待。
    let _export_flight = app_update::ExportFlightGuard::acquire(updater.inner())?;
    verify_default_document(&cursor)?;
    if dpi.is_some_and(|dpi| !(72..=300).contains(&dpi)) {
        return Err(AppError::new(
            ErrorCode::Validation,
            "Export DPI must be between 72 and 300",
            false,
        ));
    }
    let manager = render_manager.inner().clone();
    run_frozen_render(
        &store,
        &cursor,
        "Export bundle snapshot failed",
        "Export bundle asset lease failed",
        "Typst export bundle task failed",
        "Export bundle asset lease cleanup failed",
        move |cursor, document, avatar| {
            manager.render_export_selection(cursor, document, avatar, product, selected_pages, dpi)
        },
    )
    .await
}

#[tauri::command]
async fn pick_export_path(
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
async fn pick_export_directory(
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
fn export_target_in_data_dir(target: &Path, data_dir: &Path) -> bool {
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
async fn write_export_file(
    data_dir: State<'_, DataDir>,
    updater: State<'_, app_update::UpdaterManager>,
    window: WebviewWindow,
    path: String,
    data_base64: String,
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
    tauri::async_runtime::spawn_blocking(move || {
        let target = crate::export_io::validate_export_target(&path)?;
        crate::export_io::write_export_bytes(target, &bytes)
    })
    .await
    .map_err(|error| {
        AppError::new(
            ErrorCode::EngineFailure,
            format!("导出写入任务失败：{error}"),
            false,
        )
    })?
}

#[tauri::command]
async fn render_document_preview(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
) -> Result<crate::domain::PreviewResult, AppError> {
    require_main_window(&window, "Preview render")?;
    verify_default_document(&cursor)?;
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
async fn export_document_pdf(
    store: State<'_, Mutex<Store>>,
    render_manager: State<'_, render_worker::WorkerManager>,
    updater: State<'_, app_update::UpdaterManager>,
    window: WebviewWindow,
    cursor: AuthorityCursor,
) -> Result<Vec<u8>, AppError> {
    require_main_window(&window, "PDF export")?;
    // 安装更新器进入退出前摇时不接受新导出；在途导出由安装前收束等待。
    let _export_flight = app_update::ExportFlightGuard::acquire(updater.inner())?;
    verify_default_document(&cursor)?;
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

#[tauri::command]
fn read_setting(
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
fn write_setting(
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
fn read_imported_template_catalog(
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
fn write_imported_template_catalog(
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
fn bootstrap_template_activity(
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
fn update_template_activity(
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
fn bootstrap_agent_sessions(
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
fn replace_agent_sessions(
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
fn agent_selected_context(
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

#[tauri::command]
fn register_account(
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
fn login_account(
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
fn logout_account(
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
fn current_account(
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
fn store_provider_key(
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
fn provider_profile(
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
fn clear_provider(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<(), AppError> {
    let token = active_token(&session)?;
    lock_store(&store)?
        .clear_provider(&token, DEFAULT_PROVIDER_ID)
        .map_err(|error| AppError::from(error).with_context("Provider clear failed"))
}

fn draft_provider_config(
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
async fn provider_models(
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
async fn provider_test(
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

// Tauri 命令的参数由 invoke 调用方逐项命名传入；此处的参数数量是
// IPC 契约的一部分，聚合成单一 struct 反而要求前端同步改调用面。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn agent_chat(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    runs: State<'_, AgentRuns>,
    run_id: String,
    session_id: String,
    target_cursor: AuthorityCursor,
    reference_ids: Vec<String>,
    user_text: String,
    skill_id: Option<String>,
    on_event: Channel<AgentRuntimeEvent>,
) -> Result<gateway::ChatReply, AppError> {
    if run_id.len() < 8
        || run_id.len() > 80
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(validation_error("Invalid agent run ID"));
    }
    let database_generation = runs.1.load(Ordering::Acquire);
    let token = active_token(&session)?;
    verify_default_document(&target_cursor)?;
    if session_id.is_empty()
        || session_id.len() > 160
        || user_text.trim().is_empty()
        || user_text.chars().count() > 6_000
        || skill_id.as_ref().is_some_and(|id| id.len() > 80)
    {
        return Err(validation_error("Invalid agent request"));
    }
    agent::trusted_system_message(skill_id.as_deref()).map_err(validation_error)?;
    let epoch = runs
        .2
        .fetch_add(1, Ordering::AcqRel)
        .checked_add(1)
        .filter(|epoch| *epoch > 0)
        .ok_or_else(|| AppError::new(ErrorCode::ResourceLimit, "Agent epoch exhausted", false))?;
    let (account_id, config, tools_enabled) = {
        let store = lock_store(&store)?;
        let account = store
            .session_account(&token)
            .map_err(|error| AppError::from(error).with_context("Account session failed"))?
            .ok_or_else(|| "请先登录本机账户".to_string())?;
        let profile = store
            .provider_profile(&token, DEFAULT_PROVIDER_ID)
            .map_err(|error| AppError::from(error).with_context("Provider profile failed"))?
            .ok_or_else(|| "请先配置模型连接".to_string())?;
        let key = store
            .reveal_provider_secret(&account.id, DEFAULT_PROVIDER_ID)
            .map_err(|error| sanitized_storage_error(error, "模型 Key 无法解密，请重新输入"))?;
        let tools_enabled = profile.capability == "structured";
        (
            account.id,
            gateway::ProviderConfig {
                base_url: profile.base_url,
                model: profile.model,
                key,
            },
            tools_enabled,
        )
    };
    let (sender, receiver) = watch::channel(false);
    let mut selected;
    let messages;
    {
        let mut active = runs
            .0
            .lock()
            .map_err(|_| "Agent run lock failed".to_string())?;
        if runs.1.load(Ordering::Acquire) != database_generation {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "完整数据库已恢复，请重新载入工作区后再运行 Agent",
                false,
            ));
        }
        if active.contains_key(&run_id) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "Agent run ID already active",
                false,
            ));
        }
        {
            let mut store = lock_store(&store)?;
            let persisted = store
                .load_agent_session(&account_id, &session_id)
                .map_err(|error| AppError::from(error).with_context("Agent session load failed"))?
                .ok_or_else(|| validation_error("Agent session does not belong to this account"))?;
            selected = agent_context::selected_context(&store, &target_cursor, &reference_ids)
                .map_err(|error| AppError::from(error).with_context("Agent run target failed"))?;
            for (reference_id, payload) in reference_ids.iter().zip(selected.iter_mut()) {
                payload["referenceId"] = serde_json::Value::String(reference_id.clone());
            }
            messages = agent::build_messages(
                &persisted.messages,
                &user_text,
                skill_id.as_deref(),
                &selected,
            )
            .map_err(validation_error)?;
            store
                .begin_agent_run_with_epoch(
                    &account_id,
                    &run_id,
                    &session_id,
                    &target_cursor,
                    &reference_ids,
                    epoch,
                )
                .map_err(|error| AppError::from(error).with_context("Agent run start failed"))?;
            store
                .update_agent_run_state(&account_id, &run_id, epoch, "running", 0, 0, 0, None)
                .map_err(|error| AppError::from(error).with_context("Agent run state failed"))?;
        }
        active.insert(run_id.clone(), (token.clone(), sender.clone()));
    }
    let progress = Arc::new(Mutex::new(AgentRunProgress::default()));
    let target_changed = Arc::new(AtomicBool::new(false));
    let persistence_error = Arc::new(Mutex::new(None::<String>));
    let observe_cancel = receiver.clone();
    let token_for_events = token.clone();
    let sender_for_delta = sender.clone();
    let progress_for_delta = Arc::clone(&progress);
    let error_for_delta = Arc::clone(&persistence_error);
    let run_for_delta = run_id.clone();
    let account_for_delta = account_id.clone();
    let delta_channel = on_event.clone();
    let lifecycle_channel = on_event.clone();
    let store_ref = store.inner();
    let session_ref = session.inner();
    let runs_ref = runs.inner();
    let target_cursor_for_events = target_cursor.clone();
    let database_generation = runs_ref.1.load(Ordering::Acquire);
    let staged_proposal_events = Arc::new(Mutex::new(Vec::<String>::new()));
    let staged_proposal_events_for_callback = Arc::clone(&staged_proposal_events);
    let result = agent::run_agent_turns(
        config,
        messages,
        &selected,
        &target_cursor,
        &run_id,
        tools_enabled,
        receiver.clone(),
        move |text| {
            if text.is_empty() {
                return;
            }
            if *observe_cancel.borrow()
                || !active_token_matches(session_ref, &token_for_events)
                || runs_ref.1.load(Ordering::Acquire) != database_generation
            {
                let _ = sender_for_delta.send(true);
                return;
            }
            let seq = {
                let mut current = match progress_for_delta.lock() {
                    Ok(current) => current,
                    Err(_) => {
                        let _ = sender_for_delta.send(true);
                        return;
                    }
                };
                current.seq = current.seq.saturating_add(1);
                current.pending_seq = current.seq;
                current.pending_text.push_str(&text);
                current.seq
            };
            if let Err(error) = flush_agent_delta_buffer(
                &progress_for_delta,
                store_ref,
                &account_for_delta,
                &run_for_delta,
                epoch,
                false,
            ) {
                if let Ok(mut saved_error) = error_for_delta.lock() {
                    *saved_error = Some(error.message);
                }
                let _ = sender_for_delta.send(true);
                return;
            }
            let _ = delta_channel.send(AgentRuntimeEvent {
                run_id: run_for_delta.clone(),
                seq,
                epoch,
                kind: "delta".into(),
                text: Some(text),
            });
        },
        {
            let progress = Arc::clone(&progress);
            let target_changed = Arc::clone(&target_changed);
            let persistence_error = Arc::clone(&persistence_error);
            let sender = sender.clone();
            let token_for_events = token.clone();
            let run_id_for_events = run_id.clone();
            let account_id_for_events = account_id.clone();
            let observe_cancel_events = receiver.clone();
            move |kind, detail| {
                if *observe_cancel_events.borrow()
                    || !active_token_matches(session_ref, &token_for_events)
                    || runs_ref.1.load(Ordering::Acquire) != database_generation
                {
                    let _ = sender.send(true);
                    return;
                }
                // lifecycle 会以更大的 seq 写 last_seq；先把聚合缓冲按当前水位
                // 落库，避免之后的 delta flush 因 last_seq 倒挂而被拒绝。
                if let Err(error) = flush_agent_delta_buffer(
                    &progress,
                    store_ref,
                    &account_id_for_events,
                    &run_id_for_events,
                    epoch,
                    true,
                ) {
                    if let Ok(mut saved_error) = persistence_error.lock() {
                        *saved_error = Some(error.message);
                    }
                    let _ = sender.send(true);
                    return;
                }
                if kind == "proposal.ready" {
                    if let Ok(mut staged) = staged_proposal_events_for_callback.lock() {
                        staged.push(detail.to_string());
                    } else {
                        let _ = sender.send(true);
                    }
                    return;
                }
                if kind == "tool.started" {
                    let valid_target = lock_store_mutex(store_ref)
                        .and_then(|store| {
                            store
                                .validate_active_cursor(&target_cursor_for_events)
                                .map_err(AppError::from)
                        })
                        .is_ok();
                    if !valid_target {
                        target_changed.store(true, Ordering::Release);
                        let _ = sender.send(true);
                        return;
                    }
                }
                let (seq, model_calls, tool_calls) = match progress.lock() {
                    Ok(mut current) => {
                        current.seq = current.seq.saturating_add(1);
                        if kind == "model_call.started" {
                            current.model_calls = detail.parse().unwrap_or(current.model_calls);
                        } else if kind == "tool.started" {
                            current.tool_calls = current.tool_calls.saturating_add(1);
                        }
                        (current.seq, current.model_calls, current.tool_calls)
                    }
                    Err(_) => {
                        let _ = sender.send(true);
                        return;
                    }
                };
                let state = if kind == "proposal.ready" {
                    "awaiting_confirmation"
                } else {
                    "running"
                };
                let persist_result = lock_store_mutex(store_ref).and_then(|mut store| {
                    store
                        .update_agent_run_state(
                            &account_id_for_events,
                            &run_id_for_events,
                            epoch,
                            state,
                            seq,
                            model_calls,
                            tool_calls,
                            None,
                        )
                        .map_err(|error| {
                            AppError::from(error).with_context("Agent lifecycle persistence failed")
                        })
                });
                if let Err(error) = persist_result {
                    if let Ok(mut saved_error) = persistence_error.lock() {
                        *saved_error = Some(error.message);
                    }
                    let _ = sender.send(true);
                    return;
                }
                let _ = lifecycle_channel.send(AgentRuntimeEvent {
                    run_id: run_id_for_events.clone(),
                    seq,
                    epoch,
                    kind: kind.to_string(),
                    text: Some(detail.to_string()),
                });
            }
        },
    )
    .await;

    // Removing the active run is the cancel/finish linearization point. A
    // cancellation accepted before this point suppresses proposal persistence;
    // after it, only the explicit proposal transaction can change the draft.
    runs.0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?
        .remove(&run_id);

    let switched = !active_token_matches(session.inner(), &token);
    let stale_target = target_changed.load(Ordering::Acquire);
    // finish_agent_run 终结 status 前落位剩余聚合 delta。lifecycle 已把状态
    // 推离 running（proposal.ready 后的残留）或取消已终结 status 时返回
    // Conflict，缓冲内容属于已终结状态，按无需写入容忍。
    if let Err(error) =
        flush_agent_delta_buffer(&progress, store.inner(), &account_id, &run_id, epoch, true)
    {
        if error.code != ErrorCode::Conflict {
            if let Ok(mut saved) = persistence_error.lock() {
                *saved = Some(error.message);
            }
        }
    }
    let saved_error = persistence_error
        .lock()
        .ok()
        .and_then(|error| error.clone());
    let mut proposal_error = None;
    let mut persisted_proposal_ids = Vec::new();
    if !switched && !*receiver.borrow() && !stale_target && saved_error.is_none() {
        if let Ok(run_result) = &result {
            if !run_result.proposal_drafts.is_empty() {
                match agent::durable_proposal_drafts(
                    &run_result.proposal_drafts,
                    &selected,
                    &run_id,
                ) {
                    Ok(drafts) => {
                        let staged = staged_proposal_events
                            .lock()
                            .map(|values| values.clone())
                            .unwrap_or_default();
                        let draft_ids = drafts
                            .iter()
                            .map(|draft| draft.id.as_str())
                            .collect::<Vec<_>>();
                        let staged_ids = staged.iter().map(String::as_str).collect::<Vec<_>>();
                        if draft_ids != staged_ids {
                            proposal_error = Some(validation_error(
                                "Agent proposal events do not match the durable proposal drafts",
                            ));
                        } else {
                            match lock_store(&store).and_then(|mut store| {
                                store
                                    .create_agent_proposals(
                                        &account_id,
                                        &run_id,
                                        &target_cursor,
                                        &drafts,
                                    )
                                    .map_err(|error| {
                                        AppError::from(error)
                                            .with_context("Agent proposal persistence failed")
                                    })
                            }) {
                                Ok(records) => {
                                    persisted_proposal_ids =
                                        records.into_iter().map(|record| record.id).collect();
                                }
                                Err(error) => proposal_error = Some(error),
                            }
                        }
                    }
                    Err(message) => proposal_error = Some(validation_error(message)),
                }
            }
        }
    }
    let status = if stale_target {
        "failed"
    } else if switched || *receiver.borrow() {
        "cancelled"
    } else if result.is_ok() && proposal_error.is_none() {
        "completed"
    } else {
        "failed"
    };
    lock_store(&store)?
        .finish_agent_run(&account_id, &run_id, status)
        .map_err(|error| AppError::from(error).with_context("Agent run finish failed"))?;
    let (mut seq, model_calls, tool_calls) = {
        let progress = progress.lock().map_err(|_| {
            AppError::new(
                ErrorCode::StorageCorrupt,
                "Agent run progress lock failed",
                false,
            )
        })?;
        (progress.seq, progress.model_calls, progress.tool_calls)
    };
    let lifecycle_state = if !persisted_proposal_ids.is_empty() && status == "completed" {
        "awaiting_confirmation"
    } else {
        status
    };
    if lifecycle_state == "awaiting_confirmation" {
        for proposal_id in &persisted_proposal_ids {
            seq = seq.saturating_add(1);
            lock_store(&store)?
                .update_agent_run_state(
                    &account_id,
                    &run_id,
                    epoch,
                    "awaiting_confirmation",
                    seq,
                    model_calls,
                    tool_calls,
                    None,
                )
                .map_err(|error| {
                    AppError::from(error)
                        .with_context("Agent proposal lifecycle persistence failed")
                })?;
            let _ = on_event.send(AgentRuntimeEvent {
                run_id: run_id.clone(),
                seq,
                epoch,
                kind: "proposal.ready".into(),
                text: Some(proposal_id.clone()),
            });
        }
    }
    seq = seq.saturating_add(1);
    lock_store(&store)?
        .update_agent_run_state(
            &account_id,
            &run_id,
            epoch,
            lifecycle_state,
            seq,
            model_calls,
            tool_calls,
            saved_error
                .as_deref()
                .or_else(|| stale_target.then_some("document target changed during run")),
        )
        .map_err(|error| AppError::from(error).with_context("Agent run terminal state failed"))?;
    let terminal_kind = match status {
        "completed" => "run.completed",
        "cancelled" => "run.cancelled",
        _ => "run.failed",
    };
    let _ = on_event.send(AgentRuntimeEvent {
        run_id: run_id.clone(),
        seq,
        epoch,
        kind: terminal_kind.into(),
        text: saved_error.clone(),
    });
    if switched {
        return Err(AppError::new(
            ErrorCode::Permission,
            "模型请求所属账户已切换",
            false,
        ));
    }
    if stale_target {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "Agent target changed; no late tool result was accepted",
            false,
        ));
    }
    if let Some(message) = saved_error {
        return Err(AppError::new(ErrorCode::StorageCorrupt, message, false));
    }
    if let Some(error) = proposal_error {
        return Err(error);
    }
    result
        .map_err(|message| {
            let code = if message == "模型请求已取消" {
                ErrorCode::Cancelled
            } else {
                ErrorCode::ProviderFailure
            };
            AppError::new(code, message, false)
        })
        .map(|result| result.reply)
}

#[cfg(test)]
mod session_boundary_tests {
    use super::*;

    #[test]
    fn switched_account_invalidates_a_late_request_result() {
        let session = ActiveSession(Mutex::new(Some("account-a-token".into())));
        assert!(active_token_matches(&session, "account-a-token"));
        *session.0.lock().expect("session lock") = Some("account-b-token".into());
        assert!(!active_token_matches(&session, "account-a-token"));
        assert!(active_token_matches(&session, "account-b-token"));
    }

    #[test]
    fn anonymous_document_edit_uses_only_local_storage() {
        let mut store = Store::open_in_memory().expect("isolated store");
        let document = default_resume_document("anonymous-fixture-document")
            .expect("synthetic blank document");
        store
            .initialize_document(&document, "anonymous-fixture-context")
            .expect("initialize document");
        let cursor = store
            .load_cursor(&document.document_id, "anonymous-fixture-context")
            .expect("load cursor")
            .expect("initialized cursor");
        let actor = document_actor_for_token(&store, None).expect("anonymous actor");
        let result = store
            .apply_command(
                &actor,
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "anonymous-edit-fixture".into(),
                    document_id: cursor.document_id.clone(),
                    context_id: cursor.context_id.clone(),
                    expected_revision: cursor.revision,
                    expected_branch_id: cursor.branch_id,
                    expected_head_id: cursor.head_id,
                    payload: crate::domain::DomainCommand::SetDocumentTitle {
                        title: "匿名离线编辑".into(),
                    },
                },
            )
            .expect("local durable edit without authentication or network");
        assert_eq!(actor, "local-anonymous");
        assert_eq!(result.document.title, "匿名离线编辑");
        assert!(result.durable);
        let account_count: i64 = store
            .connection()
            .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))
            .expect("account count");
        assert_eq!(account_count, 0);
    }
}

#[tauri::command]
fn list_agent_proposals(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<AgentProposalInbox, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        store
            .list_agent_proposals(account_id)
            .map_err(|error| AppError::from(error).with_context("Agent proposals load failed"))
    })
}

#[tauri::command]
fn confirm_proposal(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    request: ConfirmProposalRequest,
) -> Result<AgentProposalReceipt, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        store
            .confirm_agent_proposal(account_id, &request)
            .map_err(|error| AppError::from(error).with_context("Proposal confirmation failed"))
    })
}

#[tauri::command]
fn reject_proposal(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    request: RejectAgentProposalRequest,
) -> Result<AgentProposalReceipt, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        store
            .reject_agent_proposal(account_id, &request)
            .map_err(|error| AppError::from(error).with_context("Proposal rejection failed"))
    })
}

#[tauri::command]
fn undo_confirmed_proposal(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
    request: UndoConfirmedProposalRequest,
) -> Result<AgentProposalReceipt, AppError> {
    agent_proposal_command(&store, &session, |store, account_id| {
        store
            .undo_agent_proposal(account_id, &request)
            .map_err(|error| AppError::from(error).with_context("Proposal undo failed"))
    })
}

#[tauri::command]
fn list_agent_runs(
    store: State<'_, Mutex<Store>>,
    session: State<'_, ActiveSession>,
) -> Result<Vec<storage::AgentRunRecord>, AppError> {
    let token = active_token(&session)?;
    let store = lock_store(&store)?;
    let account = store
        .session_account(&token)
        .map_err(|error| AppError::from(error).with_context("Account session failed"))?
        .ok_or_else(|| "请先登录本机账户".to_string())?;
    store
        .list_agent_runs(&account.id)
        .map_err(|error| AppError::from(error).with_context("Agent runs load failed"))
}

#[tauri::command]
fn cancel_agent_run(
    runs: State<'_, AgentRuns>,
    session: State<'_, ActiveSession>,
    run_id: String,
) -> Result<(), AppError> {
    let token = active_token(&session)?;
    let active = runs
        .0
        .lock()
        .map_err(|_| "Agent run lock failed".to_string())?;
    if let Some((owner, sender)) = active.get(&run_id) {
        if owner != &token {
            return Err(AppError::new(
                ErrorCode::Permission,
                "Agent run belongs to another account",
                false,
            ));
        }
        let _ = sender.send(true);
    }
    Ok(())
}

fn verify_default_document(cursor: &AuthorityCursor) -> Result<(), AppError> {
    if cursor.document_id != DEFAULT_DOCUMENT_ID {
        return Err(AppError::new(
            ErrorCode::NotFound,
            "Document editing target was not found",
            false,
        ));
    }
    Ok(())
}

fn trusted_document_actor(
    store: &Store,
    session: &State<'_, ActiveSession>,
    window: &WebviewWindow,
) -> Result<String, AppError> {
    require_main_window(window, "Document editing")?;
    let token = session
        .0
        .lock()
        .map_err(|_| "Account session lock failed".to_string())?
        .clone();
    document_actor_for_token(store, token.as_deref())
}

#[derive(Clone)]
struct DataDir(PathBuf);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 更新器仅经 src-tauri/src/app_update.rs 的五个业务命令暴露；插件的
        // JS 直连权限（updater:default）不加入任何 capability。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("zinecv-font", |context, request| {
            font_protocol::respond(context.webview_label(), request)
        })
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
            let mut store = Store::open(&data_dir.join("zinecv.sqlite3"))
                .map_err(|error| {
                    std::io::Error::other(format!("Document store open failed: {error:?}"))
                })?
                .with_secret_provider(Arc::new(zinecv_native::NativeSecrets));
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
            app.manage(render_worker::WorkerManager::default());
            app.manage(DataDir(data_dir));
            app.manage(app_update::UpdaterManager::new(&app.state::<DataDir>().0));
            // 离线缓存恢复不阻塞启动：后台校验版本后广播状态事件。
            let updater_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let manager = updater_app.state::<app_update::UpdaterManager>();
                manager.restore_cached_update(&updater_app);
            });
            // Isolated permission acceptance only. This code and its environment
            // switch are absent from the production release.
            #[cfg(feature = "test-hooks")]
            if std::env::var_os("ZINECV_TEST_UNAUTHORIZED_WINDOW").is_some() {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "unauthorized-probe",
                    tauri::WebviewUrl::App("index.html?unauthorized-probe".into()),
                )
                .visible(false)
                .build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            document_state,
            switch_editing_context,
            version_graph_detailed,
            version_commit_detail,
            apply_document_command,
            inspect_legacy_migration,
            dry_run_legacy_migration,
            commit_legacy_migration,
            inspect_legacy_identity_conflicts,
            create_import_draft,
            get_import_draft,
            transition_import_draft,
            apply_import,
            commit_version,
            create_version_branch,
            switch_version_branch,
            load_history_commit,
            delete_version_commit,
            delete_version_branch,
            replace_version_store,
            export_database_backup,
            restore_database_backup,
            store_avatar_asset,
            read_avatar_asset,
            export_document_pdf,
            render_document_preview,
            render_document_export,
            pick_export_path,
            pick_export_directory,
            write_export_file,
            write_clipboard_text,
            fit_document_one_page,
            read_setting,
            write_setting,
            read_imported_template_catalog,
            write_imported_template_catalog,
            bootstrap_template_activity,
            update_template_activity,
            bootstrap_agent_sessions,
            replace_agent_sessions,
            agent_selected_context,
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
            list_agent_proposals,
            confirm_proposal,
            reject_proposal,
            undo_confirmed_proposal,
            list_agent_runs,
            cancel_agent_run,
            app_update::app_update_state,
            app_update::app_update_check,
            app_update::app_update_download,
            app_update::app_update_cancel_download,
            app_update::app_update_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running ZineCV desktop");
}

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

#[cfg(test)]
#[path = "commands/session_boundary_tests.rs"]
mod session_boundary_tests;

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

#[path = "commands/session.rs"]
mod session;
use session::*;

#[path = "commands/documents.rs"]
mod documents;
use documents::*;

#[path = "commands/imports.rs"]
mod imports;
use imports::*;

#[path = "commands/versions.rs"]
mod versions;
use versions::*;

#[path = "commands/rendering.rs"]
mod rendering;
use rendering::*;

#[path = "commands/preferences.rs"]
mod preferences;
use preferences::*;

#[path = "commands/providers.rs"]
mod providers;
use providers::*;

#[path = "commands/agent_run.rs"]
mod agent_run;
use agent_run::*;

#[path = "commands/proposals.rs"]
mod proposals;
use proposals::*;

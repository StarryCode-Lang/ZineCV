use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use base64::Engine;
use rusqlite::backup::{Backup, StepResult};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;

use crate::migration::{self, CommitLegacyMigrationRequest, LegacyMigrationCommitReceipt};
use zinecv_contracts::{
    canonical_hash, ApplyImportRequest, AuthorityCursor, CommandResult, DatabaseBackupPayload,
    EditingContextSourceKind, EntrySection, ImportBasicField, ImportCandidate,
    ImportCandidateValue, ImportDraft, ImportDraftStatus, ImportSourceKind, ResumeDocument,
    Section, SummarySection, SwitchEditingContextResult, TransitionImportDraftRequest,
};

#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Database(rusqlite::Error),
    Serialization(serde_json::Error),
    HashMismatch,
    MissingDraft,
    Domain(zinecv_contracts::AppError),
    Conflict(String),
    Validation(String),
    Permission(String),
    NotFound(String),
    Corrupt(String),
    MigrationFailed(String),
    UnsupportedSchema(i64),
}

impl From<StorageError> for zinecv_contracts::AppError {
    fn from(error: StorageError) -> Self {
        use zinecv_contracts::{AppError, ErrorCode};
        match error {
            StorageError::Domain(error) => error,
            StorageError::Conflict(message) => AppError::new(ErrorCode::Conflict, message, false),
            StorageError::Validation(message) => {
                AppError::new(ErrorCode::Validation, message, false)
            }
            StorageError::Permission(message) => {
                AppError::new(ErrorCode::Permission, message, false)
            }
            StorageError::NotFound(message) => AppError::new(ErrorCode::NotFound, message, false),
            StorageError::MissingDraft => {
                AppError::new(ErrorCode::NotFound, "Import draft is missing", false)
            }
            StorageError::UnsupportedSchema(version) => AppError::new(
                ErrorCode::UnsupportedSchema,
                format!("Database schema {version} is not supported"),
                false,
            ),
            StorageError::MigrationFailed(message) => {
                AppError::new(ErrorCode::MigrationPartial, message, false)
            }
            StorageError::Io(error) => {
                let code = match error.kind() {
                    std::io::ErrorKind::StorageFull => ErrorCode::StorageFull,
                    std::io::ErrorKind::PermissionDenied => ErrorCode::Permission,
                    std::io::ErrorKind::NotFound => ErrorCode::NotFound,
                    _ => ErrorCode::StorageCorrupt,
                };
                AppError::new(code, error.to_string(), code == ErrorCode::StorageFull)
            }
            StorageError::Database(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::DiskFull =>
            {
                AppError::new(ErrorCode::StorageFull, "Database storage is full", true)
            }
            StorageError::Database(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                AppError::new(ErrorCode::Conflict, "Database is busy", true)
            }
            StorageError::Database(_)
            | StorageError::Serialization(_)
            | StorageError::HashMismatch
            | StorageError::Corrupt(_) => AppError::new(
                ErrorCode::StorageCorrupt,
                "Stored data could not be read or verified",
                false,
            ),
        }
    }
}

impl From<std::io::Error> for StorageError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Database(value)
    }
}
impl From<serde_json::Error> for StorageError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value)
    }
}

impl From<zinecv_contracts::AppError> for StorageError {
    fn from(value: zinecv_contracts::AppError) -> Self {
        Self::Domain(value)
    }
}

pub type StorageResult<T> = Result<T, StorageError>;
pub type ExportSnapshot = (ResumeDocument, Option<(String, Vec<u8>)>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTemplateCatalog {
    pub revision: i64,
    pub payload_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateActivity {
    pub template_id: String,
    pub favorite: bool,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub source_view: Option<String>,
    #[serde(default)]
    pub source_refs: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentSession {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<StoredAgentMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAgentSessionStore {
    pub active_id: String,
    pub sessions: Vec<StoredAgentSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionState {
    pub revision: i64,
    pub store: StoredAgentSessionStore,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: String,
    pub session_id: String,
    pub target: AuthorityCursor,
    pub reference_ids: Vec<String>,
    pub status: String,
    pub lifecycle_state: String,
    pub epoch: i64,
    pub last_seq: i64,
    pub model_calls: i64,
    pub tool_calls: i64,
    pub partial_text: String,
    pub interrupted_reason: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

// C+ P1b：5 个版本图导出契约类型已并入 crates/zinecv-contracts（serde 形状与
// ts-rs 绑定输出不变）；此处再出口保持 `crate::storage::*` 既有引用路径不变。
pub use zinecv_contracts::{
    VersionBranch, VersionCommit, VersionCommitDetailed, VersionGraph, VersionGraphDetailed,
};

/// 旧版 ResumeVersionStore 的替换载荷（F28）；快照已是新 ResumeDocument。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceBranch {
    pub id: String,
    pub name: String,
    pub head_commit_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceCommit {
    pub id: String,
    pub branch_id: String,
    pub parent_id: Option<String>,
    pub message: String,
    pub created_at: String,
    pub snapshot: ResumeDocument,
}

mod legacy_identity;
mod migrations;
mod proposals;
mod resources;
pub struct Store {
    connection: Connection,
    pub(crate) secrets: Option<std::sync::Arc<dyn zinecv_contracts::capability::SecretProvider>>,
}

use migrations::MIGRATIONS;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
const JOURNAL_MODE: &str = "WAL";
// SAH pool has one writer and no shared-memory WAL; SQLite rollback journaling
// still provides the same transactional publication semantics.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
const JOURNAL_MODE: &str = "DELETE";

mod agent_runs;
mod agent_sessions;
mod backup;
mod branches;
mod connection;
mod drafts;
mod history_mutations;
mod history_queries;
mod imports;
mod legacy_commit;
mod legacy_conflicts;
mod legacy_mapping;
mod publication;
mod resource_links;
mod schema;
mod settings;
mod snapshots;
mod templates;

struct LegacyIdentityContext<'a> {
    namespace: &'a str,
    document_id: &'a str,
    accepted_updates: &'a HashSet<String>,
    used_updates: HashSet<String>,
}

const MAX_IMPORT_CANDIDATES: usize = 256;
const MAX_IMPORT_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMPORT_REVIEW_BYTES: usize = 2 * 1024 * 1024;

#[cfg(test)]
#[path = "storage/tests.rs"]
mod tests;

#[path = "storage/validation.rs"]
mod validation;
#[cfg(feature = "test-hooks")]
use validation::publication_test_hook;
use validation::*;

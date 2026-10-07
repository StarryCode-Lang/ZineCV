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

// Feature-only pause at the real SQLite publication boundary. The production
// build neither reads these variables nor writes markers.
#[cfg(feature = "test-hooks")]
fn publication_test_hook(operation: &str, phase: &str) -> StorageResult<()> {
    if std::env::var(format!("ZINECV_TEST_{operation}_PAUSE_PHASE"))
        .ok()
        .as_deref()
        != Some(phase)
    {
        return Ok(());
    }
    let Some(marker) = std::env::var_os(format!("ZINECV_TEST_{operation}_PAUSE_MARKER")) else {
        return Ok(());
    };
    std::fs::write(marker, format!("{}:{phase}", std::process::id()))?;
    std::thread::sleep(std::time::Duration::from_secs(15));
    Ok(())
}

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

fn default_branch_id(document_id: &str) -> String {
    format!("main:{document_id}")
}

fn editing_context_source_name(source_kind: EditingContextSourceKind) -> &'static str {
    match source_kind {
        EditingContextSourceKind::Workspace => "workspace",
        EditingContextSourceKind::ImportedTemplate => "imported-template",
    }
}

fn stable_editing_context_id(source_kind: EditingContextSourceKind, source_id: &str) -> String {
    if source_kind == EditingContextSourceKind::Workspace && source_id == "default" {
        return "workspace-default-context".into();
    }
    let source = format!("{}\0{source_id}", editing_context_source_name(source_kind));
    format!(
        "editing-context:{}:{}",
        editing_context_source_name(source_kind),
        Sha256::digest(source.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

mod legacy_identity;
mod migrations;
mod proposals;
mod resources;
pub struct Store {
    connection: Connection,
}

use migrations::MIGRATIONS;

impl Store {
    /// Bounded attempts used when a peer connection is still creating or
    /// locking the WAL shared-memory index of the same database file.
    const OPEN_CONTENTION_ATTEMPTS: usize = 20;
    const OPEN_CONTENTION_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

    /// Open the single authoritative database file.
    ///
    /// Several connections to one database are a supported shape (the
    /// resource-lease/GC tests exercise them), and a concurrent opener can
    /// still hold the `-shm` index. SQLite surfaces that window as
    /// `SQLITE_BUSY`/`SQLITE_LOCKED`, and on Windows also as a transient
    /// `SQLITE_READONLY` downgrade when the `-shm` handle open races a
    /// file-system filter. The whole open is retried a bounded number of
    /// times, mirroring the bounded caller retry already required for lease
    /// admission. Only transient contention on a writable database is
    /// retried: a genuinely read-only or missing file fails immediately.
    pub fn open(path: &Path) -> StorageResult<Self> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match Self::open_once(path) {
                Ok(store) => return Ok(store),
                Err(error) => {
                    if attempt >= Self::OPEN_CONTENTION_ATTEMPTS
                        || !Self::is_transient_open_contention(path, &error)
                    {
                        return Err(error);
                    }
                    std::thread::sleep(Self::OPEN_CONTENTION_DELAY);
                }
            }
        }
    }

    fn is_transient_open_contention(path: &Path, error: &StorageError) -> bool {
        let StorageError::Database(rusqlite::Error::SqliteFailure(code, _)) = error else {
            return false;
        };
        if !matches!(
            code.code,
            rusqlite::ErrorCode::DatabaseBusy
                | rusqlite::ErrorCode::DatabaseLocked
                | rusqlite::ErrorCode::ReadOnly
        ) {
            return false;
        }
        match std::fs::OpenOptions::new().write(true).open(path) {
            Ok(_) => true,
            Err(probe) => probe.kind() == std::io::ErrorKind::NotFound,
        }
    }

    fn open_once(path: &Path) -> StorageResult<Self> {
        let existing_nonempty = std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.len() > 0)
            .unwrap_or(false);
        let connection = Connection::open(path)?;
        let pre_upgrade_backup = if existing_nonempty {
            Self::integrity_check(&connection)?;
            let has_schema = Self::check_schema_compatibility(&connection)?;
            if !has_schema {
                let has_application_tables: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%')",
                    [],
                    |row| row.get(0),
                )?;
                if has_application_tables {
                    return Err(StorageError::Corrupt(
                        "Existing database has tables but no ZineCV migration records".into(),
                    ));
                }
                None
            } else if Self::needs_upgrade(&connection)? {
                Self::validate_connection(&connection)?;
                let backup_path = Self::unique_database_path(path, "pre-upgrade")?;
                Self::write_verified_backup(&connection, &backup_path)?;
                Some(backup_path)
            } else {
                Self::validate_connection(&connection)?;
                None
            }
        } else {
            None
        };

        match Self::prepare(connection) {
            Ok(store) => Ok(store),
            Err(error) => {
                if let Some(backup_path) = pre_upgrade_backup {
                    let diagnostic_path = Self::migration_diagnostic_path(&backup_path);
                    let diagnostic = format!(
                        "ZineCV database upgrade failed.\nDatabase: {}\nVerified pre-upgrade backup: {}\nError: {error:?}\n",
                        path.display(),
                        backup_path.display(),
                    );
                    let diagnostic_result = std::fs::write(&diagnostic_path, diagnostic);
                    let detail = match diagnostic_result {
                        Ok(()) => format!(
                            "Database upgrade failed; original database was rolled back. Verified backup: {}. Diagnostic: {}. Cause: {error:?}",
                            backup_path.display(),
                            diagnostic_path.display(),
                        ),
                        Err(write_error) => format!(
                            "Database upgrade failed; original database was rolled back. Verified backup: {}. Diagnostic write failed: {write_error}. Cause: {error:?}",
                            backup_path.display(),
                        ),
                    };
                    Err(StorageError::MigrationFailed(detail))
                } else {
                    Err(error)
                }
            }
        }
    }

    pub fn open_in_memory() -> StorageResult<Self> {
        Self::prepare(Connection::open_in_memory()?)
    }

    pub fn backup_to(&self, path: &Path) -> StorageResult<()> {
        if path.try_exists()? {
            return Err(StorageError::Validation(
                "Backup target already exists".into(),
            ));
        }
        let name = path
            .file_name()
            .ok_or_else(|| StorageError::Validation("Backup target needs a file name".into()))?
            .to_string_lossy();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| StorageError::Validation(error.to_string()))?
            .as_nanos();
        let staging =
            path.with_file_name(format!(".{name}.partial-{}-{suffix}", std::process::id()));
        let reserved = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        drop(reserved);
        let lease_id = match self.create_all_resource_lease(15 * 60) {
            Ok(lease_id) => lease_id,
            Err(error) => {
                let _ = std::fs::remove_file(&staging);
                return Err(error);
            }
        };
        let result = (|| -> StorageResult<()> {
            let mut destination = Connection::open(&staging)?;
            destination.pragma_update(None, "journal_mode", "DELETE")?;
            destination.pragma_update(None, "synchronous", "FULL")?;
            {
                let backup = Backup::new(&self.connection, &mut destination)?;
                loop {
                    match backup.step(128)? {
                        StepResult::Done => break,
                        _ => continue,
                    }
                }
            }
            Self::validate_connection(&destination)?;
            drop(destination);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&staging)?
                .sync_all()?;
            if path.try_exists()? {
                return Err(StorageError::Validation(
                    "Backup target already exists".into(),
                ));
            }
            std::fs::rename(&staging, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&staging);
        }
        let release = self.release_resource_lease(&lease_id);
        match (result, release) {
            (Err(error), _) => Err(error),
            (Ok(()), Err(error)) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    pub fn restore_from(&mut self, path: &Path) -> StorageResult<()> {
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Self::integrity_check(&source)?;
        if !Self::check_schema_compatibility(&source)? {
            return Err(StorageError::Corrupt(
                "Backup has no ZineCV migration records".into(),
            ));
        }
        Self::validate_connection(&source)?;
        let mut staging = Connection::open_in_memory()?;
        Self::copy_database(&source, &mut staging)?;
        let staged_store = Self::prepare(staging)?;
        Self::validate_connection(&staged_store.connection)?;
        self.publish_candidate(&staged_store.connection)
    }

    pub fn export_database_backup(&self) -> StorageResult<DatabaseBackupPayload> {
        const MAX_DATABASE_BYTES: usize = 128 * 1024 * 1024;
        let lease_id = self.create_all_resource_lease(15 * 60)?;
        let result = (|| -> StorageResult<DatabaseBackupPayload> {
            let mut snapshot = Connection::open_in_memory()?;
            Self::copy_database(&self.connection, &mut snapshot)?;
            Self::validate_connection(&snapshot)?;
            let database = snapshot.serialize("main")?.to_vec();
            if database.len() > MAX_DATABASE_BYTES {
                return Err(StorageError::Validation(
                    "Database backup exceeds the 128 MiB limit".into(),
                ));
            }
            let schema_version = Self::schema_version(&snapshot)?;
            let unavailable_secret_count =
                crate::identity::unavailable_secret_count_from(&snapshot)?;
            let database_sha256 = format!("{:x}", Sha256::digest(&database));
            Ok(DatabaseBackupPayload {
                format: "zinecv-sqlite-full-backup".into(),
                format_version: 1,
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| StorageError::Validation(error.to_string()))?
                    .as_secs()
                    .to_string(),
                schema_version: u32::try_from(schema_version).map_err(|_| {
                    StorageError::Corrupt("Database schema version is out of range".into())
                })?,
                database_sha256,
                database_base64: base64::engine::general_purpose::STANDARD.encode(database),
                unavailable_secret_count: u32::try_from(unavailable_secret_count).map_err(
                    |_| StorageError::Validation("Unavailable secret count is out of range".into()),
                )?,
            })
        })();
        let release = self.release_resource_lease(&lease_id);
        match (result, release) {
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(payload), Ok(())) => Ok(payload),
        }
    }

    pub fn restore_database_backup(
        &mut self,
        payload: &DatabaseBackupPayload,
        pre_restore_backup_path: &Path,
    ) -> StorageResult<(u32, u32)> {
        const MAX_DATABASE_BYTES: usize = 128 * 1024 * 1024;
        const MAX_BASE64_BYTES: usize = MAX_DATABASE_BYTES.div_ceil(3) * 4;
        if payload.format != "zinecv-sqlite-full-backup" || payload.format_version != 1 {
            return Err(StorageError::Validation(
                "Unsupported full database backup format".into(),
            ));
        }
        if payload.database_base64.len() > MAX_BASE64_BYTES {
            return Err(StorageError::Validation(
                "Database backup exceeds the 128 MiB limit".into(),
            ));
        }
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.database_base64.as_bytes())
            .map_err(|_| StorageError::Corrupt("Database backup encoding is invalid".into()))?;
        if bytes.is_empty() || bytes.len() > MAX_DATABASE_BYTES {
            return Err(StorageError::Validation(
                "Database backup must contain between 1 byte and 128 MiB".into(),
            ));
        }
        if format!("{:x}", Sha256::digest(&bytes)) != payload.database_sha256 {
            return Err(StorageError::HashMismatch);
        }

        // A serialized standalone snapshot has no -wal/-shm sidecars. File-backed
        // databases record WAL mode in bytes 18/19; normalize only this verified
        // snapshot image to rollback-journal mode before SQLite deserializes it in
        // memory. The payload hash above still covers the exact exported bytes.
        if bytes.get(..16) != Some(b"SQLite format 3\0".as_slice()) {
            return Err(StorageError::Corrupt(
                "Database backup has an invalid SQLite header".into(),
            ));
        }
        match (bytes.get(18).copied(), bytes.get(19).copied()) {
            (Some(1), Some(1)) => {}
            (Some(2), Some(2)) => {
                bytes[18] = 1;
                bytes[19] = 1;
            }
            _ => {
                return Err(StorageError::Corrupt(
                    "Database backup has an unsupported SQLite journal header".into(),
                ));
            }
        }

        let mut candidate = Connection::open_in_memory()?;
        candidate.deserialize_read_exact("main", Cursor::new(&bytes), bytes.len(), false)?;
        Self::validate_connection(&candidate)?;
        if Self::schema_version(&candidate)? != i64::from(payload.schema_version) {
            return Err(StorageError::Corrupt(
                "Database backup schema metadata does not match its contents".into(),
            ));
        }
        let staged_store = Self::prepare(candidate)?;
        Self::validate_connection(&staged_store.connection)?;
        Self::validate_restorable_database(&staged_store.connection)?;
        let schema_version = u32::try_from(Self::schema_version(&staged_store.connection)?)
            .map_err(|_| StorageError::Corrupt("Database schema version is out of range".into()))?;
        let unavailable_secret_count = u32::try_from(staged_store.unavailable_secret_count()?)
            .map_err(|_| {
                StorageError::Validation("Unavailable secret count is out of range".into())
            })?;

        // 保留当前整库的可验证副本后，再从已升级的候选库发布；运行时只保留一个 Store 连接。
        self.backup_to(pre_restore_backup_path)?;
        self.publish_candidate(&staged_store.connection)?;
        Ok((schema_version, unavailable_secret_count))
    }

    fn publish_candidate(&mut self, candidate: &Connection) -> StorageResult<()> {
        let mut rollback = Connection::open_in_memory()?;
        Self::copy_database(&self.connection, &mut rollback)?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("RESTORE", "before-commit")?;
        let publish_result = (|| -> StorageResult<()> {
            Self::copy_database(candidate, &mut self.connection)?;
            #[cfg(feature = "test-hooks")]
            publication_test_hook("RESTORE", "after-commit")?;
            self.connection.pragma_update(None, "foreign_keys", "ON")?;
            self.connection.pragma_update(None, "journal_mode", "WAL")?;
            self.connection.pragma_update(None, "synchronous", "FULL")?;
            self.connection.pragma_update(None, "busy_timeout", 5000)?;
            self.connection
                .pragma_update(None, "temp_store", "MEMORY")?;
            Self::validate_connection(&self.connection)?;
            Self::validate_restorable_database(&self.connection)?;
            Ok(())
        })();
        if let Err(error) = publish_result {
            let rollback_result = Self::copy_database(&rollback, &mut self.connection)
                .and_then(|()| Self::validate_connection(&self.connection));
            return match rollback_result {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(StorageError::MigrationFailed(format!(
                    "Database publication failed ({error:?}) and rollback failed ({rollback_error:?})"
                ))),
            };
        }
        Ok(())
    }

    fn validate_restorable_database(connection: &Connection) -> StorageResult<()> {
        let document_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))?;
        if document_count == 0 {
            return Err(StorageError::Corrupt(
                "Full database backup contains no resume document".into(),
            ));
        }
        let documents = {
            let mut statement = connection.prepare("SELECT id FROM documents ORDER BY id")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for document_id in documents {
            let (context_id, branch_id, document_revision, head_id): (
                String,
                String,
                i64,
                Option<String>,
            ) = connection.query_row(
                "SELECT d.active_context_id, d.current_branch_id, d.revision, b.head_commit_id
                 FROM documents d LEFT JOIN branches b
                   ON b.id = d.current_branch_id AND b.document_id = d.id
                 WHERE d.id = ?1",
                [&document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            let context_exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM editing_contexts WHERE document_id = ?1 AND id = ?2)",
                params![document_id, context_id],
                |row| row.get(0),
            )?;
            let branch_exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM branches WHERE document_id = ?1 AND id = ?2)",
                params![document_id, branch_id],
                |row| row.get(0),
            )?;
            if !context_exists || !branch_exists {
                return Err(StorageError::Corrupt(format!(
                    "Active context or branch for {document_id} could not be restored"
                )));
            }
            let draft: Option<(i64, String, String)> = connection
                .query_row(
                    "SELECT revision, document_json, hash FROM drafts
                     WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![document_id, context_id, branch_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let (json, hash) = if let Some((draft_revision, json, hash)) = draft {
                if draft_revision != document_revision {
                    return Err(StorageError::Corrupt(format!(
                        "Active draft revision for {document_id} does not match the document"
                    )));
                }
                (json, hash)
            } else if let Some(head_id) = head_id {
                connection.query_row(
                    "SELECT s.document_json, s.hash FROM commits c
                     JOIN snapshots s ON s.id = c.snapshot_id
                     WHERE c.document_id = ?1 AND c.id = ?2",
                    params![document_id, head_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?
            } else {
                return Err(StorageError::Corrupt(format!(
                    "Active document {document_id} has neither a draft nor a version snapshot"
                )));
            };
            let document: ResumeDocument = serde_json::from_str(&json)?;
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
            if document.document_id != document_id || canonical_hash(&document)? != hash {
                return Err(StorageError::Corrupt(format!(
                    "Active document hash failed for {document_id}"
                )));
            }
        }
        Ok(())
    }

    fn schema_version(connection: &Connection) -> StorageResult<i64> {
        Ok(
            connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })?,
        )
    }

    fn integrity_check(connection: &Connection) -> StorageResult<()> {
        let query = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0));
        let result = match query {
            Ok(result) => result,
            Err(rusqlite::Error::SqliteFailure(error, Some(message)))
                if error.code == rusqlite::ffi::ErrorCode::NotADatabase
                    || error.code == rusqlite::ffi::ErrorCode::DatabaseCorrupt =>
            {
                return Err(StorageError::Corrupt(message));
            }
            Err(rusqlite::Error::SqliteFailure(error, None))
                if error.code == rusqlite::ffi::ErrorCode::NotADatabase
                    || error.code == rusqlite::ffi::ErrorCode::DatabaseCorrupt =>
            {
                return Err(StorageError::Corrupt("SQLite database is corrupt".into()));
            }
            Err(error) => return Err(error.into()),
        };
        if result == "ok" {
            Ok(())
        } else {
            Err(StorageError::Corrupt(result))
        }
    }

    fn validate_connection(connection: &Connection) -> StorageResult<()> {
        Self::integrity_check(connection)?;
        if !Self::check_schema_compatibility(connection)? {
            return Err(StorageError::Corrupt(
                "Database has no ZineCV migration records".into(),
            ));
        }

        let mut foreign_keys = connection.prepare("PRAGMA foreign_key_check")?;
        let violation = foreign_keys
            .query_row([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .optional()?;
        if let Some((table, row_id, parent, constraint)) = violation {
            return Err(StorageError::Corrupt(format!(
                "Foreign key violation in {table} row {row_id:?} referencing {parent} (constraint {constraint})"
            )));
        }

        let has_resources: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resources')",
            [],
            |row| row.get(0),
        )?;
        if has_resources {
            let mut statement =
                connection.prepare("SELECT hash, bytes, size FROM resources ORDER BY hash")?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let hash: String = row.get(0)?;
                let bytes: Vec<u8> = row.get(1)?;
                let size: i64 = row.get(2)?;
                if size < 0
                    || usize::try_from(size).ok() != Some(bytes.len())
                    || format!("{:x}", Sha256::digest(&bytes)) != hash
                {
                    return Err(StorageError::Corrupt(format!(
                        "Resource integrity check failed for {hash}"
                    )));
                }
            }
        }
        Ok(())
    }

    fn needs_upgrade(connection: &Connection) -> StorageResult<bool> {
        let latest = MIGRATIONS.last().expect("at least one migration").0;
        let applied: Option<i64> =
            connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })?;
        let Some(applied) = applied else {
            return Ok(true);
        };
        if applied < latest {
            return Ok(true);
        }
        let marker: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'resource-ownership-backfilled-v1'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(marker.as_deref() != Some("1"))
    }

    fn unique_database_path(path: &Path, label: &str) -> StorageResult<std::path::PathBuf> {
        let file_name = path
            .file_name()
            .ok_or_else(|| StorageError::Validation("Database path needs a file name".into()))?
            .to_string_lossy();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| StorageError::Validation(error.to_string()))?
            .as_nanos();
        Ok(path.with_file_name(format!(
            "{file_name}.{label}-{}-{suffix}.bak",
            std::process::id()
        )))
    }

    fn migration_diagnostic_path(backup_path: &Path) -> std::path::PathBuf {
        let backup_name = backup_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        backup_path.with_file_name(format!("{backup_name}.upgrade-diagnostic.txt"))
    }

    fn write_verified_backup(source: &Connection, path: &Path) -> StorageResult<()> {
        if path.try_exists()? {
            return Err(StorageError::Validation(
                "Database backup target already exists".into(),
            ));
        }
        let name = path
            .file_name()
            .ok_or_else(|| StorageError::Validation("Backup target needs a file name".into()))?
            .to_string_lossy();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| StorageError::Validation(error.to_string()))?
            .as_nanos();
        let staging =
            path.with_file_name(format!(".{name}.partial-{}-{suffix}", std::process::id()));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        let result = (|| -> StorageResult<()> {
            let mut destination = Connection::open(&staging)?;
            destination.pragma_update(None, "journal_mode", "DELETE")?;
            destination.pragma_update(None, "synchronous", "FULL")?;
            Self::copy_database(source, &mut destination)?;
            Self::validate_connection(&destination)?;
            drop(destination);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&staging)?
                .sync_all()?;
            std::fs::rename(&staging, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&staging);
        }
        result
    }

    fn copy_database(source: &Connection, destination: &mut Connection) -> StorageResult<()> {
        let backup = Backup::new(source, destination)?;
        loop {
            match backup.step(128)? {
                StepResult::Done => break,
                _ => continue,
            }
        }
        Ok(())
    }

    fn prepare(connection: Connection) -> StorageResult<Self> {
        Self::integrity_check(&connection)?;
        Self::check_schema_compatibility(&connection)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "busy_timeout", 5000)?;
        connection.pragma_update(None, "temp_store", "MEMORY")?;
        let mut store = Self { connection };
        store.migrate()?;
        store.recover_interrupted_agent_runs()?;
        Self::validate_connection(&store.connection)?;
        Ok(store)
    }

    fn check_schema_compatibility(connection: &Connection) -> StorageResult<bool> {
        let has_migrations: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
            [],
            |row| row.get(0),
        )?;
        if !has_migrations {
            return Ok(false);
        }

        let mut statement =
            connection.prepare("SELECT version, checksum FROM schema_migrations")?;
        let applied = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut applied_versions = Vec::new();
        for entry in applied {
            let (version, checksum) = entry?;
            let Some((_, sql)) = MIGRATIONS.iter().find(|(known, _)| *known == version) else {
                if version > MIGRATIONS.last().expect("at least one migration").0 {
                    return Err(StorageError::UnsupportedSchema(version));
                }
                return Err(StorageError::Corrupt(format!(
                    "Unknown migration version {version}"
                )));
            };
            let expected = format!("{:x}", Sha256::digest(sql.as_bytes()));
            if checksum != expected {
                return Err(StorageError::Corrupt(format!(
                    "Migration {version} checksum mismatch"
                )));
            }
            applied_versions.push(version);
        }
        applied_versions.sort_unstable();
        let valid_base = applied_versions.contains(&1);
        if applied_versions.contains(&2) && !valid_base {
            return Err(StorageError::Corrupt(
                "Branch tombstone migration has no base schema".into(),
            ));
        }
        if valid_base {
            for table in [
                "documents",
                "editing_contexts",
                "branches",
                "drafts",
                "snapshots",
                "commits",
                "commit_links",
                "resources",
                "resource_refs",
                "command_receipts",
            ] {
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Corrupt(format!(
                        "Missing required table {table}"
                    )));
                }
            }
            if applied_versions.contains(&2) {
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'branch_tombstones')",
                    [],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Corrupt(
                        "Missing required table branch_tombstones".into(),
                    ));
                }
            }
            if applied_versions.contains(&6) {
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'imported_template_catalog')",
                    [],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Corrupt(
                        "Missing required table imported_template_catalog".into(),
                    ));
                }
            }
            if applied_versions.contains(&7) {
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'template_activity')",
                    [],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Corrupt(
                        "Missing required table template_activity".into(),
                    ));
                }
            }
            if applied_versions.contains(&8) {
                for table in ["agent_session_meta", "agent_sessions", "agent_messages"] {
                    let exists: bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                        [table],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(StorageError::Corrupt(format!(
                            "Missing required table {table}"
                        )));
                    }
                }
            }
            if applied_versions.contains(&9) {
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs')",
                    [],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Corrupt(
                        "Missing required table agent_runs".into(),
                    ));
                }
            }
            if applied_versions.contains(&11) {
                for table in [
                    "template_revisions",
                    "resource_leases",
                    "resource_recovery_requirements",
                ] {
                    let exists: bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                        [table],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(StorageError::Corrupt(format!(
                            "Missing required table {table}"
                        )));
                    }
                }
            }
            if applied_versions.contains(&13) {
                for table in [
                    "legacy_migration_batches",
                    "legacy_migration_commands",
                    "legacy_entity_identity",
                ] {
                    let exists: bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                        [table],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(StorageError::Corrupt(format!(
                            "Missing required table {table}"
                        )));
                    }
                }
            }
            if applied_versions.contains(&14) {
                let exists: bool = connection.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_run_lifecycle')",
                    [],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StorageError::Corrupt(
                        "Missing required table agent_run_lifecycle".into(),
                    ));
                }
            }
            if applied_versions.contains(&15) {
                for table in ["agent_proposals", "agent_proposal_receipts"] {
                    let exists: bool = connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                        [table],
                        |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(StorageError::Corrupt(format!(
                            "Missing required table {table}"
                        )));
                    }
                }
            }
        }
        Ok(valid_base)
    }

    fn migrate(&mut self) -> StorageResult<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              checksum TEXT NOT NULL,
              applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )?;
        for (version, sql) in MIGRATIONS {
            let applied: Option<i64> = transaction
                .query_row(
                    "SELECT version FROM schema_migrations WHERE version = ?1",
                    [version],
                    |row| row.get(0),
                )
                .optional()?;
            if applied.is_some() {
                continue;
            }
            let checksum = format!("{:x}", Sha256::digest(sql.as_bytes()));
            transaction.execute_batch(sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, checksum) VALUES (?1, ?2)",
                params![version, checksum],
            )?;
        }
        resources::reconcile_ownership_backfill(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    /// 供宿主与同 crate 的身份/设置模块访问底层连接（不越过 Store 的事务约定）；
    /// 原 pub(crate)，P3b 迁出后宿主测试仍需访问，转 pub。
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn migration_versions(&self) -> StorageResult<Vec<i64>> {
        let mut statement = self
            .connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")?;
        let values = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }

    pub fn load_active_document(
        &self,
        document_id: &str,
    ) -> StorageResult<Option<(AuthorityCursor, ResumeDocument)>> {
        let context_id: Option<String> = self
            .connection
            .query_row(
                "SELECT active_context_id FROM documents WHERE id = ?1",
                params![document_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(context_id) = context_id else {
            return Ok(None);
        };
        let cursor = self
            .load_cursor(document_id, &context_id)?
            .ok_or_else(|| StorageError::Corrupt("Active document cursor is missing".into()))?;
        let (_, document) = self
            .load_current(document_id, &context_id)?
            .ok_or(StorageError::MissingDraft)?;
        Ok(Some((cursor, document)))
    }

    pub fn validate_active_cursor(&self, expected: &AuthorityCursor) -> StorageResult<()> {
        let actual = self
            .load_cursor(&expected.document_id, &expected.context_id)?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        if actual != *expected {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let registered: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM editing_contexts WHERE document_id = ?1 AND id = ?2)",
            params![expected.document_id, expected.context_id],
            |row| row.get(0),
        )?;
        if !registered {
            return Err(StorageError::NotFound(
                "Editing context was not found".into(),
            ));
        }
        Ok(())
    }

    pub fn switch_editing_context(
        &mut self,
        expected: &AuthorityCursor,
        source_kind: EditingContextSourceKind,
        source_id: &str,
        initial_document: Option<&ResumeDocument>,
    ) -> StorageResult<SwitchEditingContextResult> {
        let source_id = source_id.trim();
        if source_id.is_empty() || source_id.len() > 512 {
            return Err(StorageError::Validation(
                "Editing context source ID is invalid".into(),
            ));
        }
        if source_kind == EditingContextSourceKind::Workspace && source_id != "default" {
            return Err(StorageError::Validation(
                "Workspace source ID must be default".into(),
            ));
        }
        if let Some(document) = initial_document {
            if document.document_id != expected.document_id {
                return Err(StorageError::Validation(
                    "Initial draft belongs to another document".into(),
                ));
            }
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        }

        let source_kind_name = editing_context_source_name(source_kind);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (branch_id, active_context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != active_context_id
            || expected.revision != revision.to_string()
            || expected.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let active_context_registered: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM editing_contexts WHERE document_id = ?1 AND id = ?2)",
            params![expected.document_id, active_context_id],
            |row| row.get(0),
        )?;
        if !active_context_registered {
            return Err(StorageError::NotFound(
                "Active editing context was not found".into(),
            ));
        }

        let mut source_rows = transaction.prepare(
            "SELECT id FROM editing_contexts
             WHERE document_id = ?1 AND source_kind = ?2 AND source_id = ?3",
        )?;
        let source_contexts = source_rows
            .query_map(
                params![expected.document_id, source_kind_name, source_id],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(source_rows);
        if source_contexts.len() > 1 {
            return Err(StorageError::Corrupt(
                "Editing context source maps to multiple IDs".into(),
            ));
        }
        let created = source_contexts.is_empty();
        let target_context_id = source_contexts
            .first()
            .cloned()
            .unwrap_or_else(|| stable_editing_context_id(source_kind, source_id));
        if created {
            let collision: Option<(String, String)> = transaction
                .query_row(
                    "SELECT source_kind, source_id FROM editing_contexts
                     WHERE document_id = ?1 AND id = ?2",
                    params![expected.document_id, target_context_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if collision.is_some() {
                return Err(StorageError::Corrupt(
                    "Stable editing context ID is already assigned".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    target_context_id,
                    expected.document_id,
                    source_kind_name,
                    source_id
                ],
            )?;
        }

        let target_draft: Option<(String, String)> = transaction
            .query_row(
                "SELECT document_json, hash FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, target_context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (target_document, target_json, target_hash) =
            if let Some((json, stored_hash)) = target_draft {
                let document: ResumeDocument = serde_json::from_str(&json)?;
                if document.document_id != expected.document_id
                    || canonical_hash(&document)? != stored_hash
                {
                    return Err(StorageError::HashMismatch);
                }
                (document, Some(json), Some(stored_hash))
            } else if created {
                let document = initial_document.ok_or(StorageError::MissingDraft)?.clone();
                let json = serde_json::to_string(&document)?;
                let hash = canonical_hash(&document)?;
                (document, Some(json), Some(hash))
            } else {
                let head_id = head_id.as_ref().ok_or(StorageError::MissingDraft)?;
                let (json, stored_hash): (String, String) = transaction.query_row(
                    "SELECT snapshots.document_json, snapshots.hash FROM commits
                     JOIN snapshots ON snapshots.id = commits.snapshot_id
                     WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![head_id, expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let document: ResumeDocument = serde_json::from_str(&json)?;
                if document.document_id != expected.document_id
                    || canonical_hash(&document)? != stored_hash
                {
                    return Err(StorageError::HashMismatch);
                }
                (document, None, None)
            };

        if target_context_id == active_context_id {
            transaction.commit()?;
            return Ok(SwitchEditingContextResult {
                cursor: expected.clone(),
                document: target_document,
                created: false,
            });
        }

        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Corrupt("Document revision overflow".into()))?;
        if let (Some(json), Some(hash)) = (target_json, target_hash) {
            transaction.execute(
                "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
                 ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
                   revision = excluded.revision,
                   updated_at = CURRENT_TIMESTAMP",
                params![expected.document_id, target_context_id, branch_id, next_revision, json, hash],
            )?;
            Self::sync_draft_resource_owner(
                &transaction,
                &expected.document_id,
                &target_context_id,
                &branch_id,
                &json,
            )?;
        }
        let changed = transaction.execute(
            "UPDATE documents SET active_context_id = ?1, title = ?2, revision = ?3
             WHERE id = ?4 AND current_branch_id = ?5 AND active_context_id = ?6 AND revision = ?7",
            params![
                target_context_id,
                target_document.title,
                next_revision,
                expected.document_id,
                branch_id,
                active_context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        let cursor = self
            .load_cursor(&expected.document_id, &target_context_id)?
            .ok_or_else(|| StorageError::Corrupt("Switched context cursor is missing".into()))?;
        Ok(SwitchEditingContextResult {
            cursor,
            document: target_document,
            created,
        })
    }

    pub fn initialize_document(
        &mut self,
        document: &ResumeDocument,
        context_id: &str,
    ) -> StorageResult<bool> {
        if context_id.trim().is_empty() {
            return Err(StorageError::Validation(
                "Editing context ID is required".into(),
            ));
        }
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM documents WHERE id = ?1",
                params![document.document_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Ok(false);
        }
        let branch_id = default_branch_id(&document.document_id);
        let json = serde_json::to_string(document)?;
        let hash = canonical_hash(document)?;
        transaction.execute(
            "INSERT INTO documents(id, title, current_branch_id, active_context_id, revision)
             VALUES (?1, ?2, ?3, ?4, 0)",
            params![document.document_id, document.title, branch_id, context_id],
        )?;
        transaction.execute(
            "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
             VALUES (?1, ?2, 'workspace', 'default')",
            params![context_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT INTO branches(id, document_id, name) VALUES (?1, ?2, 'main')",
            params![branch_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
             VALUES (?1, ?2, ?3, 0, ?4, ?5)",
            params![document.document_id, context_id, branch_id, json, hash],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &document.document_id,
            context_id,
            &branch_id,
            &json,
        )?;
        let snapshot_id = format!("snap-{hash}");
        let commit_id = format!("commit:{}:initial", document.document_id);
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, hash],
        )?;
        Self::sync_snapshot_resource_owner(&transaction, &snapshot_id, &json)?;
        transaction.execute(
            "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
             VALUES (?1, ?2, ?3, ?4, '初始版本')",
            params![commit_id, document.document_id, branch_id, snapshot_id],
        )?;
        transaction.execute(
            "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, NULL)",
            params![commit_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
            params![commit_id, branch_id, document.document_id],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn save_draft(
        &self,
        document: &ResumeDocument,
        context_id: &str,
        revision: u64,
    ) -> StorageResult<()> {
        let json = serde_json::to_string(document)?;
        let hash = canonical_hash(document)?;
        let transaction = self.connection.unchecked_transaction()?;
        let branch_id: Option<String> = transaction
            .query_row(
                "SELECT current_branch_id FROM documents WHERE id = ?1",
                params![document.document_id],
                |row| row.get(0),
            )
            .optional()?;
        let branch_id = branch_id.unwrap_or_else(|| default_branch_id(&document.document_id));
        transaction.execute(
            "INSERT INTO documents(id, title, current_branch_id, active_context_id, revision) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               active_context_id = excluded.active_context_id,
               revision = excluded.revision",
            params![document.document_id, document.title, branch_id, context_id, revision as i64],
        )?;
        transaction.execute(
            "INSERT INTO editing_contexts(id, document_id, source_kind, source_id) VALUES (?1, ?2, 'workspace', 'default')
             ON CONFLICT(document_id, id) DO NOTHING",
            params![context_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO branches(id, document_id, name) VALUES (?1, ?2, 'main')",
            params![branch_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
               revision = excluded.revision,
               document_json = excluded.document_json,
               hash = excluded.hash,
               updated_at = CURRENT_TIMESTAMP",
            params![document.document_id, context_id, branch_id, revision as i64, json, hash],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &document.document_id,
            context_id,
            &branch_id,
            &json,
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
            [&document.document_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn apply_command(
        &mut self,
        actor: &str,
        envelope: zinecv_contracts::CommandEnvelope,
    ) -> StorageResult<zinecv_contracts::CommandResult> {
        use zinecv_domain::DocumentContext;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT actor, request_hash, result_json FROM command_receipts WHERE command_id = ?1",
                params![envelope.command_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_actor, stored_hash, result_json)) = existing {
            let request_hash = canonical_hash(&envelope)?;
            if stored_actor == actor && stored_hash == request_hash {
                return Ok(serde_json::from_str(&result_json)?);
            }
            return Err(StorageError::Conflict(
                "Command ID was reused with a different request".into(),
            ));
        }

        let authority = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![envelope.document_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let (branch_id, active_context_id, stored_revision) = authority;
        let stored_revision = stored_revision as u64;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, envelope.document_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        if envelope.context_id != active_context_id
            || envelope.expected_branch_id != branch_id
            || envelope.expected_head_id != head_id
            || envelope.expected_revision != stored_revision.to_string()
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }

        let draft_json: Option<String> = transaction
            .query_row(
                "SELECT document_json FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![envelope.document_id, active_context_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        let document = if let Some(json) = draft_json {
            serde_json::from_str(&json)?
        } else if let Some(head_id) = head_id.as_ref() {
            let json: String = transaction.query_row(
                "SELECT snapshots.document_json FROM snapshots JOIN commits ON commits.snapshot_id = snapshots.id WHERE commits.id = ?1",
                params![head_id],
                |row| row.get(0),
            )?;
            serde_json::from_str(&json)?
        } else {
            return Err(StorageError::NotFound("No draft or head snapshot".into()));
        };

        let mut context =
            DocumentContext::with_authority(document, stored_revision, branch_id, head_id)
                .map_err(StorageError::Domain)?;
        let result = context
            .apply_command(actor, &active_context_id, envelope.clone())
            .map_err(StorageError::Domain)?;

        let json = serde_json::to_string(&result.document)?;
        let document_hash = canonical_hash(&result.document)?;
        let updated = transaction.execute(
            "UPDATE documents SET title = ?1, active_context_id = ?2, revision = ?3
             WHERE id = ?4 AND revision = ?5 AND current_branch_id = ?6 AND active_context_id = ?7",
            params![
                result.document.title,
                active_context_id,
                result.cursor.revision,
                envelope.document_id,
                stored_revision as i64,
                envelope.expected_branch_id,
                envelope.context_id,
            ],
        )?;
        if updated != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
               revision = excluded.revision,
               document_json = excluded.document_json,
               hash = excluded.hash,
               updated_at = CURRENT_TIMESTAMP",
            params![
                envelope.document_id,
                active_context_id,
                result.cursor.branch_id,
                result.cursor.revision,
                json,
                document_hash
            ],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &envelope.document_id,
            &active_context_id,
            &result.cursor.branch_id,
            &json,
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
            [&envelope.document_id],
        )?;
        transaction.execute(
            "INSERT INTO command_receipts(command_id, document_id, actor, request_hash, result_json, result_hash, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                envelope.command_id,
                envelope.document_id,
                actor,
                canonical_hash(&envelope)?,
                serde_json::to_string(&result)?,
                canonical_hash(&result)?,
                result.cursor.revision
            ],
        )?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn load_current(
        &self,
        document_id: &str,
        context_id: &str,
    ) -> StorageResult<Option<(u64, ResumeDocument)>> {
        let authority: Option<(String, String, i64)> = self
            .connection
            .query_row(
                "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((active_context_id, branch_id, stored_revision)) = authority else {
            return Ok(None);
        };
        if context_id != active_context_id {
            return Err(StorageError::Conflict("Inactive editing context".into()));
        }
        let draft: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT revision, document_json FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((draft_revision, json)) = draft {
            if draft_revision != stored_revision {
                return Err(StorageError::Conflict(
                    "Draft revision does not match document authority".into(),
                ));
            }
            return Ok(Some((
                draft_revision as u64,
                serde_json::from_str::<ResumeDocument>(&json)?,
            )));
        }

        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT snapshots.document_json
                 FROM documents
                 JOIN branches ON branches.id = documents.current_branch_id
                 JOIN commits ON commits.id = branches.head_commit_id
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE documents.id = ?1 AND branches.document_id = ?1 AND branches.id = ?2",
                params![document_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| {
            Ok((
                stored_revision as u64,
                serde_json::from_str::<ResumeDocument>(&json)?,
            ))
        })
        .transpose()
    }

    pub fn load_cursor(
        &self,
        document_id: &str,
        context_id: &str,
    ) -> StorageResult<Option<AuthorityCursor>> {
        let authority: Option<(String, String, i64)> = self
            .connection
            .query_row(
                "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((active_context_id, branch_id, revision)) = authority else {
            return Ok(None);
        };
        if active_context_id != context_id {
            return Err(StorageError::Conflict("Inactive editing context".into()));
        }
        let head_id: Option<Option<String>> = self
            .connection
            .query_row(
                "SELECT head_commit_id FROM branches WHERE document_id = ?1 AND id = ?2",
                params![document_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        let head_id =
            head_id.ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        let revision = u64::try_from(revision)
            .map_err(|_| StorageError::Corrupt("Document revision is negative".into()))?;
        Ok(Some(AuthorityCursor {
            document_id: document_id.into(),
            context_id: context_id.into(),
            revision: revision.to_string(),
            branch_id,
            head_id,
        }))
    }

    pub fn load_draft(
        &self,
        document_id: &str,
        context_id: &str,
    ) -> StorageResult<Option<(u64, ResumeDocument)>> {
        let row = self
            .connection
            .query_row(
                "SELECT drafts.revision, drafts.document_json FROM drafts
                 JOIN documents ON documents.id = drafts.document_id
                 WHERE drafts.document_id = ?1 AND drafts.context_id = ?2
                   AND drafts.branch_id = documents.current_branch_id",
                params![document_id, context_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        row.map(|(revision, json)| Ok((revision as u64, serde_json::from_str(&json)?)))
            .transpose()
    }

    /// Freeze the document and its avatar in one SQLite read snapshot.
    pub fn freeze_export(&self, expected: &AuthorityCursor) -> StorageResult<ExportSnapshot> {
        let transaction = self.connection.unchecked_transaction()?;
        let actual = self
            .load_cursor(&expected.document_id, &expected.context_id)?
            .ok_or_else(|| StorageError::NotFound("Export document is missing".into()))?;
        if &actual != expected {
            return Err(StorageError::Conflict(
                "Document changed before export".into(),
            ));
        }
        let (_, document) = self
            .load_current(&expected.document_id, &expected.context_id)?
            .ok_or(StorageError::MissingDraft)?;
        let avatar = match document.basic.avatar_asset_id.as_deref() {
            Some(hash) => Some(self.read_resource_bytes(hash)?.ok_or_else(|| {
                StorageError::NotFound("Export avatar resource is missing".into())
            })?),
            None => None,
        };
        transaction.commit()?;
        Ok((document, avatar))
    }

    pub fn commit_draft(
        &mut self,
        expected: &AuthorityCursor,
        message: &str,
    ) -> StorageResult<AuthorityCursor> {
        let message = message.trim();
        if message.is_empty() {
            return Err(StorageError::Validation(
                "Commit message is required".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor = Self::commit_draft_core(&transaction, expected, message)?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("COMMIT", "before-commit")?;
        transaction.commit()?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("COMMIT", "after-commit")?;
        Ok(cursor)
    }

    /// 版本提交核心：在调用方持有的事务内写快照、提交节点并推进分支指针。
    /// `commit_draft` 独占提交；提议确认的版本副作用在确认事务内复用本函数。
    fn commit_draft_core(
        transaction: &rusqlite::Transaction<'_>,
        expected: &AuthorityCursor,
        message: &str,
    ) -> StorageResult<AuthorityCursor> {
        let message = message.trim();
        if message.is_empty() {
            return Err(StorageError::Validation(
                "Commit message is required".into(),
            ));
        }
        let (branch_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let previous_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != previous_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let (draft_revision, json, stored_hash): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, document_json, hash FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(StorageError::MissingDraft)?;
        if draft_revision != revision {
            return Err(StorageError::Conflict(
                "Draft revision does not match document authority".into(),
            ));
        }
        let document: ResumeDocument = serde_json::from_str(&json)?;
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        let actual_hash = canonical_hash(&document)?;
        if document.document_id != expected.document_id || actual_hash != stored_hash {
            return Err(StorageError::HashMismatch);
        }
        if let Some(head_id) = previous_head.as_ref() {
            let head_hash: String = transaction
                .query_row(
                    "SELECT snapshots.hash FROM commits
                     JOIN snapshots ON snapshots.id = commits.snapshot_id
                     WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![head_id, expected.document_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Current head snapshot is missing".into()))?;
            if head_hash == actual_hash {
                return Err(StorageError::Validation("No uncommitted changes".into()));
            }
        }
        let snapshot_id = format!("snap-{actual_hash}");
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, actual_hash],
        )?;
        Self::sync_snapshot_resource_owner(transaction, &snapshot_id, &json)?;
        let random_id: String =
            transaction.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
        let commit_id = format!("commit:{}:{random_id}", expected.document_id);
        transaction.execute(
            "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                commit_id,
                expected.document_id,
                branch_id,
                snapshot_id,
                message
            ],
        )?;
        transaction.execute(
            "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
            params![commit_id, previous_head],
        )?;
        let updated_branch = transaction.execute(
            "UPDATE branches SET head_commit_id = ?1
             WHERE id = ?2 AND document_id = ?3 AND head_commit_id IS ?4",
            params![commit_id, branch_id, expected.document_id, previous_head],
        )?;
        if updated_branch != 1 {
            return Err(StorageError::Conflict("Stale branch head".into()));
        }
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![expected.document_id, context_id, branch_id],
        )?;
        Self::delete_draft_resource_owner(
            transaction,
            &expected.document_id,
            &context_id,
            &branch_id,
        )?;
        let updated_document = transaction.execute(
            "UPDATE documents SET revision = revision + 1
             WHERE id = ?1 AND current_branch_id = ?2 AND active_context_id = ?3 AND revision = ?4",
            params![expected.document_id, branch_id, context_id, revision],
        )?;
        if updated_document != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id,
            head_id: Some(commit_id),
        })
    }

    pub fn create_branch_from_current(
        &mut self,
        expected: &AuthorityCursor,
        name: &str,
    ) -> StorageResult<AuthorityCursor> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::Validation("Branch name is required".into()));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authority: (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let (branch_id, context_id, revision) = authority;
        let mut head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let mut existing =
            transaction.prepare("SELECT name FROM branches WHERE document_id = ?1")?;
        let names =
            existing.query_map(params![expected.document_id], |row| row.get::<_, String>(0))?;
        for existing_name in names {
            if existing_name?.to_lowercase() == name.to_lowercase() {
                return Err(StorageError::Conflict("Branch name already exists".into()));
            }
        }
        drop(existing);

        let draft: Option<(String, String)> = transaction
            .query_row(
                "SELECT document_json, hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (json, stored_hash) = if let Some(draft) = draft {
            draft
        } else if let Some(head_id) = head_id.as_ref() {
            transaction.query_row(
                "SELECT snapshots.document_json, snapshots.hash FROM snapshots
                 JOIN commits ON commits.snapshot_id = snapshots.id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![head_id, expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
        } else {
            return Err(StorageError::MissingDraft);
        };
        let document: ResumeDocument = serde_json::from_str(&json)?;
        let hash = canonical_hash(&document)?;
        if document.document_id != expected.document_id || hash != stored_hash {
            return Err(StorageError::HashMismatch);
        }
        let snapshot_id = format!("snap-{hash}");
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, hash],
        )?;
        Self::sync_snapshot_resource_owner(&transaction, &snapshot_id, &json)?;
        let random_id: String =
            transaction.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
        if head_id.is_none() {
            let baseline_id = format!("commit:{}:baseline:{random_id}", expected.document_id);
            transaction.execute(
                "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
                 VALUES (?1, ?2, ?3, ?4, '初始版本')",
                params![baseline_id, expected.document_id, branch_id, snapshot_id],
            )?;
            transaction.execute(
                "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, NULL)",
                params![baseline_id],
            )?;
            transaction.execute(
                "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
                params![baseline_id, branch_id, expected.document_id],
            )?;
            head_id = Some(baseline_id);
        }
        let new_branch_id = format!("branch:{}:{random_id}", expected.document_id);
        let commit_id = format!("commit:{}:{random_id}", expected.document_id);
        transaction.execute(
            "INSERT INTO branches(id, document_id, name) VALUES (?1, ?2, ?3)",
            params![new_branch_id, expected.document_id, name],
        )?;
        transaction.execute(
            "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                commit_id,
                expected.document_id,
                new_branch_id,
                snapshot_id,
                format!("创建分支：{name}")
            ],
        )?;
        transaction.execute(
            "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
            params![commit_id, head_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
            params![commit_id, new_branch_id, expected.document_id],
        )?;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![expected.document_id, context_id, branch_id],
        )?;
        Self::delete_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &context_id,
            &branch_id,
        )?;
        let changed = transaction.execute(
            "UPDATE documents SET current_branch_id = ?1, revision = revision + 1
             WHERE id = ?2 AND current_branch_id = ?3 AND active_context_id = ?4 AND revision = ?5",
            params![
                new_branch_id,
                expected.document_id,
                branch_id,
                context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id: new_branch_id,
            head_id: Some(commit_id),
        })
    }

    pub fn switch_branch(
        &mut self,
        expected: &AuthorityCursor,
        target_branch_id: &str,
        discard_uncommitted: bool,
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (branch_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let current_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != current_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        if target_branch_id == branch_id {
            return Ok(expected.clone());
        }
        let current_head = current_head.ok_or_else(|| {
            StorageError::Conflict("Current branch has no committed baseline".into())
        })?;
        let current_head_hash: String = transaction
            .query_row(
                "SELECT snapshots.hash FROM commits
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![current_head, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current head snapshot is missing".into()))?;
        let draft_hash: Option<String> = transaction
            .query_row(
                "SELECT hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if draft_hash
            .as_ref()
            .is_some_and(|hash| hash != &current_head_hash)
            && !discard_uncommitted
        {
            return Err(StorageError::Conflict(
                "Uncommitted changes require confirmation".into(),
            ));
        }

        let target_head: String = transaction
            .query_row(
                "SELECT branches.head_commit_id FROM branches
                 LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                 WHERE branches.id = ?1 AND branches.document_id = ?2
                   AND branch_tombstones.branch_id IS NULL",
                params![target_branch_id, expected.document_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Target branch not found".into()))?
            .ok_or_else(|| StorageError::NotFound("Target branch has no head".into()))?;
        let (target_json, target_hash): (String, String) = transaction
            .query_row(
                "SELECT snapshots.document_json, snapshots.hash FROM commits
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![target_head, expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Target head snapshot is missing".into()))?;
        let target_document: ResumeDocument = serde_json::from_str(&target_json)?;
        if target_document.document_id != expected.document_id
            || canonical_hash(&target_document)? != target_hash
        {
            return Err(StorageError::HashMismatch);
        }
        let target_draft_hash: Option<String> = transaction
            .query_row(
                "SELECT hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, target_branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if target_draft_hash
            .as_ref()
            .is_some_and(|hash| hash != &target_hash)
        {
            return Err(StorageError::Conflict(
                "Target branch has an unsaved draft".into(),
            ));
        }
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2
             AND branch_id IN (?3, ?4)",
            params![
                expected.document_id,
                context_id,
                branch_id,
                target_branch_id
            ],
        )?;
        Self::delete_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &context_id,
            &branch_id,
        )?;
        Self::delete_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &context_id,
            target_branch_id,
        )?;
        let changed = transaction.execute(
            "UPDATE documents SET current_branch_id = ?1, title = ?2, revision = revision + 1
             WHERE id = ?3 AND current_branch_id = ?4 AND active_context_id = ?5 AND revision = ?6",
            params![
                target_branch_id,
                target_document.title,
                expected.document_id,
                branch_id,
                context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id: target_branch_id.into(),
            head_id: Some(target_head),
        })
    }

    pub fn load_commit_into_draft(
        &mut self,
        expected: &AuthorityCursor,
        commit_id: &str,
        confirmed: bool,
    ) -> StorageResult<AuthorityCursor> {
        if !confirmed {
            return Err(StorageError::Validation(
                "Loading history requires confirmation".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (branch_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }

        let (json, stored_hash): (String, String) = transaction
            .query_row(
                "SELECT snapshots.document_json, snapshots.hash FROM commits
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![commit_id, expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("History commit not found".into()))?;
        let document: ResumeDocument = serde_json::from_str(&json)?;
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        if document.document_id != expected.document_id || canonical_hash(&document)? != stored_hash
        {
            return Err(StorageError::HashMismatch);
        }
        let (target_kind, target_source_id) = document
            .legacy_extensions
            .get("importedTemplate")
            .and_then(|value| value.get("id"))
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty() && id.len() <= 512)
            .map(|id| (EditingContextSourceKind::ImportedTemplate, id.to_string()))
            .unwrap_or((EditingContextSourceKind::Workspace, "default".into()));
        let target_source_kind_name = editing_context_source_name(target_kind);
        let mut source_rows = transaction.prepare(
            "SELECT id FROM editing_contexts
             WHERE document_id = ?1 AND source_kind = ?2 AND source_id = ?3",
        )?;
        let source_contexts = source_rows
            .query_map(
                params![
                    expected.document_id,
                    target_source_kind_name,
                    target_source_id
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(source_rows);
        if source_contexts.len() > 1 {
            return Err(StorageError::Corrupt(
                "History source maps to multiple editing contexts".into(),
            ));
        }
        let target_context_id = source_contexts
            .first()
            .cloned()
            .unwrap_or_else(|| stable_editing_context_id(target_kind, &target_source_id));
        if source_contexts.is_empty() {
            let collision: Option<(String, String)> = transaction
                .query_row(
                    "SELECT source_kind, source_id FROM editing_contexts
                     WHERE document_id = ?1 AND id = ?2",
                    params![expected.document_id, target_context_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if collision.is_some() {
                return Err(StorageError::Corrupt(
                    "Stable history context ID is already assigned".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    target_context_id,
                    expected.document_id,
                    target_source_kind_name,
                    target_source_id
                ],
            )?;
        }

        let changed = transaction.execute(
            "UPDATE documents SET title = ?1, active_context_id = ?2, revision = revision + 1
             WHERE id = ?3 AND current_branch_id = ?4 AND active_context_id = ?5 AND revision = ?6",
            params![
                document.title,
                target_context_id,
                expected.document_id,
                branch_id,
                context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
               revision = excluded.revision,
               document_json = excluded.document_json,
               hash = excluded.hash,
               updated_at = CURRENT_TIMESTAMP",
            params![
                expected.document_id,
                target_context_id,
                branch_id,
                revision + 1,
                json,
                stored_hash
            ],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &target_context_id,
            &branch_id,
            &json,
        )?;
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id: target_context_id,
            revision: (revision + 1).to_string(),
            branch_id,
            head_id,
        })
    }

    pub fn delete_commit(
        &mut self,
        expected: &AuthorityCursor,
        commit_id: &str,
        confirmed: bool,
    ) -> StorageResult<AuthorityCursor> {
        if !confirmed {
            return Err(StorageError::Validation(
                "Deleting a commit requires confirmation".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (branch_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let current_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != current_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let parent_id: Option<String> = transaction
            .query_row(
                "SELECT commit_links.visible_parent_id FROM commits
                 JOIN commit_links ON commit_links.commit_id = commits.id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![commit_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("History commit not found".into()))?;
        if let Some(parent_id) = parent_id.as_ref() {
            let parent_document_id: String = transaction
                .query_row(
                    "SELECT document_id FROM commits WHERE id = ?1",
                    [parent_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("History parent is missing".into()))?;
            if parent_document_id != expected.document_id {
                return Err(StorageError::Corrupt(
                    "History parent crosses documents".into(),
                ));
            }
        }

        let draft_revision: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(draft_revision) = draft_revision {
            if draft_revision != revision {
                return Err(StorageError::Conflict("Draft revision is stale".into()));
            }
            transaction.execute(
                "UPDATE drafts SET revision = ?1, updated_at = CURRENT_TIMESTAMP
                 WHERE document_id = ?2 AND context_id = ?3 AND branch_id = ?4",
                params![revision + 1, expected.document_id, context_id, branch_id],
            )?;
        } else if current_head.as_deref() == Some(commit_id) {
            let (json, stored_hash): (String, String) = transaction
                .query_row(
                    "SELECT snapshots.document_json, snapshots.hash FROM commits
                         JOIN snapshots ON snapshots.id = commits.snapshot_id
                         WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![commit_id, expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Current head snapshot is missing".into()))?;
            let document: ResumeDocument = serde_json::from_str(&json)?;
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
            if document.document_id != expected.document_id
                || canonical_hash(&document)? != stored_hash
            {
                return Err(StorageError::HashMismatch);
            }
            transaction.execute(
                    "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![expected.document_id, context_id, branch_id, revision + 1, json, stored_hash],
                )?;
            Self::sync_draft_resource_owner(
                &transaction,
                &expected.document_id,
                &context_id,
                &branch_id,
                &json,
            )?;
        }
        transaction.execute(
            "UPDATE commit_links SET visible_parent_id = ?1 WHERE visible_parent_id = ?2",
            params![parent_id, commit_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = ?1
             WHERE document_id = ?2 AND head_commit_id = ?3",
            params![parent_id, expected.document_id, commit_id],
        )?;
        transaction.execute("DELETE FROM commit_links WHERE commit_id = ?1", [commit_id])?;
        transaction.execute(
            "DELETE FROM commits WHERE id = ?1 AND document_id = ?2",
            params![commit_id, expected.document_id],
        )?;
        let changed = transaction.execute(
            "UPDATE documents SET revision = revision + 1
             WHERE id = ?1 AND current_branch_id = ?2 AND active_context_id = ?3 AND revision = ?4",
            params![expected.document_id, branch_id, context_id, revision],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id,
            head_id: if current_head.as_deref() == Some(commit_id) {
                parent_id
            } else {
                current_head
            },
        })
    }

    pub fn delete_branch(
        &mut self,
        expected: &AuthorityCursor,
        target_branch_id: &str,
        confirmed: bool,
    ) -> StorageResult<AuthorityCursor> {
        if !confirmed {
            return Err(StorageError::Validation(
                "Deleting a branch requires confirmation".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_branch, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let current_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![current_branch, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != current_branch
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != current_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let target_name: String = transaction
            .query_row(
                "SELECT branches.name FROM branches
                 LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                 WHERE branches.id = ?1 AND branches.document_id = ?2
                   AND branch_tombstones.branch_id IS NULL",
                params![target_branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Active branch not found".into()))?;
        if target_name == "main"
            || target_branch_id == default_branch_id(&expected.document_id)
            || target_branch_id == "main"
        {
            return Err(StorageError::Validation(
                "Default branch is protected".into(),
            ));
        }
        let deleting_current = target_branch_id == current_branch;
        let mut next_branch = current_branch.clone();
        let mut next_head = current_head.clone();
        let mut next_title: Option<String> = None;
        if deleting_current {
            let (main_id, main_head): (String, String) = transaction
                .query_row(
                    "SELECT branches.id, branches.head_commit_id FROM branches
                     LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                     WHERE branches.document_id = ?1 AND branches.name = 'main'
                       AND branch_tombstones.branch_id IS NULL",
                    params![expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    StorageError::Corrupt("Default branch is missing its head".into())
                })?;
            let (json, hash): (String, String) = transaction
                .query_row(
                    "SELECT snapshots.document_json, snapshots.hash FROM commits
                     JOIN snapshots ON snapshots.id = commits.snapshot_id
                     WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![main_head, expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Default head snapshot is missing".into()))?;
            let document: ResumeDocument = serde_json::from_str(&json)?;
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
            if document.document_id != expected.document_id || canonical_hash(&document)? != hash {
                return Err(StorageError::HashMismatch);
            }
            let main_draft_hash: Option<String> = transaction
                .query_row(
                    "SELECT hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![expected.document_id, context_id, main_id],
                    |row| row.get(0),
                )
                .optional()?;
            if main_draft_hash
                .as_ref()
                .is_some_and(|draft_hash| draft_hash != &hash)
            {
                return Err(StorageError::Conflict(
                    "Default branch has an unsaved draft".into(),
                ));
            }
            Self::delete_draft_resource_owner(
                &transaction,
                &expected.document_id,
                &context_id,
                &main_id,
            )?;
            transaction.execute(
                "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, main_id],
            )?;
            next_branch = main_id;
            next_head = Some(main_head);
            next_title = Some(document.title);
        } else {
            transaction.execute(
                "UPDATE drafts SET revision = ?1, updated_at = CURRENT_TIMESTAMP
                 WHERE document_id = ?2 AND context_id = ?3 AND branch_id = ?4",
                params![
                    revision + 1,
                    expected.document_id,
                    context_id,
                    current_branch
                ],
            )?;
        }
        // 必须在草稿仍存在时先收集 owner 并清理其资源引用：先删草稿再查会
        // 恒为空集，被删分支草稿的 resource_refs / resource_recovery_requirements
        // 将永久残留，GC 永远无法回收这些资产。owner 级清理不会触碰仍被
        // 其他草稿或快照持有的引用。
        Self::delete_branch_draft_resource_owners(
            &transaction,
            &expected.document_id,
            target_branch_id,
        )?;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND branch_id = ?2",
            params![expected.document_id, target_branch_id],
        )?;
        transaction.execute(
            "INSERT INTO branch_tombstones(branch_id) VALUES (?1)",
            [target_branch_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = NULL, name = ?1
             WHERE id = ?2 AND document_id = ?3",
            params![
                format!("__deleted__:{target_branch_id}"),
                target_branch_id,
                expected.document_id
            ],
        )?;
        let unreachable = {
            let mut statement = transaction.prepare(
                "WITH RECURSIVE reachable(id) AS (
                   SELECT branches.head_commit_id FROM branches
                   LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                   WHERE branches.document_id = ?1 AND branches.head_commit_id IS NOT NULL
                     AND branch_tombstones.branch_id IS NULL
                   UNION
                   SELECT links.visible_parent_id FROM commit_links AS links
                   JOIN reachable ON reachable.id = links.commit_id
                   JOIN commits AS parent ON parent.id = links.visible_parent_id
                   WHERE parent.document_id = ?1
                 )
                 SELECT id FROM commits WHERE document_id = ?1
                   AND id NOT IN (SELECT id FROM reachable)",
            )?;
            let ids = statement
                .query_map(params![expected.document_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        for id in &unreachable {
            transaction.execute("DELETE FROM commit_links WHERE commit_id = ?1", [id])?;
        }
        for id in &unreachable {
            transaction.execute("DELETE FROM commits WHERE id = ?1", [id])?;
        }
        let changed = transaction.execute(
            "UPDATE documents SET current_branch_id = ?1, title = COALESCE(?2, title), revision = revision + 1
             WHERE id = ?3 AND current_branch_id = ?4 AND active_context_id = ?5 AND revision = ?6",
            params![next_branch, next_title, expected.document_id, current_branch, context_id, revision],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id: next_branch,
            head_id: next_head,
        })
    }

    pub fn put_resource(
        &self,
        hash: &str,
        mime: &str,
        bytes: &[u8],
        license_ref: Option<&str>,
    ) -> StorageResult<()> {
        if format!("{:x}", Sha256::digest(bytes)) != hash {
            return Err(StorageError::HashMismatch);
        }
        self.connection.execute(
            "INSERT INTO resources(hash, mime, bytes, size, license_ref) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(hash) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, size = excluded.size",
            params![hash, mime, bytes, bytes.len() as i64, license_ref],
        )?;
        self.connection.execute(
            "DELETE FROM resource_recovery_requirements WHERE resource_hash = ?1",
            [hash],
        )?;
        Ok(())
    }

    pub fn link_resource(&self, hash: &str, owner_kind: &str, owner_id: &str) -> StorageResult<()> {
        if !matches!(
            owner_kind,
            "draft" | "snapshot" | "retained-template" | "pending-import" | "document-avatar"
        ) {
            return Err(StorageError::Validation(
                "Unknown durable resource owner kind".into(),
            ));
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO resource_refs(resource_hash, owner_kind, owner_id) VALUES (?1, ?2, ?3)",
            params![hash, owner_kind, owner_id],
        )?;
        Ok(())
    }

    pub fn unlink_resource(
        &self,
        hash: &str,
        owner_kind: &str,
        owner_id: &str,
    ) -> StorageResult<usize> {
        Ok(self.connection.execute(
            "DELETE FROM resource_refs WHERE resource_hash = ?1 AND owner_kind = ?2 AND owner_id = ?3",
            params![hash, owner_kind, owner_id],
        )?)
    }

    pub fn collect_unreferenced_resources(&self) -> StorageResult<usize> {
        resources::collect_unreferenced(&self.connection)
    }

    pub fn create_resource_lease(
        &self,
        hashes: &[String],
        ttl_seconds: u64,
    ) -> StorageResult<String> {
        resources::acquire_lease(&self.connection, hashes, ttl_seconds)
    }

    fn create_all_resource_lease(&self, ttl_seconds: u64) -> StorageResult<String> {
        resources::acquire_all_resource_lease(&self.connection, ttl_seconds)
    }

    pub fn release_resource_lease(&self, lease_id: &str) -> StorageResult<()> {
        resources::release_lease(&self.connection, lease_id)
    }

    fn draft_resource_owner_id(document_id: &str, context_id: &str, branch_id: &str) -> String {
        serde_json::to_string(&[document_id, context_id, branch_id])
            .expect("resource owner tuple serialization cannot fail")
    }

    fn sync_draft_resource_owner(
        connection: &Connection,
        document_id: &str,
        context_id: &str,
        branch_id: &str,
        document_json: &str,
    ) -> StorageResult<()> {
        let owner_id = Self::draft_resource_owner_id(document_id, context_id, branch_id);
        resources::sync_document_resource_owner(connection, "draft", &owner_id, document_json)
    }

    fn sync_snapshot_resource_owner(
        connection: &Connection,
        snapshot_id: &str,
        document_json: &str,
    ) -> StorageResult<()> {
        resources::sync_document_resource_owner(connection, "snapshot", snapshot_id, document_json)
    }

    fn delete_draft_resource_owner(
        connection: &Connection,
        document_id: &str,
        context_id: &str,
        branch_id: &str,
    ) -> StorageResult<()> {
        let owner_id = Self::draft_resource_owner_id(document_id, context_id, branch_id);
        connection.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&owner_id],
        )?;
        connection.execute(
            "DELETE FROM resource_recovery_requirements WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&owner_id],
        )?;
        Ok(())
    }

    fn delete_branch_draft_resource_owners(
        connection: &Connection,
        document_id: &str,
        branch_id: &str,
    ) -> StorageResult<()> {
        let contexts = {
            let mut statement = connection.prepare(
                "SELECT context_id FROM drafts WHERE document_id = ?1 AND branch_id = ?2",
            )?;
            let rows = statement.query_map(params![document_id, branch_id], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for context_id in contexts {
            Self::delete_draft_resource_owner(connection, document_id, &context_id, branch_id)?;
        }
        Ok(())
    }

    pub fn resource_count(&self) -> StorageResult<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))?)
    }

    pub fn load_version_graph(&self, document_id: &str) -> StorageResult<VersionGraph> {
        let transaction = self.connection.unchecked_transaction()?;
        let (context_id, branch_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
                [document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        let branches = {
            let mut statement = transaction.prepare(
                "SELECT branches.id, branches.name, branches.head_commit_id, branches.created_at
                 FROM branches LEFT JOIN branch_tombstones
                   ON branch_tombstones.branch_id = branches.id
                 WHERE branches.document_id = ?1 AND branch_tombstones.branch_id IS NULL
                 ORDER BY branches.created_at, branches.id",
            )?;
            let rows = statement.query_map([document_id], |row| {
                let id: String = row.get(0)?;
                Ok(VersionBranch {
                    is_current: id == branch_id,
                    id,
                    name: row.get(1)?,
                    head_commit_id: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if !branches.iter().any(|branch| branch.is_current) {
            return Err(StorageError::Corrupt("Current branch is deleted".into()));
        }
        let commits = {
            let mut statement = transaction.prepare(
                "SELECT commits.id, commits.origin_branch_id,
                        branch_tombstones.branch_id IS NOT NULL,
                        commits.snapshot_id, commit_links.visible_parent_id,
                        commits.message, commits.created_at
                 FROM commits
                 JOIN commit_links ON commit_links.commit_id = commits.id
                 LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = commits.origin_branch_id
                 WHERE commits.document_id = ?1
                 ORDER BY commits.created_at DESC, commits.id DESC",
            )?;
            let rows = statement.query_map([document_id], |row| {
                Ok(VersionCommit {
                    id: row.get(0)?,
                    origin_branch_id: row.get(1)?,
                    origin_deleted: row.get(2)?,
                    snapshot_id: row.get(3)?,
                    parent_id: row.get(4)?,
                    message: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let total_commits: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM commits WHERE document_id = ?1",
            [document_id],
            |row| row.get(0),
        )?;
        if commits.len() as i64 != total_commits {
            return Err(StorageError::Corrupt(
                "History commit link is missing".into(),
            ));
        }
        transaction.commit()?;
        Ok(VersionGraph {
            cursor: AuthorityCursor {
                document_id: document_id.into(),
                context_id,
                revision: revision.to_string(),
                branch_id,
                head_id,
            },
            branches,
            commits,
        })
    }

    pub fn commit_count(&self, document_id: &str) -> StorageResult<i64> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM commits WHERE document_id = ?1",
            params![document_id],
            |row| row.get(0),
        )?)
    }

    /// 单次 load_version_graph_detailed 物化快照的默认提交上限（新→旧，含
    /// 当前 head）。结构始终全量返回；覆盖 F24 千版本验收输入，超大图
    /// （>1000 提交）只物化最新 1000 个以约束内存。
    pub const VERSION_GRAPH_DETAILED_DEFAULT_LIMIT: usize = 1000;

    /// 版本 UI 使用：同一读事务返回 graph 与每个提交的快照 document JSON。
    /// 默认有界：最多物化 [`Store::VERSION_GRAPH_DETAILED_DEFAULT_LIMIT`]
    /// 个提交的快照（新→旧），当前分支 head 保证在列。
    pub fn load_version_graph_detailed(
        &self,
        document_id: &str,
    ) -> StorageResult<VersionGraphDetailed> {
        self.load_version_graph_detailed_with_limit(
            document_id,
            Self::VERSION_GRAPH_DETAILED_DEFAULT_LIMIT,
        )
    }

    /// 有界读取：limit 为单次物化快照的提交上限（>0）。返回的提交仍按
    /// created_at DESC, id DESC 排序；当前分支 head 不在窗口内时追加在末尾
    /// （head 比窗口内所有提交更旧，排序不变），保证 agent 草稿 diff 与
    /// UI 当前基线不因有界读取丢失 head。
    /// 有界物化：提交结构全量返回（不丢祖先/共享节点），快照 JSON 仅物化
    /// 最新 `limit` 个提交（当前分支 head 永远物化，保证 agent 草稿 diff 与
    /// UI 当前基线可用）；更旧提交的 snapshot_document_json 为空串，需要时
    /// 用 [`Store::load_commit_detail`] 按需取回。
    pub fn load_version_graph_detailed_with_limit(
        &self,
        document_id: &str,
        limit: usize,
    ) -> StorageResult<VersionGraphDetailed> {
        if limit == 0 {
            return Err(StorageError::Validation(
                "Version graph detail limit must be positive".into(),
            ));
        }
        let graph = self.load_version_graph(document_id)?;
        let head_id = graph.cursor.head_id.clone();
        let mut detailed = Vec::with_capacity(graph.commits.len());
        for (index, commit) in graph.commits.iter().enumerate() {
            let materialize = index < limit || Some(commit.id.as_str()) == head_id.as_deref();
            let detail = if materialize {
                Self::version_commit_detail(&self.connection, commit)?
            } else {
                VersionCommitDetailed {
                    commit: commit.clone(),
                    snapshot_document_json: String::new(),
                }
            };
            detailed.push(detail);
        }
        Ok(VersionGraphDetailed {
            cursor: graph.cursor,
            branches: graph.branches,
            commits: detailed,
        })
    }

    /// 按需单条取回提交详情（含快照 JSON）；供有界版本图窗口之外的历史
    /// 版本引用使用，保持与全量图一致的可见性语义。
    pub fn load_commit_detail(
        &self,
        document_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<VersionCommitDetailed>> {
        let commit = self
            .connection
            .query_row(
                "SELECT commits.id, commits.origin_branch_id,
                        branch_tombstones.branch_id IS NOT NULL,
                        commits.snapshot_id, commit_links.visible_parent_id,
                        commits.message, commits.created_at
                 FROM commits
                 JOIN commit_links ON commit_links.commit_id = commits.id
                 LEFT JOIN branch_tombstones
                   ON branch_tombstones.branch_id = commits.origin_branch_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![commit_id, document_id],
                |row| {
                    Ok(VersionCommit {
                        id: row.get(0)?,
                        origin_branch_id: row.get(1)?,
                        origin_deleted: row.get(2)?,
                        snapshot_id: row.get(3)?,
                        parent_id: row.get(4)?,
                        message: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()?;
        let Some(commit) = commit else {
            return Ok(None);
        };
        Ok(Some(Self::version_commit_detail(
            &self.connection,
            &commit,
        )?))
    }

    fn version_commit_detail(
        connection: &Connection,
        commit: &VersionCommit,
    ) -> StorageResult<VersionCommitDetailed> {
        let json: String = connection
            .query_row(
                "SELECT document_json FROM snapshots WHERE id = ?1",
                [&commit.snapshot_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                StorageError::Corrupt(format!(
                    "Snapshot {} for commit {} is missing",
                    commit.snapshot_id, commit.id
                ))
            })?;
        // 返回前确认快照仍是合法 ResumeDocument，损坏直接报错而不是空历史。
        let _: ResumeDocument = serde_json::from_str(&json)
            .map_err(|error| StorageError::Corrupt(format!("Snapshot parse failed: {error}")))?;
        Ok(VersionCommitDetailed {
            commit: commit.clone(),
            snapshot_document_json: json,
        })
    }

    /// 头像资产读取：按 hash 返回 (mime, bytes)；缺失返回 None 而不是错误。
    pub fn read_resource_bytes(&self, hash: &str) -> StorageResult<Option<(String, Vec<u8>)>> {
        let resource: Option<(String, Vec<u8>, i64)> = self
            .connection
            .query_row(
                "SELECT mime, bytes, size FROM resources WHERE hash = ?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        resource
            .map(|(mime, bytes, size)| {
                if size != bytes.len() as i64 || format!("{:x}", Sha256::digest(&bytes)) != hash {
                    return Err(StorageError::HashMismatch);
                }
                Ok((mime, bytes))
            })
            .transpose()
    }

    pub fn create_import_draft(
        &mut self,
        request: &zinecv_contracts::CreateImportDraftRequest,
    ) -> StorageResult<ImportDraft> {
        validate_import_draft_header(
            &request.draft_id,
            &request.display_name,
            &request.source_hash,
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO import_drafts(id, source_kind, display_name, source_hash, status)
             VALUES (?1, ?2, ?3, ?4, 'queued')",
            params![
                request.draft_id,
                import_source_name(request.source_kind),
                request.display_name,
                request.source_hash.to_ascii_lowercase()
            ],
        )?;
        let draft = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        transaction.commit()?;
        Ok(draft)
    }

    pub fn read_import_draft(&self, draft_id: &str) -> StorageResult<Option<ImportDraft>> {
        read_import_draft_tx(&self.connection, draft_id)
    }

    pub fn transition_import_draft(
        &mut self,
        request: &TransitionImportDraftRequest,
    ) -> StorageResult<ImportDraft> {
        if request.draft_id.trim().is_empty() || request.draft_id.len() > 160 {
            return Err(StorageError::Validation("Invalid import draft ID".into()));
        }
        if !valid_import_transition(request.expected_status, request.next_status) {
            return Err(StorageError::Conflict(
                "Import draft status transition is not allowed".into(),
            ));
        }
        let candidates = request.candidates.as_deref().unwrap_or_default();
        let warnings = request.warnings.as_deref().unwrap_or_default();
        let unsupported = request.unsupported_features.as_deref().unwrap_or_default();
        validate_import_review_payload(candidates, warnings, unsupported)?;
        if request.next_status == ImportDraftStatus::ReviewRequired && request.candidates.is_none()
        {
            return Err(StorageError::Validation(
                "Review state requires parsed candidates".into(),
            ));
        }
        let preview = request
            .preview_data_url
            .as_deref()
            .map(parse_import_preview_data_url)
            .transpose()?
            .flatten();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        if existing.status != request.expected_status {
            return Err(StorageError::Conflict(
                "Import draft changed before the requested transition".into(),
            ));
        }
        let mut preview_asset_id = existing.preview_asset_id.clone();
        if let Some((mime, bytes)) = preview {
            let hash = format!("{:x}", Sha256::digest(&bytes));
            transaction.execute(
                "INSERT OR IGNORE INTO resources(hash, mime, bytes, size, license_ref)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![hash, mime, bytes, bytes.len() as i64],
            )?;
            transaction.execute(
                "DELETE FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
                [&request.draft_id],
            )?;
            transaction.execute(
                "INSERT OR IGNORE INTO resource_refs(resource_hash, owner_kind, owner_id)
                 VALUES (?1, 'pending-import', ?2)",
                params![hash, request.draft_id],
            )?;
            preview_asset_id = Some(hash);
        }
        let (candidate_json, warnings_json, unsupported_json) =
            if request.next_status == ImportDraftStatus::ReviewRequired {
                (
                    serde_json::to_string(candidates)?,
                    serde_json::to_string(warnings)?,
                    serde_json::to_string(unsupported)?,
                )
            } else {
                (
                    serde_json::to_string(&existing.candidates)?,
                    serde_json::to_string(&existing.warnings)?,
                    serde_json::to_string(&existing.unsupported_features)?,
                )
            };
        if matches!(
            request.next_status,
            ImportDraftStatus::Failed | ImportDraftStatus::Cancelled
        ) {
            transaction.execute(
                "DELETE FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
                [&request.draft_id],
            )?;
            preview_asset_id = None;
        }
        transaction.execute(
            "UPDATE import_drafts SET status = ?2, preview_asset_id = ?3,
                candidates_json = ?4, warnings_json = ?5, unsupported_features_json = ?6,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND status = ?7",
            params![
                request.draft_id,
                import_status_name(request.next_status),
                preview_asset_id,
                candidate_json,
                warnings_json,
                unsupported_json,
                import_status_name(request.expected_status)
            ],
        )?;
        let draft = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        transaction.commit()?;
        Ok(draft)
    }

    pub fn apply_import(
        &mut self,
        actor: &str,
        request: &ApplyImportRequest,
    ) -> StorageResult<CommandResult> {
        validate_import_command(request, actor)?;
        let request_hash = canonical_hash(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some((stored_actor, stored_hash, result_json)) = transaction
            .query_row(
                "SELECT actor, request_hash, result_json FROM command_receipts WHERE command_id = ?1",
                params![request.command_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if stored_actor == actor && stored_hash == request_hash {
                let result = serde_json::from_str(&result_json)?;
                transaction.commit()?;
                return Ok(result);
            }
            return Err(StorageError::Conflict(
                "Import command ID was already used for another request".into(),
            ));
        }

        let import = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        if import.status != ImportDraftStatus::ReviewRequired {
            return Err(StorageError::Conflict(
                "Import draft is not awaiting review".into(),
            ));
        }
        let mut accepted = BTreeSet::new();
        for id in &request.accepted_candidate_ids {
            if !accepted.insert(id.as_str()) {
                return Err(StorageError::Validation(
                    "Accepted import candidates contain duplicate IDs".into(),
                ));
            }
        }
        if accepted.is_empty() {
            return Err(StorageError::Validation(
                "Select at least one import candidate".into(),
            ));
        }
        let candidate_ids: BTreeSet<&str> = import
            .candidates
            .iter()
            .map(|candidate| candidate.id.as_str())
            .collect();
        if accepted.iter().any(|id| !candidate_ids.contains(id)) {
            return Err(StorageError::Validation(
                "Accepted import candidate was not found".into(),
            ));
        }

        let (branch_id, context_id, revision, head_id): (String, String, i64, Option<String>) =
            transaction
                .query_row(
                    "SELECT d.current_branch_id, d.active_context_id, d.revision, b.head_commit_id
                     FROM documents d JOIN branches b ON b.id = d.current_branch_id AND b.document_id = d.id
                     WHERE d.id = ?1",
                    params![request.cursor.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        if request.cursor.branch_id != branch_id
            || request.cursor.context_id != context_id
            || request.cursor.revision != revision.to_string()
            || request.cursor.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let (draft_revision, document_json, stored_hash): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, document_json, hash FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![request.cursor.document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(StorageError::MissingDraft)?;
        let mut document: ResumeDocument = serde_json::from_str(&document_json)?;
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        if draft_revision != revision
            || document.document_id != request.cursor.document_id
            || canonical_hash(&document)? != stored_hash
        {
            return Err(StorageError::Conflict(
                "Current durable document does not match its authority cursor".into(),
            ));
        }
        for candidate in &import.candidates {
            if accepted.contains(candidate.id.as_str()) {
                apply_import_candidate(&mut document, &import.id, candidate)?;
            }
        }
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Document revision overflow".into()))?;
        let document_json = serde_json::to_string(&document)?;
        let document_hash = canonical_hash(&document)?;
        let changed = transaction.execute(
            "UPDATE drafts SET revision = ?4, document_json = ?5, hash = ?6,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3 AND revision = ?7",
            params![
                request.cursor.document_id,
                context_id,
                branch_id,
                next_revision,
                document_json,
                document_hash,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale document draft".into()));
        }
        Self::sync_draft_resource_owner(
            &transaction,
            &request.cursor.document_id,
            &context_id,
            &branch_id,
            &document_json,
        )?;
        let changed_document = transaction.execute(
            "UPDATE documents SET title = ?2, revision = ?3 WHERE id = ?1 AND revision = ?4",
            params![
                request.cursor.document_id,
                document.title,
                next_revision,
                revision
            ],
        )?;
        if changed_document != 1 {
            return Err(StorageError::Conflict("Stale document revision".into()));
        }
        let result = CommandResult {
            command_id: request.command_id.clone(),
            cursor: AuthorityCursor {
                document_id: request.cursor.document_id.clone(),
                context_id,
                revision: next_revision.to_string(),
                branch_id,
                head_id,
            },
            durable: true,
            snapshot_hash: document_hash,
            changed_ids: accepted.iter().map(|id| (*id).to_string()).collect(),
            document,
        };
        transaction.execute(
            "INSERT INTO command_receipts(command_id, document_id, actor, request_hash, result_json, result_hash, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                request.command_id,
                result.cursor.document_id,
                actor,
                request_hash,
                serde_json::to_string(&result)?,
                canonical_hash(&result)?,
                next_revision
            ],
        )?;
        transaction.execute(
            "UPDATE import_drafts SET status = 'committed', preview_asset_id = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND status = 'review_required'",
            params![request.draft_id],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
            params![request.draft_id],
        )?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("IMPORT", "before-commit")?;
        transaction.commit()?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("IMPORT", "after-commit")?;
        Ok(result)
    }

    /// 工作区偏好读取（B08）；值缺失返回 None。
    pub fn read_setting(&self, key: &str) -> StorageResult<Option<String>> {
        Ok(self
            .connection
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    /// Imported templates can contain an image preview larger than the generic setting limit.
    /// A missing row means this profile has not yet imported its old browser catalog.
    pub fn read_imported_template_catalog(&self) -> StorageResult<Option<ImportedTemplateCatalog>> {
        let stored: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT revision, payload_json FROM imported_template_catalog WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        stored
            .map(|(revision, payload_json)| {
                Ok(ImportedTemplateCatalog {
                    revision,
                    payload_json: resources::catalog_with_revision_metadata(
                        &self.connection,
                        &payload_json,
                    )?,
                })
            })
            .transpose()
    }

    pub fn contains_imported_template(&self, source_id: &str) -> StorageResult<bool> {
        let Some(catalog) = self.read_imported_template_catalog()? else {
            return Ok(false);
        };
        let value: serde_json::Value = serde_json::from_str(&catalog.payload_json)?;
        let Some(items) = value.as_array() else {
            return Err(StorageError::Corrupt(
                "Imported template catalog is not an array".into(),
            ));
        };
        Ok(items
            .iter()
            .any(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(source_id)))
    }

    pub fn write_imported_template_catalog(
        &mut self,
        payload_json: &str,
        expected_revision: i64,
    ) -> StorageResult<i64> {
        let value: serde_json::Value = serde_json::from_str(payload_json)?;
        if !value.is_array() {
            return Err(StorageError::Validation(
                "Template catalog must be an array".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM imported_template_catalog WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if actual.unwrap_or(0) != expected_revision {
            return Err(StorageError::Conflict(
                "Template catalog changed in another window".into(),
            ));
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Template catalog revision overflow".into()))?;
        let normalized_payload =
            resources::normalize_catalog_for_storage(&transaction, payload_json)?;
        transaction.execute(
            "INSERT INTO imported_template_catalog(id, payload_json, revision, updated_at)
             VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(id) DO UPDATE SET
               payload_json = excluded.payload_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![normalized_payload, revision],
        )?;
        transaction.commit()?;
        Ok(revision)
    }

    pub fn list_template_activity(&self) -> StorageResult<Vec<TemplateActivity>> {
        let mut statement = self.connection.prepare(
            "SELECT template_id, favorite, last_used_at FROM template_activity ORDER BY template_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(TemplateActivity {
                    template_id: row.get(0)?,
                    favorite: row.get::<_, i64>(1)? == 1,
                    last_used_at: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Import old WebView activity once. The marker and rows commit together.
    pub fn bootstrap_template_activity(
        &mut self,
        legacy_json: &str,
    ) -> StorageResult<Vec<TemplateActivity>> {
        let legacy: serde_json::Value = serde_json::from_str(legacy_json)?;
        let entries = legacy.as_object().ok_or_else(|| {
            StorageError::Validation("Legacy template activity must be an object".into())
        })?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let migrated: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'template-activity-migrated-v1')",
            [],
            |row| row.get(0),
        )?;
        if !migrated {
            for (id, activity) in entries {
                if id.trim().is_empty() || id.len() > 256 {
                    return Err(StorageError::Validation(
                        "Invalid template activity ID".into(),
                    ));
                }
                let favorite = activity
                    .get("favorite")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let last_used_at = activity
                    .get("lastUsedAt")
                    .and_then(serde_json::Value::as_i64)
                    .filter(|value| *value > 0);
                transaction.execute(
                    "INSERT INTO template_activity(template_id, favorite, last_used_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(template_id) DO NOTHING",
                    params![id, favorite, last_used_at],
                )?;
            }
            transaction.execute(
                "INSERT INTO settings(key, value) VALUES ('template-activity-migrated-v1', '1')",
                [],
            )?;
        }
        transaction.commit()?;
        self.list_template_activity()
    }

    pub fn update_template_activity(
        &mut self,
        id: &str,
        action: &str,
    ) -> StorageResult<Option<TemplateActivity>> {
        if id.trim().is_empty() || id.len() > 256 {
            return Err(StorageError::Validation(
                "Invalid template activity ID".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        match action {
            "favorite" => {
                transaction.execute(
                    "INSERT INTO template_activity(template_id, favorite) VALUES (?1, 1)
                     ON CONFLICT(template_id) DO UPDATE SET favorite = 1 - template_activity.favorite",
                    [id],
                )?;
            }
            "use" => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|error| StorageError::Validation(error.to_string()))?
                    .as_millis();
                let now = i64::try_from(now)
                    .map_err(|_| StorageError::Validation("Clock overflow".into()))?;
                transaction.execute(
                    "INSERT INTO template_activity(template_id, favorite, last_used_at) VALUES (?1, 0, ?2)
                     ON CONFLICT(template_id) DO UPDATE SET last_used_at = excluded.last_used_at",
                    params![id, now],
                )?;
            }
            "remove" => {
                transaction
                    .execute("DELETE FROM template_activity WHERE template_id = ?1", [id])?;
            }
            _ => {
                return Err(StorageError::Validation(
                    "Unknown template activity action".into(),
                ))
            }
        }
        let result = transaction.query_row(
            "SELECT template_id, favorite, last_used_at FROM template_activity WHERE template_id = ?1",
            [id],
            |row| Ok(TemplateActivity {
                template_id: row.get(0)?,
                favorite: row.get::<_, i64>(1)? == 1,
                last_used_at: row.get(2)?,
            }),
        ).optional()?;
        transaction.commit()?;
        Ok(result)
    }

    fn validate_agent_sessions(store: &StoredAgentSessionStore) -> StorageResult<()> {
        if store.sessions.is_empty() || store.sessions.len() > 100 {
            return Err(StorageError::Validation(
                "Agent session count is invalid".into(),
            ));
        }
        let mut session_ids = std::collections::HashSet::new();
        let mut message_ids = std::collections::HashSet::new();
        let mut message_count = 0;
        for session in &store.sessions {
            if session.id.is_empty()
                || session.id.len() > 128
                || !session_ids.insert(&session.id)
                || session.title.len() > 256
                || session.created_at <= 0
                || session.updated_at < session.created_at
                || session.messages.len() > 1000
            {
                return Err(StorageError::Validation("Agent session is invalid".into()));
            }
            message_count += session.messages.len();
            for message in &session.messages {
                if message.id.is_empty()
                    || message.id.len() > 128
                    || !message_ids.insert(&message.id)
                    || message.text.len() > 16_000
                    || !["user", "assistant", "system"].contains(&message.role.as_str())
                    || message
                        .source_view
                        .as_deref()
                        .is_some_and(|view| !["editor", "templates", "versions"].contains(&view))
                    || message
                        .source_refs
                        .as_ref()
                        .is_some_and(|refs| refs.len() > 8 || refs.iter().any(|id| id.len() > 256))
                {
                    return Err(StorageError::Validation("Agent message is invalid".into()));
                }
            }
        }
        if message_count > 5000 || !session_ids.contains(&store.active_id) {
            return Err(StorageError::Validation(
                "Agent session selection is invalid".into(),
            ));
        }
        Ok(())
    }

    fn persist_agent_sessions(
        transaction: &rusqlite::Transaction<'_>,
        account_id: &str,
        store: &StoredAgentSessionStore,
        revision: i64,
    ) -> StorageResult<()> {
        transaction.execute(
            "DELETE FROM agent_sessions WHERE account_id = ?1",
            [account_id],
        )?;
        for (ordinal, session) in store.sessions.iter().enumerate() {
            transaction.execute(
                "INSERT INTO agent_sessions(id, account_id, ordinal, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![session.id, account_id, ordinal as i64, session.title, session.created_at, session.updated_at],
            )?;
            for (ordinal, message) in session.messages.iter().enumerate() {
                let refs = message
                    .source_refs
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?;
                transaction.execute(
                    "INSERT INTO agent_messages(id, session_id, ordinal, role, text, source_view, source_refs_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![message.id, session.id, ordinal as i64, message.role, message.text, message.source_view, refs],
                )?;
            }
        }
        transaction.execute(
            "INSERT INTO agent_session_meta(account_id, active_session_id, revision) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET active_session_id = excluded.active_session_id, revision = excluded.revision",
            params![account_id, store.active_id, revision],
        )?;
        Ok(())
    }

    fn read_agent_sessions_tx(
        transaction: &rusqlite::Transaction<'_>,
        account_id: &str,
    ) -> StorageResult<Option<AgentSessionState>> {
        let meta: Option<(String, i64)> = transaction
            .query_row(
                "SELECT active_session_id, revision FROM agent_session_meta WHERE account_id = ?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((active_id, revision)) = meta else {
            return Ok(None);
        };
        let mut statement = transaction.prepare(
            "SELECT id, title, created_at, updated_at FROM agent_sessions WHERE account_id = ?1 ORDER BY ordinal",
        )?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut sessions = Vec::with_capacity(rows.len());
        for (id, title, created_at, updated_at) in rows {
            let mut messages_statement = transaction.prepare(
                "SELECT id, role, text, source_view, source_refs_json FROM agent_messages WHERE session_id = ?1 ORDER BY ordinal",
            )?;
            let messages = messages_statement
                .query_map([&id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|(id, role, text, source_view, refs)| {
                    Ok(StoredAgentMessage {
                        id,
                        role,
                        text,
                        source_view,
                        source_refs: refs.map(|value| serde_json::from_str(&value)).transpose()?,
                    })
                })
                .collect::<StorageResult<Vec<_>>>()?;
            sessions.push(StoredAgentSession {
                id,
                title,
                created_at,
                updated_at,
                messages,
            });
        }
        let store = StoredAgentSessionStore {
            active_id,
            sessions,
        };
        Self::validate_agent_sessions(&store)?;
        Ok(Some(AgentSessionState { revision, store }))
    }

    pub fn bootstrap_agent_sessions(
        &mut self,
        account_id: &str,
        legacy_json: &str,
    ) -> StorageResult<AgentSessionState> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(state) = Self::read_agent_sessions_tx(&transaction, account_id)? {
            transaction.commit()?;
            return Ok(state);
        }
        let store: StoredAgentSessionStore = serde_json::from_str(legacy_json)?;
        Self::validate_agent_sessions(&store)?;
        Self::persist_agent_sessions(&transaction, account_id, &store, 1)?;
        transaction.commit()?;
        Ok(AgentSessionState { revision: 1, store })
    }

    pub fn replace_agent_sessions(
        &mut self,
        account_id: &str,
        expected_revision: i64,
        payload_json: &str,
    ) -> StorageResult<i64> {
        let store: StoredAgentSessionStore = serde_json::from_str(payload_json)?;
        Self::validate_agent_sessions(&store)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM agent_session_meta WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )
            .optional()?;
        if actual != Some(expected_revision) {
            return Err(StorageError::Conflict(
                "Agent sessions changed in another window".into(),
            ));
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Agent session revision overflow".into()))?;
        Self::persist_agent_sessions(&transaction, account_id, &store, revision)?;
        transaction.commit()?;
        Ok(revision)
    }

    pub fn load_agent_session(
        &mut self,
        account_id: &str,
        session_id: &str,
    ) -> StorageResult<Option<StoredAgentSession>> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let state = Self::read_agent_sessions_tx(&transaction, account_id)?;
        transaction.commit()?;
        Ok(state.and_then(|state| {
            state
                .store
                .sessions
                .into_iter()
                .find(|session| session.id == session_id)
        }))
    }

    pub fn begin_agent_run(
        &mut self,
        account_id: &str,
        run_id: &str,
        session_id: &str,
        target: &AuthorityCursor,
        reference_ids: &[String],
    ) -> StorageResult<()> {
        self.begin_agent_run_with_epoch(account_id, run_id, session_id, target, reference_ids, 1)
    }

    pub fn begin_agent_run_with_epoch(
        &mut self,
        account_id: &str,
        run_id: &str,
        session_id: &str,
        target: &AuthorityCursor,
        reference_ids: &[String],
        epoch: u64,
    ) -> StorageResult<()> {
        if run_id.len() < 8
            || run_id.len() > 80
            || session_id.is_empty()
            || session_id.len() > 160
            || reference_ids.len() > 8
            || epoch == 0
            || epoch > i64::MAX as u64
        {
            return Err(StorageError::Validation("Invalid agent run target".into()));
        }
        let refs_json = serde_json::to_string(reference_ids)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = transaction.execute(
            "INSERT INTO agent_runs(id, account_id, session_id, document_id, context_id, revision,
                    branch_id, head_id, reference_ids_json, status, started_at)
             SELECT ?1, ?2, ?3, d.id, d.active_context_id, CAST(d.revision AS TEXT),
                    d.current_branch_id, b.head_commit_id, ?9, 'running',
                    CAST(strftime('%s','now') AS INTEGER) * 1000
             FROM documents d JOIN branches b ON b.id = d.current_branch_id AND b.document_id = d.id
             WHERE d.id = ?4 AND d.active_context_id = ?5 AND CAST(d.revision AS TEXT) = ?6
               AND d.current_branch_id = ?7 AND b.head_commit_id IS ?8",
            params![
                run_id,
                account_id,
                session_id,
                target.document_id,
                target.context_id,
                target.revision,
                target.branch_id,
                target.head_id,
                refs_json
            ],
        )?;
        if inserted != 1 {
            return Err(StorageError::Conflict(
                "Agent target changed before run start".into(),
            ));
        }
        transaction.execute(
            "INSERT INTO agent_run_lifecycle(run_id, state, epoch, deadline_at, updated_at)
             VALUES (?1, 'preparing', ?2,
               CAST(strftime('%s','now') AS INTEGER) * 1000 + 90000,
               CAST(strftime('%s','now') AS INTEGER) * 1000)",
            params![run_id, epoch as i64],
        )?;
        transaction.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_agent_run_state(
        &mut self,
        account_id: &str,
        run_id: &str,
        epoch: u64,
        state: &str,
        seq: u64,
        model_calls: u8,
        tool_calls: u8,
        interrupted_reason: Option<&str>,
    ) -> StorageResult<()> {
        if !matches!(
            state,
            "preparing"
                | "running"
                | "awaiting_confirmation"
                | "applying"
                | "completed"
                | "failed"
                | "cancelled"
        ) || epoch == 0
            || epoch > i64::MAX as u64
            || seq > i64::MAX as u64
        {
            return Err(StorageError::Validation(
                "Invalid agent lifecycle update".into(),
            ));
        }
        let changed = self.connection.execute(
            "UPDATE agent_run_lifecycle
             SET state = ?4, last_seq = ?5, model_calls = ?6, tool_calls = ?7,
                 interrupted_reason = ?8,
                 awaiting_confirmation_since = CASE
                   WHEN ?4 = 'awaiting_confirmation' AND state <> 'awaiting_confirmation'
                     THEN CAST(strftime('%s','now') AS INTEGER) * 1000
                   WHEN ?4 <> 'awaiting_confirmation' AND state = 'awaiting_confirmation'
                     THEN NULL
                   ELSE awaiting_confirmation_since END,
                 confirmation_wait_ms = CASE
                   WHEN state = 'awaiting_confirmation' AND ?4 <> 'awaiting_confirmation'
                     THEN confirmation_wait_ms + MAX(0,
                       CAST(strftime('%s','now') AS INTEGER) * 1000 - awaiting_confirmation_since)
                   ELSE confirmation_wait_ms END,
                 updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE run_id = ?2 AND epoch = ?3
               AND EXISTS(SELECT 1 FROM agent_runs WHERE id = ?2 AND account_id = ?1)",
            params![
                account_id,
                run_id,
                epoch as i64,
                state,
                seq as i64,
                model_calls as i64,
                tool_calls as i64,
                interrupted_reason
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "Agent lifecycle epoch or owner changed".into(),
            ));
        }
        Ok(())
    }

    pub fn persist_agent_run_delta(
        &mut self,
        account_id: &str,
        run_id: &str,
        epoch: u64,
        seq: u64,
        delta: &str,
    ) -> StorageResult<()> {
        if delta.is_empty() || epoch == 0 || seq == 0 {
            return Err(StorageError::Validation(
                "Invalid agent stream delta".into(),
            ));
        }
        let changed = self.connection.execute(
            "UPDATE agent_run_lifecycle
             SET state = 'running', last_seq = ?4, partial_text = partial_text || ?5,
                 updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE run_id = ?2 AND epoch = ?3 AND state = 'running'
               AND last_seq < ?4 AND length(partial_text || ?5) <= 2097152
               AND EXISTS(SELECT 1 FROM agent_runs WHERE id = ?2 AND account_id = ?1 AND status = 'running')",
            params![account_id, run_id, epoch as i64, seq as i64, delta],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "Agent stream delta exceeded limits or arrived late".into(),
            ));
        }
        Ok(())
    }

    pub fn recover_interrupted_agent_runs(&mut self) -> StorageResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = "CAST(strftime('%s','now') AS INTEGER) * 1000";
        transaction.execute(
            &format!(
                "UPDATE agent_run_lifecycle SET state = 'failed', interrupted_reason = 'interrupted by process restart', updated_at = {now}
                 WHERE state IN ('preparing','running','awaiting_confirmation','applying')
                   AND EXISTS(SELECT 1 FROM agent_runs r
                     WHERE r.id = agent_run_lifecycle.run_id AND r.status = 'running')"
            ),
            [],
        )?;
        transaction.execute(
            &format!(
                "UPDATE agent_runs SET status = 'failed', finished_at = {now} WHERE status = 'running'"
            ),
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn finish_agent_run(
        &mut self,
        account_id: &str,
        run_id: &str,
        status: &str,
    ) -> StorageResult<()> {
        if !matches!(status, "completed" | "cancelled" | "failed") {
            return Err(StorageError::Validation("Invalid agent run status".into()));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE agent_runs SET status = ?3, finished_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE account_id = ?1 AND id = ?2 AND status = 'running'",
            params![account_id, run_id, status],
        )?;
        if changed == 0 {
            let current: Option<String> = transaction
                .query_row(
                    "SELECT status FROM agent_runs WHERE account_id = ?1 AND id = ?2",
                    params![account_id, run_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current.as_deref() != Some(status) {
                return Err(StorageError::Conflict(
                    "Agent run is missing or already settled".into(),
                ));
            }
        }
        let lifecycle_state = match status {
            "completed" => "completed",
            "cancelled" => "cancelled",
            _ => "failed",
        };
        transaction.execute(
            "UPDATE agent_run_lifecycle SET
                 state = ?3,
                 interrupted_reason = CASE WHEN ?3 = 'failed' THEN COALESCE(interrupted_reason, 'Agent run failed') ELSE interrupted_reason END,
                 updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE run_id = ?2 AND EXISTS(
               SELECT 1 FROM agent_runs WHERE account_id = ?1 AND id = ?2
             )",
            params![account_id, run_id, lifecycle_state],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_agent_runs(&self, account_id: &str) -> StorageResult<Vec<AgentRunRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT r.id, r.session_id, r.document_id, r.context_id, r.revision, r.branch_id, r.head_id,
                    r.reference_ids_json, r.status, r.started_at, r.finished_at,
                    COALESCE(l.state, r.status), COALESCE(l.epoch, 1), COALESCE(l.last_seq, 0),
                    COALESCE(l.model_calls, 0), COALESCE(l.tool_calls, 0), COALESCE(l.partial_text, ''),
                    l.interrupted_reason
             FROM agent_runs r LEFT JOIN agent_run_lifecycle l ON l.run_id = r.id
             WHERE r.account_id = ?1 ORDER BY r.started_at DESC, r.id DESC LIMIT 100",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, i64>(14)?,
                row.get::<_, i64>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, Option<String>>(17)?,
            ))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (
                id,
                session_id,
                document_id,
                context_id,
                revision,
                branch_id,
                head_id,
                reference_ids_json,
                status,
                started_at,
                finished_at,
                lifecycle_state,
                epoch,
                last_seq,
                model_calls,
                tool_calls,
                partial_text,
                interrupted_reason,
            ) = row?;
            runs.push(AgentRunRecord {
                id,
                session_id,
                target: AuthorityCursor {
                    document_id,
                    context_id,
                    revision,
                    branch_id,
                    head_id,
                },
                reference_ids: serde_json::from_str(&reference_ids_json)?,
                status,
                lifecycle_state,
                epoch,
                last_seq,
                model_calls,
                tool_calls,
                partial_text,
                interrupted_reason,
                started_at,
                finished_at,
            });
        }
        Ok(runs)
    }

    /// 工作区偏好写入；value 为 None 表示删除该键。
    pub fn write_setting(&self, key: &str, value: Option<&str>) -> StorageResult<()> {
        match value {
            Some(value) => {
                self.connection.execute(
                    "INSERT INTO settings(key, value, updated_at)
                     VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = excluded.updated_at",
                    params![key, value],
                )?;
            }
            None => {
                self.connection
                    .execute("DELETE FROM settings WHERE key = ?1", [key])?;
            }
        }
        Ok(())
    }

    /// 头像资源与文档的持有关系：换头像先解除旧引用再建立新引用，GC 依据该引用保留。
    pub fn set_document_avatar(&self, document_id: &str, hash: Option<&str>) -> StorageResult<()> {
        let mut statement = self.connection.prepare(
            "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
        )?;
        statement.execute([document_id])?;
        if let Some(hash) = hash {
            self.link_resource(hash, "document-avatar", document_id)?;
        }
        Ok(())
    }

    /// 用外部备份整库替换当前文档的版本图（F28 旧语义）：
    /// 快照按内容 hash 去重复用；默认保留当前 durable draft。
    pub fn replace_version_store(
        &mut self,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor = Self::replace_version_store_tx(
            &transaction,
            expected,
            current_branch_id,
            branches,
            commits,
            None,
        )?;
        transaction.commit()?;
        Ok(cursor)
    }

    /// Replace a version graph and optionally apply an explicitly reviewed draft in one
    /// SQLite transaction. `None` preserves the current durable draft.
    pub fn replace_version_store_with_draft(
        &mut self,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
        imported_draft: Option<&ResumeDocument>,
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor = Self::replace_version_store_tx(
            &transaction,
            expected,
            current_branch_id,
            branches,
            commits,
            imported_draft,
        )?;
        transaction.commit()?;
        Ok(cursor)
    }

    pub fn inspect_legacy_identity_conflicts(
        &self,
        request: &migration::InspectLegacyIdentityConflictsRequest,
    ) -> StorageResult<Vec<migration::LegacyMigrationIdentityConflict>> {
        if request.target_document_id.trim().is_empty()
            || request.source_namespace.trim().is_empty()
            || request.source_namespace.len() > 160
        {
            return Err(StorageError::Validation(
                "Invalid legacy identity inspection request".into(),
            ));
        }
        validate_legacy_version_graph(&request.version_graph)?;
        let target_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
            params![request.target_document_id],
            |row| row.get(0),
        )?;
        if !target_exists {
            return Err(StorageError::NotFound(
                "Migration target document is missing".into(),
            ));
        }
        let mut conflicts = HashMap::<String, migration::LegacyMigrationIdentityConflict>::new();
        for branch in &request.version_graph.branches {
            let head_hash = branch
                .head_commit_id
                .as_deref()
                .and_then(|head| {
                    request
                        .version_graph
                        .commits
                        .iter()
                        .find(|commit| commit.id == head)
                })
                .map(migration_content_hash)
                .transpose()?;
            let content_hash = migration_content_hash(&(branch, head_hash))?;
            Self::collect_legacy_identity_conflict(
                &self.connection,
                &request.source_namespace,
                &request.target_document_id,
                "branch",
                &branch.id,
                &content_hash,
                &mut conflicts,
            )?;
        }
        for commit in &request.version_graph.commits {
            let content_hash = migration_content_hash(commit)?;
            Self::collect_legacy_identity_conflict(
                &self.connection,
                &request.source_namespace,
                &request.target_document_id,
                "commit",
                &commit.id,
                &content_hash,
                &mut conflicts,
            )?;
        }
        let mut result = conflicts.into_values().collect::<Vec<_>>();
        result.sort_by(|left, right| {
            left.entity_kind
                .cmp(&right.entity_kind)
                .then_with(|| left.legacy_id.cmp(&right.legacy_id))
        });
        Ok(result)
    }

    fn collect_legacy_identity_conflict(
        connection: &Connection,
        namespace: &str,
        document_id: &str,
        entity_kind: &str,
        legacy_id: &str,
        content_hash: &str,
        conflicts: &mut HashMap<String, migration::LegacyMigrationIdentityConflict>,
    ) -> StorageResult<()> {
        let (variant_count, differing_count): (i64, i64) = connection.query_row(
            "SELECT COUNT(*), COUNT(CASE WHEN content_hash <> ?5 THEN 1 END)
             FROM legacy_entity_identity
             WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3 AND legacy_id = ?4",
            params![namespace, document_id, entity_kind, legacy_id, content_hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if differing_count > 0 {
            let conflict_key = migration::identity_conflict_key(namespace, entity_kind, legacy_id);
            conflicts.insert(
                conflict_key.clone(),
                migration::LegacyMigrationIdentityConflict {
                    conflict_key,
                    entity_kind: entity_kind.into(),
                    legacy_id: legacy_id.into(),
                    existing_variant_count: variant_count.min(u32::MAX as i64) as u32,
                },
            );
        }
        Ok(())
    }

    /// Append a reviewed legacy version graph and optionally apply its draft in one
    /// IMMEDIATE transaction. Existing native history is retained; migration receipts
    /// make retries safe after a lost IPC response.
    pub fn commit_legacy_migration(
        &mut self,
        actor: &str,
        request: &CommitLegacyMigrationRequest,
    ) -> StorageResult<LegacyMigrationCommitReceipt> {
        if actor.trim().is_empty()
            || request.command_id.trim().is_empty()
            || request.command_id.len() > 160
            || (!request
                .version_graph
                .as_ref()
                .is_some_and(|graph| !graph.branches.is_empty() || !graph.commits.is_empty())
                && request.current_draft.is_none())
        {
            return Err(StorageError::Validation(
                "Invalid legacy migration commit request".into(),
            ));
        }
        if !request.confirmed {
            return Err(StorageError::Permission(
                "Legacy migration requires explicit user confirmation".into(),
            ));
        }

        let report = migration::inspect(&request.inspection);
        if !report.ready_for_dry_run
            || !migration::expected_source_hashes_match(&report, &request.expected_source_hashes)
        {
            return Err(StorageError::Conflict(
                "Legacy migration sources changed or contain blocking errors".into(),
            ));
        }
        let batch_key = migration::source_batch_key(&report)
            .ok_or_else(|| StorageError::Validation("A source namespace is required".into()))?;
        let required_reviews = migration::required_review_item_keys(&report);
        let acknowledged: HashSet<&str> = request
            .acknowledged_review_items
            .iter()
            .map(String::as_str)
            .collect();
        if required_reviews
            .iter()
            .any(|key| !acknowledged.contains(key.as_str()))
        {
            return Err(StorageError::Permission(
                "Migration review items have not all been acknowledged".into(),
            ));
        }
        let mut seen_preference_keys = HashSet::new();
        for preference in &request.preferences {
            let key = preference.key.as_str();
            let valid_key = !key.is_empty()
                && key.len() <= 160
                && key.chars().next().is_some_and(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit()
                })
                && key.chars().all(|character| {
                    character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || matches!(character, '.' | '_' | '-')
                });
            if !valid_key
                || preference.value.len() > 16_384
                || !seen_preference_keys.insert(key.to_string())
            {
                return Err(StorageError::Validation(
                    "Migrated preferences contain an invalid, oversized, or duplicate key".into(),
                ));
            }
        }
        if let Some(templates) = request.templates.as_ref() {
            let catalog_count =
                serde_json::from_str::<Vec<serde_json::Value>>(&templates.catalog_json)
                    .map(|catalog| catalog.len())
                    .unwrap_or(usize::MAX);
            let parsed_revision = templates.expected_revision.parse::<i64>();
            if templates.catalog_json.len() > 4 * 1024 * 1024
                || catalog_count > 64
                || parsed_revision.is_err()
                || parsed_revision.as_ref().is_ok_and(|revision| *revision < 0)
            {
                return Err(StorageError::Validation(
                    "Migrated template catalog is invalid or oversized".into(),
                ));
            }
        }

        let namespace = report
            .source_namespace
            .as_deref()
            .ok_or_else(|| StorageError::Validation("A source namespace is required".into()))?;
        if request
            .accepted_identity_updates
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != request.accepted_identity_updates.len()
        {
            return Err(StorageError::Validation(
                "Accepted migration identity updates contain duplicates".into(),
            ));
        }
        let accepted_updates: HashSet<String> =
            request.accepted_identity_updates.iter().cloned().collect();
        let mut request_fingerprint = request.clone();
        request_fingerprint.command_id.clear();
        let mut request_value = serde_json::to_value(&request_fingerprint)?;
        if let Some(object) = request_value.as_object_mut() {
            object.remove("cursor");
        }
        let request_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&request_value)?));

        if let Some(graph) = request.version_graph.as_ref() {
            let source = report
                .sources
                .iter()
                .find(|source| source.source_id == graph.source_id)
                .ok_or_else(|| {
                    StorageError::Validation("Version source was not inspected".into())
                })?;
            if source.counts.version_branches as usize != graph.branches.len()
                || source.counts.version_commits as usize != graph.commits.len()
                || graph.branches.len() > 10_000
                || graph.commits.len() > 100_000
            {
                return Err(StorageError::Validation(
                    "Converted version graph does not match its inspected inventory".into(),
                ));
            }
            validate_legacy_version_graph(graph)?;
        }
        if let Some(draft) = request.current_draft.as_ref() {
            if draft.document_id != request.cursor.document_id {
                return Err(StorageError::Validation(
                    "Imported draft must target the selected document".into(),
                ));
            }
            zinecv_domain::DocumentContext::new(draft.clone()).map_err(StorageError::Domain)?;
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        let prior_command: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT batch_key, actor, request_hash FROM legacy_migration_commands
                 WHERE command_id = ?1",
                params![request.command_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((prior_key, prior_actor, prior_hash)) = prior_command.as_ref() {
            if prior_key != &batch_key || prior_actor != actor || prior_hash != &request_hash {
                return Err(StorageError::Conflict(
                    "Migration command ID has already been used".into(),
                ));
            }
        }
        let prior_batch: Option<(String, String, String, String)> = transaction
            .query_row(
                "SELECT command_id, actor, request_hash, receipt_json
                 FROM legacy_migration_batches WHERE batch_key = ?1",
                params![batch_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        if let Some((_command_id, prior_actor, prior_hash, receipt_json)) = prior_batch {
            if prior_actor != actor || prior_hash != request_hash {
                return Err(StorageError::Conflict(
                    "This migration batch was already committed with different reviewed data"
                        .into(),
                ));
            }
            let mut receipt: LegacyMigrationCommitReceipt = serde_json::from_str(&receipt_json)?;
            if prior_command.is_none() {
                transaction.execute(
                    "INSERT INTO legacy_migration_commands(command_id, batch_key, actor, request_hash)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![request.command_id, batch_key, actor, request_hash],
                )?;
            }
            receipt.idempotent_replay = true;
            transaction.commit()?;
            return Ok(receipt);
        }

        let (document_id, context_id, current_branch_id, revision): (String, String, String, i64) =
            transaction
                .query_row(
                    "SELECT id, active_context_id, current_branch_id, revision
                     FROM documents WHERE id = ?1",
                    params![request.cursor.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    StorageError::NotFound("Migration target document is missing".into())
                })?;
        let current_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![current_branch_id, document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Migration target branch is missing".into()))?;
        if context_id != request.cursor.context_id
            || current_branch_id != request.cursor.branch_id
            || revision.to_string() != request.cursor.revision
            || current_head != request.cursor.head_id
        {
            return Err(StorageError::Conflict(
                "Migration target cursor is stale".into(),
            ));
        }
        let (draft_revision, durable_draft_json, durable_draft_hash): (i64, String, String) =
            transaction
                .query_row(
                    "SELECT revision, document_json, hash FROM drafts
                     WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![document_id, context_id, current_branch_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Migration target draft is missing".into()))?;
        let durable_draft: ResumeDocument = serde_json::from_str(&durable_draft_json)?;
        zinecv_domain::DocumentContext::new(durable_draft.clone()).map_err(StorageError::Domain)?;
        if draft_revision != revision
            || durable_draft.document_id != document_id
            || canonical_hash(&durable_draft)? != durable_draft_hash
        {
            return Err(StorageError::Conflict(
                "Migration target draft does not match durable authority".into(),
            ));
        }

        let mut created_mapping_count = 0_u32;
        let mut created_branch_count = 0_u32;
        let mut created_commit_count = 0_u32;
        let mut migrated_avatar_count = 0_u32;
        let mut identity_context = LegacyIdentityContext {
            namespace,
            document_id: &document_id,
            accepted_updates: &accepted_updates,
            used_updates: HashSet::new(),
        };
        if let Some(graph) = request.version_graph.as_ref() {
            let mut branch_ids = HashMap::new();
            let mut branch_records = HashMap::new();
            let mut new_branch_ids = HashSet::new();
            let mut existing_names = {
                let mut statement =
                    transaction.prepare("SELECT name FROM branches WHERE document_id = ?1")?;
                let names = statement
                    .query_map(params![document_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(|name| name.to_lowercase())
                    .collect::<HashSet<_>>();
                names
            };
            let mut missing_origins = graph
                .commits
                .iter()
                .filter(|commit| {
                    !graph
                        .branches
                        .iter()
                        .any(|branch| branch.id == commit.branch_id)
                })
                .map(|commit| commit.branch_id.clone())
                .collect::<Vec<_>>();
            missing_origins.sort_unstable();
            missing_origins.dedup();

            for branch in &graph.branches {
                let head_content_hash = branch
                    .head_commit_id
                    .as_deref()
                    .and_then(|head| graph.commits.iter().find(|commit| commit.id == head))
                    .map(migration_content_hash)
                    .transpose()?;
                let content_hash = migration_content_hash(&(branch, head_content_hash))?;
                let (native_id, is_new_mapping) = Self::resolve_legacy_identity(
                    &transaction,
                    &mut identity_context,
                    "branch",
                    &branch.id,
                    &content_hash,
                )?;
                if is_new_mapping {
                    created_mapping_count = created_mapping_count.saturating_add(1);
                }
                branch_ids.insert(branch.id.clone(), native_id.clone());
                branch_records.insert(branch.id.clone(), (branch.clone(), content_hash, native_id));
            }
            for legacy_id in missing_origins {
                let content_hash = migration_deleted_branch_hash(&legacy_id);
                let (native_id, is_new_mapping) = Self::resolve_legacy_identity(
                    &transaction,
                    &mut identity_context,
                    "branch",
                    &legacy_id,
                    &content_hash,
                )?;
                if is_new_mapping {
                    created_mapping_count = created_mapping_count.saturating_add(1);
                    let name = format!("__deleted__:{native_id}");
                    transaction.execute(
                        "INSERT INTO branches(id, document_id, name, head_commit_id, created_at)
                         VALUES (?1, ?2, ?3, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                        params![native_id, document_id, name],
                    )?;
                    transaction.execute(
                        "INSERT INTO branch_tombstones(branch_id) VALUES (?1)",
                        params![native_id],
                    )?;
                    created_branch_count = created_branch_count.saturating_add(1);
                    new_branch_ids.insert(native_id.clone());
                }
                branch_ids.insert(legacy_id, native_id);
            }

            let mut commit_ids = HashMap::new();
            let mut commit_is_new = HashMap::new();
            for commit in &graph.commits {
                let content_hash = migration_content_hash(commit)?;
                let (native_id, is_new_mapping) = Self::resolve_legacy_identity(
                    &transaction,
                    &mut identity_context,
                    "commit",
                    &commit.id,
                    &content_hash,
                )?;
                if is_new_mapping {
                    created_mapping_count = created_mapping_count.saturating_add(1);
                }
                commit_ids.insert(commit.id.clone(), native_id.clone());
                commit_is_new.insert(commit.id.clone(), is_new_mapping);
            }
            for (legacy_id, (branch, _content_hash, native_id)) in &branch_records {
                let exists: Option<(String, Option<String>)> = transaction
                    .query_row(
                        "SELECT document_id, head_commit_id FROM branches WHERE id = ?1",
                        params![native_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((existing_document, _)) = exists {
                    if existing_document != document_id {
                        return Err(StorageError::Conflict(
                            "Mapped legacy branch belongs to another document".into(),
                        ));
                    }
                } else {
                    let requested_name = branch.name.trim();
                    if requested_name.is_empty()
                        || requested_name.len() > 512
                        || requested_name.chars().any(char::is_control)
                    {
                        return Err(StorageError::Validation(
                            "Imported branch has an invalid name".into(),
                        ));
                    }
                    let name =
                        unique_legacy_branch_name(requested_name, native_id, &existing_names);
                    existing_names.insert(name.to_lowercase());
                    transaction.execute(
                        "INSERT INTO branches(id, document_id, name, head_commit_id, created_at)
                         VALUES (?1, ?2, ?3, NULL, ?4)",
                        params![native_id, document_id, name, branch.created_at],
                    )?;
                    created_branch_count = created_branch_count.saturating_add(1);
                    new_branch_ids.insert(native_id.clone());
                }
                if !branch_ids.contains_key(legacy_id) {
                    return Err(StorageError::Corrupt(
                        "Legacy branch identity is missing".into(),
                    ));
                }
            }

            for commit in &graph.commits {
                let native_id = commit_ids.get(&commit.id).ok_or_else(|| {
                    StorageError::Corrupt("Legacy commit identity is missing".into())
                })?;
                let exists: Option<String> = transaction
                    .query_row(
                        "SELECT document_id FROM commits WHERE id = ?1",
                        params![native_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(existing_document) = exists {
                    if existing_document != document_id {
                        return Err(StorageError::Conflict(
                            "Mapped legacy commit belongs to another document".into(),
                        ));
                    }
                    commit_is_new.insert(commit.id.clone(), false);
                    continue;
                }
                let origin_branch = branch_ids.get(&commit.branch_id).ok_or_else(|| {
                    StorageError::Validation("Commit branch is unresolved".into())
                })?;
                let mut snapshot = commit.snapshot.clone();
                snapshot.document_id = document_id.clone();
                if resources::normalize_legacy_avatar(&transaction, &mut snapshot)? {
                    migrated_avatar_count = migrated_avatar_count.saturating_add(1);
                }
                zinecv_domain::DocumentContext::new(snapshot.clone())
                    .map_err(StorageError::Domain)?;
                let snapshot_json = serde_json::to_string(&snapshot)?;
                let snapshot_hash = canonical_hash(&snapshot)?;
                let snapshot_id = format!("snap-{snapshot_hash}");
                transaction.execute(
                    "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
                     VALUES (?1, 2, 1, ?2, ?3)",
                    params![snapshot_id, snapshot_json, snapshot_hash],
                )?;
                Self::sync_snapshot_resource_owner(&transaction, &snapshot_id, &snapshot_json)?;
                transaction.execute(
                    "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![native_id, document_id, origin_branch, snapshot_id, commit.message, commit.created_at],
                )?;
                created_commit_count = created_commit_count.saturating_add(1);
                commit_is_new.insert(commit.id.clone(), true);
            }

            for commit in &graph.commits {
                let native_id = commit_ids.get(&commit.id).ok_or_else(|| {
                    StorageError::Corrupt("Legacy commit identity is missing".into())
                })?;
                if !commit_is_new.get(&commit.id).copied().unwrap_or(false) {
                    continue;
                }
                let parent_id = match commit.parent_id.as_deref() {
                    Some(parent) => Some(
                        commit_ids
                            .get(parent)
                            .cloned()
                            .or(Self::lookup_legacy_identity(
                                &transaction,
                                namespace,
                                &document_id,
                                "commit",
                                parent,
                            )?)
                            .ok_or_else(|| {
                                StorageError::Validation(
                                    "A version parent is missing and has no prior identity mapping"
                                        .into(),
                                )
                            })?,
                    ),
                    None => None,
                };
                transaction.execute(
                    "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
                    params![native_id, parent_id],
                )?;
            }

            for (branch, _content_hash, native_id) in branch_records.values() {
                let head_id = match branch.head_commit_id.as_deref() {
                    Some(head) => Some(
                        commit_ids
                            .get(head)
                            .cloned()
                            .or(Self::lookup_legacy_identity(
                                &transaction,
                                namespace,
                                &document_id,
                                "commit",
                                head,
                            )?)
                            .ok_or_else(|| {
                                StorageError::Validation("A version branch head is missing".into())
                            })?,
                    ),
                    None => None,
                };
                let existing_head: Option<Option<String>> = transaction
                    .query_row(
                        "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                        params![native_id, document_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match existing_head {
                    Some(Some(actual)) if actual == head_id.clone().unwrap_or_default() => {}
                    Some(None) if head_id.is_none() => {}
                    Some(_) => {
                        if !new_branch_ids.contains(native_id) {
                            return Err(StorageError::Conflict(
                                "Mapped legacy branch head differs from its recorded identity"
                                    .into(),
                            ));
                        }
                        transaction.execute(
                            "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
                            params![head_id, native_id, document_id],
                        )?;
                    }
                    None => {
                        return Err(StorageError::Corrupt("Imported branch disappeared".into()))
                    }
                }
            }
            let unknown_accepted = accepted_updates
                .difference(&identity_context.used_updates)
                .next()
                .is_some();
            if unknown_accepted {
                return Err(StorageError::Validation(
                    "An accepted identity update does not match a detected conflict".into(),
                ));
            }
        } else if !accepted_updates.is_empty() {
            return Err(StorageError::Validation(
                "Identity updates were accepted without a version graph".into(),
            ));
        }

        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Document revision overflow".into()))?;
        let mut next_draft = request
            .current_draft
            .as_ref()
            .unwrap_or(&durable_draft)
            .clone();
        if request.current_draft.is_some()
            && resources::normalize_legacy_avatar(&transaction, &mut next_draft)?
        {
            migrated_avatar_count = migrated_avatar_count.saturating_add(1);
        }
        let next_draft_json = serde_json::to_string(&next_draft)?;
        let next_draft_hash = canonical_hash(&next_draft)?;
        transaction.execute(
            "UPDATE documents SET revision = ?1 WHERE id = ?2 AND revision = ?3",
            params![next_revision, document_id, revision],
        )?;
        transaction.execute(
            "UPDATE drafts SET revision = ?1, document_json = ?2, hash = ?3,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE document_id = ?4 AND context_id = ?5 AND branch_id = ?6",
            params![
                next_revision,
                next_draft_json,
                next_draft_hash,
                document_id,
                context_id,
                current_branch_id
            ],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &document_id,
            &context_id,
            &current_branch_id,
            &next_draft_json,
        )?;

        for preference in &request.preferences {
            transaction.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![preference.key, preference.value],
            )?;
        }
        let mut template_count = 0u32;
        if let Some(templates) = request.templates.as_ref() {
            let expected_revision = templates.expected_revision.parse::<i64>().map_err(|_| {
                StorageError::Validation("Migrated template catalog revision is invalid".into())
            })?;
            let current_revision: i64 = transaction
                .query_row(
                    "SELECT revision FROM imported_template_catalog WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if current_revision != expected_revision {
                return Err(StorageError::Conflict(
                    "Template catalog changed in another window".into(),
                ));
            }
            let normalized =
                resources::normalize_catalog_for_storage(&transaction, &templates.catalog_json)?;
            let next_revision = expected_revision.checked_add(1).ok_or_else(|| {
                StorageError::Validation("Template catalog revision overflow".into())
            })?;
            transaction.execute(
                "INSERT INTO imported_template_catalog(id, payload_json, revision, updated_at)
                 VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(id) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   revision = excluded.revision,
                   updated_at = excluded.updated_at",
                params![normalized, next_revision],
            )?;
            template_count =
                serde_json::from_str::<Vec<serde_json::Value>>(&templates.catalog_json)
                    .map(|catalog| catalog.len() as u32)
                    .unwrap_or(0);
        }

        let identity_counts = legacy_identity::commit(
            &transaction,
            namespace,
            &request.inspection.sources,
            &request.cursor,
        )?;
        let mut remaining_categories = vec![
            "templates".to_string(),
            "preferences".to_string(),
            "accounts".to_string(),
            "provider-secrets".to_string(),
            "agent-sessions".to_string(),
            "assets".to_string(),
        ];
        if !request.preferences.is_empty() {
            remaining_categories.retain(|category| category != "preferences");
        }
        if request.templates.is_some() {
            remaining_categories.retain(|category| category != "templates");
        }
        // A template-resource migration still has its own inventory gate. Only
        // close the asset category here when no template assets are involved and
        // every inventoried embedded avatar was actually transferred.
        if report.totals.avatar_assets_missing == 0
            && report.totals.template_assets_missing == 0
            && report.totals.template_assets_present == 0
            && migrated_avatar_count >= report.totals.avatar_assets_present
        {
            remaining_categories.retain(|category| category != "assets");
        }
        if identity_counts.accounts > 0 && report.totals.damaged_account_records == 0 {
            remaining_categories.retain(|category| category != "accounts");
        }
        if identity_counts.sessions > 0 {
            remaining_categories.retain(|category| category != "agent-sessions");
        }
        if report.totals.unknown_items > 0 {
            remaining_categories.push("unknown-items".to_string());
        }
        let receipt_cursor = AuthorityCursor {
            document_id: document_id.clone(),
            context_id: context_id.clone(),
            revision: next_revision.to_string(),
            branch_id: current_branch_id.clone(),
            head_id: current_head,
        };
        let receipt = LegacyMigrationCommitReceipt {
            batch_key: batch_key.clone(),
            namespace: namespace.into(),
            cursor: receipt_cursor,
            current_draft_applied: request.current_draft.is_some(),
            version_branch_count: created_branch_count,
            version_commit_count: created_commit_count,
            identity_mapping_count: created_mapping_count,
            preference_count: request.preferences.len() as u32,
            template_count,
            account_count: identity_counts.accounts,
            provider_count: identity_counts.providers,
            session_count: identity_counts.sessions,
            secret_reentry_count: identity_counts.secret_reentry,
            completion_status: "partial".into(),
            remaining_categories,
            idempotent_replay: false,
        };
        transaction.execute(
            "INSERT INTO legacy_migration_batches(batch_key, command_id, actor, request_hash, receipt_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![batch_key, request.command_id, actor, request_hash, serde_json::to_string(&receipt)?],
        )?;
        transaction.execute(
            "INSERT INTO legacy_migration_commands(command_id, batch_key, actor, request_hash)
             VALUES (?1, ?2, ?3, ?4)",
            params![request.command_id, batch_key, actor, request_hash],
        )?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("MIGRATION", "before-commit")?;
        transaction.commit()?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("MIGRATION", "after-commit")?;
        Ok(receipt)
    }

    fn resolve_legacy_identity(
        transaction: &rusqlite::Transaction<'_>,
        context: &mut LegacyIdentityContext<'_>,
        entity_kind: &str,
        legacy_id: &str,
        content_hash: &str,
    ) -> StorageResult<(String, bool)> {
        let existing: Option<String> = transaction
            .query_row(
                "SELECT native_id FROM legacy_entity_identity
                 WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3
                   AND legacy_id = ?4 AND content_hash = ?5",
                params![
                    context.namespace,
                    context.document_id,
                    entity_kind,
                    legacy_id,
                    content_hash
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(native_id) = existing {
            return Ok((native_id, false));
        }
        let has_other_content: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM legacy_entity_identity
             WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3 AND legacy_id = ?4)",
            params![context.namespace, context.document_id, entity_kind, legacy_id],
            |row| row.get(0),
        )?;
        let conflict_key =
            migration::identity_conflict_key(context.namespace, entity_kind, legacy_id);
        let base_id = migration::stable_native_id(context.namespace, entity_kind, legacy_id);
        let native_id = if has_other_content {
            if !context.accepted_updates.contains(&conflict_key) {
                return Err(StorageError::Conflict(
                    "A legacy identity changed content; explicit review is required".into(),
                ));
            }
            context.used_updates.insert(conflict_key);
            format!("{base_id}-{}", &content_hash[..12])
        } else {
            base_id
        };
        let occupied: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM legacy_entity_identity WHERE native_id = ?1)",
            params![native_id],
            |row| row.get(0),
        )?;
        if occupied {
            return Err(StorageError::Conflict(
                "Stable legacy identity is already mapped to a different entity".into(),
            ));
        }
        transaction.execute(
            "INSERT INTO legacy_entity_identity(namespace, target_document_id, entity_kind,
             legacy_id, content_hash, native_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                context.namespace,
                context.document_id,
                entity_kind,
                legacy_id,
                content_hash,
                native_id
            ],
        )?;
        Ok((native_id, true))
    }

    fn lookup_legacy_identity(
        transaction: &rusqlite::Transaction<'_>,
        namespace: &str,
        document_id: &str,
        entity_kind: &str,
        legacy_id: &str,
    ) -> StorageResult<Option<String>> {
        Ok(transaction
            .query_row(
                "SELECT native_id FROM legacy_entity_identity
                 WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3
                   AND legacy_id = ?4 ORDER BY created_at DESC LIMIT 1",
                params![namespace, document_id, entity_kind, legacy_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn replace_version_store_tx(
        transaction: &rusqlite::Transaction<'_>,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
        imported_draft: Option<&ResumeDocument>,
    ) -> StorageResult<AuthorityCursor> {
        let (document_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let (branch_id, _): (String, Option<String>) = transaction
            .query_row(
                "SELECT current_branch_id, b.head_commit_id FROM documents
                 LEFT JOIN branches b ON b.id = documents.current_branch_id AND b.document_id = documents.id
                 WHERE documents.id = ?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.revision != revision.to_string()
            || expected.context_id != context_id
        {
            return Err(StorageError::Conflict(
                "Version store replacement cursor is stale".into(),
            ));
        }
        let (draft_revision, durable_draft_json, durable_draft_hash): (i64, String, String) =
            transaction
                .query_row(
                    "SELECT revision, document_json, hash FROM drafts
                     WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![document_id, context_id, branch_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Current durable draft is missing".into()))?;
        let durable_draft: ResumeDocument = serde_json::from_str(&durable_draft_json)?;
        zinecv_domain::DocumentContext::new(durable_draft.clone()).map_err(StorageError::Domain)?;
        if draft_revision != revision
            || durable_draft.document_id != document_id
            || canonical_hash(&durable_draft)? != durable_draft_hash
        {
            return Err(StorageError::Conflict(
                "Current durable draft does not match document authority".into(),
            ));
        }
        let current_draft = match imported_draft {
            Some(imported) if imported.document_id != document_id => {
                return Err(StorageError::Validation(
                    "Imported draft must target the active document".into(),
                ));
            }
            Some(imported) => {
                zinecv_domain::DocumentContext::new(imported.clone())
                    .map_err(StorageError::Domain)?;
                imported.clone()
            }
            None => durable_draft,
        };
        let current_draft_json = serde_json::to_string(&current_draft)?;
        let current_draft_hash = canonical_hash(&current_draft)?;

        let prior_drafts = {
            let mut statement = transaction
                .prepare("SELECT context_id, branch_id FROM drafts WHERE document_id = ?1")?;
            let rows = statement
                .query_map(params![document_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (draft_context_id, draft_branch_id) in prior_drafts {
            Self::delete_draft_resource_owner(
                transaction,
                &document_id,
                &draft_context_id,
                &draft_branch_id,
            )?;
        }
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1",
            params![document_id],
        )?;

        // 1) 清空该文档的版本图；快照在全部分支删除后再统一回收。
        transaction.execute(
            "DELETE FROM commit_links WHERE commit_id IN (SELECT id FROM commits WHERE document_id = ?1)",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM branch_tombstones WHERE branch_id IN (SELECT id FROM branches WHERE document_id = ?1)",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM commits WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM branches WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'snapshot'
             AND owner_id NOT IN (SELECT id FROM snapshots)",
            [],
        )?;

        // 2) 主分支 id 固定为 main:{document_id}；其余沿用备份中的 id。
        let default_branch = default_branch_id(&document_id);
        for branch in branches {
            let id = if branch.id == "main" || branch.id == default_branch {
                default_branch.clone()
            } else {
                branch.id.clone()
            };
            transaction.execute(
                "INSERT INTO branches(id, document_id, name, head_commit_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    document_id,
                    branch.name,
                    branch.head_commit_id,
                    branch.created_at
                ],
            )?;
        }
        if !branches
            .iter()
            .any(|branch| branch.id == "main" || branch.id == default_branch)
        {
            return Err(StorageError::Validation(
                "Replacement store is missing the default branch".into(),
            ));
        }

        // 3) 提交：快照按 canonical hash 复用（与 commit_draft 同一 id/hash 约定）。
        for commit in commits {
            let snapshot_json = serde_json::to_string(&commit.snapshot)?;
            let hash = canonical_hash(&commit.snapshot)?;
            let snapshot_id = format!("snap-{hash}");
            transaction.execute(
                "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
                 VALUES (?1, 2, 1, ?2, ?3)",
                params![snapshot_id, snapshot_json, hash],
            )?;
            Self::sync_snapshot_resource_owner(transaction, &snapshot_id, &snapshot_json)?;
            transaction.execute(
                "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    commit.id,
                    document_id,
                    if commit.branch_id == "main" { &default_branch } else { &commit.branch_id },
                    snapshot_id,
                    commit.message,
                    commit.created_at
                ],
            )?;
            transaction.execute(
                "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
                params![commit.id, commit.parent_id],
            )?;
        }

        // 4) 切到替换后的当前分支（id 同样做 main 归一），保留当前工作内容为草稿。
        let target_branch = if current_branch_id == "main" {
            default_branch.clone()
        } else {
            current_branch_id.to_string()
        };
        let exists: Option<String> = transaction
            .query_row(
                "SELECT id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![target_branch, document_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(StorageError::Validation(
                "Replacement current branch is missing".into(),
            ));
        }
        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Document revision overflow".into()))?;
        transaction.execute(
            "UPDATE documents SET current_branch_id = ?2, revision = ?3 WHERE id = ?1 AND revision = ?4",
            params![document_id, target_branch, next_revision, revision],
        )?;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![document_id, context_id, target_branch],
        )?;
        Self::delete_draft_resource_owner(transaction, &document_id, &context_id, &target_branch)?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![
                document_id,
                context_id,
                target_branch,
                next_revision,
                &current_draft_json,
                current_draft_hash,
            ],
        )?;
        Self::sync_draft_resource_owner(
            transaction,
            &document_id,
            &context_id,
            &target_branch,
            &current_draft_json,
        )?;
        // 替换完成后回收未被任何提交引用的旧快照，避免历史泄漏。
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'snapshot'
             AND owner_id NOT IN (SELECT id FROM snapshots)",
            [],
        )?;
        let head_id: Option<String> = transaction.query_row(
            "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
            params![target_branch, document_id],
            |row| row.get(0),
        )?;
        Ok(AuthorityCursor {
            document_id,
            context_id,
            revision: next_revision.to_string(),
            branch_id: target_branch,
            head_id,
        })
    }

    pub fn snapshot_count(&self) -> StorageResult<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))?)
    }
}

struct LegacyIdentityContext<'a> {
    namespace: &'a str,
    document_id: &'a str,
    accepted_updates: &'a HashSet<String>,
    used_updates: HashSet<String>,
}

fn migration_content_hash<T: Serialize>(value: &T) -> StorageResult<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

fn migration_deleted_branch_hash(legacy_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("deleted-origin\0{legacy_id}").as_bytes())
    )
}

fn validate_legacy_version_graph(
    graph: &migration::LegacyMigrationVersionGraph,
) -> StorageResult<()> {
    if graph.source_id.trim().is_empty()
        || graph.source_id.len() > 80
        || graph.current_branch_id.trim().is_empty()
    {
        return Err(StorageError::Validation(
            "Invalid imported version graph identity".into(),
        ));
    }
    let mut branches = HashSet::new();
    for branch in &graph.branches {
        if branch.id.trim().is_empty()
            || branch.id.len() > 160
            || branch.id.chars().any(char::is_control)
            || branch.name.trim().is_empty()
            || branch.name.len() > 512
            || branch.name.chars().any(char::is_control)
            || branch.created_at.trim().is_empty()
            || branch.created_at.len() > 160
            || !branches.insert(branch.id.as_str())
        {
            return Err(StorageError::Validation(
                "Imported version graph has an invalid or duplicate branch".into(),
            ));
        }
    }
    if !branches.contains(graph.current_branch_id.as_str()) {
        return Err(StorageError::Validation(
            "Imported current branch is missing".into(),
        ));
    }
    let mut commits = HashMap::new();
    for commit in &graph.commits {
        if commit.id.trim().is_empty()
            || commit.id.len() > 160
            || commit.id.chars().any(char::is_control)
            || commit.branch_id.trim().is_empty()
            || commit.branch_id.len() > 160
            || commit.branch_id.chars().any(char::is_control)
            || commit.message.len() > 4096
            || commit.message.chars().any(char::is_control)
            || commit.created_at.trim().is_empty()
            || commit.created_at.len() > 160
            || commits.insert(commit.id.as_str(), commit).is_some()
        {
            return Err(StorageError::Validation(
                "Imported version graph has an invalid or duplicate commit".into(),
            ));
        }
        if commit.parent_id.as_deref() == Some(commit.id.as_str()) {
            return Err(StorageError::Validation(
                "Imported version commit cannot parent itself".into(),
            ));
        }
    }
    let mut indegree = commits
        .keys()
        .map(|commit_id| (*commit_id, 0_usize))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<&str, Vec<&str>>::new();
    for commit in &graph.commits {
        if let Some(parent) = commit.parent_id.as_deref() {
            if commits.contains_key(parent) {
                *indegree.get_mut(commit.id.as_str()).expect("commit index") += 1;
                children.entry(parent).or_default().push(commit.id.as_str());
            }
        }
    }
    let mut ready = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect::<Vec<_>>();
    let mut visited = 0_usize;
    while let Some(id) = ready.pop() {
        visited += 1;
        if let Some(next) = children.get(id) {
            for child in next {
                let count = indegree.get_mut(child).expect("child index");
                *count -= 1;
                if *count == 0 {
                    ready.push(child);
                }
            }
        }
    }
    if visited != commits.len() {
        return Err(StorageError::Validation(
            "Imported version graph contains a parent cycle".into(),
        ));
    }
    Ok(())
}

fn unique_legacy_branch_name(
    original: &str,
    native_id: &str,
    existing_lowercase_names: &HashSet<String>,
) -> String {
    let token = native_id.strip_prefix("legacy-").unwrap_or(native_id);
    let short_id = token.chars().take(8).collect::<String>();
    for suffix_number in 1..=1000 {
        let suffix = if suffix_number == 1 {
            format!(" (imported {short_id})")
        } else {
            format!(" (imported {short_id}-{suffix_number})")
        };
        let available_chars = 120_usize.saturating_sub(suffix.chars().count());
        let prefix = original.chars().take(available_chars).collect::<String>();
        let candidate = format!("{}{}", prefix.trim_end(), suffix);
        if !existing_lowercase_names.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    format!("imported-{short_id}")
}

const MAX_IMPORT_CANDIDATES: usize = 256;
const MAX_IMPORT_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMPORT_REVIEW_BYTES: usize = 2 * 1024 * 1024;

fn import_source_name(kind: ImportSourceKind) -> &'static str {
    match kind {
        ImportSourceKind::Pdf => "pdf",
        ImportSourceKind::Docx => "docx",
        ImportSourceKind::Image => "image",
        ImportSourceKind::LegacyJson => "legacy_json",
    }
}

fn parse_import_source(value: &str) -> StorageResult<ImportSourceKind> {
    match value {
        "pdf" => Ok(ImportSourceKind::Pdf),
        "docx" => Ok(ImportSourceKind::Docx),
        "image" => Ok(ImportSourceKind::Image),
        "legacy_json" => Ok(ImportSourceKind::LegacyJson),
        _ => Err(StorageError::Corrupt("Unknown import source kind".into())),
    }
}

fn import_status_name(status: ImportDraftStatus) -> &'static str {
    match status {
        ImportDraftStatus::Queued => "queued",
        ImportDraftStatus::Running => "running",
        ImportDraftStatus::ReviewRequired => "review_required",
        ImportDraftStatus::Committed => "committed",
        ImportDraftStatus::Failed => "failed",
        ImportDraftStatus::Cancelled => "cancelled",
    }
}

fn parse_import_status(value: &str) -> StorageResult<ImportDraftStatus> {
    match value {
        "queued" => Ok(ImportDraftStatus::Queued),
        "running" => Ok(ImportDraftStatus::Running),
        "review_required" => Ok(ImportDraftStatus::ReviewRequired),
        "committed" => Ok(ImportDraftStatus::Committed),
        "failed" => Ok(ImportDraftStatus::Failed),
        "cancelled" => Ok(ImportDraftStatus::Cancelled),
        _ => Err(StorageError::Corrupt("Unknown import draft status".into())),
    }
}

fn valid_import_transition(from: ImportDraftStatus, to: ImportDraftStatus) -> bool {
    matches!(
        (from, to),
        (ImportDraftStatus::Queued, ImportDraftStatus::Running)
            | (ImportDraftStatus::Queued, ImportDraftStatus::Failed)
            | (ImportDraftStatus::Queued, ImportDraftStatus::Cancelled)
            | (
                ImportDraftStatus::Running,
                ImportDraftStatus::ReviewRequired
            )
            | (ImportDraftStatus::Running, ImportDraftStatus::Failed)
            | (ImportDraftStatus::Running, ImportDraftStatus::Cancelled)
            | (ImportDraftStatus::ReviewRequired, ImportDraftStatus::Failed)
            | (
                ImportDraftStatus::ReviewRequired,
                ImportDraftStatus::Cancelled
            )
    )
}

fn validate_import_draft_header(id: &str, name: &str, source_hash: &str) -> StorageResult<()> {
    if id.trim().is_empty() || id.len() > 160 {
        return Err(StorageError::Validation("Invalid import draft ID".into()));
    }
    if name.trim().is_empty()
        || name.len() > 256
        || name.chars().any(|character| character.is_control())
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(StorageError::Validation(
            "Invalid import display name".into(),
        ));
    }
    if source_hash.len() != 64 || !source_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StorageError::Validation(
            "Invalid import source hash".into(),
        ));
    }
    Ok(())
}

fn validate_import_review_payload(
    candidates: &[ImportCandidate],
    warnings: &[String],
    unsupported: &[String],
) -> StorageResult<()> {
    if candidates.len() > MAX_IMPORT_CANDIDATES || warnings.len() > 64 || unsupported.len() > 64 {
        return Err(StorageError::Validation(
            "Import review payload exceeds item limits".into(),
        ));
    }
    let mut ids = BTreeSet::new();
    for candidate in candidates {
        if candidate.id.trim().is_empty()
            || candidate.id.len() > 160
            || candidate.label.trim().is_empty()
            || candidate.label.len() > 160
            || !ids.insert(candidate.id.as_str())
            || candidate.evidence.excerpt.len() > 512
            || candidate
                .evidence
                .source_field
                .as_ref()
                .is_some_and(|source| source.len() > 128)
            || !matches!(
                candidate.evidence.confidence.as_str(),
                "high" | "medium" | "low" | "unknown"
            )
        {
            return Err(StorageError::Validation(
                "Import candidate metadata is invalid".into(),
            ));
        }
        match &candidate.value {
            ImportCandidateValue::BasicField { value, .. } => {
                if value.trim().is_empty() || value.len() > 2048 {
                    return Err(StorageError::Validation(
                        "Import field candidate must contain bounded non-empty text".into(),
                    ));
                }
            }
            ImportCandidateValue::SectionEntries { title, entries, .. } => {
                if title.trim().is_empty()
                    || title.len() > 160
                    || entries.is_empty()
                    || entries.len() > 100
                {
                    return Err(StorageError::Validation(
                        "Import section candidate is empty or too large".into(),
                    ));
                }
            }
            ImportCandidateValue::SummaryBody { title, body } => {
                if title.trim().is_empty() || title.len() > 160 || body.is_empty() {
                    return Err(StorageError::Validation(
                        "Import summary candidate is empty or invalid".into(),
                    ));
                }
            }
        }
    }
    if warnings
        .iter()
        .chain(unsupported)
        .any(|text| text.trim().is_empty() || text.len() > 512)
    {
        return Err(StorageError::Validation(
            "Import diagnostics are invalid".into(),
        ));
    }
    let review_size = serde_json::to_vec(&(candidates, warnings, unsupported))?.len();
    if review_size > MAX_IMPORT_REVIEW_BYTES {
        return Err(StorageError::Validation(
            "Import review payload exceeds the 2 MiB limit".into(),
        ));
    }
    Ok(())
}

fn parse_import_preview_data_url(value: &str) -> StorageResult<Option<(String, Vec<u8>)>> {
    let Some((mime, encoded)) = value
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
    else {
        return Err(StorageError::Validation(
            "Import preview must be a base64 image".into(),
        ));
    };
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp")
        || encoded.len() > MAX_IMPORT_PREVIEW_BYTES * 2
    {
        return Err(StorageError::Validation(
            "Unsupported or oversized import preview".into(),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| StorageError::Validation("Import preview is not valid base64".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORT_PREVIEW_BYTES {
        return Err(StorageError::Validation(
            "Import preview exceeds the 8 MiB limit".into(),
        ));
    }
    Ok(Some((mime.into(), bytes)))
}

fn read_import_draft_tx(
    connection: &Connection,
    draft_id: &str,
) -> StorageResult<Option<ImportDraft>> {
    let row = connection
        .query_row(
            "SELECT id, source_kind, display_name, source_hash, status, preview_asset_id,
                    candidates_json, warnings_json, unsupported_features_json, created_at
             FROM import_drafts WHERE id = ?1",
            params![draft_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(
            id,
            source_kind,
            display_name,
            source_hash,
            status,
            preview_asset_id,
            candidates,
            warnings,
            unsupported_features,
            created_at,
        )| {
            Ok(ImportDraft {
                id,
                source_kind: parse_import_source(&source_kind)?,
                display_name,
                source_hash,
                created_at,
                status: parse_import_status(&status)?,
                preview_asset_id,
                candidates: serde_json::from_str(&candidates)?,
                warnings: serde_json::from_str(&warnings)?,
                unsupported_features: serde_json::from_str(&unsupported_features)?,
            })
        },
    )
    .transpose()
}

fn validate_import_command(request: &ApplyImportRequest, actor: &str) -> StorageResult<()> {
    if request.command_id.trim().is_empty()
        || request.command_id.len() > 160
        || request.draft_id.trim().is_empty()
        || request.draft_id.len() > 160
        || actor.trim().is_empty()
        || request.accepted_candidate_ids.is_empty()
        || request.accepted_candidate_ids.len() > MAX_IMPORT_CANDIDATES
    {
        return Err(StorageError::Validation(
            "Invalid import apply request".into(),
        ));
    }
    Ok(())
}

fn apply_import_candidate(
    document: &mut ResumeDocument,
    draft_id: &str,
    candidate: &ImportCandidate,
) -> StorageResult<()> {
    match &candidate.value {
        ImportCandidateValue::BasicField { field, value } => {
            let value = value.trim().to_string();
            match field {
                ImportBasicField::Name => document.basic.name = value,
                ImportBasicField::Phone => document.basic.phone = value,
                ImportBasicField::Email => document.basic.email = value,
                ImportBasicField::City => document.basic.city = value,
                ImportBasicField::Wechat => document.basic.wechat = value,
                ImportBasicField::Birth => document.basic.birth = value,
                ImportBasicField::Website => document.basic.website = Some(value),
                ImportBasicField::Linkedin => document.basic.linkedin = Some(value),
                ImportBasicField::Gender => document.basic.gender = Some(value),
                ImportBasicField::Height => document.basic.height = Some(value),
                ImportBasicField::Weight => document.basic.weight = Some(value),
                ImportBasicField::Ethnicity => document.basic.ethnicity = Some(value),
                ImportBasicField::Birthplace => document.basic.birthplace = Some(value),
                ImportBasicField::PoliticalStatus => document.basic.political_status = Some(value),
                ImportBasicField::MaritalStatus => document.basic.marital_status = Some(value),
                ImportBasicField::Zodiac => document.basic.zodiac = Some(value),
                ImportBasicField::Mbti => document.basic.mbti = Some(value),
            }
        }
        ImportCandidateValue::SectionEntries {
            kind,
            title,
            entries,
        } => {
            let mut ids = BTreeSet::new();
            for entry in entries {
                if entry.id.trim().is_empty()
                    || entry.id.len() > 160
                    || !ids.insert(entry.id.as_str())
                    || document.sections.iter().any(|section| match section {
                        Section::Entry(section) => {
                            section.entries.iter().any(|item| item.id == entry.id)
                        }
                        Section::Summary(_) => false,
                    })
                {
                    return Err(StorageError::Validation(
                        "Imported entries contain invalid or duplicate IDs".into(),
                    ));
                }
            }
            if let Some(Section::Entry(section)) = document.sections.iter_mut().find(
                |section| matches!(section, Section::Entry(existing) if existing.kind == *kind),
            ) {
                section.entries.extend(entries.clone());
            } else {
                document.sections.push(Section::Entry(EntrySection {
                    id: format!("import:{draft_id}:{}", candidate.id),
                    kind: *kind,
                    title: title.trim().to_string(),
                    visible: true,
                    entries: entries.clone(),
                }));
            }
        }
        ImportCandidateValue::SummaryBody { title, body } => {
            if let Some(Section::Summary(section)) = document
                .sections
                .iter_mut()
                .find(|section| matches!(section, Section::Summary(_)))
            {
                section.body.extend(body.clone());
            } else {
                document.sections.push(Section::Summary(SummarySection {
                    id: format!("import:{draft_id}:{}", candidate.id),
                    kind: "summary".into(),
                    title: title.trim().to_string(),
                    visible: true,
                    body: body.clone(),
                }));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "storage/tests.rs"]
mod tests;

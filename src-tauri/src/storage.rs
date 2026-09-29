use std::path::Path;

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::domain::{canonical_hash, AuthorityCursor, ResumeDocument};

#[derive(Debug)]
pub enum StorageError {
    Io(std::io::Error),
    Database(rusqlite::Error),
    Serialization(serde_json::Error),
    HashMismatch,
    MissingDraft,
    Domain(crate::domain::AppError),
    Conflict(String),
    Validation(String),
    Permission(String),
    NotFound(String),
    Corrupt(String),
    UnsupportedSchema(i64),
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

impl From<crate::domain::AppError> for StorageError {
    fn from(value: crate::domain::AppError) -> Self {
        Self::Domain(value)
    }
}

pub type StorageResult<T> = Result<T, StorageError>;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionBranch {
    pub id: String,
    pub name: String,
    pub head_commit_id: Option<String>,
    pub is_current: bool,
    pub created_at: String,
}

/// 供版本 UI 一次性取回整张图：提交按 graph 排序，附带快照 document JSON。
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionCommitDetailed {
    #[serde(flatten)]
    pub commit: VersionCommit,
    pub snapshot_document_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionGraphDetailed {
    pub cursor: AuthorityCursor,
    pub branches: Vec<VersionBranch>,
    pub commits: Vec<VersionCommitDetailed>,
}

/// 旧版 ResumeVersionStore 的替换载荷（F28）；快照已是新 ResumeDocument。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReplaceBranch {
    pub id: String,
    pub name: String,
    pub head_commit_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReplaceCommit {
    pub id: String,
    pub branch_id: String,
    pub parent_id: Option<String>,
    pub message: String,
    pub created_at: String,
    pub snapshot: ResumeDocument,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionCommit {
    pub id: String,
    pub origin_branch_id: String,
    pub origin_deleted: bool,
    pub snapshot_id: String,
    pub parent_id: Option<String>,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../src/domain/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct VersionGraph {
    pub cursor: AuthorityCursor,
    pub branches: Vec<VersionBranch>,
    pub commits: Vec<VersionCommit>,
}

fn default_branch_id(document_id: &str) -> String {
    format!("main:{document_id}")
}

const MIGRATIONS: [(i64, &str); 8] = [
    (
        1,
        r##"
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      current_branch_id TEXT NOT NULL,
      active_context_id TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE editing_contexts (
      id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      PRIMARY KEY(document_id, id),
      FOREIGN KEY(document_id) REFERENCES documents(id)
    );
    CREATE TABLE branches (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      name TEXT NOT NULL,
      head_commit_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_id, name),
      FOREIGN KEY(document_id) REFERENCES documents(id)
    );
    CREATE TABLE drafts (
      document_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(document_id, context_id, branch_id),
      FOREIGN KEY(document_id) REFERENCES documents(id),
      FOREIGN KEY(branch_id) REFERENCES branches(id)
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      canonical_version INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE commits (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      origin_branch_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(document_id) REFERENCES documents(id),
      FOREIGN KEY(origin_branch_id) REFERENCES branches(id),
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
    );
    CREATE TABLE commit_links (
      commit_id TEXT PRIMARY KEY,
      visible_parent_id TEXT,
      FOREIGN KEY(commit_id) REFERENCES commits(id),
      FOREIGN KEY(visible_parent_id) REFERENCES commits(id)
    );
    CREATE TABLE resources (
      hash TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL,
      license_ref TEXT
    );
    CREATE TABLE resource_refs (
      resource_hash TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      PRIMARY KEY(resource_hash, owner_kind, owner_id),
      FOREIGN KEY(resource_hash) REFERENCES resources(hash)
    );
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE INDEX idx_drafts_document ON drafts(document_id, updated_at);
    CREATE INDEX idx_commits_document ON commits(document_id, created_at);
    CREATE INDEX idx_resource_refs_owner ON resource_refs(owner_kind, owner_id);
    "##,
    ),
    (
        2,
        r##"
    CREATE TABLE branch_tombstones (
      branch_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(branch_id) REFERENCES branches(id)
    );
    "##,
    ),
    (
        3,
        r##"
    -- 工作区偏好（分栏宽度、模板收藏/最近使用、导入模板目录等）。
    -- 不进入文档内容 hash，也不参与版本快照。
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    "##,
    ),
    (
        4,
        r##"
    -- B11 身份与凭据：本机账户、会话、模型连接与 DPAPI 密文。
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      kdf TEXT NOT NULL DEFAULT 'scrypt-n16384-r8-p1',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE account_sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE provider_profiles (
      account_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      capability TEXT NOT NULL DEFAULT 'chat-only',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, connection_id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE secrets (
      secret_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      backend_version INTEGER NOT NULL DEFAULT 1,
      encrypted_blob BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, provider_id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    "##,
    ),
    (
        5,
        r##"
    ALTER TABLE provider_profiles ADD COLUMN name TEXT NOT NULL DEFAULT '';
    "##,
    ),
    (
        6,
        r##"
    CREATE TABLE imported_template_catalog (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      payload_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    "##,
    ),
    (
        7,
        r##"
    CREATE TABLE template_activity (
      template_id TEXT PRIMARY KEY,
      favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
      last_used_at INTEGER CHECK(last_used_at IS NULL OR last_used_at > 0)
    );
    "##,
    ),
    (
        8,
        r##"
    CREATE TABLE agent_session_meta (
      account_id TEXT PRIMARY KEY,
      active_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(account_id, ordinal),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE INDEX idx_agent_sessions_account ON agent_sessions(account_id, updated_at);
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      source_view TEXT,
      source_refs_json TEXT,
      UNIQUE(session_id, ordinal),
      FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );
    "##,
    ),
];

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn open(path: &Path) -> StorageResult<Self> {
        let connection = Connection::open(path)?;
        Self::prepare(connection)
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
            Self::integrity_check(&destination)?;
            if !Self::check_schema_compatibility(&destination)? {
                return Err(StorageError::Corrupt("Staged backup has no schema".into()));
            }
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
        result
    }

    pub fn restore_from(&mut self, path: &Path) -> StorageResult<()> {
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Self::integrity_check(&source)?;
        if !Self::check_schema_compatibility(&source)? {
            return Err(StorageError::Corrupt(
                "Backup has no ZineCV migration records".into(),
            ));
        }
        let mut staging = Connection::open_in_memory()?;
        {
            let backup = Backup::new(&source, &mut staging)?;
            loop {
                match backup.step(128)? {
                    StepResult::Done => break,
                    _ => continue,
                }
            }
        }
        let staged_store = Self::prepare(staging)?;
        {
            let backup = Backup::new(&staged_store.connection, &mut self.connection)?;
            loop {
                match backup.step(128)? {
                    StepResult::Done => break,
                    _ => continue,
                }
            }
        }
        self.connection.pragma_update(None, "foreign_keys", "ON")?;
        self.connection.pragma_update(None, "journal_mode", "WAL")?;
        self.connection.pragma_update(None, "synchronous", "FULL")?;
        self.connection.pragma_update(None, "busy_timeout", 5000)?;
        self.connection
            .pragma_update(None, "temp_store", "MEMORY")?;
        Ok(())
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
        }
        Ok(valid_base)
    }

    fn migrate(&mut self) -> StorageResult<()> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
              version INTEGER PRIMARY KEY,
              checksum TEXT NOT NULL,
              applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )?;
        for (version, sql) in MIGRATIONS {
            let applied: Option<i64> = self
                .connection
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
            let transaction = self.connection.transaction()?;
            transaction.execute_batch(sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations(version, checksum) VALUES (?1, ?2)",
                params![version, checksum],
            )?;
            transaction.commit()?;
        }
        Ok(())
    }

    /// 供同 crate 的身份/设置模块访问底层连接（不越过 Store 的事务约定）。
    pub(crate) fn connection(&self) -> &Connection {
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
        crate::domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
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
        let snapshot_id = format!("snap-{hash}");
        let commit_id = format!("commit:{}:initial", document.document_id);
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, hash],
        )?;
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
        transaction.commit()?;
        Ok(())
    }

    pub fn apply_command(
        &mut self,
        actor: &str,
        envelope: crate::domain::CommandEnvelope,
    ) -> StorageResult<crate::domain::CommandResult> {
        use crate::domain::DocumentContext;

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
        crate::domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
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
        let updated_document = transaction.execute(
            "UPDATE documents SET revision = revision + 1
             WHERE id = ?1 AND current_branch_id = ?2 AND active_context_id = ?3 AND revision = ?4",
            params![expected.document_id, branch_id, context_id, revision],
        )?;
        if updated_document != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
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
        crate::domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        if document.document_id != expected.document_id || canonical_hash(&document)? != stored_hash
        {
            return Err(StorageError::HashMismatch);
        }
        let changed = transaction.execute(
            "UPDATE documents SET title = ?1, revision = revision + 1
             WHERE id = ?2 AND current_branch_id = ?3 AND active_context_id = ?4 AND revision = ?5",
            params![
                document.title,
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
            params![expected.document_id, context_id, branch_id, revision + 1, json, stored_hash],
        )?;
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
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
            crate::domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
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
            crate::domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
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
        Ok(())
    }

    pub fn link_resource(&self, hash: &str, owner_kind: &str, owner_id: &str) -> StorageResult<()> {
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
        Ok(self.connection.execute(
            "DELETE FROM resources WHERE hash NOT IN (SELECT resource_hash FROM resource_refs)",
            [],
        )?)
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

    /// 版本 UI 使用：同一读事务返回 graph 与每个提交的快照 document JSON。
    pub fn load_version_graph_detailed(
        &self,
        document_id: &str,
    ) -> StorageResult<VersionGraphDetailed> {
        let graph = self.load_version_graph(document_id)?;
        let mut detailed = Vec::with_capacity(graph.commits.len());
        for commit in &graph.commits {
            let json: String = self
                .connection
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
            let _: ResumeDocument = serde_json::from_str(&json).map_err(|error| {
                StorageError::Corrupt(format!("Snapshot parse failed: {error}"))
            })?;
            detailed.push(VersionCommitDetailed {
                commit: commit.clone(),
                snapshot_document_json: json,
            });
        }
        Ok(VersionGraphDetailed {
            cursor: graph.cursor,
            branches: graph.branches,
            commits: detailed,
        })
    }

    /// 头像资产读取：按 hash 返回 (mime, bytes)；缺失返回 None 而不是错误。
    pub fn read_resource_bytes(&self, hash: &str) -> StorageResult<Option<(String, Vec<u8>)>> {
        Ok(self
            .connection
            .query_row(
                "SELECT mime, bytes FROM resources WHERE hash = ?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
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
        Ok(self
            .connection
            .query_row(
                "SELECT revision, payload_json FROM imported_template_catalog WHERE id = 1",
                [],
                |row| {
                    Ok(ImportedTemplateCatalog {
                        revision: row.get(0)?,
                        payload_json: row.get(1)?,
                    })
                },
            )
            .optional()?)
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
        transaction.execute(
            "INSERT INTO imported_template_catalog(id, payload_json, revision, updated_at)
             VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(id) DO UPDATE SET
               payload_json = excluded.payload_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![payload_json, revision],
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
    /// 快照按内容 hash 去重复用；当前工作内容不变化——draft 由调用方一并写入。
    pub fn replace_version_store(
        &mut self,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
        draft: &ResumeDocument,
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
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

        // 1) 清空该文档的版本图；快照在全部分支删除后再统一回收。
        transaction.execute(
            "DELETE FROM commit_links WHERE commit_id IN (SELECT id FROM commits WHERE document_id = ?1)",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM branch_tombstones WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM branches WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM commits WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
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
        transaction.execute(
            "UPDATE documents SET current_branch_id = ?2, revision = revision + 1 WHERE id = ?1",
            params![document_id, target_branch],
        )?;
        let next_revision = revision + 1;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![document_id, context_id, target_branch],
        )?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![
                document_id,
                context_id,
                target_branch,
                next_revision,
                serde_json::to_string(draft)?,
                canonical_hash(draft)?,
            ],
        )?;
        // 替换完成后回收未被任何提交引用的旧快照，避免历史泄漏。
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
            [],
        )?;
        transaction.commit()?;
        let head_id: Option<String> = self.connection.query_row(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn document(id: &str) -> ResumeDocument {
        let json = format!(
            r##"{{
              "schemaVersion":2,
              "documentId":"{id}",
              "title":"测试",
              "basic":{{"name":"样例","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"}},
              "sections":[],
              "presentation":{{"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"fixture","fontSizePt":9.75,"lineHeightPt":12,"moduleGapPt":8,"pageMarginPt":24,"headingSizePt":11,"paragraphGapPt":4,"listGapPt":4,"theme":"#000000","dateFormat":"2021.01","titleFormat":"双行标题","separator":"不使用分隔符号","textAlign":"系统默认","legacyOverrides":{{}}}},
              "legacyExtensions":{{}}
            }}"##
        );
        serde_json::from_str(&json).expect("fixture")
    }

    fn commit(store: &mut Store, document_id: &str, message: &str) -> AuthorityCursor {
        let cursor = store
            .load_cursor(document_id, "context-a")
            .expect("cursor")
            .expect("document");
        store.commit_draft(&cursor, message).expect("commit")
    }

    fn edit_title(
        store: &mut Store,
        cursor: &AuthorityCursor,
        command_id: &str,
        title: &str,
    ) -> AuthorityCursor {
        use crate::domain::{CommandEnvelope, DomainCommand};
        store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: command_id.into(),
                    document_id: cursor.document_id.clone(),
                    context_id: cursor.context_id.clone(),
                    expected_revision: cursor.revision.clone(),
                    expected_branch_id: cursor.branch_id.clone(),
                    expected_head_id: cursor.head_id.clone(),
                    payload: DomainCommand::SetDocumentTitle {
                        title: title.into(),
                    },
                },
            )
            .expect("edit title")
            .cursor
    }

    #[test]
    fn summary_body_command_is_durable_and_idempotent() {
        use crate::domain::{
            default_resume_document, CommandEnvelope, DomainCommand, Inline, RichBlock, Section,
        };

        let mut store = Store::open_in_memory().expect("store");
        let document = default_resume_document("doc-summary").expect("default document");
        store
            .initialize_document(&document, "context-a")
            .expect("initialize");
        let cursor = store
            .load_cursor("doc-summary", "context-a")
            .expect("cursor")
            .expect("document");
        let body = vec![RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: "持久化的自我评价".into(),
                marks: vec![],
            }],
        }];
        let command = CommandEnvelope {
            protocol_version: 1,
            command_id: "summary-edit-1".into(),
            document_id: cursor.document_id.clone(),
            context_id: cursor.context_id.clone(),
            expected_revision: cursor.revision.clone(),
            expected_branch_id: cursor.branch_id.clone(),
            expected_head_id: cursor.head_id.clone(),
            payload: DomainCommand::SetSummaryBody {
                section_id: "legacy-section:summary".into(),
                body: body.clone(),
            },
        };
        let first = store
            .apply_command("host-actor", command.clone())
            .expect("edit summary");
        let retry = store
            .apply_command("host-actor", command)
            .expect("retry same command");
        assert_eq!(first, retry);
        let (reloaded_cursor, reloaded) = store
            .load_current("doc-summary", "context-a")
            .expect("read persisted summary")
            .expect("document");
        assert_eq!(reloaded_cursor.to_string(), first.cursor.revision);
        let summary = reloaded
            .sections
            .iter()
            .find_map(|section| match section {
                Section::Summary(summary) => Some(summary),
                Section::Entry(_) => None,
            })
            .expect("summary section");
        assert_eq!(summary.id, "legacy-section:summary");
        assert_eq!(summary.body, body);
    }

    #[test]
    fn legacy_entry_fields_and_empty_name_survive_sqlite_reload() {
        use crate::domain::{BasicPatch, CommandEnvelope, DomainCommand, Section};

        let mut store = Store::open_in_memory().expect("store");
        let mut document = document("doc-legacy-fields");
        document.sections.push(
            serde_json::from_value(serde_json::json!({
                "id":"education-1", "kind":"education", "title":"教育经历", "visible":true,
                "entries":[{"id":"entry-1", "title":"", "role":"", "department":"", "city":"",
                    "start":"", "end":"", "body":[]}]
            }))
            .expect("entry section"),
        );
        store
            .initialize_document(&document, "context-a")
            .expect("initialize");
        let cursor = store
            .load_cursor(&document.document_id, "context-a")
            .expect("cursor")
            .expect("document");
        let updated = store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "legacy-fields".into(),
                    document_id: cursor.document_id.clone(),
                    context_id: cursor.context_id.clone(),
                    expected_revision: cursor.revision.clone(),
                    expected_branch_id: cursor.branch_id.clone(),
                    expected_head_id: cursor.head_id.clone(),
                    payload: DomainCommand::UpdateEntryFields {
                        entry_id: "entry-1".into(),
                        title: None,
                        role: None,
                        department: None,
                        city: None,
                        start: None,
                        end: None,
                        college: Some("示例大学".into()),
                        mode: Some("全日制".into()),
                    },
                },
            )
            .expect("update entry");
        store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "blank-name".into(),
                    document_id: cursor.document_id.clone(),
                    context_id: cursor.context_id.clone(),
                    expected_revision: updated.cursor.revision.clone(),
                    expected_branch_id: updated.cursor.branch_id.clone(),
                    expected_head_id: updated.cursor.head_id.clone(),
                    payload: DomainCommand::UpdateBasic {
                        patch: BasicPatch {
                            name: Some(String::new()),
                            ..BasicPatch::default()
                        },
                    },
                },
            )
            .expect("clear name");
        let (_, reloaded) = store
            .load_current(&document.document_id, "context-a")
            .expect("load current")
            .expect("document");
        assert_eq!(reloaded.basic.name, "");
        let Section::Entry(section) = &reloaded.sections[0] else {
            panic!("education section");
        };
        assert_eq!(section.entries[0].college.as_deref(), Some("示例大学"));
        assert_eq!(section.entries[0].mode.as_deref(), Some("全日制"));
    }

    #[test]
    fn deleting_commit_reconnects_children_and_branch_heads_without_changing_current_document() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-delete-graph");
        store
            .initialize_document(&initial, "context-a")
            .expect("init");
        let baseline = store
            .load_cursor(&initial.document_id, "context-a")
            .expect("cursor")
            .expect("document");
        let second_edit = edit_title(&mut store, &baseline, "delete-edit-1", "第二版");
        let second = store
            .commit_draft(&second_edit, "second")
            .expect("second commit");
        let child = store
            .create_branch_from_current(&second, "child")
            .expect("child branch");
        let dirty = edit_title(&mut store, &child, "delete-graph-dirty", "未提交的当前内容");
        let before = store
            .load_current(&initial.document_id, "context-a")
            .expect("current")
            .expect("document")
            .1;
        assert!(matches!(
            store.delete_commit(&dirty, second.head_id.as_deref().unwrap(), false),
            Err(StorageError::Validation(_))
        ));
        let after = store
            .delete_commit(&dirty, second.head_id.as_deref().unwrap(), true)
            .expect("delete middle");
        assert_eq!(after.head_id, child.head_id);
        assert_eq!(store.commit_count(&initial.document_id).expect("count"), 2);
        let parent: Option<String> = store
            .connection
            .query_row(
                "SELECT visible_parent_id FROM commit_links WHERE commit_id = ?1",
                [child.head_id.as_deref().unwrap()],
                |row| row.get(0),
            )
            .expect("parent");
        assert_eq!(parent, baseline.head_id);
        let main_head: Option<String> = store
            .connection
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1",
                [&baseline.branch_id],
                |row| row.get(0),
            )
            .expect("main head");
        assert_eq!(main_head, baseline.head_id);
        assert_eq!(
            store
                .load_current(&initial.document_id, "context-a")
                .expect("current")
                .expect("document")
                .1,
            before
        );
        assert!(matches!(
            store.delete_commit(&dirty, second.head_id.as_deref().unwrap(), true),
            Err(StorageError::Conflict(_))
        ));
        store
            .commit_draft(&after, "save surviving draft")
            .expect("commit surviving draft");
    }

    #[test]
    fn deleting_current_head_keeps_content_as_draft_and_rejects_cross_document_commit() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-delete-head");
        store
            .initialize_document(&initial, "context-a")
            .expect("init");
        let baseline = store
            .load_cursor(&initial.document_id, "context-a")
            .expect("cursor")
            .expect("document");
        let edited = edit_title(&mut store, &baseline, "delete-head-edit", "当前内容");
        let committed = store.commit_draft(&edited, "current").expect("commit");
        let other = document("doc-delete-other");
        store
            .initialize_document(&other, "context-a")
            .expect("other init");
        let other_head = store
            .load_cursor(&other.document_id, "context-a")
            .expect("other cursor")
            .expect("document")
            .head_id
            .unwrap();
        assert!(matches!(
            store.delete_commit(&committed, &other_head, true),
            Err(StorageError::NotFound(_))
        ));
        let current = store
            .load_current(&initial.document_id, "context-a")
            .expect("current")
            .expect("document")
            .1;
        let after = store
            .delete_commit(&committed, committed.head_id.as_deref().unwrap(), true)
            .expect("delete head");
        assert_eq!(after.head_id, baseline.head_id);
        assert_eq!(
            store
                .load_current(&initial.document_id, "context-a")
                .expect("current")
                .expect("document")
                .1,
            current
        );
        let draft = store
            .load_draft(&initial.document_id, "context-a")
            .expect("draft")
            .expect("present");
        assert_eq!(draft.0.to_string(), after.revision);
        assert_eq!(
            store
                .commit_draft(&after, "restore current")
                .expect("commit draft")
                .revision,
            "4"
        );
    }

    #[test]
    fn deleting_branch_retains_shared_ancestors_and_prunes_exclusive_commits() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-delete-branch");
        store
            .initialize_document(&initial, "context-a")
            .expect("init");
        let main = store
            .load_cursor(&initial.document_id, "context-a")
            .expect("cursor")
            .expect("document");
        let feature = store
            .create_branch_from_current(&main, "feature")
            .expect("feature");
        let feature_edit = edit_title(&mut store, &feature, "shared-edit", "shared");
        let shared = store
            .commit_draft(&feature_edit, "shared commit")
            .expect("shared commit");
        let descendant = store
            .create_branch_from_current(&shared, "descendant")
            .expect("descendant");
        let back = store
            .switch_branch(&descendant, &feature.branch_id, false)
            .expect("back to feature");
        let exclusive_edit = edit_title(&mut store, &back, "exclusive-edit", "exclusive");
        let exclusive = store
            .commit_draft(&exclusive_edit, "exclusive commit")
            .expect("exclusive commit");
        let current = store
            .switch_branch(&exclusive, &descendant.branch_id, false)
            .expect("descendant current");
        let before = store
            .load_current(&initial.document_id, "context-a")
            .expect("current")
            .expect("document")
            .1;
        let after = store
            .delete_branch(&current, &feature.branch_id, true)
            .expect("delete feature");
        assert_eq!(after.branch_id, descendant.branch_id);
        assert_eq!(
            store
                .load_current(&initial.document_id, "context-a")
                .expect("current")
                .expect("document")
                .1,
            before
        );
        assert_eq!(store.commit_count(&initial.document_id).expect("count"), 4);
        let exclusive_exists: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM commits WHERE id = ?1)",
                [exclusive.head_id.as_deref().unwrap()],
                |row| row.get(0),
            )
            .expect("exclusive pruned");
        assert!(!exclusive_exists);
        let retained_source: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM commits JOIN branch_tombstones
             ON branch_tombstones.branch_id = commits.origin_branch_id WHERE commits.id = ?1)",
                [shared.head_id.as_deref().unwrap()],
                |row| row.get(0),
            )
            .expect("deleted origin retained");
        assert!(retained_source);
        assert!(matches!(
            store.switch_branch(&after, &feature.branch_id, false),
            Err(StorageError::NotFound(_))
        ));
        store
            .create_branch_from_current(&after, "feature")
            .expect("name can be reused");
    }

    #[test]
    fn deleting_current_branch_switches_to_main_and_protects_default() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-delete-current-branch");
        store
            .initialize_document(&initial, "context-a")
            .expect("init");
        let main = store
            .load_cursor(&initial.document_id, "context-a")
            .expect("cursor")
            .expect("document");
        assert!(matches!(
            store.delete_branch(&main, &main.branch_id, true),
            Err(StorageError::Validation(_))
        ));
        let feature = store
            .create_branch_from_current(&main, "feature")
            .expect("feature");
        let edited = edit_title(
            &mut store,
            &feature,
            "delete-current-edit",
            "feature content",
        );
        let committed = store
            .commit_draft(&edited, "feature commit")
            .expect("commit");
        assert!(matches!(
            store.delete_branch(&committed, &feature.branch_id, false),
            Err(StorageError::Validation(_))
        ));
        let after = store
            .delete_branch(&committed, &feature.branch_id, true)
            .expect("delete current");
        assert_eq!(after.branch_id, main.branch_id);
        assert_eq!(after.head_id, main.head_id);
        assert_eq!(
            store
                .load_current(&initial.document_id, "context-a")
                .expect("current")
                .expect("document")
                .1,
            initial
        );
        assert!(matches!(
            store.delete_branch(&committed, &feature.branch_id, true),
            Err(StorageError::Conflict(_))
        ));
    }

    #[test]
    fn deleted_branch_stays_deleted_after_reopening_database() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-delete-branch-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let document_id = "doc-delete-persist";
        let branch_id = {
            let mut store = Store::open(&path).expect("store");
            store
                .initialize_document(&document(document_id), "context-a")
                .expect("init");
            let main = store
                .load_cursor(document_id, "context-a")
                .expect("cursor")
                .expect("document");
            let feature = store
                .create_branch_from_current(&main, "feature")
                .expect("feature");
            store
                .delete_branch(&feature, &feature.branch_id, true)
                .expect("delete feature");
            feature.branch_id
        };
        {
            let mut store = Store::open(&path).expect("reopen");
            let current = store
                .load_cursor(document_id, "context-a")
                .expect("cursor")
                .expect("document");
            assert_eq!(current.branch_id, default_branch_id(document_id));
            assert_eq!(store.commit_count(document_id).expect("count"), 1);
            assert!(matches!(
                store.switch_branch(&current, &branch_id, false),
                Err(StorageError::NotFound(_))
            ));
            let tombstone: bool = store
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM branch_tombstones WHERE branch_id = ?1)",
                    [&branch_id],
                    |row| row.get(0),
                )
                .expect("tombstone");
            assert!(tombstone);
        }
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn version_graph_uses_one_cursor_and_marks_deleted_commit_origin() {
        let mut store = Store::open_in_memory().expect("store");
        let document_id = "doc-version-graph";
        store
            .initialize_document(&document(document_id), "context-a")
            .expect("init");
        let main = store
            .load_cursor(document_id, "context-a")
            .expect("cursor")
            .expect("document");
        let feature = store
            .create_branch_from_current(&main, "feature")
            .expect("feature");
        let descendant = store
            .create_branch_from_current(&feature, "descendant")
            .expect("descendant");
        let current = store
            .delete_branch(&descendant, &feature.branch_id, true)
            .expect("delete feature");
        let graph = store.load_version_graph(document_id).expect("graph");
        assert_eq!(graph.cursor, current);
        assert_eq!(graph.branches.len(), 2);
        assert!(graph
            .branches
            .iter()
            .any(|branch| branch.id == descendant.branch_id && branch.is_current));
        assert!(!graph
            .branches
            .iter()
            .any(|branch| branch.id == feature.branch_id));
        assert_eq!(graph.commits.len(), 3);
        let feature_commit = graph
            .commits
            .iter()
            .find(|commit| Some(&commit.id) == feature.head_id.as_ref())
            .expect("retained feature ancestor");
        assert!(feature_commit.origin_deleted);
        assert_eq!(feature_commit.parent_id, main.head_id);
        let json = serde_json::to_value(&graph).expect("json");
        assert!(json["commits"][0].get("originDeleted").is_some());
    }

    #[test]
    fn load_current_prefers_draft_then_head_snapshot() {
        let mut store = Store::open_in_memory().expect("store");
        assert!(store
            .load_current("missing", "context-a")
            .expect("missing")
            .is_none());
        let document = document("doc-current");
        store
            .save_draft(&document, "context-a", 2)
            .expect("save draft");
        assert_eq!(
            store
                .load_current("doc-current", "context-a")
                .expect("draft")
                .expect("value")
                .0,
            2
        );
        assert_eq!(
            store
                .load_cursor("doc-current", "context-a")
                .expect("cursor")
                .expect("value")
                .revision,
            "2"
        );
        assert!(matches!(
            store.load_current("doc-current", "context-other"),
            Err(StorageError::Conflict(_))
        ));
        commit(&mut store, "doc-current", "提交");
        assert_eq!(
            store
                .load_current("doc-current", "context-a")
                .expect("head")
                .expect("value")
                .1,
            document
        );
    }

    #[test]
    fn initialization_never_replaces_an_existing_draft() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-initialize");
        assert!(store
            .initialize_document(&initial, "context-a")
            .expect("first initialization"));
        let initial_head = store
            .load_cursor("doc-initialize", "context-a")
            .expect("initial cursor")
            .expect("document")
            .head_id;
        let result = store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "edit-before-restart".into(),
                    document_id: initial.document_id.clone(),
                    context_id: "context-a".into(),
                    expected_revision: "0".into(),
                    expected_branch_id: default_branch_id("doc-initialize"),
                    expected_head_id: initial_head,
                    payload: DomainCommand::SetDocumentTitle {
                        title: "用户已修改".into(),
                    },
                },
            )
            .expect("edit");
        assert_eq!(result.cursor.revision, "1");
        assert!(!store
            .initialize_document(&initial, "context-a")
            .expect("repeat initialization"));
        let (revision, persisted) = store
            .load_current("doc-initialize", "context-a")
            .expect("read")
            .expect("document");
        assert_eq!(revision, 1);
        assert_eq!(persisted.title, "用户已修改");

        assert!(store
            .initialize_document(&document("another-document"), "context-b")
            .expect("second document"));
        assert_eq!(
            store
                .load_current("another-document", "context-b")
                .expect("second document read")
                .expect("second document draft")
                .1
                .document_id,
            "another-document"
        );
    }

    #[test]
    fn simultaneous_initialization_creates_one_document() {
        use std::sync::{Arc, Barrier};

        let path = std::env::temp_dir().join(format!(
            "zinecv-initialize-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        drop(Store::open(&path).expect("migrated empty database"));
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut store = Store::open(&path).expect("store");
                    barrier.wait();
                    store
                        .initialize_document(&document("doc-simultaneous"), "context-a")
                        .expect("initialize")
                })
            })
            .collect::<Vec<_>>();
        let created = handles
            .into_iter()
            .map(|handle| handle.join().expect("initializer thread"))
            .filter(|created| *created)
            .count();
        assert_eq!(created, 1);
        let reopened = Store::open(&path).expect("reopen");
        let (revision, _) = reopened
            .load_current("doc-simultaneous", "context-a")
            .expect("read")
            .expect("document");
        assert_eq!(revision, 0);
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn migrates_and_round_trips_draft() {
        let store = Store::open_in_memory().expect("store");
        assert_eq!(
            store.migration_versions().expect("versions"),
            vec![1, 2, 3, 4, 5, 6, 7, 8]
        );
        let document = document("doc-store");
        store.save_draft(&document, "context-a", 7).expect("save");
        let (revision, loaded) = store
            .load_draft("doc-store", "context-a")
            .expect("load")
            .expect("draft");
        assert_eq!(revision, 7);
        assert_eq!(loaded, document);
    }

    #[test]
    fn commits_same_content_as_distinct_commits_one_snapshot() {
        let mut store = Store::open_in_memory().expect("store");
        let document = document("doc-history");
        store.save_draft(&document, "context-a", 1).expect("save");
        let first = commit(&mut store, "doc-history", "第一次");
        let second = store
            .create_branch_from_current(&first, "相同内容的分支")
            .expect("branch with same snapshot");
        assert_ne!(first.head_id, second.head_id);
        assert_eq!(store.commit_count("doc-history").expect("commits"), 2);
        assert_eq!(store.snapshot_count().expect("snapshots"), 1);
        assert!(store
            .load_draft("doc-history", "context-a")
            .expect("load")
            .is_none());
    }

    #[test]
    fn commit_requires_changed_draft_message_and_fresh_cursor() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-commit-guard");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        let baseline = store
            .load_cursor("doc-commit-guard", "context-a")
            .expect("cursor")
            .expect("document");
        assert!(matches!(
            store.commit_draft(&baseline, " "),
            Err(StorageError::Validation(_))
        ));
        assert!(matches!(
            store.commit_draft(&baseline, "no changes"),
            Err(StorageError::Validation(_))
        ));
        let edited = store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "edit-before-commit".into(),
                    document_id: initial.document_id.clone(),
                    context_id: "context-a".into(),
                    expected_revision: baseline.revision.clone(),
                    expected_branch_id: baseline.branch_id.clone(),
                    expected_head_id: baseline.head_id.clone(),
                    payload: DomainCommand::SetDocumentTitle {
                        title: "已编辑".into(),
                    },
                },
            )
            .expect("edit");
        assert!(matches!(
            store.commit_draft(&baseline, "stale"),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(store.commit_count("doc-commit-guard").expect("count"), 1);
        assert!(store
            .load_draft("doc-commit-guard", "context-a")
            .expect("draft")
            .is_some());
        let committed = store
            .commit_draft(&edited.cursor, "save changes")
            .expect("commit");
        assert_eq!(committed.revision, "2");
        assert_ne!(committed.head_id, baseline.head_id);
        assert!(matches!(
            store.commit_draft(&edited.cursor, "retry stale"),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(store.commit_count("doc-commit-guard").expect("count"), 2);
    }

    #[test]
    fn commit_failure_at_each_write_boundary_keeps_draft_and_head_atomic() {
        let failpoints = [
            ("snapshot", "BEFORE INSERT ON snapshots"),
            ("commit", "BEFORE INSERT ON commits"),
            ("link", "BEFORE INSERT ON commit_links"),
            ("head", "BEFORE UPDATE ON branches"),
            ("draft", "BEFORE DELETE ON drafts"),
            ("revision", "BEFORE UPDATE ON documents"),
        ];
        for (name, boundary) in failpoints {
            let document_id = format!("doc-fail-{name}");
            let mut store = Store::open_in_memory().expect("store");
            store
                .initialize_document(&document(&document_id), "context-a")
                .expect("initialize");
            let baseline = store
                .load_cursor(&document_id, "context-a")
                .expect("cursor")
                .expect("document");
            let edited = edit_title(&mut store, &baseline, &format!("edit-{name}"), "待提交修改");
            let baseline_commits = store.commit_count(&document_id).expect("commit count");
            let baseline_snapshots = store.snapshot_count().expect("snapshot count");
            let trigger = format!(
                "CREATE TEMP TRIGGER fail_commit {boundary} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
            );
            store
                .connection
                .execute_batch(&trigger)
                .expect("inject failure");
            assert!(
                matches!(
                    store.commit_draft(&edited, "commit after edit"),
                    Err(StorageError::Database(_))
                ),
                "boundary: {name}"
            );
            assert_eq!(
                store
                    .load_cursor(&document_id, "context-a")
                    .expect("cursor"),
                Some(edited.clone()),
                "boundary: {name}"
            );
            assert_eq!(
                store.commit_count(&document_id).expect("commits"),
                baseline_commits
            );
            assert_eq!(
                store.snapshot_count().expect("snapshots"),
                baseline_snapshots
            );
            assert_eq!(
                store
                    .load_current(&document_id, "context-a")
                    .expect("current")
                    .expect("document")
                    .1
                    .title,
                "待提交修改"
            );
            store
                .connection
                .execute_batch("DROP TRIGGER fail_commit")
                .expect("clear failure");
            let committed = store.commit_draft(&edited, "retry").expect("retry commit");
            assert_ne!(committed.head_id, baseline.head_id);
            assert_eq!(
                store.commit_count(&document_id).expect("commits"),
                baseline_commits + 1
            );
        }
    }

    #[test]
    fn command_failure_rolls_back_revision_draft_and_receipt() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        for boundary in [
            "BEFORE INSERT ON drafts",
            "BEFORE INSERT ON command_receipts",
        ] {
            let mut store = Store::open_in_memory().expect("store");
            let document_id = format!("doc-command-fail-{}", boundary.replace(' ', "-"));
            store
                .initialize_document(&document(&document_id), "context-a")
                .expect("initialize");
            let cursor = store
                .load_cursor(&document_id, "context-a")
                .expect("cursor")
                .expect("document");
            let envelope = CommandEnvelope {
                protocol_version: 1,
                command_id: format!("command-{document_id}"),
                document_id: document_id.clone(),
                context_id: "context-a".into(),
                expected_revision: cursor.revision.clone(),
                expected_branch_id: cursor.branch_id.clone(),
                expected_head_id: cursor.head_id.clone(),
                payload: DomainCommand::SetDocumentTitle {
                    title: "新标题".into(),
                },
            };
            store.connection.execute_batch(&format!(
                "CREATE TEMP TRIGGER fail_command {boundary} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
            )).expect("inject failure");
            assert!(matches!(
                store.apply_command("host-actor", envelope.clone()),
                Err(StorageError::Database(_))
            ));
            assert_eq!(
                store
                    .load_cursor(&document_id, "context-a")
                    .expect("cursor"),
                Some(cursor)
            );
            assert_eq!(
                store
                    .load_current(&document_id, "context-a")
                    .expect("current")
                    .expect("document")
                    .1
                    .title,
                "测试"
            );
            let receipt_count: i64 = store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM command_receipts WHERE command_id = ?1",
                    params![envelope.command_id],
                    |row| row.get(0),
                )
                .expect("receipt count");
            assert_eq!(receipt_count, 0);
            store
                .connection
                .execute_batch("DROP TRIGGER fail_command")
                .expect("clear failure");
            let result = store
                .apply_command("host-actor", envelope)
                .expect("retry command");
            assert_eq!(result.document.title, "新标题");
        }
    }

    #[test]
    fn documents_keep_distinct_branches_and_commit_ids() {
        let mut store = Store::open_in_memory().expect("store");
        for document_id in ["first", "second"] {
            store
                .save_draft(&document(document_id), "context-a", 0)
                .expect("save document");
        }
        let first = commit(&mut store, "first", "first commit");
        let second = commit(&mut store, "second", "second commit");
        assert_ne!(first.head_id, second.head_id);
        assert_eq!(store.commit_count("first").expect("first count"), 1);
        assert_eq!(store.commit_count("second").expect("second count"), 1);
        assert_eq!(
            store
                .load_cursor("first", "context-a")
                .expect("first cursor")
                .expect("first document")
                .branch_id,
            default_branch_id("first")
        );
        assert_eq!(
            store
                .load_cursor("second", "context-a")
                .expect("second cursor")
                .expect("second document")
                .head_id,
            second.head_id
        );
    }

    #[test]
    fn creating_branch_commits_current_work_without_moving_previous_head() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-branches");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        let before_edit = store
            .load_cursor("doc-branches", "context-a")
            .expect("cursor")
            .expect("document");
        let baseline = before_edit.head_id.clone().expect("initial commit");
        let edited = store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "edit-before-branch".into(),
                    document_id: initial.document_id.clone(),
                    context_id: "context-a".into(),
                    expected_revision: before_edit.revision,
                    expected_branch_id: before_edit.branch_id.clone(),
                    expected_head_id: before_edit.head_id,
                    payload: DomainCommand::SetDocumentTitle {
                        title: "分支中的内容".into(),
                    },
                },
            )
            .expect("edit");
        let branch = store
            .create_branch_from_current(&edited.cursor, "新方案")
            .expect("create branch");
        assert_eq!(branch.revision, "2");
        assert_ne!(branch.branch_id, before_edit.branch_id);
        assert_eq!(
            store
                .load_current("doc-branches", "context-a")
                .expect("current")
                .expect("document")
                .1
                .title,
            "分支中的内容"
        );
        let previous_head: String = store
            .connection
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1",
                [before_edit.branch_id],
                |row| row.get(0),
            )
            .expect("previous head");
        assert_eq!(previous_head, baseline);
        let parent: String = store
            .connection
            .query_row(
                "SELECT visible_parent_id FROM commit_links WHERE commit_id = ?1",
                [branch.head_id.as_ref().expect("new head")],
                |row| row.get(0),
            )
            .expect("new parent");
        assert_eq!(parent, baseline);
        assert!(matches!(
            store.create_branch_from_current(&edited.cursor, "stale"),
            Err(StorageError::Conflict(_))
        ));
        assert!(matches!(
            store.create_branch_from_current(&branch, "新方案"),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(store.commit_count("doc-branches").expect("count"), 2);
    }

    #[test]
    fn existing_document_without_baseline_keeps_a_returnable_main_branch() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("legacy-no-head");
        store
            .save_draft(&initial, "context-a", 0)
            .expect("existing draft");
        let before = store
            .load_cursor("legacy-no-head", "context-a")
            .expect("cursor")
            .expect("document");
        assert!(before.head_id.is_none());
        let branch = store
            .create_branch_from_current(&before, "new branch")
            .expect("create branch");
        let main_head: String = store
            .connection
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1",
                [before.branch_id],
                |row| row.get(0),
            )
            .expect("returnable main head");
        let parent: String = store
            .connection
            .query_row(
                "SELECT visible_parent_id FROM commit_links WHERE commit_id = ?1",
                [branch.head_id.as_ref().expect("new branch head")],
                |row| row.get(0),
            )
            .expect("branch parent");
        assert_eq!(parent, main_head);
        assert_eq!(store.commit_count("legacy-no-head").expect("count"), 2);
    }

    #[test]
    fn branch_switch_requires_confirmation_and_discards_only_uncommitted_work() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-switch");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        let main = store
            .load_cursor("doc-switch", "context-a")
            .expect("main cursor")
            .expect("document");
        let branch = store
            .create_branch_from_current(&main, "experiment")
            .expect("create branch");
        let edited = store
            .apply_command(
                "host-actor",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "edit-before-switch".into(),
                    document_id: initial.document_id.clone(),
                    context_id: "context-a".into(),
                    expected_revision: branch.revision,
                    expected_branch_id: branch.branch_id.clone(),
                    expected_head_id: branch.head_id,
                    payload: DomainCommand::SetDocumentTitle {
                        title: "未提交".into(),
                    },
                },
            )
            .expect("edit");
        assert!(matches!(
            store.switch_branch(&edited.cursor, &main.branch_id, false),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(
            store
                .load_current("doc-switch", "context-a")
                .expect("unchanged draft")
                .expect("document")
                .1
                .title,
            "未提交"
        );
        let switched = store
            .switch_branch(&edited.cursor, &main.branch_id, true)
            .expect("confirmed switch");
        assert_eq!(switched.revision, "3");
        assert_eq!(
            store
                .load_current("doc-switch", "context-a")
                .expect("main content")
                .expect("document")
                .1
                .title,
            initial.title
        );
        assert!(matches!(
            store.switch_branch(&edited.cursor, &branch.branch_id, true),
            Err(StorageError::Conflict(_))
        ));
        store
            .switch_branch(&switched, &branch.branch_id, false)
            .expect("return to branch");
        assert_eq!(
            store
                .load_current("doc-switch", "context-a")
                .expect("branch head")
                .expect("document")
                .1
                .title,
            initial.title
        );
    }

    #[test]
    fn committed_branch_content_survives_switch_round_trip() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-switch-committed");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        let main = store
            .load_cursor("doc-switch-committed", "context-a")
            .expect("main cursor")
            .expect("document");
        let branch = store
            .create_branch_from_current(&main, "experiment")
            .expect("create branch");
        let mut changed = initial.clone();
        changed.title = "已提交".into();
        store
            .save_draft(&changed, "context-a", 2)
            .expect("branch draft");
        commit(&mut store, "doc-switch-committed", "commit edit");
        let committed = store
            .load_cursor("doc-switch-committed", "context-a")
            .expect("committed cursor")
            .expect("document");
        assert_eq!(committed.branch_id, branch.branch_id);
        let back_to_main = store
            .switch_branch(&committed, &main.branch_id, false)
            .expect("switch to main");
        store
            .switch_branch(&back_to_main, &branch.branch_id, false)
            .expect("switch to committed branch");
        assert_eq!(
            store
                .load_current("doc-switch-committed", "context-a")
                .expect("committed content")
                .expect("document")
                .1
                .title,
            "已提交"
        );
    }

    #[test]
    fn switching_does_not_silently_erase_target_branch_draft() {
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-target-draft");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        let main = store
            .load_cursor("doc-target-draft", "context-a")
            .expect("main cursor")
            .expect("document");
        let branch = store
            .create_branch_from_current(&main, "experiment")
            .expect("branch");
        let on_main = store
            .switch_branch(&branch, &main.branch_id, false)
            .expect("main");
        let mut pending = initial.clone();
        pending.title = "目标分支未提交".into();
        let json = serde_json::to_string(&pending).expect("json");
        let hash = canonical_hash(&pending).expect("hash");
        store
            .connection
            .execute(
                "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
                 VALUES (?1, 'context-a', ?2, 2, ?3, ?4)",
                params![initial.document_id, branch.branch_id, json, hash],
            )
            .expect("dormant target draft");
        assert!(matches!(
            store.switch_branch(&on_main, &branch.branch_id, true),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(
            store
                .load_cursor("doc-target-draft", "context-a")
                .expect("cursor")
                .expect("document")
                .branch_id,
            main.branch_id
        );
        let remaining: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM drafts WHERE document_id = ?1 AND branch_id = ?2",
                params![initial.document_id, branch.branch_id],
                |row| row.get(0),
            )
            .expect("target draft remains");
        assert_eq!(remaining, 1);
    }

    #[test]
    fn loading_history_changes_only_draft_and_survives_restart() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        let path = std::env::temp_dir().join(format!(
            "zinecv-load-history-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let edit = |id: &str, title: &str, cursor: &AuthorityCursor| CommandEnvelope {
            protocol_version: 1,
            command_id: id.into(),
            document_id: cursor.document_id.clone(),
            context_id: cursor.context_id.clone(),
            expected_revision: cursor.revision.clone(),
            expected_branch_id: cursor.branch_id.clone(),
            expected_head_id: cursor.head_id.clone(),
            payload: DomainCommand::SetDocumentTitle {
                title: title.into(),
            },
        };
        let mut store = Store::open(&path).expect("file store");
        let initial = document("doc-history-load");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        let baseline = store
            .load_cursor("doc-history-load", "context-a")
            .expect("baseline cursor")
            .expect("document");
        let baseline_id = baseline.head_id.clone().expect("baseline head");
        let first_edit = store
            .apply_command("host-actor", edit("history-edit-1", "第二版", &baseline))
            .expect("first edit");
        let committed_cursor = commit(&mut store, "doc-history-load", "second");
        let committed_id = committed_cursor.head_id.clone().expect("second head");
        let committed = store
            .load_cursor("doc-history-load", "context-a")
            .expect("committed cursor")
            .expect("document");
        assert_eq!(committed.revision, "2");
        assert_eq!(first_edit.cursor.revision, "1");
        let dirty = store
            .apply_command("host-actor", edit("history-edit-2", "未提交", &committed))
            .expect("second edit");
        assert!(matches!(
            store.load_commit_into_draft(&dirty.cursor, &baseline_id, false),
            Err(StorageError::Validation(_))
        ));
        assert_eq!(
            store
                .load_current("doc-history-load", "context-a")
                .expect("still dirty")
                .expect("document")
                .1
                .title,
            "未提交"
        );
        let loaded = store
            .load_commit_into_draft(&dirty.cursor, &baseline_id, true)
            .expect("load baseline");
        assert_eq!(loaded.head_id, Some(committed_id.clone()));
        assert_eq!(loaded.revision, "4");
        assert!(matches!(
            store.load_commit_into_draft(&dirty.cursor, &baseline_id, true),
            Err(StorageError::Conflict(_))
        ));
        drop(store);

        let mut store = Store::open(&path).expect("reopen");
        assert_eq!(
            store
                .load_current("doc-history-load", "context-a")
                .expect("loaded draft")
                .expect("document")
                .1
                .title,
            initial.title
        );
        assert_eq!(
            store
                .load_cursor("doc-history-load", "context-a")
                .expect("cursor")
                .expect("document")
                .head_id,
            Some(committed_id.clone())
        );
        let next = commit(&mut store, "doc-history-load", "after loading history");
        let parent: String = store
            .connection
            .query_row(
                "SELECT visible_parent_id FROM commit_links WHERE commit_id = ?1",
                [next.head_id.expect("new head")],
                |row| row.get(0),
            )
            .expect("visible parent");
        assert_eq!(parent, committed_id);
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup test database");
            }
        }
    }

    #[test]
    fn history_from_another_document_cannot_replace_current_draft() {
        let mut store = Store::open_in_memory().expect("store");
        for document_id in ["first-history", "second-history"] {
            store
                .initialize_document(&document(document_id), "context-a")
                .expect("initialize");
        }
        let first = store
            .load_cursor("first-history", "context-a")
            .expect("first cursor")
            .expect("first document");
        let second = store
            .load_cursor("second-history", "context-a")
            .expect("second cursor")
            .expect("second document");
        assert!(matches!(
            store.load_commit_into_draft(
                &first,
                second.head_id.as_deref().expect("second head"),
                true
            ),
            Err(StorageError::NotFound(_))
        ));
        assert_eq!(
            store
                .load_cursor("first-history", "context-a")
                .expect("unchanged cursor")
                .expect("first document"),
            first
        );
    }

    #[test]
    fn legacy_main_branch_remains_usable_next_to_new_documents() {
        let mut store = Store::open_in_memory().expect("store");
        let legacy = document("legacy");
        let json = serde_json::to_string(&legacy).expect("json");
        let hash = canonical_hash(&legacy).expect("hash");
        store
            .connection
            .execute(
                "INSERT INTO documents(id, title, current_branch_id, active_context_id, revision)
                 VALUES (?1, ?2, 'main', 'context-a', 0)",
                params![legacy.document_id, legacy.title],
            )
            .expect("legacy document");
        store
            .connection
            .execute(
                "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
                 VALUES ('context-a', ?1, 'workspace', 'default')",
                params![legacy.document_id],
            )
            .expect("legacy context");
        store
            .connection
            .execute(
                "INSERT INTO branches(id, document_id, name) VALUES ('main', ?1, 'main')",
                params![legacy.document_id],
            )
            .expect("legacy branch");
        store
            .connection
            .execute(
                "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
                 VALUES (?1, 'context-a', 'main', 0, ?2, ?3)",
                params![legacy.document_id, json, hash],
            )
            .expect("legacy draft");

        store
            .save_draft(&legacy, "context-a", 1)
            .expect("legacy save");
        assert_eq!(
            store
                .load_cursor("legacy", "context-a")
                .expect("cursor")
                .expect("legacy document")
                .branch_id,
            "main"
        );
        commit(&mut store, "legacy", "legacy commit");
        store
            .save_draft(&document("new"), "context-a", 0)
            .expect("new document beside legacy");
        assert_eq!(store.commit_count("legacy").expect("legacy count"), 1);
        assert_eq!(
            store
                .load_current("new", "context-a")
                .expect("new current")
                .expect("new document")
                .1
                .document_id,
            "new"
        );
    }

    #[test]
    fn commands_persist_revision_draft_and_idempotent_receipt() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        fn command(id: &str, revision: u64, title: &str) -> CommandEnvelope {
            CommandEnvelope {
                protocol_version: 1,
                command_id: id.into(),
                document_id: "doc-commands".into(),
                context_id: "context-a".into(),
                expected_revision: revision.to_string(),
                expected_branch_id: default_branch_id("doc-commands"),
                expected_head_id: None,
                payload: DomainCommand::SetDocumentTitle {
                    title: title.into(),
                },
            }
        }

        let mut store = Store::open_in_memory().expect("store");
        store
            .save_draft(&document("doc-commands"), "context-a", 0)
            .expect("seed");
        let first = store
            .apply_command("host-actor", command("cmd-1", 0, "第一次"))
            .expect("apply");
        assert_eq!(first.cursor.revision, "1");
        assert_eq!(first.document.title, "第一次");

        let retry = store
            .apply_command("host-actor", command("cmd-1", 0, "第一次"))
            .expect("retry");
        assert_eq!(first, retry);
        assert_eq!(
            store
                .load_draft("doc-commands", "context-a")
                .expect("load")
                .expect("draft")
                .1
                .title,
            "第一次"
        );

        let reused = command("cmd-1", 0, "第二次");
        assert!(matches!(
            store.apply_command("host-actor", reused),
            Err(StorageError::Conflict(_))
        ));

        let second = store
            .apply_command("host-actor", command("cmd-2", 1, "第二次"))
            .expect("second");
        assert_eq!(second.cursor.revision, "2");
        assert_eq!(
            store
                .load_draft("doc-commands", "context-a")
                .expect("load")
                .expect("draft")
                .1
                .title,
            "第二次"
        );
    }

    #[test]
    fn rejects_corrupt_database_on_open() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-corrupt-open-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::write(&path, b"this is definitely not a SQLite database")
            .expect("seed corrupt file");
        let result = Store::open(&path);
        assert!(matches!(result, Err(StorageError::Corrupt(_))));
        std::fs::remove_file(&path).expect("cleanup corrupt database");
    }

    #[test]
    fn rejects_corrupt_backup_without_changing_current_state() {
        let backup_path = std::env::temp_dir().join(format!(
            "zinecv-corrupt-backup-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let mut store = Store::open_in_memory().expect("store");
        store
            .save_draft(&document("doc-corrupt-guard"), "context-a", 1)
            .expect("seed");
        store.backup_to(&backup_path).expect("valid backup");
        std::fs::write(&backup_path, b"corrupted backup bytes").expect("corrupt backup");

        assert!(matches!(
            store.restore_from(&backup_path),
            Err(StorageError::Corrupt(_))
        ));
        assert!(store
            .load_draft("doc-corrupt-guard", "context-a")
            .expect("load")
            .is_some());

        drop(store);
        std::fs::remove_file(&backup_path).expect("cleanup backup");
    }

    #[test]
    fn two_connections_enforce_cas_revision() {
        use crate::domain::{CommandEnvelope, DomainCommand};

        fn command(id: &str, revision: u64, title: &str) -> CommandEnvelope {
            CommandEnvelope {
                protocol_version: 1,
                command_id: id.into(),
                document_id: "doc-cas".into(),
                context_id: "context-a".into(),
                expected_revision: revision.to_string(),
                expected_branch_id: default_branch_id("doc-cas"),
                expected_head_id: None,
                payload: DomainCommand::SetDocumentTitle {
                    title: title.into(),
                },
            }
        }

        let path = std::env::temp_dir().join(format!(
            "zinecv-cas-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        {
            let mut first = Store::open(&path).expect("first store");
            let mut second = Store::open(&path).expect("second store");
            first
                .save_draft(&document("doc-cas"), "context-a", 0)
                .expect("seed");
            first
                .apply_command("host-actor", command("cmd-1", 0, "第一次"))
                .expect("first writer");

            assert!(matches!(
                second.apply_command("host-actor", command("cmd-2", 0, "过期写入")),
                Err(StorageError::Conflict(_))
            ));
            let second_result = second
                .apply_command("host-actor", command("cmd-2", 1, "第二次"))
                .expect("fresh writer");
            assert_eq!(second_result.cursor.revision, "2");
            drop(second);
            drop(first);
        }
        let reopened = Store::open(&path).expect("reopen after both writers closed");
        let (revision, persisted) = reopened
            .load_current("doc-cas", "context-a")
            .expect("read persisted document")
            .expect("persisted document");
        assert_eq!(revision, 2);
        assert_eq!(persisted.title, "第二次");
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn concurrent_connections_serialize_conflicts_and_duplicate_receipts() {
        use crate::domain::{CommandEnvelope, DomainCommand};
        use std::sync::{Arc, Barrier};

        let path = std::env::temp_dir().join(format!(
            "zinecv-race-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let store = Store::open(&path).expect("store");
        store
            .save_draft(&document("doc-race"), "context-a", 0)
            .expect("seed");
        drop(store);

        let run_pair = |ids: [&str; 2], revision: u64| {
            let barrier = Arc::new(Barrier::new(2));
            let handles = ids.map(|id| {
                let path = path.clone();
                let barrier = Arc::clone(&barrier);
                let id = id.to_string();
                std::thread::spawn(move || {
                    let mut store = Store::open(&path).expect("parallel store");
                    barrier.wait();
                    store
                        .apply_command(
                            "host-actor",
                            CommandEnvelope {
                                protocol_version: 1,
                                command_id: id,
                                document_id: "doc-race".into(),
                                context_id: "context-a".into(),
                                expected_revision: revision.to_string(),
                                expected_branch_id: default_branch_id("doc-race"),
                                expected_head_id: None,
                                payload: DomainCommand::SetDocumentTitle {
                                    title: "并发标题".into(),
                                },
                            },
                        )
                        .map(|result| result.cursor.revision)
                        .map_err(|error| format!("{error:?}"))
                })
            });
            handles.map(|handle| handle.join().expect("writer thread"))
        };

        let distinct = run_pair(["cmd-a", "cmd-b"], 0);
        assert_eq!(distinct.iter().filter(|result| result.is_ok()).count(), 1);
        let repeated = run_pair(["cmd-repeat", "cmd-repeat"], 1);
        assert_eq!(repeated, [Ok("2".into()), Ok("2".into())]);
        let reopened = Store::open(&path).expect("reopen");
        assert_eq!(
            reopened
                .load_cursor("doc-race", "context-a")
                .expect("cursor")
                .expect("document")
                .revision,
            "2"
        );
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn backup_and_restore_returns_to_exact_prior_state() {
        let backup_path = std::env::temp_dir().join(format!(
            "zinecv-backup-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let mut store = Store::open_in_memory().expect("store");
        store
            .save_draft(&document("doc-backup"), "context-a", 1)
            .expect("initial draft");
        store.backup_to(&backup_path).expect("backup");

        store
            .save_draft(&document("doc-after-backup"), "context-a", 1)
            .expect("new draft");
        assert!(store
            .load_draft("doc-after-backup", "context-a")
            .expect("load")
            .is_some());

        store.restore_from(&backup_path).expect("restore");
        assert_eq!(
            store.migration_versions().expect("versions"),
            vec![1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert!(store
            .load_draft("doc-backup", "context-a")
            .expect("load")
            .is_some());
        assert!(store
            .load_draft("doc-after-backup", "context-a")
            .expect("load")
            .is_none());

        drop(store);
        std::fs::remove_file(&backup_path).expect("cleanup backup");
    }

    #[test]
    fn backup_stages_a_complete_file_and_never_overwrites_existing_target() {
        let directory = std::env::temp_dir().join(format!(
            "zinecv-backup-staging-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::create_dir(&directory).expect("test directory");
        let first_path = directory.join("first.db");
        let second_path = directory.join("second.db");
        let mut store = Store::open_in_memory().expect("store");
        let initial = document("doc-staged-backup");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");
        store.backup_to(&first_path).expect("first backup");
        let first_bytes = std::fs::read(&first_path).expect("first bytes");
        let cursor = store
            .load_cursor(&initial.document_id, "context-a")
            .expect("cursor")
            .expect("document");
        edit_title(&mut store, &cursor, "backup-edit", "新标题");
        assert!(matches!(
            store.backup_to(&first_path),
            Err(StorageError::Validation(_))
        ));
        assert_eq!(
            std::fs::read(&first_path).expect("unchanged bytes"),
            first_bytes
        );
        store.backup_to(&second_path).expect("new backup");
        for (path, expected_title) in [(&first_path, "测试"), (&second_path, "新标题")] {
            let backup = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("open backup read-only");
            assert_eq!(
                backup
                    .query_row(
                        "SELECT title FROM documents WHERE id = ?1",
                        params![initial.document_id],
                        |row| row.get::<_, String>(0),
                    )
                    .expect("backed up document"),
                expected_title
            );
        }
        let paths = std::fs::read_dir(&directory)
            .expect("backup directory")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 2, "no partial backup should remain");
        std::fs::remove_file(first_path).expect("cleanup first backup");
        std::fs::remove_file(second_path).expect("cleanup second backup");
        std::fs::remove_dir(directory).expect("cleanup directory");
    }

    #[test]
    fn backup_during_another_connections_write_has_one_consistent_state() {
        use std::sync::{Arc, Barrier};

        let directory = std::env::temp_dir().join(format!(
            "zinecv-backup-concurrent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::create_dir(&directory).expect("test directory");
        let source_path = directory.join("source.db");
        let backup_path = directory.join("backup.db");
        let mut store = Store::open(&source_path).expect("source store");
        let initial = document("doc-concurrent-backup");
        store
            .initialize_document(&initial, "context-a")
            .expect("initialize");

        let barrier = Arc::new(Barrier::new(2));
        let writer_barrier = Arc::clone(&barrier);
        let writer_path = source_path.clone();
        let writer = std::thread::spawn(move || {
            let connection = Connection::open(writer_path).expect("writer connection");
            connection.execute_batch(
                "PRAGMA journal_mode=WAL;
                 BEGIN IMMEDIATE;
                 UPDATE documents SET title = '并发更新' WHERE id = 'doc-concurrent-backup';
                 INSERT INTO resources(hash, mime, bytes, size) VALUES
                   ('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', 'text/plain', x'61', 1);",
            ).expect("writer transaction");
            writer_barrier.wait();
            std::thread::sleep(std::time::Duration::from_millis(150));
            connection.execute_batch("COMMIT").expect("writer commit");
        });
        barrier.wait();
        store.backup_to(&backup_path).expect("concurrent backup");
        writer.join().expect("writer finished");
        let backup = Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open backup");
        Store::integrity_check(&backup).expect("backup integrity");
        let title: String = backup
            .query_row(
                "SELECT title FROM documents WHERE id = 'doc-concurrent-backup'",
                [],
                |row| row.get(0),
            )
            .expect("backup title");
        let resources: i64 = backup
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))
            .expect("backup resources");
        assert!(
            (title == "测试" && resources == 0) || (title == "并发更新" && resources == 1),
            "backup mixed two transaction states: {title}, {resources} resources"
        );
        drop(backup);
        drop(store);
        for entry in std::fs::read_dir(&directory).expect("test directory") {
            std::fs::remove_file(entry.expect("entry").path()).expect("cleanup file");
        }
        std::fs::remove_dir(directory).expect("cleanup directory");
    }

    #[test]
    fn restores_v1_backup_after_migrating_staging_copy() {
        let backup_path = std::env::temp_dir().join(format!(
            "zinecv-v1-backup-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let source = Store::open_in_memory().expect("source");
        source
            .save_draft(&document("v1-document"), "context-a", 1)
            .expect("source draft");
        source
            .connection
            .execute_batch(
                "DROP TABLE branch_tombstones; DELETE FROM schema_migrations WHERE version = 2",
            )
            .expect("create v1 fixture");
        source.backup_to(&backup_path).expect("v1 backup");
        let before = std::fs::read(&backup_path).expect("backup bytes");

        let mut current = Store::open_in_memory().expect("current");
        current
            .save_draft(&document("current-document"), "context-a", 1)
            .expect("current draft");
        current.restore_from(&backup_path).expect("restore v1");
        assert_eq!(
            current.migration_versions().expect("migrations"),
            vec![1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert!(current
            .load_draft("v1-document", "context-a")
            .expect("v1 draft")
            .is_some());
        assert!(current
            .load_draft("current-document", "context-a")
            .expect("old draft")
            .is_none());
        assert_eq!(
            std::fs::read(&backup_path).expect("backup unchanged"),
            before
        );
        drop(current);
        drop(source);
        std::fs::remove_file(&backup_path).expect("cleanup backup");
    }

    #[test]
    fn newer_schema_is_rejected_without_changing_database_or_current_store() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-future-schema-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        {
            let connection = Connection::open(&path).expect("future database");
            connection
                .execute_batch(
                    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL);
                     INSERT INTO schema_migrations(version, checksum) VALUES (9, 'future');
                     CREATE TABLE future_data(value TEXT NOT NULL);
                     INSERT INTO future_data(value) VALUES ('preserve me');",
                )
                .expect("future schema");
        }
        let before = std::fs::read(&path).expect("database bytes before");
        assert!(matches!(
            Store::open(&path),
            Err(StorageError::UnsupportedSchema(9))
        ));
        assert_eq!(std::fs::read(&path).expect("database bytes after"), before);

        let mut current = Store::open_in_memory().expect("current store");
        current
            .save_draft(&document("current"), "context-a", 1)
            .expect("current draft");
        assert!(matches!(
            current.restore_from(&path),
            Err(StorageError::UnsupportedSchema(9))
        ));
        assert!(current
            .load_draft("current", "context-a")
            .expect("current draft remains")
            .is_some());
        assert_eq!(std::fs::read(&path).expect("backup bytes after"), before);
        drop(current);
        std::fs::remove_file(path).expect("cleanup future database");
    }

    #[test]
    fn missing_or_unrelated_backup_cannot_replace_current_draft() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-missing-backup-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let mut store = Store::open_in_memory().expect("store");
        store
            .save_draft(&document("current"), "context-a", 1)
            .expect("current draft");
        assert!(store.restore_from(&path).is_err());
        assert!(!path.exists());

        {
            let unrelated = Connection::open(&path).expect("unrelated database");
            unrelated
                .execute("CREATE TABLE unrelated(value TEXT)", [])
                .expect("unrelated schema");
        }
        assert!(matches!(
            store.restore_from(&path),
            Err(StorageError::Corrupt(_))
        ));
        {
            let unrelated = Connection::open(&path).expect("unrelated database");
            unrelated
                .execute(
                    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)",
                    [],
                )
                .expect("empty migration table");
        }
        assert!(matches!(
            store.restore_from(&path),
            Err(StorageError::Corrupt(_))
        ));
        {
            let unrelated = Connection::open(&path).expect("unrelated database");
            let checksum = format!("{:x}", Sha256::digest(MIGRATIONS[0].1.as_bytes()));
            unrelated
                .execute(
                    "INSERT INTO schema_migrations(version, checksum) VALUES (1, ?1)",
                    [checksum],
                )
                .expect("migration record without required tables");
        }
        assert!(matches!(
            store.restore_from(&path),
            Err(StorageError::Corrupt(_))
        ));
        assert!(store
            .load_draft("current", "context-a")
            .expect("current draft")
            .is_some());
        drop(store);
        std::fs::remove_file(path).expect("cleanup unrelated database");
    }

    #[test]
    fn changed_migration_checksum_is_rejected() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-checksum-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        {
            let store = Store::open(&path).expect("current database");
            store
                .connection
                .execute(
                    "UPDATE schema_migrations SET checksum = 'altered' WHERE version = 1",
                    [],
                )
                .expect("alter checksum");
        }
        assert!(matches!(Store::open(&path), Err(StorageError::Corrupt(_))));
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn avatar_assets_survive_gc_while_linked_and_are_collected_after_unlink() {
        use sha2::{Digest, Sha256};
        let store = Store::open_in_memory().expect("store");
        let bytes = b"avatar-bytes".as_slice();
        let hash = format!("{:x}", Sha256::digest(bytes));
        store
            .put_resource(&hash, "image/png", bytes, None)
            .expect("store avatar bytes");
        // 未建立引用前属于可回收资源。
        assert_eq!(store.collect_unreferenced_resources().expect("gc"), 1);
        store
            .put_resource(&hash, "image/png", bytes, None)
            .expect("store avatar bytes again");
        store
            .set_document_avatar("doc-1", Some(&hash))
            .expect("link avatar");
        // 被 document-avatar 引用后 GC 必须保留；读取返回原始字节。
        assert_eq!(store.collect_unreferenced_resources().expect("gc"), 0);
        let (mime, bytes) = store
            .read_resource_bytes(&hash)
            .expect("read avatar")
            .expect("avatar present");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"avatar-bytes");
        // 换头像/清除后解除引用，再次 GC 回收旧资产。
        store.set_document_avatar("doc-1", None).expect("unlink");
        assert_eq!(store.collect_unreferenced_resources().expect("gc"), 1);
        assert!(store
            .read_resource_bytes(&hash)
            .expect("read after gc")
            .is_none());
    }

    #[test]
    fn settings_round_trip_and_delete_survive_reopen() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-settings-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        {
            let store = Store::open(&path).expect("file store");
            assert_eq!(store.read_setting("pane-width").expect("read"), None);
            store
                .write_setting("pane-width", Some("420"))
                .expect("write setting");
            store
                .write_setting("pane-width", Some("512"))
                .expect("overwrite setting");
            assert_eq!(
                store.read_setting("pane-width").expect("read"),
                Some("512".into())
            );
            store
                .write_setting("empty-value", Some(""))
                .expect("empty value is allowed");
        }
        {
            let store = Store::open(&path).expect("reopen store");
            assert_eq!(
                store.read_setting("pane-width").expect("read"),
                Some("512".into())
            );
            store.write_setting("pane-width", None).expect("delete");
            assert_eq!(store.read_setting("pane-width").expect("read"), None);
            assert_eq!(
                store.read_setting("empty-value").expect("read"),
                Some("".into())
            );
        }
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn imported_template_catalog_exceeding_setting_limit_survives_reopen() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-templates-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let preview = "a".repeat(5 * 1024 * 1024);
        let payload = serde_json::json!([{"id":"template-a","previewDataUrl":preview}]).to_string();
        {
            let mut store = Store::open(&path).expect("file store");
            assert_eq!(store.read_imported_template_catalog().expect("read"), None);
            store
                .write_imported_template_catalog(&payload, 0)
                .expect("write");
        }
        {
            let mut store = Store::open(&path).expect("reopen");
            assert_eq!(
                store.read_imported_template_catalog().expect("read"),
                Some(ImportedTemplateCatalog {
                    revision: 1,
                    payload_json: payload.clone()
                })
            );
            assert!(matches!(
                store.write_imported_template_catalog("{}", 1),
                Err(StorageError::Validation(_))
            ));
            assert!(matches!(
                store.write_imported_template_catalog("[]", 0),
                Err(StorageError::Conflict(_))
            ));
            assert_eq!(
                store
                    .read_imported_template_catalog()
                    .expect("read")
                    .unwrap()
                    .payload_json,
                payload
            );
        }
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn template_activity_migrates_once_and_updates_atomically() {
        let mut store = Store::open_in_memory().expect("store");
        let rows = store
            .bootstrap_template_activity(r#"{"template-a":{"favorite":true,"lastUsedAt":123}}"#)
            .expect("migrate");
        assert_eq!(
            rows,
            vec![TemplateActivity {
                template_id: "template-a".into(),
                favorite: true,
                last_used_at: Some(123),
            }]
        );
        let updated = store
            .update_template_activity("template-a", "favorite")
            .expect("toggle")
            .unwrap();
        assert!(!updated.favorite);
        assert_eq!(updated.last_used_at, Some(123));
        let used = store
            .update_template_activity("template-a", "use")
            .expect("use")
            .unwrap();
        assert!(used.last_used_at.unwrap() > 123);
        assert_eq!(
            store
                .bootstrap_template_activity(r#"{"template-b":{"favorite":true}}"#)
                .expect("repeat"),
            vec![used]
        );
        assert_eq!(
            store
                .update_template_activity("template-a", "remove")
                .expect("remove"),
            None
        );
        assert!(store.list_template_activity().expect("list").is_empty());
        assert!(matches!(
            store.update_template_activity("", "use"),
            Err(StorageError::Validation(_))
        ));
    }

    #[test]
    fn agent_sessions_are_account_scoped_durable_and_cas_protected() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-agent-sessions-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let alice_id;
        let bob_id;
        let alice_payload = serde_json::json!({
            "activeId":"alice-session",
            "sessions":[{"id":"alice-session","title":"Alice","createdAt":1,"updatedAt":2,
                "messages":[{"id":"alice-message","role":"user","text":"private Alice","sourceView":"editor","sourceRefs":["basic:name"]}]},
                {"id":"alice-second","title":"Second","createdAt":1,"updatedAt":3,"messages":[]}]
        }).to_string();
        let bob_payload = serde_json::json!({
            "activeId":"bob-session",
            "sessions":[{"id":"bob-session","title":"Bob","createdAt":1,"updatedAt":1,"messages":[]}]
        }).to_string();
        {
            let mut store = Store::open(&path).expect("open");
            alice_id = store
                .register_account("alice@example.com", "fixture-pass-1")
                .expect("alice")
                .id;
            bob_id = store
                .register_account("bob@example.com", "fixture-pass-2")
                .expect("bob")
                .id;
            assert_eq!(
                store
                    .bootstrap_agent_sessions(&alice_id, &alice_payload)
                    .expect("import")
                    .revision,
                1
            );
            assert_eq!(
                store
                    .bootstrap_agent_sessions(&bob_id, &bob_payload)
                    .expect("import")
                    .revision,
                1
            );
            assert!(matches!(
                store.replace_agent_sessions(&alice_id, 0, &bob_payload),
                Err(StorageError::Conflict(_))
            ));
            let mut updated: StoredAgentSessionStore =
                serde_json::from_str(&alice_payload).expect("payload");
            updated.sessions[0].title = "Alice updated".into();
            assert_eq!(
                store
                    .replace_agent_sessions(
                        &alice_id,
                        1,
                        &serde_json::to_string(&updated).expect("json")
                    )
                    .expect("replace"),
                2
            );
        }
        {
            let mut store = Store::open(&path).expect("reopen");
            let alice = store
                .bootstrap_agent_sessions(&alice_id, &bob_payload)
                .expect("alice existing");
            let bob = store
                .bootstrap_agent_sessions(&bob_id, &alice_payload)
                .expect("bob existing");
            assert_eq!(alice.revision, 2);
            assert_eq!(alice.store.sessions[0].title, "Alice updated");
            assert_eq!(alice.store.sessions[1].id, "alice-second");
            assert_eq!(alice.store.sessions[0].messages[0].text, "private Alice");
            assert_eq!(bob.store.sessions[0].id, "bob-session");
            assert!(bob.store.sessions[0].messages.is_empty());
        }
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn opens_real_file_database_with_migrations() {
        let path = std::env::temp_dir().join(format!(
            "zinecv-store-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        {
            let store = Store::open(&path).expect("file store");
            assert_eq!(
                store.migration_versions().expect("versions"),
                vec![1, 2, 3, 4, 5, 6, 7, 8]
            );
            store
                .save_draft(&document("doc-file"), "context-file", 3)
                .expect("save");
            assert!(store
                .load_draft("doc-file", "context-file")
                .expect("load")
                .is_some());
        }
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup database");
            }
        }
    }

    #[test]
    fn draft_only_resource_survives_gc_until_unreferenced() {
        let store = Store::open_in_memory().expect("store");
        let bytes = b"fake-avatar-bytes";
        let hash = format!("{:x}", Sha256::digest(bytes));
        store
            .put_resource(&hash, "image/png", bytes, Some("fixture-license"))
            .expect("put");
        store
            .link_resource(&hash, "draft", "doc-store/context-a")
            .expect("link");
        assert_eq!(store.collect_unreferenced_resources().expect("gc"), 0);
        assert_eq!(store.resource_count().expect("count"), 1);
        store
            .unlink_resource(&hash, "draft", "doc-store/context-a")
            .expect("unlink");
        assert_eq!(store.collect_unreferenced_resources().expect("gc"), 1);
        assert_eq!(store.resource_count().expect("count"), 0);
    }
}

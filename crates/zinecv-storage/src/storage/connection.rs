use super::*;

impl Store {
    /// Inject platform protection without changing the persisted ciphertext format.
    pub fn with_secret_provider(
        mut self,
        provider: std::sync::Arc<dyn zinecv_contracts::capability::SecretProvider>,
    ) -> Self {
        self.secrets = Some(provider);
        self
    }

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

    pub(super) fn is_transient_open_contention(path: &Path, error: &StorageError) -> bool {
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

    pub(super) fn open_once(path: &Path) -> StorageResult<Self> {
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

    /// A host-owned VFS provides the connection and a fresh backup destination.
    /// Schema checks, verified pre-upgrade snapshots and migrations stay here.
    pub fn from_platform_connection(
        connection: Connection,
        pre_upgrade_backup: Option<&mut Connection>,
    ) -> StorageResult<Self> {
        Self::integrity_check(&connection)?;
        let has_schema = Self::check_schema_compatibility(&connection)?;
        if !has_schema {
            let has_tables: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
                [], |row| row.get(0),
            )?;
            if has_tables {
                return Err(StorageError::Corrupt(
                    "Existing database has tables but no ZineCV migration records".into(),
                ));
            }
        } else {
            Self::validate_connection(&connection)?;
            if !Self::needs_upgrade(&connection)? {
                return Self::prepare(connection);
            }
            let destination = pre_upgrade_backup.ok_or_else(|| {
                StorageError::Validation(
                    "Platform database upgrade requires a verified backup destination".into(),
                )
            })?;
            Self::require_empty_snapshot(destination)?;
            Self::copy_database(&connection, destination)?;
            Self::validate_connection(destination)?;
        }
        Self::prepare(connection)
    }
}

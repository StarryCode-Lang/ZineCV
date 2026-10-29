use super::*;

impl Store {
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
        let mut staged_store = Self::prepare(staging)?;
        Self::validate_connection(&staged_store.connection)?;
        staged_store.invalidate_restored_authority(self.maximum_document_revision()?)?;
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
                crate::identity::unavailable_secret_count_from(&snapshot, |blob| {
                    self.unprotect_secret(blob)
                })?;
            let database_sha256 = format!("{:x}", Sha256::digest(&database));
            Ok(DatabaseBackupPayload {
                format: "zinecv-sqlite-full-backup".into(),
                format_version: 1,
                created_at: crate::clock::SystemTime::now()
                    .duration_since(crate::clock::UNIX_EPOCH)
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
        let (staged_store, schema_version, unavailable_secret_count) =
            self.stage_database_backup(payload)?;
        self.backup_to(pre_restore_backup_path)?;
        self.publish_candidate(&staged_store.connection)?;
        Ok((schema_version, unavailable_secret_count))
    }

    /// Same Backup JSON validation/publication with a host-provided SQLite
    /// snapshot destination instead of native filesystem operations.
    pub fn restore_database_backup_with_snapshot(
        &mut self,
        payload: &DatabaseBackupPayload,
        snapshot: &mut Connection,
    ) -> StorageResult<(u32, u32)> {
        let (staged_store, schema_version, unavailable_secret_count) =
            self.stage_database_backup(payload)?;
        self.backup_into(snapshot)?;
        self.publish_candidate(&staged_store.connection)?;
        Ok((schema_version, unavailable_secret_count))
    }

    pub(super) fn require_empty_snapshot(destination: &Connection) -> StorageResult<()> {
        let occupied: bool = destination.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )?;
        if occupied {
            return Err(StorageError::Validation(
                "Backup target already contains data".into(),
            ));
        }
        Ok(())
    }

    pub fn backup_into(&self, destination: &mut Connection) -> StorageResult<()> {
        Self::require_empty_snapshot(destination)?;
        Self::copy_database(&self.connection, destination)?;
        Self::validate_connection(destination)
    }

    /// Validated preflight for an asynchronous platform secret capability.
    /// The live database remains untouched until the normal restore path runs.
    pub fn backup_secret_blobs(
        &self,
        payload: &DatabaseBackupPayload,
    ) -> StorageResult<Vec<Vec<u8>>> {
        let (staged, _, _) = self.stage_database_backup(payload)?;
        let mut statement = staged
            .connection
            .prepare("SELECT encrypted_blob FROM secrets")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<Vec<u8>>, _>>()?)
    }
}

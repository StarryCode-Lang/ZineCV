use super::*;

impl Store {
    pub(super) fn stage_database_backup(
        &self,
        payload: &DatabaseBackupPayload,
    ) -> StorageResult<(Self, u32, u32)> {
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
        let mut staged_store = Self::prepare(candidate)?;
        staged_store.secrets = self.secrets.clone();
        Self::validate_connection(&staged_store.connection)?;
        Self::validate_restorable_database(&staged_store.connection)?;
        let schema_version = u32::try_from(Self::schema_version(&staged_store.connection)?)
            .map_err(|_| StorageError::Corrupt("Database schema version is out of range".into()))?;
        let unavailable_secret_count = u32::try_from(staged_store.unavailable_secret_count()?)
            .map_err(|_| {
                StorageError::Validation("Unavailable secret count is out of range".into())
            })?;

        Ok((staged_store, schema_version, unavailable_secret_count))
    }

    pub(super) fn publish_candidate(&mut self, candidate: &Connection) -> StorageResult<()> {
        let mut rollback = Connection::open_in_memory()?;
        Self::copy_database(&self.connection, &mut rollback)?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("RESTORE", "before-commit")?;
        let publish_result = (|| -> StorageResult<()> {
            Self::copy_database(candidate, &mut self.connection)?;
            #[cfg(feature = "test-hooks")]
            publication_test_hook("RESTORE", "after-commit")?;
            self.connection.pragma_update(None, "foreign_keys", "ON")?;
            self.connection
                .pragma_update(None, "journal_mode", JOURNAL_MODE)?;
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

    pub(super) fn validate_restorable_database(connection: &Connection) -> StorageResult<()> {
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

    pub(super) fn schema_version(connection: &Connection) -> StorageResult<i64> {
        Ok(
            connection.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })?,
        )
    }

    pub(super) fn integrity_check(connection: &Connection) -> StorageResult<()> {
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

    pub(super) fn validate_connection(connection: &Connection) -> StorageResult<()> {
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
}

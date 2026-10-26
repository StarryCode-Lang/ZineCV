use super::*;

impl Store {
    pub(super) fn needs_upgrade(connection: &Connection) -> StorageResult<bool> {
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

    pub(super) fn unique_database_path(
        path: &Path,
        label: &str,
    ) -> StorageResult<std::path::PathBuf> {
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

    pub(super) fn migration_diagnostic_path(backup_path: &Path) -> std::path::PathBuf {
        let backup_name = backup_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        backup_path.with_file_name(format!("{backup_name}.upgrade-diagnostic.txt"))
    }

    pub(super) fn write_verified_backup(source: &Connection, path: &Path) -> StorageResult<()> {
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

    pub(super) fn copy_database(
        source: &Connection,
        destination: &mut Connection,
    ) -> StorageResult<()> {
        let backup = Backup::new(source, destination)?;
        loop {
            match backup.step(128)? {
                StepResult::Done => break,
                _ => continue,
            }
        }
        Ok(())
    }

    pub(super) fn prepare(connection: Connection) -> StorageResult<Self> {
        Self::integrity_check(&connection)?;
        Self::check_schema_compatibility(&connection)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", JOURNAL_MODE)?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "busy_timeout", 5000)?;
        connection.pragma_update(None, "temp_store", "MEMORY")?;
        let mut store = Self {
            connection,
            secrets: None,
        };
        store.migrate()?;
        store.recover_interrupted_agent_runs()?;
        Self::validate_connection(&store.connection)?;
        Ok(store)
    }

    pub(super) fn check_schema_compatibility(connection: &Connection) -> StorageResult<bool> {
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

    pub(super) fn migrate(&mut self) -> StorageResult<()> {
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
}

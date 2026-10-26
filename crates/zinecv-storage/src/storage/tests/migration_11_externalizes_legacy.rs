use super::*;

#[test]
fn migration_11_externalizes_legacy_catalog_assets_without_changing_old_checksums() {
    let path = std::env::temp_dir().join(format!(
        "zinecv-r05-migration-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let bytes = b"legacy-preview-to-migrate";
    let hash = format!("{:x}", Sha256::digest(bytes));
    let old_payload = serde_json::to_string(&vec![imported_template_with_preview(
        "template-legacy-v10",
        &synthetic_preview_data_url(bytes),
    )])
    .expect("legacy catalog");
    let old_checksums = {
        let connection = Connection::open(&path).expect("legacy database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   checksum TEXT NOT NULL,
                   applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .expect("migration records table");
        for (version, sql) in MIGRATIONS.iter().take(10) {
            connection
                .execute_batch(sql)
                .expect("apply legacy migration");
            let checksum = format!("{:x}", Sha256::digest(sql.as_bytes()));
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, checksum) VALUES (?1, ?2)",
                    params![version, checksum],
                )
                .expect("record legacy migration");
        }
        connection
            .execute(
                "INSERT INTO imported_template_catalog(id, payload_json, revision)
                 VALUES (1, ?1, 17)",
                [&old_payload],
            )
            .expect("legacy template catalog");
        let mut statement = connection
            .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
            .expect("old checksums");
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .expect("old checksum rows");
        rows.collect::<Result<Vec<_>, _>>()
            .expect("old checksum values")
    };
    {
        let store = Store::open(&path).expect("migrate legacy database");
        assert_eq!(
            store.migration_versions().expect("versions"),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
        );
        let catalog = store
            .read_imported_template_catalog()
            .expect("catalog read")
            .expect("catalog");
        assert_eq!(catalog.revision, 17);
        let migrated: serde_json::Value =
            serde_json::from_str(&catalog.payload_json).expect("migrated JSON");
        assert!(!migrated[0]
            .as_object()
            .unwrap()
            .contains_key("previewDataUrl"));
        assert_eq!(migrated[0]["previewAssetId"], hash);
        assert!(store
            .read_resource_bytes(&hash)
            .expect("preview resource")
            .is_some());
        let checksums = {
            let mut statement = store
                .connection
                .prepare("SELECT version, checksum FROM schema_migrations WHERE version <= 10 ORDER BY version")
                .expect("checksums after migration");
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .expect("checksum rows after migration");
            rows.collect::<Result<Vec<_>, _>>()
                .expect("checksum values after migration")
        };
        assert_eq!(checksums, old_checksums);
    }
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if candidate.exists() {
            std::fs::remove_file(candidate).expect("cleanup legacy database");
        }
    }
    let backup_prefix = format!(
        "{}.pre-upgrade-",
        path.file_name().expect("legacy filename").to_string_lossy()
    );
    for entry in std::fs::read_dir(std::env::temp_dir()).expect("temp directory") {
        let entry = entry.expect("temp entry");
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(&backup_prefix)
        {
            std::fs::remove_file(entry.path()).expect("cleanup verified pre-upgrade backup");
        }
    }
}

#[test]
fn open_upgrades_supported_schema_from_verified_backup_and_rolls_back_failed_upgrade() {
    fn make_v10_database(path: &std::path::Path, invalid_catalog: bool) {
        let connection = Connection::open(path).expect("v10 database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                   version INTEGER PRIMARY KEY,
                   checksum TEXT NOT NULL,
                   applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .expect("migration records");
        for (version, sql) in MIGRATIONS.iter().take(10) {
            connection.execute_batch(sql).expect("apply v10 migration");
            let checksum = format!("{:x}", Sha256::digest(sql.as_bytes()));
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, checksum) VALUES (?1, ?2)",
                    params![version, checksum],
                )
                .expect("record v10 migration");
        }
        if invalid_catalog {
            connection
                .execute(
                    "INSERT INTO imported_template_catalog(id, payload_json, revision)
                     VALUES (1, '{invalid json', 4)",
                    [],
                )
                .expect("insert migration failure fixture");
        }
    }

    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let success_path = std::env::temp_dir().join(format!(
        "zinecv-r06-v10-success-{}-{suffix}.db",
        std::process::id()
    ));
    make_v10_database(&success_path, false);
    {
        let store = Store::open(&success_path).expect("supported v10 database upgrades");
        assert_eq!(
            store.migration_versions().expect("versions").last(),
            Some(&17)
        );
    }
    let success_backup_prefix = format!(
        "{}.pre-upgrade-",
        success_path
            .file_name()
            .expect("filename")
            .to_string_lossy()
    );
    let success_backups: Vec<_> = std::fs::read_dir(std::env::temp_dir())
        .expect("temp directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&success_backup_prefix)
        })
        .collect();
    assert_eq!(
        success_backups.len(),
        1,
        "verified pre-upgrade backup is retained"
    );
    let backup =
        Connection::open_with_flags(success_backups[0].path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("pre-upgrade backup opens");
    Store::validate_connection(&backup).expect("pre-upgrade backup validates");
    assert_eq!(Store::schema_version(&backup).expect("old schema"), 10);
    drop(backup);

    let failed_path = std::env::temp_dir().join(format!(
        "zinecv-r06-v10-failure-{}-{suffix}.db",
        std::process::id()
    ));
    make_v10_database(&failed_path, true);
    let failure = match Store::open(&failed_path) {
        Err(error) => error,
        Ok(_) => panic!("invalid backfill must abort startup upgrade"),
    };
    let failure_detail = format!("{failure:?}");
    assert!(failure_detail.contains("pre-upgrade-"));
    assert!(failure_detail.contains("upgrade-diagnostic.txt"));
    let original = Connection::open_with_flags(&failed_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("original database remains readable");
    Store::integrity_check(&original).expect("original database integrity");
    assert_eq!(
        Store::schema_version(&original).expect("original schema"),
        10
    );
    let payload: String = original
        .query_row(
            "SELECT payload_json FROM imported_template_catalog WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("original invalid payload remains intact");
    assert_eq!(payload, "{invalid json");
    drop(original);

    for path in [&success_path, &failed_path] {
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
            if candidate.exists() {
                std::fs::remove_file(candidate).expect("cleanup migration fixture");
            }
        }
    }
    for entry in std::fs::read_dir(std::env::temp_dir()).expect("temp directory") {
        let entry = entry.expect("temp entry");
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if [&success_path, &failed_path].iter().any(|path| {
            let own_name = path.file_name().unwrap().to_string_lossy();
            file_name.starts_with(own_name.as_ref())
        }) {
            std::fs::remove_file(entry.path()).expect("cleanup upgrade backup and diagnostic");
        }
    }
}

#[test]
fn full_database_backup_restores_complete_durable_draft_and_keeps_pre_restore_copy() {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let pre_restore = std::env::temp_dir().join(format!(
        "zinecv-r06-pre-restore-{}-{suffix}.db",
        std::process::id()
    ));
    let source_document = document("doc-full-backup-source");
    let mut source = Store::open_in_memory().expect("source store");
    source
        .initialize_document(&source_document, "context-a")
        .expect("initialize source");
    let cursor = source
        .load_cursor(&source_document.document_id, "context-a")
        .expect("cursor")
        .expect("active cursor");
    edit_title(&mut source, &cursor, "full-backup-edit", "源数据库草稿");
    source
        .connection
        .execute_batch(
            "INSERT INTO accounts(id, email, salt, password_hash)
               VALUES ('account-synthetic', 'backup@example.invalid', 'salt', 'hash');
             INSERT INTO provider_profiles(account_id, connection_id, name, base_url, model, capability)
               VALUES ('account-synthetic', 'provider-synthetic', 'Synthetic provider',
                       'https://example.invalid', 'model-synthetic', 'chat-only');
             INSERT INTO secrets(secret_id, account_id, provider_id, encrypted_blob)
               VALUES ('secret-synthetic', 'account-synthetic', 'provider-synthetic', x'010203');",
        )
        .expect("seed synthetic provider secret");
    let payload = source
        .export_database_backup()
        .expect("export full database");
    assert_eq!(payload.format, "zinecv-sqlite-full-backup");
    assert_eq!(payload.format_version, 1);
    assert_eq!(payload.schema_version, 17);

    let target_document = document("doc-full-backup-target");
    let mut target = Store::open_in_memory().expect("target store");
    target
        .initialize_document(&target_document, "context-a")
        .expect("initialize target");
    let (restored_schema, unreadable) = target
        .restore_database_backup(&payload, &pre_restore)
        .expect("validate and publish full backup");
    assert_eq!(restored_schema, 17);
    assert_eq!(unreadable, 1);
    assert!(pre_restore.exists(), "old database backup is retained");
    assert!(target
        .load_draft(&source_document.document_id, "context-a")
        .expect("restored draft")
        .is_some());
    assert!(target
        .load_draft(&target_document.document_id, "context-a")
        .expect("old target draft")
        .is_none());
    let restored = target
        .load_active_document(&source_document.document_id)
        .expect("restored active document")
        .expect("restored source doc");
    assert_eq!(restored.1.title, "源数据库草稿");
    let (profile_count, secret): (i64, Vec<u8>) = target
        .connection
        .query_row(
            "SELECT (SELECT COUNT(*) FROM provider_profiles WHERE connection_id = 'provider-synthetic'),
                    encrypted_blob
             FROM secrets WHERE secret_id = 'secret-synthetic'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("restored connection and ciphertext");
    assert_eq!(profile_count, 1);
    assert_eq!(secret, vec![1, 2, 3]);

    let mut bad_payload = payload.clone();
    bad_payload.database_sha256 = "0".repeat(64);
    assert!(matches!(
        target.restore_database_backup(&bad_payload, &pre_restore.with_extension("bad.bak")),
        Err(StorageError::HashMismatch)
    ));
    assert_eq!(
        target
            .load_active_document(&source_document.document_id)
            .expect("still-restored state")
            .expect("source remains")
            .1
            .title,
        "源数据库草稿"
    );

    let mut corrupt_sqlite = payload.clone();
    let mut corrupt_bytes = base64::engine::general_purpose::STANDARD
        .decode(corrupt_sqlite.database_base64.as_bytes())
        .expect("decode backup before damage");
    corrupt_bytes[0] ^= 0xff;
    corrupt_sqlite.database_sha256 = format!("{:x}", Sha256::digest(&corrupt_bytes));
    corrupt_sqlite.database_base64 =
        base64::engine::general_purpose::STANDARD.encode(&corrupt_bytes);
    let invalid_header_target = pre_restore.with_extension("invalid-header.bak");
    assert!(matches!(
        target.restore_database_backup(&corrupt_sqlite, &invalid_header_target),
        Err(StorageError::Corrupt(_))
    ));
    assert!(
        !invalid_header_target.exists(),
        "invalid SQLite candidate must fail before preserving or replacing the current database"
    );

    let occupied_target = pre_restore.with_extension("occupied.bak");
    std::fs::write(&occupied_target, b"preserve this existing recovery file")
        .expect("create occupied pre-restore path");
    assert!(matches!(
        target.restore_database_backup(&payload, &occupied_target),
        Err(StorageError::Validation(_))
    ));
    assert_eq!(
        std::fs::read(&occupied_target).expect("existing recovery file remains"),
        b"preserve this existing recovery file"
    );
    assert_eq!(
        target
            .load_active_document(&source_document.document_id)
            .expect("current database remains after occupied backup path")
            .expect("source remains")
            .1
            .title,
        "源数据库草稿"
    );
    std::fs::remove_file(&occupied_target).expect("cleanup occupied recovery path");

    drop(target);
    std::fs::remove_file(&pre_restore).expect("cleanup pre-restore backup");
}

#[test]
fn file_backed_database_backup_restores_wal_snapshot_without_sidecars() {
    let pre_restore = std::env::temp_dir().join(format!(
        "zinecv-r06-wal-pre-restore-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos(),
    ));
    let source_path = std::env::temp_dir().join(format!(
        "zinecv-r06-wal-source-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos(),
    ));
    let source_document = document("doc-wal-backup-source");
    let mut source = Store::open(&source_path).expect("file-backed source store");
    source
        .initialize_document(&source_document, "context-a")
        .expect("initialize file-backed source");
    let cursor = source
        .load_cursor(&source_document.document_id, "context-a")
        .expect("source cursor")
        .expect("active source cursor");
    edit_title(&mut source, &cursor, "wal-backup-edit", "WAL 文件库草稿");
    let payload = source.export_database_backup().expect("export WAL backup");
    let database = base64::engine::general_purpose::STANDARD
        .decode(payload.database_base64.as_bytes())
        .expect("decode serialized WAL snapshot");
    assert_eq!(
        &database[18..20],
        &[2, 2],
        "file-backed snapshots record WAL mode"
    );

    let mut target = Store::open_in_memory().expect("target store");
    let (schema, _) = target
        .restore_database_backup(&payload, &pre_restore)
        .expect("restore file-backed WAL snapshot");
    assert_eq!(schema, 17);
    assert!(
        pre_restore.exists(),
        "restore keeps the prior target database"
    );
    let restored = target
        .load_active_document(&source_document.document_id)
        .expect("load restored document")
        .expect("restored active document");
    assert_eq!(restored.1.title, "WAL 文件库草稿");

    drop(target);
    drop(source);
    for path in [
        pre_restore,
        source_path.clone(),
        source_path.with_file_name(format!(
            "{}-wal",
            source_path.file_name().unwrap().to_string_lossy()
        )),
        source_path.with_file_name(format!(
            "{}-shm",
            source_path.file_name().unwrap().to_string_lossy()
        )),
    ] {
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn database_backup_rejects_foreign_key_and_resource_hash_corruption() {
    let (foreign_key_store, current) = seeded_store("doc-r06-fk", "context-a");
    foreign_key_store
        .connection
        .pragma_update(None, "foreign_keys", "OFF")
        .expect("disable FK for corruption fixture");
    foreign_key_store
        .connection
        .execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
             VALUES (?1, 'context-a', 'missing-branch', 0, '{}', 'bad')",
            [&current.document_id],
        )
        .expect("inject orphan draft");
    let fk_path = std::env::temp_dir().join(format!(
        "zinecv-r06-fk-backup-{}-{}.db",
        std::process::id(),
        current.document_id
    ));
    assert!(matches!(
        foreign_key_store.backup_to(&fk_path),
        Err(StorageError::Corrupt(message)) if message.contains("Foreign key violation")
    ));
    assert!(!fk_path.exists());

    let resource_store = Store::open_in_memory().expect("resource store");
    resource_store
        .connection
        .execute(
            "INSERT INTO resources(hash, mime, bytes, size) VALUES ('not-the-hash', 'image/png', x'0102', 2)",
            [],
        )
        .expect("inject mismatched resource");
    let resource_path = std::env::temp_dir().join(format!(
        "zinecv-r06-resource-backup-{}-{}.db",
        std::process::id(),
        current.document_id
    ));
    assert!(matches!(
        resource_store.backup_to(&resource_path),
        Err(StorageError::Corrupt(message)) if message.contains("Resource integrity check")
    ));
    assert!(!resource_path.exists());
}

#[test]
fn version_graph_replacement_uses_current_durable_draft_not_client_snapshot() {
    let (mut store, initial) = seeded_store("doc-replace-version-draft", "context-a");
    let before = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("active cursor");
    edit_title(&mut store, &before, "durable-draft-edit", "当前已保存草稿");
    let current = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("updated cursor")
        .expect("updated active cursor");
    store
        .replace_version_store(
            &current,
            "main",
            &[ReplaceBranch {
                id: "main".into(),
                name: "导入默认分支".into(),
                head_commit_id: None,
                created_at: "2026-10-01T00:00:00Z".into(),
            }],
            &[],
        )
        .expect("replace graph");
    let (_, restored) = store
        .load_active_document(&initial.document_id)
        .expect("active state")
        .expect("document");
    assert_eq!(restored.title, "当前已保存草稿");

    let current = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after graph replacement")
        .expect("active cursor");
    let mut imported_draft = initial.clone();
    imported_draft.title = "用户审阅的导入草稿".into();
    store
        .replace_version_store_with_draft(
            &current,
            "main",
            &[ReplaceBranch {
                id: "main".into(),
                name: "导入版本图".into(),
                head_commit_id: None,
                created_at: "2026-10-01T00:00:00Z".into(),
            }],
            &[],
            Some(&imported_draft),
        )
        .expect("replace graph and apply reviewed draft atomically");
    let (_, restored) = store
        .load_active_document(&initial.document_id)
        .expect("active state after import")
        .expect("document");
    assert_eq!(restored.title, "用户审阅的导入草稿");

    let before_failure = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor before rejected replacement")
        .expect("active cursor");
    let mut rejected_draft = imported_draft.clone();
    rejected_draft.title = "不得部分写入".into();
    assert!(matches!(
        store.replace_version_store_with_draft(
            &before_failure,
            "side",
            &[ReplaceBranch {
                id: "side".into(),
                name: "不完整图".into(),
                head_commit_id: None,
                created_at: "2026-10-01T00:00:00Z".into(),
            }],
            &[],
            Some(&rejected_draft),
        ),
        Err(StorageError::Validation(_))
    ));
    let after_failure = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after rejected replacement")
        .expect("active cursor");
    assert_eq!(after_failure.revision, before_failure.revision);
    let (_, restored) = store
        .load_active_document(&initial.document_id)
        .expect("active state after rollback")
        .expect("document");
    assert_eq!(restored.title, "用户审阅的导入草稿");
    let graph = store
        .load_version_graph(&initial.document_id)
        .expect("version graph after rollback");
    assert_eq!(graph.branches.len(), 1);
    assert!(graph
        .branches
        .iter()
        .any(|branch| branch.is_current && branch.name == "导入版本图"));

    let branch: ReplaceBranch = serde_json::from_value(serde_json::json!({
        "id": "main",
        "name": "camel case",
        "headCommitId": null,
        "createdAt": "2026-10-01T00:00:00Z"
    }))
    .expect("camel-case import branch payload");
    assert_eq!(branch.head_commit_id, None);
    assert_eq!(branch.created_at, "2026-10-01T00:00:00Z");
}

#[test]
fn platform_backup_rejects_occupied_destination_without_mutation() {
    let store =
        Store::from_platform_connection(Connection::open_in_memory().unwrap(), None).unwrap();
    let mut snapshot = Connection::open_in_memory().unwrap();
    snapshot
        .execute_batch("CREATE TABLE protected(value TEXT); INSERT INTO protected VALUES('keep');")
        .unwrap();
    assert!(matches!(
        store.backup_into(&mut snapshot),
        Err(StorageError::Validation(_))
    ));
    let value: String = snapshot
        .query_row("SELECT value FROM protected", [], |row| row.get(0))
        .unwrap();
    assert_eq!(value, "keep");
}

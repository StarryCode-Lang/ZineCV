use super::*;

#[test]
fn two_connections_enforce_cas_revision() {
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

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
    use std::sync::{Arc, Barrier};
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
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
    let (mut store, initial) = seeded_store("doc-staged-backup", "context-a");
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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
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
                     INSERT INTO schema_migrations(version, checksum) VALUES (99, 'future');
                     CREATE TABLE future_data(value TEXT NOT NULL);
                     INSERT INTO future_data(value) VALUES ('preserve me');",
                )
                .expect("future schema");
    }
    let before = std::fs::read(&path).expect("database bytes before");
    assert!(matches!(
        Store::open(&path),
        Err(StorageError::UnsupportedSchema(99))
    ));
    assert_eq!(std::fs::read(&path).expect("database bytes after"), before);

    let mut current = Store::open_in_memory().expect("current store");
    current
        .save_draft(&document("current"), "context-a", 1)
        .expect("current draft");
    assert!(matches!(
        current.restore_from(&path),
        Err(StorageError::UnsupportedSchema(99))
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
    let preview_bytes = vec![b'a'; 4 * 1024 * 1024];
    let preview = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(preview_bytes)
    );
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
        let catalog = store
            .read_imported_template_catalog()
            .expect("read")
            .expect("catalog");
        assert_eq!(catalog.revision, 1);
        let catalog_value: serde_json::Value =
            serde_json::from_str(&catalog.payload_json).expect("catalog JSON");
        let template = &catalog_value[0];
        assert!(template.get("previewDataUrl").is_none());
        let asset_hash = template["previewAssetId"].as_str().expect("preview asset");
        assert_eq!(asset_hash.len(), 64);
        assert!(template["revisionHash"].as_str().is_some());
        assert!(template["knownRevisions"].as_array().is_some());
        assert!(matches!(
            store.write_imported_template_catalog("{}", 1),
            Err(StorageError::Validation(_))
        ));
        assert!(matches!(
            store.write_imported_template_catalog("[]", 0),
            Err(StorageError::Conflict(_))
        ));
        let reopened = store
            .read_imported_template_catalog()
            .expect("read")
            .expect("catalog");
        let reopened_value: serde_json::Value =
            serde_json::from_str(&reopened.payload_json).expect("catalog JSON");
        assert_eq!(reopened_value[0]["previewAssetId"], asset_hash);
        assert_eq!(reopened_value[0]["revisionHash"], template["revisionHash"]);
    }
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if candidate.exists() {
            std::fs::remove_file(candidate).expect("cleanup database");
        }
    }
}

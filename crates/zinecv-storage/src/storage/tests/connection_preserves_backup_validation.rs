use super::*;

#[test]
fn platform_connection_preserves_backup_validation_and_publication() {
    let mut store =
        Store::from_platform_connection(Connection::open_in_memory().unwrap(), None).unwrap();
    let document = zinecv_domain::default_resume_document("portable-backup").unwrap();
    store
        .initialize_document(&document, "portable-context")
        .unwrap();
    let backup = store.export_database_backup().unwrap();
    let before = store.load_active_document("portable-backup").unwrap();
    let mut bad = backup.clone();
    bad.database_sha256 = "0".repeat(64);
    let mut snapshot = Connection::open_in_memory().unwrap();
    assert!(matches!(
        store.restore_database_backup_with_snapshot(&bad, &mut snapshot),
        Err(StorageError::HashMismatch)
    ));
    assert_eq!(
        store.load_active_document("portable-backup").unwrap(),
        before
    );
    assert_eq!(
        store
            .restore_database_backup_with_snapshot(&backup, &mut snapshot)
            .unwrap()
            .0,
        18
    );
    Store::validate_connection(&snapshot).unwrap();
    let (old_cursor, old_document) = before.unwrap();
    let (cursor, document) = store
        .load_active_document("portable-backup")
        .unwrap()
        .unwrap();
    assert_eq!(document, old_document);
    assert_eq!(cursor.document_id, old_cursor.document_id);
    assert_eq!(cursor.context_id, old_cursor.context_id);
    assert_eq!(cursor.branch_id, old_cursor.branch_id);
    assert_eq!(cursor.head_id, old_cursor.head_id);
    assert_eq!(cursor.revision, "1");
}

fn set_authority_revision(store: &Store, revision: i64) {
    store
        .connection
        .execute("UPDATE documents SET revision = ?1", [revision])
        .unwrap();
    store
        .connection
        .execute("UPDATE drafts SET revision = ?1", [revision])
        .unwrap();
}

#[test]
fn restore_revision_fence_rejects_old_live_and_backup_cursors_without_changing_content() {
    for (candidate_revision, live_revision, expected) in [(4, 5, "6"), (12, 5, "13")] {
        let (mut store, original) = seeded_store("restore-fence", "context-a");
        let bytes = b"synthetic retained avatar";
        let hash = format!("{:x}", Sha256::digest(bytes));
        store.put_resource(&hash, "image/png", bytes, None).unwrap();
        store
            .link_resource(&hash, "document-avatar", "restore-fence")
            .unwrap();
        set_authority_revision(&store, candidate_revision);
        let candidate_cursor = store
            .load_cursor("restore-fence", "context-a")
            .unwrap()
            .unwrap();
        let graph = store.load_version_graph_detailed("restore-fence").unwrap();
        let backup = store.export_database_backup().unwrap();
        set_authority_revision(&store, live_revision);
        let live_cursor = store
            .load_cursor("restore-fence", "context-a")
            .unwrap()
            .unwrap();
        let mut snapshot = Connection::open_in_memory().unwrap();
        store
            .restore_database_backup_with_snapshot(&backup, &mut snapshot)
            .unwrap();
        let (cursor, restored) = store
            .load_active_document("restore-fence")
            .unwrap()
            .unwrap();
        assert_eq!(cursor.revision, expected);
        assert_eq!(cursor.context_id, live_cursor.context_id);
        assert_eq!(cursor.branch_id, live_cursor.branch_id);
        assert_eq!(cursor.head_id, live_cursor.head_id);
        assert_eq!(restored, original);
        assert_eq!(
            store.read_setting("active-document-id").unwrap().as_deref(),
            Some("restore-fence")
        );
        assert!(matches!(
            store.validate_active_cursor(&live_cursor),
            Err(StorageError::Conflict(_))
        ));
        assert!(matches!(
            store.validate_active_cursor(&candidate_cursor),
            Err(StorageError::Conflict(_))
        ));
        let restored_graph = store.load_version_graph_detailed("restore-fence").unwrap();
        assert_eq!(restored_graph.branches, graph.branches);
        assert_eq!(restored_graph.commits, graph.commits);
        assert_eq!(
            store.read_resource_bytes(&hash).unwrap().unwrap().1,
            bytes.to_vec()
        );
        let owners: i64 = store.connection.query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE resource_hash = ?1 AND owner_kind = 'document-avatar' AND owner_id = 'restore-fence'",
            [&hash], |row| row.get(0),
        ).unwrap();
        assert_eq!(owners, 1);
        assert_eq!(
            snapshot
                .query_row("SELECT MAX(revision) FROM documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            live_revision
        );
        Store::validate_restorable_database(&store.connection).unwrap();
    }
}

#[test]
fn restore_fence_overflow_or_candidate_failure_never_publishes() {
    for mode in [
        "live-overflow",
        "candidate-overflow",
        "candidate-write-failure",
        "all-archived",
    ] {
        let (mut store, _) = seeded_store("restore-failure", "context-a");
        if mode == "candidate-overflow" {
            set_authority_revision(&store, i64::MAX);
        }
        if mode == "candidate-write-failure" {
            store
                .connection
                .execute_batch(
                    "CREATE TRIGGER reject_revision_fence BEFORE UPDATE OF revision ON documents
                 BEGIN SELECT RAISE(ABORT, 'synthetic candidate failure'); END;",
                )
                .unwrap();
        }
        if mode == "all-archived" {
            store
                .connection
                .execute("UPDATE documents SET archived = 1", [])
                .unwrap();
        }
        let backup = store.export_database_backup().unwrap();
        if mode == "all-archived" {
            store
                .connection
                .execute("UPDATE documents SET archived = 0", [])
                .unwrap();
        }
        if mode == "candidate-write-failure" {
            store
                .connection
                .execute_batch("DROP TRIGGER reject_revision_fence")
                .unwrap();
        }
        set_authority_revision(&store, if mode == "live-overflow" { i64::MAX } else { 5 });
        let before = store.load_active_document("restore-failure").unwrap();
        let graph = store
            .load_version_graph_detailed("restore-failure")
            .unwrap();
        let mut snapshot = Connection::open_in_memory().unwrap();
        assert!(
            store
                .restore_database_backup_with_snapshot(&backup, &mut snapshot)
                .is_err(),
            "{mode}"
        );
        assert_eq!(
            store.load_active_document("restore-failure").unwrap(),
            before,
            "{mode}"
        );
        assert_eq!(
            store
                .load_version_graph_detailed("restore-failure")
                .unwrap(),
            graph,
            "{mode}"
        );
        assert_eq!(
            snapshot
                .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn platform_connection_rejects_foreign_database_before_migration() {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch("CREATE TABLE unrelated(value TEXT);")
        .unwrap();
    assert!(matches!(
        Store::from_platform_connection(connection, None),
        Err(StorageError::Corrupt(_))
    ));
}

#[test]
fn sqlite_page_limit_reports_full_without_partial_resource_and_recovers() {
    let store = Store::open_in_memory().expect("store");
    let pages: i64 = store
        .connection
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let bytes = vec![42_u8; 1024 * 1024];
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let failure = store
        .put_resource(&hash, "image/png", &bytes, None)
        .expect_err("real SQLite full");
    assert_eq!(
        zinecv_contracts::AppError::from(failure).code,
        zinecv_contracts::ErrorCode::StorageFull
    );
    assert!(store.read_resource_bytes(&hash).unwrap().is_none());
    store
        .connection
        .pragma_update(None, "max_page_count", 1_000_000)
        .unwrap();
    store
        .put_resource(&hash, "image/png", &bytes, None)
        .expect("retry after capacity restored");
    assert_eq!(store.read_resource_bytes(&hash).unwrap().unwrap().1, bytes);
}

#[test]
fn separate_connections_gc_and_lease_admission_keep_active_resource() {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("zinecv-p06-gc-{}-{suffix}.db", std::process::id()));
    let hash = format!("{:x}", Sha256::digest(b"synthetic resource"));
    {
        let store = Store::open(&path).unwrap();
        store
            .put_resource(&hash, "image/png", b"synthetic resource", None)
            .unwrap();
        store
            .create_resource_lease(std::slice::from_ref(&hash), 30)
            .unwrap();
    }
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let gc_path = path.clone();
    let gc_barrier = barrier.clone();
    let gc = std::thread::spawn(move || {
        let store = Store::open(&gc_path).unwrap();
        gc_barrier.wait();
        store.collect_unreferenced_resources().unwrap()
    });
    let lease_path = path.clone();
    let lease_hash = hash.clone();
    let admission = std::thread::spawn(move || {
        let store = Store::open(&lease_path).unwrap();
        barrier.wait();
        // A deferred SQLite read-to-write upgrade may conflict with GC; bounded
        // caller retry still has to validate the resource inside its transaction.
        for _ in 0..20 {
            match store.create_resource_lease(std::slice::from_ref(&lease_hash), 30) {
                Ok(lease) => return lease,
                Err(StorageError::Database(rusqlite::Error::SqliteFailure(error, _)))
                    if matches!(
                        error.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("lease admission failed: {error:?}"),
            }
        }
        panic!("lease admission did not converge");
    });
    assert_eq!(gc.join().unwrap(), 0);
    assert!(!admission.join().unwrap().is_empty());
    {
        let store = Store::open(&path).unwrap();
        assert!(store.read_resource_bytes(&hash).unwrap().is_some());
        store
            .connection
            .execute("UPDATE resource_leases SET expires_at = 0", [])
            .unwrap();
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 1);
    }
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
        if candidate.exists() {
            std::fs::remove_file(candidate).unwrap();
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_acl_and_exclusive_file_lock_preserve_live_document() {
    use std::os::windows::fs::OpenOptionsExt;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let folder =
        std::env::temp_dir().join(format!("zinecv-p06-io-{}-{suffix}", std::process::id()));
    std::fs::create_dir(&folder).unwrap();
    struct AclGuard(std::path::PathBuf);
    impl Drop for AclGuard {
        fn drop(&mut self) {
            let _ = std::process::Command::new("icacls")
                .arg(&self.0)
                .args(["/remove:d", "*S-1-1-0"])
                .output();
        }
    }
    let (mut store, original) = seeded_store("p06-io", "context-a");
    let backup = folder.join("source.db");
    store.backup_to(&backup).unwrap();
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&backup)
        .unwrap();
    assert!(
        store.restore_from(&backup).is_err(),
        "actual Windows sharing denial"
    );
    assert_eq!(
        store
            .load_current("p06-io", "context-a")
            .unwrap()
            .unwrap()
            .1,
        original
    );
    drop(locked);
    store.restore_from(&backup).expect("unlock recovery");
    let guard = AclGuard(folder.clone());
    let denial = std::process::Command::new("icacls")
        .arg(&folder)
        .args(["/deny", "*S-1-1-0:(WD)"])
        .output()
        .unwrap();
    assert!(denial.status.success(), "synthetic folder ACL configured");
    let error = store
        .backup_to(&folder.join("denied.db"))
        .expect_err("actual ACL create denial");
    assert_eq!(
        zinecv_contracts::AppError::from(error).code,
        zinecv_contracts::ErrorCode::Permission
    );
    assert_eq!(
        store
            .load_current("p06-io", "context-a")
            .unwrap()
            .unwrap()
            .1,
        original
    );
    drop(guard);
    store
        .backup_to(&folder.join("recovered.db"))
        .expect("ACL recovery");
    drop(store);
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn ipc_storage_errors_keep_their_business_categories() {
    use zinecv_contracts::{AppError, ErrorCode};

    assert_eq!(
        AppError::from(StorageError::Conflict("stale cursor".into())).code,
        ErrorCode::Conflict
    );
    assert_eq!(
        AppError::from(StorageError::MissingDraft).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        AppError::from(StorageError::Validation("bad input".into())).code,
        ErrorCode::Validation
    );
    assert_eq!(
        AppError::from(StorageError::UnsupportedSchema(99)).code,
        ErrorCode::UnsupportedSchema
    );
    assert_eq!(
        AppError::from(StorageError::Io(std::io::Error::from(
            std::io::ErrorKind::StorageFull
        )))
        .code,
        ErrorCode::StorageFull
    );
}

#[test]
fn export_freezes_cursor_and_rejects_missing_or_corrupt_avatar() {
    let mut store = Store::open_in_memory().expect("store");
    let mut source = document("doc-export");
    let bytes = b"fixture-avatar";
    let hash = format!("{:x}", Sha256::digest(bytes));
    store
        .put_resource(&hash, "image/png", bytes, None)
        .expect("avatar");
    source.basic.avatar_asset_id = Some(hash.clone());
    store
        .initialize_document(&source, "context-a")
        .expect("initialize");
    let cursor = store
        .load_cursor("doc-export", "context-a")
        .unwrap()
        .unwrap();
    let (frozen, avatar) = store.freeze_export(&cursor).expect("freeze");
    assert_eq!(frozen, source);
    assert_eq!(avatar.unwrap().1, bytes);
    let next = edit_title(&mut store, &cursor, "export-later-edit", "后续编辑");
    assert!(matches!(
        store.freeze_export(&cursor),
        Err(StorageError::Conflict(_))
    ));
    assert_eq!(frozen.title, source.title);
    store
        .connection
        .execute(
            "UPDATE resources SET bytes = x'01' WHERE hash = ?1",
            [&hash],
        )
        .unwrap();
    assert!(matches!(
        store.freeze_export(&next),
        Err(StorageError::HashMismatch)
    ));
    store
        .connection
        .execute(
            "DELETE FROM resource_refs WHERE resource_hash = ?1",
            [&hash],
        )
        .unwrap();
    store
        .connection
        .execute("DELETE FROM resources WHERE hash = ?1", [&hash])
        .unwrap();
    assert!(matches!(
        store.freeze_export(&next),
        Err(StorageError::NotFound(_))
    ));
}

#[test]
fn legacy_migration_commit_writes_preferences_and_stays_idempotent() {
    use crate::migration::LegacyMigrationPreference;
    let (mut store, initial) = seeded_store("doc-legacy-migration-preferences", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let mut request = legacy_migration_request(
        cursor,
        "synthetic source title",
        "reviewed import draft",
        None,
        "migration-command-preferences",
    );
    request.preferences = vec![
        LegacyMigrationPreference {
            key: "legacy.resume-diy-preferences".into(),
            value: "{\"font\":\"宋体\",\"theme\":\"#000000\"}".into(),
        },
        LegacyMigrationPreference {
            key: "legacy.resume-diy-presentation-v1".into(),
            value: "{\"density\":\"standard\"}".into(),
        },
    ];

    let receipt = store
        .commit_legacy_migration("test-actor", &request)
        .expect("commit with preferences");
    assert_eq!(receipt.preference_count, 2);
    assert!(!receipt.remaining_categories.contains(&"preferences".into()));
    let stored_count: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key LIKE 'legacy.%'",
            [],
            |row| row.get(0),
        )
        .expect("settings rows");
    assert_eq!(stored_count, 2);
    let stored_value: String = store
        .connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'legacy.resume-diy-preferences'",
            [],
            |row| row.get(0),
        )
        .expect("stored preference value");
    assert!(stored_value.contains("宋体"));

    let mut invalid = request.clone();
    invalid.command_id = "migration-command-preferences-invalid".into();
    invalid.preferences.push(request.preferences[0].clone());
    assert!(store
        .commit_legacy_migration("test-actor", &invalid)
        .is_err());
    let after_invalid: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key LIKE 'legacy.%'",
            [],
            |row| row.get(0),
        )
        .expect("settings rows after invalid");
    assert_eq!(after_invalid, 2);

    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after migration")
        .expect("document");
    edit_title(
        &mut store,
        &cursor,
        "edit-after-migration-preferences",
        "later manual edit",
    );
    let mut replay_request = request.clone();
    replay_request.command_id = "migration-command-preferences-replay".into();
    replay_request.cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after manual edit")
        .expect("document");
    let replay = store
        .commit_legacy_migration("test-actor", &replay_request)
        .expect("idempotent replay with preferences");
    assert!(replay.idempotent_replay);
    let replayed_value: String = store
        .connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'legacy.resume-diy-preferences'",
            [],
            |row| row.get(0),
        )
        .expect("stored preference value after replay");
    assert_eq!(replayed_value, stored_value);
    let (_, restored) = store
        .load_active_document(&initial.document_id)
        .expect("active document after replay")
        .expect("document");
    assert_eq!(restored.title, "later manual edit");
}

#[test]
fn legacy_identity_import_is_atomic_idempotent_and_survives_reopen() {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "zinecv-identity-migration-{}-{suffix}.db",
        std::process::id()
    ));
    let request;
    {
        let mut store = Store::open(&path).unwrap();
        let initial = document("doc-identity-import");
        store.initialize_document(&initial, "context-a").unwrap();
        let cursor = store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap();
        request = identity_migration_request(cursor, "已接收的合成历史");
        let receipt = store
            .commit_legacy_migration("test-actor", &request)
            .unwrap();
        assert_eq!(
            (
                receipt.account_count,
                receipt.provider_count,
                receipt.session_count,
                receipt.secret_reentry_count
            ),
            (1, 1, 1, 1)
        );
        assert!(!receipt.remaining_categories.contains(&"accounts".into()));
        assert!(!receipt
            .remaining_categories
            .contains(&"agent-sessions".into()));
        assert!(receipt
            .remaining_categories
            .contains(&"provider-secrets".into()));
        for index in 0..3 {
            let mut repeated = request.clone();
            repeated.command_id = format!("identity-replay-{index}");
            assert!(
                store
                    .commit_legacy_migration("test-actor", &repeated)
                    .unwrap()
                    .idempotent_replay
            );
        }
        for (table, count) in [
            ("accounts", 1),
            ("provider_profiles", 1),
            ("agent_sessions", 1),
            ("agent_messages", 1),
            ("account_sessions", 0),
            ("secrets", 0),
        ] {
            let actual: i64 = store
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(actual, count, "{table}");
        }
        let reason: String = store
            .connection
            .query_row(
                "SELECT interrupted_reason FROM agent_run_lifecycle WHERE state='failed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(reason.contains("not resumed"));
        // A new batch with a changed existing session conflicts and rolls back its draft/graph writes.
        let cursor = store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap();
        let mut changed = identity_migration_request(cursor.clone(), "冲突的历史");
        changed.command_id = "identity-conflicting-session".into();
        assert!(matches!(
            store.commit_legacy_migration("test-actor", &changed),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(
            store
                .load_cursor(&initial.document_id, "context-a")
                .unwrap()
                .unwrap(),
            cursor
        );
    }
    {
        let mut store = Store::open(&path)
            .unwrap()
            .with_secret_provider(std::sync::Arc::new(zinecv_native::NativeSecrets));
        let token = store
            .login_account("identity-migration@example.com", "legacy-password")
            .unwrap();
        let profile = store.provider_profile(&token, "primary").unwrap().unwrap();
        assert!(profile.api_key_needs_reentry);
        assert!(!profile.has_api_key);
        assert_eq!(profile.capability, "chat-only");
        let state = store
            .bootstrap_agent_sessions("legacy-identity-account", "null")
            .unwrap();
        assert_eq!(state.store.sessions.len(), 1);
        assert_eq!(state.store.sessions[0].messages[0].text, "已接收的合成历史");
        store
            .store_provider_key(
                &token,
                "primary",
                "Legacy fixture",
                "https://example.com",
                "fixture-model",
                "sk-synthetic-new-key",
            )
            .unwrap();
        assert!(
            !store
                .provider_profile(&token, "primary")
                .unwrap()
                .unwrap()
                .api_key_needs_reentry
        );
    }
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn legacy_identity_email_conflict_rolls_back_all_migration_writes() {
    let (mut store, initial) = seeded_store("doc-identity-conflict", "context-a");
    store
        .register_account("identity-migration@example.com", "different-password")
        .unwrap();
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let request = identity_migration_request(cursor.clone(), "合成历史");
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &request),
        Err(StorageError::Conflict(_))
    ));
    assert_eq!(
        store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap(),
        cursor
    );
    assert_eq!(
        store
            .load_draft(&initial.document_id, "context-a")
            .unwrap()
            .unwrap()
            .1,
        initial
    );
    let count: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM legacy_migration_batches", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
    let count: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM provider_profiles", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

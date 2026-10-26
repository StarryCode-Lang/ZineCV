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
        17
    );
    Store::validate_connection(&snapshot).unwrap();
    assert_eq!(
        store.load_active_document("portable-backup").unwrap(),
        before
    );
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

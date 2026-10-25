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

fn seeded_store(id: &str, context: &str) -> (Store, ResumeDocument) {
    let mut store = Store::open_in_memory().unwrap();
    let document = document(id);
    store.initialize_document(&document, context).unwrap();
    (store, document)
}

fn legacy_migration_request(
    cursor: AuthorityCursor,
    source_title: &str,
    converted_title: &str,
    parent_id: Option<&str>,
    command_id: &str,
) -> crate::migration::CommitLegacyMigrationRequest {
    use crate::migration::{
        CommitLegacyMigrationRequest, InspectLegacyMigrationRequest, LegacyMigrationExpectedHash,
        LegacyMigrationSourceInput, LegacyMigrationSourceKind, LegacyMigrationVersionBranch,
        LegacyMigrationVersionCommit, LegacyMigrationVersionGraph,
    };
    use serde_json::json;

    let source_json = json!({
        "currentBranchId":"main",
        "branches":[{"id":"main","name":"Imported main","createdAt":"2026-01-01T00:00:00Z","headCommitId":"commit-1"}],
        "commits":[{
            "id":"commit-1","branchId":"main","parentId":parent_id,"message":"fixture","createdAt":"2026-01-01T00:00:00Z",
            "snapshot":{
                "resumeTitle":source_title,"summaryTitle":"自我评价",
                "resume":{"basic":{"name":"Synthetic","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},"summary":"","education":[],"skills":[],"work":[{"id":"entry-1","title":source_title,"role":"","department":"","city":"","start":"2024","end":"","html":"<p>Synthetic</p>"}],"projects":[],"orgs":[],"research":[],"awards":[],"other":[],"portfolio":[],"custom":[]},
                "moduleOrder":["work","summary"],"moduleNames":{"work":"工作经历"},
                "layout":{"font":"宋体","fontSize":"13","lineHeight":"13","moduleSpacing":"0","pageMargin":"30","theme":"#000000","dateFormat":"2021年1月","titleFormat":"单行标题","separator":"使用分隔符号","textAlign":"系统默认"}
            }
        }]
    });
    let raw_json = source_json.to_string();
    let source_sha256 = format!("{:x}", Sha256::digest(raw_json.as_bytes()));
    let source = LegacyMigrationSourceInput {
        source_id: "versions".into(),
        kind: LegacyMigrationSourceKind::VersionJson,
        raw_json,
    };
    let mut converted = document(&cursor.document_id);
    converted.title = converted_title.into();
    CommitLegacyMigrationRequest {
        command_id: command_id.into(),
        cursor,
        inspection: InspectLegacyMigrationRequest {
            source_namespace: Some("library-a".into()),
            sources: vec![source],
        },
        expected_source_hashes: vec![LegacyMigrationExpectedHash {
            source_id: "versions".into(),
            source_sha256,
        }],
        confirmed: true,
        acknowledged_review_items: Vec::new(),
        accepted_identity_updates: Vec::new(),
        current_draft: Some(converted.clone()),
        version_graph: Some(LegacyMigrationVersionGraph {
            source_id: "versions".into(),
            current_branch_id: "main".into(),
            branches: vec![LegacyMigrationVersionBranch {
                id: "main".into(),
                name: "Imported main".into(),
                head_commit_id: Some("commit-1".into()),
                created_at: "2026-01-01T00:00:00Z".into(),
            }],
            commits: vec![LegacyMigrationVersionCommit {
                id: "commit-1".into(),
                branch_id: "main".into(),
                parent_id: parent_id.map(str::to_string),
                message: "fixture".into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                snapshot: converted,
            }],
        }),
        preferences: Vec::new(),
        templates: None,
    }
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

fn identity_migration_request(
    cursor: AuthorityCursor,
    text: &str,
) -> crate::migration::CommitLegacyMigrationRequest {
    use crate::migration::{
        LegacyMigrationExpectedHash, LegacyMigrationSourceInput, LegacyMigrationSourceKind,
    };
    use serde_json::json;
    let mut request = legacy_migration_request(
        cursor,
        "identity source",
        "identity draft",
        None,
        "identity-import",
    );
    let accounts = json!({"version":1,"accounts":[{
        "id":"legacy-identity-account","email":"identity-migration@example.com",
        "salt":"0123456789abcdef0123456789abcdef",
        "passwordHash":"2a6389fa6e25b6b6825dbdc48b528f1ea4664b8f414aaaca42c308771a248049d7ae5077d8c02cac2f5956664a51ea802e02f798daa62c6151aded48d87346cc",
        "provider":{"name":"Legacy fixture","baseUrl":"https://example.com","model":"fixture-model","apiKey":"legacy-secret-must-not-migrate"}
    }],"sessions":[{"accountId":"legacy-identity-account","tokenHash":"excluded-live-token","expiresAt":9999999999999i64}]});
    let sessions = json!({"activeId":"legacy-chat","sessions":[{
        "id":"legacy-chat","title":"旧会话","createdAt":1000,"updatedAt":2000,"status":"running",
        "messages":[{"id":"legacy-message","role":"assistant","text":text}]
    }]});
    let entries = json!([
        ["resume-diy-agent-accounts", accounts.to_string()],
        [
            "resume-diy-agent-sessions-v2:legacy-identity-account",
            sessions.to_string()
        ]
    ]);
    let entry_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&entries).unwrap())
    );
    let raw_json = json!({"format":"zinecv-legacy-browser-export","version":1,
        "origin":"http://127.0.0.1:5173","sourceHash":entry_hash,"entries":entries})
    .to_string();
    request
        .expected_source_hashes
        .push(LegacyMigrationExpectedHash {
            source_id: "identity-browser".into(),
            source_sha256: format!("{:x}", Sha256::digest(raw_json.as_bytes())),
        });
    request.inspection.sources.push(LegacyMigrationSourceInput {
        source_id: "identity-browser".into(),
        kind: LegacyMigrationSourceKind::BrowserExport,
        raw_json,
    });
    let report = crate::migration::inspect(&request.inspection);
    assert!(report.ready_for_dry_run, "{report:?}");
    assert_eq!(report.totals.account_records, 1);
    assert_eq!(report.totals.provider_profiles, 1);
    assert_eq!(report.totals.live_session_tokens_not_migrated, 1);
    request.acknowledged_review_items = crate::migration::required_review_item_keys(&report);
    request
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

#[test]
fn legacy_identity_multiple_browser_sources_reconcile_accounts_and_session_namespaces() {
    let (mut store, initial) = seeded_store("doc-multiple-identity", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let mut request = identity_migration_request(cursor, "多命名空间合成历史");
    let original = request.inspection.sources.last().unwrap().clone();
    let mut other = original.clone();
    other.source_id = "identity-browser-other".into();
    let mut value: serde_json::Value = serde_json::from_str(&other.raw_json).unwrap();
    for entry in value["entries"].as_array_mut().unwrap() {
        for item in entry.as_array_mut().unwrap() {
            *item = serde_json::Value::String(
                item.as_str()
                    .unwrap()
                    .replace("legacy-identity-account", "legacy-identity-other")
                    .replace(
                        "identity-migration@example.com",
                        "identity-other@example.com",
                    ),
            );
        }
    }
    value["sourceHash"] = serde_json::Value::String(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value["entries"]).unwrap())
    ));
    other.raw_json = value.to_string();
    request
        .expected_source_hashes
        .push(crate::migration::LegacyMigrationExpectedHash {
            source_id: other.source_id.clone(),
            source_sha256: format!("{:x}", Sha256::digest(other.raw_json.as_bytes())),
        });
    request.inspection.sources.push(other);
    let report = crate::migration::inspect(&request.inspection);
    assert!(report.ready_for_dry_run, "{report:?}");
    request.acknowledged_review_items = crate::migration::required_review_item_keys(&report);
    let receipt = store
        .commit_legacy_migration("test-actor", &request)
        .unwrap();
    assert_eq!(
        (
            receipt.account_count,
            receipt.provider_count,
            receipt.session_count
        ),
        (2, 2, 2)
    );
    for _ in 0..3 {
        assert!(
            store
                .commit_legacy_migration("test-actor", &request)
                .unwrap()
                .idempotent_replay
        );
    }
    for account in ["legacy-identity-account", "legacy-identity-other"] {
        let state = store.bootstrap_agent_sessions(account, "null").unwrap();
        assert_eq!(state.store.sessions.len(), 1);
        assert_eq!(
            state.store.sessions[0].messages[0].text,
            "多命名空间合成历史"
        );
    }
}

#[test]
fn legacy_migration_commit_writes_template_catalog_idempotently() {
    let (mut store, initial) = seeded_store("doc-legacy-migration-templates", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let mut request = legacy_migration_request(
        cursor,
        "synthetic source title",
        "reviewed import draft",
        None,
        "migration-command-templates",
    );
    request.templates = Some(crate::migration::LegacyMigrationTemplates {
        expected_revision: "0".into(),
        catalog_json: r#"[{"id":"legacy-template-1","name":"旧版模板A","sourceName":"a.png","sourceType":"image","createdAt":"2025-01-01T00:00:00.000Z"},{"id":"legacy-template-2","name":"旧版模板B","sourceName":"b.png","sourceType":"pdf","createdAt":"2025-02-01T00:00:00.000Z"}]"#.into(),
    });

    let receipt = store
        .commit_legacy_migration("test-actor", &request)
        .expect("commit with template catalog");
    assert_eq!(receipt.template_count, 2);
    assert!(!receipt.remaining_categories.contains(&"templates".into()));
    let (revision, payload_json): (i64, String) = store
        .connection
        .query_row(
            "SELECT revision, payload_json FROM imported_template_catalog WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("catalog row");
    assert_eq!(revision, 1);
    assert!(payload_json.contains("legacy-template-1"));
    let revision_rows: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM template_revisions", [], |row| {
            row.get(0)
        })
        .expect("template revision rows");
    assert_eq!(revision_rows, 2);

    // 幂等重放：返回已存回执，目录 revision 不再前进。
    let mut replay_request = request.clone();
    replay_request.command_id = "migration-command-templates-replay".into();
    let replay = store
        .commit_legacy_migration("test-actor", &replay_request)
        .expect("idempotent replay with templates");
    assert!(replay.idempotent_replay);
    let replayed_revision: i64 = store
        .connection
        .query_row(
            "SELECT revision FROM imported_template_catalog WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("catalog revision after replay");
    assert_eq!(replayed_revision, 1);

    // CAS 冲突：期望的基准 revision 已过期，整组拒绝。
    let mut stale = request.clone();
    stale.command_id = "migration-command-templates-stale".into();
    if let Some(templates) = stale.templates.as_mut() {
        templates.expected_revision = "5".into();
    }
    let error = store
        .commit_legacy_migration("test-actor", &stale)
        .expect_err("stale catalog revision must conflict");
    assert!(matches!(error, crate::storage::StorageError::Conflict(_)));
}

#[test]
fn legacy_migration_commit_is_atomic_idempotent_and_does_not_revert_later_edits() {
    let (mut store, initial) = seeded_store("doc-legacy-migration-commit", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let request = legacy_migration_request(
        cursor,
        "synthetic source title",
        "reviewed import draft",
        None,
        "migration-command-first",
    );

    let receipt = store
        .commit_legacy_migration("test-actor", &request)
        .expect("atomic migration commit");
    assert!(!receipt.idempotent_replay);
    assert_eq!(receipt.completion_status, "partial");
    assert!(receipt.remaining_categories.contains(&"accounts".into()));
    assert_eq!(receipt.version_branch_count, 1);
    assert_eq!(receipt.version_commit_count, 1);
    let graph = store
        .load_version_graph(&initial.document_id)
        .expect("imported graph");
    assert_eq!(graph.commits.len(), 2);
    assert!(graph
        .branches
        .iter()
        .any(|branch| branch.name.starts_with("Imported main (imported ")));
    let (_, imported_draft) = store
        .load_active_document(&initial.document_id)
        .expect("active document")
        .expect("document");
    assert_eq!(imported_draft.title, "reviewed import draft");

    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after migration")
        .expect("document");
    edit_title(
        &mut store,
        &cursor,
        "edit-after-migration",
        "later manual edit",
    );
    let mut replay_request = request.clone();
    replay_request.command_id = "migration-command-replay".into();
    replay_request.cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after manual edit")
        .expect("document");
    let replay = store
        .commit_legacy_migration("test-actor", &replay_request)
        .expect("idempotent replay");
    assert!(replay.idempotent_replay);
    let (_, restored) = store
        .load_active_document(&initial.document_id)
        .expect("active document after replay")
        .expect("document");
    assert_eq!(restored.title, "later manual edit");
    let commit_count: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM commits WHERE document_id = ?1",
            [&initial.document_id],
            |row| row.get(0),
        )
        .expect("commit count");
    assert_eq!(commit_count, 2);
}

fn legacy_avatar_migration_request(
    cursor: AuthorityCursor,
) -> (CommitLegacyMigrationRequest, Vec<u8>, String) {
    let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM90AAAAASUVORK5CYII=";
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let data_url = format!("data:image/png;base64,{encoded}");
    let mut request = legacy_migration_request(
        cursor,
        "avatar source",
        "avatar draft",
        None,
        "avatar-migration",
    );
    let source = &mut request.inspection.sources[0];
    let mut raw: serde_json::Value = serde_json::from_str(&source.raw_json).unwrap();
    raw["commits"][0]["snapshot"]["resume"]["basic"]["avatar"] = data_url.clone().into();
    source.raw_json = raw.to_string();
    request.expected_source_hashes[0].source_sha256 =
        format!("{:x}", Sha256::digest(source.raw_json.as_bytes()));
    request
        .current_draft
        .as_mut()
        .unwrap()
        .legacy_extensions
        .insert("legacyAvatar".into(), data_url.clone().into());
    request.version_graph.as_mut().unwrap().commits[0]
        .snapshot
        .legacy_extensions
        .insert("legacyAvatar".into(), data_url.into());
    request.acknowledged_review_items =
        migration::required_review_item_keys(&migration::inspect(&request.inspection));
    (request, bytes, hash)
}

#[test]
fn legacy_avatar_migration_preserves_bytes_owners_and_idempotence() {
    let (mut store, initial) = seeded_store("legacy-avatar", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let (request, bytes, hash) = legacy_avatar_migration_request(cursor);
    assert_eq!(
        migration::inspect(&request.inspection)
            .totals
            .avatar_assets_present,
        1
    );
    let receipt = store
        .commit_legacy_migration("test-actor", &request)
        .unwrap();
    assert!(!receipt.remaining_categories.contains(&"assets".into()));
    let (_, migrated) = store
        .load_active_document(&initial.document_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        migrated.basic.avatar_asset_id.as_deref(),
        Some(hash.as_str())
    );
    assert!(!migrated.legacy_extensions.contains_key("legacyAvatar"));
    let stored = store.read_resource_bytes(&hash).unwrap().unwrap();
    assert_eq!(stored.0, "image/png");
    assert_eq!(stored.1, bytes);
    let owners: Vec<String> = store.connection.prepare("SELECT DISTINCT owner_kind FROM resource_refs WHERE resource_hash=?1 ORDER BY owner_kind").unwrap()
        .query_map([&hash], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert!(owners.contains(&"draft".into()));
    assert!(owners.contains(&"snapshot".into()));
    store.collect_unreferenced_resources().unwrap();
    assert_eq!(store.read_resource_bytes(&hash).unwrap().unwrap().1, bytes);
    assert!(
        store
            .commit_legacy_migration("test-actor", &request)
            .unwrap()
            .idempotent_replay
    );
    let count: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resources WHERE hash=?1",
            [&hash],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn legacy_avatar_migration_late_failure_rolls_back_resource_and_history() {
    let (mut store, initial) = seeded_store("legacy-avatar-rollback", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let (mut request, _, hash) = legacy_avatar_migration_request(cursor.clone());
    // The snapshot stages a valid resource first. The later draft mismatch must
    // roll back the actual resource row, its owners, graph mappings and cursor.
    request
        .current_draft
        .as_mut()
        .unwrap()
        .basic
        .avatar_asset_id = Some("0".repeat(64));
    assert!(store
        .commit_legacy_migration("test-actor", &request)
        .is_err());
    assert!(store.read_resource_bytes(&hash).unwrap().is_none());
    assert_eq!(
        store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap(),
        cursor
    );
    assert_eq!(
        store
            .load_active_document(&initial.document_id)
            .unwrap()
            .unwrap()
            .1,
        initial
    );
    let batches: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM legacy_migration_batches", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(batches, 0);
    let mappings: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM legacy_entity_identity", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(mappings, 0);
}

fn legacy_template_preview_request(
    cursor: AuthorityCursor,
) -> (CommitLegacyMigrationRequest, Vec<u8>, String) {
    let (mut request, bytes, hash) = legacy_avatar_migration_request(cursor);
    let preview = request.current_draft.as_ref().unwrap().legacy_extensions["legacyAvatar"]
        .as_str()
        .unwrap()
        .to_string();
    let templates = serde_json::json!([{
        "id":"legacy-image-template", "name":"Synthetic template", "sourceName":"fixture.png",
        "sourceType":"image", "createdAt":"2026-10-08T00:00:00Z", "accent":"#123456",
        "formatId":"legacy-v1", "layout":"single-column", "analysis":"Synthetic only",
        "previewDataUrl":preview
    }]);
    let entries = serde_json::json!([["resume-diy-imported-templates-v1", templates.to_string()]]);
    let raw_json = serde_json::json!({"format":"zinecv-legacy-browser-export","version":1,
        "origin":"http://127.0.0.1:5173",
        "sourceHash":format!("{:x}", Sha256::digest(serde_json::to_vec(&entries).unwrap())),
        "entries":entries})
    .to_string();
    request
        .expected_source_hashes
        .push(crate::migration::LegacyMigrationExpectedHash {
            source_id: "template-browser".into(),
            source_sha256: format!("{:x}", Sha256::digest(raw_json.as_bytes())),
        });
    request
        .inspection
        .sources
        .push(crate::migration::LegacyMigrationSourceInput {
            source_id: "template-browser".into(),
            kind: crate::migration::LegacyMigrationSourceKind::BrowserExport,
            raw_json,
        });
    request.templates = Some(crate::migration::LegacyMigrationTemplates {
        expected_revision: "0".into(),
        catalog_json: templates.to_string(),
    });
    request.acknowledged_review_items =
        migration::required_review_item_keys(&migration::inspect(&request.inspection));
    (request, bytes, hash)
}

#[test]
fn legacy_template_previews_preserve_bytes_owners_reopen_gc_and_replay() {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "zinecv-template-migration-{}-{suffix}.db",
        std::process::id()
    ));
    let request;
    let original_bytes;
    let original_hash;
    {
        let mut store = Store::open(&path).unwrap();
        let initial = document("template-migration");
        store.initialize_document(&initial, "context-a").unwrap();
        let cursor = store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap();
        (request, original_bytes, original_hash) = legacy_template_preview_request(cursor);
        assert_eq!(
            migration::inspect(&request.inspection)
                .totals
                .template_assets_present,
            1
        );
        let receipt = store
            .commit_legacy_migration("test-actor", &request)
            .unwrap();
        assert!(!receipt.remaining_categories.contains(&"assets".into()));
        assert_eq!(receipt.template_count, 1);
    }
    {
        let mut store = Store::open(&path).unwrap();
        let catalog: serde_json::Value = serde_json::from_str(
            &store
                .connection
                .query_row(
                    "SELECT payload_json FROM imported_template_catalog WHERE id=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            catalog[0]["previewAssetId"].as_str(),
            Some(original_hash.as_str())
        );
        assert!(catalog[0].get("previewDataUrl").is_none());
        store.collect_unreferenced_resources().unwrap();
        assert_eq!(
            store
                .read_resource_bytes(&original_hash)
                .unwrap()
                .unwrap()
                .1,
            original_bytes
        );
        assert!(
            store
                .commit_legacy_migration("test-actor", &request)
                .unwrap()
                .idempotent_replay
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM resources", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(store.connection.query_row("SELECT COUNT(*) FROM resource_refs WHERE owner_kind='retained-template' AND owner_id='legacy-image-template'", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn legacy_template_previews_do_not_close_assets_for_wrong_owner_or_missing_bytes() {
    for (suffix, changed) in [("wrong-owner", true), ("missing-preview", false)] {
        let (mut store, initial) = seeded_store(suffix, "context-a");
        let cursor = store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap();
        let (mut request, _, _) = legacy_template_preview_request(cursor);
        let mut catalog: serde_json::Value =
            serde_json::from_str(&request.templates.as_ref().unwrap().catalog_json).unwrap();
        if changed {
            catalog[0]["id"] = "another-template".into();
        } else {
            catalog[0].as_object_mut().unwrap().remove("previewDataUrl");
        }
        request.templates.as_mut().unwrap().catalog_json = catalog.to_string();
        let receipt = store
            .commit_legacy_migration("test-actor", &request)
            .unwrap();
        assert!(
            receipt.remaining_categories.contains(&"assets".into()),
            "{suffix}"
        );
    }
}

#[test]
fn legacy_template_previews_late_catalog_failure_rolls_back_staged_images() {
    let (mut store, initial) = seeded_store("template-rollback", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let (mut request, _, hash) = legacy_template_preview_request(cursor.clone());
    let mut templates: Vec<serde_json::Value> =
        serde_json::from_str(&request.templates.as_ref().unwrap().catalog_json).unwrap();
    templates.push(templates[0].clone());
    request.templates.as_mut().unwrap().catalog_json = serde_json::to_string(&templates).unwrap();
    assert!(store
        .commit_legacy_migration("test-actor", &request)
        .is_err());
    assert!(store.read_resource_bytes(&hash).unwrap().is_none());
    assert_eq!(
        store
            .load_cursor(&initial.document_id, "context-a")
            .unwrap()
            .unwrap(),
        cursor
    );
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM imported_template_catalog",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM resource_refs", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn legacy_migration_failed_parent_rolls_back_graph_mappings_and_revision() {
    let (mut store, initial) = seeded_store("doc-legacy-migration-rollback", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let request = legacy_migration_request(
        cursor.clone(),
        "synthetic source title",
        "reviewed import draft",
        Some("missing-parent"),
        "migration-command-rollback",
    );
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &request),
        Err(StorageError::Validation(_))
    ));
    let after = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after rollback")
        .expect("document");
    assert_eq!(after, cursor);
    let graph = store
        .load_version_graph(&initial.document_id)
        .expect("version graph after rollback");
    assert_eq!(graph.commits.len(), 1);
    assert_eq!(graph.branches.len(), 1);
    let mapping_count: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM legacy_entity_identity", [], |row| {
            row.get(0)
        })
        .expect("identity count");
    assert_eq!(mapping_count, 0);
    let batch_count: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM legacy_migration_batches", [], |row| {
            row.get(0)
        })
        .expect("batch count");
    assert_eq!(batch_count, 0);
}

#[test]
fn legacy_migration_requires_confirmation_and_rechecks_source_hashes() {
    let (mut store, initial) = seeded_store("doc-legacy-migration-source-check", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let mut request = legacy_migration_request(
        cursor,
        "synthetic source title",
        "reviewed import draft",
        None,
        "migration-command-confirmation",
    );
    request.confirmed = false;
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &request),
        Err(StorageError::Permission(_))
    ));
    request.confirmed = true;
    request.inspection.sources[0].raw_json.push(' ');
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &request),
        Err(StorageError::Conflict(_))
    ));
    let batches: i64 = store
        .connection
        .query_row("SELECT COUNT(*) FROM legacy_migration_batches", [], |row| {
            row.get(0)
        })
        .expect("batch count");
    assert_eq!(batches, 0);
}

#[test]
fn changed_legacy_entities_are_reviewed_and_appended_without_replacing_prior_history() {
    use crate::migration::InspectLegacyIdentityConflictsRequest;

    let (mut store, initial) = seeded_store("doc-legacy-migration-identity-update", "context-a");
    let first_cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let first = legacy_migration_request(
        first_cursor,
        "synthetic source title",
        "reviewed import v1",
        None,
        "migration-command-v1",
    );
    store
        .commit_legacy_migration("test-actor", &first)
        .expect("first migration");

    let second_cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .expect("cursor after first import")
        .expect("document");
    let mut second = legacy_migration_request(
        second_cursor,
        "updated synthetic source title",
        "reviewed import v2",
        None,
        "migration-command-v2",
    );
    let graph = second.version_graph.clone().expect("converted graph");
    let conflicts = store
        .inspect_legacy_identity_conflicts(&InspectLegacyIdentityConflictsRequest {
            target_document_id: initial.document_id.clone(),
            source_namespace: "library-a".into(),
            version_graph: graph,
        })
        .expect("identity preflight");
    assert_eq!(conflicts.len(), 2);
    assert!(conflicts.iter().any(|item| item.entity_kind == "branch"));
    assert!(conflicts.iter().any(|item| item.entity_kind == "commit"));
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &second),
        Err(StorageError::Conflict(_))
    ));
    second.accepted_identity_updates = conflicts
        .iter()
        .map(|item| item.conflict_key.clone())
        .collect();
    let update = store
        .commit_legacy_migration("test-actor", &second)
        .expect("explicitly accepted append-only identity update");
    assert_eq!(update.version_branch_count, 1);
    assert_eq!(update.version_commit_count, 1);
    let graph = store
        .load_version_graph(&initial.document_id)
        .expect("merged native history");
    assert_eq!(graph.commits.len(), 3);
    assert_eq!(graph.branches.len(), 3);
    let migrated_commits = store
        .connection
        .prepare("SELECT id FROM commits WHERE document_id = ?1 AND id LIKE 'legacy-%'")
        .expect("commit query")
        .query_map([&initial.document_id], |row| row.get::<_, String>(0))
        .expect("commit rows")
        .collect::<Result<Vec<_>, _>>()
        .expect("commit ids");
    assert_eq!(migrated_commits.len(), 2);
    assert_ne!(migrated_commits[0], migrated_commits[1]);
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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};
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

fn import_candidate(id: &str, value: &str) -> zinecv_contracts::ImportCandidate {
    use zinecv_contracts::{
        ImportBasicField, ImportCandidate, ImportCandidateValue, ImportFieldEvidence,
    };
    ImportCandidate {
        id: id.into(),
        label: "姓名".into(),
        value: ImportCandidateValue::BasicField {
            field: ImportBasicField::Name,
            value: value.into(),
        },
        evidence: ImportFieldEvidence {
            page: Some(1),
            excerpt: value.into(),
            source_field: Some("name".into()),
            confidence: "high".into(),
        },
    }
}

fn review_import_draft(
    store: &mut Store,
    id: &str,
    preview: bool,
) -> zinecv_contracts::ImportDraft {
    use zinecv_contracts::{
        CreateImportDraftRequest, ImportDraftStatus, ImportSourceKind, TransitionImportDraftRequest,
    };
    let hash = "a".repeat(64);
    store
        .create_import_draft(&CreateImportDraftRequest {
            draft_id: id.into(),
            source_kind: ImportSourceKind::Pdf,
            display_name: "fixture.pdf".into(),
            source_hash: hash,
        })
        .expect("queued import draft");
    store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: id.into(),
            expected_status: ImportDraftStatus::Queued,
            next_status: ImportDraftStatus::Running,
            candidates: None,
            warnings: None,
            unsupported_features: None,
            preview_data_url: None,
        })
        .expect("running import draft");
    store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: id.into(),
            expected_status: ImportDraftStatus::Running,
            next_status: ImportDraftStatus::ReviewRequired,
            candidates: Some(vec![import_candidate("candidate-name", "导入姓名")]),
            warnings: Some(vec!["仅合成测试输入".into()]),
            unsupported_features: Some(vec![]),
            preview_data_url: preview.then(|| "data:image/png;base64,AQID".into()),
        })
        .expect("review import draft")
}

#[test]
fn import_draft_stays_separate_until_atomic_confirm_and_retry_is_idempotent() {
    use zinecv_contracts::ApplyImportRequest;

    let (mut store, before) = seeded_store("doc-import", "context-a");
    let initial_cursor = store
        .load_cursor("doc-import", "context-a")
        .unwrap()
        .unwrap();
    let import = review_import_draft(&mut store, "import-fixture-1", true);
    assert_eq!(
        import.status,
        zinecv_contracts::ImportDraftStatus::ReviewRequired
    );
    assert!(import.preview_asset_id.is_some());
    assert_eq!(
        store
            .load_current("doc-import", "context-a")
            .unwrap()
            .unwrap()
            .1,
        before,
        "parsing and review must not change the resume"
    );

    let request = ApplyImportRequest {
        command_id: "apply-import-fixture-1".into(),
        cursor: initial_cursor,
        draft_id: import.id,
        accepted_candidate_ids: vec!["candidate-name".into()],
    };
    let applied = store
        .apply_import("local-anonymous", &request)
        .expect("confirm import");
    assert_eq!(applied.document.basic.name, "导入姓名");
    assert_eq!(applied.cursor.revision, "1");
    assert!(applied.durable);
    assert_eq!(
        store.apply_import("local-anonymous", &request).unwrap(),
        applied,
        "retry returns the exact durable receipt"
    );
    assert_eq!(
        store
            .load_cursor("doc-import", "context-a")
            .unwrap()
            .unwrap(),
        applied.cursor
    );
    let terminal = store
        .read_import_draft("import-fixture-1")
        .unwrap()
        .unwrap();
    assert_eq!(
        terminal.status,
        zinecv_contracts::ImportDraftStatus::Committed
    );
    assert!(terminal.preview_asset_id.is_none());
    let preview_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = 'import-fixture-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preview_refs, 0);
}

#[test]
fn cancelling_import_releases_source_preview_and_stale_target_is_rejected() {
    use zinecv_contracts::{ApplyImportRequest, ImportDraftStatus, TransitionImportDraftRequest};

    let (mut store, before) = seeded_store("doc-import-cancel", "context-a");
    let cursor = store
        .load_cursor("doc-import-cancel", "context-a")
        .unwrap()
        .unwrap();
    let draft = review_import_draft(&mut store, "import-fixture-cancel", true);
    store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: draft.id.clone(),
            expected_status: ImportDraftStatus::ReviewRequired,
            next_status: ImportDraftStatus::Cancelled,
            candidates: None,
            warnings: None,
            unsupported_features: None,
            preview_data_url: None,
        })
        .expect("cancel import");
    let terminal = store.read_import_draft(&draft.id).unwrap().unwrap();
    assert_eq!(terminal.status, ImportDraftStatus::Cancelled);
    assert!(terminal.preview_asset_id.is_none());
    let preview_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
            [&draft.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preview_refs, 0);

    let draft = review_import_draft(&mut store, "import-fixture-stale", false);
    edit_title(&mut store, &cursor, "change-before-import", "后续手工标题");
    let stale_request = ApplyImportRequest {
        command_id: "apply-import-stale-target".into(),
        cursor,
        draft_id: draft.id,
        accepted_candidate_ids: vec!["candidate-name".into()],
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &stale_request),
        Err(StorageError::Conflict(_))
    ));
    let current = store
        .load_current("doc-import-cancel", "context-a")
        .unwrap()
        .unwrap()
        .1;
    assert_eq!(current.title, "后续手工标题");
    assert_eq!(current.basic.name, before.basic.name);
}

#[test]
fn failed_import_commit_rolls_back_document_receipt_status_and_preview_release() {
    use zinecv_contracts::ApplyImportRequest;

    let (mut store, before) = seeded_store("doc-import-rollback", "context-a");
    let cursor = store
        .load_cursor("doc-import-rollback", "context-a")
        .unwrap()
        .unwrap();
    let draft = review_import_draft(&mut store, "import-fixture-rollback", true);
    store
        .connection
        .execute_batch(
            "CREATE TRIGGER reject_import_terminal BEFORE UPDATE OF status ON import_drafts
             WHEN NEW.status = 'committed' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
        )
        .unwrap();
    let request = ApplyImportRequest {
        command_id: "apply-import-rollback".into(),
        cursor,
        draft_id: draft.id.clone(),
        accepted_candidate_ids: vec!["candidate-name".into()],
    };
    assert!(store.apply_import("local-anonymous", &request).is_err());
    assert_eq!(
        store
            .load_current("doc-import-rollback", "context-a")
            .unwrap()
            .unwrap()
            .1,
        before
    );
    assert_eq!(
        store.read_import_draft(&draft.id).unwrap().unwrap().status,
        zinecv_contracts::ImportDraftStatus::ReviewRequired
    );
    let receipts: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM command_receipts WHERE command_id = 'apply-import-rollback'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 0);
    let refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
            [&draft.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(refs, 1);
}

#[test]
fn summary_body_command_is_durable_and_idempotent() {
    use zinecv_contracts::{CommandEnvelope, DomainCommand, Inline, RichBlock, Section};
    use zinecv_domain::default_resume_document;

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
    use zinecv_contracts::{BasicPatch, CommandEnvelope, DomainCommand, Section};

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
    let (mut store, initial) = seeded_store("doc-delete-graph", "context-a");
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
    let (mut store, initial) = seeded_store("doc-delete-head", "context-a");
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
    let (mut store, initial) = seeded_store("doc-delete-branch", "context-a");
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
    let (mut store, initial) = seeded_store("doc-delete-current-branch", "context-a");
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
fn deleting_branch_with_resource_draft_clears_draft_refs_and_keeps_shared_assets() {
    use sha2::{Digest, Sha256};
    use zinecv_contracts::{BasicPatch, CommandEnvelope, DomainCommand};

    let mut store = Store::open_in_memory().expect("store");
    let avatar_bytes = b"branch-avatar-bytes".as_slice();
    let avatar = format!("{:x}", Sha256::digest(avatar_bytes));
    store
        .put_resource(&avatar, "image/png", avatar_bytes, None)
        .expect("store avatar");
    let mut initial = document("doc-branch-resource");
    initial.basic.avatar_asset_id = Some(avatar.clone());
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
    let switched = store
        .switch_branch(&feature, &feature.branch_id, false)
        .expect("switch to feature");
    let banner_bytes = b"branch-banner-bytes".as_slice();
    let banner = format!("{:x}", Sha256::digest(banner_bytes));
    store
        .put_resource(&banner, "image/png", banner_bytes, None)
        .expect("store banner");
    // feature 分支草稿引用 banner 资产，产生 draft owner 的 resource_refs。
    let edited = store
        .apply_command(
            "host-actor",
            CommandEnvelope {
                protocol_version: 1,
                command_id: "feature-avatar".into(),
                document_id: switched.document_id.clone(),
                context_id: switched.context_id.clone(),
                expected_revision: switched.revision.clone(),
                expected_branch_id: switched.branch_id.clone(),
                expected_head_id: switched.head_id.clone(),
                payload: DomainCommand::UpdateBasic {
                    patch: BasicPatch {
                        avatar_asset_id: Some(banner.clone()),
                        ..Default::default()
                    },
                },
            },
        )
        .expect("edit avatar on feature")
        .cursor;
    let feature_owner =
        Store::draft_resource_owner_id(&initial.document_id, "context-a", &feature.branch_id);
    let draft_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&feature_owner],
            |row| row.get(0),
        )
        .expect("draft refs before delete");
    assert_eq!(draft_refs, 1, "feature draft 必须先建立 banner 引用");

    let after = store
        .delete_branch(&edited, &feature.branch_id, true)
        .expect("delete feature with live draft");
    assert_eq!(after.branch_id, main.branch_id);
    // 回归断言：删除仍带草稿的分支必须清掉该草稿 owner 的 resource_refs 与
    // resource_recovery_requirements，否则这些资产被 GC 永久占用。
    let draft_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&feature_owner],
            |row| row.get(0),
        )
        .expect("draft refs after delete");
    assert_eq!(draft_refs, 0, "被删分支草稿的资源引用必须被清理");
    let recovery_rows: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_recovery_requirements
             WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&feature_owner],
            |row| row.get(0),
        )
        .expect("recovery rows after delete");
    assert_eq!(recovery_rows, 0, "被删分支草稿的恢复要求必须被清理");
    // 引用保护语义：banner 只被被删草稿引用 → GC 回收；avatar 仍被 main
    // 头快照（snapshot owner）引用 → 必须保留。
    assert_eq!(store.collect_unreferenced_resources().expect("gc"), 1);
    assert!(store
        .read_resource_bytes(&banner)
        .expect("read banner after gc")
        .is_none());
    assert!(store
        .read_resource_bytes(&avatar)
        .expect("read avatar after gc")
        .is_some());
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
fn version_graph_detailed_window_returns_newest_commits_and_keeps_current_head() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "doc-graph-window";
    store
        .initialize_document(&document(document_id), "context-a")
        .expect("init");
    let start = store
        .load_cursor(document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let mut chain = vec![start.head_id.clone().expect("initial head")];
    let mut cursor = start;
    for index in 0..4 {
        let edited = edit_title(
            &mut store,
            &cursor,
            &format!("window-edit-{index}"),
            &format!("标题 {index}"),
        );
        let committed = store
            .commit_draft(&edited, &format!("main commit {index}"))
            .expect("commit");
        chain.push(committed.head_id.clone().expect("head"));
        cursor = committed;
    }
    let main_head = chain[4].clone();
    let side = store
        .create_branch_from_current(&cursor, "side")
        .expect("side");
    let switched = store
        .switch_branch(&side, &side.branch_id, false)
        .expect("switch to side");
    let side_edited = edit_title(&mut store, &switched, "side-edit", "side 标题");
    let side_commit = store
        .commit_draft(&side_edited, "side commit")
        .expect("side commit");
    let side_head = side_commit.head_id.clone().expect("side head");
    chain.push(side_head.clone());
    let back = store
        .switch_branch(&side_commit, &cursor.branch_id, false)
        .expect("back to main");
    assert_eq!(back.head_id.as_deref(), Some(main_head.as_str()));
    // 图中共 7 个提交：baseline、4 次 main 编辑、side 分支创建提交、side 提交。
    // 创建提交不在 chain 里，查出来插入 main_head 与 side_head 之间，统一固定
    // created_at，保证语义顺序与查询排序（created_at DESC, id DESC）一致。
    let creation_commit: String = store
        .connection
        .query_row(
            "SELECT id FROM commits WHERE message = '创建分支：side'",
            [],
            |row| row.get(0),
        )
        .expect("side branch creation commit");
    let mut order: Vec<String> = chain.clone();
    order.insert(5, creation_commit.clone());
    for (index, id) in order.iter().enumerate() {
        let stamp = format!("2026-01-01T00:00:{index:02}");
        store
            .connection
            .execute(
                "UPDATE commits SET created_at = ?1 WHERE id = ?2",
                [&stamp, id],
            )
            .expect("stamp commit");
    }
    let full = store.load_version_graph(document_id).expect("full graph");
    assert_eq!(full.commits.len(), 7);
    assert_eq!(full.commits[0].id, side_head);
    // 分支创建提交在 main_head 之后发生，排序上位于两者之间。
    assert_eq!(full.commits[1].id, creation_commit);
    assert_eq!(full.commits[2].id, main_head);

    let window = store
        .load_version_graph_detailed_with_limit(document_id, 3)
        .expect("window");
    // 结构全量返回：7 个提交一个不少（祖先/共享节点不丢）。
    assert_eq!(window.commits.len(), 7);
    for (index, item) in window.commits.iter().enumerate() {
        assert_eq!(item.commit.id, full.commits[index].id);
        // 只有最新 3 个物化快照；main_head 是第 3 新，也在物化范围内。
        if index < 3 {
            assert!(!item.snapshot_document_json.is_empty());
        } else {
            assert!(item.snapshot_document_json.is_empty());
        }
    }
    // 物化上限 1：当前 head（main 头，第 3 新）不在窗口内也必须物化。
    let narrow = store
        .load_version_graph_detailed_with_limit(document_id, 1)
        .expect("narrow window");
    assert_eq!(narrow.commits.len(), 7);
    assert_eq!(narrow.commits[0].commit.id, side_head);
    assert!(!narrow.commits[0].snapshot_document_json.is_empty());
    assert_eq!(narrow.commits[2].commit.id, main_head);
    assert!(!narrow.commits[2].snapshot_document_json.is_empty());
    assert!(narrow.commits[1].snapshot_document_json.is_empty());
    // 无参调用物化全量（7 ≤ 默认上限），与旧全量实现行为一致。
    let all = store
        .load_version_graph_detailed(document_id)
        .expect("detailed");
    assert_eq!(all.commits.len(), 7);
    assert!(all
        .commits
        .iter()
        .all(|item| !item.snapshot_document_json.is_empty()));
    assert!(matches!(
        store.load_version_graph_detailed_with_limit(document_id, 0),
        Err(StorageError::Validation(_))
    ));
}

#[test]
fn version_graph_detailed_default_limit_bounds_large_graph() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "doc-graph-large";
    store
        .initialize_document(&document(document_id), "context-a")
        .expect("init");
    let start = store
        .load_cursor(document_id, "context-a")
        .expect("cursor")
        .expect("document");
    let initial_head = start.head_id.clone().expect("initial head");
    let initial_snapshot: String = store
        .connection
        .query_row(
            "SELECT snapshot_id FROM commits WHERE id = ?1",
            [&initial_head],
            |row| row.get(0),
        )
        .expect("initial snapshot");
    // 超过默认 1000 物化上限，验证图保留结构且详情可按需读取。
    let seeded = store
        .connection
        .unchecked_transaction()
        .expect("seed transaction");
    for index in 0..1199 {
        let commit_id = format!("commit:{document_id}:seeded-{index:04}");
        let parent = if index == 0 {
            initial_head.clone()
        } else {
            format!("commit:{document_id}:seeded-{:04}", index - 1)
        };
        seeded
            .execute(
                "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    commit_id,
                    document_id,
                    start.branch_id.as_str(),
                    initial_snapshot.as_str(),
                    format!("seeded {index}"),
                    format!("2020-01-01T{:02}:{:02}:00", index / 60, index % 60),
                ],
            )
            .expect("seed commit");
        seeded
            .execute(
                "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
                params![commit_id, parent],
            )
            .expect("seed link");
    }
    seeded.commit().expect("seed commits");

    let full = store.load_version_graph(document_id).expect("full graph");
    assert_eq!(full.commits.len(), 1200);
    assert_eq!(full.commits[0].id, initial_head);
    let detailed = store
        .load_version_graph_detailed(document_id)
        .expect("detailed");
    assert_eq!(detailed.commits.len(), 1200);
    for index in [0usize, 1, 250, 499, 599] {
        assert_eq!(detailed.commits[index].commit.id, full.commits[index].id);
    }
    assert_eq!(
        detailed
            .commits
            .iter()
            .filter(|item| !item.snapshot_document_json.is_empty())
            .count(),
        1000
    );
    let lazy = &detailed.commits[1100];
    assert!(lazy.snapshot_document_json.is_empty());
    let detail = store
        .load_commit_detail(document_id, &lazy.commit.id)
        .expect("detail")
        .expect("visible commit");
    assert_eq!(detail.commit, lazy.commit);
    assert!(!detail.snapshot_document_json.is_empty());
    assert!(store
        .load_commit_detail("other-document", &lazy.commit.id)
        .expect("document scope")
        .is_none());
    // 显式物化上限：结构仍全量，只有最新 limit 个（含 head）物化快照。
    let page = store
        .load_version_graph_detailed_with_limit(document_id, 100)
        .expect("page");
    assert_eq!(page.commits.len(), 1200);
    assert_eq!(page.commits[0].commit.id, full.commits[0].id);
    assert!(!page.commits[99].snapshot_document_json.is_empty());
    assert!(page.commits[100].snapshot_document_json.is_empty());
    assert!(!page.commits[0].snapshot_document_json.is_empty());
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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

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
fn imported_source_contexts_keep_independent_drafts_across_switches_and_restart() {
    let path = std::env::temp_dir().join(format!(
        "zinecv-context-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let document_id = "workspace-default-document";
    let base = document(document_id);
    let mut store = Store::open(&path).expect("store");
    store
        .initialize_document(&base, "workspace-default-context")
        .expect("initialize workspace");
    let default_cursor = store
        .load_active_document(document_id)
        .expect("active workspace")
        .expect("workspace document")
        .0;
    let branch_before = default_cursor.branch_id.clone();
    let commits_before = store
        .commit_count(document_id)
        .expect("initial commit count");

    let mut source_a_seed = base.clone();
    source_a_seed.title = "同名来源 A 初始稿".into();
    let source_a = store
        .switch_editing_context(
            &default_cursor,
            EditingContextSourceKind::ImportedTemplate,
            "source-a-id",
            Some(&source_a_seed),
        )
        .expect("open source A");
    assert!(source_a.created);
    assert_ne!(source_a.cursor.context_id, default_cursor.context_id);
    let source_a_context = source_a.cursor.context_id.clone();
    let edited_a = edit_title(
        &mut store,
        &source_a.cursor,
        "r04-edit-a",
        "来源 A 未提交草稿",
    );

    let mut source_b_seed = base.clone();
    source_b_seed.title = "同名来源 B 初始稿".into();
    let source_b = store
        .switch_editing_context(
            &edited_a,
            EditingContextSourceKind::ImportedTemplate,
            "source-b-id",
            Some(&source_b_seed),
        )
        .expect("open same-name source B");
    assert!(source_b.created);
    assert_ne!(source_a_context, source_b.cursor.context_id);
    assert_eq!(source_b.document.title, "同名来源 B 初始稿");
    let edited_b = edit_title(
        &mut store,
        &source_b.cursor,
        "r04-edit-b",
        "来源 B 未提交草稿",
    );

    let returned_a = store
        .switch_editing_context(
            &edited_b,
            EditingContextSourceKind::ImportedTemplate,
            "source-a-id",
            Some(&base),
        )
        .expect("return to source A");
    assert!(!returned_a.created);
    assert_eq!(returned_a.cursor.context_id, source_a_context);
    assert_eq!(returned_a.document.title, "来源 A 未提交草稿");
    assert_eq!(returned_a.cursor.branch_id, branch_before);
    assert_eq!(
        store.commit_count(document_id).expect("commit count"),
        commits_before
    );

    assert!(matches!(
        store.switch_editing_context(
            &returned_a.cursor,
            EditingContextSourceKind::ImportedTemplate,
            "  ",
            Some(&base),
        ),
        Err(StorageError::Validation(_))
    ));
    assert!(matches!(
        store.switch_editing_context(
            &edited_b,
            EditingContextSourceKind::ImportedTemplate,
            "source-b-id",
            Some(&base),
        ),
        Err(StorageError::Conflict(_))
    ));

    let returned_b = store
        .switch_editing_context(
            &returned_a.cursor,
            EditingContextSourceKind::ImportedTemplate,
            "source-b-id",
            Some(&base),
        )
        .expect("retry source B after stale request");
    assert_eq!(returned_b.document.title, "来源 B 未提交草稿");
    drop(store);

    let mut reopened = Store::open(&path).expect("reopen isolated profile");
    let after_restart = reopened
        .load_active_document(document_id)
        .expect("load active document")
        .expect("active source B");
    assert_eq!(after_restart.0.context_id, returned_b.cursor.context_id);
    assert_eq!(after_restart.1.title, "来源 B 未提交草稿");
    let after_restart_a = reopened
        .switch_editing_context(
            &after_restart.0,
            EditingContextSourceKind::ImportedTemplate,
            "source-a-id",
            Some(&base),
        )
        .expect("reload source A after restart");
    assert_eq!(after_restart_a.document.title, "来源 A 未提交草稿");
    let after_restart_b = reopened
        .switch_editing_context(
            &after_restart_a.cursor,
            EditingContextSourceKind::ImportedTemplate,
            "source-b-id",
            Some(&base),
        )
        .expect("reload source B after restart");
    assert_eq!(after_restart_b.document.title, "来源 B 未提交草稿");
    assert_eq!(
        stable_editing_context_id(EditingContextSourceKind::ImportedTemplate, "source-a-id"),
        source_a_context
    );

    drop(reopened);
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if candidate.exists() {
            std::fs::remove_file(candidate).expect("cleanup isolated database");
        }
    }
}

#[test]
fn history_load_activates_the_snapshot_source_and_preserves_other_source_draft() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "workspace-default-document";
    let base = document(document_id);
    store
        .initialize_document(&base, "workspace-default-context")
        .expect("initialize workspace");
    let initial_cursor = store
        .load_active_document(document_id)
        .expect("active workspace")
        .expect("workspace document")
        .0;

    let mut source_a_seed = base.clone();
    source_a_seed.title = "来源 A 初始稿".into();
    source_a_seed.legacy_extensions.insert(
        "importedTemplate".into(),
        serde_json::json!({ "id": "history-source-a", "name": "旧名称 A" }),
    );
    let source_a = store
        .switch_editing_context(
            &initial_cursor,
            EditingContextSourceKind::ImportedTemplate,
            "history-source-a",
            Some(&source_a_seed),
        )
        .expect("switch to source A");
    let source_a_context = source_a.cursor.context_id.clone();
    let committed_a_cursor = edit_title(
        &mut store,
        &source_a.cursor,
        "r04-history-a-commit",
        "来源 A 已提交",
    );
    store
        .commit_draft(&committed_a_cursor, "来源 A")
        .expect("commit source A");
    let current_a = store
        .load_active_document(document_id)
        .expect("load committed source A")
        .expect("source A state")
        .0;
    let dirty_a = edit_title(
        &mut store,
        &current_a,
        "r04-history-a-draft",
        "来源 A 未提交修改",
    );

    let mut source_b_seed = base.clone();
    source_b_seed.title = "来源 B 初始稿".into();
    source_b_seed.legacy_extensions.insert(
        "importedTemplate".into(),
        serde_json::json!({ "id": "history-source-b", "name": "B" }),
    );
    let source_b = store
        .switch_editing_context(
            &dirty_a,
            EditingContextSourceKind::ImportedTemplate,
            "history-source-b",
            Some(&source_b_seed),
        )
        .expect("switch to source B");
    let edited_b = edit_title(
        &mut store,
        &source_b.cursor,
        "r04-history-b-commit",
        "来源 B 历史版本",
    );
    let committed_b = store
        .commit_draft(&edited_b, "来源 B 历史")
        .expect("commit source B");
    let current_b = store
        .load_active_document(document_id)
        .expect("load committed source B")
        .expect("source B state")
        .0;
    let current_a = store
        .switch_editing_context(
            &current_b,
            EditingContextSourceKind::ImportedTemplate,
            "history-source-a",
            Some(&base),
        )
        .expect("return to source A")
        .cursor;

    let restored = store
        .load_commit_into_draft(
            &current_a,
            committed_b.head_id.as_deref().expect("source B commit ID"),
            true,
        )
        .expect("load source B history commit");
    store
        .write_imported_template_catalog(
            r#"[{"id":"history-source-a"},{"id":"history-source-b"}]"#,
            0,
        )
        .expect("store source catalog");
    store
        .write_imported_template_catalog(r#"[{"id":"history-source-b"}]"#, 1)
        .expect("delete source A from catalog");
    assert!(!store
        .contains_imported_template("history-source-a")
        .expect("source A is no longer selectable"));
    assert_eq!(restored.context_id, source_b.cursor.context_id);
    let active = store
        .load_active_document(document_id)
        .expect("active source after history load")
        .expect("history-loaded document");
    assert_eq!(active.0, restored);
    assert_eq!(active.1.title, "来源 B 历史版本");
    assert_eq!(
        store
            .load_draft(document_id, &source_a_context)
            .expect("source A durable draft")
            .expect("source A draft remains")
            .1
            .title,
        "来源 A 未提交修改"
    );
}

#[test]
fn context_selection_does_not_recover_a_draft_from_another_branch() {
    let mut store = Store::open_in_memory().expect("store");
    let document_id = "workspace-default-document";
    let base = document(document_id);
    store
        .initialize_document(&base, "workspace-default-context")
        .expect("initialize workspace");
    let initial = store
        .load_active_document(document_id)
        .expect("active workspace")
        .expect("workspace document")
        .0;
    let mut a_seed = base.clone();
    a_seed.title = "A 分支草稿基线".into();
    let a = store
        .switch_editing_context(
            &initial,
            EditingContextSourceKind::ImportedTemplate,
            "branch-source-a",
            Some(&a_seed),
        )
        .expect("switch to A");
    let dirty_a = edit_title(&mut store, &a.cursor, "r04-branch-a-edit", "A 子分支内容");
    let child = store
        .create_branch_from_current(&dirty_a, "A child")
        .expect("create child from A content");
    let main_branch_id = initial.branch_id;

    let mut b_seed = base.clone();
    b_seed.title = "B 子分支初始稿".into();
    let b = store
        .switch_editing_context(
            &child,
            EditingContextSourceKind::ImportedTemplate,
            "branch-source-b",
            Some(&b_seed),
        )
        .expect("switch to B on child");
    let dirty_b = edit_title(&mut store, &b.cursor, "r04-branch-b-edit", "B 子分支未提交");
    assert!(matches!(
        store.switch_branch(&dirty_b, &main_branch_id, false),
        Err(StorageError::Conflict(_))
    ));
    let main = store
        .switch_branch(&dirty_b, &main_branch_id, true)
        .expect("confirmed switch to main");
    let a_on_main = store
        .switch_editing_context(
            &main,
            EditingContextSourceKind::ImportedTemplate,
            "branch-source-a",
            Some(&base),
        )
        .expect("load A from main head");
    assert_eq!(a_on_main.document.title, "测试");
    assert_eq!(a_on_main.cursor.branch_id, main_branch_id);

    let child_again = store
        .switch_branch(&a_on_main.cursor, &child.branch_id, true)
        .expect("return to child branch");
    let child_state = store
        .load_active_document(document_id)
        .expect("load child active state")
        .expect("child document");
    assert_eq!(child_state.0, child_again);
    assert_eq!(child_state.1.title, "A 子分支内容");
}

#[test]
fn migrates_and_round_trips_draft() {
    let store = Store::open_in_memory().expect("store");
    assert_eq!(
        store.migration_versions().expect("versions"),
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

    let (mut store, initial) = seeded_store("doc-commit-guard", "context-a");
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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

    let (mut store, initial) = seeded_store("doc-branches", "context-a");
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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

    let (mut store, initial) = seeded_store("doc-switch", "context-a");
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
    let (mut store, initial) = seeded_store("doc-switch-committed", "context-a");
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
    let (mut store, initial) = seeded_store("doc-target-draft", "context-a");
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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

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
    use zinecv_contracts::{CommandEnvelope, DomainCommand};

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
    std::fs::write(&path, b"this is definitely not a SQLite database").expect("seed corrupt file");
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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
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
    })
    .to_string();
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
fn agent_runs_freeze_target_and_keep_account_scoped_terminal_state() {
    let path = std::env::temp_dir().join(format!(
        "zinecv-agent-runs-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let alice_id;
    let bob_id;
    {
        let mut store = Store::open(&path).expect("store");
        alice_id = store
            .register_account("run-alice@example.com", "strong-password-123")
            .expect("alice")
            .id;
        bob_id = store
            .register_account("run-bob@example.com", "strong-password-456")
            .expect("bob")
            .id;
        let document = zinecv_domain::default_resume_document("doc-run").expect("document");
        store
            .initialize_document(&document, "context-run")
            .expect("initialize");
        let cursor = store
            .load_cursor("doc-run", "context-run")
            .expect("cursor")
            .unwrap();
        let mut stale = cursor.clone();
        stale.revision = "999".into();
        assert!(matches!(
            store.begin_agent_run(&alice_id, "run-stale", "session-a", &stale, &[]),
            Err(StorageError::Conflict(_))
        ));
        store
            .begin_agent_run(
                &alice_id,
                "run-12345678",
                "session-a",
                &cursor,
                &["basic:name".into()],
            )
            .expect("begin");
        store
            .update_agent_run_state(&alice_id, "run-12345678", 1, "running", 1, 1, 0, None)
            .expect("record running state");
        store
            .persist_agent_run_delta(&alice_id, "run-12345678", 1, 2, "synthetic partial")
            .expect("persist received text");
        store
            .update_agent_run_state(
                &alice_id,
                "run-12345678",
                1,
                "awaiting_confirmation",
                3,
                1,
                1,
                None,
            )
            .expect("record pending confirmation");
        assert!(store
            .begin_agent_run(&alice_id, "run-12345678", "session-a", &cursor, &[])
            .is_err());
        assert!(store.list_agent_runs(&bob_id).expect("bob runs").is_empty());
        assert!(matches!(
            store.finish_agent_run(&bob_id, "run-12345678", "cancelled"),
            Err(StorageError::Conflict(_))
        ));
        store
            .finish_agent_run(&alice_id, "run-12345678", "completed")
            .expect("finish");
        store
            .begin_agent_run_with_epoch(&alice_id, "run-restart-123", "session-a", &cursor, &[], 42)
            .expect("begin process-restart fixture");
        store
            .update_agent_run_state(&alice_id, "run-restart-123", 42, "running", 0, 1, 0, None)
            .expect("mark restart fixture running");
        store
            .persist_agent_run_delta(&alice_id, "run-restart-123", 42, 1, "preserved partial")
            .expect("persist restart fixture text");
        store
            .finish_agent_run(&alice_id, "run-12345678", "completed")
            .expect("idempotent finish");
        assert!(matches!(
            store.finish_agent_run(&alice_id, "run-12345678", "failed"),
            Err(StorageError::Conflict(_))
        ));
    }
    {
        let store = Store::open(&path).expect("reopen");
        let runs = store.list_agent_runs(&alice_id).expect("alice runs");
        assert_eq!(runs.len(), 2);
        let completed = runs
            .iter()
            .find(|run| run.id == "run-12345678")
            .expect("completed run");
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.session_id, "session-a");
        assert_eq!(completed.reference_ids, vec!["basic:name"]);
        assert_eq!(completed.target.document_id, "doc-run");
        assert!(completed.finished_at.is_some());
        assert_eq!(completed.lifecycle_state, "completed");
        assert_eq!(completed.last_seq, 3);
        assert_eq!(completed.epoch, 1);
        assert_eq!(completed.partial_text, "synthetic partial");
        let interrupted = runs
            .iter()
            .find(|run| run.id == "run-restart-123")
            .expect("interrupted run");
        assert_eq!(interrupted.status, "failed");
        assert_eq!(interrupted.lifecycle_state, "failed");
        assert_eq!(interrupted.epoch, 42);
        assert_eq!(interrupted.partial_text, "preserved partial");
        assert_eq!(
            interrupted.interrupted_reason.as_deref(),
            Some("interrupted by process restart")
        );
        assert!(store.list_agent_runs(&bob_id).expect("bob runs").is_empty());
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
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
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

fn imported_template_with_preview(id: &str, preview_data_url: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": "合成模板",
        "sourceName": "synthetic.pdf",
        "sourceType": "pdf",
        "createdAt": "2026-10-01T00:00:00.000Z",
        "previewDataUrl": preview_data_url,
        "accent": "#224466",
        "formatId": "legacy-v1",
        "layout": "single-column",
        "analysis": "合成版式分析",
        "extractedText": "合成文本内容",
        "detectedFont": "Source Han Serif",
        "presentation": { "fontSetId": "legacy-font:Source Han Serif" }
    })
}

fn synthetic_preview_data_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[test]
fn imported_template_preview_is_externalized_and_revision_is_immutable() {
    let mut store = Store::open_in_memory().expect("store");
    let bytes = b"synthetic-template-preview";
    let payload = serde_json::to_string(&vec![imported_template_with_preview(
        "template-stable-id",
        &synthetic_preview_data_url(bytes),
    )])
    .expect("catalog payload");
    assert_eq!(
        store
            .write_imported_template_catalog(&payload, 0)
            .expect("write catalog"),
        1
    );

    let catalog = store
        .read_imported_template_catalog()
        .expect("read catalog")
        .expect("catalog");
    let mut value: serde_json::Value =
        serde_json::from_str(&catalog.payload_json).expect("stored catalog JSON");
    let template = value[0].as_object_mut().expect("template object");
    let hash = format!("{:x}", Sha256::digest(bytes));
    assert_eq!(template["previewAssetId"], hash);
    assert!(!template.contains_key("previewDataUrl"));
    let revision_hash = template["revisionHash"]
        .as_str()
        .expect("revision hash")
        .to_string();
    assert_eq!(template["revisionStatus"], "current");
    assert_eq!(template["knownRevisions"][0]["revisionHash"], revision_hash);
    let (mime, stored_bytes) = store
        .read_resource_bytes(&hash)
        .expect("read preview")
        .expect("preview bytes");
    assert_eq!(mime, "image/png");
    assert_eq!(stored_bytes, bytes);
    let retained_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs
             WHERE resource_hash = ?1 AND owner_kind = 'retained-template'
               AND owner_id = 'template-stable-id'",
            [&hash],
            |row| row.get(0),
        )
        .expect("retained template reference");
    assert_eq!(retained_refs, 1);
    let manifest_json: String = store
        .connection
        .query_row(
            "SELECT manifest_json FROM template_revisions
             WHERE template_id = 'template-stable-id' AND revision_hash = ?1",
            [&revision_hash],
            |row| row.get(0),
        )
        .expect("immutable manifest");
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json).expect("manifest JSON");
    assert!(manifest.pointer("/source/extractedTextHash").is_some());
    assert!(manifest.pointer("/fontIdentity/fontBundleHash").is_some());
    assert!(manifest
        .pointer("/engineIdentity/engineSourceHash")
        .is_some());
    assert_eq!(manifest["resources"][0], hash);

    store
        .update_template_activity("template-stable-id", "favorite")
        .expect("favorite activity");
    value[0]["name"] = serde_json::Value::String("重命名模板".into());
    assert_eq!(
        store
            .write_imported_template_catalog(
                &serde_json::to_string(&value).expect("renamed JSON"),
                1,
            )
            .expect("rename"),
        2
    );
    let renamed = store
        .read_imported_template_catalog()
        .expect("read renamed")
        .expect("catalog");
    let renamed: serde_json::Value =
        serde_json::from_str(&renamed.payload_json).expect("renamed catalog JSON");
    assert_eq!(renamed[0]["revisionHash"], revision_hash);
    assert_eq!(
        store.list_template_activity().expect("activity").len(),
        1,
        "catalog revision writes do not fold activity into document/template content"
    );

    store
        .write_imported_template_catalog("[]", 2)
        .expect("remove template directory entry");
    assert_eq!(store.collect_unreferenced_resources().expect("gc"), 1);
    let recovery_count: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_recovery_requirements
             WHERE owner_kind = 'template-revision' AND resource_hash = ?1",
            [&hash],
            |row| row.get(0),
        )
        .expect("recovery record");
    assert!(recovery_count >= 1);
}

#[test]
fn deleted_template_keeps_resources_referenced_by_history_and_backup() {
    let mut store = Store::open_in_memory().expect("store");
    let bytes = b"preview-kept-by-history";
    let payload = serde_json::to_string(&vec![imported_template_with_preview(
        "template-history",
        &synthetic_preview_data_url(bytes),
    )])
    .expect("catalog payload");
    store
        .write_imported_template_catalog(&payload, 0)
        .expect("write template");
    let catalog = store
        .read_imported_template_catalog()
        .expect("read catalog")
        .expect("catalog");
    let value: serde_json::Value =
        serde_json::from_str(&catalog.payload_json).expect("catalog JSON");
    let revision_hash = value[0]["revisionHash"]
        .as_str()
        .expect("revision hash")
        .to_string();
    let asset_hash = value[0]["previewAssetId"]
        .as_str()
        .expect("asset hash")
        .to_string();
    let mut historical = document("doc-template-history");
    historical.legacy_extensions.insert(
        "importedTemplate".into(),
        serde_json::json!({ "id": "template-history", "name": "合成模板", "revisionHash": revision_hash }),
    );
    store
        .initialize_document(&historical, "workspace-default-context")
        .expect("initialize historic document");
    store
        .write_imported_template_catalog("[]", 1)
        .expect("delete current directory entry");
    let loaded_history = store
        .load_active_document("doc-template-history")
        .expect("load saved template history")
        .expect("active historical document");
    assert_eq!(
        loaded_history.1.legacy_extensions["importedTemplate"]["revisionHash"],
        revision_hash
    );
    let rendered = zinecv_engine::render_document_pdf(&loaded_history.1, None)
        .expect("render saved history with the available renderer");
    assert!(rendered.starts_with(b"%PDF-"));
    assert_eq!(store.collect_unreferenced_resources().expect("gc"), 0);
    let history_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE resource_hash = ?1
             AND owner_kind IN ('draft', 'snapshot')",
            [&asset_hash],
            |row| row.get(0),
        )
        .expect("durable refs");
    assert_eq!(history_refs, 2);

    let path = std::env::temp_dir().join(format!(
        "zinecv-r05-resource-backup-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    store.backup_to(&path).expect("backup with assets");
    {
        let backup = Store::open(&path).expect("open backup");
        assert!(backup
            .read_resource_bytes(&asset_hash)
            .expect("backup asset read")
            .is_some());
        let manifest_count: i64 = backup
            .connection
            .query_row(
                "SELECT COUNT(*) FROM template_revisions WHERE template_id = 'template-history'",
                [],
                |row| row.get(0),
            )
            .expect("backup revision manifest");
        assert_eq!(manifest_count, 1);
        let ref_count: i64 = backup
            .connection
            .query_row(
                "SELECT COUNT(*) FROM resource_refs WHERE resource_hash = ?1",
                [&asset_hash],
                |row| row.get(0),
            )
            .expect("backup asset references");
        assert_eq!(ref_count, 2);
    }
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if candidate.exists() {
            std::fs::remove_file(candidate).expect("cleanup backup database");
        }
    }
}

#[test]
fn draft_and_snapshot_asset_refs_survive_reopen_and_leases_expire_before_gc() {
    let path = std::env::temp_dir().join(format!(
        "zinecv-r05-draft-assets-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    let bytes = b"synthetic-avatar-for-r05";
    let hash = format!("{:x}", Sha256::digest(bytes));
    {
        let mut store = Store::open(&path).expect("file store");
        store
            .put_resource(&hash, "image/png", bytes, None)
            .expect("avatar resource");
        let mut source = document("doc-r05-avatar");
        source.basic.avatar_asset_id = Some(hash.clone());
        store
            .initialize_document(&source, "workspace-default-context")
            .expect("initialize avatar document");
    }
    {
        let store = Store::open(&path).expect("reopen store");
        assert_eq!(store.collect_unreferenced_resources().expect("gc"), 0);
        assert!(store
            .read_resource_bytes(&hash)
            .expect("read avatar after reopen")
            .is_some());
        let refs: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM resource_refs WHERE resource_hash = ?1
                 AND owner_kind IN ('draft', 'snapshot')",
                [&hash],
                |row| row.get(0),
            )
            .expect("draft and snapshot refs");
        assert_eq!(refs, 2);
    }
    {
        let store = Store::open_in_memory().expect("lease store");
        store
            .put_resource(&hash, "image/png", bytes, None)
            .expect("lease resource");
        let lease = store
            .create_resource_lease(std::slice::from_ref(&hash), 30)
            .expect("bounded lease");
        assert_eq!(
            store.collect_unreferenced_resources().expect("leased gc"),
            0
        );
        assert!(matches!(
            store.create_resource_lease(std::slice::from_ref(&hash), 901),
            Err(StorageError::Validation(_))
        ));
        store
            .connection
            .execute(
                "UPDATE resource_leases SET expires_at = 0 WHERE lease_id = ?1",
                [&lease],
            )
            .expect("expire lease");
        assert_eq!(
            store.collect_unreferenced_resources().expect("expired gc"),
            1
        );
    }
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        if candidate.exists() {
            std::fs::remove_file(candidate).expect("cleanup file store");
        }
    }
}

#[test]
fn unknown_template_revision_recovery_uses_the_durable_document_owner() {
    let store = Store::open_in_memory().expect("store");
    let draft_json = serde_json::json!({
        "legacyExtensions": {
            "importedTemplate": {
                "id": "template-missing-manifest",
                "revisionHash": "missing-revision-hash"
            }
        }
    })
    .to_string();
    resources::sync_document_resource_owner(&store.connection, "draft", "draft-owner", &draft_json)
        .expect("record draft recovery requirement");
    resources::sync_document_resource_owner(&store.connection, "draft", "draft-owner", &draft_json)
        .expect("resync draft recovery requirement");

    let (owner_kind, owner_id, resource_hash, recovery_count): (
        String,
        String,
        Option<String>,
        i64,
    ) = store
        .connection
        .query_row(
            "SELECT owner_kind, owner_id, resource_hash,
                   (SELECT COUNT(*) FROM resource_recovery_requirements)
                 FROM resource_recovery_requirements",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("recovery owner");
    assert_eq!(owner_kind, "draft");
    assert_eq!(owner_id, "draft-owner");
    assert_eq!(resource_hash, None);
    assert_eq!(recovery_count, 1);
}

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

#[test]
fn legacy_template_previews_reprepared_catalog_replays_but_review_changes_conflict() {
    let (mut store, initial) = seeded_store("template-reprepared", "context-a");
    let cursor = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let (request, _, _) = legacy_template_preview_request(cursor);
    store
        .commit_legacy_migration("test-actor", &request)
        .unwrap();
    let stored = store.read_imported_template_catalog().unwrap().unwrap();
    let mut replay = request.clone();
    replay.command_id = "template-reprepared-replay".into();
    replay.templates.as_mut().unwrap().expected_revision = stored.revision.to_string();
    replay.templates.as_mut().unwrap().catalog_json = stored.payload_json.clone();
    assert!(
        store
            .commit_legacy_migration("test-actor", &replay)
            .unwrap()
            .idempotent_replay
    );
    assert_eq!(
        store
            .read_imported_template_catalog()
            .unwrap()
            .unwrap()
            .revision,
        stored.revision
    );
    let mut changed = replay.clone();
    changed.command_id = "template-review-changed".into();
    let mut catalog: serde_json::Value = serde_json::from_str(&stored.payload_json).unwrap();
    catalog[0]["name"] = "Actually different reviewed template".into();
    changed.templates.as_mut().unwrap().catalog_json = catalog.to_string();
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &changed),
        Err(StorageError::Conflict(_))
    ));
    assert_eq!(
        store
            .read_imported_template_catalog()
            .unwrap()
            .unwrap()
            .payload_json,
        stored.payload_json
    );
    let mut image_changed = replay;
    image_changed.command_id = "template-image-changed".into();
    catalog[0]["name"] = "Synthetic template".into();
    catalog[0]["previewAssetId"] = "0".repeat(64).into();
    image_changed.templates.as_mut().unwrap().catalog_json = catalog.to_string();
    assert!(matches!(
        store.commit_legacy_migration("test-actor", &image_changed),
        Err(StorageError::Conflict(_))
    ));
}

#[test]
fn replacement_rejects_unresolved_and_foreign_heads_without_mutating_draft_or_graph() {
    let (mut store, initial) = seeded_store("replace-head-validation", "context-a");
    let other = document("replace-head-foreign");
    store.initialize_document(&other, "context-a").unwrap();
    let foreign_head = store
        .load_cursor(&other.document_id, "context-a")
        .unwrap()
        .unwrap()
        .head_id
        .unwrap();
    let before = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let current = store
        .load_current(&initial.document_id, "context-a")
        .unwrap();
    let count = store.commit_count(&initial.document_id).unwrap();
    for head in ["missing-head", foreign_head.as_str()] {
        let result = store.replace_version_store(
            &before,
            "main",
            &[ReplaceBranch {
                id: "main".into(),
                name: "main".into(),
                head_commit_id: Some(head.into()),
                created_at: "2026-10-25T00:00:00Z".into(),
            }],
            &[],
        );
        assert!(matches!(result, Err(StorageError::Validation(_))));
        assert_eq!(
            store
                .load_cursor(&initial.document_id, "context-a")
                .unwrap()
                .unwrap(),
            before
        );
        assert_eq!(
            store
                .load_current(&initial.document_id, "context-a")
                .unwrap(),
            current
        );
        assert_eq!(store.commit_count(&initial.document_id).unwrap(), count);
    }
}

#[test]
fn deleting_history_reclaims_only_unreferenced_snapshots_and_keeps_durable_drafts() {
    fn set_avatar(
        store: &mut Store,
        cursor: &AuthorityCursor,
        id: &str,
        hash: &str,
    ) -> AuthorityCursor {
        store
            .apply_command(
                "host-actor",
                zinecv_contracts::CommandEnvelope {
                    protocol_version: 1,
                    command_id: id.into(),
                    document_id: cursor.document_id.clone(),
                    context_id: cursor.context_id.clone(),
                    expected_revision: cursor.revision.clone(),
                    expected_branch_id: cursor.branch_id.clone(),
                    expected_head_id: cursor.head_id.clone(),
                    payload: zinecv_contracts::DomainCommand::UpdateBasic {
                        patch: zinecv_contracts::BasicPatch {
                            avatar_asset_id: Some(hash.into()),
                            ..Default::default()
                        },
                    },
                },
            )
            .unwrap()
            .cursor
    }
    let mut store = Store::open_in_memory().unwrap();
    let assets: Vec<String> = [
        b"main-asset".as_slice(),
        b"history-asset".as_slice(),
        b"branch-asset".as_slice(),
        b"other-document-asset".as_slice(),
    ]
    .iter()
    .map(|bytes| {
        let hash = format!("{:x}", Sha256::digest(bytes));
        store.put_resource(&hash, "image/png", bytes, None).unwrap();
        hash
    })
    .collect();
    let mut initial = document("prune-history-snapshots");
    initial.basic.avatar_asset_id = Some(assets[0].clone());
    store.initialize_document(&initial, "context-a").unwrap();
    let mut other = document("prune-other-document");
    other.basic.avatar_asset_id = Some(assets[3].clone());
    store.initialize_document(&other, "context-a").unwrap();
    let first = store
        .load_cursor(&initial.document_id, "context-a")
        .unwrap()
        .unwrap();
    let edited = set_avatar(&mut store, &first, "prune-edit", &assets[1]);
    let second = store.commit_draft(&edited, "second").unwrap();
    let baseline_count = store.snapshot_count().unwrap();
    let after = store
        .delete_commit(&second, second.head_id.as_deref().unwrap(), true)
        .unwrap();
    assert_eq!(store.snapshot_count().unwrap(), baseline_count - 1);
    assert_eq!(
        store
            .load_current(&initial.document_id, "context-a")
            .unwrap()
            .unwrap()
            .1
            .basic
            .avatar_asset_id,
        Some(assets[1].clone())
    );
    let snapshot_refs: i64 = store.connection.query_row(
        "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'snapshot' AND resource_hash = ?1",
        [&assets[1]], |row| row.get(0),
    ).unwrap();
    assert_eq!(snapshot_refs, 0, "deleted snapshot must release its owner");
    // The deleted head was materialized as a durable draft before pruning.
    let draft_refs: i64 = store
        .connection
        .query_row(
            "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'draft' AND resource_hash = ?1",
            [&assets[1]],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(draft_refs, 1);
    let staged_lease = store
        .create_resource_lease(&[assets[2].clone()], 60)
        .unwrap();
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
    assert!(
        store.read_resource_bytes(&assets[1]).unwrap().is_some(),
        "durable draft must retain the deleted head's asset"
    );
    store.release_resource_lease(&staged_lease).unwrap();
    let side = store.create_branch_from_current(&after, "side").unwrap();
    let shared_count = store.snapshot_count().unwrap();
    let side_head = side.head_id.as_deref().unwrap();
    let shared = store.create_branch_from_current(&side, "shared").unwrap();
    let shared = store.delete_commit(&shared, side_head, true).unwrap();
    assert_eq!(
        store.snapshot_count().unwrap(),
        shared_count,
        "another commit still owns the shared snapshot"
    );
    let side = store.delete_branch(&shared, &side.branch_id, true).unwrap();
    let changed = set_avatar(&mut store, &side, "prune-side-edit", &assets[2]);
    let side = store.commit_draft(&changed, "exclusive").unwrap();
    let back = store.switch_branch(&side, &after.branch_id, true).unwrap();
    let before_branch = store.snapshot_count().unwrap();
    store.delete_branch(&back, &side.branch_id, true).unwrap();
    assert!(store.snapshot_count().unwrap() < before_branch);
    let orphan_owners: i64 = store.connection.query_row(
        "SELECT COUNT(*) FROM resource_refs WHERE owner_kind = 'snapshot' AND owner_id NOT IN (SELECT id FROM snapshots)",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(orphan_owners, 0);
    assert_eq!(store.collect_unreferenced_resources().unwrap(), 2);
    for hash in [&assets[1], &assets[2]] {
        assert!(
            store.read_resource_bytes(hash).unwrap().is_none(),
            "removed history asset retained"
        );
    }
    for hash in [&assets[0], &assets[3]] {
        assert!(
            store.read_resource_bytes(hash).unwrap().is_some(),
            "live document asset removed"
        );
    }
    assert_eq!(
        store
            .load_current(&other.document_id, "context-a")
            .unwrap()
            .unwrap()
            .1,
        other
    );
}

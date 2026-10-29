use super::*;

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
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
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

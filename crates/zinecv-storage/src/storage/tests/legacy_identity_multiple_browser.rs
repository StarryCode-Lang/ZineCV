use super::*;

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

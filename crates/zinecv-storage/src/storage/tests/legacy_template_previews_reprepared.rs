use super::*;

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

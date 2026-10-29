use super::*;
use zinecv_contracts::{
    ArchiveDocumentRequest, CreateDocumentPayload, CreateDocumentRequest, DeleteJobMaterialRequest,
    LinkJobMaterialRequest, RestoreDocumentRequest, UnlinkJobMaterialRequest,
    UpsertJobMaterialRequest,
};

const ACTOR: &str = "local-anonymous";

fn workspace() -> Store {
    let (mut store, _) = seeded_store("doc-a", "context-a");
    store
        .initialize_document(&document("doc-b"), "context-b")
        .unwrap();
    store
        .write_setting("active-document-id", Some("doc-a"))
        .unwrap();
    store
}

fn create_request(command_id: &str, duplicate: bool) -> CreateDocumentRequest {
    CreateDocumentRequest {
        command_id: command_id.into(),
        expected_current_id: "doc-a".into(),
        expected_epoch: 7,
        payload: if duplicate {
            CreateDocumentPayload::Duplicate {
                source_document_id: "doc-a".into(),
                initial_title: None,
            }
        } else {
            CreateDocumentPayload::Blank {
                initial_title: "新简历".into(),
            }
        },
    }
}

fn material_request(command_id: &str, document_id: &str) -> UpsertJobMaterialRequest {
    UpsertJobMaterialRequest {
        command_id: command_id.into(),
        document_id: document_id.into(),
        expected_epoch: 7,
        job_material: None,
        title: "原始岗位".into(),
        company: "合成公司".into(),
        job_description: "真实旧依据".into(),
        source_note: String::new(),
    }
}

fn link_request(
    store: &Store,
    command_id: &str,
    material: &zinecv_contracts::JobMaterial,
) -> LinkJobMaterialRequest {
    let cursor = store
        .load_active_document(&material.document_id)
        .unwrap()
        .unwrap()
        .0;
    LinkJobMaterialRequest {
        command_id: command_id.into(),
        branch_id: cursor.branch_id.clone(),
        cursor,
        job_material_id: material.id.clone(),
        job_material_revision: material.revision,
    }
}

fn block_receipts(store: &Store) {
    store
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_mutation_receipt BEFORE INSERT ON command_receipts
        BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;",
        )
        .unwrap();
}

#[test]
fn document_creation_receipts_are_atomic_and_replay_without_selecting_again() {
    for duplicate in [false, true] {
        let mut store = workspace();
        let request = create_request("create-once", duplicate);
        let source = store.load_active_document("doc-a").unwrap().unwrap();
        let receipt = store.create_document_with_receipt(ACTOR, &request).unwrap();
        assert_eq!(receipt.document_id, "doc:create-once");
        let source_after = store.load_active_document("doc-a").unwrap().unwrap();
        assert_eq!(source_after.0.revision, "1");
        assert_eq!(source_after.1, source.1);
        assert_eq!(
            store
                .load_version_graph_detailed(&receipt.document_id)
                .unwrap()
                .commits
                .len(),
            1
        );
        store
            .persist_active_document_transition(Some(&receipt.document_id), "doc-b")
            .unwrap();
        let before_retry = store.load_active_document(&receipt.document_id).unwrap();
        assert_eq!(
            store.create_document_with_receipt(ACTOR, &request).unwrap(),
            receipt
        );
        assert_eq!(
            store.read_setting("active-document-id").unwrap().as_deref(),
            Some("doc-b")
        );
        assert_eq!(
            store.load_active_document(&receipt.document_id).unwrap(),
            before_retry
        );
        let mut changed = request.clone();
        changed.payload = CreateDocumentPayload::Blank {
            initial_title: "different".into(),
        };
        assert!(store.create_document_with_receipt(ACTOR, &changed).is_err());
        assert!(store
            .create_document_with_receipt("different-actor", &request)
            .is_err());
    }
}

#[test]
fn creation_receipt_failure_rolls_back_graph_selection_and_authority() {
    let mut store = workspace();
    let before = store.load_active_document("doc-a").unwrap();
    let graph = store.load_version_graph_detailed("doc-a").unwrap();
    block_receipts(&store);
    assert!(store
        .create_document_with_receipt(ACTOR, &create_request("failed-create", true))
        .is_err());
    assert!(store.document_meta("doc:failed-create").unwrap().is_none());
    assert_eq!(store.load_active_document("doc-a").unwrap(), before);
    assert_eq!(store.load_version_graph_detailed("doc-a").unwrap(), graph);
    assert_eq!(
        store.read_setting("active-document-id").unwrap().as_deref(),
        Some("doc-a")
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM command_receipts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn archive_receipt_replay_does_not_reverse_a_later_restore() {
    let mut store = workspace();
    let archive = ArchiveDocumentRequest {
        command_id: "archive-b".into(),
        target_document_id: "doc-b".into(),
        expected_archived: false,
    };
    let restore = RestoreDocumentRequest {
        command_id: "restore-b".into(),
        target_document_id: "doc-b".into(),
        expected_archived: true,
    };
    let before = store.load_active_document("doc-b").unwrap();
    store
        .set_document_archived_with_receipt(
            ACTOR,
            &archive,
            &archive.command_id,
            "doc-b",
            (false, true),
            Some("doc-a"),
        )
        .unwrap();
    store
        .set_document_archived_with_receipt(
            ACTOR,
            &restore,
            &restore.command_id,
            "doc-b",
            (true, false),
            Some("doc-a"),
        )
        .unwrap();
    store
        .set_document_archived_with_receipt(
            ACTOR,
            &archive,
            &archive.command_id,
            "doc-b",
            (false, true),
            Some("doc-b"),
        )
        .unwrap();
    assert!(!store.document_meta("doc-b").unwrap().unwrap().archived);
    assert_eq!(store.load_active_document("doc-b").unwrap(), before);
    assert!(store
        .set_document_archived_with_receipt(
            ACTOR,
            &archive,
            &archive.command_id,
            "doc-b",
            (false, false),
            Some("doc-a")
        )
        .is_err());
    let fresh = ArchiveDocumentRequest {
        command_id: "archive-active".into(),
        target_document_id: "doc-a".into(),
        expected_archived: false,
    };
    assert!(store
        .set_document_archived_with_receipt(
            ACTOR,
            &fresh,
            &fresh.command_id,
            "doc-a",
            (false, true),
            Some("doc-a")
        )
        .is_err());
    let original_meta = store.document_meta("doc-b").unwrap();
    block_receipts(&store);
    let fail = ArchiveDocumentRequest {
        command_id: "archive-fail".into(),
        ..archive
    };
    assert!(store
        .set_document_archived_with_receipt(
            ACTOR,
            &fail,
            &fail.command_id,
            "doc-b",
            (false, true),
            Some("doc-a")
        )
        .is_err());
    assert_eq!(store.document_meta("doc-b").unwrap(), original_meta);
}

#[test]
fn job_material_history_uses_database_content_and_replay_has_no_side_effects() {
    let mut store = workspace();
    let request = material_request("job-once", "doc-a");
    let original = store.save_job_material(ACTOR, &request).unwrap();
    assert_eq!(store.save_job_material(ACTOR, &request).unwrap(), original);
    let original_link_request = link_request(&store, "link-once", &original);
    let link = store
        .link_job_material(ACTOR, &original_link_request)
        .unwrap();
    let mut forged = original.clone();
    forged.title = "伪造历史标题".into();
    forged.job_description = "伪造历史依据".into();
    let update = UpsertJobMaterialRequest {
        command_id: "job-update".into(),
        job_material: Some(forged),
        title: "新岗位".into(),
        ..request.clone()
    };
    let updated = store.save_job_material(ACTOR, &update).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(store.save_job_material(ACTOR, &update).unwrap(), updated);
    let listing = store.list_job_materials("doc-a").unwrap();
    assert_eq!(listing.materials, vec![updated.clone()]);
    assert_eq!(listing.links, vec![link.clone()]);
    assert_eq!(listing.revisions, vec![original.clone()]);
    let newer = store
        .save_job_material(
            ACTOR,
            &UpsertJobMaterialRequest {
                command_id: "job-update-again".into(),
                job_material: Some(updated),
                ..request.clone()
            },
        )
        .unwrap();
    assert_eq!(
        store.list_job_materials("doc-a").unwrap().revisions,
        vec![original.clone()]
    );
    let refreshed_request = link_request(&store, "link-refresh", &newer);
    let refreshed = store.link_job_material(ACTOR, &refreshed_request).unwrap();
    assert_eq!(refreshed.id, link.id);
    assert_eq!(refreshed.job_material_revision, 3);
    assert!(store
        .save_job_material(
            ACTOR,
            &UpsertJobMaterialRequest {
                command_id: "stale-job-version".into(),
                job_material: Some(original),
                ..request.clone()
            }
        )
        .is_err());
    assert!(store
        .list_job_materials("doc-a")
        .unwrap()
        .revisions
        .is_empty());
    assert_eq!(
        store
            .link_job_material(ACTOR, &original_link_request)
            .unwrap(),
        link
    );
    assert_eq!(
        store.list_job_materials("doc-a").unwrap().links,
        vec![refreshed]
    );
    let unlink = UnlinkJobMaterialRequest {
        command_id: "unlink-once".into(),
        document_id: "doc-a".into(),
        expected_epoch: 7,
        link_id: link.id.clone(),
    };
    store.unlink_job_material(ACTOR, &unlink).unwrap();
    store.unlink_job_material(ACTOR, &unlink).unwrap();
    store
        .link_job_material(ACTOR, &original_link_request)
        .unwrap();
    assert!(store.list_job_materials("doc-a").unwrap().links.is_empty());
    let deletion = DeleteJobMaterialRequest {
        command_id: "delete-once".into(),
        document_id: "doc-a".into(),
        expected_epoch: 7,
        job_material_id: newer.id,
    };
    store.delete_job_material(ACTOR, &deletion).unwrap();
    store.delete_job_material(ACTOR, &deletion).unwrap();
    assert!(store
        .list_job_materials("doc-a")
        .unwrap()
        .materials
        .is_empty());
    store.save_job_material(ACTOR, &request).unwrap();
    assert!(store
        .list_job_materials("doc-a")
        .unwrap()
        .materials
        .is_empty());
    assert!(store.save_job_material("other-actor", &request).is_err());
}

#[test]
fn job_mutations_reject_forged_ownership_stale_cursors_and_command_reuse() {
    let mut store = workspace();
    let request = material_request("job-b", "doc-b");
    let material = store.save_job_material(ACTOR, &request).unwrap();
    let mut forged = material.clone();
    forged.document_id = "doc-a".into();
    assert!(store
        .save_job_material(
            ACTOR,
            &UpsertJobMaterialRequest {
                command_id: "forge-update".into(),
                document_id: "doc-a".into(),
                job_material: Some(forged),
                ..request.clone()
            }
        )
        .is_err());
    let mut link = link_request(&store, "forge-link", &material);
    link.cursor = store.load_active_document("doc-a").unwrap().unwrap().0;
    link.branch_id = link.cursor.branch_id.clone();
    assert!(store.link_job_material(ACTOR, &link).is_err());
    let mut stale = link_request(&store, "stale-link", &material);
    store
        .persist_active_document_transition(Some("doc-b"), "doc-a")
        .unwrap();
    assert!(store.link_job_material(ACTOR, &stale).is_err());
    stale.command_id = "valid-link".into();
    stale.cursor = store.load_active_document("doc-b").unwrap().unwrap().0;
    let valid = store.link_job_material(ACTOR, &stale).unwrap();
    let deletion = DeleteJobMaterialRequest {
        command_id: "forge-delete".into(),
        document_id: "doc-a".into(),
        expected_epoch: 7,
        job_material_id: material.id.clone(),
    };
    assert!(store.delete_job_material(ACTOR, &deletion).is_err());
    let unlink = UnlinkJobMaterialRequest {
        command_id: "forge-unlink".into(),
        document_id: "doc-a".into(),
        expected_epoch: 7,
        link_id: valid.id.clone(),
    };
    assert!(store.unlink_job_material(ACTOR, &unlink).is_err());
    let mut reused = request.clone();
    reused.title = "different payload".into();
    assert!(store.save_job_material(ACTOR, &reused).is_err());
    assert!(store
        .list_job_materials("doc-a")
        .unwrap()
        .materials
        .is_empty());
    assert_eq!(
        store.list_job_materials("doc-b").unwrap().materials,
        vec![material]
    );
}

#[test]
fn job_receipt_failure_rolls_back_update_history_link_delete_and_unlink() {
    let mut store = workspace();
    let request = material_request("job-before-failure", "doc-a");
    let material = store.save_job_material(ACTOR, &request).unwrap();
    let link = store
        .link_job_material(
            ACTOR,
            &link_request(&store, "link-before-failure", &material),
        )
        .unwrap();
    let material = store
        .save_job_material(
            ACTOR,
            &UpsertJobMaterialRequest {
                command_id: "update-before-failure".into(),
                job_material: Some(material),
                title: "new material before failure".into(),
                ..request.clone()
            },
        )
        .unwrap();
    let before = store.list_job_materials("doc-a").unwrap();
    block_receipts(&store);
    assert!(store
        .save_job_material(
            ACTOR,
            &UpsertJobMaterialRequest {
                command_id: "fail-update".into(),
                job_material: Some(material.clone()),
                title: "should rollback".into(),
                ..request.clone()
            }
        )
        .is_err());
    assert!(store
        .save_job_material(ACTOR, &material_request("fail-create-job", "doc-a"))
        .is_err());
    assert!(store
        .link_job_material(ACTOR, &link_request(&store, "fail-link", &material))
        .is_err());
    assert!(store
        .delete_job_material(
            ACTOR,
            &DeleteJobMaterialRequest {
                command_id: "fail-delete".into(),
                document_id: "doc-a".into(),
                expected_epoch: 7,
                job_material_id: material.id
            }
        )
        .is_err());
    assert!(store
        .unlink_job_material(
            ACTOR,
            &UnlinkJobMaterialRequest {
                command_id: "fail-unlink".into(),
                document_id: "doc-a".into(),
                expected_epoch: 7,
                link_id: link.id
            }
        )
        .is_err());
    assert_eq!(store.list_job_materials("doc-a").unwrap(), before);
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM job_material_revisions", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

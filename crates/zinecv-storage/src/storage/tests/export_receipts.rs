use super::*;
use zinecv_contracts::{
    CreateImportDraftRequest, ExportArtifact, ExportFileFormat, ExportReceipt, FrozenExportSource,
};

fn receipt(cursor: &AuthorityCursor, index: u32) -> ExportReceipt {
    ExportReceipt {
        id: format!("export:{index:020}:native:write"),
        export_id: "native-export".into(),
        cursor: cursor.clone(),
        render_key: "a".repeat(64),
        source: FrozenExportSource {
            document_title: "冻结简历".into(),
            branch_name: "冻结岗位分支".into(),
            template_id: "legacy-v1".into(),
            template_revision: "1".into(),
            template_source_sha256: "b".repeat(64),
            frozen_at: "2026-10-29T00:00:00.000Z".into(),
        },
        artifact: ExportArtifact {
            artifact_id: "pdf".into(),
            format: ExportFileFormat::Pdf,
            page: None,
            bytes: 3,
            sha256: "c".repeat(64),
        },
        written_at: "2026-10-29T00:00:01.000Z".into(),
        filename: "简历.pdf".into(),
        source_page_count: 1,
        selected_pages: None,
        dpi: 192,
    }
}

#[test]
fn export_history_is_document_scoped_recent_twenty_and_does_not_mutate_frozen_authority() {
    let (mut store, _) = seeded_store("export-history-a", "context-a");
    store
        .initialize_document(&document("export-history-b"), "context-b")
        .unwrap();
    let frozen = store
        .load_active_document("export-history-a")
        .unwrap()
        .unwrap()
        .0;
    store
        .persist_active_document_transition(Some("export-history-a"), "export-history-b")
        .unwrap();
    let before = store.load_active_document("export-history-a").unwrap();
    for index in 0..25 {
        store
            .record_export_receipt(&receipt(&frozen, index))
            .unwrap();
    }
    let entries = store.recent_export_receipts("export-history-a").unwrap();
    assert_eq!(entries.len(), 20);
    assert_eq!(entries[0].id, receipt(&frozen, 24).id);
    assert_eq!(entries[19].id, receipt(&frozen, 5).id);
    assert!(entries.iter().all(|entry| entry.cursor == frozen));
    assert!(store
        .recent_export_receipts("export-history-b")
        .unwrap()
        .is_empty());
    assert_eq!(
        store.load_active_document("export-history-a").unwrap(),
        before
    );
    store.record_export_receipt(&receipt(&frozen, 24)).unwrap();
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM command_receipts WHERE actor = 'host-export'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        25
    );
    let mut changed = receipt(&frozen, 24);
    changed.filename = "different.pdf".into();
    assert!(store.record_export_receipt(&changed).is_err());
    assert_eq!(
        store.recent_export_receipts("export-history-a").unwrap(),
        entries
    );
}

#[test]
fn pending_import_count_tracks_only_unfinished_drafts_bound_to_that_document() {
    let (mut store, _) = seeded_store("pending-import-a", "context-a");
    store
        .initialize_document(&document("pending-import-b"), "context-b")
        .unwrap();
    for (id, document_id) in [
        ("queued-a", "pending-import-a"),
        ("running-a", "pending-import-a"),
        ("review-a", "pending-import-a"),
        ("cancelled-a", "pending-import-a"),
        ("failed-a", "pending-import-a"),
        ("queued-b", "pending-import-b"),
    ] {
        store
            .create_import_draft(&CreateImportDraftRequest {
                draft_id: id.into(),
                target_document_id: document_id.into(),
                expected_epoch: 1,
                source_kind: ImportSourceKind::Pdf,
                display_name: "fixture.pdf".into(),
                source_hash: "a".repeat(64),
            })
            .unwrap();
    }
    let transition = |store: &mut Store, id: &str, expected, next| {
        store
            .transition_import_draft(&TransitionImportDraftRequest {
                draft_id: id.into(),
                expected_status: expected,
                next_status: next,
                candidates: if next == ImportDraftStatus::ReviewRequired {
                    Some(Vec::new())
                } else {
                    None
                },
                warnings: None,
                unsupported_features: None,
                preview_data_url: None,
                extracted_text: None,
            })
            .unwrap();
    };
    for id in ["running-a", "review-a", "cancelled-a", "failed-a"] {
        transition(
            &mut store,
            id,
            ImportDraftStatus::Queued,
            ImportDraftStatus::Running,
        );
    }
    transition(
        &mut store,
        "review-a",
        ImportDraftStatus::Running,
        ImportDraftStatus::ReviewRequired,
    );
    transition(
        &mut store,
        "cancelled-a",
        ImportDraftStatus::Running,
        ImportDraftStatus::Cancelled,
    );
    transition(
        &mut store,
        "failed-a",
        ImportDraftStatus::Running,
        ImportDraftStatus::Failed,
    );
    assert_eq!(store.pending_import_count("pending-import-a").unwrap(), 3);
    assert_eq!(store.pending_import_count("pending-import-b").unwrap(), 1);
    assert_eq!(store.pending_import_count("missing-document").unwrap(), 0);
    transition(
        &mut store,
        "review-a",
        ImportDraftStatus::ReviewRequired,
        ImportDraftStatus::Cancelled,
    );
    assert_eq!(store.pending_import_count("pending-import-a").unwrap(), 2);
}

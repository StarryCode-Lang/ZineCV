use super::*;

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

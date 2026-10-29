use super::*;

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
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
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

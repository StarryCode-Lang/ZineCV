use super::*;

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

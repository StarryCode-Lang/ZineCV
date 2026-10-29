use super::*;

static ACTIVE_HOST_TEST_LOCK: Mutex<()> = Mutex::new(());

struct TestActiveHost {
    _exclusive: std::sync::MutexGuard<'static, ()>,
    previous: Option<crate::ActiveDocumentInner>,
}

impl Drop for TestActiveHost {
    fn drop(&mut self) {
        *ACTIVE_DOCUMENT.lock().expect("restore active host") = self.previous.take();
    }
}

fn test_active_host(document_id: &str, epoch: u64) -> TestActiveHost {
    let exclusive = ACTIVE_HOST_TEST_LOCK.lock().expect("serialize host tests");
    let previous =
        ACTIVE_DOCUMENT
            .lock()
            .expect("active host")
            .replace(crate::ActiveDocumentInner {
                document_id: document_id.into(),
                epoch,
            });
    TestActiveHost {
        _exclusive: exclusive,
        previous,
    }
}

fn host_switch_store() -> Store {
    let mut store = Store::open_in_memory().expect("isolated store");
    for id in ["doc-a", "doc-b"] {
        store
            .initialize_document(
                &default_resume_document(id).unwrap(),
                &format!("context-{id}"),
            )
            .unwrap();
    }
    store
}

fn host_switch_request(current: &str, target: &str, epoch: u64) -> SwitchActiveDocumentRequest {
    SwitchActiveDocumentRequest {
        expected_current_id: Some(current.into()),
        target_document_id: target.into(),
        expected_epoch: epoch,
    }
}

/// M2 边界：activeDocument 校验、导入草稿目标绑定、复制独立版本图、
/// 未来 schema 拒开。全部进程内断言，不依赖 Tauri State。

#[test]
fn require_active_document_rejects_non_active_targets_and_reports_epoch() {
    let _host = test_active_host("doc-active", 7);
    let epoch = require_active_document("doc-active").expect("active document accepted");
    assert_eq!(epoch, 7);
    let rejection = require_active_document("doc-stale").expect_err("stale target rejected");
    assert_eq!(rejection.code, ErrorCode::Conflict);
    assert!(!rejection.retryable);
}

#[test]
fn document_switch_aba_permanently_rejects_the_old_write_cursor() {
    let _host = test_active_host("doc-a", 7);
    let mut store = host_switch_store();
    let (old, content) = store.load_active_document("doc-a").unwrap().unwrap();
    let graph = store.load_version_graph_detailed("doc-a").unwrap();
    let b = switch_active_document_in_store(&mut store, &host_switch_request("doc-a", "doc-b", 7))
        .unwrap();
    let a = switch_active_document_in_store(
        &mut store,
        &host_switch_request("doc-b", "doc-a", b.epoch),
    )
    .unwrap();
    assert_eq!(a.document, content);
    assert_eq!(a.cursor.context_id, old.context_id);
    assert_eq!(a.cursor.branch_id, old.branch_id);
    assert_eq!(a.cursor.head_id, old.head_id);
    assert_ne!(a.cursor.revision, old.revision);
    let after_graph = store.load_version_graph_detailed("doc-a").unwrap();
    assert_eq!(after_graph.branches, graph.branches);
    assert_eq!(after_graph.commits, graph.commits);
    require_active_document("doc-a").unwrap();
    let rejected = store
        .apply_command(
            "local-anonymous",
            CommandEnvelope {
                protocol_version: 1,
                command_id: "stale-aba-write".into(),
                document_id: old.document_id,
                context_id: old.context_id,
                expected_revision: old.revision,
                expected_branch_id: old.branch_id,
                expected_head_id: old.head_id,
                payload: crate::domain::DomainCommand::SetDocumentTitle {
                    title: "stale title".into(),
                },
            },
        )
        .expect_err("old A cursor stays invalid after returning to A");
    assert!(matches!(
        rejected,
        crate::storage::StorageError::Conflict(_)
    ));
    assert_eq!(
        store.load_active_document("doc-a").unwrap().unwrap().1,
        content
    );
}

#[test]
fn concurrent_document_switches_with_the_same_epoch_have_one_winner() {
    let _host = test_active_host("doc-a", 7);
    let store = Arc::new(Mutex::new(host_switch_store()));
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let workers = (0..2)
        .map(|_| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let mut store = store.lock().unwrap();
                switch_active_document_in_store(
                    &mut store,
                    &host_switch_request("doc-a", "doc-b", 7),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(error) if error.code == ErrorCode::Conflict))
            .count(),
        1
    );
    assert_eq!(require_active_document("doc-b").unwrap(), 8);
    assert_eq!(
        store
            .lock()
            .unwrap()
            .read_setting("active-document-id")
            .unwrap()
            .as_deref(),
        Some("doc-b")
    );
}

#[test]
fn failed_document_switch_preserves_host_and_source_authority() {
    let _host = test_active_host("doc-a", 7);
    let mut store = host_switch_store();
    let before = store.load_active_document("doc-a").unwrap();
    store
        .connection()
        .execute_batch(
            "CREATE TRIGGER reject_host_setting BEFORE INSERT ON settings
         WHEN NEW.key = 'active-document-id'
         BEGIN SELECT RAISE(ABORT, 'synthetic setting failure'); END;",
        )
        .unwrap();
    assert!(
        switch_active_document_in_store(&mut store, &host_switch_request("doc-a", "doc-b", 7))
            .is_err()
    );
    assert_eq!(require_active_document("doc-a").unwrap(), 7);
    assert_eq!(store.load_active_document("doc-a").unwrap(), before);
    assert!(store.read_setting("active-document-id").unwrap().is_none());
}

#[test]
fn document_switch_counter_overflow_preserves_the_old_host() {
    for epoch in [7, u64::MAX] {
        let _host = test_active_host("doc-a", epoch);
        let mut store = host_switch_store();
        if epoch == 7 {
            store
                .connection()
                .execute(
                    "UPDATE documents SET revision = ?1 WHERE id = 'doc-a'",
                    [i64::MAX],
                )
                .unwrap();
            store
                .connection()
                .execute(
                    "UPDATE drafts SET revision = ?1 WHERE document_id = 'doc-a'",
                    [i64::MAX],
                )
                .unwrap();
        }
        let before = store.load_active_document("doc-a").unwrap();
        assert!(switch_active_document_in_store(
            &mut store,
            &host_switch_request("doc-a", "doc-b", epoch)
        )
        .is_err());
        assert_eq!(require_active_document("doc-a").unwrap(), epoch);
        assert_eq!(store.load_active_document("doc-a").unwrap(), before);
        assert!(store.read_setting("active-document-id").unwrap().is_none());
    }
}

fn host_create_request(command_id: &str) -> CreateDocumentRequest {
    CreateDocumentRequest {
        command_id: command_id.into(),
        expected_current_id: "doc-a".into(),
        expected_epoch: 7,
        payload: crate::domain::CreateDocumentPayload::Duplicate {
            source_document_id: "doc-a".into(),
            initial_title: None,
        },
    }
}

#[test]
fn creation_receipt_replay_never_takes_back_the_current_document() {
    let _host = test_active_host("doc-a", 7);
    let mut store = host_switch_store();
    let request = host_create_request("host-create-once");
    let mut wrong_source = host_create_request("host-other-source");
    wrong_source.payload = crate::domain::CreateDocumentPayload::Duplicate {
        source_document_id: "doc-b".into(),
        initial_title: None,
    };
    assert!(create_document_in_store(&mut store, "local-anonymous", &wrong_source).is_err());
    assert_eq!(require_active_document("doc-a").unwrap(), 7);
    let created = create_document_in_store(&mut store, "local-anonymous", &request).unwrap();
    assert_eq!(created.receipt.document_id, "doc:host-create-once");
    assert_eq!(created.active_state.as_ref().unwrap().epoch, 8);
    let replay = create_document_in_store(&mut store, "local-anonymous", &request).unwrap();
    assert_eq!(replay, created);
    switch_active_document_in_store(
        &mut store,
        &host_switch_request(&created.receipt.document_id, "doc-b", 8),
    )
    .unwrap();
    let replay = create_document_in_store(&mut store, "local-anonymous", &request).unwrap();
    assert_eq!(replay.receipt, created.receipt);
    assert!(replay.active_state.is_none());
    assert_eq!(require_active_document("doc-b").unwrap(), 9);
    let mut changed = request.clone();
    changed.payload = crate::domain::CreateDocumentPayload::Blank {
        initial_title: "changed request".into(),
    };
    assert!(create_document_in_store(&mut store, "local-anonymous", &changed).is_err());
    assert_eq!(require_active_document("doc-b").unwrap(), 9);
}

#[test]
fn fresh_creation_and_id_only_writes_reject_an_old_epoch_after_aba() {
    let _host = test_active_host("doc-a", 7);
    let mut store = host_switch_store();
    let request = host_create_request("host-stale-create");
    switch_active_document_in_store(&mut store, &host_switch_request("doc-a", "doc-b", 7)).unwrap();
    switch_active_document_in_store(&mut store, &host_switch_request("doc-b", "doc-a", 8)).unwrap();
    assert!(create_document_in_store(&mut store, "local-anonymous", &request).is_err());
    assert!(store
        .document_meta("doc:host-stale-create")
        .unwrap()
        .is_none());
    let import = zinecv_contracts::CreateImportDraftRequest {
        draft_id: "stale-import".into(),
        target_document_id: "doc-a".into(),
        expected_epoch: 7,
        source_kind: zinecv_contracts::ImportSourceKind::Pdf,
        display_name: "fixture.pdf".into(),
        source_hash: "a".repeat(64),
    };
    assert!(
        require_active_document_epoch(&import.target_document_id, import.expected_epoch)
            .and_then(|_| store.create_import_draft(&import).map_err(AppError::from))
            .is_err()
    );
    assert!(store.read_import_draft(&import.draft_id).unwrap().is_none());
    let job = zinecv_contracts::UpsertJobMaterialRequest {
        command_id: "stale-job".into(),
        document_id: "doc-a".into(),
        expected_epoch: 7,
        job_material: None,
        title: "stale job".into(),
        company: String::new(),
        job_description: String::new(),
        source_note: String::new(),
    };
    assert!(
        require_active_document_epoch(&job.document_id, job.expected_epoch)
            .and_then(|_| store
                .save_job_material("local-anonymous", &job)
                .map_err(AppError::from))
            .is_err()
    );
    assert!(store
        .list_job_materials("doc-a")
        .unwrap()
        .materials
        .is_empty());
}

#[test]
fn creation_receipt_failure_leaves_host_epoch_and_database_unchanged() {
    let _host = test_active_host("doc-a", 7);
    let mut store = host_switch_store();
    let before = store.load_active_document("doc-a").unwrap();
    store
        .connection()
        .execute_batch(
            "CREATE TRIGGER reject_creation_receipt BEFORE INSERT ON command_receipts
        BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;",
        )
        .unwrap();
    assert!(create_document_in_store(
        &mut store,
        "local-anonymous",
        &host_create_request("host-failed-create")
    )
    .is_err());
    assert_eq!(require_active_document("doc-a").unwrap(), 7);
    assert_eq!(store.load_active_document("doc-a").unwrap(), before);
    assert!(store
        .document_meta("doc:host-failed-create")
        .unwrap()
        .is_none());
    assert!(store.read_setting("active-document-id").unwrap().is_none());
}

#[test]
fn import_draft_confirmations_stay_bound_to_their_target_document() {
    let mut store = Store::open_in_memory().expect("isolated store");
    for id in ["doc-a", "doc-b"] {
        let document = default_resume_document(id).expect("synthetic blank document");
        store
            .initialize_document(&document, &format!("context-{id}"))
            .expect("initialize document");
    }
    let target = store
        .load_cursor("doc-a", "context-doc-a")
        .expect("cursor")
        .expect("cursor exists");
    let wrong = store
        .load_cursor("doc-b", "context-doc-b")
        .expect("cursor")
        .expect("cursor exists");
    store
        .create_import_draft(&zinecv_contracts::CreateImportDraftRequest {
            expected_epoch: 1,
            target_document_id: "doc-a".into(),
            draft_id: "draft-bound".into(),
            source_kind: zinecv_contracts::ImportSourceKind::Pdf,
            display_name: "fixture.pdf".into(),
            source_hash: "a".repeat(64),
        })
        .expect("bound import draft");
    // 推进到 review_required 后，用另一文档的 cursor 确认 → 拒绝。
    store
        .transition_import_draft(&zinecv_contracts::TransitionImportDraftRequest {
            draft_id: "draft-bound".into(),
            expected_status: zinecv_contracts::ImportDraftStatus::Queued,
            next_status: zinecv_contracts::ImportDraftStatus::Running,
            candidates: None,
            warnings: None,
            unsupported_features: None,
            preview_data_url: None,
            extracted_text: None,
        })
        .expect("draft running");
    let candidate = zinecv_contracts::ImportCandidate {
        id: "candidate-1".into(),
        label: "姓名".into(),
        value: zinecv_contracts::ImportCandidateValue::BasicField {
            field: zinecv_contracts::ImportBasicField::Name,
            value: "林合成".into(),
        },
        evidence: zinecv_contracts::ImportFieldEvidence {
            page: Some(1),
            excerpt: "林合成".into(),
            source_field: Some("name".into()),
            confidence: "high".into(),
        },
    };
    store
        .transition_import_draft(&zinecv_contracts::TransitionImportDraftRequest {
            draft_id: "draft-bound".into(),
            expected_status: zinecv_contracts::ImportDraftStatus::Running,
            next_status: zinecv_contracts::ImportDraftStatus::ReviewRequired,
            candidates: Some(vec![candidate]),
            warnings: Some(vec![]),
            unsupported_features: None,
            preview_data_url: None,
            extracted_text: None,
        })
        .expect("draft review required");
    let rejection = store
        .apply_import(
            "local-anonymous",
            &ApplyImportRequest {
                command_id: "apply-wrong-target".into(),
                cursor: wrong,
                draft_id: "draft-bound".into(),
                accepted_candidate_ids: vec!["candidate-1".into()],
                corrections: None,
            },
        )
        .expect_err("confirmation against another document is rejected");
    assert!(matches!(
        rejection,
        crate::storage::StorageError::Conflict(_)
    ));
    // 绑定文档本身的 cursor 在宿主 active 校验（host）之后由存储 CAS 接受。
    let accepted = store
        .apply_import(
            "local-anonymous",
            &ApplyImportRequest {
                command_id: "apply-bound-target".into(),
                cursor: target,
                draft_id: "draft-bound".into(),
                accepted_candidate_ids: vec!["candidate-1".into()],
                corrections: None,
            },
        )
        .expect("bound confirmation accepted");
    assert!(accepted.durable);
}

#[test]
fn duplicated_documents_start_with_their_own_independent_version_graph() {
    let mut store = Store::open_in_memory().expect("isolated store");
    let document = default_resume_document("doc-source").expect("synthetic blank document");
    store
        .initialize_document(&document, "context-source")
        .expect("initialize source");
    let created = store
        .duplicate_document("doc-source", "doc-copy", "context-copy", "复制简历")
        .expect("duplicate");
    assert!(created);
    let source_graph = store
        .load_version_graph_detailed("doc-source")
        .expect("source graph");
    let copy_graph = store
        .load_version_graph_detailed("doc-copy")
        .expect("copy graph");
    // 复制建立独立初始版本：提交数一致（各 1），但提交 ID 与文档身份不同。
    assert_eq!(copy_graph.commits.len(), source_graph.commits.len());
    assert!(copy_graph
        .commits
        .iter()
        .all(|commit| commit.commit.id.contains("doc-copy")));
    let source_meta = store.document_meta("doc-source").expect("meta").unwrap();
    let copy_meta = store.document_meta("doc-copy").expect("meta").unwrap();
    assert_eq!(
        source_meta.origin_kind,
        zinecv_contracts::DocumentOriginKind::Blank
    );
    assert_eq!(
        copy_meta.origin_kind,
        zinecv_contracts::DocumentOriginKind::Duplicated
    );
    assert!(!copy_meta.archived);
    // 归档复制文档不影响源文档；恢复后回归原状态。
    store
        .set_document_archived("doc-copy", false, true)
        .expect("archive copy");
    let archived = store.document_meta("doc-copy").expect("meta").unwrap();
    assert!(archived.archived);
    assert!(archived.archived_at.is_some());
    assert!(
        !store
            .document_meta("doc-source")
            .expect("meta")
            .unwrap()
            .archived
    );
    store
        .set_document_archived("doc-copy", true, false)
        .expect("restore copy");
    assert!(
        !store
            .document_meta("doc-copy")
            .expect("meta")
            .unwrap()
            .archived
    );
}

#[test]
fn schema_versions_above_the_latest_are_rejected_on_open() {
    let path = std::env::temp_dir().join(format!(
        "zinecv-m2-future-schema-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    {
        let store = Store::open(&path).expect("baseline database");
        assert_eq!(
            store.migration_versions().expect("versions").last(),
            Some(&18)
        );
    }
    // 未来 schema：宿主写入更高版本号后，旧程序必须拒开（UnsupportedSchema）。
    {
        let store = Store::open(&path).expect("reopen for injection");
        store
            .connection()
            .execute(
                "INSERT INTO schema_migrations(version, checksum) VALUES (19, 'future')",
                [],
            )
            .expect("inject future schema version");
    }
    let error = match Store::open(&path) {
        Ok(_) => panic!("future schema accepted"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        crate::storage::StorageError::UnsupportedSchema { .. }
            | crate::storage::StorageError::Corrupt(_)
    ));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn duplicated_documents_keep_independent_edits_after_database_reopen() {
    struct Profile(std::path::PathBuf);
    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn edit_name(store: &mut Store, id: &str, command_id: &str, name: &str) {
        let (cursor, _) = store.load_active_document(id).unwrap().unwrap();
        let result = store
            .apply_command(
                "local-anonymous",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: command_id.into(),
                    document_id: cursor.document_id,
                    context_id: cursor.context_id,
                    expected_revision: cursor.revision,
                    expected_branch_id: cursor.branch_id,
                    expected_head_id: cursor.head_id,
                    payload: crate::domain::DomainCommand::UpdateBasic {
                        patch: zinecv_contracts::BasicPatch {
                            name: Some(name.into()),
                            ..Default::default()
                        },
                    },
                },
            )
            .expect("edit the explicitly selected document");
        assert!(result.durable);
        assert_eq!(result.cursor.document_id, id);
    }
    let profile = Profile(std::env::temp_dir().join(format!(
        "zinecv-copy-reopen-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    std::fs::create_dir(&profile.0).expect("isolated profile");
    let path = profile.0.join("copy.sqlite3");
    let (source_before, copy_before, source_graph, copy_graph) = {
        let mut store = Store::open(&path).expect("open isolated disk store");
        let mut source = default_resume_document("doc-source").unwrap();
        source.basic.name = "共同初始内容".into();
        store
            .initialize_document(&source, "context-source")
            .unwrap();
        store
            .duplicate_document("doc-source", "doc-copy", "context-copy", "独立副本")
            .unwrap();
        let source_initial = store.load_active_document("doc-source").unwrap().unwrap();
        edit_name(&mut store, "doc-copy", "copy-name", "副本独立编辑");
        assert_eq!(
            store.load_active_document("doc-source").unwrap().unwrap(),
            source_initial,
            "editing the copy must not advance or replace the source"
        );
        let copy_edited = store.load_active_document("doc-copy").unwrap().unwrap();
        edit_name(&mut store, "doc-source", "source-name", "原件独立编辑");
        assert_eq!(
            store.load_active_document("doc-copy").unwrap().unwrap(),
            copy_edited,
            "editing the source must not advance or replace the copy"
        );
        (
            store.load_active_document("doc-source").unwrap().unwrap(),
            copy_edited,
            store.load_version_graph_detailed("doc-source").unwrap(),
            store.load_version_graph_detailed("doc-copy").unwrap(),
        )
    };
    {
        let mut store = Store::open(&path).expect("reopen after closing every connection");
        assert_eq!(
            store.load_active_document("doc-source").unwrap().unwrap(),
            source_before
        );
        assert_eq!(
            store.load_active_document("doc-copy").unwrap().unwrap(),
            copy_before
        );
        assert_eq!(source_before.1.basic.name, "原件独立编辑");
        assert_eq!(copy_before.1.basic.name, "副本独立编辑");
        let source_after = store.load_version_graph_detailed("doc-source").unwrap();
        let copy_after = store.load_version_graph_detailed("doc-copy").unwrap();
        assert_eq!(source_after.branches, source_graph.branches);
        assert_eq!(source_after.commits, source_graph.commits);
        assert_eq!(copy_after.branches, copy_graph.branches);
        assert_eq!(copy_after.commits, copy_graph.commits);
        assert_eq!(
            store
                .document_meta("doc-copy")
                .unwrap()
                .unwrap()
                .origin_kind,
            zinecv_contracts::DocumentOriginKind::Duplicated
        );
        edit_name(
            &mut store,
            "doc-copy",
            "copy-after-reopen",
            "重开后只改副本",
        );
        assert_eq!(
            store.load_active_document("doc-source").unwrap().unwrap(),
            source_before
        );
    }
    let store = Store::open(&path).expect("second reopen");
    assert_eq!(
        store.load_active_document("doc-source").unwrap().unwrap(),
        source_before
    );
    assert_eq!(
        store
            .load_active_document("doc-copy")
            .unwrap()
            .unwrap()
            .1
            .basic
            .name,
        "重开后只改副本"
    );
}

//! Import candidate correction paths: user-reviewed values rewrite accepted
//! candidates only, entry identities are stabilized by the host, and invalid
//! corrections are rejected without touching the durable document.

use super::*;
use zinecv_contracts::{Inline, RichBlock};

fn section_entries_candidate(id: &str) -> zinecv_contracts::ImportCandidate {
    use zinecv_contracts::{
        Entry, ImportCandidate, ImportCandidateValue, ImportFieldEvidence, ModuleKind,
    };
    ImportCandidate {
        id: id.into(),
        label: "工作经历".into(),
        value: ImportCandidateValue::SectionEntries {
            kind: ModuleKind::Work,
            title: "工作经历".into(),
            entries: vec![Entry {
                id: "parsed-entry-1".into(),
                title: "解析公司".into(),
                role: "解析职位".into(),
                department: String::new(),
                city: String::new(),
                start: "2024".into(),
                end: "2025".into(),
                college: None,
                mode: None,
                body: vec![RichBlock::Paragraph {
                    children: vec![Inline::Text {
                        text: "解析正文".into(),
                        marks: vec![],
                    }],
                }],
            }],
        },
        evidence: ImportFieldEvidence {
            page: Some(1),
            excerpt: "解析公司".into(),
            source_field: Some("work".into()),
            confidence: "medium".into(),
        },
    }
}

fn corrected_section_entries(
    entries: Vec<zinecv_contracts::Entry>,
) -> zinecv_contracts::ImportCandidateValue {
    use zinecv_contracts::{ImportCandidateValue, ModuleKind};
    ImportCandidateValue::SectionEntries {
        kind: ModuleKind::Work,
        title: "工作经历".into(),
        entries,
    }
}

fn corrected_entry(id: &str, title: &str) -> zinecv_contracts::Entry {
    zinecv_contracts::Entry {
        id: id.into(),
        title: title.into(),
        role: "校正职位".into(),
        department: String::new(),
        city: String::new(),
        start: "2024".into(),
        end: String::new(),
        college: None,
        mode: None,
        body: vec![RichBlock::Paragraph {
            children: vec![Inline::Text {
                text: "校正正文".into(),
                marks: vec![],
            }],
        }],
    }
}

fn review_with_candidates(
    store: &mut Store,
    draft_id: &str,
    candidates: Vec<zinecv_contracts::ImportCandidate>,
    extracted_text: Option<&str>,
) -> zinecv_contracts::ImportDraft {
    use zinecv_contracts::{CreateImportDraftRequest, ImportDraftStatus, ImportSourceKind};
    let target_document_id = store
        .list_documents(false)
        .expect("document list")
        .into_iter()
        .map(|meta| meta.document_id)
        .next()
        .expect("seeded document");
    store
        .create_import_draft(&CreateImportDraftRequest {
            expected_epoch: 1,
            target_document_id,
            draft_id: draft_id.into(),
            source_kind: ImportSourceKind::Pdf,
            display_name: "fixture.pdf".into(),
            source_hash: "a".repeat(64),
        })
        .expect("queued import draft");
    store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: draft_id.into(),
            expected_status: ImportDraftStatus::Queued,
            next_status: ImportDraftStatus::Running,
            candidates: None,
            warnings: None,
            unsupported_features: None,
            preview_data_url: None,
            extracted_text: None,
        })
        .expect("running import draft");
    store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: draft_id.into(),
            expected_status: ImportDraftStatus::Running,
            next_status: ImportDraftStatus::ReviewRequired,
            candidates: Some(candidates),
            warnings: Some(vec![]),
            unsupported_features: Some(vec![]),
            preview_data_url: None,
            extracted_text: extracted_text.map(str::to_string),
        })
        .expect("review import draft")
}

fn import_entry_id(draft_id: &str, candidate_id: &str, index: usize) -> String {
    let digest = Sha256::digest(format!("{}\0{}\0{index}", draft_id, candidate_id));
    format!("import-entry:{digest:x}")
}

#[test]
fn correction_rewrites_accepted_candidate_and_stabilizes_split_entry_ids() {
    use zinecv_contracts::{ApplyImportRequest, ImportCandidateValue, Section};

    let (mut store, _) = seeded_store("doc-corrections", "context-a");
    let cursor = store
        .load_cursor("doc-corrections", "context-a")
        .unwrap()
        .unwrap();
    let draft = review_with_candidates(
        &mut store,
        "import-corrections-1",
        vec![
            import_candidate("candidate-name", "解析姓名"),
            section_entries_candidate("candidate-work"),
        ],
        Some("解析姓名\n解析公司\n校正正文"),
    );
    assert_eq!(
        draft.extracted_text.as_deref(),
        Some("解析姓名\n解析公司\n校正正文")
    );

    // Split the parsed work entry into two corrected rows; the host must
    // replace client-chosen identities with stable derived IDs.
    let corrected = ImportCandidateValue::SectionEntries {
        kind: zinecv_contracts::ModuleKind::Work,
        title: "工作经历".into(),
        entries: vec![
            corrected_entry("client-chosen-a", "校正公司A"),
            corrected_entry("client-chosen-b", "校正公司B"),
        ],
    };
    let request = ApplyImportRequest {
        command_id: "apply-corrections-1".into(),
        cursor,
        draft_id: draft.id.clone(),
        accepted_candidate_ids: vec!["candidate-name".into(), "candidate-work".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-work".into(),
            value: corrected,
        }]),
    };
    let applied = store
        .apply_import("local-anonymous", &request)
        .expect("apply with corrections");
    // The uncorrected name candidate applies verbatim; only the work
    // candidate was corrected.
    assert_eq!(applied.document.basic.name, "解析姓名");
    let section = applied
        .document
        .sections
        .iter()
        .find_map(|section| match section {
            Section::Entry(section) => Some(section),
            Section::Summary(_) => None,
        })
        .expect("imported work section");
    assert_eq!(section.entries.len(), 2);
    let expected_ids = [
        import_entry_id(&draft.id, "candidate-work", 0),
        import_entry_id(&draft.id, "candidate-work", 1),
    ];
    assert_eq!(
        section
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        expected_ids,
        "split entries must carry host-derived stable IDs"
    );
    assert_eq!(section.entries[0].title, "校正公司A");
    assert_eq!(section.entries[1].title, "校正公司B");

    // The same split on another document must derive identical entry IDs.
    let (mut second, _) = seeded_store("doc-corrections-2", "context-a");
    let second_cursor = second
        .load_cursor("doc-corrections-2", "context-a")
        .unwrap()
        .unwrap();
    let second_draft = review_with_candidates(
        &mut second,
        "import-corrections-2",
        vec![section_entries_candidate("candidate-work")],
        None,
    );
    let second_request = ApplyImportRequest {
        command_id: "apply-corrections-2".into(),
        cursor: second_cursor,
        draft_id: second_draft.id.clone(),
        accepted_candidate_ids: vec!["candidate-work".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-work".into(),
            value: corrected_section_entries(vec![
                corrected_entry("other-client-a", "校正公司A"),
                corrected_entry("other-client-b", "校正公司B"),
            ]),
        }]),
    };
    let second_applied = second
        .apply_import("local-anonymous", &second_request)
        .expect("apply second split");
    let second_section = second_applied
        .document
        .sections
        .iter()
        .find_map(|section| match section {
            Section::Entry(section) => Some(section),
            Section::Summary(_) => None,
        })
        .expect("second work section");
    assert_eq!(
        second_section
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        [
            import_entry_id("import-corrections-2", "candidate-work", 0),
            import_entry_id("import-corrections-2", "candidate-work", 1),
        ],
        "derived entry IDs stay deterministic per draft and candidate, and the draft namespace keeps identical splits from two imports from colliding"
    );
    assert_ne!(
        second_section.entries[0].id, section.entries[0].id,
        "identical splits applied from different drafts must not collide"
    );
}

#[test]
fn corrections_must_name_unique_accepted_candidates() {
    use zinecv_contracts::ApplyImportRequest;

    let (mut store, _) = seeded_store("doc-corrections-unaccepted", "context-a");
    let cursor = store
        .load_cursor("doc-corrections-unaccepted", "context-a")
        .unwrap()
        .unwrap();
    let draft = review_with_candidates(
        &mut store,
        "import-corrections-unaccepted",
        vec![
            import_candidate("candidate-name", "解析姓名"),
            section_entries_candidate("candidate-work"),
        ],
        None,
    );
    // A correction for a parsed candidate that was not confirmed is rejected.
    let unaccepted = ApplyImportRequest {
        command_id: "apply-unaccepted-correction".into(),
        cursor: cursor.clone(),
        draft_id: draft.id.clone(),
        accepted_candidate_ids: vec!["candidate-name".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-work".into(),
            value: corrected_section_entries(vec![corrected_entry("x", "校正公司")]),
        }]),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &unaccepted),
        Err(StorageError::Validation(_))
    ));
    // A correction for an unknown candidate is rejected the same way.
    let unknown = ApplyImportRequest {
        command_id: "apply-unknown-correction".into(),
        cursor: cursor.clone(),
        draft_id: draft.id.clone(),
        accepted_candidate_ids: vec!["candidate-name".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-missing".into(),
            value: corrected_section_entries(vec![corrected_entry("x", "校正公司")]),
        }]),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &unknown),
        Err(StorageError::Validation(_))
    ));
    // Two corrections for the same candidate are rejected.
    let duplicated = ApplyImportRequest {
        command_id: "apply-duplicate-correction".into(),
        cursor,
        draft_id: draft.id,
        accepted_candidate_ids: vec!["candidate-name".into()],
        corrections: Some(vec![
            zinecv_contracts::ImportCandidateCorrection {
                candidate_id: "candidate-name".into(),
                value: zinecv_contracts::ImportCandidateValue::BasicField {
                    field: ImportBasicField::Name,
                    value: "第一次校正".into(),
                },
            },
            zinecv_contracts::ImportCandidateCorrection {
                candidate_id: "candidate-name".into(),
                value: zinecv_contracts::ImportCandidateValue::BasicField {
                    field: ImportBasicField::Name,
                    value: "第二次校正".into(),
                },
            },
        ]),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &duplicated),
        Err(StorageError::Validation(_))
    ));
}

#[test]
fn correction_cannot_change_candidate_type_or_basic_field() {
    use zinecv_contracts::{ApplyImportRequest, ImportCandidateValue};

    let (mut store, _) = seeded_store("doc-corrections-type", "context-a");
    let cursor = store
        .load_cursor("doc-corrections-type", "context-a")
        .unwrap()
        .unwrap();
    let draft = review_with_candidates(
        &mut store,
        "import-corrections-type",
        vec![import_candidate("candidate-name", "解析姓名")],
        None,
    );
    // A basic field candidate cannot be corrected into a summary body.
    let type_change = ApplyImportRequest {
        command_id: "apply-correction-type-change".into(),
        cursor: cursor.clone(),
        draft_id: draft.id.clone(),
        accepted_candidate_ids: vec!["candidate-name".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-name".into(),
            value: ImportCandidateValue::SummaryBody {
                title: "自我评价".into(),
                body: vec![RichBlock::Paragraph {
                    children: vec![Inline::Text {
                        text: "抢占正文".into(),
                        marks: vec![],
                    }],
                }],
            },
        }]),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &type_change),
        Err(StorageError::Permission(_))
    ));
    // The same basic field candidate cannot be redirected to another field.
    let field_change = ApplyImportRequest {
        command_id: "apply-correction-field-change".into(),
        cursor,
        draft_id: draft.id,
        accepted_candidate_ids: vec!["candidate-name".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-name".into(),
            value: ImportCandidateValue::BasicField {
                field: ImportBasicField::Email,
                value: "抢占邮箱@example.com".into(),
            },
        }]),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &field_change),
        Err(StorageError::Permission(_))
    ));
}

#[test]
fn correction_cannot_redirect_another_basic_field_candidate() {
    use zinecv_contracts::{ApplyImportRequest, ImportCandidateValue};

    let (mut store, _) = seeded_store("doc-corrections-crossfield", "context-a");
    let cursor = store
        .load_cursor("doc-corrections-crossfield", "context-a")
        .unwrap()
        .unwrap();
    let mut phone_candidate = import_candidate("candidate-phone", "解析电话");
    phone_candidate.label = "电话".into();
    phone_candidate.value = ImportCandidateValue::BasicField {
        field: ImportBasicField::Phone,
        value: "解析电话".into(),
    };
    let draft = review_with_candidates(
        &mut store,
        "import-corrections-crossfield",
        vec![phone_candidate],
        None,
    );
    // Correcting the phone candidate with a name-field value changes the
    // candidate's basic field and must be rejected.
    let request = ApplyImportRequest {
        command_id: "apply-crossfield-correction".into(),
        cursor,
        draft_id: draft.id,
        accepted_candidate_ids: vec!["candidate-phone".into()],
        corrections: Some(vec![zinecv_contracts::ImportCandidateCorrection {
            candidate_id: "candidate-phone".into(),
            value: ImportCandidateValue::BasicField {
                field: ImportBasicField::Name,
                value: "抢占姓名".into(),
            },
        }]),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &request),
        Err(StorageError::Permission(_))
    ));
}

#[test]
fn corrections_exceeding_budget_are_rejected() {
    use zinecv_contracts::{ApplyImportRequest, ImportCandidateValue};

    let (mut store, _) = seeded_store("doc-corrections-budget", "context-a");
    let cursor = store
        .load_cursor("doc-corrections-budget", "context-a")
        .unwrap()
        .unwrap();
    let draft = review_with_candidates(
        &mut store,
        "import-corrections-budget",
        vec![import_candidate("candidate-name", "解析姓名")],
        None,
    );
    let flood = (0..=256)
        .map(|index| zinecv_contracts::ImportCandidateCorrection {
            candidate_id: format!("candidate-{index}"),
            value: ImportCandidateValue::BasicField {
                field: ImportBasicField::Name,
                value: "超预算".into(),
            },
        })
        .collect::<Vec<_>>();
    let request = ApplyImportRequest {
        command_id: "apply-corrections-budget".into(),
        cursor,
        draft_id: draft.id,
        accepted_candidate_ids: vec!["candidate-name".into()],
        corrections: Some(flood),
    };
    assert!(matches!(
        store.apply_import("local-anonymous", &request),
        Err(StorageError::Validation(_))
    ));
    let current = store
        .load_current("doc-corrections-budget", "context-a")
        .unwrap()
        .unwrap()
        .1;
    assert_eq!(current.basic.name, "样例", "rejected apply must not mutate");
}

#[test]
fn extracted_text_persists_for_review_and_old_drafts_return_none() {
    use zinecv_contracts::{CreateImportDraftRequest, ImportDraftStatus, ImportSourceKind};

    let (mut store, _) = seeded_store("doc-source-text", "context-a");
    let target_document_id = store
        .list_documents(false)
        .unwrap()
        .into_iter()
        .map(|meta| meta.document_id)
        .next()
        .unwrap();
    let with_text = review_with_candidates(
        &mut store,
        "import-source-text-kept",
        vec![import_candidate("candidate-name", "解析姓名")],
        Some("需要对照的原始全文"),
    );
    assert_eq!(
        with_text.extracted_text.as_deref(),
        Some("需要对照的原始全文")
    );
    // The value is durable: a fresh read hits the SQLite resource, not memory.
    let reread = store
        .read_import_draft("import-source-text-kept")
        .unwrap()
        .unwrap();
    assert_eq!(reread.extracted_text.as_deref(), Some("需要对照的原始全文"));
    assert!(reread.extracted_text.unwrap().chars().count() > 0);

    // A draft transitioned without source text explicitly returns None, and
    // so does a draft that never entered review.
    let without_text = review_with_candidates(
        &mut store,
        "import-source-text-absent",
        vec![import_candidate("candidate-name", "解析姓名")],
        None,
    );
    assert_eq!(without_text.extracted_text, None);
    store
        .create_import_draft(&CreateImportDraftRequest {
            expected_epoch: 1,
            target_document_id,
            draft_id: "import-source-text-queued".into(),
            source_kind: ImportSourceKind::Pdf,
            display_name: "fixture.pdf".into(),
            source_hash: "a".repeat(64),
        })
        .unwrap();
    let queued = store
        .read_import_draft("import-source-text-queued")
        .unwrap()
        .unwrap();
    assert_eq!(queued.status, ImportDraftStatus::Queued);
    assert_eq!(queued.extracted_text, None);

    // Oversized source text exceeds the review budget even with no candidates.
    let oversized = "很长的原文".repeat(512 * 1024);
    assert!(store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: "import-source-text-queued".into(),
            expected_status: ImportDraftStatus::Queued,
            next_status: ImportDraftStatus::Running,
            candidates: None,
            warnings: None,
            unsupported_features: None,
            preview_data_url: None,
            extracted_text: None,
        })
        .is_ok());
    let failed = store.transition_import_draft(&TransitionImportDraftRequest {
        draft_id: "import-source-text-queued".into(),
        expected_status: ImportDraftStatus::Running,
        next_status: ImportDraftStatus::ReviewRequired,
        candidates: Some(vec![import_candidate("candidate-name", "解析姓名")]),
        warnings: Some(vec![]),
        unsupported_features: Some(vec![]),
        preview_data_url: None,
        extracted_text: Some(oversized),
    });
    assert!(matches!(failed, Err(StorageError::Validation(_))));
    // The draft stays in running status after the rejected transition.
    let still_running = store
        .read_import_draft("import-source-text-queued")
        .unwrap()
        .unwrap();
    assert_eq!(still_running.status, ImportDraftStatus::Running);
    assert_eq!(still_running.extracted_text, None);
}

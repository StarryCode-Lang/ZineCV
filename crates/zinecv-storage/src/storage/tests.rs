use super::*;

fn document(id: &str) -> ResumeDocument {
    let json = format!(
        r##"{{
              "schemaVersion":2,
              "documentId":"{id}",
              "title":"测试",
              "basic":{{"name":"样例","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"}},
              "sections":[],
              "presentation":{{"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"fixture","fontSizePt":9.75,"lineHeightPt":12,"moduleGapPt":8,"pageMarginPt":24,"headingSizePt":11,"paragraphGapPt":4,"listGapPt":4,"theme":"#000000","dateFormat":"2021.01","titleFormat":"双行标题","separator":"不使用分隔符号","textAlign":"系统默认","legacyOverrides":{{}}}},
              "legacyExtensions":{{}}
            }}"##
    );
    serde_json::from_str(&json).expect("fixture")
}

fn seeded_store(id: &str, context: &str) -> (Store, ResumeDocument) {
    let mut store = Store::open_in_memory().unwrap();
    let document = document(id);
    store.initialize_document(&document, context).unwrap();
    (store, document)
}

fn legacy_migration_request(
    cursor: AuthorityCursor,
    source_title: &str,
    converted_title: &str,
    parent_id: Option<&str>,
    command_id: &str,
) -> crate::migration::CommitLegacyMigrationRequest {
    use crate::migration::{
        CommitLegacyMigrationRequest, InspectLegacyMigrationRequest, LegacyMigrationExpectedHash,
        LegacyMigrationSourceInput, LegacyMigrationSourceKind, LegacyMigrationVersionBranch,
        LegacyMigrationVersionCommit, LegacyMigrationVersionGraph,
    };
    use serde_json::json;

    let source_json = json!({
        "currentBranchId":"main",
        "branches":[{"id":"main","name":"Imported main","createdAt":"2026-01-01T00:00:00Z","headCommitId":"commit-1"}],
        "commits":[{
            "id":"commit-1","branchId":"main","parentId":parent_id,"message":"fixture","createdAt":"2026-01-01T00:00:00Z",
            "snapshot":{
                "resumeTitle":source_title,"summaryTitle":"自我评价",
                "resume":{"basic":{"name":"Synthetic","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},"summary":"","education":[],"skills":[],"work":[{"id":"entry-1","title":source_title,"role":"","department":"","city":"","start":"2024","end":"","html":"<p>Synthetic</p>"}],"projects":[],"orgs":[],"research":[],"awards":[],"other":[],"portfolio":[],"custom":[]},
                "moduleOrder":["work","summary"],"moduleNames":{"work":"工作经历"},
                "layout":{"font":"宋体","fontSize":"13","lineHeight":"13","moduleSpacing":"0","pageMargin":"30","theme":"#000000","dateFormat":"2021年1月","titleFormat":"单行标题","separator":"使用分隔符号","textAlign":"系统默认"}
            }
        }]
    });
    let raw_json = source_json.to_string();
    let source_sha256 = format!("{:x}", Sha256::digest(raw_json.as_bytes()));
    let source = LegacyMigrationSourceInput {
        source_id: "versions".into(),
        kind: LegacyMigrationSourceKind::VersionJson,
        raw_json,
    };
    let mut converted = document(&cursor.document_id);
    converted.title = converted_title.into();
    CommitLegacyMigrationRequest {
        command_id: command_id.into(),
        cursor,
        inspection: InspectLegacyMigrationRequest {
            source_namespace: Some("library-a".into()),
            sources: vec![source],
        },
        expected_source_hashes: vec![LegacyMigrationExpectedHash {
            source_id: "versions".into(),
            source_sha256,
        }],
        confirmed: true,
        acknowledged_review_items: Vec::new(),
        accepted_identity_updates: Vec::new(),
        current_draft: Some(converted.clone()),
        version_graph: Some(LegacyMigrationVersionGraph {
            source_id: "versions".into(),
            current_branch_id: "main".into(),
            branches: vec![LegacyMigrationVersionBranch {
                id: "main".into(),
                name: "Imported main".into(),
                head_commit_id: Some("commit-1".into()),
                created_at: "2026-01-01T00:00:00Z".into(),
            }],
            commits: vec![LegacyMigrationVersionCommit {
                id: "commit-1".into(),
                branch_id: "main".into(),
                parent_id: parent_id.map(str::to_string),
                message: "fixture".into(),
                created_at: "2026-01-01T00:00:00Z".into(),
                snapshot: converted,
            }],
        }),
        preferences: Vec::new(),
        templates: None,
    }
}

fn identity_migration_request(
    cursor: AuthorityCursor,
    text: &str,
) -> crate::migration::CommitLegacyMigrationRequest {
    use crate::migration::{
        LegacyMigrationExpectedHash, LegacyMigrationSourceInput, LegacyMigrationSourceKind,
    };
    use serde_json::json;
    let mut request = legacy_migration_request(
        cursor,
        "identity source",
        "identity draft",
        None,
        "identity-import",
    );
    let accounts = json!({"version":1,"accounts":[{
        "id":"legacy-identity-account","email":"identity-migration@example.com",
        "salt":"0123456789abcdef0123456789abcdef",
        "passwordHash":"2a6389fa6e25b6b6825dbdc48b528f1ea4664b8f414aaaca42c308771a248049d7ae5077d8c02cac2f5956664a51ea802e02f798daa62c6151aded48d87346cc",
        "provider":{"name":"Legacy fixture","baseUrl":"https://example.com","model":"fixture-model","apiKey":"legacy-secret-must-not-migrate"}
    }],"sessions":[{"accountId":"legacy-identity-account","tokenHash":"excluded-live-token","expiresAt":9999999999999i64}]});
    let sessions = json!({"activeId":"legacy-chat","sessions":[{
        "id":"legacy-chat","title":"旧会话","createdAt":1000,"updatedAt":2000,"status":"running",
        "messages":[{"id":"legacy-message","role":"assistant","text":text}]
    }]});
    let entries = json!([
        ["resume-diy-agent-accounts", accounts.to_string()],
        [
            "resume-diy-agent-sessions-v2:legacy-identity-account",
            sessions.to_string()
        ]
    ]);
    let entry_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&entries).unwrap())
    );
    let raw_json = json!({"format":"zinecv-legacy-browser-export","version":1,
        "origin":"http://127.0.0.1:5173","sourceHash":entry_hash,"entries":entries})
    .to_string();
    request
        .expected_source_hashes
        .push(LegacyMigrationExpectedHash {
            source_id: "identity-browser".into(),
            source_sha256: format!("{:x}", Sha256::digest(raw_json.as_bytes())),
        });
    request.inspection.sources.push(LegacyMigrationSourceInput {
        source_id: "identity-browser".into(),
        kind: LegacyMigrationSourceKind::BrowserExport,
        raw_json,
    });
    let report = crate::migration::inspect(&request.inspection);
    assert!(report.ready_for_dry_run, "{report:?}");
    assert_eq!(report.totals.account_records, 1);
    assert_eq!(report.totals.provider_profiles, 1);
    assert_eq!(report.totals.live_session_tokens_not_migrated, 1);
    request.acknowledged_review_items = crate::migration::required_review_item_keys(&report);
    request
}

fn legacy_avatar_migration_request(
    cursor: AuthorityCursor,
) -> (CommitLegacyMigrationRequest, Vec<u8>, String) {
    let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM90AAAAASUVORK5CYII=";
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let data_url = format!("data:image/png;base64,{encoded}");
    let mut request = legacy_migration_request(
        cursor,
        "avatar source",
        "avatar draft",
        None,
        "avatar-migration",
    );
    let source = &mut request.inspection.sources[0];
    let mut raw: serde_json::Value = serde_json::from_str(&source.raw_json).unwrap();
    raw["commits"][0]["snapshot"]["resume"]["basic"]["avatar"] = data_url.clone().into();
    source.raw_json = raw.to_string();
    request.expected_source_hashes[0].source_sha256 =
        format!("{:x}", Sha256::digest(source.raw_json.as_bytes()));
    request
        .current_draft
        .as_mut()
        .unwrap()
        .legacy_extensions
        .insert("legacyAvatar".into(), data_url.clone().into());
    request.version_graph.as_mut().unwrap().commits[0]
        .snapshot
        .legacy_extensions
        .insert("legacyAvatar".into(), data_url.into());
    request.acknowledged_review_items =
        migration::required_review_item_keys(&migration::inspect(&request.inspection));
    (request, bytes, hash)
}

fn legacy_template_preview_request(
    cursor: AuthorityCursor,
) -> (CommitLegacyMigrationRequest, Vec<u8>, String) {
    let (mut request, bytes, hash) = legacy_avatar_migration_request(cursor);
    let preview = request.current_draft.as_ref().unwrap().legacy_extensions["legacyAvatar"]
        .as_str()
        .unwrap()
        .to_string();
    let templates = serde_json::json!([{
        "id":"legacy-image-template", "name":"Synthetic template", "sourceName":"fixture.png",
        "sourceType":"image", "createdAt":"2026-10-08T00:00:00Z", "accent":"#123456",
        "formatId":"legacy-v1", "layout":"single-column", "analysis":"Synthetic only",
        "previewDataUrl":preview
    }]);
    let entries = serde_json::json!([["resume-diy-imported-templates-v1", templates.to_string()]]);
    let raw_json = serde_json::json!({"format":"zinecv-legacy-browser-export","version":1,
        "origin":"http://127.0.0.1:5173",
        "sourceHash":format!("{:x}", Sha256::digest(serde_json::to_vec(&entries).unwrap())),
        "entries":entries})
    .to_string();
    request
        .expected_source_hashes
        .push(crate::migration::LegacyMigrationExpectedHash {
            source_id: "template-browser".into(),
            source_sha256: format!("{:x}", Sha256::digest(raw_json.as_bytes())),
        });
    request
        .inspection
        .sources
        .push(crate::migration::LegacyMigrationSourceInput {
            source_id: "template-browser".into(),
            kind: crate::migration::LegacyMigrationSourceKind::BrowserExport,
            raw_json,
        });
    request.templates = Some(crate::migration::LegacyMigrationTemplates {
        expected_revision: "0".into(),
        catalog_json: templates.to_string(),
    });
    request.acknowledged_review_items =
        migration::required_review_item_keys(&migration::inspect(&request.inspection));
    (request, bytes, hash)
}

fn commit(store: &mut Store, document_id: &str, message: &str) -> AuthorityCursor {
    let cursor = store
        .load_cursor(document_id, "context-a")
        .expect("cursor")
        .expect("document");
    store.commit_draft(&cursor, message).expect("commit")
}

fn edit_title(
    store: &mut Store,
    cursor: &AuthorityCursor,
    command_id: &str,
    title: &str,
) -> AuthorityCursor {
    use zinecv_contracts::{CommandEnvelope, DomainCommand};
    store
        .apply_command(
            "host-actor",
            CommandEnvelope {
                protocol_version: 1,
                command_id: command_id.into(),
                document_id: cursor.document_id.clone(),
                context_id: cursor.context_id.clone(),
                expected_revision: cursor.revision.clone(),
                expected_branch_id: cursor.branch_id.clone(),
                expected_head_id: cursor.head_id.clone(),
                payload: DomainCommand::SetDocumentTitle {
                    title: title.into(),
                },
            },
        )
        .expect("edit title")
        .cursor
}

fn import_candidate(id: &str, value: &str) -> zinecv_contracts::ImportCandidate {
    use zinecv_contracts::{
        ImportBasicField, ImportCandidate, ImportCandidateValue, ImportFieldEvidence,
    };
    ImportCandidate {
        id: id.into(),
        label: "姓名".into(),
        value: ImportCandidateValue::BasicField {
            field: ImportBasicField::Name,
            value: value.into(),
        },
        evidence: ImportFieldEvidence {
            page: Some(1),
            excerpt: value.into(),
            source_field: Some("name".into()),
            confidence: "high".into(),
        },
    }
}

fn review_import_draft(
    store: &mut Store,
    id: &str,
    preview: bool,
) -> zinecv_contracts::ImportDraft {
    let target_document_id = store
        .list_documents(false)
        .expect("document list")
        .into_iter()
        .map(|meta| meta.document_id)
        .next()
        .unwrap_or_else(|| "workspace-default-document".into());
    use zinecv_contracts::{
        CreateImportDraftRequest, ImportDraftStatus, ImportSourceKind, TransitionImportDraftRequest,
    };
    let hash = "a".repeat(64);
    store
        .create_import_draft(&CreateImportDraftRequest {
            expected_epoch: 1,
            target_document_id,
            draft_id: id.into(),
            source_kind: ImportSourceKind::Pdf,
            display_name: "fixture.pdf".into(),
            source_hash: hash,
        })
        .expect("queued import draft");
    store
        .transition_import_draft(&TransitionImportDraftRequest {
            draft_id: id.into(),
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
            draft_id: id.into(),
            expected_status: ImportDraftStatus::Running,
            next_status: ImportDraftStatus::ReviewRequired,
            candidates: Some(vec![import_candidate("candidate-name", "导入姓名")]),
            warnings: Some(vec!["仅合成测试输入".into()]),
            unsupported_features: Some(vec![]),
            preview_data_url: preview.then(|| "data:image/png;base64,AQID".into()),
            extracted_text: None,
        })
        .expect("review import draft")
}

fn imported_template_with_preview(id: &str, preview_data_url: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": "合成模板",
        "sourceName": "synthetic.pdf",
        "sourceType": "pdf",
        "createdAt": "2026-10-01T00:00:00.000Z",
        "previewDataUrl": preview_data_url,
        "accent": "#224466",
        "formatId": "legacy-v1",
        "layout": "single-column",
        "analysis": "合成版式分析",
        "extractedText": "合成文本内容",
        "detectedFont": "Source Han Serif",
        "presentation": { "fontSetId": "legacy-font:Source Han Serif" }
    })
}

fn synthetic_preview_data_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

#[path = "tests/connection_preserves_backup_validation.rs"]
mod connection_preserves_backup_validation;
#[path = "tests/creating_branch_commits_current.rs"]
mod creating_branch_commits_current;
#[path = "tests/deleting_branch_with_resource.rs"]
mod deleting_branch_with_resource;
#[path = "tests/export_receipts.rs"]
mod export_receipts;
#[path = "tests/import_candidate_corrections.rs"]
mod import_candidate_corrections;
#[path = "tests/import_draft_stays_separate.rs"]
mod import_draft_stays_separate;
#[path = "tests/imported_source_contexts_keep.rs"]
mod imported_source_contexts_keep;
#[path = "tests/legacy_identity_multiple_browser.rs"]
mod legacy_identity_multiple_browser;
#[path = "tests/legacy_template_previews_reprepared.rs"]
mod legacy_template_previews_reprepared;
#[path = "tests/m2_mutations.rs"]
mod m2_mutations;
#[path = "tests/migration_11_externalizes_legacy.rs"]
mod migration_11_externalizes_legacy;
#[path = "tests/template_activity_migrates_once.rs"]
mod template_activity_migrates_once;
#[path = "tests/two_connections_enforce_cas.rs"]
mod two_connections_enforce_cas;

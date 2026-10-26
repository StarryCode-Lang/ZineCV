use super::*;
use serde_json::json;
use ts_rs::TS;

fn source(
    source_id: &str,
    kind: LegacyMigrationSourceKind,
    value: serde_json::Value,
) -> LegacyMigrationSourceInput {
    LegacyMigrationSourceInput {
        source_id: source_id.into(),
        kind,
        raw_json: value.to_string(),
    }
}

fn version_store(commit_id: &str, title: &str) -> serde_json::Value {
    json!({
        "currentBranchId": "main",
        "branches": [{"id":"main","name":"默认版本","createdAt":"2026-01-01T00:00:00Z","headCommitId":commit_id}],
        "commits": [{
            "id":commit_id,"branchId":"main","parentId":null,"message":"fixture","createdAt":"2026-01-01T00:00:00Z",
            "snapshot": {
                "resumeTitle":title,
                "summaryTitle":"自我评价",
                "resume":{"basic":{"name":"合成","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},"summary":"","education":[],"skills":[],"work":[{"id":"entry-1","title":title,"role":"","department":"","city":"","start":"2024","end":"","html":"<p>合成</p>"}],"projects":[],"orgs":[],"research":[],"awards":[],"other":[],"portfolio":[],"custom":[]},
                "moduleOrder":["work","summary"],
                "moduleNames":{"work":"工作经历"},
                "layout":{"font":"宋体","fontSize":"13","lineHeight":"13","moduleSpacing":"0","pageMargin":"30","theme":"#000000","dateFormat":"2021年1月","titleFormat":"单行标题","separator":"使用分隔符号","textAlign":"系统默认"}
            }
        }]
    })
}

fn browser_export(value: serde_json::Value) -> serde_json::Value {
    let entries = json!([["resume-diy-version-store-v1", value.to_string()]]);
    let source_hash = sha256(&serde_json::to_vec(&entries).unwrap());
    json!({
        "format":"zinecv-legacy-browser-export",
        "version":1,
        "origin":LEGACY_ORIGIN,
        "exportedAt":"2026-09-30T00:00:00.000Z",
        "sourceHash":source_hash,
        "entries":entries
    })
}

#[test]
fn browser_export_inspection_checks_hash_origin_and_keys() {
    let inspect_export = |value| {
        inspect(&InspectLegacyMigrationRequest {
            source_namespace: Some("library-a".into()),
            sources: vec![source(
                "browser",
                LegacyMigrationSourceKind::BrowserExport,
                value,
            )],
        })
    };
    let original = browser_export(version_store("commit-1", "合成简历"));
    assert!(inspect_export(original.clone()).ready_for_dry_run);

    let mut bad_hash = original.clone();
    bad_hash["sourceHash"] = json!("0".repeat(64));
    let report = inspect_export(bad_hash);
    assert!(!report.ready_for_dry_run);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "browser_entry_hash_mismatch"));

    let mut bad_origin = original.clone();
    bad_origin["origin"] = json!("https://other.example");
    let report = inspect_export(bad_origin);
    assert!(!report.ready_for_dry_run);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "unexpected_browser_origin"));

    for (entries, code) in [
        (
            json!([["resume-diy-state", "{}"], ["resume-diy-state", "{}"]]),
            "duplicate_browser_key",
        ),
        (
            json!([["another-app-secret", "not our key"]]),
            "foreign_browser_key",
        ),
    ] {
        let mut candidate = original.clone();
        candidate["sourceHash"] = json!(sha256(&serde_json::to_vec(&entries).unwrap()));
        candidate["entries"] = entries;
        let report = inspect_export(candidate);
        assert!(!report.ready_for_dry_run);
        assert!(
            report.issues.iter().any(|issue| issue.code == code),
            "{code}"
        );
    }

    let entries = json!([["resume-diy-future-key", "keep"]]);
    let mut unknown = original;
    unknown["sourceHash"] = json!(sha256(&serde_json::to_vec(&entries).unwrap()));
    unknown["entries"] = entries;
    let report = inspect_export(unknown);
    assert!(report.issues.iter().any(|issue| {
        issue.code == "unknown_browser_key" && issue.severity == LegacyMigrationSeverity::Review
    }));
}

#[test]
fn versions_only_inspection_does_not_infer_a_current_draft() {
    let request = InspectLegacyMigrationRequest {
        source_namespace: Some("library-a".into()),
        sources: vec![source(
            "versions",
            LegacyMigrationSourceKind::VersionJson,
            version_store("commit-1", "合成简历"),
        )],
    };
    let report = inspect(&request);
    assert!(report.ready_for_dry_run);
    assert!(!report.sources[0].current_draft_present);
    assert_eq!(report.sources[0].counts.version_commits, 1);
    assert_eq!(report.sources[0].counts.entries, 1);
    assert!(report.sources[0]
        .field_evidence
        .iter()
        .any(|item| item.status == "not_inferred_from_versions_only"));
}

#[test]
fn version_graph_requires_schema_fields_before_dry_run() {
    let mut value = version_store("commit-1", "合成简历");
    value["branches"][0]
        .as_object_mut()
        .unwrap()
        .remove("createdAt");
    value["branches"][0]
        .as_object_mut()
        .unwrap()
        .remove("headCommitId");
    value["commits"][0]
        .as_object_mut()
        .unwrap()
        .remove("message");
    value["commits"][0]
        .as_object_mut()
        .unwrap()
        .remove("createdAt");

    let report = inspect(&InspectLegacyMigrationRequest {
        source_namespace: Some("library-a".into()),
        sources: vec![source(
            "versions",
            LegacyMigrationSourceKind::VersionJson,
            value,
        )],
    });

    assert!(!report.ready_for_dry_run);
    for code in [
        "missing_branch_timestamp",
        "missing_branch_head",
        "invalid_commit_message",
        "missing_commit_timestamp",
    ] {
        assert!(
            report.issues.iter().any(|issue| issue.code == code),
            "{code}"
        );
    }
}

#[test]
fn version_graph_keeps_pruned_parent_and_deleted_branch_ancestor_as_diagnostics() {
    let mut value = version_store("head", "合成简历");
    let mut ancestor = value["commits"][0].clone();
    ancestor["id"] = json!("orphan-commit");
    ancestor["branchId"] = json!("deleted-branch");
    ancestor["parentId"] = json!("pruned-parent");
    let mut head = ancestor.clone();
    head["id"] = json!("head");
    head["branchId"] = json!("main");
    head["parentId"] = json!("orphan-commit");
    value["branches"][0]["headCommitId"] = json!("head");
    value["commits"] = json!([ancestor, head]);

    let report = inspect(&InspectLegacyMigrationRequest {
        source_namespace: Some("library-a".into()),
        sources: vec![source(
            "versions",
            LegacyMigrationSourceKind::VersionJson,
            value,
        )],
    });

    assert!(report.ready_for_dry_run);
    assert!(report.issues.iter().any(|issue| {
        issue.code == "unknown_commit_parent" && issue.severity == LegacyMigrationSeverity::Info
    }));
    assert!(report.issues.iter().any(|issue| {
        issue.code == "unknown_commit_branch" && issue.severity == LegacyMigrationSeverity::Info
    }));
}

#[test]
fn corrupt_browser_primary_keeps_a_valid_backup_as_review_only() {
    let entries = json!([
        ["resume-diy-version-store-v1", "{"],
        [
            "resume-diy-version-store-v1-backup",
            version_store("backup-1", "备份合成").to_string()
        ]
    ]);
    let source_hash = sha256(&serde_json::to_vec(&entries).unwrap());
    let export = json!({
        "format":"zinecv-legacy-browser-export","version":1,"origin":LEGACY_ORIGIN,
        "exportedAt":"2026-09-30T00:00:00.000Z","sourceHash":source_hash,"entries":entries
    });
    let report = inspect(&InspectLegacyMigrationRequest {
        source_namespace: Some("library-a".into()),
        sources: vec![source(
            "browser",
            LegacyMigrationSourceKind::BrowserExport,
            export,
        )],
    });
    assert!(!report.ready_for_dry_run);
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "version_backup_recoverable"));
    assert!(report.sources[0]
        .issues
        .iter()
        .any(|issue| issue.code == "invalid_stored_json"));
    assert!(report.no_target_writes);
}

#[test]
fn same_id_conflict_and_same_content_distinct_commit_are_reported_separately() {
    let request = InspectLegacyMigrationRequest {
        source_namespace: Some("library-a".into()),
        sources: vec![
            source(
                "versions-a",
                LegacyMigrationSourceKind::VersionJson,
                version_store("commit-shared", "第一版"),
            ),
            source(
                "browser",
                LegacyMigrationSourceKind::BrowserExport,
                browser_export(version_store("commit-shared", "冲突内容")),
            ),
            source(
                "versions-c",
                LegacyMigrationSourceKind::VersionJson,
                version_store("commit-distinct", "第一版"),
            ),
        ],
    };
    let report = inspect(&request);
    assert!(report
        .conflicts
        .iter()
        .any(|conflict| conflict.kind == LegacyMigrationConflictKind::SameIdDifferentContent));
    assert!(report
        .conflicts
        .iter()
        .any(|conflict| conflict.kind == LegacyMigrationConflictKind::SameContentDifferentCommit));
    assert!(report
        .conflicts
        .iter()
        .any(|conflict| conflict.kind == LegacyMigrationConflictKind::BrowserVersionConflict));
}

#[test]
fn account_inspection_redacts_secrets_and_excludes_live_sessions() {
    let request = InspectLegacyMigrationRequest {
        source_namespace: None,
        sources: vec![source(
            "accounts",
            LegacyMigrationSourceKind::AccountJson,
            json!({
                "accounts":[{"id":"account-fixture","email":"fixture@example.invalid","passwordHash":"scrypt-fixture","provider":{"apiKey":"fixture-secret","sessionToken":"fixture-token"}}]
            }),
        )],
    };
    let report = inspect(&request);
    let output = serde_json::to_string(&report).unwrap();
    assert_eq!(report.totals.account_records, 1);
    assert_eq!(report.totals.provider_secrets_need_reentry, 1);
    assert_eq!(report.totals.live_session_tokens_not_migrated, 1);
    assert!(!output.contains("fixture-secret"));
    assert!(!output.contains("scrypt-fixture"));
    assert!(report.namespace_decision_required);
}

#[test]
fn dry_run_detects_changed_source_hash_without_target_write() {
    let inspection = InspectLegacyMigrationRequest {
        source_namespace: Some("library-a".into()),
        sources: vec![source(
            "versions",
            LegacyMigrationSourceKind::VersionJson,
            version_store("commit-1", "合成简历"),
        )],
    };
    let result = dry_run(&DryRunLegacyMigrationRequest {
        inspection,
        expected_source_hashes: vec![LegacyMigrationExpectedHash {
            source_id: "versions".into(),
            source_sha256: "00".repeat(32),
        }],
        converted_documents: vec![],
    });
    assert!(!result.source_hashes_match);
    assert!(result.target_database_unchanged);
    assert_eq!(result.status, "source_changed");
}

#[test]
fn dry_run_stages_namespaced_identity_mapping_in_memory() {
    let value = version_store("commit-1", "合成简历");
    let raw_json = value.to_string();
    let source_hash = sha256(raw_json.as_bytes());
    let source = LegacyMigrationSourceInput {
        source_id: "versions".into(),
        kind: LegacyMigrationSourceKind::VersionJson,
        raw_json,
    };
    let result = dry_run(&DryRunLegacyMigrationRequest {
        inspection: InspectLegacyMigrationRequest {
            source_namespace: Some("library-a".into()),
            sources: vec![source],
        },
        expected_source_hashes: vec![LegacyMigrationExpectedHash {
            source_id: "versions".into(),
            source_sha256: source_hash.clone(),
        }],
        converted_documents: vec![LegacyMigrationConvertedDocument {
            source_id: "versions".into(),
            source_sha256: source_hash,
            document_kind: LegacyMigrationDocumentKind::VersionCommit,
            legacy_id: "commit-1".into(),
            document: zinecv_domain::default_resume_document("converted-fixture").unwrap(),
        }],
    });
    assert_eq!(result.status, "ready");
    assert!(result.staging_database_created);
    assert!(result.staged_identity_count >= 3);
    assert_eq!(result.staged_document_count, 1);
    assert!(result.conversion_complete);
    assert!(result.target_database_unchanged);
    assert_eq!(
        result.identity_mapping_namespace.as_deref(),
        Some("library-a")
    );
}

#[test]
fn export_bindings_for_migration_contract() {
    let config = ts_rs::Config::default();
    let _ = LegacyMigrationSourceKind::export_to_string(&config).unwrap();
    let _ = LegacyMigrationSourceInput::export_to_string(&config).unwrap();
    let _ = InspectLegacyMigrationRequest::export_to_string(&config).unwrap();
    let _ = LegacyMigrationSeverity::export_to_string(&config).unwrap();
    let _ = LegacyMigrationIssue::export_to_string(&config).unwrap();
    let _ = LegacyMigrationCounts::export_to_string(&config).unwrap();
    let _ = LegacyMigrationFieldEvidence::export_to_string(&config).unwrap();
    let _ = LegacyMigrationSourceReport::export_to_string(&config).unwrap();
    let _ = LegacyMigrationConflictKind::export_to_string(&config).unwrap();
    let _ = LegacyMigrationConflict::export_to_string(&config).unwrap();
    let _ = LegacyMigrationReport::export_to_string(&config).unwrap();
    let _ = LegacyMigrationExpectedHash::export_to_string(&config).unwrap();
    let _ = DryRunLegacyMigrationRequest::export_to_string(&config).unwrap();
    let _ = LegacyMigrationDocumentKind::export_to_string(&config).unwrap();
    let _ = LegacyMigrationConvertedDocument::export_to_string(&config).unwrap();
    let _ = LegacyMigrationDryRun::export_to_string(&config).unwrap();
    let _ = LegacyMigrationVersionBranch::export_to_string(&config).unwrap();
    let _ = LegacyMigrationVersionCommit::export_to_string(&config).unwrap();
    let _ = LegacyMigrationVersionGraph::export_to_string(&config).unwrap();
    let _ = CommitLegacyMigrationRequest::export_to_string(&config).unwrap();
    let _ = LegacyMigrationCommitReceipt::export_to_string(&config).unwrap();
    let _ = InspectLegacyIdentityConflictsRequest::export_to_string(&config).unwrap();
    let _ = LegacyMigrationIdentityConflict::export_to_string(&config).unwrap();
}

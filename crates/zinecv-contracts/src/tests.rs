use super::*;

fn document() -> ResumeDocument {
    serde_json::from_str(r##"{
          "schemaVersion": 2,
          "documentId": "doc-1",
          "title": "测试简历",
          "basic": {"name":"样例","phone":"","email":"","city":"","wechat":"","birth":"","ageMode":"age"},
          "sections": [
            {"id":"summary-1","kind":"summary","title":"自我评价","visible":true,"body":[{"type":"paragraph","children":[{"type":"text","text":"本地","marks":[]}]}]},
            {"id":"work-1","kind":"work","title":"工作","visible":true,"entries":[{"id":"entry-1","title":"工程师","role":"","department":"","city":"","start":"2024","end":"2025","body":[{"type":"paragraph","children":[{"type":"text","text":"工作","marks":[]}]}]}]}
          ],
          "presentation": {"templateId":"legacy-v1","templateRevision":"1","density":"standard","fontSetId":"fixture","fontSizePt":9.75,"lineHeightPt":12,"moduleGapPt":8,"pageMarginPt":24,"headingSizePt":11,"paragraphGapPt":4,"listGapPt":4,"theme":"#000000","dateFormat":"2021.01","titleFormat":"双行标题","separator":"不使用分隔符号","textAlign":"系统默认","legacyOverrides":{}},
          "legacyExtensions": {"unknownField":{"safe":true}}
        }"##).expect("valid fixture")
}

#[test]
fn preserves_unknown_fields_and_hashes_stably() {
    let value = document();
    let json = serde_json::to_value(&value).expect("serialize");
    assert_eq!(json["legacyExtensions"]["unknownField"]["safe"], true);
    let first = canonical_hash(&value).expect("hash");
    let round_trip: ResumeDocument = serde_json::from_value(json).expect("deserialize");
    assert_eq!(first, canonical_hash(&round_trip).expect("hash"));
}

#[test]
fn public_mutation_contract_rejects_unlisted_and_account_scoped_fields() {
    let confirm = serde_json::json!({
        "commandId": "cmd-confirm-123",
        "cursor": {
            "documentId": "doc-1",
            "contextId": "context-1",
            "revision": "0",
            "branchId": "main",
            "headId": null
        },
        "proposalId": "proposal-1",
        "acceptedItemIds": ["item-1"]
    });
    assert!(serde_json::from_value::<ConfirmProposalRequest>(confirm.clone()).is_ok());
    let mut cross_account = confirm;
    cross_account["accountId"] = serde_json::json!("attacker-account");
    assert!(serde_json::from_value::<ConfirmProposalRequest>(cross_account).is_err());

    let mut envelope = serde_json::json!({
        "protocolVersion": 1,
        "commandId": "cmd-title-123",
        "documentId": "doc-1",
        "contextId": "context-1",
        "expectedRevision": "0",
        "expectedBranchId": "main",
        "expectedHeadId": null,
        "payload": { "type": "setDocumentTitle", "title": "更新" }
    });
    assert!(serde_json::from_value::<CommandEnvelope>(envelope.clone()).is_ok());
    envelope["payload"]["accountId"] = serde_json::json!("attacker-account");
    assert!(serde_json::from_value::<CommandEnvelope>(envelope).is_err());

    let unknown_template = serde_json::json!({
        "commandId": "cmd-template-123",
        "cursor": {
            "documentId": "doc-1",
            "contextId": "context-1",
            "revision": "0",
            "branchId": "main",
            "headId": null
        },
        "templateId": "untrusted-template",
        "templateRevision": "1"
    });
    assert!(serde_json::from_value::<ApplyTemplateRequest>(unknown_template).is_err());
}

#[test]
fn app_errors_have_distinct_diagnostic_ids() {
    let first = AppError::new(ErrorCode::Conflict, "stale cursor", false);
    let second = AppError::new(ErrorCode::Conflict, "stale cursor", false);
    assert_ne!(first.diagnostic_id, second.diagnostic_id);
    assert!(first.diagnostic_id.starts_with("diag-"));
}

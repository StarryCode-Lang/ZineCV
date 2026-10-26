use super::*;

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn valid_source_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(super) fn valid_namespace(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub(super) fn add_issue(
    issues: &mut Vec<LegacyMigrationIssue>,
    source_id: &str,
    code: &str,
    path: &str,
    severity: LegacyMigrationSeverity,
    message: &str,
) {
    issues.push(LegacyMigrationIssue {
        source_id: source_id.into(),
        code: code.into(),
        path: path.into(),
        severity,
        message: message.into(),
    });
}

pub(super) fn add_evidence(
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    field: &str,
    records: usize,
    status: &str,
) {
    evidence.push(LegacyMigrationFieldEvidence {
        field: field.into(),
        records: records.min(u32::MAX as usize) as u32,
        status: status.into(),
    });
}

pub(super) fn as_record(
    value: &serde_json::Value,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.as_object()
}

pub(super) fn nonempty_string(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

pub(super) fn parse_embedded_json(
    value: Option<&String>,
    source_id: &str,
    key: &str,
    issues: &mut Vec<LegacyMigrationIssue>,
) -> Option<serde_json::Value> {
    let raw = value?;
    match serde_json::from_str(raw) {
        Ok(value) => Some(value),
        Err(_) => {
            add_issue(
                issues,
                source_id,
                "invalid_stored_json",
                key,
                LegacyMigrationSeverity::Error,
                "A stored JSON field is malformed; its source bytes remain unchanged.",
            );
            None
        }
    }
}

pub(super) fn fingerprint_entity(
    source_id: &str,
    kind: &str,
    id: &str,
    value: &serde_json::Value,
    name: Option<&str>,
) -> EntityFingerprint {
    EntityFingerprint {
        source_id: source_id.into(),
        kind: kind.into(),
        id: id.into(),
        content_hash: sha256(&serde_json::to_vec(value).unwrap_or_default()),
        name: name.map(str::to_string),
    }
}

pub(super) fn read_known_browser_key(key: &str) -> bool {
    const FIXED: [&str; 21] = [
        "resume-diy-agent-accounts",
        "resume-diy-active-imported-template",
        "resume-diy-agent-mode-v1",
        "resume-diy-agent-position-v1",
        "resume-diy-agent-size-v1",
        "resume-diy-editor-pane-width",
        "resume-diy-imported-templates-v1",
        "resume-diy-layout-consistency-v1",
        "resume-diy-module-names",
        "resume-diy-modules",
        "resume-diy-preferences",
        "resume-diy-presentation-v1",
        "resume-diy-section-order-v2",
        "resume-diy-smart-fit-signature-v3",
        "resume-diy-state",
        "resume-diy-summary-title",
        "resume-diy-template-library-v1",
        "resume-diy-title",
        "resume-diy-version-project-revision",
        "resume-diy-version-store-v1",
        "resume-diy-version-store-v1-backup",
    ];
    FIXED.contains(&key)
        || key.starts_with("resume-diy-agent-sessions-v2:")
        || key.starts_with("resume-diy-source-preview-dismissed:")
}

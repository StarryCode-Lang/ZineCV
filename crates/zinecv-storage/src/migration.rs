//! Read-only inspection and dry-run support for legacy JSON sources.
//!
//! Source strings are supplied by the UI after an explicit file selection. This
//! module never opens browser profiles, resolves source paths, or writes to the
//! active Store. Commit and receipt persistence are owned by the later R20 path.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use base64::Engine;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const IMPORTER_VERSION: &str = "r19.1";
const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: usize = 128 * 1024 * 1024;
const MAX_SOURCE_COUNT: usize = 8;
const LEGACY_ORIGIN: &str = "http://127.0.0.1:5173";

const MODULE_KEYS: [&str; 10] = [
    "education",
    "skills",
    "work",
    "projects",
    "orgs",
    "research",
    "awards",
    "other",
    "portfolio",
    "custom",
];
const BASIC_KEYS: [&str; 19] = [
    "name",
    "phone",
    "email",
    "city",
    "wechat",
    "birth",
    "ageMode",
    "website",
    "linkedin",
    "gender",
    "height",
    "weight",
    "ethnicity",
    "birthplace",
    "politicalStatus",
    "maritalStatus",
    "zodiac",
    "mbti",
    "avatar",
];

// C+ P1b：全部 25 个导出契约类型已并入 crates/zinecv-contracts（serde 形状与
// ts-rs 绑定输出不变，`LegacyMigrationCounts::add_assign` 随迁并转 pub）；
// 此处再出口保持 `crate::migration::*` 既有引用路径不变。
pub use zinecv_contracts::{
    CommitLegacyMigrationRequest, DryRunLegacyMigrationRequest,
    InspectLegacyIdentityConflictsRequest, InspectLegacyMigrationRequest,
    LegacyMigrationCommitReceipt, LegacyMigrationConflict, LegacyMigrationConflictKind,
    LegacyMigrationConvertedDocument, LegacyMigrationCounts, LegacyMigrationDocumentKind,
    LegacyMigrationDryRun, LegacyMigrationExpectedHash, LegacyMigrationFieldEvidence,
    LegacyMigrationIdentityConflict, LegacyMigrationIssue, LegacyMigrationPreference,
    LegacyMigrationReport, LegacyMigrationSeverity, LegacyMigrationSourceInput,
    LegacyMigrationSourceKind, LegacyMigrationSourceReport, LegacyMigrationTemplates,
    LegacyMigrationVersionBranch, LegacyMigrationVersionCommit, LegacyMigrationVersionGraph,
};

#[derive(Debug, Clone)]
struct EntityFingerprint {
    source_id: String,
    kind: String,
    id: String,
    content_hash: String,
    name: Option<String>,
}

#[derive(Debug, Clone)]
struct InternalSourceResult {
    report: LegacyMigrationSourceReport,
    entities: Vec<EntityFingerprint>,
    version_store_hash: Option<String>,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn stable_native_id(namespace: &str, entity_kind: &str, legacy_id: &str) -> String {
    let material = format!("{namespace}\0{entity_kind}\0{legacy_id}");
    format!("legacy-{}", sha256(material.as_bytes()))
}

pub fn identity_conflict_key(namespace: &str, entity_kind: &str, legacy_id: &str) -> String {
    let material = format!("{namespace}\0{entity_kind}\0{legacy_id}");
    sha256(material.as_bytes())
}

pub fn source_batch_key(report: &LegacyMigrationReport) -> Option<String> {
    let namespace = report.source_namespace.as_deref()?;
    let mut sources: Vec<(&str, &str)> = report
        .sources
        .iter()
        .map(|source| (source.source_id.as_str(), source.source_sha256.as_str()))
        .collect();
    sources.sort_unstable();
    let material = format!(
        "{IMPORTER_VERSION}\0{namespace}\0{}",
        sources
            .into_iter()
            .map(|(source_id, hash)| format!("{source_id}\0{hash}"))
            .collect::<Vec<_>>()
            .join("\0")
    );
    Some(sha256(material.as_bytes()))
}

pub fn expected_source_hashes_match(
    report: &LegacyMigrationReport,
    expected_source_hashes: &[LegacyMigrationExpectedHash],
) -> bool {
    let expected: HashMap<&str, &str> = expected_source_hashes
        .iter()
        .map(|item| (item.source_id.as_str(), item.source_sha256.as_str()))
        .collect();
    let actual: HashMap<&str, &str> = report
        .sources
        .iter()
        .map(|source| (source.source_id.as_str(), source.source_sha256.as_str()))
        .collect();
    expected.len() == expected_source_hashes.len()
        && expected == actual
        && report.sources.iter().all(|source| {
            expected.get(source.source_id.as_str()) == Some(&source.source_sha256.as_str())
        })
}

pub fn review_item_key(issue: &LegacyMigrationIssue) -> String {
    let material = format!("{}\0{}\0{}", issue.source_id, issue.code, issue.path);
    sha256(material.as_bytes())
}

pub fn required_review_item_keys(report: &LegacyMigrationReport) -> Vec<String> {
    let mut keys = report
        .issues
        .iter()
        .chain(
            report
                .sources
                .iter()
                .flat_map(|source| source.issues.iter()),
        )
        .filter(|issue| issue.severity == LegacyMigrationSeverity::Review)
        .map(review_item_key)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    keys.dedup();
    keys
}

fn valid_source_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_namespace(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn add_issue(
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

fn add_evidence(
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

fn as_record(value: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value.as_object()
}

fn nonempty_string(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

fn parse_embedded_json(
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

fn fingerprint_entity(
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

// The same accumulator bundle is threaded through the bounded legacy JSON walk.
#[allow(clippy::too_many_arguments)]
fn inspect_resume_state(
    state: &serde_json::Value,
    source_id: &str,
    path: &str,
    strict_snapshot: bool,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> bool {
    let Some(record) = as_record(state) else {
        add_issue(
            issues,
            source_id,
            "invalid_resume",
            path,
            LegacyMigrationSeverity::Error,
            "Resume data must be a JSON object.",
        );
        return false;
    };
    counts.resume_snapshots = counts.resume_snapshots.saturating_add(1);
    add_evidence(evidence, &format!("{path}.resume"), 1, "present");
    let basic = record.get("basic");
    if let Some(basic) = basic.and_then(as_record) {
        let field_count = basic
            .keys()
            .filter(|key| BASIC_KEYS.contains(&key.as_str()))
            .count();
        counts.basic_fields = counts.basic_fields.saturating_add(field_count as u32);
        add_evidence(
            evidence,
            &format!("{path}.resume.basic"),
            field_count,
            "present",
        );
        for required in ["name", "phone", "email", "city", "wechat", "birth"] {
            if !basic
                .get(required)
                .is_some_and(serde_json::Value::is_string)
            {
                add_issue(
                    issues,
                    source_id,
                    "defaulted_basic_field",
                    &format!("{path}.resume.basic.{required}"),
                    if strict_snapshot {
                        LegacyMigrationSeverity::Error
                    } else {
                        LegacyMigrationSeverity::Review
                    },
                    if strict_snapshot {
                        "A version snapshot is missing a required basic-information field."
                    } else {
                        "Legacy normalization would supply a default for this field."
                    },
                );
            }
        }
        if basic
            .get("ageMode")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|mode| !["age", "birthday"].contains(&mode))
        {
            add_issue(
                issues,
                source_id,
                "invalid_age_mode",
                &format!("{path}.resume.basic.ageMode"),
                if strict_snapshot {
                    LegacyMigrationSeverity::Error
                } else {
                    LegacyMigrationSeverity::Review
                },
                "The age mode is not supported by the current resume schema.",
            );
        }
        for optional in [
            "website",
            "linkedin",
            "gender",
            "height",
            "weight",
            "ethnicity",
            "birthplace",
            "politicalStatus",
            "maritalStatus",
            "zodiac",
            "mbti",
            "avatar",
        ] {
            if basic.get(optional).is_some_and(|value| !value.is_string()) {
                add_issue(
                    issues,
                    source_id,
                    "invalid_basic_optional_field",
                    &format!("{path}.resume.basic.{optional}"),
                    if strict_snapshot {
                        LegacyMigrationSeverity::Error
                    } else {
                        LegacyMigrationSeverity::Review
                    },
                    "An optional basic-information field must be a string when present.",
                );
            }
        }
        if let Some(avatar) = basic
            .get("avatar")
            .and_then(serde_json::Value::as_str)
            .filter(|avatar| !avatar.is_empty())
        {
            let embedded_asset =
                decode_data_url(avatar).is_some_and(|bytes| supported_image_bytes(&bytes));
            if embedded_asset {
                counts.avatar_assets_present = counts.avatar_assets_present.saturating_add(1);
                add_evidence(
                    evidence,
                    &format!("{path}.resume.basic.avatar"),
                    1,
                    "embedded_asset_needs_staging",
                );
            } else {
                counts.avatar_assets_missing = counts.avatar_assets_missing.saturating_add(1);
                add_evidence(
                    evidence,
                    &format!("{path}.resume.basic.avatar"),
                    1,
                    "resource_missing_or_unsupported",
                );
            }
            add_issue(
                issues,
                source_id,
                "avatar_asset_needs_transfer",
                &format!("{path}.resume.basic.avatar"),
                LegacyMigrationSeverity::Review,
                if embedded_asset {
                    "Avatar bytes are present and must be staged as a content-addressed asset."
                } else {
                    "The avatar reference cannot be decoded as a supported image and needs repair."
                },
            );
        }
    } else if basic.is_some() {
        add_issue(
            issues,
            source_id,
            "invalid_basic_info",
            &format!("{path}.resume.basic"),
            LegacyMigrationSeverity::Error,
            "Basic information must be a JSON object.",
        );
    } else {
        add_issue(
            issues,
            source_id,
            "defaulted_basic_info",
            &format!("{path}.resume.basic"),
            if strict_snapshot {
                LegacyMigrationSeverity::Error
            } else {
                LegacyMigrationSeverity::Review
            },
            if strict_snapshot {
                "A version snapshot is missing basic information."
            } else {
                "Basic information is absent; legacy defaults would be required."
            },
        );
    }

    let mut entry_ids = HashMap::<String, (String, String)>::new();
    for module in MODULE_KEYS {
        let Some(value) = record.get(module) else {
            if strict_snapshot {
                add_issue(
                    issues,
                    source_id,
                    "missing_module_entries",
                    &format!("{path}.resume.{module}"),
                    LegacyMigrationSeverity::Error,
                    "A version snapshot is missing a module entry array.",
                );
            } else {
                add_evidence(
                    evidence,
                    &format!("{path}.resume.{module}"),
                    0,
                    "defaulted_empty",
                );
            }
            continue;
        };
        let Some(entries) = value.as_array() else {
            add_issue(
                issues,
                source_id,
                "invalid_module_entries",
                &format!("{path}.resume.{module}"),
                LegacyMigrationSeverity::Error,
                "Module entries must be an array.",
            );
            continue;
        };
        counts.sections = counts.sections.saturating_add(1);
        counts.entries = counts.entries.saturating_add(entries.len() as u32);
        add_evidence(
            evidence,
            &format!("{path}.resume.{module}.entries"),
            entries.len(),
            "present",
        );
        for (index, entry) in entries.iter().enumerate() {
            let Some(entry) = as_record(entry) else {
                add_issue(
                    issues,
                    source_id,
                    "invalid_entry",
                    &format!("{path}.resume.{module}[{index}]"),
                    LegacyMigrationSeverity::Error,
                    "A resume entry must be a JSON object.",
                );
                continue;
            };
            let Some(id) = nonempty_string(entry.get("id")) else {
                add_issue(
                    issues,
                    source_id,
                    "missing_entry_id",
                    &format!("{path}.resume.{module}[{index}].id"),
                    if strict_snapshot {
                        LegacyMigrationSeverity::Error
                    } else {
                        LegacyMigrationSeverity::Review
                    },
                    if strict_snapshot {
                        "A version snapshot entry is missing its required legacy ID."
                    } else {
                        "Legacy normalization would create an identifier; the generated mapping is not yet persisted."
                    },
                );
                continue;
            };
            let hash = sha256(
                &serde_json::to_vec(&serde_json::Value::Object(entry.clone())).unwrap_or_default(),
            );
            if let Some((previous_module, previous_hash)) = entry_ids.get(id) {
                let severity = if previous_hash == &hash {
                    LegacyMigrationSeverity::Review
                } else {
                    LegacyMigrationSeverity::Error
                };
                add_issue(
                    issues,
                    source_id,
                    "duplicate_entry_id",
                    &format!("{path}.resume.{module}[{index}].id"),
                    severity,
                    if previous_module == module {
                        "This legacy identifier appears more than once in a module."
                    } else {
                        "This legacy identifier is used by different module records."
                    },
                );
            } else {
                entry_ids.insert(id.into(), (module.into(), hash));
            }
            for key in [
                "title",
                "role",
                "department",
                "city",
                "start",
                "end",
                "html",
            ] {
                if strict_snapshot && entry.get(key).is_none() {
                    add_issue(
                        issues,
                        source_id,
                        "missing_entry_field",
                        &format!("{path}.resume.{module}[{index}].{key}"),
                        LegacyMigrationSeverity::Error,
                        "A version snapshot entry is missing a required string field.",
                    );
                }
                if entry.get(key).is_some_and(|value| !value.is_string()) {
                    add_issue(
                        issues,
                        source_id,
                        "invalid_entry_field",
                        &format!("{path}.resume.{module}[{index}].{key}"),
                        LegacyMigrationSeverity::Error,
                        "A legacy entry field has an unsupported type.",
                    );
                }
            }
            if entry
                .get("html")
                .and_then(serde_json::Value::as_str)
                .is_some()
            {
                add_evidence(
                    evidence,
                    &format!("{path}.resume.{module}[{index}].html"),
                    1,
                    "source_retained_for_rich_text_conversion",
                );
            }
            entities.push(fingerprint_entity(
                source_id,
                &format!("resume-entry:{module}"),
                id,
                &serde_json::Value::Object(entry.clone()),
                nonempty_string(entry.get("title")),
            ));
        }
    }
    if strict_snapshot && record.get("summary").is_none() {
        add_issue(
            issues,
            source_id,
            "missing_summary",
            &format!("{path}.resume.summary"),
            LegacyMigrationSeverity::Error,
            "A version snapshot is missing its summary string.",
        );
    }
    if record
        .get("summary")
        .is_some_and(|summary| !summary.is_string())
    {
        add_issue(
            issues,
            source_id,
            "invalid_summary",
            &format!("{path}.resume.summary"),
            LegacyMigrationSeverity::Error,
            "Summary content must be a string.",
        );
    } else if record
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        counts.sections = counts.sections.saturating_add(1);
        add_evidence(evidence, &format!("{path}.resume.summary"), 1, "present");
    }

    let known: HashSet<&str> = MODULE_KEYS
        .into_iter()
        .chain(["basic", "summary"])
        .collect();
    for key in record.keys() {
        if !known.contains(key.as_str()) {
            counts.unknown_items = counts.unknown_items.saturating_add(1);
            add_issue(
                issues,
                source_id,
                "unknown_resume_field",
                &format!("{path}.resume.{key}"),
                LegacyMigrationSeverity::Review,
                "The source field is preserved for review and is not silently discarded.",
            );
        }
    }
    true
}

fn inspect_snapshot(
    snapshot: &serde_json::Value,
    source_id: &str,
    path: &str,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> bool {
    let Some(record) = as_record(snapshot) else {
        add_issue(
            issues,
            source_id,
            "invalid_snapshot",
            path,
            LegacyMigrationSeverity::Error,
            "A version snapshot must be a JSON object.",
        );
        return false;
    };
    let mut valid = true;
    for key in [
        "moduleOrder",
        "moduleNames",
        "summaryTitle",
        "resumeTitle",
        "layout",
    ] {
        if !record.contains_key(key) {
            add_issue(
                issues,
                source_id,
                "missing_snapshot_field",
                &format!("{path}.{key}"),
                LegacyMigrationSeverity::Error,
                "A version snapshot is missing a field required by the legacy schema.",
            );
            valid = false;
        }
    }
    let has_schema_version = record.contains_key("schemaVersion");
    let has_presentation = record.contains_key("presentation");
    if has_schema_version != has_presentation {
        add_issue(
            issues,
            source_id,
            "snapshot_presentation_pair_mismatch",
            path,
            LegacyMigrationSeverity::Error,
            "schemaVersion and presentation must either both be present or both be absent.",
        );
        valid = false;
    }
    if has_schema_version
        && record
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(2)
    {
        add_issue(
            issues,
            source_id,
            "unsupported_snapshot_schema",
            &format!("{path}.schemaVersion"),
            LegacyMigrationSeverity::Error,
            "Only legacy snapshot schema version 2 is supported.",
        );
        valid = false;
    }
    let Some(resume) = record.get("resume") else {
        add_issue(
            issues,
            source_id,
            "missing_snapshot_resume",
            &format!("{path}.resume"),
            LegacyMigrationSeverity::Error,
            "A version snapshot is missing resume content.",
        );
        return false;
    };
    valid &= inspect_resume_state(
        resume, source_id, path, true, counts, evidence, issues, entities,
    );
    if !nonempty_string(record.get("resumeTitle")).is_some() {
        add_issue(
            issues,
            source_id,
            "defaulted_resume_title",
            &format!("{path}.resumeTitle"),
            LegacyMigrationSeverity::Review,
            "Legacy normalization would supply a document title.",
        );
    }
    if let Some(layout) = record.get("layout") {
        let Some(layout) = as_record(layout) else {
            add_issue(
                issues,
                source_id,
                "invalid_layout",
                &format!("{path}.layout"),
                LegacyMigrationSeverity::Error,
                "Layout must be a JSON object.",
            );
            return false;
        };
        let keys = [
            "font",
            "fontSize",
            "lineHeight",
            "moduleSpacing",
            "pageMargin",
            "theme",
            "dateFormat",
            "titleFormat",
            "separator",
            "textAlign",
        ];
        let present = keys.iter().filter(|key| layout.contains_key(**key)).count();
        for key in keys {
            if !layout.contains_key(key) {
                add_issue(
                    issues,
                    source_id,
                    "missing_layout_field",
                    &format!("{path}.layout.{key}"),
                    LegacyMigrationSeverity::Error,
                    "A version snapshot is missing a required layout field.",
                );
                valid = false;
            }
        }
        counts.preference_fields = counts.preference_fields.saturating_add(present as u32);
        add_evidence(evidence, &format!("{path}.layout"), present, "present");
        for key in ["fontSize", "lineHeight", "moduleSpacing", "pageMargin"] {
            if layout.get(key).is_some_and(|value| {
                value
                    .as_f64()
                    .or_else(|| {
                        value
                            .as_str()
                            .and_then(|text| text.trim().parse::<f64>().ok())
                    })
                    .is_none_or(|number| !number.is_finite() || number < 0.0)
            }) {
                add_issue(
                    issues,
                    source_id,
                    "invalid_layout_number",
                    &format!("{path}.layout.{key}"),
                    LegacyMigrationSeverity::Error,
                    "A layout measurement is not a finite number.",
                );
                valid = false;
            }
        }
        for key in [
            "font",
            "theme",
            "dateFormat",
            "titleFormat",
            "separator",
            "textAlign",
        ] {
            if !layout.get(key).is_some_and(serde_json::Value::is_string) {
                add_issue(
                    issues,
                    source_id,
                    "invalid_layout_string",
                    &format!("{path}.layout.{key}"),
                    LegacyMigrationSeverity::Error,
                    "A layout text field is missing or not a string.",
                );
                valid = false;
            }
        }
        if layout
            .get("theme")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|theme| {
                theme.len() != 7
                    || !theme.starts_with('#')
                    || !theme[1..]
                        .chars()
                        .all(|character| character.is_ascii_hexdigit())
            })
        {
            add_issue(
                issues,
                source_id,
                "invalid_layout_theme",
                &format!("{path}.layout.theme"),
                LegacyMigrationSeverity::Error,
                "The layout theme must be a six-digit hexadecimal color.",
            );
            valid = false;
        }
    } else {
        add_issue(
            issues,
            source_id,
            "missing_layout",
            &format!("{path}.layout"),
            LegacyMigrationSeverity::Error,
            "A version snapshot is missing its layout object.",
        );
        valid = false;
    }
    if let Some(order) = record.get("moduleOrder") {
        if let Some(order) = order.as_array() {
            let mut seen = HashSet::new();
            for (index, item) in order.iter().enumerate() {
                let Some(module) = item.as_str() else {
                    add_issue(
                        issues,
                        source_id,
                        "invalid_module_order",
                        &format!("{path}.moduleOrder[{index}]"),
                        LegacyMigrationSeverity::Error,
                        "Module order entries must be strings.",
                    );
                    valid = false;
                    continue;
                };
                if !MODULE_KEYS.contains(&module) && module != "summary" {
                    add_issue(
                        issues,
                        source_id,
                        "unknown_module_order_entry",
                        &format!("{path}.moduleOrder[{index}]"),
                        LegacyMigrationSeverity::Review,
                        "An unknown module-order value is preserved for review.",
                    );
                }
                if !seen.insert(module) {
                    add_issue(
                        issues,
                        source_id,
                        "duplicate_module_order_entry",
                        &format!("{path}.moduleOrder[{index}]"),
                        LegacyMigrationSeverity::Review,
                        "The repeated order entry requires an explicit resolution.",
                    );
                }
            }
            add_evidence(
                evidence,
                &format!("{path}.moduleOrder"),
                order.len(),
                "preserved",
            );
        } else {
            add_issue(
                issues,
                source_id,
                "invalid_module_order",
                &format!("{path}.moduleOrder"),
                LegacyMigrationSeverity::Error,
                "Module order must be an array.",
            );
            valid = false;
        }
    }
    if let Some(names) = record.get("moduleNames") {
        if let Some(names) = as_record(names) {
            add_evidence(
                evidence,
                &format!("{path}.moduleNames"),
                names.len(),
                "present",
            );
            for (key, name) in names {
                if !MODULE_KEYS.contains(&key.as_str()) || !name.is_string() {
                    add_issue(
                        issues,
                        source_id,
                        "invalid_module_name",
                        &format!("{path}.moduleNames.{key}"),
                        if name.is_string() {
                            LegacyMigrationSeverity::Review
                        } else {
                            LegacyMigrationSeverity::Error
                        },
                        "The module name is unknown or is not a string.",
                    );
                    valid &= name.is_string();
                }
            }
        } else {
            add_issue(
                issues,
                source_id,
                "invalid_module_names",
                &format!("{path}.moduleNames"),
                LegacyMigrationSeverity::Error,
                "Module names must be a JSON object.",
            );
            valid = false;
        }
    }
    if let Some(template) = record.get("importedTemplate") {
        if template.is_object() && !template.is_null() {
            counts.imported_templates = counts.imported_templates.saturating_add(1);
            for key in ["id", "name"] {
                if !template
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    add_issue(
                        issues,
                        source_id,
                        "invalid_snapshot_imported_template",
                        &format!("{path}.importedTemplate.{key}"),
                        LegacyMigrationSeverity::Error,
                        "An imported-template reference requires nonempty ID and name values.",
                    );
                    valid = false;
                }
            }
            add_issue(
                issues,
                source_id,
                "imported_template_resource_review",
                &format!("{path}.importedTemplate"),
                LegacyMigrationSeverity::Review,
                "Template source metadata is present; its immutable assets and recognition state need separate mapping.",
            );
        } else if !template.is_null() {
            add_issue(
                issues,
                source_id,
                "invalid_snapshot_imported_template",
                &format!("{path}.importedTemplate"),
                LegacyMigrationSeverity::Error,
                "An imported-template reference must be an object or null.",
            );
            valid = false;
        }
    }
    if let Some(presentation) = record.get("presentation") {
        if let Some(presentation) = as_record(presentation) {
            for key in [
                "templateId",
                "templateVersion",
                "densityPreset",
                "overrides",
            ] {
                if !presentation.contains_key(key) {
                    add_issue(
                        issues,
                        source_id,
                        "missing_snapshot_presentation_field",
                        &format!("{path}.presentation.{key}"),
                        LegacyMigrationSeverity::Error,
                        "The legacy presentation record is missing a required field.",
                    );
                    valid = false;
                }
            }
            if !nonempty_string(presentation.get("templateId")).is_some() {
                add_issue(
                    issues,
                    source_id,
                    "invalid_snapshot_template_id",
                    &format!("{path}.presentation.templateId"),
                    LegacyMigrationSeverity::Error,
                    "The template ID must be a nonempty string.",
                );
                valid = false;
            }
            if presentation
                .get("templateVersion")
                .and_then(serde_json::Value::as_u64)
                .is_none_or(|version| version == 0)
            {
                add_issue(
                    issues,
                    source_id,
                    "invalid_snapshot_template_version",
                    &format!("{path}.presentation.templateVersion"),
                    LegacyMigrationSeverity::Error,
                    "The template version must be a positive integer.",
                );
                valid = false;
            }
            if presentation
                .get("densityPreset")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|density| !["comfortable", "standard", "compact"].contains(&density))
            {
                add_issue(
                    issues,
                    source_id,
                    "invalid_snapshot_density",
                    &format!("{path}.presentation.densityPreset"),
                    LegacyMigrationSeverity::Error,
                    "The density preset is not supported.",
                );
                valid = false;
            }
            if let Some(overrides) = presentation.get("overrides") {
                if let Some(overrides) = as_record(overrides) {
                    for (key, value) in overrides {
                        if !value.is_string() && !value.as_f64().is_some_and(f64::is_finite) {
                            add_issue(
                                issues,
                                source_id,
                                "invalid_snapshot_override",
                                &format!("{path}.presentation.overrides.{key}"),
                                LegacyMigrationSeverity::Error,
                                "A presentation override must be a string or finite number.",
                            );
                            valid = false;
                        }
                    }
                } else {
                    add_issue(
                        issues,
                        source_id,
                        "invalid_snapshot_overrides",
                        &format!("{path}.presentation.overrides"),
                        LegacyMigrationSeverity::Error,
                        "Presentation overrides must be a JSON object.",
                    );
                    valid = false;
                }
            }
        } else {
            add_issue(
                issues,
                source_id,
                "invalid_presentation",
                &format!("{path}.presentation"),
                LegacyMigrationSeverity::Error,
                "Presentation metadata must be a JSON object.",
            );
            valid = false;
        }
    }
    for key in ["summaryTitle", "resumeTitle"] {
        if record.get(key).is_some_and(|value| !value.is_string()) {
            add_issue(
                issues,
                source_id,
                "invalid_snapshot_title",
                &format!("{path}.{key}"),
                LegacyMigrationSeverity::Error,
                "Snapshot titles must be strings.",
            );
            valid = false;
        }
    }
    valid
}

fn inspect_version_store(
    value: &serde_json::Value,
    source_id: &str,
    path: &str,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> Option<String> {
    let store = if value.get("format").and_then(serde_json::Value::as_str)
        == Some("resume-diy-version-backup")
    {
        value.get("store")?
    } else {
        value
    };
    let Some(store) = as_record(store) else {
        add_issue(
            issues,
            source_id,
            "invalid_version_store",
            path,
            LegacyMigrationSeverity::Error,
            "Version data must be a JSON object.",
        );
        return None;
    };
    let Some(branches) = store.get("branches").and_then(serde_json::Value::as_array) else {
        add_issue(
            issues,
            source_id,
            "invalid_branches",
            &format!("{path}.branches"),
            LegacyMigrationSeverity::Error,
            "Version data is missing a branches array.",
        );
        return None;
    };
    let Some(commits) = store.get("commits").and_then(serde_json::Value::as_array) else {
        add_issue(
            issues,
            source_id,
            "invalid_commits",
            &format!("{path}.commits"),
            LegacyMigrationSeverity::Error,
            "Version data is missing a commits array.",
        );
        return None;
    };
    counts.version_branches = counts
        .version_branches
        .saturating_add(branches.len() as u32);
    counts.version_commits = counts.version_commits.saturating_add(commits.len() as u32);
    add_evidence(
        evidence,
        &format!("{path}.branches"),
        branches.len(),
        "present",
    );
    add_evidence(
        evidence,
        &format!("{path}.commits"),
        commits.len(),
        "present",
    );

    let mut branch_ids = HashMap::<String, (String, String)>::new();
    let mut branch_names = HashMap::<String, String>::new();
    for (index, branch) in branches.iter().enumerate() {
        let Some(branch) = as_record(branch) else {
            add_issue(
                issues,
                source_id,
                "invalid_branch",
                &format!("{path}.branches[{index}]"),
                LegacyMigrationSeverity::Error,
                "A branch must be a JSON object.",
            );
            continue;
        };
        let Some(id) = nonempty_string(branch.get("id")) else {
            add_issue(
                issues,
                source_id,
                "missing_branch_id",
                &format!("{path}.branches[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A branch identifier is required.",
            );
            continue;
        };
        let Some(name) = nonempty_string(branch.get("name")) else {
            add_issue(
                issues,
                source_id,
                "invalid_branch_name",
                &format!("{path}.branches[{index}].name"),
                LegacyMigrationSeverity::Error,
                "A branch name must be a nonempty string.",
            );
            continue;
        };
        if nonempty_string(branch.get("createdAt")).is_none() {
            add_issue(
                issues,
                source_id,
                "missing_branch_timestamp",
                &format!("{path}.branches[{index}].createdAt"),
                LegacyMigrationSeverity::Error,
                "A branch creation timestamp must be a nonempty string.",
            );
        }
        if !branch.contains_key("headCommitId") {
            add_issue(
                issues,
                source_id,
                "missing_branch_head",
                &format!("{path}.branches[{index}].headCommitId"),
                LegacyMigrationSeverity::Error,
                "A branch head field is required; use null for an empty branch.",
            );
        }
        if branch_ids.contains_key(id) {
            add_issue(
                issues,
                source_id,
                "duplicate_branch_id",
                &format!("{path}.branches[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A branch identifier occurs more than once.",
            );
        }
        if let Some(previous_id) = branch_names.get(name) {
            if previous_id != id {
                add_issue(
                    issues,
                    source_id,
                    "same_name_different_branch_id",
                    &format!("{path}.branches[{index}].name"),
                    LegacyMigrationSeverity::Review,
                    "Different branch identifiers share a name; neither is selected automatically.",
                );
            }
        } else {
            branch_names.insert(name.into(), id.into());
        }
        let hash = sha256(
            &serde_json::to_vec(&serde_json::Value::Object(branch.clone())).unwrap_or_default(),
        );
        branch_ids
            .entry(id.into())
            .or_insert((hash.clone(), name.into()));
        entities.push(fingerprint_entity(
            source_id,
            "version-branch",
            id,
            &serde_json::Value::Object(branch.clone()),
            Some(name),
        ));
    }
    if !branch_ids.contains_key("main") {
        add_issue(
            issues,
            source_id,
            "missing_main_branch",
            &format!("{path}.branches"),
            LegacyMigrationSeverity::Error,
            "The source version graph must contain a main branch.",
        );
    }
    let current_branch = nonempty_string(store.get("currentBranchId"));
    if current_branch.is_none_or(|id| !branch_ids.contains_key(id)) {
        add_issue(
            issues,
            source_id,
            "missing_current_branch",
            &format!("{path}.currentBranchId"),
            LegacyMigrationSeverity::Error,
            "The active branch does not reference a known branch.",
        );
    }

    let mut commit_ids = HashMap::<String, (String, String, Option<String>)>::new();
    let mut seen_commit_ids = HashSet::new();
    let mut snapshot_hashes = HashMap::<String, String>::new();
    for (index, commit) in commits.iter().enumerate() {
        let Some(commit) = as_record(commit) else {
            add_issue(
                issues,
                source_id,
                "invalid_commit",
                &format!("{path}.commits[{index}]"),
                LegacyMigrationSeverity::Error,
                "A commit must be a JSON object.",
            );
            continue;
        };
        let Some(id) = nonempty_string(commit.get("id")) else {
            add_issue(
                issues,
                source_id,
                "missing_commit_id",
                &format!("{path}.commits[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A commit identifier is required.",
            );
            continue;
        };
        if !seen_commit_ids.insert(id.to_string()) {
            add_issue(
                issues,
                source_id,
                "duplicate_commit_id",
                &format!("{path}.commits[{index}].id"),
                LegacyMigrationSeverity::Error,
                "A commit identifier occurs more than once.",
            );
        }
        let Some(branch_id) = nonempty_string(commit.get("branchId")) else {
            add_issue(
                issues,
                source_id,
                "invalid_commit_branch",
                &format!("{path}.commits[{index}].branchId"),
                LegacyMigrationSeverity::Error,
                "A commit branch identifier must be a nonempty string.",
            );
            continue;
        };
        let parent_id = match commit.get("parentId") {
            Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(parent)) if !parent.trim().is_empty() => {
                Some(parent.clone())
            }
            Some(_) => {
                add_issue(
                    issues,
                    source_id,
                    "invalid_commit_parent",
                    &format!("{path}.commits[{index}].parentId"),
                    LegacyMigrationSeverity::Error,
                    "A commit parent must be a nonempty string or null.",
                );
                None
            }
            None => {
                add_issue(
                    issues,
                    source_id,
                    "legacy_missing_parent_field",
                    &format!("{path}.commits[{index}].parentId"),
                    LegacyMigrationSeverity::Info,
                    "This older commit has no parent field; its history is retained as a broken edge.",
                );
                None
            }
        };
        if let Some(snapshot) = commit.get("snapshot") {
            let _ = inspect_snapshot(
                snapshot,
                source_id,
                &format!("{path}.commits[{index}].snapshot"),
                counts,
                evidence,
                issues,
                entities,
            );
            let snapshot_hash = sha256(&serde_json::to_vec(snapshot).unwrap_or_default());
            if let Some(previous_id) = snapshot_hashes.get(&snapshot_hash) {
                if previous_id != id {
                    add_issue(issues, source_id, "same_content_different_commit", &format!("{path}.commits[{index}].snapshot"), LegacyMigrationSeverity::Info, "Identical snapshot content has distinct commit identities; both commits remain distinct.");
                }
            } else {
                snapshot_hashes.insert(snapshot_hash.clone(), id.into());
            }
            entities.push(fingerprint_entity(
                source_id,
                "version-commit",
                id,
                snapshot,
                nonempty_string(commit.get("message")),
            ));
            commit_ids
                .entry(id.into())
                .or_insert((branch_id.into(), snapshot_hash, parent_id));
        } else {
            add_issue(
                issues,
                source_id,
                "missing_commit_snapshot",
                &format!("{path}.commits[{index}].snapshot"),
                LegacyMigrationSeverity::Error,
                "A commit without a snapshot cannot be converted.",
            );
        }
        if !commit
            .get("message")
            .is_some_and(serde_json::Value::is_string)
        {
            add_issue(
                issues,
                source_id,
                "invalid_commit_message",
                &format!("{path}.commits[{index}].message"),
                LegacyMigrationSeverity::Error,
                "Commit messages must be strings and the field is required.",
            );
        }
        if nonempty_string(commit.get("createdAt")).is_none() {
            add_issue(
                issues,
                source_id,
                "missing_commit_timestamp",
                &format!("{path}.commits[{index}].createdAt"),
                LegacyMigrationSeverity::Error,
                "A commit creation timestamp must be a nonempty string.",
            );
        }
    }
    for (index, branch) in branches.iter().enumerate() {
        let Some(branch) = as_record(branch) else {
            continue;
        };
        if let Some(head) = nonempty_string(branch.get("headCommitId")) {
            if !commit_ids.contains_key(head) {
                add_issue(
                    issues,
                    source_id,
                    "unknown_branch_head",
                    &format!("{path}.branches[{index}].headCommitId"),
                    LegacyMigrationSeverity::Error,
                    "A branch head refers to an unknown commit.",
                );
            }
        } else if branch
            .get("headCommitId")
            .is_some_and(|head| !head.is_null())
        {
            add_issue(
                issues,
                source_id,
                "invalid_branch_head",
                &format!("{path}.branches[{index}].headCommitId"),
                LegacyMigrationSeverity::Error,
                "A branch head must be a string or null.",
            );
        }
    }
    let mut reachable_from_heads = HashSet::new();
    let mut pending_heads = branches
        .iter()
        .filter_map(as_record)
        .filter_map(|branch| nonempty_string(branch.get("headCommitId")))
        .map(str::to_string)
        .collect::<Vec<_>>();
    while let Some(id) = pending_heads.pop() {
        if !reachable_from_heads.insert(id.clone()) {
            continue;
        }
        if let Some((_, _, Some(parent))) = commit_ids.get(&id) {
            if commit_ids.contains_key(parent) {
                pending_heads.push(parent.clone());
            }
        }
    }
    for (index, commit) in commits.iter().enumerate() {
        let Some(commit) = as_record(commit) else {
            continue;
        };
        let (Some(commit_id), Some(branch_id)) = (
            nonempty_string(commit.get("id")),
            nonempty_string(commit.get("branchId")),
        ) else {
            continue;
        };
        if !branch_ids.contains_key(branch_id) {
            add_issue(
                issues,
                source_id,
                "unknown_commit_branch",
                &format!("{path}.commits[{index}].branchId"),
                if reachable_from_heads.contains(commit_id) {
                    LegacyMigrationSeverity::Info
                } else {
                    LegacyMigrationSeverity::Error
                },
                if reachable_from_heads.contains(commit_id) {
                    "A reachable ancestor references a deleted source branch and is retained as history."
                } else {
                    "A commit outside surviving branch history refers to a missing branch."
                },
            );
        }
    }
    for (index, commit) in commits.iter().enumerate() {
        let Some(commit) = as_record(commit) else {
            continue;
        };
        if let Some(parent) = nonempty_string(commit.get("parentId")) {
            if !commit_ids.contains_key(parent) {
                add_issue(
                    issues,
                    source_id,
                    "unknown_commit_parent",
                    &format!("{path}.commits[{index}].parentId"),
                    LegacyMigrationSeverity::Info,
                    "The legacy version schema retains missing parents as broken history edges.",
                );
            }
        }
    }
    let mut done = HashSet::new();
    for id in commit_ids.keys() {
        let mut visiting = HashSet::new();
        let mut current = Some(id.as_str());
        while let Some(current_id) = current {
            if done.contains(current_id) {
                break;
            }
            if !visiting.insert(current_id.to_string()) {
                add_issue(
                    issues,
                    source_id,
                    "commit_parent_cycle",
                    &format!("{path}.commits"),
                    LegacyMigrationSeverity::Error,
                    "The commit parent graph contains a cycle.",
                );
                break;
            }
            current = commit_ids
                .get(current_id)
                .and_then(|(_, _, parent)| parent.as_deref());
        }
        done.extend(visiting);
    }
    let canonical =
        sha256(&serde_json::to_vec(&serde_json::Value::Object(store.clone())).unwrap_or_default());
    Some(canonical)
}

fn read_known_browser_key(key: &str) -> bool {
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

fn inspect_browser_export(
    value: &serde_json::Value,
    source_id: &str,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> (bool, bool, Option<String>) {
    let Some(payload) = as_record(value) else {
        add_issue(
            issues,
            source_id,
            "invalid_browser_export",
            "manifest",
            LegacyMigrationSeverity::Error,
            "Browser export must be a JSON object.",
        );
        return (false, false, None);
    };
    if payload.get("format").and_then(serde_json::Value::as_str)
        != Some("zinecv-legacy-browser-export")
        || payload.get("version").and_then(serde_json::Value::as_u64) != Some(1)
    {
        add_issue(
            issues,
            source_id,
            "unsupported_browser_export",
            "manifest",
            LegacyMigrationSeverity::Error,
            "Browser export format or version is unsupported.",
        );
        return (false, false, None);
    }
    if payload.get("origin").and_then(serde_json::Value::as_str) != Some(LEGACY_ORIGIN) {
        add_issue(
            issues,
            source_id,
            "unexpected_browser_origin",
            "origin",
            LegacyMigrationSeverity::Error,
            "Browser export origin does not match the documented legacy application origin.",
        );
    }
    let Some(entries) = payload.get("entries").and_then(serde_json::Value::as_array) else {
        add_issue(
            issues,
            source_id,
            "invalid_browser_entries",
            "entries",
            LegacyMigrationSeverity::Error,
            "Browser export is missing its entries array.",
        );
        return (false, false, None);
    };
    let expected_hash = nonempty_string(payload.get("sourceHash"));
    let actual_hash =
        sha256(&serde_json::to_vec(&serde_json::Value::Array(entries.clone())).unwrap_or_default());
    if expected_hash != Some(actual_hash.as_str()) {
        add_issue(
            issues,
            source_id,
            "browser_entry_hash_mismatch",
            "sourceHash",
            LegacyMigrationSeverity::Error,
            "The browser entry hash does not match the supplied entries.",
        );
    }
    let mut map = BTreeMap::<String, String>::new();
    let mut seen = HashSet::new();
    let mut previous_key: Option<String> = None;
    let mut valid = expected_hash == Some(actual_hash.as_str());
    for (index, entry) in entries.iter().enumerate() {
        let Some(pair) = entry.as_array() else {
            add_issue(
                issues,
                source_id,
                "invalid_browser_entry",
                &format!("entries[{index}]"),
                LegacyMigrationSeverity::Error,
                "Each browser entry must be a key/value pair.",
            );
            valid = false;
            continue;
        };
        if pair.len() != 2 || !pair[0].is_string() || !pair[1].is_string() {
            add_issue(
                issues,
                source_id,
                "invalid_browser_entry",
                &format!("entries[{index}]"),
                LegacyMigrationSeverity::Error,
                "Each browser entry must contain two strings.",
            );
            valid = false;
            continue;
        }
        let key = pair[0].as_str().unwrap_or_default();
        let raw = pair[1].as_str().unwrap_or_default();
        if !key.starts_with("resume-diy-") {
            add_issue(
                issues,
                source_id,
                "foreign_browser_key",
                &format!("entries[{index}].key"),
                LegacyMigrationSeverity::Error,
                "The export contains a key outside the application namespace.",
            );
            valid = false;
            continue;
        }
        if !seen.insert(key.to_string()) {
            add_issue(
                issues,
                source_id,
                "duplicate_browser_key",
                &format!("entries[{index}].key"),
                LegacyMigrationSeverity::Error,
                "A browser key occurs more than once.",
            );
            valid = false;
        }
        if previous_key
            .as_deref()
            .is_some_and(|previous| previous > key)
        {
            add_issue(
                issues,
                source_id,
                "browser_keys_unsorted",
                "entries",
                LegacyMigrationSeverity::Error,
                "Browser keys must remain in their exported deterministic order.",
            );
            valid = false;
        }
        previous_key = Some(key.into());
        map.insert(key.into(), raw.into());
        if !read_known_browser_key(key) {
            counts.unknown_items = counts.unknown_items.saturating_add(1);
            add_issue(
                issues,
                source_id,
                "unknown_browser_key",
                &format!("entries[{index}].key"),
                LegacyMigrationSeverity::Review,
                "An unknown application key is preserved for explicit review.",
            );
        }
    }

    if let Some(state) = parse_embedded_json(
        map.get("resume-diy-state"),
        source_id,
        "resume-diy-state",
        issues,
    ) {
        let _ = inspect_resume_state(
            &state,
            source_id,
            "resume-diy-state",
            false,
            counts,
            evidence,
            issues,
            entities,
        );
    }
    for key in ["resume-diy-preferences", "resume-diy-presentation-v1"] {
        if let Some(value) = parse_embedded_json(map.get(key), source_id, key, issues) {
            let Some(record) = as_record(&value) else {
                add_issue(
                    issues,
                    source_id,
                    "invalid_preference_record",
                    key,
                    LegacyMigrationSeverity::Error,
                    "Preference data must be a JSON object.",
                );
                continue;
            };
            counts.preference_fields = counts.preference_fields.saturating_add(record.len() as u32);
            add_evidence(evidence, key, record.len(), "present");
        }
    }
    for key in ["resume-diy-section-order-v2", "resume-diy-modules"] {
        if let Some(value) = parse_embedded_json(map.get(key), source_id, key, issues) {
            if let Some(order) = value.as_array() {
                add_evidence(evidence, key, order.len(), "present");
                counts.module_order_records = counts
                    .module_order_records
                    .saturating_add(order.len() as u32);
                counts.module_visibility_records = counts
                    .module_visibility_records
                    .saturating_add((MODULE_KEYS.len() + 1) as u32);
                let mut seen_modules = HashSet::new();
                let mut visible_modules = HashSet::new();
                for (index, module) in order.iter().enumerate() {
                    let Some(module) = module.as_str() else {
                        add_issue(
                            issues,
                            source_id,
                            "invalid_module_order",
                            &format!("{key}[{index}]"),
                            LegacyMigrationSeverity::Error,
                            "Module order items must be strings.",
                        );
                        continue;
                    };
                    if module != "summary" && !MODULE_KEYS.contains(&module) {
                        add_issue(
                            issues,
                            source_id,
                            "unknown_module_order_entry",
                            &format!("{key}[{index}]"),
                            LegacyMigrationSeverity::Review,
                            "An unknown module order item is retained for review.",
                        );
                    } else {
                        visible_modules.insert(module);
                    }
                    if !seen_modules.insert(module) {
                        add_issue(
                            issues,
                            source_id,
                            "duplicate_module_order_entry",
                            &format!("{key}[{index}]"),
                            LegacyMigrationSeverity::Review,
                            "A duplicate module order item needs user review.",
                        );
                    }
                }
                if key == "resume-diy-modules" {
                    visible_modules.insert("summary");
                }
                add_evidence(
                    evidence,
                    &format!("{key}.visible"),
                    visible_modules.len(),
                    "order_implies_visible",
                );
                add_evidence(
                    evidence,
                    &format!("{key}.hidden"),
                    MODULE_KEYS.len() + 1 - visible_modules.len(),
                    "omitted_sections_preserved_as_hidden",
                );
            } else {
                add_issue(
                    issues,
                    source_id,
                    "invalid_module_order",
                    key,
                    LegacyMigrationSeverity::Error,
                    "Module order must be a JSON array.",
                );
            }
        }
    }
    for key in ["resume-diy-module-names", "resume-diy-template-library-v1"] {
        if let Some(value) = parse_embedded_json(map.get(key), source_id, key, issues) {
            if let Some(record) = as_record(&value) {
                counts.preference_fields =
                    counts.preference_fields.saturating_add(record.len() as u32);
                add_evidence(evidence, key, record.len(), "present");
                if key == "resume-diy-template-library-v1" {
                    let mut favorites = 0usize;
                    let mut recently_used = 0usize;
                    for activity in record.values() {
                        let Some(activity) = as_record(activity) else {
                            counts.unknown_items = counts.unknown_items.saturating_add(1);
                            continue;
                        };
                        if activity
                            .get("favorite")
                            .and_then(serde_json::Value::as_bool)
                            == Some(true)
                        {
                            favorites += 1;
                        }
                        if activity
                            .get("lastUsedAt")
                            .and_then(serde_json::Value::as_f64)
                            .is_some_and(|value| value.is_finite() && value > 0.0)
                        {
                            recently_used += 1;
                        }
                    }
                    counts.favorite_template_records = counts
                        .favorite_template_records
                        .saturating_add(favorites as u32);
                    counts.recent_template_records = counts
                        .recent_template_records
                        .saturating_add(recently_used as u32);
                    add_evidence(
                        evidence,
                        "resume-diy-template-library-v1.favorite",
                        favorites,
                        "present",
                    );
                    add_evidence(
                        evidence,
                        "resume-diy-template-library-v1.lastUsedAt",
                        recently_used,
                        "present",
                    );
                    for candidate in ["favorites", "favoriteIds", "recent", "recentlyUsed"] {
                        if let Some(list) =
                            record.get(candidate).and_then(serde_json::Value::as_array)
                        {
                            if matches!(candidate, "recent" | "recentlyUsed") {
                                counts.recent_template_records = counts
                                    .recent_template_records
                                    .saturating_add(list.len() as u32);
                            } else {
                                counts.favorite_template_records = counts
                                    .favorite_template_records
                                    .saturating_add(list.len() as u32);
                            }
                            add_evidence(
                                evidence,
                                &format!("{key}.{candidate}"),
                                list.len(),
                                "present",
                            );
                        }
                    }
                } else if key == "resume-diy-module-names" {
                    counts.module_name_records = counts
                        .module_name_records
                        .saturating_add(record.len() as u32);
                    for (module, name) in record {
                        if !name.is_string() {
                            add_issue(
                                issues,
                                source_id,
                                "invalid_module_name",
                                &format!("{key}.{module}"),
                                LegacyMigrationSeverity::Error,
                                "A module name must be a string.",
                            );
                        } else if !MODULE_KEYS.contains(&module.as_str()) {
                            add_issue(
                                issues,
                                source_id,
                                "unknown_module_name",
                                &format!("{key}.{module}"),
                                LegacyMigrationSeverity::Review,
                                "An unknown module name is preserved for review.",
                            );
                        }
                    }
                    let present_known = record
                        .keys()
                        .filter(|module| MODULE_KEYS.contains(&module.as_str()))
                        .count();
                    add_evidence(
                        evidence,
                        &format!("{key}.defaulted"),
                        MODULE_KEYS.len().saturating_sub(present_known),
                        "built_in_module_titles",
                    );
                }
            } else {
                add_issue(
                    issues,
                    source_id,
                    "invalid_metadata_record",
                    key,
                    LegacyMigrationSeverity::Error,
                    "Metadata must be a JSON object.",
                );
            }
        }
    }
    let mut template_ids = HashSet::<String>::new();
    if let Some(raw_templates) = map.get("resume-diy-imported-templates-v1") {
        if let Some(value) = parse_embedded_json(
            Some(raw_templates),
            source_id,
            "resume-diy-imported-templates-v1",
            issues,
        ) {
            if let Some(templates) = value.as_array() {
                counts.imported_templates = counts
                    .imported_templates
                    .saturating_add(templates.len() as u32);
                add_evidence(
                    evidence,
                    "resume-diy-imported-templates-v1",
                    templates.len(),
                    "present",
                );
                let mut ids = HashMap::<String, String>::new();
                let mut names = HashMap::<String, String>::new();
                for (index, template) in templates.iter().enumerate() {
                    let Some(template) = as_record(template) else {
                        add_issue(
                            issues,
                            source_id,
                            "invalid_template",
                            &format!("resume-diy-imported-templates-v1[{index}]"),
                            LegacyMigrationSeverity::Error,
                            "Imported template must be a JSON object.",
                        );
                        continue;
                    };
                    let Some(id) = nonempty_string(template.get("id")) else {
                        add_issue(
                            issues,
                            source_id,
                            "missing_template_id",
                            &format!("resume-diy-imported-templates-v1[{index}].id"),
                            LegacyMigrationSeverity::Review,
                            "The template has no stable legacy identifier.",
                        );
                        continue;
                    };
                    template_ids.insert(id.into());
                    let name = nonempty_string(template.get("name")).unwrap_or("");
                    for field in [
                        "name",
                        "sourceName",
                        "sourceType",
                        "createdAt",
                        "accent",
                        "formatId",
                        "layout",
                        "analysis",
                    ] {
                        if !template
                            .get(field)
                            .is_some_and(serde_json::Value::is_string)
                        {
                            add_issue(
                                issues,
                                source_id,
                                "invalid_template_field",
                                &format!("resume-diy-imported-templates-v1[{index}].{field}"),
                                LegacyMigrationSeverity::Error,
                                "A required imported-template field is missing or not a string.",
                            );
                        }
                    }
                    if template
                        .get("sourceType")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|value| !["image", "pdf", "word"].contains(&value))
                    {
                        add_issue(
                            issues,
                            source_id,
                            "unsupported_template_source_type",
                            &format!("resume-diy-imported-templates-v1[{index}].sourceType"),
                            LegacyMigrationSeverity::Review,
                            "The source type is not supported by the current imported-template contract.",
                        );
                    }
                    if template
                        .get("formatId")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|value| {
                            !["legacy-v1", "clear-single-v1", "compact-single-v1"].contains(&value)
                        })
                    {
                        add_issue(
                            issues,
                            source_id,
                            "unsupported_template_format",
                            &format!("resume-diy-imported-templates-v1[{index}].formatId"),
                            LegacyMigrationSeverity::Review,
                            "The template renderer ID requires explicit mapping review.",
                        );
                    }
                    if template
                        .get("layout")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|value| !["side-band", "single-column"].contains(&value))
                    {
                        add_issue(
                            issues,
                            source_id,
                            "unsupported_template_layout",
                            &format!("resume-diy-imported-templates-v1[{index}].layout"),
                            LegacyMigrationSeverity::Review,
                            "The imported-template layout requires explicit mapping review.",
                        );
                    }
                    if let Some(resume) = template.get("resume") {
                        if as_record(resume).is_some() {
                            let _ = inspect_resume_state(
                                resume,
                                source_id,
                                &format!("resume-diy-imported-templates-v1[{index}]"),
                                true,
                                counts,
                                evidence,
                                issues,
                                entities,
                            );
                        } else {
                            add_issue(
                                issues,
                                source_id,
                                "invalid_template_resume",
                                &format!("resume-diy-imported-templates-v1[{index}].resume"),
                                LegacyMigrationSeverity::Error,
                                "An imported-template draft must be a legacy resume object.",
                            );
                        }
                    }
                    if let Some(order) = template.get("moduleOrder") {
                        if let Some(order) = order.as_array() {
                            add_evidence(
                                evidence,
                                &format!("resume-diy-imported-templates-v1[{index}].moduleOrder"),
                                order.len(),
                                "present",
                            );
                        } else {
                            add_issue(
                                issues,
                                source_id,
                                "invalid_template_module_order",
                                &format!("resume-diy-imported-templates-v1[{index}].moduleOrder"),
                                LegacyMigrationSeverity::Review,
                                "The template module order needs explicit review.",
                            );
                        }
                    }
                    if let Some(names) = template.get("moduleNames") {
                        if let Some(names) = as_record(names) {
                            add_evidence(
                                evidence,
                                &format!("resume-diy-imported-templates-v1[{index}].moduleNames"),
                                names.len(),
                                "present",
                            );
                        } else {
                            add_issue(
                                issues,
                                source_id,
                                "invalid_template_module_names",
                                &format!("resume-diy-imported-templates-v1[{index}].moduleNames"),
                                LegacyMigrationSeverity::Review,
                                "The template module names need explicit review.",
                            );
                        }
                    }
                    if template
                        .get("extractedText")
                        .is_some_and(|value| !value.is_string())
                    {
                        add_issue(
                            issues,
                            source_id,
                            "invalid_template_extracted_text",
                            &format!("resume-diy-imported-templates-v1[{index}].extractedText"),
                            LegacyMigrationSeverity::Error,
                            "Extracted template text must be a string.",
                        );
                    }
                    if template
                        .get("extractedText")
                        .and_then(serde_json::Value::as_str)
                        .is_some()
                    {
                        counts.extracted_text_records =
                            counts.extracted_text_records.saturating_add(1);
                        add_evidence(
                            evidence,
                            &format!("resume-diy-imported-templates-v1[{index}].extractedText"),
                            1,
                            "present",
                        );
                    }
                    let digest = sha256(
                        &serde_json::to_vec(&serde_json::Value::Object(template.clone()))
                            .unwrap_or_default(),
                    );
                    if ids.get(id).is_some_and(|previous| previous != &digest) {
                        add_issue(
                            issues,
                            source_id,
                            "same_template_id_different_content",
                            &format!("resume-diy-imported-templates-v1[{index}].id"),
                            LegacyMigrationSeverity::Error,
                            "The same template identifier has conflicting content.",
                        );
                    }
                    ids.insert(id.into(), digest);
                    if let Some(previous_id) = names.get(name) {
                        if previous_id != id {
                            add_issue(issues, source_id, "same_template_name_different_id", &format!("resume-diy-imported-templates-v1[{index}].name"), LegacyMigrationSeverity::Review, "Different templates share a name; neither is selected automatically.");
                        }
                    } else if !name.is_empty() {
                        names.insert(name.into(), id.into());
                    }
                    if let Some(preview) = template
                        .get("previewDataUrl")
                        .and_then(serde_json::Value::as_str)
                    {
                        match decode_data_url(preview) {
                            Some(bytes) if supported_image_bytes(&bytes) => {
                                counts.template_assets_present =
                                    counts.template_assets_present.saturating_add(1)
                            }
                            _ => {
                                counts.template_assets_missing =
                                    counts.template_assets_missing.saturating_add(1);
                                add_issue(
                                    issues,
                                    source_id,
                                    "invalid_template_preview",
                                    &format!(
                                        "resume-diy-imported-templates-v1[{index}].previewDataUrl"
                                    ),
                                    LegacyMigrationSeverity::Review,
                                    "The preview source is not a valid supported data URL.",
                                );
                            }
                        }
                    } else if template
                        .get("previewAssetId")
                        .and_then(serde_json::Value::as_str)
                        .is_some()
                    {
                        counts.template_assets_missing =
                            counts.template_assets_missing.saturating_add(1);
                        add_issue(issues, source_id, "template_asset_reference_unresolved", &format!("resume-diy-imported-templates-v1[{index}].previewAssetId"), LegacyMigrationSeverity::Review, "A template references an asset that is not included in this browser export.");
                    } else {
                        counts.template_assets_missing =
                            counts.template_assets_missing.saturating_add(1);
                        add_issue(
                            issues,
                            source_id,
                            "template_preview_missing",
                            &format!("resume-diy-imported-templates-v1[{index}].previewDataUrl"),
                            LegacyMigrationSeverity::Review,
                            "No template preview resource was included in the browser export.",
                        );
                    }
                    entities.push(fingerprint_entity(
                        source_id,
                        "imported-template",
                        id,
                        &serde_json::Value::Object(template.clone()),
                        Some(name),
                    ));
                }
            } else {
                add_issue(
                    issues,
                    source_id,
                    "invalid_template_catalog",
                    "resume-diy-imported-templates-v1",
                    LegacyMigrationSeverity::Error,
                    "Imported template catalog must be an array.",
                );
            }
        }
    }
    if let Some(active_template) = map.get("resume-diy-active-imported-template") {
        if !active_template.trim().is_empty() {
            counts.active_template_records = counts.active_template_records.saturating_add(1);
            add_evidence(
                evidence,
                "resume-diy-active-imported-template",
                1,
                "present",
            );
            if !template_ids.contains(active_template) {
                add_issue(
                    issues,
                    source_id,
                    "active_template_unresolved",
                    "resume-diy-active-imported-template",
                    LegacyMigrationSeverity::Review,
                    "The active imported-template ID is not present in the included template catalog.",
                );
            }
        }
    }
    for key in [
        "resume-diy-editor-pane-width",
        "resume-diy-layout-consistency-v1",
        "resume-diy-smart-fit-signature-v3",
        "resume-diy-version-project-revision",
        "resume-diy-agent-mode-v1",
        "resume-diy-agent-position-v1",
        "resume-diy-agent-size-v1",
    ] {
        if let Some(raw) = map.get(key) {
            counts.preference_fields = counts.preference_fields.saturating_add(1);
            add_evidence(evidence, key, 1, "source_retained_for_review");
            if key == "resume-diy-editor-pane-width"
                && raw
                    .parse::<f64>()
                    .ok()
                    .is_none_or(|value| !value.is_finite() || value <= 0.0)
            {
                add_issue(
                    issues,
                    source_id,
                    "invalid_editor_pane_width",
                    key,
                    LegacyMigrationSeverity::Review,
                    "The old editor-pane width requires fallback review.",
                );
            }
        }
    }
    for key in ["resume-diy-title", "resume-diy-summary-title"] {
        if let Some(raw) = map.get(key) {
            counts.preference_fields = counts.preference_fields.saturating_add(1);
            if raw.trim().is_empty() {
                add_issue(
                    issues,
                    source_id,
                    "defaulted_browser_title",
                    key,
                    LegacyMigrationSeverity::Review,
                    "Legacy conversion would supply a default for this title.",
                );
            }
            add_evidence(evidence, key, 1, "present");
        }
    }
    for (key, raw) in &map {
        if key == "resume-diy-agent-accounts" {
            if let Some(value) = parse_embedded_json(Some(raw), source_id, key, issues) {
                inspect_account_json(&value, source_id, counts, evidence, issues, entities);
            }
        } else if key.starts_with("resume-diy-agent-sessions-v2:") {
            let account_id = key
                .strip_prefix("resume-diy-agent-sessions-v2:")
                .unwrap_or_default();
            if account_id.trim().is_empty() {
                add_issue(
                    issues,
                    source_id,
                    "missing_session_account_id",
                    key,
                    LegacyMigrationSeverity::Review,
                    "The session namespace has no account identifier.",
                );
            }
            if let Some(value) = parse_embedded_json(Some(raw), source_id, key, issues) {
                if let Some(store) = as_record(&value) {
                    if let Some(sessions) =
                        store.get("sessions").and_then(serde_json::Value::as_array)
                    {
                        let mut account_messages = 0usize;
                        let mut account_running = 0usize;
                        counts.agent_sessions =
                            counts.agent_sessions.saturating_add(sessions.len() as u32);
                        add_evidence(evidence, key, sessions.len(), "account_scoped_sessions");
                        for (session_index, session) in sessions.iter().enumerate() {
                            if let Some(messages) = session
                                .get("messages")
                                .and_then(serde_json::Value::as_array)
                            {
                                counts.session_messages = counts
                                    .session_messages
                                    .saturating_add(messages.len() as u32);
                                account_messages = account_messages.saturating_add(messages.len());
                            }
                            if session.get("status").and_then(serde_json::Value::as_str)
                                == Some("running")
                            {
                                counts.running_runs_marked_interrupted =
                                    counts.running_runs_marked_interrupted.saturating_add(1);
                                account_running = account_running.saturating_add(1);
                                add_issue(issues, source_id, "running_session_interrupted", &format!("{key}.sessions[{session_index}].status"), LegacyMigrationSeverity::Review, "A running legacy session will be imported as interrupted and will not be replayed.");
                            }
                        }
                        add_evidence(
                            evidence,
                            &format!("{key}.messages"),
                            account_messages,
                            "account_scoped_history",
                        );
                        add_evidence(
                            evidence,
                            &format!("{key}.running"),
                            account_running,
                            "marked_interrupted",
                        );
                    } else {
                        add_issue(
                            issues,
                            source_id,
                            "invalid_agent_session_store",
                            key,
                            LegacyMigrationSeverity::Review,
                            "The account session record does not contain a sessions array.",
                        );
                    }
                } else {
                    add_issue(
                        issues,
                        source_id,
                        "invalid_agent_session_store",
                        key,
                        LegacyMigrationSeverity::Error,
                        "Account session data must be a JSON object.",
                    );
                }
            }
        } else if key.starts_with("resume-diy-source-preview-dismissed:") {
            counts.template_preview_dismissals =
                counts.template_preview_dismissals.saturating_add(1);
            add_evidence(evidence, "template.previewDismissals", 1, "present");
        }
    }
    let mut embedded_version_hash = None;
    if let Some(primary) = map.get("resume-diy-version-store-v1") {
        if let Some(value) = parse_embedded_json(
            Some(primary),
            source_id,
            "resume-diy-version-store-v1",
            issues,
        ) {
            let mut temp = Vec::new();
            let mut hash_issues = Vec::new();
            let primary_hash = inspect_version_store(
                &value,
                source_id,
                "resume-diy-version-store-v1",
                counts,
                evidence,
                &mut hash_issues,
                entities,
            );
            embedded_version_hash = primary_hash.clone();
            issues.extend(hash_issues);
            if primary_hash.is_none() {
                if let Some(backup) = map.get("resume-diy-version-store-v1-backup") {
                    if let Some(backup_value) = parse_embedded_json(
                        Some(backup),
                        source_id,
                        "resume-diy-version-store-v1-backup",
                        &mut temp,
                    ) {
                        let mut backup_issues = Vec::new();
                        let backup_hash = inspect_version_store(
                            &backup_value,
                            source_id,
                            "resume-diy-version-store-v1-backup",
                            counts,
                            evidence,
                            &mut backup_issues,
                            entities,
                        );
                        if backup_hash.is_some()
                            && !backup_issues
                                .iter()
                                .any(|issue| issue.severity == LegacyMigrationSeverity::Error)
                        {
                            add_issue(issues, source_id, "version_backup_recoverable", "resume-diy-version-store-v1-backup", LegacyMigrationSeverity::Review, "The primary version store is damaged and a valid backup is available; the backup is not selected automatically.");
                        }
                        issues.extend(backup_issues);
                    }
                    issues.extend(temp);
                }
            } else if let Some(backup) = map.get("resume-diy-version-store-v1-backup") {
                if let Some(backup_value) = parse_embedded_json(
                    Some(backup),
                    source_id,
                    "resume-diy-version-store-v1-backup",
                    issues,
                ) {
                    if let Some(backup_hash) = inspect_version_store(
                        &backup_value,
                        source_id,
                        "resume-diy-version-store-v1-backup",
                        counts,
                        evidence,
                        issues,
                        entities,
                    ) {
                        if primary_hash.as_deref() != Some(backup_hash.as_str()) {
                            add_issue(issues, source_id, "version_backup_differs", "resume-diy-version-store-v1-backup", LegacyMigrationSeverity::Review, "Primary and backup version stores differ; neither is overwritten or selected by recency.");
                        }
                    }
                }
            }
        } else if let Some(backup) = map.get("resume-diy-version-store-v1-backup") {
            if let Some(backup_value) = parse_embedded_json(
                Some(backup),
                source_id,
                "resume-diy-version-store-v1-backup",
                issues,
            ) {
                if inspect_version_store(
                    &backup_value,
                    source_id,
                    "resume-diy-version-store-v1-backup",
                    counts,
                    evidence,
                    issues,
                    entities,
                )
                .is_some()
                {
                    add_issue(
                        issues,
                        source_id,
                        "version_backup_recoverable",
                        "resume-diy-version-store-v1-backup",
                        LegacyMigrationSeverity::Review,
                        "The primary version store is damaged and a valid backup is available; the backup is not selected automatically.",
                    );
                }
            }
        }
    } else if let Some(backup) = map.get("resume-diy-version-store-v1-backup") {
        if let Some(backup_value) = parse_embedded_json(
            Some(backup),
            source_id,
            "resume-diy-version-store-v1-backup",
            issues,
        ) {
            if inspect_version_store(
                &backup_value,
                source_id,
                "resume-diy-version-store-v1-backup",
                counts,
                evidence,
                issues,
                entities,
            )
            .is_some()
            {
                add_issue(
                    issues,
                    source_id,
                    "version_backup_recoverable",
                    "resume-diy-version-store-v1-backup",
                    LegacyMigrationSeverity::Review,
                    "Only a valid version backup is present; it is retained for explicit review.",
                );
            }
        }
    }
    let current_draft_present = map.contains_key("resume-diy-state");
    add_evidence(
        evidence,
        "browserExport.entries",
        entries.len(),
        "read_only",
    );
    (
        valid
            && !issues
                .iter()
                .any(|issue| issue.severity == LegacyMigrationSeverity::Error),
        current_draft_present,
        embedded_version_hash,
    )
}

fn decode_data_url(value: &str) -> Option<Vec<u8>> {
    let (header, data) = value.split_once(',')?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

// 宿主 storage 资源导入路径复用该图片格式探测（原 pub(crate)，P3a 迁出后转 pub 经垫片可见）。
pub fn supported_image_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP")
}

fn scan_account_fields(
    value: &serde_json::Value,
    source_id: &str,
    path: &str,
    counts: &mut LegacyMigrationCounts,
    issues: &mut Vec<LegacyMigrationIssue>,
) {
    match value {
        serde_json::Value::Object(record) => {
            for (key, nested) in record {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "apikey",
                    "providerkey",
                    "secret",
                    "secretkey",
                    "encryptedblob",
                ]
                .contains(&normalized.as_str())
                    && !nested.is_null()
                    && !(nested.is_string() && nested.as_str().is_some_and(str::is_empty))
                {
                    counts.provider_secrets_need_reentry =
                        counts.provider_secrets_need_reentry.saturating_add(1);
                    add_issue(issues, source_id, "provider_secret_requires_reentry", &format!("{path}.{key}"), LegacyMigrationSeverity::Review, "A provider secret is present; this inspector never returns it and the target Windows user must re-enter or explicitly re-encrypt it.");
                }
                if [
                    "sessiontoken",
                    "accesstoken",
                    "refreshtoken",
                    "cookie",
                    "sessionid",
                ]
                .contains(&normalized.as_str())
                    && !nested.is_null()
                {
                    counts.live_session_tokens_not_migrated =
                        counts.live_session_tokens_not_migrated.saturating_add(1);
                    add_issue(
                        issues,
                        source_id,
                        "live_session_not_migrated",
                        &format!("{path}.{key}"),
                        LegacyMigrationSeverity::Info,
                        "Live authentication material is excluded from migration.",
                    );
                }
                if [
                    "provider",
                    "providers",
                    "providerprofile",
                    "providerprofiles",
                ]
                .contains(&normalized.as_str())
                {
                    let amount = if normalized == "provider" && nested.is_object() {
                        1
                    } else if nested.is_array() {
                        nested.as_array().map_or(0, Vec::len)
                    } else if nested.is_object() {
                        nested.as_object().map_or(0, serde_json::Map::len)
                    } else {
                        usize::from(!nested.is_null())
                    };
                    counts.provider_profiles =
                        counts.provider_profiles.saturating_add(amount as u32);
                }
                scan_account_fields(nested, source_id, &format!("{path}.{key}"), counts, issues);
            }
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_account_fields(item, source_id, &format!("{path}[{index}]"), counts, issues);
            }
        }
        _ => {}
    }
}

fn inspect_account_json(
    value: &serde_json::Value,
    source_id: &str,
    counts: &mut LegacyMigrationCounts,
    evidence: &mut Vec<LegacyMigrationFieldEvidence>,
    issues: &mut Vec<LegacyMigrationIssue>,
    entities: &mut Vec<EntityFingerprint>,
) -> bool {
    let accounts = value
        .get("accounts")
        .or_else(|| value.get("users"))
        .or_else(|| value.as_array().map(|_| value));
    let Some(accounts) = accounts else {
        add_issue(issues, source_id, "unknown_account_schema", "accounts", LegacyMigrationSeverity::Review, "The account JSON schema is not recognized; original bytes and hash are retained without importing account fields.");
        return true;
    };
    let records: Vec<&serde_json::Value> = if let Some(array) = accounts.as_array() {
        array.iter().collect()
    } else if let Some(object) = accounts.as_object() {
        object.values().collect()
    } else {
        add_issue(
            issues,
            source_id,
            "invalid_account_records",
            "accounts",
            LegacyMigrationSeverity::Error,
            "Account records must be an array or object.",
        );
        return false;
    };
    counts.account_records = counts.account_records.saturating_add(records.len() as u32);
    if let Some(tokens) = value.get("sessions").and_then(serde_json::Value::as_array) {
        counts.live_session_tokens_not_migrated = counts
            .live_session_tokens_not_migrated
            .saturating_add(tokens.len() as u32);
        add_evidence(
            evidence,
            "accounts.sessions",
            tokens.len(),
            "excluded_live_tokens",
        );
    }
    add_evidence(evidence, "accounts", records.len(), "present");
    for (index, account) in records.iter().enumerate() {
        let path = format!("accounts[{index}]");
        let Some(record) = as_record(account) else {
            counts.damaged_account_records = counts.damaged_account_records.saturating_add(1);
            add_issue(
                issues,
                source_id,
                "damaged_account_record",
                &path,
                LegacyMigrationSeverity::Review,
                "This account record is not an object and is retained for manual recovery.",
            );
            continue;
        };
        let id =
            nonempty_string(record.get("id")).or_else(|| nonempty_string(record.get("accountId")));
        let email = nonempty_string(record.get("email"));
        if id.is_none() || email.is_none() {
            counts.damaged_account_records = counts.damaged_account_records.saturating_add(1);
            add_issue(issues, source_id, "damaged_account_record", &path, LegacyMigrationSeverity::Review, "Account ID or email is missing; account status is reported separately from other sources.");
        }
        if let Some(id) = id {
            entities.push(fingerprint_entity(source_id, "account", id, account, email));
        }
        if record.keys().any(|key| {
            matches!(
                key.as_str(),
                "passwordHash" | "password_hash" | "password_hash_hex"
            )
        }) {
            add_evidence(
                evidence,
                &format!("{path}.passwordHash"),
                1,
                "hash_present_not_migrated_without_kdf_match",
            );
        }
        scan_account_fields(account, source_id, &path, counts, issues);
    }
    true
}

fn inspect_one(source: &LegacyMigrationSourceInput) -> InternalSourceResult {
    let source_hash = sha256(source.raw_json.as_bytes());
    let mut counts = LegacyMigrationCounts::default();
    let mut evidence = Vec::new();
    let mut issues = Vec::new();
    let mut entities = Vec::new();
    let mut version_store_hash = None;
    if source.raw_json.len() > MAX_SOURCE_BYTES {
        add_issue(
            &mut issues,
            &source.source_id,
            "source_too_large",
            "file",
            LegacyMigrationSeverity::Error,
            "The selected source exceeds the per-file migration inspection limit.",
        );
    } else if !valid_source_id(&source.source_id) {
        add_issue(
            &mut issues,
            &source.source_id,
            "invalid_source_id",
            "sourceId",
            LegacyMigrationSeverity::Error,
            "Source IDs must be short labels, not file paths.",
        );
    } else {
        match serde_json::from_str::<serde_json::Value>(&source.raw_json) {
            Err(_) => add_issue(
                &mut issues,
                &source.source_id,
                "invalid_json",
                "file",
                LegacyMigrationSeverity::Error,
                "The selected source is not valid JSON; source bytes remain unchanged.",
            ),
            Ok(value) => match source.kind {
                LegacyMigrationSourceKind::BrowserExport => {
                    let (_, current_draft, embedded_version_hash) = inspect_browser_export(
                        &value,
                        &source.source_id,
                        &mut counts,
                        &mut evidence,
                        &mut issues,
                        &mut entities,
                    );
                    let schema = "zinecv-legacy-browser-export/v1".to_string();
                    return InternalSourceResult {
                        report: LegacyMigrationSourceReport {
                            source_id: source.source_id.clone(),
                            kind: source.kind,
                            source_sha256: source_hash,
                            schema,
                            valid: !issues
                                .iter()
                                .any(|issue| issue.severity == LegacyMigrationSeverity::Error),
                            counts,
                            field_evidence: evidence,
                            issues,
                            current_draft_present: current_draft,
                        },
                        entities,
                        version_store_hash: embedded_version_hash,
                    };
                }
                LegacyMigrationSourceKind::VersionJson
                | LegacyMigrationSourceKind::VersionBackupJson => {
                    if value.get("format").and_then(serde_json::Value::as_str)
                        == Some("resume-diy-version-backup")
                    {
                        if value
                            .get("formatVersion")
                            .and_then(serde_json::Value::as_u64)
                            .is_none_or(|version| !(1..=2).contains(&version))
                        {
                            add_issue(
                                &mut issues,
                                &source.source_id,
                                "unsupported_version_backup",
                                "formatVersion",
                                LegacyMigrationSeverity::Error,
                                "This version-backup format is not supported.",
                            );
                        }
                        version_store_hash = inspect_version_store(
                            &value,
                            &source.source_id,
                            "store",
                            &mut counts,
                            &mut evidence,
                            &mut issues,
                            &mut entities,
                        );
                        if let Some(draft) =
                            value.get("draft").and_then(|draft| draft.get("snapshot"))
                        {
                            let _ = inspect_snapshot(
                                draft,
                                &source.source_id,
                                "draft.snapshot",
                                &mut counts,
                                &mut evidence,
                                &mut issues,
                                &mut entities,
                            );
                        }
                    } else {
                        version_store_hash = inspect_version_store(
                            &value,
                            &source.source_id,
                            "versionStore",
                            &mut counts,
                            &mut evidence,
                            &mut issues,
                            &mut entities,
                        );
                        if source.kind == LegacyMigrationSourceKind::VersionBackupJson {
                            add_issue(&mut issues, &source.source_id, "backup_container_missing", "format", LegacyMigrationSeverity::Review, "The selected backup is a bare version store; its original file role is retained for explicit review.");
                        }
                    }
                    let mut report = LegacyMigrationSourceReport {
                        source_id: source.source_id.clone(),
                        kind: source.kind,
                        source_sha256: source_hash,
                        schema: if value.get("format").is_some() {
                            "resume-diy-version-backup/v1-v2"
                        } else {
                            "resume-diy-version-store"
                        }
                        .into(),
                        valid: !issues
                            .iter()
                            .any(|issue| issue.severity == LegacyMigrationSeverity::Error),
                        counts,
                        field_evidence: evidence,
                        issues,
                        current_draft_present: false,
                    };
                    if source.kind == LegacyMigrationSourceKind::VersionJson
                        && !report.current_draft_present
                    {
                        report.field_evidence.push(LegacyMigrationFieldEvidence {
                            field: "workspace.currentDraft".into(),
                            records: 0,
                            status: "not_inferred_from_versions_only".into(),
                        });
                    }
                    return InternalSourceResult {
                        report,
                        entities,
                        version_store_hash,
                    };
                }
                LegacyMigrationSourceKind::AccountJson => {
                    let valid = inspect_account_json(
                        &value,
                        &source.source_id,
                        &mut counts,
                        &mut evidence,
                        &mut issues,
                        &mut entities,
                    );
                    return InternalSourceResult {
                        report: LegacyMigrationSourceReport {
                            source_id: source.source_id.clone(),
                            kind: source.kind,
                            source_sha256: source_hash,
                            schema: "legacy-agent-accounts/unresolved".into(),
                            valid: valid
                                && !issues
                                    .iter()
                                    .any(|issue| issue.severity == LegacyMigrationSeverity::Error),
                            counts,
                            field_evidence: evidence,
                            issues,
                            current_draft_present: false,
                        },
                        entities,
                        version_store_hash: None,
                    };
                }
            },
        }
    }
    InternalSourceResult {
        report: LegacyMigrationSourceReport {
            source_id: source.source_id.clone(),
            kind: source.kind,
            source_sha256: source_hash,
            schema: "unrecognized".into(),
            valid: false,
            counts,
            field_evidence: evidence,
            issues,
            current_draft_present: false,
        },
        entities,
        version_store_hash,
    }
}

fn cross_source_conflicts(
    entities: &[EntityFingerprint],
    issues: &mut Vec<LegacyMigrationIssue>,
) -> Vec<LegacyMigrationConflict> {
    let mut conflicts = Vec::new();
    let mut by_identity = HashMap::<(String, String), EntityFingerprint>::new();
    let mut by_name = HashMap::<(String, String), EntityFingerprint>::new();
    let mut same_content = HashMap::<String, EntityFingerprint>::new();
    for entity in entities {
        let key = (entity.kind.clone(), entity.id.clone());
        if let Some(previous) = by_identity.get(&key) {
            if previous.source_id != entity.source_id
                && previous.content_hash != entity.content_hash
            {
                let sources = vec![previous.source_id.clone(), entity.source_id.clone()];
                conflicts.push(LegacyMigrationConflict {
                    kind: LegacyMigrationConflictKind::SameIdDifferentContent,
                    entity_kind: entity.kind.clone(),
                    entity_id: entity.id.clone(),
                    source_ids: sources.clone(),
                    severity: LegacyMigrationSeverity::Error,
                });
                add_issue(issues, &entity.source_id, "same_id_different_content", &format!("{}[legacyId]", entity.kind), LegacyMigrationSeverity::Error, "The same legacy ID has different source content; no version is selected automatically.");
            }
        } else {
            by_identity.insert(key, entity.clone());
        }
        if let Some(name) = entity.name.as_deref().filter(|name| !name.is_empty()) {
            let name_key = (entity.kind.clone(), name.to_lowercase());
            if let Some(previous) = by_name.get(&name_key) {
                if previous.source_id != entity.source_id && previous.id != entity.id {
                    conflicts.push(LegacyMigrationConflict {
                        kind: LegacyMigrationConflictKind::SameNameDifferentId,
                        entity_kind: entity.kind.clone(),
                        entity_id: sha256(name.as_bytes())[..12].into(),
                        source_ids: vec![previous.source_id.clone(), entity.source_id.clone()],
                        severity: LegacyMigrationSeverity::Review,
                    });
                    add_issue(
                        issues,
                        &entity.source_id,
                        "same_name_different_id",
                        &format!("{}[name]", entity.kind),
                        LegacyMigrationSeverity::Review,
                        "Same-named entities with distinct legacy IDs are retained separately.",
                    );
                }
            } else {
                by_name.insert(name_key, entity.clone());
            }
        }
        if entity.kind == "version-commit" {
            if let Some(previous) = same_content.get(&entity.content_hash) {
                if previous.source_id != entity.source_id && previous.id != entity.id {
                    conflicts.push(LegacyMigrationConflict {
                        kind: LegacyMigrationConflictKind::SameContentDifferentCommit,
                        entity_kind: entity.kind.clone(),
                        entity_id: sha256(entity.content_hash.as_bytes())[..12].into(),
                        source_ids: vec![previous.source_id.clone(), entity.source_id.clone()],
                        severity: LegacyMigrationSeverity::Info,
                    });
                }
            } else {
                same_content.insert(entity.content_hash.clone(), entity.clone());
            }
        }
    }
    conflicts
}

pub fn inspect(request: &InspectLegacyMigrationRequest) -> LegacyMigrationReport {
    let mut report_issues = Vec::new();
    let namespace = request
        .source_namespace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if request.sources.is_empty() || request.sources.len() > MAX_SOURCE_COUNT {
        add_issue(
            &mut report_issues,
            "request",
            "source_count_out_of_range",
            "sources",
            LegacyMigrationSeverity::Error,
            "Select between one and eight explicit source files.",
        );
    }
    if namespace.is_some_and(|namespace| !valid_namespace(namespace)) {
        add_issue(
            &mut report_issues,
            "request",
            "invalid_namespace",
            "sourceNamespace",
            LegacyMigrationSeverity::Error,
            "Namespace IDs may contain only letters, numbers, dot, underscore, colon and hyphen.",
        );
    }
    let total_bytes = request.sources.iter().fold(0usize, |total, source| {
        total.saturating_add(source.raw_json.len())
    });
    if total_bytes > MAX_TOTAL_SOURCE_BYTES {
        add_issue(
            &mut report_issues,
            "request",
            "total_source_limit",
            "sources",
            LegacyMigrationSeverity::Error,
            "Selected sources exceed the total migration inspection limit.",
        );
    }
    let mut source_ids = HashSet::new();
    let mut internal = Vec::new();
    for source in &request.sources {
        if !source_ids.insert(source.source_id.clone()) {
            add_issue(
                &mut report_issues,
                &source.source_id,
                "duplicate_source_id",
                "sourceId",
                LegacyMigrationSeverity::Error,
                "Source IDs must be unique within one inspection.",
            );
        }
        internal.push(inspect_one(source));
    }
    let entities: Vec<EntityFingerprint> = internal
        .iter()
        .flat_map(|result| result.entities.clone())
        .collect();
    let mut conflicts = cross_source_conflicts(&entities, &mut report_issues);
    let version_hashes: Vec<(&str, &str, LegacyMigrationSourceKind)> = internal
        .iter()
        .filter_map(|result| {
            result
                .version_store_hash
                .as_deref()
                .map(|hash| (result.report.source_id.as_str(), hash, result.report.kind))
        })
        .collect();
    if version_hashes.len() > 1 {
        for left in 0..version_hashes.len() {
            for right in (left + 1)..version_hashes.len() {
                let (left_source, left_hash, left_kind) = version_hashes[left];
                let (right_source, right_hash, right_kind) = version_hashes[right];
                if left_hash != right_hash {
                    let has_browser = left_kind == LegacyMigrationSourceKind::BrowserExport
                        || right_kind == LegacyMigrationSourceKind::BrowserExport;
                    report_issues.push(LegacyMigrationIssue {
                        source_id: right_source.into(),
                        code: if has_browser {
                            "browser_version_conflict"
                        } else {
                            "version_sources_disagree"
                        }
                        .into(),
                        path: "versionStore".into(),
                        severity: LegacyMigrationSeverity::Error,
                        message: "Selected version sources differ; the importer does not choose by timestamp or record count.".into(),
                    });
                    if has_browser {
                        conflicts.push(LegacyMigrationConflict {
                            kind: LegacyMigrationConflictKind::BrowserVersionConflict,
                            entity_kind: "version-store".into(),
                            entity_id: sha256(format!("{left_hash}\0{right_hash}").as_bytes())
                                [..12]
                                .into(),
                            source_ids: vec![left_source.into(), right_source.into()],
                            severity: LegacyMigrationSeverity::Error,
                        });
                    }
                }
            }
        }
    }
    let mut totals = LegacyMigrationCounts::default();
    let mut sources = Vec::with_capacity(internal.len());
    for result in internal {
        totals.add_assign(&result.report.counts);
        report_issues.extend(result.report.issues.iter().cloned());
        sources.push(result.report);
    }
    let namespace_decision_required = namespace.is_none();
    if namespace_decision_required {
        add_issue(&mut report_issues, "request", "namespace_choice_required", "sourceNamespace", LegacyMigrationSeverity::Review, "Choose whether the selected files belong to one existing legacy library or to a separate source namespace.");
    }
    let valid = !report_issues
        .iter()
        .any(|issue| issue.severity == LegacyMigrationSeverity::Error)
        && sources.iter().all(|source| source.valid);
    let has_review = namespace_decision_required
        || report_issues
            .iter()
            .any(|issue| issue.severity == LegacyMigrationSeverity::Review)
        || sources
            .iter()
            .any(|source| issue_requires_review(&source.issues));
    let status = if !valid {
        "invalid"
    } else if has_review {
        "needs_review"
    } else {
        "ready"
    };
    let unique_entity_identity_count = entities
        .iter()
        .map(|entity| (entity.kind.as_str(), entity.id.as_str()))
        .collect::<BTreeSet<_>>()
        .len()
        .min(u32::MAX as usize) as u32;
    LegacyMigrationReport {
        importer_version: IMPORTER_VERSION.into(),
        source_namespace: namespace.map(str::to_string),
        namespace_decision_required,
        status: status.into(),
        ready_for_dry_run: valid,
        no_target_writes: true,
        sources,
        totals,
        conflicts,
        issues: report_issues,
        unique_entity_identity_count,
    }
}

fn issue_requires_review(issues: &[LegacyMigrationIssue]) -> bool {
    issues
        .iter()
        .any(|issue| issue.severity == LegacyMigrationSeverity::Review)
}

pub fn dry_run(request: &DryRunLegacyMigrationRequest) -> LegacyMigrationDryRun {
    let inspection = inspect(&request.inspection);
    let source_hashes_match =
        expected_source_hashes_match(&inspection, &request.expected_source_hashes);
    let batch_key = source_batch_key(&inspection);
    let mut conversion_issues =
        validate_converted_documents(&request.converted_documents, &inspection);
    let converted_document_count = request.converted_documents.len().min(u32::MAX as usize) as u32;
    let expected_document_count = inspection.totals.resume_snapshots;
    if converted_document_count != expected_document_count {
        add_issue(
            &mut conversion_issues,
            "request",
            "conversion_incomplete",
            "convertedDocuments",
            LegacyMigrationSeverity::Review,
            "The converted document count does not match the source snapshot inventory.",
        );
    }
    let conversion_complete = converted_document_count == expected_document_count
        && !conversion_issues
            .iter()
            .any(|issue| issue.severity == LegacyMigrationSeverity::Error);
    let conversion_invalid = conversion_issues
        .iter()
        .any(|issue| issue.severity == LegacyMigrationSeverity::Error);
    let namespace = inspection.source_namespace.as_deref();
    let staging_result =
        if source_hashes_match && inspection.ready_for_dry_run && !conversion_invalid {
            namespace
                .zip(batch_key.as_deref())
                .map(|(namespace, batch)| {
                    stage_identity_mapping(
                        namespace,
                        batch,
                        &request.inspection.sources,
                        &request.converted_documents,
                    )
                })
        } else {
            None
        };
    let staging_database_created = staging_result.is_some();
    let staging_failed = staging_result.as_ref().is_some_and(Result::is_err);
    let status = if !source_hashes_match {
        "source_changed"
    } else if staging_failed {
        "staging_failed"
    } else if !inspection.ready_for_dry_run {
        "blocked_by_source_errors"
    } else if conversion_invalid {
        "invalid_conversion"
    } else if !conversion_complete {
        "conversion_incomplete"
    } else if inspection.namespace_decision_required || inspection.status == "needs_review" {
        "requires_review"
    } else {
        "ready"
    };
    let live_session_tokens_excluded = inspection.totals.live_session_tokens_not_migrated;
    let unsupported_items_preserved_for_review = inspection.totals.unknown_items;
    let (staged_identity_count, staged_document_count) = match staging_result {
        Some(Ok(counts)) => counts,
        Some(Err(_)) | None => (0, 0),
    };
    LegacyMigrationDryRun {
        importer_version: IMPORTER_VERSION.into(),
        batch_key,
        source_hashes_match,
        target_database_unchanged: true,
        staging_database_created,
        conversion_complete,
        conversion_issues,
        status: status.into(),
        staged_identity_count,
        staged_document_count,
        identity_mapping_namespace: inspection.source_namespace.clone(),
        live_session_tokens_excluded,
        unsupported_items_preserved_for_review,
        inspection,
    }
}

fn validate_converted_documents(
    documents: &[LegacyMigrationConvertedDocument],
    inspection: &LegacyMigrationReport,
) -> Vec<LegacyMigrationIssue> {
    let mut issues = Vec::new();
    let sources: HashMap<&str, &str> = inspection
        .sources
        .iter()
        .map(|source| (source.source_id.as_str(), source.source_sha256.as_str()))
        .collect();
    let mut identities = HashSet::new();
    for (index, candidate) in documents.iter().enumerate() {
        let path = format!("convertedDocuments[{index}]");
        match sources.get(candidate.source_id.as_str()) {
            Some(hash) if **hash == candidate.source_sha256 => {}
            _ => add_issue(
                &mut issues,
                &candidate.source_id,
                "converted_source_hash_mismatch",
                &format!("{path}.sourceSha256"),
                LegacyMigrationSeverity::Error,
                "A converted document is not bound to an inspected source hash.",
            ),
        }
        if candidate.legacy_id.trim().is_empty()
            || candidate.legacy_id.len() > 512
            || candidate.legacy_id.chars().any(char::is_control)
        {
            add_issue(
                &mut issues,
                &candidate.source_id,
                "invalid_converted_legacy_id",
                &format!("{path}.legacyId"),
                LegacyMigrationSeverity::Error,
                "A converted document needs a bounded, nonempty legacy identity.",
            );
        }
        let identity = (candidate.document_kind, candidate.legacy_id.as_str());
        if !identities.insert(identity) {
            add_issue(
                &mut issues,
                &candidate.source_id,
                "duplicate_converted_identity",
                &format!("{path}.legacyId"),
                LegacyMigrationSeverity::Error,
                "A document identity occurs more than once in the converted batch.",
            );
        }
        if zinecv_domain::DocumentContext::new(candidate.document.clone()).is_err() {
            add_issue(
                &mut issues,
                &candidate.source_id,
                "invalid_converted_document",
                &format!("{path}.document"),
                LegacyMigrationSeverity::Error,
                "The converted document failed native domain validation.",
            );
        }
    }
    issues
}

fn stage_identity_mapping(
    namespace: &str,
    batch_key: &str,
    sources: &[LegacyMigrationSourceInput],
    documents: &[LegacyMigrationConvertedDocument],
) -> rusqlite::Result<(u32, u32)> {
    let connection = Connection::open_in_memory()?;
    connection.execute_batch(
        "CREATE TABLE legacy_entity_identity (
            namespace TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            legacy_id TEXT NOT NULL,
            batch_key TEXT NOT NULL,
            importer_version TEXT NOT NULL,
         PRIMARY KEY (namespace, entity_kind, legacy_id)
        );
        CREATE TABLE converted_document (
            namespace TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            legacy_id TEXT NOT NULL,
            source_sha256 TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            document_json TEXT NOT NULL,
            PRIMARY KEY (namespace, entity_kind, legacy_id)
        );",
    )?;
    for source in sources {
        for entity in inspect_one(source).entities {
            connection.execute(
                "INSERT OR IGNORE INTO legacy_entity_identity
                    (namespace, entity_kind, legacy_id, batch_key, importer_version)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    namespace,
                    entity.kind,
                    entity.id,
                    batch_key,
                    IMPORTER_VERSION
                ],
            )?;
        }
    }
    for candidate in documents {
        let document_json = serde_json::to_string(&candidate.document)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        connection.execute(
            "INSERT INTO converted_document
                (namespace, entity_kind, legacy_id, source_sha256, content_sha256, document_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                namespace,
                match candidate.document_kind {
                    LegacyMigrationDocumentKind::CurrentDraft => "current_draft",
                    LegacyMigrationDocumentKind::VersionCommit => "version_commit",
                    LegacyMigrationDocumentKind::ImportedTemplate => "imported_template",
                },
                candidate.legacy_id,
                candidate.source_sha256,
                sha256(document_json.as_bytes()),
                document_json,
            ],
        )?;
    }
    let count = connection.query_row("SELECT COUNT(*) FROM legacy_entity_identity", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let document_count =
        connection.query_row("SELECT COUNT(*) FROM converted_document", [], |row| {
            row.get::<_, i64>(0)
        })?;
    Ok((
        u32::try_from(count).unwrap_or(u32::MAX),
        u32::try_from(document_count).unwrap_or(u32::MAX),
    ))
}

#[cfg(test)]
mod tests {
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
        assert!(report.conflicts.iter().any(
            |conflict| conflict.kind == LegacyMigrationConflictKind::SameContentDifferentCommit
        ));
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
}

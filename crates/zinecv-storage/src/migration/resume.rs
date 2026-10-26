use super::*;

// The same accumulator bundle is threaded through the bounded legacy JSON walk.
#[allow(clippy::too_many_arguments)]
pub(super) fn inspect_resume_state(
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

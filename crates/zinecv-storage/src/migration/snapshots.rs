use super::*;

pub(super) fn inspect_snapshot(
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

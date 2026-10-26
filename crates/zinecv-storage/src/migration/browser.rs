use super::*;

pub(super) fn inspect_browser_export(
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

use super::*;

pub(super) fn inspect_one(source: &LegacyMigrationSourceInput) -> InternalSourceResult {
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

pub(super) fn cross_source_conflicts(
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

pub(super) fn issue_requires_review(issues: &[LegacyMigrationIssue]) -> bool {
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

pub(super) fn validate_converted_documents(
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

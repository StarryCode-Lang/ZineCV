use super::*;

// Feature-only pause at the real SQLite publication boundary. The production
// build neither reads these variables nor writes markers.
#[cfg(feature = "test-hooks")]
pub(super) fn publication_test_hook(operation: &str, phase: &str) -> StorageResult<()> {
    if std::env::var(format!("ZINECV_TEST_{operation}_PAUSE_PHASE"))
        .ok()
        .as_deref()
        != Some(phase)
    {
        return Ok(());
    }
    let Some(marker) = std::env::var_os(format!("ZINECV_TEST_{operation}_PAUSE_MARKER")) else {
        return Ok(());
    };
    std::fs::write(marker, format!("{}:{phase}", std::process::id()))?;
    std::thread::sleep(std::time::Duration::from_secs(15));
    Ok(())
}

pub(super) fn default_branch_id(document_id: &str) -> String {
    format!("main:{document_id}")
}

pub(super) fn editing_context_source_name(source_kind: EditingContextSourceKind) -> &'static str {
    match source_kind {
        EditingContextSourceKind::Workspace => "workspace",
        EditingContextSourceKind::ImportedTemplate => "imported-template",
    }
}

pub(super) fn stable_editing_context_id(
    source_kind: EditingContextSourceKind,
    source_id: &str,
) -> String {
    if source_kind == EditingContextSourceKind::Workspace && source_id == "default" {
        return "workspace-default-context".into();
    }
    let source = format!("{}\0{source_id}", editing_context_source_name(source_kind));
    format!(
        "editing-context:{}:{}",
        editing_context_source_name(source_kind),
        Sha256::digest(source.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub(super) fn migration_content_hash<T: Serialize>(value: &T) -> StorageResult<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

pub(super) fn migration_deleted_branch_hash(legacy_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("deleted-origin\0{legacy_id}").as_bytes())
    )
}

pub(super) fn validate_legacy_version_graph(
    graph: &migration::LegacyMigrationVersionGraph,
) -> StorageResult<()> {
    if graph.source_id.trim().is_empty()
        || graph.source_id.len() > 80
        || graph.current_branch_id.trim().is_empty()
    {
        return Err(StorageError::Validation(
            "Invalid imported version graph identity".into(),
        ));
    }
    let mut branches = HashSet::new();
    for branch in &graph.branches {
        if branch.id.trim().is_empty()
            || branch.id.len() > 160
            || branch.id.chars().any(char::is_control)
            || branch.name.trim().is_empty()
            || branch.name.len() > 512
            || branch.name.chars().any(char::is_control)
            || branch.created_at.trim().is_empty()
            || branch.created_at.len() > 160
            || !branches.insert(branch.id.as_str())
        {
            return Err(StorageError::Validation(
                "Imported version graph has an invalid or duplicate branch".into(),
            ));
        }
    }
    if !branches.contains(graph.current_branch_id.as_str()) {
        return Err(StorageError::Validation(
            "Imported current branch is missing".into(),
        ));
    }
    let mut commits = HashMap::new();
    for commit in &graph.commits {
        if commit.id.trim().is_empty()
            || commit.id.len() > 160
            || commit.id.chars().any(char::is_control)
            || commit.branch_id.trim().is_empty()
            || commit.branch_id.len() > 160
            || commit.branch_id.chars().any(char::is_control)
            || commit.message.len() > 4096
            || commit.message.chars().any(char::is_control)
            || commit.created_at.trim().is_empty()
            || commit.created_at.len() > 160
            || commits.insert(commit.id.as_str(), commit).is_some()
        {
            return Err(StorageError::Validation(
                "Imported version graph has an invalid or duplicate commit".into(),
            ));
        }
        if commit.parent_id.as_deref() == Some(commit.id.as_str()) {
            return Err(StorageError::Validation(
                "Imported version commit cannot parent itself".into(),
            ));
        }
    }
    let mut indegree = commits
        .keys()
        .map(|commit_id| (*commit_id, 0_usize))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<&str, Vec<&str>>::new();
    for commit in &graph.commits {
        if let Some(parent) = commit.parent_id.as_deref() {
            if commits.contains_key(parent) {
                *indegree.get_mut(commit.id.as_str()).expect("commit index") += 1;
                children.entry(parent).or_default().push(commit.id.as_str());
            }
        }
    }
    let mut ready = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect::<Vec<_>>();
    let mut visited = 0_usize;
    while let Some(id) = ready.pop() {
        visited += 1;
        if let Some(next) = children.get(id) {
            for child in next {
                let count = indegree.get_mut(child).expect("child index");
                *count -= 1;
                if *count == 0 {
                    ready.push(child);
                }
            }
        }
    }
    if visited != commits.len() {
        return Err(StorageError::Validation(
            "Imported version graph contains a parent cycle".into(),
        ));
    }
    Ok(())
}

pub(super) fn unique_legacy_branch_name(
    original: &str,
    native_id: &str,
    existing_lowercase_names: &HashSet<String>,
) -> String {
    let token = native_id.strip_prefix("legacy-").unwrap_or(native_id);
    let short_id = token.chars().take(8).collect::<String>();
    for suffix_number in 1..=1000 {
        let suffix = if suffix_number == 1 {
            format!(" (imported {short_id})")
        } else {
            format!(" (imported {short_id}-{suffix_number})")
        };
        let available_chars = 120_usize.saturating_sub(suffix.chars().count());
        let prefix = original.chars().take(available_chars).collect::<String>();
        let candidate = format!("{}{}", prefix.trim_end(), suffix);
        if !existing_lowercase_names.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    format!("imported-{short_id}")
}

pub(super) fn import_source_name(kind: ImportSourceKind) -> &'static str {
    match kind {
        ImportSourceKind::Pdf => "pdf",
        ImportSourceKind::Docx => "docx",
        ImportSourceKind::Image => "image",
        ImportSourceKind::LegacyJson => "legacy_json",
    }
}

pub(super) fn parse_import_source(value: &str) -> StorageResult<ImportSourceKind> {
    match value {
        "pdf" => Ok(ImportSourceKind::Pdf),
        "docx" => Ok(ImportSourceKind::Docx),
        "image" => Ok(ImportSourceKind::Image),
        "legacy_json" => Ok(ImportSourceKind::LegacyJson),
        _ => Err(StorageError::Corrupt("Unknown import source kind".into())),
    }
}

pub(super) fn import_status_name(status: ImportDraftStatus) -> &'static str {
    match status {
        ImportDraftStatus::Queued => "queued",
        ImportDraftStatus::Running => "running",
        ImportDraftStatus::ReviewRequired => "review_required",
        ImportDraftStatus::Committed => "committed",
        ImportDraftStatus::Failed => "failed",
        ImportDraftStatus::Cancelled => "cancelled",
    }
}

pub(super) fn parse_import_status(value: &str) -> StorageResult<ImportDraftStatus> {
    match value {
        "queued" => Ok(ImportDraftStatus::Queued),
        "running" => Ok(ImportDraftStatus::Running),
        "review_required" => Ok(ImportDraftStatus::ReviewRequired),
        "committed" => Ok(ImportDraftStatus::Committed),
        "failed" => Ok(ImportDraftStatus::Failed),
        "cancelled" => Ok(ImportDraftStatus::Cancelled),
        _ => Err(StorageError::Corrupt("Unknown import draft status".into())),
    }
}

pub(super) fn valid_import_transition(from: ImportDraftStatus, to: ImportDraftStatus) -> bool {
    matches!(
        (from, to),
        (ImportDraftStatus::Queued, ImportDraftStatus::Running)
            | (ImportDraftStatus::Queued, ImportDraftStatus::Failed)
            | (ImportDraftStatus::Queued, ImportDraftStatus::Cancelled)
            | (
                ImportDraftStatus::Running,
                ImportDraftStatus::ReviewRequired
            )
            | (ImportDraftStatus::Running, ImportDraftStatus::Failed)
            | (ImportDraftStatus::Running, ImportDraftStatus::Cancelled)
            | (ImportDraftStatus::ReviewRequired, ImportDraftStatus::Failed)
            | (
                ImportDraftStatus::ReviewRequired,
                ImportDraftStatus::Cancelled
            )
    )
}

pub(super) fn validate_import_draft_header(
    id: &str,
    name: &str,
    source_hash: &str,
) -> StorageResult<()> {
    if id.trim().is_empty() || id.len() > 160 {
        return Err(StorageError::Validation("Invalid import draft ID".into()));
    }
    if name.trim().is_empty()
        || name.len() > 256
        || name.chars().any(|character| character.is_control())
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(StorageError::Validation(
            "Invalid import display name".into(),
        ));
    }
    if source_hash.len() != 64 || !source_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StorageError::Validation(
            "Invalid import source hash".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_import_review_payload(
    candidates: &[ImportCandidate],
    warnings: &[String],
    unsupported: &[String],
) -> StorageResult<()> {
    if candidates.len() > MAX_IMPORT_CANDIDATES || warnings.len() > 64 || unsupported.len() > 64 {
        return Err(StorageError::Validation(
            "Import review payload exceeds item limits".into(),
        ));
    }
    let mut ids = BTreeSet::new();
    for candidate in candidates {
        if candidate.id.trim().is_empty()
            || candidate.id.len() > 160
            || candidate.label.trim().is_empty()
            || candidate.label.len() > 160
            || !ids.insert(candidate.id.as_str())
            || candidate.evidence.excerpt.len() > 512
            || candidate
                .evidence
                .source_field
                .as_ref()
                .is_some_and(|source| source.len() > 128)
            || !matches!(
                candidate.evidence.confidence.as_str(),
                "high" | "medium" | "low" | "unknown"
            )
        {
            return Err(StorageError::Validation(
                "Import candidate metadata is invalid".into(),
            ));
        }
        match &candidate.value {
            ImportCandidateValue::BasicField { value, .. } => {
                if value.trim().is_empty() || value.len() > 2048 {
                    return Err(StorageError::Validation(
                        "Import field candidate must contain bounded non-empty text".into(),
                    ));
                }
            }
            ImportCandidateValue::SectionEntries { title, entries, .. } => {
                if title.trim().is_empty()
                    || title.len() > 160
                    || entries.is_empty()
                    || entries.len() > 100
                {
                    return Err(StorageError::Validation(
                        "Import section candidate is empty or too large".into(),
                    ));
                }
            }
            ImportCandidateValue::SummaryBody { title, body } => {
                if title.trim().is_empty() || title.len() > 160 || body.is_empty() {
                    return Err(StorageError::Validation(
                        "Import summary candidate is empty or invalid".into(),
                    ));
                }
            }
        }
    }
    if warnings
        .iter()
        .chain(unsupported)
        .any(|text| text.trim().is_empty() || text.len() > 512)
    {
        return Err(StorageError::Validation(
            "Import diagnostics are invalid".into(),
        ));
    }
    let review_size = serde_json::to_vec(&(candidates, warnings, unsupported))?.len();
    if review_size > MAX_IMPORT_REVIEW_BYTES {
        return Err(StorageError::Validation(
            "Import review payload exceeds the 2 MiB limit".into(),
        ));
    }
    Ok(())
}

pub(super) fn parse_import_preview_data_url(
    value: &str,
) -> StorageResult<Option<(String, Vec<u8>)>> {
    let Some((mime, encoded)) = value
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
    else {
        return Err(StorageError::Validation(
            "Import preview must be a base64 image".into(),
        ));
    };
    if !matches!(mime, "image/png" | "image/jpeg" | "image/webp")
        || encoded.len() > MAX_IMPORT_PREVIEW_BYTES * 2
    {
        return Err(StorageError::Validation(
            "Unsupported or oversized import preview".into(),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| StorageError::Validation("Import preview is not valid base64".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORT_PREVIEW_BYTES {
        return Err(StorageError::Validation(
            "Import preview exceeds the 8 MiB limit".into(),
        ));
    }
    Ok(Some((mime.into(), bytes)))
}

pub(super) fn read_import_draft_tx(
    connection: &Connection,
    draft_id: &str,
) -> StorageResult<Option<ImportDraft>> {
    let row = connection
        .query_row(
            "SELECT id, source_kind, display_name, source_hash, status, preview_asset_id,
                    candidates_json, warnings_json, unsupported_features_json, created_at
             FROM import_drafts WHERE id = ?1",
            params![draft_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(
            id,
            source_kind,
            display_name,
            source_hash,
            status,
            preview_asset_id,
            candidates,
            warnings,
            unsupported_features,
            created_at,
        )| {
            Ok(ImportDraft {
                id,
                source_kind: parse_import_source(&source_kind)?,
                display_name,
                source_hash,
                created_at,
                status: parse_import_status(&status)?,
                preview_asset_id,
                candidates: serde_json::from_str(&candidates)?,
                warnings: serde_json::from_str(&warnings)?,
                unsupported_features: serde_json::from_str(&unsupported_features)?,
            })
        },
    )
    .transpose()
}

pub(super) fn validate_import_command(
    request: &ApplyImportRequest,
    actor: &str,
) -> StorageResult<()> {
    if request.command_id.trim().is_empty()
        || request.command_id.len() > 160
        || request.draft_id.trim().is_empty()
        || request.draft_id.len() > 160
        || actor.trim().is_empty()
        || request.accepted_candidate_ids.is_empty()
        || request.accepted_candidate_ids.len() > MAX_IMPORT_CANDIDATES
    {
        return Err(StorageError::Validation(
            "Invalid import apply request".into(),
        ));
    }
    Ok(())
}

pub(super) fn apply_import_candidate(
    document: &mut ResumeDocument,
    draft_id: &str,
    candidate: &ImportCandidate,
) -> StorageResult<()> {
    match &candidate.value {
        ImportCandidateValue::BasicField { field, value } => {
            let value = value.trim().to_string();
            match field {
                ImportBasicField::Name => document.basic.name = value,
                ImportBasicField::Phone => document.basic.phone = value,
                ImportBasicField::Email => document.basic.email = value,
                ImportBasicField::City => document.basic.city = value,
                ImportBasicField::Wechat => document.basic.wechat = value,
                ImportBasicField::Birth => document.basic.birth = value,
                ImportBasicField::Website => document.basic.website = Some(value),
                ImportBasicField::Linkedin => document.basic.linkedin = Some(value),
                ImportBasicField::Gender => document.basic.gender = Some(value),
                ImportBasicField::Height => document.basic.height = Some(value),
                ImportBasicField::Weight => document.basic.weight = Some(value),
                ImportBasicField::Ethnicity => document.basic.ethnicity = Some(value),
                ImportBasicField::Birthplace => document.basic.birthplace = Some(value),
                ImportBasicField::PoliticalStatus => document.basic.political_status = Some(value),
                ImportBasicField::MaritalStatus => document.basic.marital_status = Some(value),
                ImportBasicField::Zodiac => document.basic.zodiac = Some(value),
                ImportBasicField::Mbti => document.basic.mbti = Some(value),
            }
        }
        ImportCandidateValue::SectionEntries {
            kind,
            title,
            entries,
        } => {
            let mut ids = BTreeSet::new();
            for entry in entries {
                if entry.id.trim().is_empty()
                    || entry.id.len() > 160
                    || !ids.insert(entry.id.as_str())
                    || document.sections.iter().any(|section| match section {
                        Section::Entry(section) => {
                            section.entries.iter().any(|item| item.id == entry.id)
                        }
                        Section::Summary(_) => false,
                    })
                {
                    return Err(StorageError::Validation(
                        "Imported entries contain invalid or duplicate IDs".into(),
                    ));
                }
            }
            if let Some(Section::Entry(section)) = document.sections.iter_mut().find(
                |section| matches!(section, Section::Entry(existing) if existing.kind == *kind),
            ) {
                section.entries.extend(entries.clone());
            } else {
                document.sections.push(Section::Entry(EntrySection {
                    id: format!("import:{draft_id}:{}", candidate.id),
                    kind: *kind,
                    title: title.trim().to_string(),
                    visible: true,
                    entries: entries.clone(),
                }));
            }
        }
        ImportCandidateValue::SummaryBody { title, body } => {
            if let Some(Section::Summary(section)) = document
                .sections
                .iter_mut()
                .find(|section| matches!(section, Section::Summary(_)))
            {
                section.body.extend(body.clone());
            } else {
                document.sections.push(Section::Summary(SummarySection {
                    id: format!("import:{draft_id}:{}", candidate.id),
                    kind: "summary".into(),
                    title: title.trim().to_string(),
                    visible: true,
                    body: body.clone(),
                }));
            }
        }
    }
    Ok(())
}

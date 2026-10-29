use super::*;
use zinecv_contracts::ImportCandidateCorrection;

pub(super) fn write_import_source_text(
    connection: &Connection,
    draft_id: &str,
    text: &str,
    candidates: &[ImportCandidate],
    warnings: &[String],
    unsupported: &[String],
) -> StorageResult<()> {
    if serde_json::to_vec(&(candidates, warnings, unsupported, text))?.len()
        > MAX_IMPORT_REVIEW_BYTES
    {
        return Err(StorageError::Validation(
            "Import source text and candidates exceed the 2 MiB review budget".into(),
        ));
    }
    let bytes = text.as_bytes();
    let hash = format!("{:x}", Sha256::digest(bytes));
    connection.execute(
        "INSERT OR IGNORE INTO resources(hash, mime, bytes, size, license_ref)
         VALUES (?1, 'text/plain; charset=utf-8', ?2, ?3, NULL)",
        params![hash, bytes, bytes.len() as i64],
    )?;
    connection.execute(
        "INSERT INTO resource_refs(resource_hash, owner_kind, owner_id)
         VALUES (?1, 'import-source-text', ?2)",
        params![hash, draft_id],
    )?;
    Ok(())
}

pub(super) fn read_import_source_text(
    connection: &Connection,
    draft_id: &str,
) -> StorageResult<Option<String>> {
    let row: Option<(String, Vec<u8>)> = connection.query_row(
        "SELECT r.hash, r.bytes FROM resources r JOIN resource_refs ref ON ref.resource_hash = r.hash
         WHERE ref.owner_kind = 'import-source-text' AND ref.owner_id = ?1",
        [draft_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    row.map(|(hash, bytes)| {
        if bytes.len() > MAX_IMPORT_REVIEW_BYTES || format!("{:x}", Sha256::digest(&bytes)) != hash
        {
            return Err(StorageError::HashMismatch);
        }
        String::from_utf8(bytes)
            .map_err(|_| StorageError::Corrupt("Import source is not UTF-8".into()))
    })
    .transpose()
}

pub(super) fn reviewed_import_candidates(
    draft: &ImportDraft,
    accepted: &BTreeSet<&str>,
    corrections: &[ImportCandidateCorrection],
) -> StorageResult<Vec<ImportCandidate>> {
    if corrections.len() > MAX_IMPORT_CANDIDATES
        || serde_json::to_vec(corrections)?.len() > MAX_IMPORT_REVIEW_BYTES
    {
        return Err(StorageError::Validation(
            "Import corrections exceed the review budget".into(),
        ));
    }
    let mut edits = std::collections::BTreeMap::new();
    for correction in corrections {
        if !accepted.contains(correction.candidate_id.as_str())
            || !draft
                .candidates
                .iter()
                .any(|candidate| candidate.id == correction.candidate_id)
            || edits
                .insert(correction.candidate_id.as_str(), &correction.value)
                .is_some()
        {
            return Err(StorageError::Validation(
                "Corrections must name unique accepted source candidates".into(),
            ));
        }
    }
    draft
        .candidates
        .iter()
        .filter(|candidate| accepted.contains(candidate.id.as_str()))
        .map(|original| {
            let Some(value) = edits.get(original.id.as_str()) else {
                return Ok(original.clone());
            };
            let compatible = match (&original.value, *value) {
                (
                    ImportCandidateValue::BasicField { field: before, .. },
                    ImportCandidateValue::BasicField { field: after, .. },
                ) => before == after,
                (
                    ImportCandidateValue::SectionEntries { .. },
                    ImportCandidateValue::SectionEntries { .. },
                ) => true,
                (
                    ImportCandidateValue::SummaryBody { .. },
                    ImportCandidateValue::SummaryBody { .. },
                ) => true,
                _ => false,
            };
            if !compatible {
                return Err(StorageError::Permission(
                    "Import correction cannot change its source candidate type or basic field"
                        .into(),
                ));
            }
            let mut corrected = original.clone();
            corrected.value = (*value).clone();
            if let ImportCandidateValue::SectionEntries { entries, .. } = &mut corrected.value {
                for (index, entry) in entries.iter_mut().enumerate() {
                    // The renderer may split or merge reviewed rows, but never chooses
                    // identities that could collide with or overwrite another document.
                    entry.id = format!(
                        "import-entry:{:x}",
                        Sha256::digest(format!("{}\0{}\0{index}", draft.id, original.id))
                    );
                }
            }
            validate_import_review_payload(std::slice::from_ref(&corrected), &[], &[])?;
            Ok(corrected)
        })
        .collect()
}

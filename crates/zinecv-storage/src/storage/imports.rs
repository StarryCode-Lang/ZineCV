use super::*;

impl Store {
    pub fn pending_import_count(&self, document_id: &str) -> StorageResult<u32> {
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM import_drafts WHERE target_document_id = ?1
             AND status IN ('queued', 'running', 'review_required')",
            [document_id],
            |row| row.get(0),
        )?;
        u32::try_from(count)
            .map_err(|_| StorageError::Corrupt("Pending import count is out of range".into()))
    }

    pub fn create_import_draft(
        &mut self,
        request: &zinecv_contracts::CreateImportDraftRequest,
    ) -> StorageResult<ImportDraft> {
        validate_import_draft_header(
            &request.draft_id,
            &request.display_name,
            &request.source_hash,
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        // M2：草稿持久绑定目标文档；绑定列写入后不可变（transition 不改它）。
        if request.target_document_id.trim().is_empty() {
            return Err(StorageError::Validation(
                "Import draft target document is required".into(),
            ));
        }
        let target_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
            params![request.target_document_id],
            |row| row.get(0),
        )?;
        if !target_exists {
            return Err(StorageError::NotFound("Document not found".into()));
        }
        transaction.execute(
            "INSERT INTO import_drafts(id, source_kind, display_name, source_hash, status, target_document_id)
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5)",
            params![
                request.draft_id,
                import_source_name(request.source_kind),
                request.display_name,
                request.source_hash.to_ascii_lowercase(),
                request.target_document_id
            ],
        )?;
        let draft = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        transaction.commit()?;
        Ok(draft)
    }

    pub fn read_import_draft(&self, draft_id: &str) -> StorageResult<Option<ImportDraft>> {
        read_import_draft_tx(&self.connection, draft_id)
    }

    pub fn transition_import_draft(
        &mut self,
        request: &TransitionImportDraftRequest,
    ) -> StorageResult<ImportDraft> {
        if request.draft_id.trim().is_empty() || request.draft_id.len() > 160 {
            return Err(StorageError::Validation("Invalid import draft ID".into()));
        }
        if !valid_import_transition(request.expected_status, request.next_status) {
            return Err(StorageError::Conflict(
                "Import draft status transition is not allowed".into(),
            ));
        }
        let candidates = request.candidates.as_deref().unwrap_or_default();
        let warnings = request.warnings.as_deref().unwrap_or_default();
        let unsupported = request.unsupported_features.as_deref().unwrap_or_default();
        validate_import_review_payload(candidates, warnings, unsupported)?;
        if request.next_status == ImportDraftStatus::ReviewRequired && request.candidates.is_none()
        {
            return Err(StorageError::Validation(
                "Review state requires parsed candidates".into(),
            ));
        }
        let preview = request
            .preview_data_url
            .as_deref()
            .map(parse_import_preview_data_url)
            .transpose()?
            .flatten();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        if existing.status != request.expected_status {
            return Err(StorageError::Conflict(
                "Import draft changed before the requested transition".into(),
            ));
        }
        if let Some(text) = request.extracted_text.as_deref() {
            if request.next_status != ImportDraftStatus::ReviewRequired {
                return Err(StorageError::Validation(
                    "Source text can only be set when entering review".into(),
                ));
            }
            super::import_review::write_import_source_text(
                &transaction,
                &request.draft_id,
                text,
                candidates,
                warnings,
                unsupported,
            )?;
        }
        let mut preview_asset_id = existing.preview_asset_id.clone();
        if let Some((mime, bytes)) = preview {
            let hash = format!("{:x}", Sha256::digest(&bytes));
            transaction.execute(
                "INSERT OR IGNORE INTO resources(hash, mime, bytes, size, license_ref)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![hash, mime, bytes, bytes.len() as i64],
            )?;
            transaction.execute(
                "DELETE FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
                [&request.draft_id],
            )?;
            transaction.execute(
                "INSERT OR IGNORE INTO resource_refs(resource_hash, owner_kind, owner_id)
                 VALUES (?1, 'pending-import', ?2)",
                params![hash, request.draft_id],
            )?;
            preview_asset_id = Some(hash);
        }
        let (candidate_json, warnings_json, unsupported_json) =
            if request.next_status == ImportDraftStatus::ReviewRequired {
                (
                    serde_json::to_string(candidates)?,
                    serde_json::to_string(warnings)?,
                    serde_json::to_string(unsupported)?,
                )
            } else {
                (
                    serde_json::to_string(&existing.candidates)?,
                    serde_json::to_string(&existing.warnings)?,
                    serde_json::to_string(&existing.unsupported_features)?,
                )
            };
        if matches!(
            request.next_status,
            ImportDraftStatus::Failed | ImportDraftStatus::Cancelled
        ) {
            transaction.execute(
                "DELETE FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
                [&request.draft_id],
            )?;
            preview_asset_id = None;
        }
        transaction.execute(
            "UPDATE import_drafts SET status = ?2, preview_asset_id = ?3,
                candidates_json = ?4, warnings_json = ?5, unsupported_features_json = ?6,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND status = ?7",
            params![
                request.draft_id,
                import_status_name(request.next_status),
                preview_asset_id,
                candidate_json,
                warnings_json,
                unsupported_json,
                import_status_name(request.expected_status)
            ],
        )?;
        let draft = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        transaction.commit()?;
        Ok(draft)
    }

    pub fn apply_import(
        &mut self,
        actor: &str,
        request: &ApplyImportRequest,
    ) -> StorageResult<CommandResult> {
        validate_import_command(request, actor)?;
        let request_hash = canonical_hash(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some((stored_actor, stored_hash, result_json)) = transaction
            .query_row(
                "SELECT actor, request_hash, result_json FROM command_receipts WHERE command_id = ?1",
                params![request.command_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if stored_actor == actor && stored_hash == request_hash {
                let result = serde_json::from_str(&result_json)?;
                transaction.commit()?;
                return Ok(result);
            }
            return Err(StorageError::Conflict(
                "Import command ID was already used for another request".into(),
            ));
        }

        let import = read_import_draft_tx(&transaction, &request.draft_id)?
            .ok_or(StorageError::MissingDraft)?;
        if import.status != ImportDraftStatus::ReviewRequired {
            return Err(StorageError::Conflict(
                "Import draft is not awaiting review".into(),
            ));
        }
        // M2：确认必须命中草稿持久绑定的目标文档（双校验的存储侧一半；
        // 宿主侧校验 active 见 commands/imports.rs）。
        let bound_target: Option<String> = transaction
            .query_row(
                "SELECT target_document_id FROM import_drafts WHERE id = ?1",
                params![request.draft_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let request_target = request.cursor.document_id.as_str();
        if let Some(bound) = bound_target {
            if bound != request_target {
                return Err(StorageError::Conflict(
                    "Import draft is bound to a different document".into(),
                ));
            }
        }
        let mut accepted = BTreeSet::new();
        for id in &request.accepted_candidate_ids {
            if !accepted.insert(id.as_str()) {
                return Err(StorageError::Validation(
                    "Accepted import candidates contain duplicate IDs".into(),
                ));
            }
        }
        if accepted.is_empty() {
            return Err(StorageError::Validation(
                "Select at least one import candidate".into(),
            ));
        }
        let candidate_ids: BTreeSet<&str> = import
            .candidates
            .iter()
            .map(|candidate| candidate.id.as_str())
            .collect();
        if accepted.iter().any(|id| !candidate_ids.contains(id)) {
            return Err(StorageError::Validation(
                "Accepted import candidate was not found".into(),
            ));
        }

        let (branch_id, context_id, revision, head_id): (String, String, i64, Option<String>) =
            transaction
                .query_row(
                    "SELECT d.current_branch_id, d.active_context_id, d.revision, b.head_commit_id
                     FROM documents d JOIN branches b ON b.id = d.current_branch_id AND b.document_id = d.id
                     WHERE d.id = ?1",
                    params![request.cursor.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        if request.cursor.branch_id != branch_id
            || request.cursor.context_id != context_id
            || request.cursor.revision != revision.to_string()
            || request.cursor.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let (draft_revision, document_json, stored_hash): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, document_json, hash FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![request.cursor.document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(StorageError::MissingDraft)?;
        let mut document: ResumeDocument = serde_json::from_str(&document_json)?;
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        if draft_revision != revision
            || document.document_id != request.cursor.document_id
            || canonical_hash(&document)? != stored_hash
        {
            return Err(StorageError::Conflict(
                "Current durable document does not match its authority cursor".into(),
            ));
        }
        let reviewed = super::import_review::reviewed_import_candidates(
            &import,
            &accepted,
            request.corrections.as_deref().unwrap_or_default(),
        )?;
        for candidate in &reviewed {
            apply_import_candidate(&mut document, &import.id, candidate)?;
        }
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Document revision overflow".into()))?;
        let document_json = serde_json::to_string(&document)?;
        let document_hash = canonical_hash(&document)?;
        let changed = transaction.execute(
            "UPDATE drafts SET revision = ?4, document_json = ?5, hash = ?6,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3 AND revision = ?7",
            params![
                request.cursor.document_id,
                context_id,
                branch_id,
                next_revision,
                document_json,
                document_hash,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale document draft".into()));
        }
        Self::sync_draft_resource_owner(
            &transaction,
            &request.cursor.document_id,
            &context_id,
            &branch_id,
            &document_json,
        )?;
        let changed_document = transaction.execute(
            "UPDATE documents SET title = ?2, revision = ?3 WHERE id = ?1 AND revision = ?4",
            params![
                request.cursor.document_id,
                document.title,
                next_revision,
                revision
            ],
        )?;
        if changed_document != 1 {
            return Err(StorageError::Conflict("Stale document revision".into()));
        }
        let result = CommandResult {
            command_id: request.command_id.clone(),
            cursor: AuthorityCursor {
                document_id: request.cursor.document_id.clone(),
                context_id,
                revision: next_revision.to_string(),
                branch_id,
                head_id,
            },
            durable: true,
            snapshot_hash: document_hash,
            changed_ids: accepted.iter().map(|id| (*id).to_string()).collect(),
            document,
        };
        transaction.execute(
            "INSERT INTO command_receipts(command_id, document_id, actor, request_hash, result_json, result_hash, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                request.command_id,
                result.cursor.document_id,
                actor,
                request_hash,
                serde_json::to_string(&result)?,
                canonical_hash(&result)?,
                next_revision
            ],
        )?;
        transaction.execute(
            "UPDATE import_drafts SET status = 'committed', preview_asset_id = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?1 AND status = 'review_required'",
            params![request.draft_id],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'pending-import' AND owner_id = ?1",
            params![request.draft_id],
        )?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("IMPORT", "before-commit")?;
        transaction.commit()?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("IMPORT", "after-commit")?;
        Ok(result)
    }
}

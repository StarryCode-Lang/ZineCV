use super::*;

impl Store {
    pub fn load_active_document(
        &self,
        document_id: &str,
    ) -> StorageResult<Option<(AuthorityCursor, ResumeDocument)>> {
        let context_id: Option<String> = self
            .connection
            .query_row(
                "SELECT active_context_id FROM documents WHERE id = ?1",
                params![document_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(context_id) = context_id else {
            return Ok(None);
        };
        let cursor = self
            .load_cursor(document_id, &context_id)?
            .ok_or_else(|| StorageError::Corrupt("Active document cursor is missing".into()))?;
        let (_, document) = self
            .load_current(document_id, &context_id)?
            .ok_or(StorageError::MissingDraft)?;
        Ok(Some((cursor, document)))
    }

    pub fn validate_active_cursor(&self, expected: &AuthorityCursor) -> StorageResult<()> {
        let actual = self
            .load_cursor(&expected.document_id, &expected.context_id)?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        if actual != *expected {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let registered: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM editing_contexts WHERE document_id = ?1 AND id = ?2)",
            params![expected.document_id, expected.context_id],
            |row| row.get(0),
        )?;
        if !registered {
            return Err(StorageError::NotFound(
                "Editing context was not found".into(),
            ));
        }
        Ok(())
    }

    pub fn switch_editing_context(
        &mut self,
        expected: &AuthorityCursor,
        source_kind: EditingContextSourceKind,
        source_id: &str,
        initial_document: Option<&ResumeDocument>,
    ) -> StorageResult<SwitchEditingContextResult> {
        let source_id = source_id.trim();
        if source_id.is_empty() || source_id.len() > 512 {
            return Err(StorageError::Validation(
                "Editing context source ID is invalid".into(),
            ));
        }
        if source_kind == EditingContextSourceKind::Workspace && source_id != "default" {
            return Err(StorageError::Validation(
                "Workspace source ID must be default".into(),
            ));
        }
        if let Some(document) = initial_document {
            if document.document_id != expected.document_id {
                return Err(StorageError::Validation(
                    "Initial draft belongs to another document".into(),
                ));
            }
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        }

        let source_kind_name = editing_context_source_name(source_kind);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (branch_id, active_context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != active_context_id
            || expected.revision != revision.to_string()
            || expected.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let active_context_registered: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM editing_contexts WHERE document_id = ?1 AND id = ?2)",
            params![expected.document_id, active_context_id],
            |row| row.get(0),
        )?;
        if !active_context_registered {
            return Err(StorageError::NotFound(
                "Active editing context was not found".into(),
            ));
        }

        let mut source_rows = transaction.prepare(
            "SELECT id FROM editing_contexts
             WHERE document_id = ?1 AND source_kind = ?2 AND source_id = ?3",
        )?;
        let source_contexts = source_rows
            .query_map(
                params![expected.document_id, source_kind_name, source_id],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(source_rows);
        if source_contexts.len() > 1 {
            return Err(StorageError::Corrupt(
                "Editing context source maps to multiple IDs".into(),
            ));
        }
        let created = source_contexts.is_empty();
        let target_context_id = source_contexts
            .first()
            .cloned()
            .unwrap_or_else(|| stable_editing_context_id(source_kind, source_id));
        if created {
            let collision: Option<(String, String)> = transaction
                .query_row(
                    "SELECT source_kind, source_id FROM editing_contexts
                     WHERE document_id = ?1 AND id = ?2",
                    params![expected.document_id, target_context_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if collision.is_some() {
                return Err(StorageError::Corrupt(
                    "Stable editing context ID is already assigned".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    target_context_id,
                    expected.document_id,
                    source_kind_name,
                    source_id
                ],
            )?;
        }

        let target_draft: Option<(String, String)> = transaction
            .query_row(
                "SELECT document_json, hash FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, target_context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (target_document, target_json, target_hash) =
            if let Some((json, stored_hash)) = target_draft {
                let document: ResumeDocument = serde_json::from_str(&json)?;
                if document.document_id != expected.document_id
                    || canonical_hash(&document)? != stored_hash
                {
                    return Err(StorageError::HashMismatch);
                }
                (document, Some(json), Some(stored_hash))
            } else if created {
                let document = initial_document.ok_or(StorageError::MissingDraft)?.clone();
                let json = serde_json::to_string(&document)?;
                let hash = canonical_hash(&document)?;
                (document, Some(json), Some(hash))
            } else {
                let head_id = head_id.as_ref().ok_or(StorageError::MissingDraft)?;
                let (json, stored_hash): (String, String) = transaction.query_row(
                    "SELECT snapshots.document_json, snapshots.hash FROM commits
                     JOIN snapshots ON snapshots.id = commits.snapshot_id
                     WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![head_id, expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let document: ResumeDocument = serde_json::from_str(&json)?;
                if document.document_id != expected.document_id
                    || canonical_hash(&document)? != stored_hash
                {
                    return Err(StorageError::HashMismatch);
                }
                (document, None, None)
            };

        if target_context_id == active_context_id {
            transaction.commit()?;
            return Ok(SwitchEditingContextResult {
                cursor: expected.clone(),
                document: target_document,
                created: false,
            });
        }

        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Corrupt("Document revision overflow".into()))?;
        if let (Some(json), Some(hash)) = (target_json, target_hash) {
            transaction.execute(
                "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
                 ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
                   revision = excluded.revision,
                   updated_at = CURRENT_TIMESTAMP",
                params![expected.document_id, target_context_id, branch_id, next_revision, json, hash],
            )?;
            Self::sync_draft_resource_owner(
                &transaction,
                &expected.document_id,
                &target_context_id,
                &branch_id,
                &json,
            )?;
        }
        let changed = transaction.execute(
            "UPDATE documents SET active_context_id = ?1, title = ?2, revision = ?3
             WHERE id = ?4 AND current_branch_id = ?5 AND active_context_id = ?6 AND revision = ?7",
            params![
                target_context_id,
                target_document.title,
                next_revision,
                expected.document_id,
                branch_id,
                active_context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        let cursor = self
            .load_cursor(&expected.document_id, &target_context_id)?
            .ok_or_else(|| StorageError::Corrupt("Switched context cursor is missing".into()))?;
        Ok(SwitchEditingContextResult {
            cursor,
            document: target_document,
            created,
        })
    }

    pub fn initialize_document(
        &mut self,
        document: &ResumeDocument,
        context_id: &str,
    ) -> StorageResult<bool> {
        if context_id.trim().is_empty() {
            return Err(StorageError::Validation(
                "Editing context ID is required".into(),
            ));
        }
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: Option<i64> = transaction
            .query_row(
                "SELECT 1 FROM documents WHERE id = ?1",
                params![document.document_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Ok(false);
        }
        let branch_id = default_branch_id(&document.document_id);
        let json = serde_json::to_string(document)?;
        let hash = canonical_hash(document)?;
        transaction.execute(
            "INSERT INTO documents(id, title, current_branch_id, active_context_id, revision)
             VALUES (?1, ?2, ?3, ?4, 0)",
            params![document.document_id, document.title, branch_id, context_id],
        )?;
        transaction.execute(
            "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
             VALUES (?1, ?2, 'workspace', 'default')",
            params![context_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT INTO branches(id, document_id, name) VALUES (?1, ?2, 'main')",
            params![branch_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
             VALUES (?1, ?2, ?3, 0, ?4, ?5)",
            params![document.document_id, context_id, branch_id, json, hash],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &document.document_id,
            context_id,
            &branch_id,
            &json,
        )?;
        let snapshot_id = format!("snap-{hash}");
        let commit_id = format!("commit:{}:initial", document.document_id);
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, hash],
        )?;
        Self::sync_snapshot_resource_owner(&transaction, &snapshot_id, &json)?;
        transaction.execute(
            "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
             VALUES (?1, ?2, ?3, ?4, '初始版本')",
            params![commit_id, document.document_id, branch_id, snapshot_id],
        )?;
        transaction.execute(
            "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, NULL)",
            params![commit_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
            params![commit_id, branch_id, document.document_id],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn save_draft(
        &self,
        document: &ResumeDocument,
        context_id: &str,
        revision: u64,
    ) -> StorageResult<()> {
        let json = serde_json::to_string(document)?;
        let hash = canonical_hash(document)?;
        let transaction = self.connection.unchecked_transaction()?;
        let branch_id: Option<String> = transaction
            .query_row(
                "SELECT current_branch_id FROM documents WHERE id = ?1",
                params![document.document_id],
                |row| row.get(0),
            )
            .optional()?;
        let branch_id = branch_id.unwrap_or_else(|| default_branch_id(&document.document_id));
        transaction.execute(
            "INSERT INTO documents(id, title, current_branch_id, active_context_id, revision) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               active_context_id = excluded.active_context_id,
               revision = excluded.revision",
            params![document.document_id, document.title, branch_id, context_id, revision as i64],
        )?;
        transaction.execute(
            "INSERT INTO editing_contexts(id, document_id, source_kind, source_id) VALUES (?1, ?2, 'workspace', 'default')
             ON CONFLICT(document_id, id) DO NOTHING",
            params![context_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO branches(id, document_id, name) VALUES (?1, ?2, 'main')",
            params![branch_id, document.document_id],
        )?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
               revision = excluded.revision,
               document_json = excluded.document_json,
               hash = excluded.hash,
               updated_at = CURRENT_TIMESTAMP",
            params![document.document_id, context_id, branch_id, revision as i64, json, hash],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &document.document_id,
            context_id,
            &branch_id,
            &json,
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
            [&document.document_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn apply_command(
        &mut self,
        actor: &str,
        envelope: zinecv_contracts::CommandEnvelope,
    ) -> StorageResult<zinecv_contracts::CommandResult> {
        use zinecv_domain::DocumentContext;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT actor, request_hash, result_json FROM command_receipts WHERE command_id = ?1",
                params![envelope.command_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_actor, stored_hash, result_json)) = existing {
            let request_hash = canonical_hash(&envelope)?;
            if stored_actor == actor && stored_hash == request_hash {
                return Ok(serde_json::from_str(&result_json)?);
            }
            return Err(StorageError::Conflict(
                "Command ID was reused with a different request".into(),
            ));
        }

        let authority = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![envelope.document_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let (branch_id, active_context_id, stored_revision) = authority;
        let stored_revision = stored_revision as u64;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, envelope.document_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        if envelope.context_id != active_context_id
            || envelope.expected_branch_id != branch_id
            || envelope.expected_head_id != head_id
            || envelope.expected_revision != stored_revision.to_string()
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }

        let draft_json: Option<String> = transaction
            .query_row(
                "SELECT document_json FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![envelope.document_id, active_context_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        let document = if let Some(json) = draft_json {
            serde_json::from_str(&json)?
        } else if let Some(head_id) = head_id.as_ref() {
            let json: String = transaction.query_row(
                "SELECT snapshots.document_json FROM snapshots JOIN commits ON commits.snapshot_id = snapshots.id WHERE commits.id = ?1",
                params![head_id],
                |row| row.get(0),
            )?;
            serde_json::from_str(&json)?
        } else {
            return Err(StorageError::NotFound("No draft or head snapshot".into()));
        };

        let mut context =
            DocumentContext::with_authority(document, stored_revision, branch_id, head_id)
                .map_err(StorageError::Domain)?;
        let result = context
            .apply_command(actor, &active_context_id, envelope.clone())
            .map_err(StorageError::Domain)?;

        let json = serde_json::to_string(&result.document)?;
        let document_hash = canonical_hash(&result.document)?;
        let updated = transaction.execute(
            "UPDATE documents SET title = ?1, active_context_id = ?2, revision = ?3
             WHERE id = ?4 AND revision = ?5 AND current_branch_id = ?6 AND active_context_id = ?7",
            params![
                result.document.title,
                active_context_id,
                result.cursor.revision,
                envelope.document_id,
                stored_revision as i64,
                envelope.expected_branch_id,
                envelope.context_id,
            ],
        )?;
        if updated != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
               revision = excluded.revision,
               document_json = excluded.document_json,
               hash = excluded.hash,
               updated_at = CURRENT_TIMESTAMP",
            params![
                envelope.document_id,
                active_context_id,
                result.cursor.branch_id,
                result.cursor.revision,
                json,
                document_hash
            ],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &envelope.document_id,
            &active_context_id,
            &result.cursor.branch_id,
            &json,
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
            [&envelope.document_id],
        )?;
        transaction.execute(
            "INSERT INTO command_receipts(command_id, document_id, actor, request_hash, result_json, result_hash, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                envelope.command_id,
                envelope.document_id,
                actor,
                canonical_hash(&envelope)?,
                serde_json::to_string(&result)?,
                canonical_hash(&result)?,
                result.cursor.revision
            ],
        )?;
        transaction.commit()?;
        Ok(result)
    }
}

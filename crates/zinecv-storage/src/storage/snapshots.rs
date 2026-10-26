use super::*;

impl Store {
    pub fn load_current(
        &self,
        document_id: &str,
        context_id: &str,
    ) -> StorageResult<Option<(u64, ResumeDocument)>> {
        let authority: Option<(String, String, i64)> = self
            .connection
            .query_row(
                "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((active_context_id, branch_id, stored_revision)) = authority else {
            return Ok(None);
        };
        if context_id != active_context_id {
            return Err(StorageError::Conflict("Inactive editing context".into()));
        }
        let draft: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT revision, document_json FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((draft_revision, json)) = draft {
            if draft_revision != stored_revision {
                return Err(StorageError::Conflict(
                    "Draft revision does not match document authority".into(),
                ));
            }
            return Ok(Some((
                draft_revision as u64,
                serde_json::from_str::<ResumeDocument>(&json)?,
            )));
        }

        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT snapshots.document_json
                 FROM documents
                 JOIN branches ON branches.id = documents.current_branch_id
                 JOIN commits ON commits.id = branches.head_commit_id
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE documents.id = ?1 AND branches.document_id = ?1 AND branches.id = ?2",
                params![document_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| {
            Ok((
                stored_revision as u64,
                serde_json::from_str::<ResumeDocument>(&json)?,
            ))
        })
        .transpose()
    }

    pub fn load_cursor(
        &self,
        document_id: &str,
        context_id: &str,
    ) -> StorageResult<Option<AuthorityCursor>> {
        let authority: Option<(String, String, i64)> = self
            .connection
            .query_row(
                "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((active_context_id, branch_id, revision)) = authority else {
            return Ok(None);
        };
        if active_context_id != context_id {
            return Err(StorageError::Conflict("Inactive editing context".into()));
        }
        let head_id: Option<Option<String>> = self
            .connection
            .query_row(
                "SELECT head_commit_id FROM branches WHERE document_id = ?1 AND id = ?2",
                params![document_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        let head_id =
            head_id.ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        let revision = u64::try_from(revision)
            .map_err(|_| StorageError::Corrupt("Document revision is negative".into()))?;
        Ok(Some(AuthorityCursor {
            document_id: document_id.into(),
            context_id: context_id.into(),
            revision: revision.to_string(),
            branch_id,
            head_id,
        }))
    }

    pub fn load_draft(
        &self,
        document_id: &str,
        context_id: &str,
    ) -> StorageResult<Option<(u64, ResumeDocument)>> {
        let row = self
            .connection
            .query_row(
                "SELECT drafts.revision, drafts.document_json FROM drafts
                 JOIN documents ON documents.id = drafts.document_id
                 WHERE drafts.document_id = ?1 AND drafts.context_id = ?2
                   AND drafts.branch_id = documents.current_branch_id",
                params![document_id, context_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        row.map(|(revision, json)| Ok((revision as u64, serde_json::from_str(&json)?)))
            .transpose()
    }

    /// Freeze the document and its avatar in one SQLite read snapshot.
    pub fn freeze_export(&self, expected: &AuthorityCursor) -> StorageResult<ExportSnapshot> {
        let transaction = self.connection.unchecked_transaction()?;
        let actual = self
            .load_cursor(&expected.document_id, &expected.context_id)?
            .ok_or_else(|| StorageError::NotFound("Export document is missing".into()))?;
        if &actual != expected {
            return Err(StorageError::Conflict(
                "Document changed before export".into(),
            ));
        }
        let (_, document) = self
            .load_current(&expected.document_id, &expected.context_id)?
            .ok_or(StorageError::MissingDraft)?;
        let avatar = match document.basic.avatar_asset_id.as_deref() {
            Some(hash) => Some(self.read_resource_bytes(hash)?.ok_or_else(|| {
                StorageError::NotFound("Export avatar resource is missing".into())
            })?),
            None => None,
        };
        transaction.commit()?;
        Ok((document, avatar))
    }

    pub fn commit_draft(
        &mut self,
        expected: &AuthorityCursor,
        message: &str,
    ) -> StorageResult<AuthorityCursor> {
        let message = message.trim();
        if message.is_empty() {
            return Err(StorageError::Validation(
                "Commit message is required".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor = Self::commit_draft_core(&transaction, expected, message)?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("COMMIT", "before-commit")?;
        transaction.commit()?;
        #[cfg(feature = "test-hooks")]
        publication_test_hook("COMMIT", "after-commit")?;
        Ok(cursor)
    }

    /// 版本提交核心：在调用方持有的事务内写快照、提交节点并推进分支指针。
    /// `commit_draft` 独占提交；提议确认的版本副作用在确认事务内复用本函数。
    pub(super) fn commit_draft_core(
        transaction: &rusqlite::Transaction<'_>,
        expected: &AuthorityCursor,
        message: &str,
    ) -> StorageResult<AuthorityCursor> {
        let message = message.trim();
        if message.is_empty() {
            return Err(StorageError::Validation(
                "Commit message is required".into(),
            ));
        }
        let (branch_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let previous_head: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != previous_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let (draft_revision, json, stored_hash): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, document_json, hash FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or(StorageError::MissingDraft)?;
        if draft_revision != revision {
            return Err(StorageError::Conflict(
                "Draft revision does not match document authority".into(),
            ));
        }
        let document: ResumeDocument = serde_json::from_str(&json)?;
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        let actual_hash = canonical_hash(&document)?;
        if document.document_id != expected.document_id || actual_hash != stored_hash {
            return Err(StorageError::HashMismatch);
        }
        if let Some(head_id) = previous_head.as_ref() {
            let head_hash: String = transaction
                .query_row(
                    "SELECT snapshots.hash FROM commits
                     JOIN snapshots ON snapshots.id = commits.snapshot_id
                     WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![head_id, expected.document_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Current head snapshot is missing".into()))?;
            if head_hash == actual_hash {
                return Err(StorageError::Validation("No uncommitted changes".into()));
            }
        }
        let snapshot_id = format!("snap-{actual_hash}");
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, actual_hash],
        )?;
        Self::sync_snapshot_resource_owner(transaction, &snapshot_id, &json)?;
        let random_id: String =
            transaction.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
        let commit_id = format!("commit:{}:{random_id}", expected.document_id);
        transaction.execute(
            "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                commit_id,
                expected.document_id,
                branch_id,
                snapshot_id,
                message
            ],
        )?;
        transaction.execute(
            "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
            params![commit_id, previous_head],
        )?;
        let updated_branch = transaction.execute(
            "UPDATE branches SET head_commit_id = ?1
             WHERE id = ?2 AND document_id = ?3 AND head_commit_id IS ?4",
            params![commit_id, branch_id, expected.document_id, previous_head],
        )?;
        if updated_branch != 1 {
            return Err(StorageError::Conflict("Stale branch head".into()));
        }
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![expected.document_id, context_id, branch_id],
        )?;
        Self::delete_draft_resource_owner(
            transaction,
            &expected.document_id,
            &context_id,
            &branch_id,
        )?;
        let updated_document = transaction.execute(
            "UPDATE documents SET revision = revision + 1
             WHERE id = ?1 AND current_branch_id = ?2 AND active_context_id = ?3 AND revision = ?4",
            params![expected.document_id, branch_id, context_id, revision],
        )?;
        if updated_document != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id,
            head_id: Some(commit_id),
        })
    }
}

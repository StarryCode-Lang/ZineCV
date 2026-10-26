use super::*;

impl Store {
    pub fn create_branch_from_current(
        &mut self,
        expected: &AuthorityCursor,
        name: &str,
    ) -> StorageResult<AuthorityCursor> {
        let name = name.trim();
        if name.is_empty() {
            return Err(StorageError::Validation("Branch name is required".into()));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let authority: (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let (branch_id, context_id, revision) = authority;
        let mut head_id: Option<String> = transaction
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
            || expected.head_id != head_id
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let mut existing =
            transaction.prepare("SELECT name FROM branches WHERE document_id = ?1")?;
        let names =
            existing.query_map(params![expected.document_id], |row| row.get::<_, String>(0))?;
        for existing_name in names {
            if existing_name?.to_lowercase() == name.to_lowercase() {
                return Err(StorageError::Conflict("Branch name already exists".into()));
            }
        }
        drop(existing);

        let draft: Option<(String, String)> = transaction
            .query_row(
                "SELECT document_json, hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (json, stored_hash) = if let Some(draft) = draft {
            draft
        } else if let Some(head_id) = head_id.as_ref() {
            transaction.query_row(
                "SELECT snapshots.document_json, snapshots.hash FROM snapshots
                 JOIN commits ON commits.snapshot_id = snapshots.id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![head_id, expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
        } else {
            return Err(StorageError::MissingDraft);
        };
        let document: ResumeDocument = serde_json::from_str(&json)?;
        let hash = canonical_hash(&document)?;
        if document.document_id != expected.document_id || hash != stored_hash {
            return Err(StorageError::HashMismatch);
        }
        let snapshot_id = format!("snap-{hash}");
        transaction.execute(
            "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
             VALUES (?1, 2, 1, ?2, ?3)",
            params![snapshot_id, json, hash],
        )?;
        Self::sync_snapshot_resource_owner(&transaction, &snapshot_id, &json)?;
        let random_id: String =
            transaction.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
        if head_id.is_none() {
            let baseline_id = format!("commit:{}:baseline:{random_id}", expected.document_id);
            transaction.execute(
                "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
                 VALUES (?1, ?2, ?3, ?4, '初始版本')",
                params![baseline_id, expected.document_id, branch_id, snapshot_id],
            )?;
            transaction.execute(
                "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, NULL)",
                params![baseline_id],
            )?;
            transaction.execute(
                "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
                params![baseline_id, branch_id, expected.document_id],
            )?;
            head_id = Some(baseline_id);
        }
        let new_branch_id = format!("branch:{}:{random_id}", expected.document_id);
        let commit_id = format!("commit:{}:{random_id}", expected.document_id);
        transaction.execute(
            "INSERT INTO branches(id, document_id, name) VALUES (?1, ?2, ?3)",
            params![new_branch_id, expected.document_id, name],
        )?;
        transaction.execute(
            "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                commit_id,
                expected.document_id,
                new_branch_id,
                snapshot_id,
                format!("创建分支：{name}")
            ],
        )?;
        transaction.execute(
            "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
            params![commit_id, head_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = ?1 WHERE id = ?2 AND document_id = ?3",
            params![commit_id, new_branch_id, expected.document_id],
        )?;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![expected.document_id, context_id, branch_id],
        )?;
        Self::delete_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &context_id,
            &branch_id,
        )?;
        let changed = transaction.execute(
            "UPDATE documents SET current_branch_id = ?1, revision = revision + 1
             WHERE id = ?2 AND current_branch_id = ?3 AND active_context_id = ?4 AND revision = ?5",
            params![
                new_branch_id,
                expected.document_id,
                branch_id,
                context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id: new_branch_id,
            head_id: Some(commit_id),
        })
    }

    pub fn switch_branch(
        &mut self,
        expected: &AuthorityCursor,
        target_branch_id: &str,
        discard_uncommitted: bool,
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (branch_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT current_branch_id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let current_head: Option<String> = transaction
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
            || expected.head_id != current_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        if target_branch_id == branch_id {
            return Ok(expected.clone());
        }
        let current_head = current_head.ok_or_else(|| {
            StorageError::Conflict("Current branch has no committed baseline".into())
        })?;
        let current_head_hash: String = transaction
            .query_row(
                "SELECT snapshots.hash FROM commits
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![current_head, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current head snapshot is missing".into()))?;
        let draft_hash: Option<String> = transaction
            .query_row(
                "SELECT hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if draft_hash
            .as_ref()
            .is_some_and(|hash| hash != &current_head_hash)
            && !discard_uncommitted
        {
            return Err(StorageError::Conflict(
                "Uncommitted changes require confirmation".into(),
            ));
        }

        let target_head: String = transaction
            .query_row(
                "SELECT branches.head_commit_id FROM branches
                 LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                 WHERE branches.id = ?1 AND branches.document_id = ?2
                   AND branch_tombstones.branch_id IS NULL",
                params![target_branch_id, expected.document_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Target branch not found".into()))?
            .ok_or_else(|| StorageError::NotFound("Target branch has no head".into()))?;
        let (target_json, target_hash): (String, String) = transaction
            .query_row(
                "SELECT snapshots.document_json, snapshots.hash FROM commits
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![target_head, expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Target head snapshot is missing".into()))?;
        let target_document: ResumeDocument = serde_json::from_str(&target_json)?;
        if target_document.document_id != expected.document_id
            || canonical_hash(&target_document)? != target_hash
        {
            return Err(StorageError::HashMismatch);
        }
        let target_draft_hash: Option<String> = transaction
            .query_row(
                "SELECT hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, target_branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if target_draft_hash
            .as_ref()
            .is_some_and(|hash| hash != &target_hash)
        {
            return Err(StorageError::Conflict(
                "Target branch has an unsaved draft".into(),
            ));
        }
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2
             AND branch_id IN (?3, ?4)",
            params![
                expected.document_id,
                context_id,
                branch_id,
                target_branch_id
            ],
        )?;
        Self::delete_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &context_id,
            &branch_id,
        )?;
        Self::delete_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &context_id,
            target_branch_id,
        )?;
        let changed = transaction.execute(
            "UPDATE documents SET current_branch_id = ?1, title = ?2, revision = revision + 1
             WHERE id = ?3 AND current_branch_id = ?4 AND active_context_id = ?5 AND revision = ?6",
            params![
                target_branch_id,
                target_document.title,
                expected.document_id,
                branch_id,
                context_id,
                revision
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id: target_branch_id.into(),
            head_id: Some(target_head),
        })
    }
}

use super::*;

impl Store {
    pub fn load_commit_into_draft(
        &mut self,
        expected: &AuthorityCursor,
        commit_id: &str,
        confirmed: bool,
    ) -> StorageResult<AuthorityCursor> {
        if !confirmed {
            return Err(StorageError::Validation(
                "Loading history requires confirmation".into(),
            ));
        }
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
        let head_id: Option<String> = transaction
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

        let (json, stored_hash): (String, String) = transaction
            .query_row(
                "SELECT snapshots.document_json, snapshots.hash FROM commits
                 JOIN snapshots ON snapshots.id = commits.snapshot_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![commit_id, expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("History commit not found".into()))?;
        let document: ResumeDocument = serde_json::from_str(&json)?;
        zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
        if document.document_id != expected.document_id || canonical_hash(&document)? != stored_hash
        {
            return Err(StorageError::HashMismatch);
        }
        let (target_kind, target_source_id) = document
            .legacy_extensions
            .get("importedTemplate")
            .and_then(|value| value.get("id"))
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.trim().is_empty() && id.len() <= 512)
            .map(|id| (EditingContextSourceKind::ImportedTemplate, id.to_string()))
            .unwrap_or((EditingContextSourceKind::Workspace, "default".into()));
        let target_source_kind_name = editing_context_source_name(target_kind);
        let mut source_rows = transaction.prepare(
            "SELECT id FROM editing_contexts
             WHERE document_id = ?1 AND source_kind = ?2 AND source_id = ?3",
        )?;
        let source_contexts = source_rows
            .query_map(
                params![
                    expected.document_id,
                    target_source_kind_name,
                    target_source_id
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(source_rows);
        if source_contexts.len() > 1 {
            return Err(StorageError::Corrupt(
                "History source maps to multiple editing contexts".into(),
            ));
        }
        let target_context_id = source_contexts
            .first()
            .cloned()
            .unwrap_or_else(|| stable_editing_context_id(target_kind, &target_source_id));
        if source_contexts.is_empty() {
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
                    "Stable history context ID is already assigned".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO editing_contexts(id, document_id, source_kind, source_id)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    target_context_id,
                    expected.document_id,
                    target_source_kind_name,
                    target_source_id
                ],
            )?;
        }

        let changed = transaction.execute(
            "UPDATE documents SET title = ?1, active_context_id = ?2, revision = revision + 1
             WHERE id = ?3 AND current_branch_id = ?4 AND active_context_id = ?5 AND revision = ?6",
            params![
                document.title,
                target_context_id,
                expected.document_id,
                branch_id,
                context_id,
                revision
            ],
        )?;
        if changed != 1 {
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
                expected.document_id,
                target_context_id,
                branch_id,
                revision + 1,
                json,
                stored_hash
            ],
        )?;
        Self::sync_draft_resource_owner(
            &transaction,
            &expected.document_id,
            &target_context_id,
            &branch_id,
            &json,
        )?;
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id: target_context_id,
            revision: (revision + 1).to_string(),
            branch_id,
            head_id,
        })
    }

    pub fn delete_commit(
        &mut self,
        expected: &AuthorityCursor,
        commit_id: &str,
        confirmed: bool,
    ) -> StorageResult<AuthorityCursor> {
        if !confirmed {
            return Err(StorageError::Validation(
                "Deleting a commit requires confirmation".into(),
            ));
        }
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
        let parent_id: Option<String> = transaction
            .query_row(
                "SELECT commit_links.visible_parent_id FROM commits
                 JOIN commit_links ON commit_links.commit_id = commits.id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![commit_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("History commit not found".into()))?;
        if let Some(parent_id) = parent_id.as_ref() {
            let parent_document_id: String = transaction
                .query_row(
                    "SELECT document_id FROM commits WHERE id = ?1",
                    [parent_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("History parent is missing".into()))?;
            if parent_document_id != expected.document_id {
                return Err(StorageError::Corrupt(
                    "History parent crosses documents".into(),
                ));
            }
        }

        let draft_revision: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM drafts
                 WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, branch_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(draft_revision) = draft_revision {
            if draft_revision != revision {
                return Err(StorageError::Conflict("Draft revision is stale".into()));
            }
            transaction.execute(
                "UPDATE drafts SET revision = ?1, updated_at = CURRENT_TIMESTAMP
                 WHERE document_id = ?2 AND context_id = ?3 AND branch_id = ?4",
                params![revision + 1, expected.document_id, context_id, branch_id],
            )?;
        } else if current_head.as_deref() == Some(commit_id) {
            let (json, stored_hash): (String, String) = transaction
                .query_row(
                    "SELECT snapshots.document_json, snapshots.hash FROM commits
                         JOIN snapshots ON snapshots.id = commits.snapshot_id
                         WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![commit_id, expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Current head snapshot is missing".into()))?;
            let document: ResumeDocument = serde_json::from_str(&json)?;
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
            if document.document_id != expected.document_id
                || canonical_hash(&document)? != stored_hash
            {
                return Err(StorageError::HashMismatch);
            }
            transaction.execute(
                    "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![expected.document_id, context_id, branch_id, revision + 1, json, stored_hash],
                )?;
            Self::sync_draft_resource_owner(
                &transaction,
                &expected.document_id,
                &context_id,
                &branch_id,
                &json,
            )?;
        }
        transaction.execute(
            "UPDATE commit_links SET visible_parent_id = ?1 WHERE visible_parent_id = ?2",
            params![parent_id, commit_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = ?1
             WHERE document_id = ?2 AND head_commit_id = ?3",
            params![parent_id, expected.document_id, commit_id],
        )?;
        transaction.execute("DELETE FROM commit_links WHERE commit_id = ?1", [commit_id])?;
        transaction.execute(
            "DELETE FROM commits WHERE id = ?1 AND document_id = ?2",
            params![commit_id, expected.document_id],
        )?;
        Self::prune_unreferenced_snapshots(&transaction)?;
        let changed = transaction.execute(
            "UPDATE documents SET revision = revision + 1
             WHERE id = ?1 AND current_branch_id = ?2 AND active_context_id = ?3 AND revision = ?4",
            params![expected.document_id, branch_id, context_id, revision],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id,
            head_id: if current_head.as_deref() == Some(commit_id) {
                parent_id
            } else {
                current_head
            },
        })
    }

    pub fn delete_branch(
        &mut self,
        expected: &AuthorityCursor,
        target_branch_id: &str,
        confirmed: bool,
    ) -> StorageResult<AuthorityCursor> {
        if !confirmed {
            return Err(StorageError::Validation(
                "Deleting a branch requires confirmation".into(),
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_branch, context_id, revision): (String, String, i64) = transaction
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
                params![current_branch, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != current_branch
            || expected.context_id != context_id
            || expected.revision != revision.to_string()
            || expected.head_id != current_head
        {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let target_name: String = transaction
            .query_row(
                "SELECT branches.name FROM branches
                 LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                 WHERE branches.id = ?1 AND branches.document_id = ?2
                   AND branch_tombstones.branch_id IS NULL",
                params![target_branch_id, expected.document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Active branch not found".into()))?;
        if target_name == "main"
            || target_branch_id == default_branch_id(&expected.document_id)
            || target_branch_id == "main"
        {
            return Err(StorageError::Validation(
                "Default branch is protected".into(),
            ));
        }
        let deleting_current = target_branch_id == current_branch;
        let mut next_branch = current_branch.clone();
        let mut next_head = current_head.clone();
        let mut next_title: Option<String> = None;
        if deleting_current {
            let (main_id, main_head): (String, String) = transaction
                .query_row(
                    "SELECT branches.id, branches.head_commit_id FROM branches
                     LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                     WHERE branches.document_id = ?1 AND branches.name = 'main'
                       AND branch_tombstones.branch_id IS NULL",
                    params![expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| {
                    StorageError::Corrupt("Default branch is missing its head".into())
                })?;
            let (json, hash): (String, String) = transaction
                .query_row(
                    "SELECT snapshots.document_json, snapshots.hash FROM commits
                     JOIN snapshots ON snapshots.id = commits.snapshot_id
                     WHERE commits.id = ?1 AND commits.document_id = ?2",
                    params![main_head, expected.document_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Default head snapshot is missing".into()))?;
            let document: ResumeDocument = serde_json::from_str(&json)?;
            zinecv_domain::DocumentContext::new(document.clone()).map_err(StorageError::Domain)?;
            if document.document_id != expected.document_id || canonical_hash(&document)? != hash {
                return Err(StorageError::HashMismatch);
            }
            let main_draft_hash: Option<String> = transaction
                .query_row(
                    "SELECT hash FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![expected.document_id, context_id, main_id],
                    |row| row.get(0),
                )
                .optional()?;
            if main_draft_hash
                .as_ref()
                .is_some_and(|draft_hash| draft_hash != &hash)
            {
                return Err(StorageError::Conflict(
                    "Default branch has an unsaved draft".into(),
                ));
            }
            Self::delete_draft_resource_owner(
                &transaction,
                &expected.document_id,
                &context_id,
                &main_id,
            )?;
            transaction.execute(
                "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                params![expected.document_id, context_id, main_id],
            )?;
            next_branch = main_id;
            next_head = Some(main_head);
            next_title = Some(document.title);
        } else {
            transaction.execute(
                "UPDATE drafts SET revision = ?1, updated_at = CURRENT_TIMESTAMP
                 WHERE document_id = ?2 AND context_id = ?3 AND branch_id = ?4",
                params![
                    revision + 1,
                    expected.document_id,
                    context_id,
                    current_branch
                ],
            )?;
        }
        // 必须在草稿仍存在时先收集 owner 并清理其资源引用：先删草稿再查会
        // 恒为空集，被删分支草稿的 resource_refs / resource_recovery_requirements
        // 将永久残留，GC 永远无法回收这些资产。owner 级清理不会触碰仍被
        // 其他草稿或快照持有的引用。
        Self::delete_branch_draft_resource_owners(
            &transaction,
            &expected.document_id,
            target_branch_id,
        )?;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND branch_id = ?2",
            params![expected.document_id, target_branch_id],
        )?;
        transaction.execute(
            "INSERT INTO branch_tombstones(branch_id) VALUES (?1)",
            [target_branch_id],
        )?;
        transaction.execute(
            "UPDATE branches SET head_commit_id = NULL, name = ?1
             WHERE id = ?2 AND document_id = ?3",
            params![
                format!("__deleted__:{target_branch_id}"),
                target_branch_id,
                expected.document_id
            ],
        )?;
        let unreachable = {
            let mut statement = transaction.prepare(
                "WITH RECURSIVE reachable(id) AS (
                   SELECT branches.head_commit_id FROM branches
                   LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = branches.id
                   WHERE branches.document_id = ?1 AND branches.head_commit_id IS NOT NULL
                     AND branch_tombstones.branch_id IS NULL
                   UNION
                   SELECT links.visible_parent_id FROM commit_links AS links
                   JOIN reachable ON reachable.id = links.commit_id
                   JOIN commits AS parent ON parent.id = links.visible_parent_id
                   WHERE parent.document_id = ?1
                 )
                 SELECT id FROM commits WHERE document_id = ?1
                   AND id NOT IN (SELECT id FROM reachable)",
            )?;
            let ids = statement
                .query_map(params![expected.document_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        for id in &unreachable {
            transaction.execute("DELETE FROM commit_links WHERE commit_id = ?1", [id])?;
        }
        for id in &unreachable {
            transaction.execute("DELETE FROM commits WHERE id = ?1", [id])?;
        }
        Self::prune_unreferenced_snapshots(&transaction)?;
        let changed = transaction.execute(
            "UPDATE documents SET current_branch_id = ?1, title = COALESCE(?2, title), revision = revision + 1
             WHERE id = ?3 AND current_branch_id = ?4 AND active_context_id = ?5 AND revision = ?6",
            params![next_branch, next_title, expected.document_id, current_branch, context_id, revision],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        transaction.commit()?;
        Ok(AuthorityCursor {
            document_id: expected.document_id.clone(),
            context_id,
            revision: (revision + 1).to_string(),
            branch_id: next_branch,
            head_id: next_head,
        })
    }
}

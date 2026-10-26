use super::*;

impl Store {
    pub(super) fn resolve_legacy_identity(
        transaction: &rusqlite::Transaction<'_>,
        context: &mut LegacyIdentityContext<'_>,
        entity_kind: &str,
        legacy_id: &str,
        content_hash: &str,
    ) -> StorageResult<(String, bool)> {
        let existing: Option<String> = transaction
            .query_row(
                "SELECT native_id FROM legacy_entity_identity
                 WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3
                   AND legacy_id = ?4 AND content_hash = ?5",
                params![
                    context.namespace,
                    context.document_id,
                    entity_kind,
                    legacy_id,
                    content_hash
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(native_id) = existing {
            return Ok((native_id, false));
        }
        let has_other_content: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM legacy_entity_identity
             WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3 AND legacy_id = ?4)",
            params![context.namespace, context.document_id, entity_kind, legacy_id],
            |row| row.get(0),
        )?;
        let conflict_key =
            migration::identity_conflict_key(context.namespace, entity_kind, legacy_id);
        let base_id = migration::stable_native_id(context.namespace, entity_kind, legacy_id);
        let native_id = if has_other_content {
            if !context.accepted_updates.contains(&conflict_key) {
                return Err(StorageError::Conflict(
                    "A legacy identity changed content; explicit review is required".into(),
                ));
            }
            context.used_updates.insert(conflict_key);
            format!("{base_id}-{}", &content_hash[..12])
        } else {
            base_id
        };
        let occupied: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM legacy_entity_identity WHERE native_id = ?1)",
            params![native_id],
            |row| row.get(0),
        )?;
        if occupied {
            return Err(StorageError::Conflict(
                "Stable legacy identity is already mapped to a different entity".into(),
            ));
        }
        transaction.execute(
            "INSERT INTO legacy_entity_identity(namespace, target_document_id, entity_kind,
             legacy_id, content_hash, native_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                context.namespace,
                context.document_id,
                entity_kind,
                legacy_id,
                content_hash,
                native_id
            ],
        )?;
        Ok((native_id, true))
    }

    pub(super) fn lookup_legacy_identity(
        transaction: &rusqlite::Transaction<'_>,
        namespace: &str,
        document_id: &str,
        entity_kind: &str,
        legacy_id: &str,
    ) -> StorageResult<Option<String>> {
        Ok(transaction
            .query_row(
                "SELECT native_id FROM legacy_entity_identity
                 WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3
                   AND legacy_id = ?4 ORDER BY created_at DESC LIMIT 1",
                params![namespace, document_id, entity_kind, legacy_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub(super) fn prune_unreferenced_snapshots(
        transaction: &rusqlite::Transaction<'_>,
    ) -> StorageResult<()> {
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'snapshot'
             AND owner_id NOT IN (SELECT id FROM snapshots)",
            [],
        )?;
        Ok(())
    }

    pub(super) fn replace_version_store_tx(
        transaction: &rusqlite::Transaction<'_>,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
        imported_draft: Option<&ResumeDocument>,
    ) -> StorageResult<AuthorityCursor> {
        // Replacement removes this document's old commits: every supplied head
        // and parent must resolve inside the replacement, never in another graph.
        let commit_ids: HashSet<&str> = commits.iter().map(|commit| commit.id.as_str()).collect();
        if branches.iter().any(|branch| {
            branch
                .head_commit_id
                .as_deref()
                .is_some_and(|id| !commit_ids.contains(id))
        }) || commits.iter().any(|commit| {
            commit
                .parent_id
                .as_deref()
                .is_some_and(|id| !commit_ids.contains(id))
        }) {
            return Err(StorageError::Validation(
                "Replacement graph contains an unresolved head or parent".into(),
            ));
        }
        let (document_id, context_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT id, active_context_id, revision FROM documents WHERE id = ?1",
                params![expected.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let (branch_id, _): (String, Option<String>) = transaction
            .query_row(
                "SELECT current_branch_id, b.head_commit_id FROM documents
                 LEFT JOIN branches b ON b.id = documents.current_branch_id AND b.document_id = documents.id
                 WHERE documents.id = ?1",
                params![document_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        if expected.branch_id != branch_id
            || expected.revision != revision.to_string()
            || expected.context_id != context_id
        {
            return Err(StorageError::Conflict(
                "Version store replacement cursor is stale".into(),
            ));
        }
        let (draft_revision, durable_draft_json, durable_draft_hash): (i64, String, String) =
            transaction
                .query_row(
                    "SELECT revision, document_json, hash FROM drafts
                     WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
                    params![document_id, context_id, branch_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::Corrupt("Current durable draft is missing".into()))?;
        let durable_draft: ResumeDocument = serde_json::from_str(&durable_draft_json)?;
        zinecv_domain::DocumentContext::new(durable_draft.clone()).map_err(StorageError::Domain)?;
        if draft_revision != revision
            || durable_draft.document_id != document_id
            || canonical_hash(&durable_draft)? != durable_draft_hash
        {
            return Err(StorageError::Conflict(
                "Current durable draft does not match document authority".into(),
            ));
        }
        let current_draft = match imported_draft {
            Some(imported) if imported.document_id != document_id => {
                return Err(StorageError::Validation(
                    "Imported draft must target the active document".into(),
                ));
            }
            Some(imported) => {
                zinecv_domain::DocumentContext::new(imported.clone())
                    .map_err(StorageError::Domain)?;
                imported.clone()
            }
            None => durable_draft,
        };
        let current_draft_json = serde_json::to_string(&current_draft)?;
        let current_draft_hash = canonical_hash(&current_draft)?;

        let prior_drafts = {
            let mut statement = transaction
                .prepare("SELECT context_id, branch_id FROM drafts WHERE document_id = ?1")?;
            let rows = statement
                .query_map(params![document_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (draft_context_id, draft_branch_id) in prior_drafts {
            Self::delete_draft_resource_owner(
                transaction,
                &document_id,
                &draft_context_id,
                &draft_branch_id,
            )?;
        }
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1",
            params![document_id],
        )?;

        // 1) 清空该文档的版本图；快照在全部分支删除后再统一回收。
        transaction.execute(
            "DELETE FROM commit_links WHERE commit_id IN (SELECT id FROM commits WHERE document_id = ?1)",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM branch_tombstones WHERE branch_id IN (SELECT id FROM branches WHERE document_id = ?1)",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM commits WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM branches WHERE document_id = ?1",
            params![document_id],
        )?;
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'snapshot'
             AND owner_id NOT IN (SELECT id FROM snapshots)",
            [],
        )?;

        // 2) 主分支 id 固定为 main:{document_id}；其余沿用备份中的 id。
        let default_branch = default_branch_id(&document_id);
        for branch in branches {
            let id = if branch.id == "main" || branch.id == default_branch {
                default_branch.clone()
            } else {
                branch.id.clone()
            };
            transaction.execute(
                "INSERT INTO branches(id, document_id, name, head_commit_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    document_id,
                    branch.name,
                    branch.head_commit_id,
                    branch.created_at
                ],
            )?;
        }
        if !branches
            .iter()
            .any(|branch| branch.id == "main" || branch.id == default_branch)
        {
            return Err(StorageError::Validation(
                "Replacement store is missing the default branch".into(),
            ));
        }

        // 3) 提交：快照按 canonical hash 复用（与 commit_draft 同一 id/hash 约定）。
        for commit in commits {
            let snapshot_json = serde_json::to_string(&commit.snapshot)?;
            let hash = canonical_hash(&commit.snapshot)?;
            let snapshot_id = format!("snap-{hash}");
            transaction.execute(
                "INSERT OR IGNORE INTO snapshots(id, schema_version, canonical_version, document_json, hash)
                 VALUES (?1, 2, 1, ?2, ?3)",
                params![snapshot_id, snapshot_json, hash],
            )?;
            Self::sync_snapshot_resource_owner(transaction, &snapshot_id, &snapshot_json)?;
            transaction.execute(
                "INSERT INTO commits(id, document_id, origin_branch_id, snapshot_id, message, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    commit.id,
                    document_id,
                    if commit.branch_id == "main" { &default_branch } else { &commit.branch_id },
                    snapshot_id,
                    commit.message,
                    commit.created_at
                ],
            )?;
            transaction.execute(
                "INSERT INTO commit_links(commit_id, visible_parent_id) VALUES (?1, ?2)",
                params![commit.id, commit.parent_id],
            )?;
        }

        // 4) 切到替换后的当前分支（id 同样做 main 归一），保留当前工作内容为草稿。
        let target_branch = if current_branch_id == "main" {
            default_branch.clone()
        } else {
            current_branch_id.to_string()
        };
        let exists: Option<String> = transaction
            .query_row(
                "SELECT id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![target_branch, document_id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(StorageError::Validation(
                "Replacement current branch is missing".into(),
            ));
        }
        let next_revision = revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Document revision overflow".into()))?;
        transaction.execute(
            "UPDATE documents SET current_branch_id = ?2, revision = ?3 WHERE id = ?1 AND revision = ?4",
            params![document_id, target_branch, next_revision, revision],
        )?;
        transaction.execute(
            "DELETE FROM drafts WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![document_id, context_id, target_branch],
        )?;
        Self::delete_draft_resource_owner(transaction, &document_id, &context_id, &target_branch)?;
        transaction.execute(
            "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![
                document_id,
                context_id,
                target_branch,
                next_revision,
                &current_draft_json,
                current_draft_hash,
            ],
        )?;
        Self::sync_draft_resource_owner(
            transaction,
            &document_id,
            &context_id,
            &target_branch,
            &current_draft_json,
        )?;
        // 替换完成后回收未被任何提交引用的旧快照，避免历史泄漏。
        transaction.execute(
            "DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM commits)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'snapshot'
             AND owner_id NOT IN (SELECT id FROM snapshots)",
            [],
        )?;
        let head_id: Option<String> = transaction.query_row(
            "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
            params![target_branch, document_id],
            |row| row.get(0),
        )?;
        Ok(AuthorityCursor {
            document_id,
            context_id,
            revision: next_revision.to_string(),
            branch_id: target_branch,
            head_id,
        })
    }

    pub fn snapshot_count(&self) -> StorageResult<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))?)
    }
}

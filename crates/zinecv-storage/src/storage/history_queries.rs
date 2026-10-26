use super::*;

impl Store {
    pub fn load_version_graph(&self, document_id: &str) -> StorageResult<VersionGraph> {
        let transaction = self.connection.unchecked_transaction()?;
        let (context_id, branch_id, revision): (String, String, i64) = transaction
            .query_row(
                "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
                [document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("Document not found".into()))?;
        let head_id: Option<String> = transaction
            .query_row(
                "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
                params![branch_id, document_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::Corrupt("Current branch is missing".into()))?;
        let branches = {
            let mut statement = transaction.prepare(
                "SELECT branches.id, branches.name, branches.head_commit_id, branches.created_at
                 FROM branches LEFT JOIN branch_tombstones
                   ON branch_tombstones.branch_id = branches.id
                 WHERE branches.document_id = ?1 AND branch_tombstones.branch_id IS NULL
                 ORDER BY branches.created_at, branches.id",
            )?;
            let rows = statement.query_map([document_id], |row| {
                let id: String = row.get(0)?;
                Ok(VersionBranch {
                    is_current: id == branch_id,
                    id,
                    name: row.get(1)?,
                    head_commit_id: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if !branches.iter().any(|branch| branch.is_current) {
            return Err(StorageError::Corrupt("Current branch is deleted".into()));
        }
        let commits = {
            let mut statement = transaction.prepare(
                "SELECT commits.id, commits.origin_branch_id,
                        branch_tombstones.branch_id IS NOT NULL,
                        commits.snapshot_id, commit_links.visible_parent_id,
                        commits.message, commits.created_at
                 FROM commits
                 JOIN commit_links ON commit_links.commit_id = commits.id
                 LEFT JOIN branch_tombstones ON branch_tombstones.branch_id = commits.origin_branch_id
                 WHERE commits.document_id = ?1
                 ORDER BY commits.created_at DESC, commits.id DESC",
            )?;
            let rows = statement.query_map([document_id], |row| {
                Ok(VersionCommit {
                    id: row.get(0)?,
                    origin_branch_id: row.get(1)?,
                    origin_deleted: row.get(2)?,
                    snapshot_id: row.get(3)?,
                    parent_id: row.get(4)?,
                    message: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let total_commits: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM commits WHERE document_id = ?1",
            [document_id],
            |row| row.get(0),
        )?;
        if commits.len() as i64 != total_commits {
            return Err(StorageError::Corrupt(
                "History commit link is missing".into(),
            ));
        }
        transaction.commit()?;
        Ok(VersionGraph {
            cursor: AuthorityCursor {
                document_id: document_id.into(),
                context_id,
                revision: revision.to_string(),
                branch_id,
                head_id,
            },
            branches,
            commits,
        })
    }

    pub fn commit_count(&self, document_id: &str) -> StorageResult<i64> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM commits WHERE document_id = ?1",
            params![document_id],
            |row| row.get(0),
        )?)
    }

    /// 单次 load_version_graph_detailed 物化快照的默认提交上限（新→旧，含
    /// 当前 head）。结构始终全量返回；覆盖 F24 千版本验收输入，超大图
    /// （>1000 提交）只物化最新 1000 个以约束内存。
    pub const VERSION_GRAPH_DETAILED_DEFAULT_LIMIT: usize = 1000;

    /// 版本 UI 使用：同一读事务返回 graph 与每个提交的快照 document JSON。
    /// 默认有界：最多物化 [`Store::VERSION_GRAPH_DETAILED_DEFAULT_LIMIT`]
    /// 个提交的快照（新→旧），当前分支 head 保证在列。
    pub fn load_version_graph_detailed(
        &self,
        document_id: &str,
    ) -> StorageResult<VersionGraphDetailed> {
        self.load_version_graph_detailed_with_limit(
            document_id,
            Self::VERSION_GRAPH_DETAILED_DEFAULT_LIMIT,
        )
    }

    /// 有界读取：limit 为单次物化快照的提交上限（>0）。返回的提交仍按
    /// created_at DESC, id DESC 排序；当前分支 head 不在窗口内时追加在末尾
    /// （head 比窗口内所有提交更旧，排序不变），保证 agent 草稿 diff 与
    /// UI 当前基线不因有界读取丢失 head。
    /// 有界物化：提交结构全量返回（不丢祖先/共享节点），快照 JSON 仅物化
    /// 最新 `limit` 个提交（当前分支 head 永远物化，保证 agent 草稿 diff 与
    /// UI 当前基线可用）；更旧提交的 snapshot_document_json 为空串，需要时
    /// 用 [`Store::load_commit_detail`] 按需取回。
    pub fn load_version_graph_detailed_with_limit(
        &self,
        document_id: &str,
        limit: usize,
    ) -> StorageResult<VersionGraphDetailed> {
        if limit == 0 {
            return Err(StorageError::Validation(
                "Version graph detail limit must be positive".into(),
            ));
        }
        let graph = self.load_version_graph(document_id)?;
        let head_id = graph.cursor.head_id.clone();
        let mut detailed = Vec::with_capacity(graph.commits.len());
        for (index, commit) in graph.commits.iter().enumerate() {
            let materialize = index < limit || Some(commit.id.as_str()) == head_id.as_deref();
            let detail = if materialize {
                Self::version_commit_detail(&self.connection, commit)?
            } else {
                VersionCommitDetailed {
                    commit: commit.clone(),
                    snapshot_document_json: String::new(),
                }
            };
            detailed.push(detail);
        }
        Ok(VersionGraphDetailed {
            cursor: graph.cursor,
            branches: graph.branches,
            commits: detailed,
        })
    }

    /// 按需单条取回提交详情（含快照 JSON）；供有界版本图窗口之外的历史
    /// 版本引用使用，保持与全量图一致的可见性语义。
    pub fn load_commit_detail(
        &self,
        document_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<VersionCommitDetailed>> {
        let commit = self
            .connection
            .query_row(
                "SELECT commits.id, commits.origin_branch_id,
                        branch_tombstones.branch_id IS NOT NULL,
                        commits.snapshot_id, commit_links.visible_parent_id,
                        commits.message, commits.created_at
                 FROM commits
                 JOIN commit_links ON commit_links.commit_id = commits.id
                 LEFT JOIN branch_tombstones
                   ON branch_tombstones.branch_id = commits.origin_branch_id
                 WHERE commits.id = ?1 AND commits.document_id = ?2",
                params![commit_id, document_id],
                |row| {
                    Ok(VersionCommit {
                        id: row.get(0)?,
                        origin_branch_id: row.get(1)?,
                        origin_deleted: row.get(2)?,
                        snapshot_id: row.get(3)?,
                        parent_id: row.get(4)?,
                        message: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()?;
        let Some(commit) = commit else {
            return Ok(None);
        };
        Ok(Some(Self::version_commit_detail(
            &self.connection,
            &commit,
        )?))
    }

    pub(super) fn version_commit_detail(
        connection: &Connection,
        commit: &VersionCommit,
    ) -> StorageResult<VersionCommitDetailed> {
        let json: String = connection
            .query_row(
                "SELECT document_json FROM snapshots WHERE id = ?1",
                [&commit.snapshot_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                StorageError::Corrupt(format!(
                    "Snapshot {} for commit {} is missing",
                    commit.snapshot_id, commit.id
                ))
            })?;
        // 返回前确认快照仍是合法 ResumeDocument，损坏直接报错而不是空历史。
        let _: ResumeDocument = serde_json::from_str(&json)
            .map_err(|error| StorageError::Corrupt(format!("Snapshot parse failed: {error}")))?;
        Ok(VersionCommitDetailed {
            commit: commit.clone(),
            snapshot_document_json: json,
        })
    }

    /// 头像资产读取：按 hash 返回 (mime, bytes)；缺失返回 None 而不是错误。
    pub fn read_resource_bytes(&self, hash: &str) -> StorageResult<Option<(String, Vec<u8>)>> {
        let resource: Option<(String, Vec<u8>, i64)> = self
            .connection
            .query_row(
                "SELECT mime, bytes, size FROM resources WHERE hash = ?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        resource
            .map(|(mime, bytes, size)| {
                if size != bytes.len() as i64 || format!("{:x}", Sha256::digest(&bytes)) != hash {
                    return Err(StorageError::HashMismatch);
                }
                Ok((mime, bytes))
            })
            .transpose()
    }
}

use super::*;

impl Store {
    /// 工作区偏好写入；value 为 None 表示删除该键。
    pub fn write_setting(&self, key: &str, value: Option<&str>) -> StorageResult<()> {
        match value {
            Some(value) => {
                self.connection.execute(
                    "INSERT INTO settings(key, value, updated_at)
                     VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = excluded.updated_at",
                    params![key, value],
                )?;
            }
            None => {
                self.connection
                    .execute("DELETE FROM settings WHERE key = ?1", [key])?;
            }
        }
        Ok(())
    }

    /// 头像资源与文档的持有关系：换头像先解除旧引用再建立新引用，GC 依据该引用保留。
    pub fn set_document_avatar(&self, document_id: &str, hash: Option<&str>) -> StorageResult<()> {
        let mut statement = self.connection.prepare(
            "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
        )?;
        statement.execute([document_id])?;
        if let Some(hash) = hash {
            self.link_resource(hash, "document-avatar", document_id)?;
        }
        Ok(())
    }

    /// 用外部备份整库替换当前文档的版本图（F28 旧语义）：
    /// 快照按内容 hash 去重复用；默认保留当前 durable draft。
    pub fn replace_version_store(
        &mut self,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor = Self::replace_version_store_tx(
            &transaction,
            expected,
            current_branch_id,
            branches,
            commits,
            None,
        )?;
        transaction.commit()?;
        Ok(cursor)
    }

    /// Replace a version graph and optionally apply an explicitly reviewed draft in one
    /// SQLite transaction. `None` preserves the current durable draft.
    pub fn replace_version_store_with_draft(
        &mut self,
        expected: &AuthorityCursor,
        current_branch_id: &str,
        branches: &[ReplaceBranch],
        commits: &[ReplaceCommit],
        imported_draft: Option<&ResumeDocument>,
    ) -> StorageResult<AuthorityCursor> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor = Self::replace_version_store_tx(
            &transaction,
            expected,
            current_branch_id,
            branches,
            commits,
            imported_draft,
        )?;
        transaction.commit()?;
        Ok(cursor)
    }
}

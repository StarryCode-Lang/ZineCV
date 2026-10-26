use super::*;

impl Store {
    pub fn put_resource(
        &self,
        hash: &str,
        mime: &str,
        bytes: &[u8],
        license_ref: Option<&str>,
    ) -> StorageResult<()> {
        if format!("{:x}", Sha256::digest(bytes)) != hash {
            return Err(StorageError::HashMismatch);
        }
        self.connection.execute(
            "INSERT INTO resources(hash, mime, bytes, size, license_ref) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(hash) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes, size = excluded.size",
            params![hash, mime, bytes, bytes.len() as i64, license_ref],
        )?;
        self.connection.execute(
            "DELETE FROM resource_recovery_requirements WHERE resource_hash = ?1",
            [hash],
        )?;
        Ok(())
    }

    pub fn link_resource(&self, hash: &str, owner_kind: &str, owner_id: &str) -> StorageResult<()> {
        if !matches!(
            owner_kind,
            "draft" | "snapshot" | "retained-template" | "pending-import" | "document-avatar"
        ) {
            return Err(StorageError::Validation(
                "Unknown durable resource owner kind".into(),
            ));
        }
        self.connection.execute(
            "INSERT OR IGNORE INTO resource_refs(resource_hash, owner_kind, owner_id) VALUES (?1, ?2, ?3)",
            params![hash, owner_kind, owner_id],
        )?;
        Ok(())
    }

    pub fn unlink_resource(
        &self,
        hash: &str,
        owner_kind: &str,
        owner_id: &str,
    ) -> StorageResult<usize> {
        Ok(self.connection.execute(
            "DELETE FROM resource_refs WHERE resource_hash = ?1 AND owner_kind = ?2 AND owner_id = ?3",
            params![hash, owner_kind, owner_id],
        )?)
    }

    pub fn collect_unreferenced_resources(&self) -> StorageResult<usize> {
        resources::collect_unreferenced(&self.connection)
    }

    pub fn create_resource_lease(
        &self,
        hashes: &[String],
        ttl_seconds: u64,
    ) -> StorageResult<String> {
        resources::acquire_lease(&self.connection, hashes, ttl_seconds)
    }

    pub(super) fn create_all_resource_lease(&self, ttl_seconds: u64) -> StorageResult<String> {
        resources::acquire_all_resource_lease(&self.connection, ttl_seconds)
    }

    pub fn release_resource_lease(&self, lease_id: &str) -> StorageResult<()> {
        resources::release_lease(&self.connection, lease_id)
    }

    pub(super) fn draft_resource_owner_id(
        document_id: &str,
        context_id: &str,
        branch_id: &str,
    ) -> String {
        serde_json::to_string(&[document_id, context_id, branch_id])
            .expect("resource owner tuple serialization cannot fail")
    }

    pub(super) fn sync_draft_resource_owner(
        connection: &Connection,
        document_id: &str,
        context_id: &str,
        branch_id: &str,
        document_json: &str,
    ) -> StorageResult<()> {
        let owner_id = Self::draft_resource_owner_id(document_id, context_id, branch_id);
        resources::sync_document_resource_owner(connection, "draft", &owner_id, document_json)
    }

    pub(super) fn sync_snapshot_resource_owner(
        connection: &Connection,
        snapshot_id: &str,
        document_json: &str,
    ) -> StorageResult<()> {
        resources::sync_document_resource_owner(connection, "snapshot", snapshot_id, document_json)
    }

    pub(super) fn delete_draft_resource_owner(
        connection: &Connection,
        document_id: &str,
        context_id: &str,
        branch_id: &str,
    ) -> StorageResult<()> {
        let owner_id = Self::draft_resource_owner_id(document_id, context_id, branch_id);
        connection.execute(
            "DELETE FROM resource_refs WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&owner_id],
        )?;
        connection.execute(
            "DELETE FROM resource_recovery_requirements WHERE owner_kind = 'draft' AND owner_id = ?1",
            [&owner_id],
        )?;
        Ok(())
    }

    pub(super) fn delete_branch_draft_resource_owners(
        connection: &Connection,
        document_id: &str,
        branch_id: &str,
    ) -> StorageResult<()> {
        let contexts = {
            let mut statement = connection.prepare(
                "SELECT context_id FROM drafts WHERE document_id = ?1 AND branch_id = ?2",
            )?;
            let rows = statement.query_map(params![document_id, branch_id], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for context_id in contexts {
            Self::delete_draft_resource_owner(connection, document_id, &context_id, branch_id)?;
        }
        Ok(())
    }

    pub fn resource_count(&self) -> StorageResult<i64> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM resources", [], |row| row.get(0))?)
    }
}

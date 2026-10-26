use super::*;

impl Store {
    pub fn inspect_legacy_identity_conflicts(
        &self,
        request: &migration::InspectLegacyIdentityConflictsRequest,
    ) -> StorageResult<Vec<migration::LegacyMigrationIdentityConflict>> {
        if request.target_document_id.trim().is_empty()
            || request.source_namespace.trim().is_empty()
            || request.source_namespace.len() > 160
        {
            return Err(StorageError::Validation(
                "Invalid legacy identity inspection request".into(),
            ));
        }
        validate_legacy_version_graph(&request.version_graph)?;
        let target_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
            params![request.target_document_id],
            |row| row.get(0),
        )?;
        if !target_exists {
            return Err(StorageError::NotFound(
                "Migration target document is missing".into(),
            ));
        }
        let mut conflicts = HashMap::<String, migration::LegacyMigrationIdentityConflict>::new();
        for branch in &request.version_graph.branches {
            let head_hash = branch
                .head_commit_id
                .as_deref()
                .and_then(|head| {
                    request
                        .version_graph
                        .commits
                        .iter()
                        .find(|commit| commit.id == head)
                })
                .map(migration_content_hash)
                .transpose()?;
            let content_hash = migration_content_hash(&(branch, head_hash))?;
            Self::collect_legacy_identity_conflict(
                &self.connection,
                &request.source_namespace,
                &request.target_document_id,
                "branch",
                &branch.id,
                &content_hash,
                &mut conflicts,
            )?;
        }
        for commit in &request.version_graph.commits {
            let content_hash = migration_content_hash(commit)?;
            Self::collect_legacy_identity_conflict(
                &self.connection,
                &request.source_namespace,
                &request.target_document_id,
                "commit",
                &commit.id,
                &content_hash,
                &mut conflicts,
            )?;
        }
        let mut result = conflicts.into_values().collect::<Vec<_>>();
        result.sort_by(|left, right| {
            left.entity_kind
                .cmp(&right.entity_kind)
                .then_with(|| left.legacy_id.cmp(&right.legacy_id))
        });
        Ok(result)
    }

    pub(super) fn collect_legacy_identity_conflict(
        connection: &Connection,
        namespace: &str,
        document_id: &str,
        entity_kind: &str,
        legacy_id: &str,
        content_hash: &str,
        conflicts: &mut HashMap<String, migration::LegacyMigrationIdentityConflict>,
    ) -> StorageResult<()> {
        let (variant_count, differing_count): (i64, i64) = connection.query_row(
            "SELECT COUNT(*), COUNT(CASE WHEN content_hash <> ?5 THEN 1 END)
             FROM legacy_entity_identity
             WHERE namespace = ?1 AND target_document_id = ?2 AND entity_kind = ?3 AND legacy_id = ?4",
            params![namespace, document_id, entity_kind, legacy_id, content_hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if differing_count > 0 {
            let conflict_key = migration::identity_conflict_key(namespace, entity_kind, legacy_id);
            conflicts.insert(
                conflict_key.clone(),
                migration::LegacyMigrationIdentityConflict {
                    conflict_key,
                    entity_kind: entity_kind.into(),
                    legacy_id: legacy_id.into(),
                    existing_variant_count: variant_count.min(u32::MAX as i64) as u32,
                },
            );
        }
        Ok(())
    }
}

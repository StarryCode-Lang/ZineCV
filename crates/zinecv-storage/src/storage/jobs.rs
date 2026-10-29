use super::mutation_receipts::{self, MutationScope};
use super::*;
use zinecv_contracts::{
    DeleteJobMaterialRequest, DocumentJobLink, JobMaterial, JobMaterialListResult,
    LinkJobMaterialRequest, UnlinkJobMaterialRequest, UpsertJobMaterialRequest,
};

impl Store {
    /// Resolve a selected immutable job reference from SQLite. A job reference
    /// supplies context only and never grants permission to edit resume fields.
    pub fn resolve_job_material_reference(
        &self,
        document_id: &str,
        reference_id: &str,
    ) -> StorageResult<Option<JobMaterial>> {
        read_job_reference(&self.connection, document_id, reference_id)
    }

    pub fn save_job_material(
        &mut self,
        actor: &str,
        request: &UpsertJobMaterialRequest,
    ) -> StorageResult<JobMaterial> {
        let mut scope = MutationScope {
            actor,
            kind: "job_material_save",
            command_id: &request.command_id,
            document_id: &request.document_id,
            revision: 0,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(result) = mutation_receipts::read(&transaction, &scope, request)? {
            return Ok(result);
        }
        if request.title.trim().is_empty() {
            return Err(StorageError::Validation("Job title is required".into()));
        }
        let available: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1 AND archived = 0)",
            [&request.document_id],
            |row| row.get(0),
        )?;
        if !available {
            return Err(StorageError::NotFound("Document not found".into()));
        }
        let material = match &request.job_material {
            None => {
                let id = format!("job:{}", request.command_id);
                transaction.execute(
                    "INSERT INTO job_materials(id, document_id, title, company, job_description, source_note, revision)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
                    params![id, request.document_id, request.title.trim(), request.company.trim(), request.job_description, request.source_note],
                )?;
                read_job_material_tx(&transaction, &id)?
            }
            Some(expected) => {
                let current = read_job_material_tx(&transaction, &expected.id)?;
                if current.document_id != request.document_id
                    || expected.document_id != request.document_id
                {
                    return Err(StorageError::Conflict(
                        "Job material belongs to a different document".into(),
                    ));
                }
                if current.revision != expected.revision {
                    return Err(StorageError::Conflict(
                        "Job material revision is stale".into(),
                    ));
                }
                let next_revision = current.revision.checked_add(1).ok_or_else(|| {
                    StorageError::Conflict("Job material revision exhausted".into())
                })?;
                transaction.execute(
                    "INSERT INTO job_material_revisions(job_material_id, revision, payload_json) VALUES (?1, ?2, ?3)",
                    params![current.id, current.revision, serde_json::to_string(&current)?],
                )?;
                transaction.execute(
                    "UPDATE job_materials SET title = ?2, company = ?3, job_description = ?4, source_note = ?5,
                     revision = ?6, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
                    params![current.id, request.title.trim(), request.company.trim(), request.job_description, request.source_note, next_revision],
                )?;
                read_job_material_tx(&transaction, &current.id)?
            }
        };
        scope.revision = i64::from(material.revision);
        mutation_receipts::write(&transaction, &scope, request, &material)?;
        transaction.commit()?;
        Ok(material)
    }

    pub fn list_job_materials(&self, document_id: &str) -> StorageResult<JobMaterialListResult> {
        let transaction = self.connection.unchecked_transaction()?;
        let materials = {
            let mut statement = transaction.prepare(
                "SELECT id FROM job_materials WHERE document_id = ?1 ORDER BY updated_at DESC, id",
            )?;
            let ids = statement
                .query_map([document_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.iter()
                .map(|id| read_job_material_tx(&transaction, id))
                .collect::<StorageResult<Vec<_>>>()?
        };
        let links = {
            let mut statement = transaction.prepare(
                "SELECT l.id FROM document_job_links l JOIN job_materials m ON m.id = l.job_material_id
                 WHERE l.document_id = ?1 AND m.document_id = ?1 ORDER BY l.created_at, l.id",
            )?;
            let ids = statement
                .query_map([document_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.iter()
                .map(|id| read_job_link_tx(&transaction, id)?.ok_or(StorageError::MissingDraft))
                .collect::<StorageResult<Vec<_>>>()?
        };
        let revisions = {
            let mut statement = transaction.prepare(
                "SELECT DISTINCT r.payload_json, r.job_material_id, r.revision FROM job_material_revisions r
                 JOIN document_job_links l ON l.job_material_id = r.job_material_id AND l.job_material_revision = r.revision
                 JOIN job_materials m ON m.id = r.job_material_id
                 WHERE l.document_id = ?1 AND m.document_id = ?1 ORDER BY r.job_material_id, r.revision",
            )?;
            let rows = statement
                .query_map([document_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|(json, id, revision)| {
                    let material: JobMaterial = serde_json::from_str(&json)?;
                    if material.document_id != document_id
                        || material.id != id
                        || i64::from(material.revision) != revision
                    {
                        return Err(StorageError::Corrupt(
                            "Historical job material identity does not match its link".into(),
                        ));
                    }
                    Ok(material)
                })
                .collect::<StorageResult<Vec<_>>>()?
        };
        transaction.commit()?;
        Ok(JobMaterialListResult {
            materials,
            links,
            revisions,
        })
    }

    pub fn delete_job_material(
        &mut self,
        actor: &str,
        request: &DeleteJobMaterialRequest,
    ) -> StorageResult<()> {
        let scope = MutationScope {
            actor,
            kind: "job_material_delete",
            command_id: &request.command_id,
            document_id: &request.document_id,
            revision: 0,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if mutation_receipts::read::<()>(&transaction, &scope, request)?.is_some() {
            return Ok(());
        }
        let current = read_job_material_tx(&transaction, &request.job_material_id)?;
        if current.document_id != request.document_id {
            return Err(StorageError::Conflict(
                "Job material belongs to a different document".into(),
            ));
        }
        transaction.execute(
            "DELETE FROM document_job_links WHERE job_material_id = ?1",
            [&request.job_material_id],
        )?;
        transaction.execute(
            "DELETE FROM job_material_revisions WHERE job_material_id = ?1",
            [&request.job_material_id],
        )?;
        transaction.execute(
            "DELETE FROM job_materials WHERE id = ?1",
            [&request.job_material_id],
        )?;
        mutation_receipts::write(&transaction, &scope, request, &())?;
        transaction.commit()?;
        Ok(())
    }

    pub fn link_job_material(
        &mut self,
        actor: &str,
        request: &LinkJobMaterialRequest,
    ) -> StorageResult<DocumentJobLink> {
        let scope = MutationScope {
            actor,
            kind: "job_material_link",
            command_id: &request.command_id,
            document_id: &request.cursor.document_id,
            revision: 0,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(result) = mutation_receipts::read(&transaction, &scope, request)? {
            return Ok(result);
        }
        mutation_receipts::validate_cursor(&transaction, &request.cursor)?;
        let material = read_job_material_tx(&transaction, &request.job_material_id)?;
        if material.document_id != request.cursor.document_id {
            return Err(StorageError::Conflict(
                "Job material belongs to a different document".into(),
            ));
        }
        if material.revision != request.job_material_revision {
            return Err(StorageError::Conflict(
                "Job material revision is stale".into(),
            ));
        }
        let branch_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM branches WHERE id = ?1 AND document_id = ?2)",
            params![request.branch_id, request.cursor.document_id],
            |row| row.get(0),
        )?;
        if !branch_exists {
            return Err(StorageError::NotFound("Branch not found".into()));
        }
        let existing: Option<String> = transaction.query_row(
            "SELECT id FROM document_job_links WHERE document_id = ?1 AND branch_id = ?2 AND job_material_id = ?3",
            params![request.cursor.document_id, request.branch_id, request.job_material_id], |row| row.get(0),
        ).optional()?;
        let id = if let Some(id) = existing {
            transaction.execute(
                "UPDATE document_job_links SET job_material_revision = ?2 WHERE id = ?1",
                params![id, request.job_material_revision],
            )?;
            id
        } else {
            let id = format!("joblink:{}", request.command_id);
            transaction.execute(
                "INSERT INTO document_job_links(id, document_id, job_material_id, job_material_revision, branch_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, request.cursor.document_id, request.job_material_id, request.job_material_revision, request.branch_id],
            )?;
            id
        };
        let link = read_job_link_tx(&transaction, &id)?.ok_or(StorageError::MissingDraft)?;
        mutation_receipts::write(&transaction, &scope, request, &link)?;
        transaction.commit()?;
        Ok(link)
    }

    pub fn unlink_job_material(
        &mut self,
        actor: &str,
        request: &UnlinkJobMaterialRequest,
    ) -> StorageResult<()> {
        let scope = MutationScope {
            actor,
            kind: "job_material_unlink",
            command_id: &request.command_id,
            document_id: &request.document_id,
            revision: 0,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if mutation_receipts::read::<()>(&transaction, &scope, request)?.is_some() {
            return Ok(());
        }
        let link = read_job_link_tx(&transaction, &request.link_id)?
            .ok_or_else(|| StorageError::NotFound("Job link not found".into()))?;
        if link.document_id != request.document_id {
            return Err(StorageError::Conflict(
                "Job link belongs to a different document".into(),
            ));
        }
        transaction.execute(
            "DELETE FROM document_job_links WHERE id = ?1",
            [&request.link_id],
        )?;
        mutation_receipts::write(&transaction, &scope, request, &())?;
        transaction.commit()?;
        Ok(())
    }
}

pub(super) fn read_job_reference(
    connection: &Connection,
    document_id: &str,
    reference_id: &str,
) -> StorageResult<Option<JobMaterial>> {
    let Some(identity) = reference_id.strip_prefix("job-material:") else {
        return Ok(None);
    };
    let (id, revision) = identity
        .rsplit_once(':')
        .ok_or_else(|| StorageError::Validation("Invalid job material reference".into()))?;
    let revision: u32 = revision
        .parse()
        .ok()
        .filter(|revision| *revision > 0)
        .ok_or_else(|| StorageError::Validation("Invalid job material revision".into()))?;
    let material = read_job_material_tx(connection, id)?;
    if material.document_id != document_id {
        return Err(StorageError::Permission(
            "Job material belongs to a different document".into(),
        ));
    }
    if material.revision != revision {
        return Err(StorageError::Conflict(
            "岗位材料已更新，请重新核对依据后生成建议".into(),
        ));
    }
    Ok(Some(material))
}

pub(super) fn validate_job_references(
    connection: &Connection,
    document_id: &str,
    reference_ids: &[String],
) -> StorageResult<()> {
    for reference in reference_ids {
        read_job_reference(connection, document_id, reference)?;
    }
    Ok(())
}

fn read_job_material_tx(
    connection: &Connection,
    id: &str,
) -> StorageResult<zinecv_contracts::JobMaterial> {
    connection
        .query_row(
            "SELECT id, document_id, title, company, job_description, source_note,
                    revision, created_at, updated_at
             FROM job_materials WHERE id = ?1",
            params![id],
            |row| {
                Ok(zinecv_contracts::JobMaterial {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    title: row.get(2)?,
                    company: row.get(3)?,
                    job_description: row.get(4)?,
                    source_note: row.get(5)?,
                    revision: row.get::<_, i64>(6)? as u32,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| StorageError::NotFound("Job material not found".into()))
}

fn read_job_link_tx(
    connection: &Connection,
    id: &str,
) -> StorageResult<Option<zinecv_contracts::DocumentJobLink>> {
    connection
        .query_row(
            "SELECT id, document_id, job_material_id, job_material_revision, branch_id, created_at
             FROM document_job_links WHERE id = ?1",
            params![id],
            |row| {
                Ok(zinecv_contracts::DocumentJobLink {
                    id: row.get(0)?,
                    document_id: row.get(1)?,
                    job_material_id: row.get(2)?,
                    job_material_revision: row.get::<_, i64>(3)? as u32,
                    branch_id: row.get(4)?,
                    created_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::from)
}

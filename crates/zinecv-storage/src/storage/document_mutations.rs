use super::mutation_receipts::{self, MutationScope};
use super::*;
use zinecv_contracts::{CreateDocumentPayload, CreateDocumentReceipt, CreateDocumentRequest};

impl Store {
    pub fn find_document_creation_receipt(
        &self,
        actor: &str,
        request: &CreateDocumentRequest,
    ) -> StorageResult<Option<CreateDocumentReceipt>> {
        let id = format!("doc:{}", request.command_id);
        let scope = MutationScope {
            actor,
            kind: "document_create",
            command_id: &request.command_id,
            document_id: &id,
            revision: 0,
        };
        mutation_receipts::read(&self.connection, &scope, request)
    }

    /// Host holds Store then active lock, and checks expected identity before a
    /// first execution. The document, selection and receipt commit together.
    pub fn create_document_with_receipt(
        &mut self,
        actor: &str,
        request: &CreateDocumentRequest,
    ) -> StorageResult<CreateDocumentReceipt> {
        let id = format!("doc:{}", request.command_id);
        let scope = MutationScope {
            actor,
            kind: "document_create",
            command_id: &request.command_id,
            document_id: &id,
            revision: 0,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) = mutation_receipts::read(&transaction, &scope, request)? {
            return Ok(receipt);
        }
        let (mut document, origin) = match &request.payload {
            CreateDocumentPayload::Blank { initial_title } => {
                let mut document =
                    zinecv_domain::default_resume_document(&id).map_err(StorageError::Domain)?;
                document.title = initial_title.trim().into();
                (document, "blank")
            }
            CreateDocumentPayload::Duplicate {
                source_document_id,
                initial_title,
            } => {
                if source_document_id != &request.expected_current_id {
                    return Err(StorageError::Conflict(
                        "Copy source is not the expected active document".into(),
                    ));
                }
                let json: Option<String> = transaction.query_row(
                    "SELECT COALESCE(
                        (SELECT document_json FROM drafts WHERE document_id = d.id AND context_id = d.active_context_id AND branch_id = d.current_branch_id),
                        (SELECT s.document_json FROM snapshots s JOIN commits c ON c.snapshot_id = s.id WHERE c.id = b.head_commit_id AND c.document_id = d.id))
                     FROM documents d JOIN branches b ON b.id = d.current_branch_id AND b.document_id = d.id
                     WHERE d.id = ?1 AND d.archived = 0", [source_document_id], |row| row.get(0),
                ).optional()?.flatten();
                let mut document: ResumeDocument =
                    serde_json::from_str(&json.ok_or(StorageError::MissingDraft)?)?;
                document.title = initial_title
                    .as_deref()
                    .map(str::trim)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} 副本", document.title));
                (document, "duplicated")
            }
        };
        if document.title.is_empty() {
            return Err(StorageError::Validation(
                "Document title is required".into(),
            ));
        }
        document.document_id = id.clone();
        if !Self::initialize_document_tx(
            &transaction,
            &document,
            &format!("workspace-context:{id}"),
        )? {
            return Err(StorageError::Conflict(
                "Document ID already exists without a matching receipt".into(),
            ));
        }
        transaction.execute(
            "UPDATE documents SET origin_kind = ?2 WHERE id = ?1",
            params![id, origin],
        )?;
        Self::persist_active_document_transition_tx(
            &transaction,
            Some(&request.expected_current_id),
            &id,
        )?;
        let receipt = CreateDocumentReceipt {
            command_id: request.command_id.clone(),
            document_id: id.clone(),
        };
        mutation_receipts::write(&transaction, &scope, request, &receipt)?;
        transaction.commit()?;
        Ok(receipt)
    }

    pub fn set_document_archived_with_receipt<R: Serialize>(
        &mut self,
        actor: &str,
        request: &R,
        command_id: &str,
        document_id: &str,
        states: (bool, bool),
        active_document_id: Option<&str>,
    ) -> StorageResult<()> {
        let (expected_archived, archived) = states;
        let scope = MutationScope {
            actor,
            kind: if archived {
                "document_archive"
            } else {
                "document_restore"
            },
            command_id,
            document_id,
            revision: 0,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if mutation_receipts::read::<bool>(&transaction, &scope, request)?.is_some() {
            return Ok(());
        }
        let current: Option<bool> = transaction
            .query_row(
                "SELECT archived FROM documents WHERE id = ?1",
                [document_id],
                |row| row.get(0),
            )
            .optional()?;
        if current != Some(expected_archived) {
            return Err(StorageError::Conflict(
                "Document archived state changed".into(),
            ));
        }
        if archived && active_document_id == Some(document_id) {
            return Err(StorageError::Conflict(
                "Active document cannot be archived".into(),
            ));
        }
        transaction.execute(
            "UPDATE documents SET archived = ?2, archived_at = CASE WHEN ?2 = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1", params![document_id, archived],
        )?;
        mutation_receipts::write(&transaction, &scope, request, &archived)?;
        transaction.commit()?;
        Ok(())
    }
}

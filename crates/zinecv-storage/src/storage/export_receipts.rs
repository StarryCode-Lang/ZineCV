use super::mutation_receipts::{self, MutationScope};
use super::*;
use zinecv_contracts::ExportReceipt;

impl Store {
    /// Only the native export writer calls this after re-reading a successful file.
    /// Frozen revisions remain valid provenance after the active document changes.
    pub fn record_export_receipt(
        &mut self,
        receipt: &ExportReceipt,
    ) -> StorageResult<ExportReceipt> {
        if !receipt.id.starts_with("export:")
            || receipt.id.len() > 160
            || receipt.artifact.sha256.len() != 64
            || receipt.artifact.bytes == 0
            || receipt.filename.is_empty()
            || receipt.filename.contains('/')
            || receipt.filename.contains('\\')
        {
            return Err(StorageError::Validation(
                "Invalid verified export receipt".into(),
            ));
        }
        let revision = receipt
            .cursor
            .revision
            .parse::<i64>()
            .map_err(|_| StorageError::Validation("Invalid export revision".into()))?;
        let scope = MutationScope {
            actor: "host-export",
            kind: "verified_export_write",
            command_id: &receipt.id,
            document_id: &receipt.cursor.document_id,
            revision,
        };
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) = mutation_receipts::read(&transaction, &scope, receipt)? {
            return Ok(existing);
        }
        mutation_receipts::write(&transaction, &scope, receipt, receipt)?;
        transaction.commit()?;
        Ok(receipt.clone())
    }

    pub fn recent_export_receipts(&self, document_id: &str) -> StorageResult<Vec<ExportReceipt>> {
        let mut statement = self.connection.prepare(
            "SELECT command_id, result_json, result_hash FROM command_receipts
             WHERE actor = 'host-export' AND document_id = ?1 AND command_id >= 'export:' AND command_id < 'export;'
             ORDER BY command_id DESC LIMIT 20",
        )?;
        let rows = statement
            .query_map([document_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, json, hash)| {
                let value: serde_json::Value = serde_json::from_str(&json)?;
                if canonical_hash(&value)? != hash {
                    return Err(StorageError::HashMismatch);
                }
                let receipt: ExportReceipt = serde_json::from_value(value)?;
                if receipt.id != id || receipt.cursor.document_id != document_id {
                    return Err(StorageError::Corrupt(
                        "Export receipt identity does not match its document".into(),
                    ));
                }
                Ok(receipt)
            })
            .collect()
    }
}

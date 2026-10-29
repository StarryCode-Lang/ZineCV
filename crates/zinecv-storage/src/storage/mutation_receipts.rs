use super::*;
use serde::de::DeserializeOwned;

pub(super) struct MutationScope<'a> {
    pub actor: &'a str,
    pub kind: &'a str,
    pub command_id: &'a str,
    pub document_id: &'a str,
    pub revision: i64,
}

fn request_hash(scope: &MutationScope<'_>, request: &impl Serialize) -> StorageResult<String> {
    if scope.command_id.trim().is_empty()
        || scope.command_id.len() > 160
        || scope.actor.trim().is_empty()
    {
        return Err(StorageError::Validation("Invalid mutation identity".into()));
    }
    Ok(canonical_hash(
        &serde_json::json!({ "operation": scope.kind, "version": 1, "request": request }),
    )?)
}

pub(super) fn read<T: DeserializeOwned>(
    connection: &Connection,
    scope: &MutationScope<'_>,
    request: &impl Serialize,
) -> StorageResult<Option<T>> {
    let expected_hash = request_hash(scope, request)?;
    let row: Option<(String, String, String, String)> = connection.query_row(
        "SELECT actor, request_hash, result_json, result_hash FROM command_receipts WHERE command_id = ?1",
        [scope.command_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    let Some((actor, hash, json, result_hash)) = row else {
        return Ok(None);
    };
    if actor != scope.actor || hash != expected_hash {
        return Err(StorageError::Conflict(
            "Command ID was reused with a different request".into(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&json)?;
    if canonical_hash(&value)? != result_hash {
        return Err(StorageError::HashMismatch);
    }
    Ok(Some(serde_json::from_value(value)?))
}

pub(super) fn write(
    connection: &Connection,
    scope: &MutationScope<'_>,
    request: &impl Serialize,
    result: &impl Serialize,
) -> StorageResult<()> {
    let result_value = serde_json::to_value(result)?;
    connection.execute(
        "INSERT INTO command_receipts(command_id, document_id, actor, request_hash, result_json, result_hash, revision)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![scope.command_id, scope.document_id, scope.actor, request_hash(scope, request)?,
            serde_json::to_string(&result_value)?, canonical_hash(&result_value)?, scope.revision],
    )?;
    Ok(())
}

impl Store {
    /// Replay lookup precedes volatile host preconditions; it never applies work.
    pub fn has_mutation_receipt(
        &self,
        actor: &str,
        kind: &str,
        command_id: &str,
        request: &impl Serialize,
    ) -> StorageResult<bool> {
        let scope = MutationScope {
            actor,
            kind,
            command_id,
            document_id: "",
            revision: 0,
        };
        Ok(read::<serde_json::Value>(&self.connection, &scope, request)?.is_some())
    }
}

pub(super) fn validate_cursor(
    connection: &Connection,
    expected: &AuthorityCursor,
) -> StorageResult<()> {
    let actual: Option<AuthorityCursor> = connection
        .query_row(
            "SELECT d.active_context_id, d.current_branch_id, d.revision, b.head_commit_id
         FROM documents d JOIN branches b ON b.id = d.current_branch_id AND b.document_id = d.id
         WHERE d.id = ?1 AND d.archived = 0",
            [&expected.document_id],
            |row| {
                Ok(AuthorityCursor {
                    document_id: expected.document_id.clone(),
                    context_id: row.get(0)?,
                    branch_id: row.get(1)?,
                    revision: row.get::<_, i64>(2)?.to_string(),
                    head_id: row.get(3)?,
                })
            },
        )
        .optional()?;
    if actual.as_ref() != Some(expected) {
        return Err(StorageError::Conflict("Stale authority cursor".into()));
    }
    Ok(())
}

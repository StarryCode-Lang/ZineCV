use super::*;

pub(super) fn retain_proposal_assets(
    transaction: &Transaction<'_>,
    proposal_id: &str,
    items: &[AgentProposalItem],
) -> StorageResult<()> {
    for item in items {
        if !matches!(&item.change, ProposalChange::UpdateBasic { patch } if patch.avatar_asset_id.is_some())
        {
            continue;
        }
        for value in [&item.before_value, &item.after_value] {
            let Some(hash) = value
                .get("avatarAssetId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let mime: Option<String> = transaction
                .query_row("SELECT mime FROM resources WHERE hash=?1", [hash], |row| {
                    row.get(0)
                })
                .optional()?;
            if !mime
                .as_deref()
                .is_some_and(|mime| matches!(mime, "image/png" | "image/jpeg" | "image/webp"))
            {
                return Err(StorageError::Validation(
                    "Avatar proposal requires an existing supported image asset".into(),
                ));
            }
            transaction.execute(
                "INSERT OR IGNORE INTO resource_refs(resource_hash,owner_kind,owner_id) VALUES (?1,'proposal-asset',?2)",
                params![hash,proposal_id],
            )?;
        }
    }
    Ok(())
}

pub(super) fn load_active_document(
    connection: &Connection,
    expected: &AuthorityCursor,
) -> StorageResult<(AuthorityCursor, ResumeDocument)> {
    let authority: Option<(String, String, i64)> = connection
        .query_row(
            "SELECT active_context_id, current_branch_id, revision FROM documents WHERE id = ?1",
            [&expected.document_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((context_id, branch_id, revision)) = authority else {
        return Err(StorageError::NotFound("Document was not found".into()));
    };
    let head_id: Option<String> = connection
        .query_row(
            "SELECT head_commit_id FROM branches WHERE id = ?1 AND document_id = ?2",
            params![branch_id, expected.document_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let cursor = AuthorityCursor {
        document_id: expected.document_id.clone(),
        context_id: context_id.clone(),
        revision: revision.to_string(),
        branch_id: branch_id.clone(),
        head_id: head_id.clone(),
    };
    let draft: Option<String> = connection
        .query_row(
            "SELECT document_json FROM drafts
             WHERE document_id = ?1 AND context_id = ?2 AND branch_id = ?3",
            params![expected.document_id, context_id, branch_id],
            |row| row.get(0),
        )
        .optional()?;
    let document = if let Some(json) = draft {
        serde_json::from_str(&json)?
    } else if let Some(head_id) = head_id {
        let json: String = connection.query_row(
            "SELECT s.document_json FROM snapshots s JOIN commits c ON c.snapshot_id = s.id
             WHERE c.id = ?1 AND c.document_id = ?2",
            params![head_id, expected.document_id],
            |row| row.get(0),
        )?;
        serde_json::from_str(&json)?
    } else {
        return Err(StorageError::NotFound(
            "Active document draft or snapshot was not found".into(),
        ));
    };
    Ok((cursor, document))
}

pub(super) fn save_document_tx(
    transaction: &Transaction<'_>,
    base: &AuthorityCursor,
    document: &ResumeDocument,
    result: &AuthorityCursor,
) -> StorageResult<()> {
    let base_revision = parse_revision(&base.revision)?;
    let result_revision = parse_revision(&result.revision)?;
    let json = serde_json::to_string(document)?;
    let hash = canonical_hash(document)?;
    let updated = transaction.execute(
        "UPDATE documents SET title = ?1, revision = ?2
         WHERE id = ?3 AND active_context_id = ?4 AND current_branch_id = ?5 AND revision = ?6",
        params![
            document.title,
            result_revision as i64,
            base.document_id,
            base.context_id,
            base.branch_id,
            base_revision as i64
        ],
    )?;
    if updated != 1 {
        return Err(StorageError::Conflict("Stale authority cursor".into()));
    }
    transaction.execute(
        "INSERT INTO drafts(document_id, context_id, branch_id, revision, document_json, hash, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
         ON CONFLICT(document_id, context_id, branch_id) DO UPDATE SET
           revision = excluded.revision, document_json = excluded.document_json,
           hash = excluded.hash, updated_at = CURRENT_TIMESTAMP",
        params![
            base.document_id,
            base.context_id,
            base.branch_id,
            result_revision as i64,
            json,
            hash
        ],
    )?;
    Store::sync_draft_resource_owner(
        transaction,
        &base.document_id,
        &base.context_id,
        &base.branch_id,
        &json,
    )?;
    transaction.execute(
        "DELETE FROM resource_refs WHERE owner_kind = 'document-avatar' AND owner_id = ?1",
        [&base.document_id],
    )?;
    Ok(())
}

pub(super) fn load_proposal(
    connection: &Connection,
    account_id: &str,
    proposal_id: &str,
) -> StorageResult<Option<AgentProposalRecord>> {
    let row: Option<AgentProposalSqlRow> = connection
        .query_row(
            "SELECT id, run_id, account_id, session_id, document_id, context_id, base_revision,
                    branch_id, head_id, scope_hash, explanation, created_at, expires_at,
                    status, items_json
             FROM agent_proposals WHERE id = ?1 AND account_id = ?2",
            params![proposal_id, account_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                ))
            },
        )
        .optional()?;
    let Some((
        id,
        run_id,
        account_id,
        session_id,
        document_id,
        context_id,
        revision,
        branch_id,
        head_id,
        scope_hash,
        explanation,
        created_at,
        expires_at,
        status,
        items_json,
    )) = row
    else {
        return Ok(None);
    };
    let status = parse_status(&status)?;
    let items = serde_json::from_str(&items_json)?;
    Ok(Some(AgentProposalRecord {
        id,
        run_id,
        account_id,
        session_id,
        document_id: document_id.clone(),
        cursor: AuthorityCursor {
            document_id,
            context_id,
            revision,
            branch_id,
            head_id,
        },
        scope_hash,
        explanation,
        created_at,
        expires_at,
        status,
        items,
    }))
}

pub(super) fn parse_status(status: &str) -> StorageResult<AgentProposalStatus> {
    match status {
        "pending" => Ok(AgentProposalStatus::Pending),
        "confirmed" => Ok(AgentProposalStatus::Confirmed),
        "rejected" => Ok(AgentProposalStatus::Rejected),
        "undone" => Ok(AgentProposalStatus::Undone),
        "expired" => Ok(AgentProposalStatus::Expired),
        _ => Err(StorageError::Corrupt(
            "Unknown agent proposal status".into(),
        )),
    }
}

pub(super) fn validate_identifier(value: &str, max: usize, field: &str) -> StorageResult<()> {
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StorageError::Validation(format!("Invalid {field}")));
    }
    Ok(())
}

pub(super) fn parse_revision(value: &str) -> StorageResult<u64> {
    value
        .parse::<u64>()
        .map_err(|_| StorageError::Validation("Invalid authority revision".into()))
}

pub(super) fn proposal_expired(connection: &Connection, proposal_id: &str) -> StorageResult<bool> {
    Ok(connection.query_row(
        "SELECT expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM agent_proposals WHERE id = ?1",
        [proposal_id],
        |row| row.get(0),
    )?)
}

pub(super) fn verify_record_scope(record: &AgentProposalRecord) -> StorageResult<()> {
    let mut refs = BTreeSet::new();
    for item in &record.items {
        if !refs.insert(item.reference_id.as_str()) {
            return Err(StorageError::Corrupt(
                "Stored proposal contains duplicate scoped references".into(),
            ));
        }
    }
    let sorted = refs.into_iter().collect::<Vec<_>>();
    if canonical_hash(&sorted)? != record.scope_hash {
        return Err(StorageError::Corrupt(
            "Stored proposal scope hash is invalid".into(),
        ));
    }
    Ok(())
}

pub(super) fn find_idempotent_receipt(
    connection: &Connection,
    account_id: &str,
    command_id: &str,
    request_hash: &str,
) -> StorageResult<Option<AgentProposalReceipt>> {
    let existing: Option<(String, String, String)> = connection
        .query_row(
            "SELECT account_id, request_hash, result_json
             FROM agent_proposal_receipts WHERE command_id = ?1",
            [command_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((stored_account, stored_hash, result_json)) = existing else {
        return Ok(None);
    };
    if stored_account != account_id || stored_hash != request_hash {
        return Err(StorageError::Conflict(
            "Proposal command ID was reused with a different request".into(),
        ));
    }
    let mut receipt: AgentProposalReceipt = serde_json::from_str(&result_json)?;
    receipt.idempotent_replay = true;
    Ok(Some(receipt))
}

pub(super) fn receipt_id(account_id: &str, command_id: &str, request_hash: &str) -> String {
    let digest = canonical_hash(&(account_id, command_id, request_hash))
        .unwrap_or_else(|_| format!("{account_id}:{command_id}:{request_hash}"));
    format!("receipt-{digest}")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn insert_receipt(
    transaction: &Transaction<'_>,
    account_id: &str,
    command_id: &str,
    proposal_id: &str,
    operation: &str,
    request_hash: &str,
    cursor: &AuthorityCursor,
    accepted_item_ids: &[String],
    undo_of_receipt_id: Option<&str>,
    _status: AgentProposalStatus,
) -> StorageResult<String> {
    let id = receipt_id(account_id, command_id, request_hash);
    transaction.execute(
        "INSERT INTO agent_proposal_receipts(
           id, command_id, proposal_id, account_id, operation, request_hash,
           cursor_json, accepted_item_ids_json, undo_of_receipt_id, result_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '{}')",
        params![
            id,
            command_id,
            proposal_id,
            account_id,
            operation,
            request_hash,
            serde_json::to_string(cursor)?,
            serde_json::to_string(accepted_item_ids)?,
            undo_of_receipt_id
        ],
    )?;
    Ok(transaction.query_row(
        "SELECT created_at FROM agent_proposal_receipts WHERE id = ?1",
        [&id],
        |row| row.get(0),
    )?)
}

pub(super) fn persist_receipt_result(
    transaction: &Transaction<'_>,
    receipt: &AgentProposalReceipt,
) -> StorageResult<()> {
    transaction.execute(
        "UPDATE agent_proposal_receipts SET result_json = ?2 WHERE id = ?1",
        params![receipt.id, serde_json::to_string(receipt)?],
    )?;
    Ok(())
}

pub(super) fn update_lifecycle_if_settled(
    transaction: &Transaction<'_>,
    run_id: &str,
) -> StorageResult<()> {
    transaction.execute(
        "UPDATE agent_run_lifecycle SET state = 'completed',
           awaiting_confirmation_since = NULL,
           confirmation_wait_ms = confirmation_wait_ms + CASE
             WHEN awaiting_confirmation_since IS NULL THEN 0
             ELSE MAX(0, CAST(strftime('%s','now') AS INTEGER) * 1000 - awaiting_confirmation_since)
           END,
           updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
         WHERE run_id = ?1 AND state = 'awaiting_confirmation'
           AND NOT EXISTS(
             SELECT 1 FROM agent_proposals p
             WHERE p.run_id = ?1 AND p.status = 'pending'
           )",
        [run_id],
    )?;
    Ok(())
}

pub(super) fn proposal_command(
    document: &ResumeDocument,
    change: &ProposalChange,
) -> StorageResult<Option<DomainCommand>> {
    let command = match change.clone() {
        ProposalChange::SetDocumentTitle { title } => DomainCommand::SetDocumentTitle { title },
        ProposalChange::RenameSection { section_id, title } => {
            DomainCommand::RenameSection { section_id, title }
        }
        ProposalChange::SetSectionVisibility {
            section_id,
            visible,
        } => DomainCommand::SetSectionVisibility {
            section_id,
            visible,
        },
        ProposalChange::MoveSection { section_id, index } => {
            DomainCommand::MoveSection { section_id, index }
        }
        ProposalChange::SetEntryBody { entry_id, body } => {
            DomainCommand::SetEntryBody { entry_id, body }
        }
        ProposalChange::SetSummaryBody { section_id, body } => {
            DomainCommand::SetSummaryBody { section_id, body }
        }
        ProposalChange::UpdateEntryFields {
            entry_id,
            title,
            role,
            department,
            city,
            start,
            end,
            college,
            mode,
        } => DomainCommand::UpdateEntryFields {
            entry_id,
            title,
            role,
            department,
            city,
            start,
            end,
            college,
            mode,
        },
        ProposalChange::AddEntry { section_id, entry } => {
            DomainCommand::AddEntry { section_id, entry }
        }
        ProposalChange::DeleteEntry { entry_id } => DomainCommand::DeleteEntry { entry_id },
        ProposalChange::MoveEntry {
            entry_id,
            section_id,
            index,
        } => DomainCommand::MoveEntry {
            entry_id,
            section_id,
            index,
        },
        ProposalChange::UpdateBasic { patch } => DomainCommand::UpdateBasic { patch },
        ProposalChange::ApplyTemplate { template_id } => {
            let mut presentation = document.presentation.clone();
            presentation.template_id = template_id;
            DomainCommand::SetLayout { presentation }
        }
        // 版本副作用在确认事务里单独处理，不产生正文领域命令。
        ProposalChange::CommitVersion { .. } => return Ok(None),
    };
    Ok(Some(command))
}

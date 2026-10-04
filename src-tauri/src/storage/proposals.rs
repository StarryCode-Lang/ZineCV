use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};

use crate::domain::{
    canonical_hash, AgentProposalDraft, AgentProposalInbox, AgentProposalItem,
    AgentProposalReceipt, AgentProposalRecord, AgentProposalStatus, AgentProposalUndoRecord,
    AuthorityCursor, BasicField, BasicInfo, CommandEnvelope, DomainCommand, ProposalChange,
    ResumeDocument, Section,
};

use super::{StorageError, StorageResult, Store};

const MAX_PROPOSAL_ITEMS: usize = 12;
type AgentRunProposalScope = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
);
type AgentProposalSqlRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    String,
    String,
);

impl Store {
    pub fn create_agent_proposals(
        &mut self,
        account_id: &str,
        run_id: &str,
        target: &AuthorityCursor,
        drafts: &[AgentProposalDraft],
    ) -> StorageResult<Vec<AgentProposalRecord>> {
        if drafts.is_empty() {
            return Ok(Vec::new());
        }
        if drafts.len() > MAX_PROPOSAL_ITEMS {
            return Err(StorageError::Validation("Too many agent proposals".into()));
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run: Option<AgentRunProposalScope> = transaction
            .query_row(
                "SELECT session_id, document_id, context_id, revision, branch_id, head_id,
                            reference_ids_json
                     FROM agent_runs WHERE id = ?1 AND account_id = ?2",
                params![run_id, account_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((session_id, document_id, context_id, revision, branch_id, head_id, refs_json)) =
            run
        else {
            return Err(StorageError::Permission(
                "Agent run does not belong to the active account".into(),
            ));
        };
        let run_cursor = AuthorityCursor {
            document_id,
            context_id,
            revision,
            branch_id,
            head_id,
        };
        if &run_cursor != target {
            return Err(StorageError::Conflict(
                "Agent run cursor does not match proposal target".into(),
            ));
        }
        let allowed_refs: BTreeSet<String> = serde_json::from_str::<Vec<String>>(&refs_json)?
            .into_iter()
            .collect();
        let (actual_cursor, document) = load_active_document(&transaction, target)?;
        if &actual_cursor != target {
            return Err(StorageError::Conflict(
                "Document changed before agent proposal persistence".into(),
            ));
        }

        let actor = account_id;
        let base_revision = parse_revision(&target.revision)?;
        let mut records = Vec::with_capacity(drafts.len());
        let mut all_ids = BTreeSet::new();
        for draft in drafts {
            validate_identifier(&draft.id, 160, "proposal ID")?;
            if !all_ids.insert(draft.id.as_str())
                || draft.explanation.trim().is_empty()
                || draft.explanation.chars().count() > 2_000
                || draft.items.is_empty()
                || draft.items.len() > MAX_PROPOSAL_ITEMS
            {
                return Err(StorageError::Validation(
                    "Agent proposal draft is invalid".into(),
                ));
            }

            let mut refs = BTreeSet::new();
            let mut touched = BTreeSet::new();
            for item in &draft.items {
                validate_identifier(&item.id, 160, "proposal item ID")?;
                validate_identifier(&item.reference_id, 256, "proposal reference ID")?;
                if !allowed_refs.contains(&item.reference_id)
                    || !refs.insert(item.reference_id.as_str())
                {
                    return Err(StorageError::Permission(
                        "Proposal target was not explicitly selected".into(),
                    ));
                }
                if matches!(&item.change, ProposalChange::UpdateBasic { patch } if patch.avatar_asset_id.is_some())
                    && item.reference_id != "basic:avatar"
                {
                    return Err(StorageError::Permission(
                        "Avatar proposal requires an explicit avatar reference".into(),
                    ));
                }
                for key in scope_keys(&document, &item.change)? {
                    if !touched.insert(key) {
                        return Err(StorageError::Validation(
                            "Proposal items overlap the same document scope".into(),
                        ));
                    }
                }
            }
            let sorted_refs = refs.into_iter().collect::<Vec<_>>();
            let scope_hash = canonical_hash(&sorted_refs)?;
            let mut context = crate::domain::DocumentContext::with_authority(
                document.clone(),
                base_revision,
                target.branch_id.clone(),
                target.head_id.clone(),
            )
            .map_err(StorageError::Domain)?;
            let mut items = Vec::with_capacity(draft.items.len());
            for (index, item) in draft.items.iter().enumerate() {
                let before_value = change_target_value(context.document(), &item.change)?;
                let after_value = if matches!(item.change, ProposalChange::CommitVersion { .. }) {
                    // 版本副作用不改正文：提议值只绑定提交消息本身。
                    before_value.clone()
                } else {
                    let cursor = context.cursor(&target.context_id);
                    let payload =
                        proposal_command(context.document(), &item.change)?.ok_or_else(|| {
                            StorageError::Validation(
                                "Version side effects do not produce a document command".into(),
                            )
                        })?;
                    let result = context
                        .apply_command(
                            actor,
                            &target.context_id,
                            CommandEnvelope {
                                protocol_version: 1,
                                command_id: format!("{}-stage-{index}", draft.id),
                                document_id: target.document_id.clone(),
                                context_id: target.context_id.clone(),
                                expected_revision: cursor.revision,
                                expected_branch_id: cursor.branch_id,
                                expected_head_id: cursor.head_id,
                                payload,
                            },
                        )
                        .map_err(StorageError::Domain)?;
                    change_target_value(&result.document, &item.change)?
                };
                items.push(AgentProposalItem {
                    id: item.id.clone(),
                    summary: item.summary.chars().take(240).collect(),
                    reference_id: item.reference_id.clone(),
                    change: item.change.clone(),
                    before_value,
                    after_value,
                });
            }
            let item_json = serde_json::to_string(&items)?;
            if item_json.len() > 48 * 1024 {
                return Err(StorageError::Validation(
                    "Agent proposal exceeds the durable size budget".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO agent_proposals(
                   id, run_id, account_id, session_id, document_id, context_id,
                   base_revision, branch_id, head_id, scope_hash, explanation,
                   expires_at, status, items_json
                 ) VALUES (
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                   strftime('%Y-%m-%dT%H:%M:%fZ','now', '+24 hours'), 'pending', ?12
                 )",
                params![
                    draft.id,
                    run_id,
                    account_id,
                    session_id,
                    target.document_id,
                    target.context_id,
                    target.revision,
                    target.branch_id,
                    target.head_id,
                    scope_hash,
                    draft.explanation,
                    item_json
                ],
            )?;
            retain_proposal_assets(&transaction, &draft.id, &items)?;
            records.push(
                load_proposal(&transaction, account_id, &draft.id)?.ok_or_else(|| {
                    StorageError::Corrupt("Persisted agent proposal could not be loaded".into())
                })?,
            );
        }
        transaction.commit()?;
        Ok(records)
    }

    pub fn list_agent_proposals(&mut self, account_id: &str) -> StorageResult<AgentProposalInbox> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expiring_runs = {
            let mut statement = transaction.prepare(
                "SELECT DISTINCT run_id FROM agent_proposals
                 WHERE account_id = ?1 AND status = 'pending'
                   AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            )?;
            let rows = statement
                .query_map([account_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        transaction.execute(
            "UPDATE agent_proposals SET status = 'expired'
             WHERE account_id = ?1 AND status = 'pending'
               AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')",
            [account_id],
        )?;
        for run_id in expiring_runs {
            update_lifecycle_if_settled(&transaction, &run_id)?;
        }
        let ids = {
            let mut statement = transaction.prepare(
                "SELECT id FROM agent_proposals WHERE account_id = ?1 AND status = 'pending'
                 ORDER BY created_at DESC, id DESC LIMIT 100",
            )?;
            let rows = statement
                .query_map([account_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut pending = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(record) = load_proposal(&transaction, account_id, &id)? {
                pending.push(record);
            }
        }
        let undoable = {
            let mut statement = transaction.prepare(
                "SELECT r.id, r.proposal_id, p.session_id, r.cursor_json,
                        r.accepted_item_ids_json, r.created_at
                 FROM agent_proposal_receipts r
                 JOIN agent_proposals p ON p.id = r.proposal_id
                 WHERE r.account_id = ?1 AND r.operation = 'confirm'
                   AND p.status = 'confirmed'
                   AND NOT EXISTS (
                     SELECT 1 FROM agent_proposal_receipts undo
                     WHERE undo.undo_of_receipt_id = r.id
                   )
                 ORDER BY r.created_at DESC, r.id DESC LIMIT 100",
            )?;
            let rows = statement
                .query_map([account_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(
                    |(
                        receipt_id,
                        proposal_id,
                        session_id,
                        cursor_json,
                        accepted_json,
                        created_at,
                    )| {
                        let cursor_json = cursor_json.ok_or_else(|| {
                            StorageError::Corrupt("Confirmation receipt has no cursor".into())
                        })?;
                        Ok(AgentProposalUndoRecord {
                            receipt_id,
                            proposal_id,
                            session_id,
                            cursor: serde_json::from_str(&cursor_json)?,
                            accepted_item_ids: serde_json::from_str(&accepted_json)?,
                            created_at,
                        })
                    },
                )
                .collect::<StorageResult<Vec<_>>>()?
        };
        transaction.commit()?;
        Ok(AgentProposalInbox { pending, undoable })
    }

    pub fn confirm_agent_proposal(
        &mut self,
        account_id: &str,
        request: &crate::domain::ConfirmProposalRequest,
    ) -> StorageResult<AgentProposalReceipt> {
        let request_hash = canonical_hash(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) =
            find_idempotent_receipt(&transaction, account_id, &request.command_id, &request_hash)?
        {
            transaction.commit()?;
            return Ok(receipt);
        }
        let record = load_proposal(&transaction, account_id, &request.proposal_id)?
            .ok_or_else(|| StorageError::NotFound("Agent proposal was not found".into()))?;
        if record.status != AgentProposalStatus::Pending {
            return Err(StorageError::Conflict(
                "Agent proposal is no longer pending".into(),
            ));
        }
        if proposal_expired(&transaction, &record.id)? {
            transaction.execute(
                "UPDATE agent_proposals SET status = 'expired' WHERE id = ?1 AND status = 'pending'",
                [&record.id],
            )?;
            update_lifecycle_if_settled(&transaction, &record.run_id)?;
            transaction.commit()?;
            return Err(StorageError::Conflict("Agent proposal expired".into()));
        }
        if request.accepted_item_ids.is_empty() {
            return Err(StorageError::Validation(
                "Confirm at least one proposal item".into(),
            ));
        }
        if record.cursor != request.cursor {
            return Err(StorageError::Conflict(
                "Proposal cursor does not match the confirmation cursor".into(),
            ));
        }
        verify_record_scope(&record)?;
        let mut accepted = BTreeSet::new();
        for id in &request.accepted_item_ids {
            if !accepted.insert(id.as_str()) || !record.items.iter().any(|item| item.id == *id) {
                return Err(StorageError::Validation(
                    "Accepted proposal item IDs are invalid".into(),
                ));
            }
        }
        let (actual_cursor, document) = load_active_document(&transaction, &request.cursor)?;
        if actual_cursor != request.cursor {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        let base_revision = parse_revision(&request.cursor.revision)?;
        let mut context = crate::domain::DocumentContext::with_authority(
            document,
            base_revision,
            request.cursor.branch_id.clone(),
            request.cursor.head_id.clone(),
        )
        .map_err(StorageError::Domain)?;
        let mut applied_ids = Vec::new();
        let mut last_result: Option<crate::domain::CommandResult> = None;
        let mut version_message: Option<String> = None;
        for (index, item) in record.items.iter().enumerate() {
            if !accepted.contains(item.id.as_str()) {
                continue;
            }
            if change_target_value(context.document(), &item.change)? != item.before_value {
                return Err(StorageError::Conflict(format!(
                    "Proposal before-value changed for item {}",
                    item.id
                )));
            }
            if let ProposalChange::CommitVersion { message } = &item.change {
                if version_message.is_some() {
                    return Err(StorageError::Validation(
                        "At most one version side effect per confirmation".into(),
                    ));
                }
                let trimmed = message.trim();
                if trimmed.is_empty() || trimmed.chars().count() > 200 {
                    return Err(StorageError::Validation(
                        "Version commit message is invalid".into(),
                    ));
                }
                version_message = Some(trimmed.to_string());
                applied_ids.push(item.id.clone());
                continue;
            }
            let payload = proposal_command(context.document(), &item.change)?.ok_or_else(|| {
                StorageError::Validation(
                    "Version side effects do not produce a document command".into(),
                )
            })?;
            let cursor = context.cursor(&request.cursor.context_id);
            let result = context
                .apply_command(
                    account_id,
                    &request.cursor.context_id,
                    CommandEnvelope {
                        protocol_version: 1,
                        command_id: format!("{}-apply-{index}", request.command_id),
                        document_id: request.cursor.document_id.clone(),
                        context_id: request.cursor.context_id.clone(),
                        expected_revision: cursor.revision,
                        expected_branch_id: cursor.branch_id,
                        expected_head_id: cursor.head_id,
                        payload,
                    },
                )
                .map_err(StorageError::Domain)?;
            if change_target_value(&result.document, &item.change)? != item.after_value {
                return Err(StorageError::Conflict(
                    "Stored proposal after-value is invalid".into(),
                ));
            }
            applied_ids.push(item.id.clone());
            last_result = Some(result);
        }
        if last_result.is_none() && version_message.is_none() {
            return Err(StorageError::Validation(
                "No proposal items were selected".into(),
            ));
        }
        let mut final_cursor = match last_result {
            Some(result) => {
                save_document_tx(
                    &transaction,
                    &request.cursor,
                    &result.document,
                    &result.cursor,
                )?;
                result.cursor
            }
            None => request.cursor.clone(),
        };
        if let Some(message) = version_message {
            final_cursor = Self::commit_draft_core(&transaction, &final_cursor, &message)?;
        }
        let created_at = insert_receipt(
            &transaction,
            account_id,
            &request.command_id,
            &record.id,
            "confirm",
            &request_hash,
            &final_cursor,
            &applied_ids,
            None,
            AgentProposalStatus::Confirmed,
        )?;
        transaction.execute(
            "UPDATE agent_proposals SET status = 'confirmed' WHERE id = ?1 AND account_id = ?2 AND status = 'pending'",
            params![record.id, account_id],
        )?;
        let receipt = AgentProposalReceipt {
            id: receipt_id(account_id, &request.command_id, &request_hash),
            command_id: request.command_id.clone(),
            proposal_id: record.id,
            cursor: final_cursor,
            status: AgentProposalStatus::Confirmed,
            accepted_item_ids: applied_ids,
            created_at,
            idempotent_replay: false,
        };
        update_lifecycle_if_settled(&transaction, &record.run_id)?;
        persist_receipt_result(&transaction, &receipt)?;
        transaction.commit()?;
        Ok(receipt)
    }

    pub fn reject_agent_proposal(
        &mut self,
        account_id: &str,
        request: &crate::domain::RejectAgentProposalRequest,
    ) -> StorageResult<AgentProposalReceipt> {
        let request_hash = canonical_hash(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) =
            find_idempotent_receipt(&transaction, account_id, &request.command_id, &request_hash)?
        {
            transaction.commit()?;
            return Ok(receipt);
        }
        let record = load_proposal(&transaction, account_id, &request.proposal_id)?
            .ok_or_else(|| StorageError::NotFound("Agent proposal was not found".into()))?;
        if record.status != AgentProposalStatus::Pending {
            return Err(StorageError::Conflict(
                "Agent proposal is no longer pending".into(),
            ));
        }
        if proposal_expired(&transaction, &record.id)? {
            transaction.execute(
                "UPDATE agent_proposals SET status = 'expired' WHERE id = ?1 AND status = 'pending'",
                [&record.id],
            )?;
            update_lifecycle_if_settled(&transaction, &record.run_id)?;
            transaction.commit()?;
            return Err(StorageError::Conflict("Agent proposal expired".into()));
        }
        transaction.execute(
            "UPDATE agent_proposals SET status = 'rejected' WHERE id = ?1 AND account_id = ?2 AND status = 'pending'",
            params![record.id, account_id],
        )?;
        let created_at = insert_receipt(
            &transaction,
            account_id,
            &request.command_id,
            &record.id,
            "reject",
            &request_hash,
            &record.cursor,
            &[],
            None,
            AgentProposalStatus::Rejected,
        )?;
        let receipt = AgentProposalReceipt {
            id: receipt_id(account_id, &request.command_id, &request_hash),
            command_id: request.command_id.clone(),
            proposal_id: record.id,
            cursor: record.cursor,
            status: AgentProposalStatus::Rejected,
            accepted_item_ids: Vec::new(),
            created_at,
            idempotent_replay: false,
        };
        update_lifecycle_if_settled(&transaction, &record.run_id)?;
        persist_receipt_result(&transaction, &receipt)?;
        transaction.commit()?;
        Ok(receipt)
    }

    pub fn undo_agent_proposal(
        &mut self,
        account_id: &str,
        request: &crate::domain::UndoConfirmedProposalRequest,
    ) -> StorageResult<AgentProposalReceipt> {
        let request_hash = canonical_hash(request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) =
            find_idempotent_receipt(&transaction, account_id, &request.command_id, &request_hash)?
        {
            transaction.commit()?;
            return Ok(receipt);
        }
        let original: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT proposal_id, operation, accepted_item_ids_json
                 FROM agent_proposal_receipts WHERE id = ?1 AND account_id = ?2",
                params![request.receipt_id, account_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((proposal_id, operation, accepted_json)) = original else {
            return Err(StorageError::NotFound(
                "Confirmation receipt was not found".into(),
            ));
        };
        if operation != "confirm" {
            return Err(StorageError::Validation(
                "Only a confirmation receipt can be undone".into(),
            ));
        }
        let already_undone: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_proposal_receipts WHERE undo_of_receipt_id = ?1)",
            [&request.receipt_id],
            |row| row.get(0),
        )?;
        if already_undone {
            return Err(StorageError::Conflict(
                "Confirmation receipt was already undone".into(),
            ));
        }
        let record = load_proposal(&transaction, account_id, &proposal_id)?
            .ok_or_else(|| StorageError::NotFound("Agent proposal was not found".into()))?;
        if record.status != AgentProposalStatus::Confirmed {
            return Err(StorageError::Conflict(
                "Agent proposal is no longer confirmed".into(),
            ));
        }
        let (actual_cursor, document) = load_active_document(&transaction, &request.cursor)?;
        if actual_cursor != request.cursor {
            return Err(StorageError::Conflict("Stale authority cursor".into()));
        }
        verify_record_scope(&record)?;
        let accepted: BTreeSet<String> = serde_json::from_str::<Vec<String>>(&accepted_json)?
            .into_iter()
            .collect();
        let mut context = crate::domain::DocumentContext::with_authority(
            document,
            parse_revision(&request.cursor.revision)?,
            request.cursor.branch_id.clone(),
            request.cursor.head_id.clone(),
        )
        .map_err(StorageError::Domain)?;
        let mut inverse = Vec::new();
        for item in record.items.iter().rev() {
            if !accepted.contains(&item.id) {
                continue;
            }
            if change_target_value(context.document(), &item.change)? != item.after_value {
                return Err(StorageError::Conflict(format!(
                    "Proposal after-value changed for item {}",
                    item.id
                )));
            }
            inverse.extend(inverse_commands(
                context.document(),
                &item.change,
                &item.before_value,
            )?);
        }
        if inverse.is_empty() {
            return Err(StorageError::Validation(
                "Confirmation receipt has no reversible items".into(),
            ));
        }
        let mut last_result = None;
        for (index, payload) in inverse.into_iter().enumerate() {
            let cursor = context.cursor(&request.cursor.context_id);
            let result = context
                .apply_command(
                    account_id,
                    &request.cursor.context_id,
                    CommandEnvelope {
                        protocol_version: 1,
                        command_id: format!("{}-undo-{index}", request.command_id),
                        document_id: request.cursor.document_id.clone(),
                        context_id: request.cursor.context_id.clone(),
                        expected_revision: cursor.revision,
                        expected_branch_id: cursor.branch_id,
                        expected_head_id: cursor.head_id,
                        payload,
                    },
                )
                .map_err(StorageError::Domain)?;
            last_result = Some(result);
        }
        let result = last_result
            .ok_or_else(|| StorageError::Validation("No inverse proposal operations".into()))?;
        save_document_tx(
            &transaction,
            &request.cursor,
            &result.document,
            &result.cursor,
        )?;
        let created_at = insert_receipt(
            &transaction,
            account_id,
            &request.command_id,
            &record.id,
            "undo",
            &request_hash,
            &result.cursor,
            &accepted.iter().cloned().collect::<Vec<_>>(),
            Some(&request.receipt_id),
            AgentProposalStatus::Undone,
        )?;
        transaction.execute(
            "UPDATE agent_proposals SET status = 'undone' WHERE id = ?1 AND account_id = ?2 AND status = 'confirmed'",
            params![record.id, account_id],
        )?;
        let receipt = AgentProposalReceipt {
            id: receipt_id(account_id, &request.command_id, &request_hash),
            command_id: request.command_id.clone(),
            proposal_id: record.id,
            cursor: result.cursor,
            status: AgentProposalStatus::Undone,
            accepted_item_ids: accepted.into_iter().collect(),
            created_at,
            idempotent_replay: false,
        };
        update_lifecycle_if_settled(&transaction, &record.run_id)?;
        persist_receipt_result(&transaction, &receipt)?;
        transaction.commit()?;
        Ok(receipt)
    }
}

fn retain_proposal_assets(
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

fn load_active_document(
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

fn save_document_tx(
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

fn load_proposal(
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

fn parse_status(status: &str) -> StorageResult<AgentProposalStatus> {
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

fn validate_identifier(value: &str, max: usize, field: &str) -> StorageResult<()> {
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(StorageError::Validation(format!("Invalid {field}")));
    }
    Ok(())
}

fn parse_revision(value: &str) -> StorageResult<u64> {
    value
        .parse::<u64>()
        .map_err(|_| StorageError::Validation("Invalid authority revision".into()))
}

fn proposal_expired(connection: &Connection, proposal_id: &str) -> StorageResult<bool> {
    Ok(connection.query_row(
        "SELECT expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM agent_proposals WHERE id = ?1",
        [proposal_id],
        |row| row.get(0),
    )?)
}

fn verify_record_scope(record: &AgentProposalRecord) -> StorageResult<()> {
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

fn find_idempotent_receipt(
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

fn receipt_id(account_id: &str, command_id: &str, request_hash: &str) -> String {
    let digest = canonical_hash(&(account_id, command_id, request_hash))
        .unwrap_or_else(|_| format!("{account_id}:{command_id}:{request_hash}"));
    format!("receipt-{digest}")
}

#[allow(clippy::too_many_arguments)]
fn insert_receipt(
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

fn persist_receipt_result(
    transaction: &Transaction<'_>,
    receipt: &AgentProposalReceipt,
) -> StorageResult<()> {
    transaction.execute(
        "UPDATE agent_proposal_receipts SET result_json = ?2 WHERE id = ?1",
        params![receipt.id, serde_json::to_string(receipt)?],
    )?;
    Ok(())
}

fn update_lifecycle_if_settled(transaction: &Transaction<'_>, run_id: &str) -> StorageResult<()> {
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

fn proposal_command(
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

fn change_target_value(document: &ResumeDocument, change: &ProposalChange) -> StorageResult<Value> {
    let value = serde_json::to_value(document)?;
    match change {
        ProposalChange::SetDocumentTitle { .. } => Ok(value["title"].clone()),
        ProposalChange::RenameSection { section_id, .. }
        | ProposalChange::SetSectionVisibility { section_id, .. }
        | ProposalChange::SetSummaryBody { section_id, .. } => {
            let section = section_value(&value, section_id)?;
            match change {
                ProposalChange::RenameSection { .. } => Ok(section["title"].clone()),
                ProposalChange::SetSectionVisibility { .. } => Ok(section["visible"].clone()),
                ProposalChange::SetSummaryBody { .. } => {
                    if section["kind"] != "summary" {
                        return Err(StorageError::Validation(
                            "Summary proposal target is not a summary section".into(),
                        ));
                    }
                    Ok(section["body"].clone())
                }
                _ => unreachable!(),
            }
        }
        ProposalChange::MoveSection { .. } => Ok(Value::Array(
            document
                .sections
                .iter()
                .map(|section| match section {
                    Section::Entry(section) => json!(section.id),
                    Section::Summary(section) => json!(section.id),
                })
                .collect(),
        )),
        ProposalChange::SetEntryBody { entry_id, .. } => {
            Ok(entry_value(&value, entry_id)?["body"].clone())
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
        } => {
            let entry = entry_value(&value, entry_id)?;
            let names = [
                ("title", title.is_some()),
                ("role", role.is_some()),
                ("department", department.is_some()),
                ("city", city.is_some()),
                ("start", start.is_some()),
                ("end", end.is_some()),
                ("college", college.is_some()),
                ("mode", mode.is_some()),
            ];
            Ok(project_fields(entry, &names))
        }
        ProposalChange::AddEntry { entry, .. } => match entry_location(document, &entry.id) {
            Some((section_id, index, current)) => Ok(json!({
                "present": true, "sectionId": section_id, "index": index, "entry": current
            })),
            None => Ok(json!({"present": false})),
        },
        ProposalChange::DeleteEntry { entry_id } => match entry_location(document, entry_id) {
            Some((section_id, index, entry)) => Ok(json!({
                "present": true, "sectionId": section_id, "index": index, "entry": entry
            })),
            None => Ok(json!({"present": false})),
        },
        ProposalChange::MoveEntry { entry_id, .. } => {
            let (section_id, index, entry) = entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            let orders = document
                .sections
                .iter()
                .filter_map(|section| match section {
                    Section::Entry(section) => Some(json!({
                        "sectionId": section.id,
                        "entryIds": section.entries.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>()
                    })),
                    Section::Summary(_) => None,
                })
                .collect::<Vec<_>>();
            Ok(json!({"sectionId": section_id, "index": index, "entry": entry, "orders": orders}))
        }
        ProposalChange::UpdateBasic { patch } => {
            let basic = &value["basic"];
            let names = [
                ("name", patch.name.is_some()),
                ("phone", patch.phone.is_some()),
                ("email", patch.email.is_some()),
                ("city", patch.city.is_some()),
                ("wechat", patch.wechat.is_some()),
                ("birth", patch.birth.is_some()),
                ("ageMode", patch.age_mode.is_some()),
                ("website", patch.website.is_some()),
                ("linkedin", patch.linkedin.is_some()),
                ("gender", patch.gender.is_some()),
                ("height", patch.height.is_some()),
                ("weight", patch.weight.is_some()),
                ("ethnicity", patch.ethnicity.is_some()),
                ("birthplace", patch.birthplace.is_some()),
                ("politicalStatus", patch.political_status.is_some()),
                ("maritalStatus", patch.marital_status.is_some()),
                ("zodiac", patch.zodiac.is_some()),
                ("mbti", patch.mbti.is_some()),
                ("avatarAssetId", patch.avatar_asset_id.is_some()),
            ];
            Ok(project_fields(basic, &names))
        }
        ProposalChange::ApplyTemplate { .. } => {
            Ok(Value::String(document.presentation.template_id.clone()))
        }
        // 版本副作用的提议值只绑定提交消息，保证确认时消息未被篡改。
        ProposalChange::CommitVersion { message } => Ok(Value::String(message.clone())),
    }
}

fn project_fields(value: &Value, names: &[(&str, bool)]) -> Value {
    let mut result = Map::new();
    for (name, include) in names {
        if *include {
            result.insert((*name).into(), value[*name].clone());
        }
    }
    Value::Object(result)
}

fn section_value<'a>(document: &'a Value, section_id: &str) -> StorageResult<&'a Value> {
    document["sections"]
        .as_array()
        .and_then(|sections| {
            sections
                .iter()
                .find(|section| section["id"].as_str() == Some(section_id))
        })
        .ok_or_else(|| StorageError::NotFound("Proposal section was not found".into()))
}

fn entry_value<'a>(document: &'a Value, entry_id: &str) -> StorageResult<&'a Value> {
    document["sections"]
        .as_array()
        .and_then(|sections| {
            sections.iter().find_map(|section| {
                section["entries"].as_array().and_then(|entries| {
                    entries
                        .iter()
                        .find(|entry| entry["id"].as_str() == Some(entry_id))
                })
            })
        })
        .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))
}

fn entry_location(
    document: &ResumeDocument,
    entry_id: &str,
) -> Option<(String, usize, crate::domain::Entry)> {
    document.sections.iter().find_map(|section| {
        let Section::Entry(section) = section else {
            return None;
        };
        section
            .entries
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.id == entry_id)
            .map(|(index, entry)| (section.id.clone(), index, entry.clone()))
    })
}

fn scope_keys(document: &ResumeDocument, change: &ProposalChange) -> StorageResult<Vec<String>> {
    let keys = match change {
        ProposalChange::SetDocumentTitle { .. } => vec!["document:title".into()],
        ProposalChange::RenameSection { section_id, .. } => {
            vec![format!("section:{section_id}:title")]
        }
        ProposalChange::SetSectionVisibility { section_id, .. } => {
            vec![format!("section:{section_id}:visible")]
        }
        ProposalChange::MoveSection { section_id, .. } => {
            section_value(&serde_json::to_value(document)?, section_id)?;
            vec!["section:order".into()]
        }
        ProposalChange::SetEntryBody { entry_id, .. } => {
            vec![format!("entry:{entry_id}:body")]
        }
        ProposalChange::SetSummaryBody { section_id, .. } => {
            let value = serde_json::to_value(document)?;
            if section_value(&value, section_id)?["kind"] != "summary" {
                return Err(StorageError::Validation(
                    "Summary proposal target is not a summary section".into(),
                ));
            }
            vec![format!("summary:{section_id}:body")]
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
        } => {
            entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            let names = [
                ("title", title.is_some()),
                ("role", role.is_some()),
                ("department", department.is_some()),
                ("city", city.is_some()),
                ("start", start.is_some()),
                ("end", end.is_some()),
                ("college", college.is_some()),
                ("mode", mode.is_some()),
            ];
            names
                .into_iter()
                .filter(|(_, include)| *include)
                .map(|(name, _)| format!("entry:{entry_id}:{name}"))
                .collect()
        }
        ProposalChange::AddEntry { section_id, entry } => {
            let value = serde_json::to_value(document)?;
            let section = section_value(&value, section_id)?;
            if section["kind"] == "summary" || entry_location(document, &entry.id).is_some() {
                return Err(StorageError::Validation(
                    "Proposal entry cannot be added to this target".into(),
                ));
            }
            vec![format!("entry-collection:{section_id}")]
        }
        ProposalChange::DeleteEntry { entry_id } => {
            entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            vec![format!("entry-identity:{entry_id}")]
        }
        ProposalChange::MoveEntry {
            entry_id,
            section_id,
            ..
        } => {
            entry_location(document, entry_id)
                .ok_or_else(|| StorageError::NotFound("Proposal entry was not found".into()))?;
            let value = serde_json::to_value(document)?;
            if section_value(&value, section_id)?["kind"] == "summary" {
                return Err(StorageError::Validation(
                    "Proposal entry cannot be moved to a summary".into(),
                ));
            }
            vec!["entry:order".into(), format!("entry-identity:{entry_id}")]
        }
        ProposalChange::UpdateBasic { patch } => {
            let names = [
                ("name", patch.name.is_some()),
                ("phone", patch.phone.is_some()),
                ("email", patch.email.is_some()),
                ("city", patch.city.is_some()),
                ("wechat", patch.wechat.is_some()),
                ("birth", patch.birth.is_some()),
                ("ageMode", patch.age_mode.is_some()),
                ("website", patch.website.is_some()),
                ("linkedin", patch.linkedin.is_some()),
                ("gender", patch.gender.is_some()),
                ("height", patch.height.is_some()),
                ("weight", patch.weight.is_some()),
                ("ethnicity", patch.ethnicity.is_some()),
                ("birthplace", patch.birthplace.is_some()),
                ("politicalStatus", patch.political_status.is_some()),
                ("maritalStatus", patch.marital_status.is_some()),
                ("zodiac", patch.zodiac.is_some()),
                ("mbti", patch.mbti.is_some()),
                ("avatarAssetId", patch.avatar_asset_id.is_some()),
            ];
            names
                .into_iter()
                .filter(|(_, include)| *include)
                .map(|(name, _)| format!("basic:{name}"))
                .collect()
        }
        ProposalChange::ApplyTemplate { template_id } => {
            if !matches!(
                template_id.as_str(),
                "legacy-v1" | "clear-single-v1" | "compact-single-v1"
            ) {
                return Err(StorageError::Permission(
                    "Template proposals are limited to the three built-in templates".into(),
                ));
            }
            vec!["presentation:template".into()]
        }
        ProposalChange::CommitVersion { message } => {
            let trimmed = message.trim();
            if trimmed.is_empty() || trimmed.chars().count() > 200 {
                return Err(StorageError::Validation(
                    "Version commit message is invalid".into(),
                ));
            }
            vec!["version:head".into()]
        }
    };
    if keys.is_empty() {
        return Err(StorageError::Validation(
            "Proposal change has no document fields".into(),
        ));
    }
    Ok(keys)
}

fn inverse_commands(
    document: &ResumeDocument,
    change: &ProposalChange,
    before: &Value,
) -> StorageResult<Vec<DomainCommand>> {
    let one = |command| Ok(vec![command]);
    match change {
        ProposalChange::SetDocumentTitle { .. } => one(DomainCommand::SetDocumentTitle {
            title: before
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Bad title before-value".into()))?
                .to_string(),
        }),
        ProposalChange::RenameSection { section_id, .. } => one(DomainCommand::RenameSection {
            section_id: section_id.clone(),
            title: before
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Bad section title before-value".into()))?
                .to_string(),
        }),
        ProposalChange::SetSectionVisibility { section_id, .. } => {
            one(DomainCommand::SetSectionVisibility {
                section_id: section_id.clone(),
                visible: before
                    .as_bool()
                    .ok_or_else(|| StorageError::Corrupt("Bad visibility before-value".into()))?,
            })
        }
        ProposalChange::MoveSection { .. } => {
            let order = before
                .as_array()
                .ok_or_else(|| StorageError::Corrupt("Bad section order before-value".into()))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .ok_or_else(|| StorageError::Corrupt("Bad section ID".into()))
                })
                .collect::<StorageResult<Vec<_>>>()?;
            reorder_sections(document, &order)
        }
        ProposalChange::SetEntryBody { entry_id, .. } => one(DomainCommand::SetEntryBody {
            entry_id: entry_id.clone(),
            body: serde_json::from_value(before.clone())?,
        }),
        ProposalChange::SetSummaryBody { section_id, .. } => one(DomainCommand::SetSummaryBody {
            section_id: section_id.clone(),
            body: serde_json::from_value(before.clone())?,
        }),
        ProposalChange::UpdateEntryFields { entry_id, .. } => {
            let get_text = |name: &str| -> StorageResult<Option<String>> {
                before
                    .get(name)
                    .and_then(Value::as_str)
                    .map(|value| Some(value.to_string()))
                    .ok_or_else(|| StorageError::Corrupt(format!("Bad {name} before-value")))
            };
            let get_optional = |name: &str| -> StorageResult<Option<String>> {
                let value = before
                    .get(name)
                    .ok_or_else(|| StorageError::Corrupt(format!("Missing {name} before-value")))?;
                if value.is_null() {
                    Ok(Some(String::new()))
                } else {
                    value
                        .as_str()
                        .map(|value| Some(value.to_string()))
                        .ok_or_else(|| StorageError::Corrupt(format!("Bad {name} before-value")))
                }
            };
            one(DomainCommand::UpdateEntryFields {
                entry_id: entry_id.clone(),
                title: if before.get("title").is_some() {
                    get_text("title")?
                } else {
                    None
                },
                role: if before.get("role").is_some() {
                    get_text("role")?
                } else {
                    None
                },
                department: if before.get("department").is_some() {
                    get_text("department")?
                } else {
                    None
                },
                city: if before.get("city").is_some() {
                    get_text("city")?
                } else {
                    None
                },
                start: if before.get("start").is_some() {
                    get_text("start")?
                } else {
                    None
                },
                end: if before.get("end").is_some() {
                    get_text("end")?
                } else {
                    None
                },
                college: if before.get("college").is_some() {
                    get_optional("college")?
                } else {
                    None
                },
                mode: if before.get("mode").is_some() {
                    get_optional("mode")?
                } else {
                    None
                },
            })
        }
        ProposalChange::AddEntry { entry, .. } => one(DomainCommand::DeleteEntry {
            entry_id: entry.id.clone(),
        }),
        ProposalChange::DeleteEntry { entry_id } => {
            let section_id = before["sectionId"]
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Missing deleted entry section".into()))?
                .to_string();
            let index = before["index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| StorageError::Corrupt("Missing deleted entry index".into()))?;
            let entry = serde_json::from_value(before["entry"].clone())?;
            Ok(vec![
                DomainCommand::AddEntry {
                    section_id: section_id.clone(),
                    entry,
                },
                DomainCommand::MoveEntry {
                    entry_id: entry_id.clone(),
                    section_id,
                    index,
                },
            ])
        }
        ProposalChange::MoveEntry { entry_id, .. } => one(DomainCommand::MoveEntry {
            entry_id: entry_id.clone(),
            section_id: before["sectionId"]
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Missing old entry section".into()))?
                .to_string(),
            index: before["index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| StorageError::Corrupt("Missing old entry index".into()))?,
        }),
        ProposalChange::UpdateBasic { patch } => {
            let mut basic: BasicInfo =
                serde_json::from_value(serde_json::to_value(&document.basic)?)?;
            let mut fields = Vec::new();
            macro_rules! restore_field {
                ($json:literal, $field:ident, $enum:ident) => {
                    if patch.$field.is_some() {
                        basic.$field =
                            serde_json::from_value(before.get($json).cloned().ok_or_else(
                                || StorageError::Corrupt(format!("Missing {} before-value", $json)),
                            )?)?;
                        fields.push(BasicField::$enum);
                    }
                };
            }
            restore_field!("name", name, Name);
            restore_field!("phone", phone, Phone);
            restore_field!("email", email, Email);
            restore_field!("city", city, City);
            restore_field!("wechat", wechat, Wechat);
            restore_field!("birth", birth, Birth);
            restore_field!("ageMode", age_mode, AgeMode);
            restore_field!("website", website, Website);
            restore_field!("linkedin", linkedin, Linkedin);
            restore_field!("gender", gender, Gender);
            restore_field!("height", height, Height);
            restore_field!("weight", weight, Weight);
            restore_field!("ethnicity", ethnicity, Ethnicity);
            restore_field!("birthplace", birthplace, Birthplace);
            restore_field!("politicalStatus", political_status, PoliticalStatus);
            restore_field!("maritalStatus", marital_status, MaritalStatus);
            restore_field!("zodiac", zodiac, Zodiac);
            restore_field!("mbti", mbti, Mbti);
            restore_field!("avatarAssetId", avatar_asset_id, AvatarAssetId);
            one(DomainCommand::RestoreBasicFields {
                fields,
                values: basic,
            })
        }
        ProposalChange::ApplyTemplate { .. } => {
            let template_id = before
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("Bad template before-value".into()))?
                .to_string();
            let mut presentation = document.presentation.clone();
            presentation.template_id = template_id;
            one(DomainCommand::SetLayout { presentation })
        }
        // 版本提交是持久历史，撤回只还原正文，不产生版本逆操作。
        ProposalChange::CommitVersion { .. } => Ok(Vec::new()),
    }
}

fn reorder_sections(
    document: &ResumeDocument,
    desired: &[String],
) -> StorageResult<Vec<DomainCommand>> {
    if desired.len() != document.sections.len() {
        return Err(StorageError::Corrupt(
            "Bad section order before-value".into(),
        ));
    }
    let mut current = document
        .sections
        .iter()
        .map(|section| match section {
            Section::Entry(section) => section.id.clone(),
            Section::Summary(section) => section.id.clone(),
        })
        .collect::<Vec<_>>();
    let desired_set = desired.iter().cloned().collect::<BTreeSet<_>>();
    if desired_set.len() != desired.len() || desired.iter().any(|id| !current.contains(id)) {
        return Err(StorageError::Corrupt("Bad section order IDs".into()));
    }
    let mut commands = Vec::new();
    for (index, section_id) in desired.iter().enumerate() {
        let from = current
            .iter()
            .position(|id| id == section_id)
            .ok_or_else(|| StorageError::Corrupt("Missing section in undo target".into()))?;
        if from != index {
            let value = current.remove(from);
            current.insert(index, value);
            commands.push(DomainCommand::MoveSection {
                section_id: section_id.clone(),
                index,
            });
        }
    }
    if commands.is_empty() {
        return Err(StorageError::Conflict(
            "Section order no longer needs undo".into(),
        ));
    }
    Ok(commands)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::domain::{
        default_resume_document, AgentProposalDraftItem, BasicPatch, ConfirmProposalRequest,
        RejectAgentProposalRequest, UndoConfirmedProposalRequest,
    };

    const ACCOUNT: &str = "proposal-account-a";
    const RUN: &str = "proposal-run-fixture";
    const DOCUMENT: &str = "proposal-document-fixture";
    const CONTEXT: &str = "proposal-context-fixture";

    fn store_with_run(reference_ids: &[&str]) -> (Store, AuthorityCursor) {
        let mut store = Store::open_in_memory().expect("isolated SQLite store");
        store
            .connection
            .execute(
                "INSERT INTO accounts(id, email, salt, password_hash)
                 VALUES (?1, 'proposal@example.invalid', 'synthetic-salt', 'synthetic-hash')",
                [ACCOUNT],
            )
            .expect("synthetic account");
        let document = default_resume_document(DOCUMENT).expect("synthetic document");
        store
            .initialize_document(&document, CONTEXT)
            .expect("initialize synthetic document");
        let cursor = store
            .load_cursor(DOCUMENT, CONTEXT)
            .expect("load cursor")
            .expect("active cursor");
        store
            .connection
            .execute(
                "INSERT INTO agent_runs(
                   id, account_id, session_id, document_id, context_id, revision,
                   branch_id, head_id, reference_ids_json, status, started_at
                 ) VALUES (?1, ?2, 'proposal-session', ?3, ?4, ?5, ?6, ?7, ?8, 'completed', 0)",
                params![
                    RUN,
                    ACCOUNT,
                    DOCUMENT,
                    CONTEXT,
                    cursor.revision,
                    cursor.branch_id,
                    cursor.head_id,
                    serde_json::to_string(reference_ids).expect("references")
                ],
            )
            .expect("synthetic completed run");
        (store, cursor)
    }

    fn name_draft(proposal_id: &str, proposed_name: &str) -> AgentProposalDraft {
        AgentProposalDraft {
            id: proposal_id.into(),
            explanation: "只用于事务回归的合成提议".into(),
            items: vec![AgentProposalDraftItem {
                id: format!("{proposal_id}-item-1"),
                summary: "更新姓名字段".into(),
                reference_id: "basic:name".into(),
                change: ProposalChange::UpdateBasic {
                    patch: BasicPatch {
                        name: Some(proposed_name.into()),
                        ..BasicPatch::default()
                    },
                },
            }],
        }
    }

    fn create_one(
        store: &mut Store,
        cursor: &AuthorityCursor,
        proposal_id: &str,
    ) -> AgentProposalRecord {
        store
            .create_agent_proposals(ACCOUNT, RUN, cursor, &[name_draft(proposal_id, "建议姓名")])
            .expect("persist pending proposal")
            .into_iter()
            .next()
            .expect("one proposal")
    }

    fn confirm_request(record: &AgentProposalRecord, command_id: &str) -> ConfirmProposalRequest {
        ConfirmProposalRequest {
            command_id: command_id.into(),
            cursor: record.cursor.clone(),
            proposal_id: record.id.clone(),
            accepted_item_ids: record.items.iter().map(|item| item.id.clone()).collect(),
        }
    }

    fn avatar_draft(id: &str, hash: &str) -> AgentProposalDraft {
        AgentProposalDraft {
            id: id.into(),
            explanation: "合成头像提议".into(),
            items: vec![AgentProposalDraftItem {
                id: format!("{id}-avatar"),
                summary: "更新已选头像".into(),
                reference_id: "basic:avatar".into(),
                change: ProposalChange::UpdateBasic {
                    patch: BasicPatch {
                        avatar_asset_id: Some(hash.into()),
                        ..BasicPatch::default()
                    },
                },
            }],
        }
    }

    fn candidate_avatar(store: &Store) -> String {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM90AAAAASUVORK5CYII=").unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        store
            .put_resource(&hash, "image/png", &bytes, None)
            .unwrap();
        hash
    }

    #[test]
    fn avatar_proposal_retains_pending_and_undo_assets_through_gc() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let (mut store, cursor) = store_with_run(&["basic:avatar"]);
        let old_bytes = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
        let old_hash = format!("{:x}", Sha256::digest(&old_bytes));
        store
            .put_resource(&old_hash, "image/png", &old_bytes, None)
            .unwrap();
        let result = store
            .apply_command(
                ACCOUNT,
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "avatar-initial-fixture".into(),
                    document_id: DOCUMENT.into(),
                    context_id: CONTEXT.into(),
                    expected_revision: cursor.revision,
                    expected_branch_id: cursor.branch_id,
                    expected_head_id: cursor.head_id,
                    payload: DomainCommand::UpdateBasic {
                        patch: BasicPatch {
                            avatar_asset_id: Some(old_hash.clone()),
                            ..BasicPatch::default()
                        },
                    },
                },
            )
            .unwrap();
        let cursor = result.cursor;
        store
            .connection
            .execute(
                "UPDATE agent_runs SET revision=?1 WHERE id=?2",
                params![cursor.revision, RUN],
            )
            .unwrap();
        let hash = candidate_avatar(&store);
        let record = store
            .create_agent_proposals(ACCOUNT, RUN, &cursor, &[avatar_draft("avatar-gc", &hash)])
            .unwrap()
            .remove(0);
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
        assert_eq!(
            store
                .load_current(DOCUMENT, CONTEXT)
                .unwrap()
                .unwrap()
                .1
                .basic
                .avatar_asset_id
                .as_deref(),
            Some(old_hash.as_str())
        );
        let receipt = store
            .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "avatar-confirm"))
            .unwrap();
        assert_eq!(
            store
                .load_current(DOCUMENT, CONTEXT)
                .unwrap()
                .unwrap()
                .1
                .basic
                .avatar_asset_id
                .as_deref(),
            Some(hash.as_str())
        );
        let owners: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM resource_refs WHERE resource_hash=?1 AND owner_kind='draft'",
                [&hash],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owners, 1);
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
        store
            .undo_agent_proposal(
                ACCOUNT,
                &UndoConfirmedProposalRequest {
                    command_id: "avatar-undo".into(),
                    cursor: receipt.cursor,
                    receipt_id: receipt.id,
                },
            )
            .unwrap();
        assert_eq!(
            store
                .load_current(DOCUMENT, CONTEXT)
                .unwrap()
                .unwrap()
                .1
                .basic
                .avatar_asset_id
                .as_deref(),
            Some(old_hash.as_str())
        );
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 1);
    }

    #[test]
    fn avatar_proposal_missing_assets_and_cross_context_do_not_write() {
        let (mut store, cursor) = store_with_run(&["basic:avatar"]);
        assert!(store
            .create_agent_proposals(
                ACCOUNT,
                RUN,
                &cursor,
                &[avatar_draft("avatar-missing", &"a".repeat(64))]
            )
            .is_err());
        assert!(store
            .list_agent_proposals(ACCOUNT)
            .unwrap()
            .pending
            .is_empty());
        let hash = candidate_avatar(&store);
        let record = store
            .create_agent_proposals(
                ACCOUNT,
                RUN,
                &cursor,
                &[avatar_draft("avatar-context", &hash)],
            )
            .unwrap()
            .remove(0);
        let mut request = confirm_request(&record, "avatar-wrong-context");
        request.cursor.context_id = "another-context".into();
        assert!(matches!(
            store.confirm_agent_proposal(ACCOUNT, &request),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
        store
            .connection
            .execute(
                "UPDATE agent_proposals SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?1",
                [&record.id],
            )
            .unwrap();
        assert!(store
            .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "avatar-expired"))
            .is_err());
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 1);
        assert_eq!(
            store
                .load_current(DOCUMENT, CONTEXT)
                .unwrap()
                .unwrap()
                .1
                .basic
                .avatar_asset_id,
            None
        );
    }

    #[test]
    fn avatar_confirm_cancel_race_has_one_durable_winner_after_reopen() {
        let (store, cursor) = store_with_run(&["basic:avatar"]);
        let hash = candidate_avatar(&store);
        let mut store = store;
        let record = store
            .create_agent_proposals(ACCOUNT, RUN, &cursor, &[avatar_draft("avatar-race", &hash)])
            .unwrap()
            .remove(0);
        let path = std::env::temp_dir().join(format!(
            "zinecv-avatar-race-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        store.backup_to(&path).unwrap();
        drop(store);
        // Open connections before the barrier: initialization may acquire a
        // SQLite write lock and must not strand the other thread on failure.
        let mut confirm_store = Store::open(&path).unwrap();
        let mut cancel_store = Store::open(&path).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let confirm_barrier = barrier.clone();
        let request = confirm_request(&record, "avatar-race-confirm");
        let confirm = std::thread::spawn(move || {
            confirm_barrier.wait();
            confirm_store.confirm_agent_proposal(ACCOUNT, &request)
        });
        let proposal_id = record.id;
        let cancel = std::thread::spawn(move || {
            barrier.wait();
            cancel_store.reject_agent_proposal(
                ACCOUNT,
                &RejectAgentProposalRequest {
                    command_id: "avatar-race-cancel".into(),
                    proposal_id,
                },
            )
        });
        let results = [confirm.join().unwrap(), cancel.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let winner = results.into_iter().find_map(Result::ok).unwrap();
        let mut store = Store::open(&path).unwrap();
        assert!(store
            .list_agent_proposals(ACCOUNT)
            .unwrap()
            .pending
            .is_empty());
        let document = store.load_current(DOCUMENT, CONTEXT).unwrap().unwrap().1;
        assert_eq!(
            document.basic.avatar_asset_id.is_some(),
            winner.status == AgentProposalStatus::Confirmed
        );
        // The verified backup carries a short resource lease. A cancelled
        // proposal must still respect that lease before ordinary GC resumes.
        assert_eq!(store.collect_unreferenced_resources().unwrap(), 0);
        store
            .connection
            .execute("UPDATE resource_leases SET expires_at=0", [])
            .unwrap();
        assert_eq!(
            store.collect_unreferenced_resources().unwrap(),
            usize::from(winner.status == AgentProposalStatus::Rejected)
        );
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn proposal_confirm_is_atomic_idempotent_and_undoable() {
        let (mut store, cursor) = store_with_run(&["basic:name"]);
        let record = create_one(&mut store, &cursor, "proposal-same-name-id-a");
        assert_eq!(record.status, AgentProposalStatus::Pending);
        assert_eq!(record.items[0].before_value, json!({"name":""}));
        assert_eq!(record.items[0].after_value, json!({"name":"建议姓名"}));
        let other_inbox = store
            .list_agent_proposals("another-account")
            .expect("other account listing");
        assert!(other_inbox.pending.is_empty());
        assert!(other_inbox.undoable.is_empty());

        let request = confirm_request(&record, "proposal-confirm-command-a");
        let receipt = store
            .confirm_agent_proposal(ACCOUNT, &request)
            .expect("confirm proposal");
        assert_eq!(receipt.status, AgentProposalStatus::Confirmed);
        assert!(!receipt.idempotent_replay);
        let replay = store
            .confirm_agent_proposal(ACCOUNT, &request)
            .expect("repeat confirmation");
        assert!(replay.idempotent_replay);
        assert_eq!(replay.id, receipt.id);
        let (confirmed_revision, confirmed) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load confirmed draft")
            .expect("document exists");
        assert_eq!(confirmed.basic.name, "建议姓名");
        assert_eq!(confirmed_revision, 1);
        let inbox = store
            .list_agent_proposals(ACCOUNT)
            .expect("account proposal inbox");
        assert!(inbox.pending.is_empty());
        assert_eq!(inbox.undoable.len(), 1);
        assert_eq!(inbox.undoable[0].receipt_id, receipt.id);
        assert_eq!(inbox.undoable[0].session_id, record.session_id);
        let confirmed_cursor = store
            .load_cursor(DOCUMENT, CONTEXT)
            .expect("load confirmed cursor")
            .expect("confirmed cursor exists");

        let undo = UndoConfirmedProposalRequest {
            command_id: "proposal-undo-command-a".into(),
            cursor: confirmed_cursor,
            receipt_id: receipt.id,
        };
        let undone = store
            .undo_agent_proposal(ACCOUNT, &undo)
            .expect("undo proposal");
        assert_eq!(undone.status, AgentProposalStatus::Undone);
        let (after_undo_revision, after_undo) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load undone draft")
            .expect("document exists");
        assert_eq!(after_undo.basic.name, "");
        assert_eq!(after_undo_revision, 2);
        assert!(store
            .list_agent_proposals(ACCOUNT)
            .expect("proposal inbox after undo")
            .undoable
            .is_empty());
        let replay = store
            .undo_agent_proposal(ACCOUNT, &undo)
            .expect("repeat undo");
        assert!(replay.idempotent_replay);
        assert_eq!(replay.id, undone.id);
    }

    #[test]
    fn proposal_undo_refuses_to_overwrite_a_later_manual_edit() {
        let (mut store, cursor) = store_with_run(&["basic:name"]);
        let record = create_one(&mut store, &cursor, "proposal-manual-edit");
        let receipt = store
            .confirm_agent_proposal(
                ACCOUNT,
                &confirm_request(&record, "proposal-confirm-manual-edit"),
            )
            .expect("confirm");
        let manual = store
            .apply_command(
                "local-anonymous",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "proposal-manual-command".into(),
                    document_id: receipt.cursor.document_id.clone(),
                    context_id: receipt.cursor.context_id.clone(),
                    expected_revision: receipt.cursor.revision.clone(),
                    expected_branch_id: receipt.cursor.branch_id.clone(),
                    expected_head_id: receipt.cursor.head_id.clone(),
                    payload: DomainCommand::UpdateBasic {
                        patch: BasicPatch {
                            name: Some("手工后续编辑".into()),
                            ..BasicPatch::default()
                        },
                    },
                },
            )
            .expect("manual edit");
        let error = store
            .undo_agent_proposal(
                ACCOUNT,
                &UndoConfirmedProposalRequest {
                    command_id: "proposal-undo-manual-edit".into(),
                    cursor: manual.cursor,
                    receipt_id: receipt.id,
                },
            )
            .expect_err("undo must conflict after a target edit");
        assert!(matches!(error, StorageError::Conflict(_)));
        assert_eq!(
            store
                .load_current(DOCUMENT, CONTEXT)
                .expect("load manual draft")
                .expect("document exists")
                .1
                .basic
                .name,
            "手工后续编辑"
        );
    }

    #[test]
    fn failed_second_item_rolls_back_the_whole_confirmation() {
        let (mut store, cursor) = store_with_run(&["basic:name", "summary"]);
        let mut draft = name_draft("proposal-rollback", "不能半写入");
        draft.items.push(AgentProposalDraftItem {
            id: "proposal-rollback-item-2".into(),
            summary: "替换自我评价".into(),
            reference_id: "summary".into(),
            change: ProposalChange::SetSummaryBody {
                section_id: "legacy-section:summary".into(),
                body: vec![crate::domain::RichBlock::Paragraph {
                    children: vec![crate::domain::Inline::Text {
                        text: "有效建议".into(),
                        marks: Vec::new(),
                    }],
                }],
            },
        });
        let record = store
            .create_agent_proposals(ACCOUNT, RUN, &cursor, &[draft])
            .expect("persist valid two-item proposal")
            .remove(0);

        let mut tampered = record.items.clone();
        tampered[1].change = ProposalChange::SetSummaryBody {
            section_id: "legacy-section:summary".into(),
            body: vec![crate::domain::RichBlock::Paragraph {
                children: vec![crate::domain::Inline::Link {
                    href: "javascript:alert(1)".into(),
                    children: vec![crate::domain::Inline::Text {
                        text: "invalid".into(),
                        marks: Vec::new(),
                    }],
                }],
            }],
        };
        store
            .connection
            .execute(
                "UPDATE agent_proposals SET items_json = ?2 WHERE id = ?1",
                params![
                    record.id,
                    serde_json::to_string(&tampered).expect("serialize fixture")
                ],
            )
            .expect("install invalid synthetic second item");

        let error = store
            .confirm_agent_proposal(
                ACCOUNT,
                &ConfirmProposalRequest {
                    command_id: "proposal-rollback-confirm".into(),
                    cursor: cursor.clone(),
                    proposal_id: record.id.clone(),
                    accepted_item_ids: record.items.iter().map(|item| item.id.clone()).collect(),
                },
            )
            .expect_err("invalid second item must reject the whole transaction");
        assert!(matches!(error, StorageError::Domain(_)));
        let (unchanged_revision, unchanged) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("read unchanged document")
            .expect("document exists");
        assert_eq!(unchanged_revision, 0);
        assert_eq!(unchanged.basic.name, "");
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT status FROM agent_proposals WHERE id = ?1",
                    [&record.id],
                    |row| row.get::<_, String>(0),
                )
                .expect("proposal state"),
            "pending"
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM agent_proposal_receipts", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("receipt count"),
            0
        );
    }

    #[test]
    fn rejecting_a_proposal_is_account_scoped_idempotent_and_does_not_edit_document() {
        let (mut store, cursor) = store_with_run(&["basic:name"]);
        let record = create_one(&mut store, &cursor, "proposal-reject");
        let request = RejectAgentProposalRequest {
            command_id: "proposal-reject-command".into(),
            proposal_id: record.id.clone(),
        };
        let receipt = store
            .reject_agent_proposal(ACCOUNT, &request)
            .expect("reject proposal");
        assert_eq!(receipt.status, AgentProposalStatus::Rejected);
        assert!(store
            .confirm_agent_proposal(
                "another-account",
                &confirm_request(&record, "cross-account")
            )
            .is_err());
        let replay = store
            .reject_agent_proposal(ACCOUNT, &request)
            .expect("repeat rejection");
        assert!(replay.idempotent_replay);
        let (current_revision, current) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load document")
            .expect("document exists");
        assert_eq!(current_revision, 0);
        assert_eq!(current.basic.name, "");
    }

    fn single_item_draft(
        proposal_id: &str,
        reference_id: &str,
        change: ProposalChange,
        summary: &str,
    ) -> AgentProposalDraft {
        AgentProposalDraft {
            id: proposal_id.into(),
            explanation: "只用于事务回归的合成提议".into(),
            items: vec![AgentProposalDraftItem {
                id: format!("{proposal_id}-item-1"),
                summary: summary.into(),
                reference_id: reference_id.into(),
                change,
            }],
        }
    }

    #[test]
    fn delete_entry_proposal_is_atomic_and_undoable() {
        use crate::domain::{CommandEnvelope, DomainCommand, Entry};
        let (mut store, cursor) = store_with_run(&["entry:entry-1"]);
        // 默认文档各模块条目为空：先用领域命令加入一条经历，再提议删除它。
        let added = store
            .apply_command(
                "local-anonymous",
                CommandEnvelope {
                    protocol_version: 1,
                    command_id: "delete-entry-fixture-add".into(),
                    document_id: cursor.document_id.clone(),
                    context_id: cursor.context_id.clone(),
                    expected_revision: cursor.revision.clone(),
                    expected_branch_id: cursor.branch_id.clone(),
                    expected_head_id: cursor.head_id.clone(),
                    payload: DomainCommand::AddEntry {
                        section_id: "legacy-section:work".into(),
                        entry: Entry {
                            id: "entry-1".into(),
                            title: "工程师".into(),
                            role: String::new(),
                            department: String::new(),
                            city: String::new(),
                            start: "2024".into(),
                            end: String::new(),
                            college: None,
                            mode: None,
                            body: Vec::new(),
                        },
                    },
                },
            )
            .expect("add fixture entry");
        store
            .connection
            .execute(
                "UPDATE agent_runs SET revision = ?1, head_id = ?2 WHERE id = ?3",
                rusqlite::params![added.cursor.revision, added.cursor.head_id, RUN],
            )
            .expect("sync run cursor to the advanced revision");
        let cursor = added.cursor.clone();
        let draft = single_item_draft(
            "proposal-delete-entry",
            "entry:entry-1",
            ProposalChange::DeleteEntry {
                entry_id: "entry-1".into(),
            },
            "删除已选经历",
        );
        let record = store
            .create_agent_proposals(ACCOUNT, RUN, &cursor, &[draft])
            .expect("persist delete proposal")
            .into_iter()
            .next()
            .expect("one proposal");
        let receipt = store
            .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "delete-entry-confirm"))
            .expect("confirm delete");
        let (_, after_delete) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load after delete")
            .expect("document exists");
        assert!(after_delete.sections.iter().all(|section| match section {
            crate::domain::Section::Entry(entry) => {
                entry.entries.iter().all(|entry| entry.id != "entry-1")
            }
            crate::domain::Section::Summary(_) => true,
        }));
        let undo = UndoConfirmedProposalRequest {
            command_id: "delete-entry-undo".into(),
            cursor: receipt.cursor.clone(),
            receipt_id: receipt.id,
        };
        store
            .undo_agent_proposal(ACCOUNT, &undo)
            .expect("undo delete");
        let (_, after_undo) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load after undo")
            .expect("document exists");
        assert!(after_undo.sections.iter().any(|section| match section {
            crate::domain::Section::Entry(entry) => {
                entry.entries.iter().any(|entry| entry.id == "entry-1")
            }
            crate::domain::Section::Summary(_) => false,
        }));
    }

    #[test]
    fn apply_template_proposal_swaps_only_the_template_and_undo_reverts_it() {
        let (mut store, cursor) = store_with_run(&["template:legacy-v1"]);
        let (_, before) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load before")
            .expect("document exists");
        let original_template = before.presentation.template_id.clone();
        let target = if original_template == "legacy-v1" {
            "clear-single-v1"
        } else {
            "legacy-v1"
        };
        let draft = single_item_draft(
            "proposal-apply-template",
            "template:legacy-v1",
            ProposalChange::ApplyTemplate {
                template_id: target.into(),
            },
            "切换到已选模板",
        );
        let record = store
            .create_agent_proposals(ACCOUNT, RUN, &cursor, &[draft])
            .expect("persist template proposal")
            .into_iter()
            .next()
            .expect("one proposal");
        let receipt = store
            .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "template-confirm"))
            .expect("confirm template switch");
        let (_, switched) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load switched")
            .expect("document exists");
        assert_eq!(switched.presentation.template_id, target);
        assert_eq!(switched.basic.name, before.basic.name);
        let undo = UndoConfirmedProposalRequest {
            command_id: "template-undo".into(),
            cursor: receipt.cursor.clone(),
            receipt_id: receipt.id,
        };
        store
            .undo_agent_proposal(ACCOUNT, &undo)
            .expect("undo template switch");
        let (_, reverted) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load reverted")
            .expect("document exists");
        assert_eq!(reverted.presentation.template_id, original_template);
    }

    #[test]
    fn commit_version_side_effect_lands_in_the_same_transaction_and_survives_undo() {
        let (mut store, cursor) = store_with_run(&["basic:name", "draft:main"]);
        let name_draft = name_draft("proposal-version", "版本确认姓名");
        let mut combined = AgentProposalDraft {
            id: name_draft.id.clone(),
            explanation: name_draft.explanation.clone(),
            items: name_draft.items.clone(),
        };
        combined.items.push(AgentProposalDraftItem {
            id: "proposal-version-item-2".into(),
            summary: "确认后保存版本".into(),
            reference_id: "draft:main".into(),
            change: ProposalChange::CommitVersion {
                message: " 提议确认并保存版本 ".into(),
            },
        });
        let record = store
            .create_agent_proposals(ACCOUNT, RUN, &cursor, &[combined])
            .expect("persist combined proposal")
            .into_iter()
            .next()
            .expect("one proposal");
        let commits_before: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .expect("commit count");
        let receipt = store
            .confirm_agent_proposal(ACCOUNT, &confirm_request(&record, "version-confirm"))
            .expect("confirm with version side effect");
        let commits_after: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .expect("commit count after");
        assert_eq!(commits_after, commits_before + 1);
        assert!(receipt.cursor.head_id.is_some());
        let (_, committed) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load committed draft")
            .expect("document exists");
        assert_eq!(committed.basic.name, "版本确认姓名");
        let draft_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM drafts WHERE document_id = ?1",
                [DOCUMENT],
                |row| row.get(0),
            )
            .expect("draft rows");
        assert_eq!(draft_rows, 0);
        let undo = UndoConfirmedProposalRequest {
            command_id: "version-undo".into(),
            cursor: receipt.cursor.clone(),
            receipt_id: receipt.id,
        };
        store
            .undo_agent_proposal(ACCOUNT, &undo)
            .expect("undo content of versioned proposal");
        let (_, restored) = store
            .load_current(DOCUMENT, CONTEXT)
            .expect("load after undo")
            .expect("document exists");
        assert_eq!(restored.basic.name, "");
        let commits_final: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .expect("commit count final");
        assert_eq!(commits_final, commits_after);
    }
}

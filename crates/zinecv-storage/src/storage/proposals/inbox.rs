use super::*;

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
            let mut context = zinecv_domain::DocumentContext::with_authority(
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
        request: &zinecv_contracts::ConfirmProposalRequest,
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
        let mut context = zinecv_domain::DocumentContext::with_authority(
            document,
            base_revision,
            request.cursor.branch_id.clone(),
            request.cursor.head_id.clone(),
        )
        .map_err(StorageError::Domain)?;
        let mut applied_ids = Vec::new();
        let mut last_result: Option<zinecv_contracts::CommandResult> = None;
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
        request: &zinecv_contracts::RejectAgentProposalRequest,
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
}

use super::*;

impl Store {
    pub fn undo_agent_proposal(
        &mut self,
        account_id: &str,
        request: &zinecv_contracts::UndoConfirmedProposalRequest,
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
        if record.cursor.document_id != request.cursor.document_id
            || record.cursor.context_id != request.cursor.context_id
            || record.cursor.branch_id != request.cursor.branch_id
        {
            return Err(StorageError::Conflict(
                "撤回目标不属于原提议的简历、来源或分支，请返回原目标".into(),
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
        let mut context = zinecv_domain::DocumentContext::with_authority(
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

use super::*;

impl Store {
    pub fn begin_agent_run(
        &mut self,
        account_id: &str,
        run_id: &str,
        session_id: &str,
        target: &AuthorityCursor,
        reference_ids: &[String],
    ) -> StorageResult<()> {
        self.begin_agent_run_with_epoch(account_id, run_id, session_id, target, reference_ids, 1)
    }

    pub fn begin_agent_run_with_epoch(
        &mut self,
        account_id: &str,
        run_id: &str,
        session_id: &str,
        target: &AuthorityCursor,
        reference_ids: &[String],
        epoch: u64,
    ) -> StorageResult<()> {
        if run_id.len() < 8
            || run_id.len() > 80
            || session_id.is_empty()
            || session_id.len() > 160
            || reference_ids.len() > 8
            || epoch == 0
            || epoch > i64::MAX as u64
        {
            return Err(StorageError::Validation("Invalid agent run target".into()));
        }
        let refs_json = serde_json::to_string(reference_ids)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = transaction.execute(
            "INSERT INTO agent_runs(id, account_id, session_id, document_id, context_id, revision,
                    branch_id, head_id, reference_ids_json, status, started_at)
             SELECT ?1, ?2, ?3, d.id, d.active_context_id, CAST(d.revision AS TEXT),
                    d.current_branch_id, b.head_commit_id, ?9, 'running',
                    CAST(strftime('%s','now') AS INTEGER) * 1000
             FROM documents d JOIN branches b ON b.id = d.current_branch_id AND b.document_id = d.id
             WHERE d.id = ?4 AND d.active_context_id = ?5 AND CAST(d.revision AS TEXT) = ?6
               AND d.current_branch_id = ?7 AND b.head_commit_id IS ?8",
            params![
                run_id,
                account_id,
                session_id,
                target.document_id,
                target.context_id,
                target.revision,
                target.branch_id,
                target.head_id,
                refs_json
            ],
        )?;
        if inserted != 1 {
            return Err(StorageError::Conflict(
                "Agent target changed before run start".into(),
            ));
        }
        transaction.execute(
            "INSERT INTO agent_run_lifecycle(run_id, state, epoch, deadline_at, updated_at)
             VALUES (?1, 'preparing', ?2,
               CAST(strftime('%s','now') AS INTEGER) * 1000 + 90000,
               CAST(strftime('%s','now') AS INTEGER) * 1000)",
            params![run_id, epoch as i64],
        )?;
        transaction.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_agent_run_state(
        &mut self,
        account_id: &str,
        run_id: &str,
        epoch: u64,
        state: &str,
        seq: u64,
        model_calls: u8,
        tool_calls: u8,
        interrupted_reason: Option<&str>,
    ) -> StorageResult<()> {
        if !matches!(
            state,
            "preparing"
                | "running"
                | "awaiting_confirmation"
                | "applying"
                | "completed"
                | "failed"
                | "cancelled"
        ) || epoch == 0
            || epoch > i64::MAX as u64
            || seq > i64::MAX as u64
        {
            return Err(StorageError::Validation(
                "Invalid agent lifecycle update".into(),
            ));
        }
        let changed = self.connection.execute(
            "UPDATE agent_run_lifecycle
             SET state = ?4, last_seq = ?5, model_calls = ?6, tool_calls = ?7,
                 interrupted_reason = ?8,
                 awaiting_confirmation_since = CASE
                   WHEN ?4 = 'awaiting_confirmation' AND state <> 'awaiting_confirmation'
                     THEN CAST(strftime('%s','now') AS INTEGER) * 1000
                   WHEN ?4 <> 'awaiting_confirmation' AND state = 'awaiting_confirmation'
                     THEN NULL
                   ELSE awaiting_confirmation_since END,
                 confirmation_wait_ms = CASE
                   WHEN state = 'awaiting_confirmation' AND ?4 <> 'awaiting_confirmation'
                     THEN confirmation_wait_ms + MAX(0,
                       CAST(strftime('%s','now') AS INTEGER) * 1000 - awaiting_confirmation_since)
                   ELSE confirmation_wait_ms END,
                 updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE run_id = ?2 AND epoch = ?3
               AND EXISTS(SELECT 1 FROM agent_runs WHERE id = ?2 AND account_id = ?1)",
            params![
                account_id,
                run_id,
                epoch as i64,
                state,
                seq as i64,
                model_calls as i64,
                tool_calls as i64,
                interrupted_reason
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "Agent lifecycle epoch or owner changed".into(),
            ));
        }
        Ok(())
    }

    pub fn persist_agent_run_delta(
        &mut self,
        account_id: &str,
        run_id: &str,
        epoch: u64,
        seq: u64,
        delta: &str,
    ) -> StorageResult<()> {
        if delta.is_empty() || epoch == 0 || seq == 0 {
            return Err(StorageError::Validation(
                "Invalid agent stream delta".into(),
            ));
        }
        let changed = self.connection.execute(
            "UPDATE agent_run_lifecycle
             SET state = 'running', last_seq = ?4, partial_text = partial_text || ?5,
                 updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE run_id = ?2 AND epoch = ?3 AND state = 'running'
               AND last_seq < ?4 AND length(partial_text || ?5) <= 2097152
               AND EXISTS(SELECT 1 FROM agent_runs WHERE id = ?2 AND account_id = ?1 AND status = 'running')",
            params![account_id, run_id, epoch as i64, seq as i64, delta],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "Agent stream delta exceeded limits or arrived late".into(),
            ));
        }
        Ok(())
    }

    pub fn recover_interrupted_agent_runs(&mut self) -> StorageResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = "CAST(strftime('%s','now') AS INTEGER) * 1000";
        transaction.execute(
            &format!(
                "UPDATE agent_run_lifecycle SET state = 'failed', interrupted_reason = 'interrupted by process restart', updated_at = {now}
                 WHERE state IN ('preparing','running','awaiting_confirmation','applying')
                   AND EXISTS(SELECT 1 FROM agent_runs r
                     WHERE r.id = agent_run_lifecycle.run_id AND r.status = 'running')"
            ),
            [],
        )?;
        transaction.execute(
            &format!(
                "UPDATE agent_runs SET status = 'failed', finished_at = {now} WHERE status = 'running'"
            ),
            [],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn finish_agent_run(
        &mut self,
        account_id: &str,
        run_id: &str,
        status: &str,
    ) -> StorageResult<()> {
        if !matches!(status, "completed" | "cancelled" | "failed") {
            return Err(StorageError::Validation("Invalid agent run status".into()));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE agent_runs SET status = ?3, finished_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE account_id = ?1 AND id = ?2 AND status = 'running'",
            params![account_id, run_id, status],
        )?;
        if changed == 0 {
            let current: Option<String> = transaction
                .query_row(
                    "SELECT status FROM agent_runs WHERE account_id = ?1 AND id = ?2",
                    params![account_id, run_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current.as_deref() != Some(status) {
                return Err(StorageError::Conflict(
                    "Agent run is missing or already settled".into(),
                ));
            }
        }
        let lifecycle_state = match status {
            "completed" => "completed",
            "cancelled" => "cancelled",
            _ => "failed",
        };
        transaction.execute(
            "UPDATE agent_run_lifecycle SET
                 state = ?3,
                 interrupted_reason = CASE WHEN ?3 = 'failed' THEN COALESCE(interrupted_reason, 'Agent run failed') ELSE interrupted_reason END,
                 updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE run_id = ?2 AND EXISTS(
               SELECT 1 FROM agent_runs WHERE account_id = ?1 AND id = ?2
             )",
            params![account_id, run_id, lifecycle_state],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_agent_runs(&self, account_id: &str) -> StorageResult<Vec<AgentRunRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT r.id, r.session_id, r.document_id, r.context_id, r.revision, r.branch_id, r.head_id,
                    r.reference_ids_json, r.status, r.started_at, r.finished_at,
                    COALESCE(l.state, r.status), COALESCE(l.epoch, 1), COALESCE(l.last_seq, 0),
                    COALESCE(l.model_calls, 0), COALESCE(l.tool_calls, 0), COALESCE(l.partial_text, ''),
                    l.interrupted_reason
             FROM agent_runs r LEFT JOIN agent_run_lifecycle l ON l.run_id = r.id
             WHERE r.account_id = ?1 ORDER BY r.started_at DESC, r.id DESC LIMIT 100",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, i64>(12)?,
                row.get::<_, i64>(13)?,
                row.get::<_, i64>(14)?,
                row.get::<_, i64>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, Option<String>>(17)?,
            ))
        })?;
        let mut runs = Vec::new();
        for row in rows {
            let (
                id,
                session_id,
                document_id,
                context_id,
                revision,
                branch_id,
                head_id,
                reference_ids_json,
                status,
                started_at,
                finished_at,
                lifecycle_state,
                epoch,
                last_seq,
                model_calls,
                tool_calls,
                partial_text,
                interrupted_reason,
            ) = row?;
            runs.push(AgentRunRecord {
                id,
                session_id,
                target: AuthorityCursor {
                    document_id,
                    context_id,
                    revision,
                    branch_id,
                    head_id,
                },
                reference_ids: serde_json::from_str(&reference_ids_json)?,
                status,
                lifecycle_state,
                epoch,
                last_seq,
                model_calls,
                tool_calls,
                partial_text,
                interrupted_reason,
                started_at,
                finished_at,
            });
        }
        Ok(runs)
    }
}

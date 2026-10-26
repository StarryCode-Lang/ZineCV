use super::*;

impl Store {
    pub(super) fn validate_agent_sessions(store: &StoredAgentSessionStore) -> StorageResult<()> {
        if store.sessions.is_empty() || store.sessions.len() > 100 {
            return Err(StorageError::Validation(
                "Agent session count is invalid".into(),
            ));
        }
        let mut session_ids = std::collections::HashSet::new();
        let mut message_ids = std::collections::HashSet::new();
        let mut message_count = 0;
        for session in &store.sessions {
            if session.id.is_empty()
                || session.id.len() > 128
                || !session_ids.insert(&session.id)
                || session.title.len() > 256
                || session.created_at <= 0
                || session.updated_at < session.created_at
                || session.messages.len() > 1000
            {
                return Err(StorageError::Validation("Agent session is invalid".into()));
            }
            message_count += session.messages.len();
            for message in &session.messages {
                if message.id.is_empty()
                    || message.id.len() > 128
                    || !message_ids.insert(&message.id)
                    || message.text.len() > 16_000
                    || !["user", "assistant", "system"].contains(&message.role.as_str())
                    || message
                        .source_view
                        .as_deref()
                        .is_some_and(|view| !["editor", "templates", "versions"].contains(&view))
                    || message
                        .source_refs
                        .as_ref()
                        .is_some_and(|refs| refs.len() > 8 || refs.iter().any(|id| id.len() > 256))
                {
                    return Err(StorageError::Validation("Agent message is invalid".into()));
                }
            }
        }
        if message_count > 5000 || !session_ids.contains(&store.active_id) {
            return Err(StorageError::Validation(
                "Agent session selection is invalid".into(),
            ));
        }
        Ok(())
    }

    pub(super) fn persist_agent_sessions(
        transaction: &rusqlite::Transaction<'_>,
        account_id: &str,
        store: &StoredAgentSessionStore,
        revision: i64,
    ) -> StorageResult<()> {
        transaction.execute(
            "DELETE FROM agent_sessions WHERE account_id = ?1",
            [account_id],
        )?;
        for (ordinal, session) in store.sessions.iter().enumerate() {
            transaction.execute(
                "INSERT INTO agent_sessions(id, account_id, ordinal, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![session.id, account_id, ordinal as i64, session.title, session.created_at, session.updated_at],
            )?;
            for (ordinal, message) in session.messages.iter().enumerate() {
                let refs = message
                    .source_refs
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?;
                transaction.execute(
                    "INSERT INTO agent_messages(id, session_id, ordinal, role, text, source_view, source_refs_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![message.id, session.id, ordinal as i64, message.role, message.text, message.source_view, refs],
                )?;
            }
        }
        transaction.execute(
            "INSERT INTO agent_session_meta(account_id, active_session_id, revision) VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET active_session_id = excluded.active_session_id, revision = excluded.revision",
            params![account_id, store.active_id, revision],
        )?;
        Ok(())
    }

    pub(super) fn read_agent_sessions_tx(
        transaction: &rusqlite::Transaction<'_>,
        account_id: &str,
    ) -> StorageResult<Option<AgentSessionState>> {
        let meta: Option<(String, i64)> = transaction
            .query_row(
                "SELECT active_session_id, revision FROM agent_session_meta WHERE account_id = ?1",
                [account_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((active_id, revision)) = meta else {
            return Ok(None);
        };
        let mut statement = transaction.prepare(
            "SELECT id, title, created_at, updated_at FROM agent_sessions WHERE account_id = ?1 ORDER BY ordinal",
        )?;
        let rows = statement
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut sessions = Vec::with_capacity(rows.len());
        for (id, title, created_at, updated_at) in rows {
            let mut messages_statement = transaction.prepare(
                "SELECT id, role, text, source_view, source_refs_json FROM agent_messages WHERE session_id = ?1 ORDER BY ordinal",
            )?;
            let messages = messages_statement
                .query_map([&id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .map(|(id, role, text, source_view, refs)| {
                    Ok(StoredAgentMessage {
                        id,
                        role,
                        text,
                        source_view,
                        source_refs: refs.map(|value| serde_json::from_str(&value)).transpose()?,
                    })
                })
                .collect::<StorageResult<Vec<_>>>()?;
            sessions.push(StoredAgentSession {
                id,
                title,
                created_at,
                updated_at,
                messages,
            });
        }
        let store = StoredAgentSessionStore {
            active_id,
            sessions,
        };
        Self::validate_agent_sessions(&store)?;
        Ok(Some(AgentSessionState { revision, store }))
    }

    pub fn bootstrap_agent_sessions(
        &mut self,
        account_id: &str,
        legacy_json: &str,
    ) -> StorageResult<AgentSessionState> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(state) = Self::read_agent_sessions_tx(&transaction, account_id)? {
            transaction.commit()?;
            return Ok(state);
        }
        let store: StoredAgentSessionStore = serde_json::from_str(legacy_json)?;
        Self::validate_agent_sessions(&store)?;
        Self::persist_agent_sessions(&transaction, account_id, &store, 1)?;
        transaction.commit()?;
        Ok(AgentSessionState { revision: 1, store })
    }

    pub fn replace_agent_sessions(
        &mut self,
        account_id: &str,
        expected_revision: i64,
        payload_json: &str,
    ) -> StorageResult<i64> {
        let store: StoredAgentSessionStore = serde_json::from_str(payload_json)?;
        Self::validate_agent_sessions(&store)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM agent_session_meta WHERE account_id = ?1",
                [account_id],
                |row| row.get(0),
            )
            .optional()?;
        if actual != Some(expected_revision) {
            return Err(StorageError::Conflict(
                "Agent sessions changed in another window".into(),
            ));
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Validation("Agent session revision overflow".into()))?;
        Self::persist_agent_sessions(&transaction, account_id, &store, revision)?;
        transaction.commit()?;
        Ok(revision)
    }

    pub fn load_agent_session(
        &mut self,
        account_id: &str,
        session_id: &str,
    ) -> StorageResult<Option<StoredAgentSession>> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let state = Self::read_agent_sessions_tx(&transaction, account_id)?;
        transaction.commit()?;
        Ok(state.and_then(|state| {
            state
                .store
                .sessions
                .into_iter()
                .find(|session| session.id == session_id)
        }))
    }
}

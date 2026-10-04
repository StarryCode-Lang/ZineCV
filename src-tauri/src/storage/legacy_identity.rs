//! Reviewed identity migration, inside the existing migration transaction.
//! Only password hashes and public provider settings cross into storage.
use super::{StorageError, StorageResult, Store, StoredAgentSessionStore};
use crate::domain::AuthorityCursor;
use crate::migration::{self, LegacyMigrationSourceInput, LegacyMigrationSourceKind};
use rusqlite::{params, OptionalExtension, Transaction};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Counts {
    pub accounts: u32,
    pub providers: u32,
    pub sessions: u32,
    pub secret_reentry: u32,
}

fn invalid(message: &str) -> StorageError {
    StorageError::Validation(message.into())
}

fn field<'a>(value: &'a Value, key: &str) -> StorageResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid("Legacy identity has a missing string field"))
}

pub(super) fn commit(
    tx: &Transaction<'_>,
    namespace: &str,
    sources: &[LegacyMigrationSourceInput],
    cursor: &AuthorityCursor,
) -> StorageResult<Counts> {
    let mut accounts = BTreeMap::new();
    let mut sessions = BTreeMap::new();
    for source in sources {
        let value: Value = serde_json::from_str(&source.raw_json)?;
        let account_payloads = match source.kind {
            LegacyMigrationSourceKind::AccountJson => vec![value],
            LegacyMigrationSourceKind::BrowserExport => {
                let mut payloads = Vec::new();
                for entry in value
                    .get("entries")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(key) = entry.get(0).and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(raw) = entry.get(1).and_then(Value::as_str) else {
                        continue;
                    };
                    if key == "resume-diy-agent-accounts" {
                        payloads.push(serde_json::from_str(raw)?);
                    } else if let Some(account_id) =
                        key.strip_prefix("resume-diy-agent-sessions-v2:")
                    {
                        let payload: Value = serde_json::from_str(raw)?;
                        if let Some(previous) =
                            sessions.insert(account_id.to_string(), payload.clone())
                        {
                            if previous != payload {
                                return Err(StorageError::Conflict(
                                    "Legacy session sources disagree".into(),
                                ));
                            }
                        }
                    }
                }
                payloads
            }
            _ => Vec::new(),
        };
        for payload in account_payloads {
            let records = payload
                .get("accounts")
                .or_else(|| payload.get("users"))
                .unwrap_or(&payload);
            let records: Vec<&Value> = if let Some(items) = records.as_array() {
                items.iter().collect()
            } else if let Some(items) = records.as_object() {
                items.values().collect()
            } else {
                return Err(invalid("Unsupported legacy account schema"));
            };
            for record in records {
                let id = field(record, "id")?;
                if let Some(previous) = accounts.insert(id.to_string(), record.clone()) {
                    if previous != *record {
                        return Err(StorageError::Conflict(
                            "Legacy account sources disagree".into(),
                        ));
                    }
                }
            }
        }
    }
    if accounts.len() > 100 || sessions.len() > 100 {
        return Err(invalid("Legacy identity count exceeds migration limits"));
    }
    let mut counts = Counts::default();
    for (id, account) in accounts {
        let email = crate::identity::normalize_email(field(&account, "email")?)?;
        let salt = field(&account, "salt")?;
        let hash = account
            .get("passwordHash")
            .or_else(|| account.get("password_hash"))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Legacy password hash is missing"))?;
        let kdf = account
            .get("kdf")
            .and_then(Value::as_str)
            .unwrap_or("scrypt-n16384-r8-p1");
        if id.len() > 128
            || email.len() > 254
            || !email.contains('@')
            || salt.len() > 256
            || hash.len() != 128
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || kdf != "scrypt-n16384-r8-p1"
        {
            return Err(invalid(
                "Legacy account or scrypt parameters are unsupported",
            ));
        }
        let existing: Option<(String, String, String, String, String)> = tx.query_row(
            "SELECT id, email, salt, password_hash, kdf FROM accounts WHERE id = ?1 OR email = ?2",
            params![id, email], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        if let Some(actual) = existing {
            if actual
                != (
                    id.clone(),
                    email.clone(),
                    salt.into(),
                    hash.into(),
                    kdf.into(),
                )
            {
                return Err(StorageError::Conflict(
                    "Legacy account conflicts with an existing account".into(),
                ));
            }
        } else {
            tx.execute(
                "INSERT INTO accounts(id,email,salt,password_hash,kdf) VALUES (?1,?2,?3,?4,?5)",
                params![id, email, salt, hash, kdf],
            )?;
        }
        counts.accounts += 1;
        // The old production account schema contains a single `provider`.
        // Unknown provider schemas fail explicitly instead of dropping keys.
        let mut providers = Vec::new();
        if let Some(provider) = account.get("provider").filter(|value| !value.is_null()) {
            providers.push(("primary".to_string(), provider));
        }
        if let Some(items) = account
            .get("providers")
            .or_else(|| account.get("providerProfiles"))
        {
            let items = items
                .as_array()
                .ok_or_else(|| invalid("Unsupported legacy provider schema"))?;
            for provider in items {
                let provider_id = provider
                    .get("connectionId")
                    .or_else(|| provider.get("id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("Legacy provider identity is missing"))?;
                providers.push((provider_id.to_string(), provider));
            }
        }
        for (provider_id, provider) in providers {
            let base_url = field(provider, "baseUrl")?;
            let model = field(provider, "model")?;
            let name = provider.get("name").and_then(Value::as_str).unwrap_or("");
            if provider_id.is_empty()
                || provider_id.len() > 128
                || name.len() > 80
                || model.len() > 256
            {
                return Err(invalid("Legacy provider limits are exceeded"));
            }
            crate::gateway::chat_endpoint(base_url).map_err(StorageError::Validation)?;
            let existing: Option<(String,String,String)> = tx.query_row(
                "SELECT name,base_url,model FROM provider_profiles WHERE account_id=?1 AND connection_id=?2",
                params![id, provider_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).optional()?;
            if let Some(actual) = existing {
                if actual != (name.into(), base_url.into(), model.into()) {
                    return Err(StorageError::Conflict(
                        "Legacy provider conflicts with current settings".into(),
                    ));
                }
            } else {
                tx.execute(
                    "INSERT INTO provider_profiles(account_id,connection_id,name,base_url,model,capability,needs_reentry) VALUES (?1,?2,?3,?4,?5,'chat-only',1)",
                    params![id,provider_id,name,base_url,model],
                )?;
            }
            counts.providers += 1;
            let needs_reentry: bool = tx.query_row(
                "SELECT needs_reentry FROM provider_profiles WHERE account_id=?1 AND connection_id=?2",
                params![id,provider_id], |row| row.get(0),
            )?;
            counts.secret_reentry += u32::from(needs_reentry);
        }
    }
    for (account_id, payload) in sessions {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1)",
            [&account_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(invalid("Legacy session account is missing"));
        }
        let mut imported: StoredAgentSessionStore = serde_json::from_value(payload.clone())?;
        Store::validate_agent_sessions(&imported)?;
        let mut interrupted = Vec::new();
        for session in &mut imported.sessions {
            let legacy_id = session.id.clone();
            let native_id = migration::stable_native_id(
                namespace,
                "agent-session",
                &format!("{account_id}:{legacy_id}"),
            );
            if imported.active_id == legacy_id {
                imported.active_id = native_id.clone();
            }
            if payload
                .get("sessions")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("id").and_then(Value::as_str) == Some(&legacy_id)
                            && item.get("status").and_then(Value::as_str) == Some("running")
                    })
                })
            {
                interrupted.push((native_id.clone(), session.updated_at));
            }
            session.id = native_id;
            for message in &mut session.messages {
                message.id = migration::stable_native_id(
                    namespace,
                    "agent-message",
                    &format!("{account_id}:{legacy_id}:{}", message.id),
                );
            }
        }
        let current = Store::read_agent_sessions_tx(tx, &account_id)?;
        let (mut merged, revision) = current
            .map(|state| (state.store, state.revision))
            .unwrap_or_else(|| {
                (
                    StoredAgentSessionStore {
                        active_id: imported.active_id.clone(),
                        sessions: vec![],
                    },
                    0,
                )
            });
        let mut changed = false;
        for session in imported.sessions {
            if let Some(actual) = merged
                .sessions
                .iter()
                .find(|actual| actual.id == session.id)
            {
                if actual != &session {
                    return Err(StorageError::Conflict(
                        "Legacy session conflicts with current messages".into(),
                    ));
                }
            } else {
                merged.sessions.push(session);
                changed = true;
            }
            counts.sessions += 1;
        }
        if changed {
            Store::validate_agent_sessions(&merged)?;
            let next_revision = revision
                .checked_add(1)
                .ok_or_else(|| invalid("Legacy session revision exceeds storage limits"))?;
            Store::persist_agent_sessions(tx, &account_id, &merged, next_revision)?;
        }
        for (session_id, timestamp) in interrupted {
            let run_id = migration::stable_native_id(namespace, "interrupted-run", &session_id);
            tx.execute(
                "INSERT OR IGNORE INTO agent_runs(id,account_id,session_id,document_id,context_id,revision,branch_id,head_id,reference_ids_json,status,started_at,finished_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'[]','failed',?9,?9)",
                params![run_id,account_id,session_id,cursor.document_id,cursor.context_id,cursor.revision,cursor.branch_id,cursor.head_id,timestamp],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO agent_run_lifecycle(run_id,state,epoch,deadline_at,updated_at,interrupted_reason) VALUES (?1,'failed',1,?2,?2,'Legacy run interrupted during migration; not resumed')",
                params![run_id,timestamp],
            )?;
        }
    }
    Ok(counts)
}

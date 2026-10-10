//! Worker lifecycle assembly; shared Agent owns messages/tools/proposal policy.
use super::store::WebStore;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use zinecv_contracts::{AppError, AuthorityCursor, ErrorCode};
pub(crate) struct Run {
    account: String,
    token: String,
    id: String,
    cursor: AuthorityCursor,
    selected: Vec<Value>,
    seq: u64,
}
fn fail(message: impl Into<String>) -> JsValue {
    super::error(AppError::new(ErrorCode::Validation, message, false))
}
fn parse<T: serde::de::DeserializeOwned>(args: &Value, key: &str) -> Result<T, JsValue> {
    serde_json::from_value(args[key].clone()).map_err(|error| fail(error.to_string()))
}
#[wasm_bindgen]
impl WebStore {
    pub fn prepare_provider(&self, args: &str) -> Result<String, JsValue> {
        let args: Value = serde_json::from_str(args).map_err(|error| fail(error.to_string()))?;
        let base_url: String = parse(&args, "baseUrl")?;
        zinecv_agent::gateway::chat_endpoint(&base_url).map_err(fail)?;
        let model = args["model"].as_str().unwrap_or("").trim().to_string();
        let key = args["key"].as_str().unwrap_or("").trim().to_string();
        let store = self.store.as_ref().ok_or_else(|| fail("Store closed"))?;
        let token = self
            .token
            .as_ref()
            .ok_or_else(|| fail("请先登录本机账户"))?;
        let account = store
            .session_account(token)
            .map_err(super::error)?
            .ok_or_else(|| fail("请先登录本机账户"))?;
        let profile = store
            .provider_profile(token, "primary")
            .map_err(super::error)?;
        let uses_saved_key = key.is_empty()
            && profile
                .as_ref()
                .is_some_and(|profile| profile.base_url == base_url && profile.model == model);
        let key = if key.is_empty() {
            store
                .reveal_provider_secret(&account.id, "primary")
                .map_err(super::error)?
        } else {
            Some(key)
        };
        Ok(json!({ "baseUrl": base_url, "model": model, "key": key, "token": token, "usesSavedKey": uses_saved_key }).to_string())
    }
    pub fn finish_provider(
        &self,
        config: &str,
        result: &str,
        tested: bool,
    ) -> Result<String, JsValue> {
        let config: Value =
            serde_json::from_str(config).map_err(|error| fail(error.to_string()))?;
        if self.token.as_deref() != config["token"].as_str() {
            return Err(fail("账户已切换"));
        }
        let result: Value =
            serde_json::from_str(result).map_err(|error| fail(error.to_string()))?;
        if tested && config["usesSavedKey"] == true {
            let store = self.store.as_ref().ok_or_else(|| fail("Store closed"))?;
            let token = self
                .token
                .as_ref()
                .ok_or_else(|| fail("请先登录本机账户"))?;
            let account = store
                .session_account(token)
                .map_err(super::error)?
                .ok_or_else(|| fail("账户已切换"))?;
            if store
                .reveal_provider_secret(&account.id, "primary")
                .map_err(super::error)?
                == parse::<Option<String>>(&config, "key")?
            {
                store
                    .set_provider_capability(
                        token,
                        "primary",
                        &parse::<String>(&config, "baseUrl")?,
                        &parse::<String>(&config, "model")?,
                        result["structuredOutput"] == true,
                    )
                    .map_err(super::error)?;
            }
        }
        Ok(result.to_string())
    }
    pub fn prepare_agent(&mut self, args: &str) -> Result<String, JsValue> {
        if self.run.is_some() {
            return Err(fail("Agent is already running"));
        }
        let args: Value = serde_json::from_str(args).map_err(|error| fail(error.to_string()))?;
        let cursor: AuthorityCursor = parse(&args, "targetCursor")?;
        let ids: Vec<String> = parse(&args, "referenceIds")?;
        let text: String = parse(&args, "userText")?;
        let session_id: String = parse(&args, "sessionId")?;
        let id: String = parse(&args, "runId")?;
        let skill: Option<String> = parse(&args, "skillId")?;
        if cursor.document_id != "workspace-default-document"
            || text.trim().is_empty()
            || text.chars().count() > 6000
        {
            return Err(fail("Invalid agent request"));
        }
        let store = self.store.as_mut().ok_or_else(|| fail("Store closed"))?;
        let token = self.token.clone().ok_or_else(|| fail("请先登录本机账户"))?;
        let account = store
            .session_account(&token)
            .map_err(super::error)?
            .ok_or_else(|| fail("请先登录本机账户"))?;
        let profile = store
            .provider_profile(&token, "primary")
            .map_err(super::error)?
            .ok_or_else(|| fail("请先配置模型连接"))?;
        if profile.api_key_needs_reentry {
            return Err(fail("模型 Key 无法解密，请重新输入"));
        }
        let key = store
            .reveal_provider_secret(&account.id, "primary")
            .map_err(super::error)?;
        let session = store
            .load_agent_session(&account.id, &session_id)
            .map_err(super::error)?
            .ok_or_else(|| fail("Agent session does not belong to this account"))?;
        let mut selected = zinecv_agent::agent_context::selected_context(store, &cursor, &ids)
            .map_err(super::error)?;
        for (id, payload) in ids.iter().zip(&mut selected) {
            payload["referenceId"] = json!(id);
        }
        let messages = zinecv_agent::agent::build_messages(
            &session.messages,
            &text,
            skill.as_deref(),
            &selected,
        )
        .map_err(fail)?;
        store
            .begin_agent_run(&account.id, &id, &session_id, &cursor, &ids)
            .map_err(super::error)?;
        store
            .update_agent_run_state(&account.id, &id, 1, "running", 0, 0, 0, None)
            .map_err(super::error)?;
        let request = json!({ "baseUrl": profile.base_url, "model": profile.model, "key": key,
            "request": { "messages": messages, "selected": selected, "cursor": cursor, "runId": id,
                "toolsEnabled": profile.capability == "structured", "streamEvents": true } });
        self.run = Some(Run {
            account: account.id,
            token,
            id,
            cursor,
            selected,
            seq: 0,
        });
        Ok(request.to_string())
    }
    pub fn persist_agent_delta(&mut self, id: &str, text: &str) -> Result<(), JsValue> {
        let run = self.run.as_mut().ok_or_else(|| fail("Agent run missing"))?;
        if run.id != id || self.token.as_deref() != Some(&run.token) {
            return Err(fail("Agent account changed"));
        }
        let store = self.store.as_mut().ok_or_else(|| fail("Store closed"))?;
        store
            .validate_active_cursor(&run.cursor)
            .map_err(super::error)?;
        run.seq += 1;
        store
            .persist_agent_run_delta(&run.account, &run.id, 1, run.seq, text)
            .map_err(super::error)
    }
    pub fn finish_browser_agent(
        &mut self,
        outcome: &str,
        failure: Option<String>,
    ) -> Result<String, JsValue> {
        let run = self.run.take().ok_or_else(|| fail("Agent run missing"))?;
        let store = self.store.as_mut().ok_or_else(|| fail("Store closed"))?;
        let result: Value =
            serde_json::from_str(outcome).map_err(|error| fail(error.to_string()))?;
        let publication = (|| -> Result<(), JsValue> {
            if failure.is_none() {
                if self.token.as_deref() != Some(&run.token) {
                    return Err(fail("Agent account changed"));
                }
                store
                    .validate_active_cursor(&run.cursor)
                    .map_err(super::error)?;
                let proposals: Vec<Value> = parse(&result, "proposalDrafts")?;
                let drafts = zinecv_agent::agent::durable_proposal_drafts(
                    &proposals,
                    &run.selected,
                    &run.id,
                )
                .map_err(fail)?;
                store
                    .create_agent_proposals(&run.account, &run.id, &run.cursor, &drafts)
                    .map_err(super::error)?;
            }
            Ok(())
        })();
        let status = if failure
            .as_deref()
            .is_some_and(|message| message.contains("已取消"))
        {
            "cancelled"
        } else if failure.is_some() || publication.is_err() {
            "failed"
        } else {
            "completed"
        };
        store
            .update_agent_run_state(
                &run.account,
                &run.id,
                1,
                status,
                run.seq,
                result["modelCalls"].as_u64().unwrap_or(0) as u8,
                result["toolCalls"].as_u64().unwrap_or(0) as u8,
                failure.as_deref(),
            )
            .map_err(super::error)?;
        store
            .finish_agent_run(&run.account, &run.id, status)
            .map_err(super::error)?;
        publication?;
        Ok(result["reply"].to_string())
    }
}

#[wasm_bindgen]
pub async fn browser_provider(config: &str, tested: bool) -> Result<String, JsValue> {
    let config: Value = serde_json::from_str(config).map_err(|error| fail(error.to_string()))?;
    let config = zinecv_agent::gateway::ProviderConfig {
        base_url: parse(&config, "baseUrl")?,
        model: parse(&config, "model")?,
        key: parse(&config, "key")?,
    };
    let value = if tested {
        if config.model.is_empty() {
            return Err(fail("请填写模型 ID"));
        }
        serde_json::to_value(
            zinecv_agent::browser::test_connection(config)
                .await
                .map_err(fail)?,
        )
    } else {
        serde_json::to_value(
            zinecv_agent::browser::discover_models(config)
                .await
                .map_err(fail)?,
        )
    };
    value
        .map(|value| value.to_string())
        .map_err(|error| fail(error.to_string()))
}

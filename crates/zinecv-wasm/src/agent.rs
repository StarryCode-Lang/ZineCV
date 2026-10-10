use serde_json::{json, Value};
use std::cell::Cell;
use tokio::sync::watch;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/js/agent-events.mjs")]
extern "C" {
    #[wasm_bindgen(catch)]
    fn emit_agent_delta(run_id: &str, text: &str) -> Result<(), JsValue>;
}

fn failure(value: impl std::fmt::Display) -> JsValue {
    super::error(zinecv_contracts::AppError::new(
        zinecv_contracts::ErrorCode::ProviderFailure,
        value.to_string(),
        false,
    ))
}
#[wasm_bindgen]
pub struct WebAgent {
    cancelled: watch::Sender<bool>,
    busy: Cell<bool>,
}
struct Busy<'a>(&'a Cell<bool>);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

#[wasm_bindgen]
impl WebAgent {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            cancelled: watch::channel(false).0,
            busy: Cell::new(false),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.send_replace(true);
    }
    pub async fn run(
        &self,
        base_url: &str,
        model: &str,
        key: &str,
        request: &str,
    ) -> Result<String, JsValue> {
        if self.busy.replace(true) {
            return Err(failure("Agent is already running"));
        }
        let _busy = Busy(&self.busy);
        self.cancelled.send_replace(false);
        let request: Value = serde_json::from_str(request).map_err(failure)?;
        let messages = serde_json::from_value(request["messages"].clone()).map_err(failure)?;
        let selected: Vec<Value> =
            serde_json::from_value(request["selected"].clone()).map_err(failure)?;
        let cursor = serde_json::from_value(request["cursor"].clone()).map_err(failure)?;
        let run_id = request["runId"]
            .as_str()
            .ok_or_else(|| failure("Run ID required"))?;
        let mut deltas = Vec::new();
        let mut events = Vec::new();
        let stream_events = request["streamEvents"].as_bool().unwrap_or(false);
        let cancellation = self.cancelled.clone();
        let result = zinecv_agent::agent::run_agent_turns_with_transport(
            &zinecv_agent::browser::BrowserTransport,
            zinecv_agent::gateway::ProviderConfig {
                base_url: base_url.into(),
                model: model.into(),
                key: (!key.is_empty()).then(|| key.into()),
            },
            messages,
            &selected,
            &cursor,
            run_id,
            request["toolsEnabled"].as_bool().unwrap_or(false),
            self.cancelled.subscribe(),
            |delta| {
                if stream_events && emit_agent_delta(run_id, &delta).is_err() {
                    cancellation.send_replace(true);
                }
                deltas.push(delta);
            },
            |kind, value| events.push(json!({ "kind": kind, "value": value })),
        )
        .await
        .map_err(failure)?;
        Ok(json!({ "reply": result.reply, "modelCalls": result.model_calls, "toolCalls": result.tool_calls,
            "proposalDrafts": result.proposal_drafts, "deltas": deltas, "events": events }).to_string())
    }
}

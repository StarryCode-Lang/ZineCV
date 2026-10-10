//! Browser fetch adapter. Shared Rust code retains SSE parsing and Agent policy.
use crate::gateway::{self, ChatMessage, ProviderConfig, SseFrames};
use crate::transport::{AgentTransport, ChatFuture};
use futures_util::future::{select, Either};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::sync::watch;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(module = "/js/browser-fetch.mjs")]
extern "C" {
    fn fetch_json(url: &str, method: &str, body: &str, key: &str, limit: u32) -> js_sys::Promise;
    fn create_stream() -> JsValue;
    fn open_stream(handle: &JsValue, url: &str, body: &str, key: &str) -> js_sys::Promise;
    fn read_stream(handle: &JsValue) -> js_sys::Promise;
    fn close_stream(handle: &JsValue);
}
async fn json_request(
    config: &ProviderConfig,
    url: &str,
    method: &str,
    body: &str,
    limit: u32,
) -> Result<Vec<u8>, String> {
    let value = JsFuture::from(fetch_json(
        url,
        method,
        body,
        config.key.as_deref().unwrap_or(""),
        limit,
    ))
    .await
    .map_err(|_| "Provider 请求失败：请检查地址、CORS 和网络".to_string())?;
    Ok(js_sys::Uint8Array::new(&value).to_vec())
}
pub async fn discover_models(config: ProviderConfig) -> Result<gateway::ModelDiscovery, String> {
    let endpoint = gateway::models_endpoint(&config.base_url)?;
    let bytes = json_request(&config, endpoint.as_str(), "GET", "", 1024 * 1024).await?;
    gateway::parse_model_discovery(&config.base_url, &bytes)
}
pub async fn test_connection(config: ProviderConfig) -> Result<gateway::ConnectionTest, String> {
    let (_sender, cancel) = watch::channel(false);
    let mut ignore = |_| {};
    let reply = crate::runtime::timeout(
        Duration::from_secs(45),
        BrowserTransport.stream(
            config.clone(),
            vec![ChatMessage {
                role: "user".into(),
                content: "Reply OK.".into(),
                provider_tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            None,
            cancel,
            &mut ignore,
        ),
    )
    .await
    .map_err(|_| "模型连接测试超时".to_string())??;
    if reply.content.trim().is_empty() {
        return Err("模型未返回可用的基础响应".into());
    }
    let (nonce, body) = gateway::structured_probe_body(&config.model)?;
    let endpoint = gateway::chat_endpoint(&config.base_url)?;
    let structured_output = match json_request(
        &config,
        endpoint.as_str(),
        "POST",
        &body.to_string(),
        256 * 1024,
    )
    .await
    {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .is_ok_and(|value| gateway::verify_structured_probe(&value, &nonce)),
        Err(_) => false,
    };
    Ok(gateway::ConnectionTest {
        success: true,
        structured_output,
        model: reply.model,
    })
}
struct Stream(JsValue);
impl Drop for Stream {
    fn drop(&mut self) {
        close_stream(&self.0);
    }
}

async fn cancellable<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<T, String> {
    if *cancelled.borrow() {
        return Err("模型请求已取消".into());
    }
    let cancellation = cancelled.changed();
    futures_util::pin_mut!(future, cancellation);
    match select(future, cancellation).await {
        Either::Left((result, _)) => result,
        Either::Right(_) => Err("模型请求已取消".into()),
    }
}

pub struct BrowserTransport;
impl AgentTransport for BrowserTransport {
    fn stream<'a>(
        &'a self,
        config: ProviderConfig,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Value>>,
        mut cancelled: watch::Receiver<bool>,
        on_delta: &'a mut (dyn FnMut(String) + Send),
    ) -> ChatFuture<'a> {
        Box::pin(async move {
            gateway::validate_messages(&messages)?;
            let endpoint = gateway::chat_endpoint(&config.base_url)?;
            let mut body = json!({ "model": config.model, "messages": messages, "stream": true, "max_tokens": 1400 });
            if let Some(tools) = tools {
                body["tools"] = json!(tools);
                body["tool_choice"] = json!("auto");
            }
            let stream = Stream(create_stream());
            let open = async {
                JsFuture::from(open_stream(
                    &stream.0,
                    endpoint.as_str(),
                    &body.to_string(),
                    config.key.as_deref().unwrap_or(""),
                ))
                .await
                .map_err(|_| {
                    "当前浏览器无法连接该 Provider：请检查 CORS、地址和网络".to_string()
                })?;
                Ok(())
            };
            cancellable(
                async {
                    crate::runtime::timeout(Duration::from_secs(45), open)
                        .await
                        .map_err(|_| "模型连接超时".to_string())?
                },
                &mut cancelled,
            )
            .await?;
            let mut frames = SseFrames::default();
            let mut content = String::new();
            let mut model = String::new();
            let mut calls = BTreeMap::new();
            let mut done = false;
            while !done {
                let read = async {
                    JsFuture::from(read_stream(&stream.0))
                        .await
                        .map_err(|_| "模型流式连接中断".to_string())
                };
                let value = cancellable(read, &mut cancelled).await?;
                let incoming = if value.is_null() {
                    frames.finish()?
                } else {
                    frames.push(&js_sys::Uint8Array::new(&value).to_vec())?
                };
                for frame in incoming {
                    let (delta, complete) =
                        gateway::accept_frame(&frame, &mut content, &mut model, &mut calls)?;
                    if let Some(text) = delta {
                        on_delta(text);
                    }
                    if complete {
                        done = true;
                        break;
                    }
                }
                if value.is_null() {
                    break;
                }
            }
            if !done {
                return Err("模型流式响应提前结束".into());
            }
            if *cancelled.borrow() {
                return Err("模型请求已取消".into());
            }
            gateway::finish_reply(content, model, calls)
        })
    }
}

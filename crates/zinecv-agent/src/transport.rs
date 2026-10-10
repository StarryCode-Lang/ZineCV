//! Platform transport seam. Agent policy never owns an HTTP client.
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use tokio::sync::watch;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use crate::gateway;
use crate::gateway::{ChatMessage, ChatReply, ProviderConfig};

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub type ChatFuture<'a> = Pin<Box<dyn Future<Output = Result<ChatReply, String>> + Send + 'a>>;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub type ChatFuture<'a> = Pin<Box<dyn Future<Output = Result<ChatReply, String>> + 'a>>;

pub trait AgentTransport: Send + Sync {
    fn stream<'a>(
        &'a self,
        config: ProviderConfig,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Value>>,
        cancelled: watch::Receiver<bool>,
        on_delta: &'a mut (dyn FnMut(String) + Send),
    ) -> ChatFuture<'a>;
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub struct NativeTransport;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl AgentTransport for NativeTransport {
    fn stream<'a>(
        &'a self,
        config: ProviderConfig,
        messages: Vec<ChatMessage>,
        tools: Option<Vec<Value>>,
        cancelled: watch::Receiver<bool>,
        on_delta: &'a mut (dyn FnMut(String) + Send),
    ) -> ChatFuture<'a> {
        Box::pin(async move {
            match tools {
                Some(tools) => {
                    gateway::stream_chat_with_tools(config, messages, tools, cancelled, |delta| {
                        on_delta(delta.text)
                    })
                    .await
                }
                None => {
                    gateway::stream_chat(config, messages, cancelled, |delta| on_delta(delta.text))
                        .await
                }
            }
        })
    }
}

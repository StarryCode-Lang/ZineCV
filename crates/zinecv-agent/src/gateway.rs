//! Account-scoped OpenAI-compatible chat transport. User text is JSON data;
//! provider URLs and credentials never come from an individual chat request.
use std::collections::BTreeMap;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::Value;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use tokio::sync::watch;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use url::Host;
use url::Url;

const MAX_REQUEST_BYTES: usize = 48 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(
        default,
        rename = "tool_calls",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider_tool_calls: Option<Vec<ProviderToolCall>>,
    #[serde(
        default,
        rename = "tool_call_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: ProviderToolFunction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderToolFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub content: String,
    pub model: String,
    pub tool_calls: Vec<ChatToolCall>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDelta {
    pub text: String,
}

#[derive(Clone)]
pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
    pub key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscovery {
    pub base_url: String,
    pub models: Vec<DiscoveredModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTest {
    pub success: bool,
    pub structured_output: bool,
    pub model: String,
}

// C+ P3b：chat_endpoint（模型端点 URL 安全校验）已迁入 zinecv-contracts，
// 此处再出口保持 `gateway::chat_endpoint` 引用路径不变（lib.rs 与迁移
// 身份检查双侧单源消费；安全校验逻辑不得出现第二份实现）。
pub use zinecv_contracts::chat_endpoint;

pub(crate) fn models_endpoint(base_url: &str) -> Result<Url, String> {
    let mut endpoint = chat_endpoint(base_url)?;
    let path = endpoint.path().trim_end_matches("/chat/completions");
    endpoint.set_path(&format!("{path}/models"));
    Ok(endpoint)
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            (0x2000..=0x3fff).contains(&segments[0])
                && segments[0] != 0x2002
                && !(segments[0] == 0x2001 && matches!(segments[1], 0 | 0x0db8))
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
fn vet_resolved_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() || addresses.iter().any(|addr| !public_ip(addr.ip())) {
        return Err("模型域名解析到非公网地址".into());
    }
    Ok(())
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
async fn client(endpoint: &Url, timeout: Duration) -> Result<reqwest::Client, String> {
    let port = endpoint.port_or_known_default().ok_or("模型连接缺少端口")?;
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout);
    match endpoint.host().ok_or("模型连接缺少主机")? {
        Host::Domain("localhost") => {
            builder = builder.resolve_to_addrs(
                "localhost",
                &[
                    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
                    SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
                ],
            );
        }
        Host::Domain(domain) => {
            let addresses: Vec<SocketAddr> = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::net::lookup_host((domain, port)),
            )
            .await
            .map_err(|_| "模型域名解析超时".to_string())?
            .map_err(|_| "模型域名解析失败".to_string())?
            .collect();
            vet_resolved_addresses(&addresses)?;
            builder = builder.resolve_to_addrs(domain, &addresses);
        }
        Host::Ipv4(ip) if !ip.is_loopback() && !public_ip(IpAddr::V4(ip)) => {
            return Err("模型地址不是公网或显式本机地址".into());
        }
        Host::Ipv6(ip) if !ip.is_loopback() && !public_ip(IpAddr::V6(ip)) => {
            return Err("模型地址不是公网或显式本机地址".into());
        }
        _ => {}
    }
    builder
        .build()
        .map_err(|_| "模型网络客户端初始化失败".into())
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub async fn discover_models(config: ProviderConfig) -> Result<ModelDiscovery, String> {
    let endpoint = models_endpoint(&config.base_url)?;
    let mut request = client(&endpoint, Duration::from_secs(20))
        .await?
        .get(endpoint);
    if let Some(key) = config.key.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "模型列表连接失败或超时".to_string())?;
    if !response.status().is_success() {
        return Err(format!("模型列表返回 HTTP {}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "模型列表传输中断".to_string())?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("模型列表超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_model_discovery(&config.base_url, &bytes)
}

pub(crate) fn parse_model_discovery(
    base_url: &str,
    bytes: &[u8],
) -> Result<ModelDiscovery, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "模型列表 JSON 无效")?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "模型列表缺少 data".to_string())?
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?;
            if id.is_empty() || id.len() > 256 {
                return None;
            }
            let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(DiscoveredModel {
                id: id.to_string(),
                name: name.chars().take(256).collect(),
            })
        })
        .take(256)
        .collect();
    Ok(ModelDiscovery {
        base_url: base_url.to_string(),
        models,
    })
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub async fn test_connection(config: ProviderConfig) -> Result<ConnectionTest, String> {
    let (_sender, cancel) = watch::channel(false);
    let reply = stream_chat_with_limit(
        config.clone(),
        vec![ChatMessage {
            role: "user".into(),
            content: "Reply OK.".into(),
            provider_tool_calls: None,
            tool_call_id: None,
            name: None,
        }],
        cancel,
        |_| {},
        16,
        None,
    )
    .await?;
    if reply.content.trim().is_empty() {
        return Err("模型未返回可用的基础响应".into());
    }
    let structured_output = probe_structured(config).await.unwrap_or(false);
    Ok(ConnectionTest {
        success: true,
        structured_output,
        model: reply.model,
    })
}

pub(crate) fn verify_structured_probe(value: &Value, nonce: &str) -> bool {
    let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return false;
    };
    if choice.get("finish_reason").and_then(Value::as_str) != Some("tool_calls") {
        return false;
    }
    let Some(calls) = choice
        .get("message")
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    if calls.len() != 1 {
        return false;
    }
    let call = &calls[0];
    if call.get("type").and_then(Value::as_str) != Some("function")
        || call
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        || call
            .get("function")
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            != Some("zinecv_capability_probe")
    {
        return false;
    }
    let Some(arguments) = call
        .get("function")
        .and_then(|function| function.get("arguments"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    if arguments.len() > 4096 {
        return false;
    }
    let Ok(arguments) = serde_json::from_str::<Value>(arguments) else {
        return false;
    };
    arguments.as_object().is_some_and(|object| {
        object.len() == 1 && object.get("nonce").and_then(Value::as_str) == Some(nonce)
    })
}

pub(crate) fn structured_probe_body(model: &str) -> Result<(String, Value), String> {
    let mut random = [0u8; 12];
    getrandom::fill(&mut random).map_err(|_| "能力测试随机数不可用".to_string())?;
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let body = json!({
        "model": model,
        "messages": [{"role":"user", "content": format!("Call zinecv_capability_probe with nonce {nonce}.")}],
        "stream": false,
        "max_tokens": 64,
        "tools": [{
            "type": "function",
            "function": {
                "name": "zinecv_capability_probe",
                "description": "Return the exact verification nonce.",
                "parameters": {
                    "type": "object",
                    "properties": {"nonce": {"type": "string", "enum": [nonce]}},
                    "required": ["nonce"],
                    "additionalProperties": false
                }
            }
        }],
        "tool_choice": {"type":"function", "function":{"name":"zinecv_capability_probe"}}
    });
    Ok((nonce, body))
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
async fn probe_structured(config: ProviderConfig) -> Result<bool, String> {
    let endpoint = chat_endpoint(&config.base_url)?;
    let client = client(&endpoint, Duration::from_secs(25)).await?;
    let (nonce, body) = structured_probe_body(&config.model)?;
    let mut request = client.post(endpoint).json(&body);
    if let Some(key) = config.key.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| "结构化能力测试连接失败".to_string())?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "结构化能力测试响应中断".to_string())?
    {
        if bytes.len() + chunk.len() > 256 * 1024 {
            return Ok(false);
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "结构化能力测试 JSON 无效".to_string())?;
    Ok(verify_structured_probe(&value, &nonce))
}

pub(crate) fn validate_messages(messages: &[ChatMessage]) -> Result<(), String> {
    if messages.is_empty() || messages.len() > 64 {
        return Err("模型消息数量超出限制".into());
    }
    let mut bytes = 0;
    for message in messages {
        if !matches!(
            message.role.as_str(),
            "system" | "user" | "assistant" | "tool"
        ) {
            return Err("模型消息角色无效".into());
        }
        bytes += message.content.len();
        if let Some(calls) = &message.provider_tool_calls {
            if message.role != "assistant" || calls.len() > 4 {
                return Err("模型工具消息格式无效".into());
            }
            bytes += serde_json::to_vec(calls)
                .map_err(|_| "模型工具消息无效")?
                .len();
        }
        if message.role == "tool" && message.tool_call_id.as_deref().is_none_or(str::is_empty) {
            return Err("模型工具响应缺少调用 ID".into());
        }
        if bytes > MAX_REQUEST_BYTES {
            return Err("模型上下文超出大小限制".into());
        }
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct SseFrames {
    pending: Vec<u8>,
    lines: Vec<Vec<u8>>,
    received: usize,
}

impl SseFrames {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.received += bytes.len();
        if self.received > MAX_RESPONSE_BYTES {
            return Err("模型流式响应超过大小限制".into());
        }
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending.drain(..=end).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                if !self.lines.is_empty() {
                    let joined = self.lines.join(&b'\n');
                    frames.push(String::from_utf8(joined).map_err(|_| "模型流式响应 UTF-8 无效")?);
                    self.lines.clear();
                }
            } else if let Some(value) = line.strip_prefix(b"data:") {
                self.lines
                    .push(value.strip_prefix(b" ").unwrap_or(value).to_vec());
            }
        }
        Ok(frames)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<String>, String> {
        self.pending.push(b'\n');
        let mut frames = self.push(&[])?;
        frames.extend(self.push(b"\n")?);
        Ok(frames)
    }
}

pub(crate) fn accept_frame(
    frame: &str,
    content: &mut String,
    model: &mut String,
    tool_calls: &mut BTreeMap<u64, ChatToolCall>,
) -> Result<(Option<String>, bool), String> {
    if frame == "[DONE]" {
        return Ok((None, true));
    }
    let value: Value = serde_json::from_str(frame).map_err(|_| "模型流式事件 JSON 无效")?;
    if value.get("error").is_some() {
        return Err("模型服务返回错误事件".into());
    }
    if let Some(name) = value.get("model").and_then(Value::as_str) {
        *model = name.to_string();
    }
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "模型流式事件缺少 choices".to_string())?;
    let delta = choice
        .get("delta")
        .ok_or_else(|| "模型流式事件缺少 delta".to_string())?;
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for piece in calls {
            let index = piece
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| "模型工具调用缺少索引".to_string())?;
            let call = tool_calls.entry(index).or_insert_with(|| ChatToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if let Some(id) = piece.get("id").and_then(Value::as_str) {
                if call.id.len() + id.len() > 128 {
                    return Err("模型工具调用 ID 超过大小限制".into());
                }
                call.id.push_str(id);
            }
            if let Some(function) = piece.get("function") {
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    call.name.push_str(name);
                }
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    if call.arguments.len() + arguments.len() > 16 * 1024 {
                        return Err("模型工具参数超过大小限制".into());
                    }
                    call.arguments.push_str(arguments);
                }
            }
        }
    } else if delta
        .get("tool_calls")
        .is_some_and(|calls| !calls.is_null())
    {
        return Err("模型工具调用格式无效".into());
    }
    let text = delta.get("content").and_then(Value::as_str).unwrap_or("");
    if content.len() + text.len() > MAX_RESPONSE_BYTES {
        return Err("模型回复超过大小限制".into());
    }
    content.push_str(text);
    Ok(((!text.is_empty()).then(|| text.to_string()), false))
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub async fn stream_chat(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    cancelled: watch::Receiver<bool>,
    on_delta: impl FnMut(ChatDelta) + Send,
) -> Result<ChatReply, String> {
    stream_chat_with_limit(config, messages, cancelled, on_delta, 1400, None).await
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub async fn stream_chat_with_tools(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    tools: Vec<Value>,
    cancelled: watch::Receiver<bool>,
    on_delta: impl FnMut(ChatDelta) + Send,
) -> Result<ChatReply, String> {
    if tools.is_empty()
        || tools.len() > 5
        || serde_json::to_vec(&tools).map_or(true, |bytes| bytes.len() > 24 * 1024)
    {
        return Err("Agent 工具定义超出限制".into());
    }
    stream_chat_with_limit(config, messages, cancelled, on_delta, 1400, Some(tools)).await
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
async fn stream_chat_with_limit(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    mut cancelled: watch::Receiver<bool>,
    mut on_delta: impl FnMut(ChatDelta) + Send,
    max_tokens: u16,
    tools: Option<Vec<Value>>,
) -> Result<ChatReply, String> {
    validate_messages(&messages)?;
    let endpoint = chat_endpoint(&config.base_url)?;
    let client = client(&endpoint, Duration::from_secs(45)).await?;
    let mut body = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens,
    });
    if let Some(tools) = tools {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    let mut request = client.post(endpoint).json(&body);
    if let Some(key) = config.key.filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let send = request.send();
    tokio::pin!(send);
    let mut response = tokio::select! {
        response = &mut send => response.map_err(|_| "模型连接失败或超时".to_string())?,
        _ = cancelled.changed() => return Err("模型请求已取消".into()),
    };
    if !response.status().is_success() {
        return Err(format!("模型服务返回 HTTP {}", response.status().as_u16()));
    }
    let mut frames = SseFrames::default();
    let mut content = String::new();
    let mut model = String::new();
    let mut tool_calls = BTreeMap::<u64, ChatToolCall>::new();
    let mut done = false;
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.map_err(|_| "模型流式连接中断".to_string())?,
            _ = cancelled.changed() => return Err("模型请求已取消".into()),
        };
        let Some(chunk) = chunk else { break };
        if *cancelled.borrow() {
            return Err("模型请求已取消".into());
        }
        for frame in frames.push(&chunk)? {
            if *cancelled.borrow() {
                return Err("模型请求已取消".into());
            }
            let (delta, complete) =
                accept_frame(&frame, &mut content, &mut model, &mut tool_calls)?;
            if let Some(text) = delta {
                on_delta(ChatDelta { text });
            }
            if complete {
                done = true;
                break;
            }
        }
        if done {
            break;
        }
    }
    if !done {
        for frame in frames.finish()? {
            let (delta, complete) =
                accept_frame(&frame, &mut content, &mut model, &mut tool_calls)?;
            if let Some(text) = delta {
                on_delta(ChatDelta { text });
            }
            if complete {
                done = true;
            }
        }
    }
    if !done {
        return Err("模型流式响应提前结束".into());
    }
    if *cancelled.borrow() {
        return Err("模型请求已取消".into());
    }
    finish_reply(content, model, tool_calls)
}

pub(crate) fn finish_reply(
    content: String,
    model: String,
    tool_calls: BTreeMap<u64, ChatToolCall>,
) -> Result<ChatReply, String> {
    let mut completed_calls = Vec::with_capacity(tool_calls.len());
    let mut unique_ids = std::collections::HashSet::<String>::new();
    for (_, call) in tool_calls {
        if call.id.is_empty()
            || call.id.len() > 128
            || call.name.is_empty()
            || call.name.len() > 80
            || call.arguments.is_empty()
            || !unique_ids.insert(call.id.clone())
        {
            return Err("模型工具调用缺少有效字段或包含重复 ID".into());
        }
        completed_calls.push(call);
    }
    Ok(ChatReply {
        content,
        model,
        tool_calls: completed_calls,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_context_can_use_the_total_request_budget() {
        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: "rules".into(),
                provider_tool_calls: None,
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: "user".into(),
                content: "x".repeat(36_000),
                provider_tool_calls: None,
                tool_call_id: None,
                name: None,
            },
        ];
        assert!(validate_messages(&messages).is_ok());
        let oversized = vec![ChatMessage {
            role: "user".into(),
            content: "x".repeat(MAX_REQUEST_BYTES + 1),
            provider_tool_calls: None,
            tool_call_id: None,
            name: None,
        }];
        assert!(validate_messages(&oversized).is_err());
    }
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn mock_server(
        status: &str,
        body: &str,
        extra_headers: &str,
        delay_body: bool,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind isolated HTTP fixture");
        let port = listener.local_addr().expect("local address").port();
        let status = status.to_string();
        let body = body.to_string();
        let extra_headers = extra_headers.to_string();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept local fixture");
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut request = [0u8; 8192];
            let size = socket.read(&mut request).expect("read request");
            assert!(String::from_utf8_lossy(&request[..size])
                .starts_with("POST /v1/chat/completions HTTP/1.1"));
            let headers = format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n", body.len());
            socket.write_all(headers.as_bytes()).expect("write headers");
            if delay_body {
                std::thread::sleep(Duration::from_millis(300));
            }
            let _ = socket.write_all(body.as_bytes());
        });
        (format!("http://127.0.0.1:{port}/v1"), handle)
    }

    #[test]
    fn url_policy_rejects_credential_redirect_and_foreign_http() {
        assert_eq!(
            chat_endpoint("https://api.example.com/v1")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/chat/completions"
        );
        assert!(chat_endpoint("http://example.com/v1").is_err());
        assert!(chat_endpoint("https://user:pass@example.com/v1").is_err());
        assert!(chat_endpoint("https://api.example.com/v1?token=x").is_err());
        assert!(chat_endpoint("http://127.0.0.1:3000/v1").is_ok());
    }

    #[test]
    fn address_policy_rejects_private_and_tunneled_destinations() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "198.18.0.1",
            "203.0.113.1",
            "::1",
            "fd00::1",
            "2001:db8::1",
            "2002::1",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(vet_resolved_addresses(&[
            "8.8.8.8:443".parse().unwrap(),
            "10.0.0.1:443".parse().unwrap(),
        ])
        .is_err());
        tokio::runtime::Runtime::new()
            .expect("test runtime")
            .block_on(async {
                let endpoint = chat_endpoint("https://10.0.0.1/v1").unwrap();
                assert!(client(&endpoint, Duration::from_secs(1)).await.is_err());
            });
    }

    #[test]
    fn sse_keeps_utf8_and_multiline_data_across_chunks() {
        let payload = "data: {\"choices\":[{\"delta\":{\"content\":\"中";
        let mut parser = SseFrames::default();
        let mut frames = Vec::new();
        for byte in payload.as_bytes().chunks(1) {
            frames.extend(parser.push(byte).unwrap());
        }
        assert!(frames.is_empty());
        frames.extend(parser.push("文\"}}],\n".as_bytes()).unwrap());
        frames.extend(
            parser
                .push(b"data: \"model\":\"fixture\"}\r\n\r\n")
                .unwrap(),
        );
        let mut content = String::new();
        let mut model = String::new();
        let mut tools = BTreeMap::new();
        let (delta, done) = accept_frame(&frames[0], &mut content, &mut model, &mut tools).unwrap();
        assert_eq!(delta.as_deref(), Some("中文"));
        assert!(!done);
        assert_eq!(model, "fixture");
    }

    #[test]
    fn rejects_malformed_event_and_tool_calls() {
        let mut content = String::new();
        let mut model = String::new();
        let mut tools = BTreeMap::new();
        assert!(accept_frame("not json", &mut content, &mut model, &mut tools).is_err());
        assert!(accept_frame(
            "{\"error\":{\"message\":\"denied\"}}",
            &mut content,
            &mut model,
            &mut tools,
        )
        .unwrap_err()
        .contains("错误事件"));
    }

    #[test]
    fn streaming_tool_call_fragments_are_assembled_by_index() {
        let mut content = String::new();
        let mut model = String::new();
        let mut tools = BTreeMap::new();
        let frames = [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read_","arguments":"{\"id\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"selected","arguments":"\"basic:name\"}"}}]}}]}"#,
        ];
        for frame in frames {
            accept_frame(frame, &mut content, &mut model, &mut tools).unwrap();
        }
        let call = tools.get(&0).expect("assembled tool call");
        assert_eq!(call.id, "call-1");
        assert_eq!(call.name, "read_selected");
        assert_eq!(call.arguments, "{\"id\":\"basic:name\"}");
    }

    #[test]
    fn structured_probe_requires_one_exact_function_call() {
        let nonce = "fixture-nonce";
        let valid = json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {"tool_calls": [{
                    "id": "call-fixture",
                    "type": "function",
                    "function": {"name": "zinecv_capability_probe", "arguments": "{\"nonce\":\"fixture-nonce\"}"}
                }]}
            }]
        });
        assert!(verify_structured_probe(&valid, nonce));
        let mut wrong = valid.clone();
        wrong["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] =
            json!("{\"nonce\":\"wrong\"}");
        assert!(!verify_structured_probe(&wrong, nonce));
        wrong = valid.clone();
        wrong["choices"][0]["finish_reason"] = json!("stop");
        assert!(!verify_structured_probe(&wrong, nonce));
        wrong = valid.clone();
        wrong["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] =
            json!("{\"nonce\":\"fixture-nonce\",\"extra\":1}");
        assert!(!verify_structured_probe(&wrong, nonce));
        wrong = valid.clone();
        wrong["choices"][0]["message"]["tool_calls"]
            .as_array_mut()
            .unwrap()
            .push(valid["choices"][0]["message"]["tool_calls"][0].clone());
        assert!(!verify_structured_probe(&wrong, nonce));
    }

    #[test]
    fn loopback_model_list_and_basic_connection_test() {
        tokio::runtime::Runtime::new().expect("test runtime").block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind model fixture");
            let port = listener.local_addr().expect("address").port();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().expect("accept model request");
                let mut request = [0u8; 4096];
                let size = socket.read(&mut request).expect("read model request");
                let request = String::from_utf8_lossy(&request[..size]);
                assert!(request.starts_with("GET /v1/models HTTP/1.1"));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer sk-fixture"));
                let body = r#"{"data":[{"id":"fixture-model","name":"Fixture"}]}"#;
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).expect("write model list");
            });
            let base_url = format!("http://127.0.0.1:{port}/v1");
            let models = discover_models(ProviderConfig {
                base_url: base_url.clone(),
                model: String::new(),
                key: Some("sk-fixture".into()),
            })
            .await
            .expect("discover models");
            server.join().expect("model server");
            assert_eq!(models.base_url, base_url);
            assert_eq!(models.models.len(), 1);
            assert_eq!(models.models[0].id, "fixture-model");

            let body = "data: {\"model\":\"fixture-model\",\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n";
            let (base_url, server) = mock_server("200 OK", body, "", false);
            let result = test_connection(ProviderConfig {
                base_url,
                model: "fixture-model".into(),
                key: None,
            })
            .await
            .expect("test connection");
            server.join().expect("test server");
            assert!(result.success);
            assert!(!result.structured_output);
            assert_eq!(result.model, "fixture-model");
        });
    }

    #[test]
    fn invalid_key_failure_does_not_echo_secret() {
        tokio::runtime::Runtime::new()
            .expect("test runtime")
            .block_on(async {
                let secret = "sk-fixture-never-echo-this";
                let (base_url, server) = mock_server("401 Unauthorized", "unauthorized", "", false);
                let (_sender, cancel) = watch::channel(false);
                let error = stream_chat(
                    ProviderConfig {
                        base_url,
                        model: "fixture-model".into(),
                        key: Some(secret.into()),
                    },
                    vec![ChatMessage {
                        role: "user".into(),
                        content: "synthetic request".into(),
                        provider_tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    }],
                    cancel,
                    |_| {},
                )
                .await
                .expect_err("invalid key should fail");
                server.join().expect("mock server");
                assert_eq!(error, "模型服务返回 HTTP 401");
                assert!(!error.contains(secret));
            });
    }

    #[test]
    fn loopback_chat_streams_text_and_refuses_redirect() {
        tokio::runtime::Runtime::new()
            .expect("test runtime")
            .block_on(async {
                let body = concat!(
                "data: {\"model\":\"fixture\",\"choices\":[{\"delta\":{\"content\":\"中\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"文\"}}]}\r\n\r\n",
                "data: [DONE]\n\n"
            );
                let (base_url, server) = mock_server("200 OK", body, "", false);
                let (_sender, cancel) = watch::channel(false);
                let mut deltas = Vec::new();
                let reply = stream_chat(
                    ProviderConfig {
                        base_url,
                        model: "fixture".into(),
                        key: Some("sk-fixture".into()),
                    },
                    vec![ChatMessage {
                        role: "user".into(),
                        content: "你好".into(),
                        provider_tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    }],
                    cancel,
                    |delta| deltas.push(delta.text),
                )
                .await
                .expect("stream reply");
                server.join().expect("server");
                assert_eq!(reply.content, "中文");
                assert_eq!(reply.model, "fixture");
                assert_eq!(deltas, vec!["中", "文"]);

                let (base_url, server) =
                    mock_server("302 Found", "", "Location: https://example.com/\r\n", false);
                let (_sender, cancel) = watch::channel(false);
                let error = stream_chat(
                    ProviderConfig {
                        base_url,
                        model: "fixture".into(),
                        key: None,
                    },
                    vec![ChatMessage {
                        role: "user".into(),
                        content: "hello".into(),
                        provider_tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    }],
                    cancel,
                    |_| {},
                )
                .await
                .expect_err("redirect must be rejected");
                server.join().expect("server");
                assert!(error.contains("HTTP 302"));
            });
    }

    #[test]
    fn cancellation_interrupts_waiting_stream() {
        tokio::runtime::Runtime::new()
            .expect("test runtime")
            .block_on(async {
                let (base_url, server) = mock_server("200 OK", "data: [DONE]\n\n", "", true);
                let (sender, cancel) = watch::channel(false);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let _ = sender.send(true);
                });
                let error = stream_chat(
                    ProviderConfig {
                        base_url,
                        model: "fixture".into(),
                        key: None,
                    },
                    vec![ChatMessage {
                        role: "user".into(),
                        content: "hello".into(),
                        provider_tool_calls: None,
                        tool_call_id: None,
                        name: None,
                    }],
                    cancel,
                    |_| panic!("cancelled request emitted text"),
                )
                .await
                .expect_err("request should cancel");
                server.join().expect("server");
                assert!(error.contains("已取消"));
            });
    }
}

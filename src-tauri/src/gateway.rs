//! Account-scoped OpenAI-compatible chat transport. User text is JSON data;
//! provider URLs and credentials never come from an individual chat request.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;
use url::{Host, Url};

const MAX_REQUEST_BYTES: usize = 48 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub content: String,
    pub model: String,
    pub tool_calls: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDelta {
    pub text: String,
}

pub struct ProviderConfig {
    pub base_url: String,
    pub model: String,
    pub key: Option<String>,
}

pub fn chat_endpoint(base_url: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url).map_err(|_| "模型连接地址无效".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型连接地址不能包含用户信息、查询参数或片段".into());
    }
    let local = match url.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if url.scheme() != "https" && !(url.scheme() == "http" && local && url.port().is_some()) {
        return Err("模型连接地址必须是 HTTPS 或带端口的本机 HTTP".into());
    }
    let path = url.path().trim_end_matches('/');
    let endpoint = if path.ends_with("/chat/completions") {
        path.to_string()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&endpoint);
    Ok(url)
}

fn validate_messages(messages: &[ChatMessage]) -> Result<(), String> {
    if messages.is_empty() || messages.len() > 24 {
        return Err("模型消息数量超出限制".into());
    }
    let mut bytes = 0;
    for message in messages {
        if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
            return Err("桌面聊天暂不接受工具消息".into());
        }
        bytes += message.content.len();
        if message.content.len() > 24 * 1024 || bytes > MAX_REQUEST_BYTES {
            return Err("模型上下文超出大小限制".into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct SseFrames {
    pending: Vec<u8>,
    lines: Vec<Vec<u8>>,
    received: usize,
}

impl SseFrames {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
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

    fn finish(&mut self) -> Result<Vec<String>, String> {
        self.pending.push(b'\n');
        let mut frames = self.push(&[])?;
        frames.extend(self.push(b"\n")?);
        Ok(frames)
    }
}

fn accept_frame(
    frame: &str,
    content: &mut String,
    model: &mut String,
) -> Result<(Option<String>, bool), String> {
    if frame == "[DONE]" {
        return Ok((None, true));
    }
    let value: Value = serde_json::from_str(frame).map_err(|_| "模型流式事件 JSON 无效")?;
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
    if delta
        .get("tool_calls")
        .is_some_and(|calls| !calls.is_null())
    {
        return Err("当前桌面聊天尚未开放模型工具调用".into());
    }
    let text = delta.get("content").and_then(Value::as_str).unwrap_or("");
    if content.len() + text.len() > MAX_RESPONSE_BYTES {
        return Err("模型回复超过大小限制".into());
    }
    content.push_str(text);
    Ok(((!text.is_empty()).then(|| text.to_string()), false))
}

pub async fn stream_chat(
    config: ProviderConfig,
    messages: Vec<ChatMessage>,
    mut cancelled: watch::Receiver<bool>,
    mut on_delta: impl FnMut(ChatDelta) + Send,
) -> Result<ChatReply, String> {
    validate_messages(&messages)?;
    let endpoint = chat_endpoint(&config.base_url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| "模型网络客户端初始化失败")?;
    let body = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "max_tokens": 1400,
    });
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
            let (delta, complete) = accept_frame(&frame, &mut content, &mut model)?;
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
            let (delta, complete) = accept_frame(&frame, &mut content, &mut model)?;
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
    Ok(ChatReply {
        content,
        model,
        tool_calls: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let (delta, done) = accept_frame(&frames[0], &mut content, &mut model).unwrap();
        assert_eq!(delta.as_deref(), Some("中文"));
        assert!(!done);
        assert_eq!(model, "fixture");
    }

    #[test]
    fn rejects_malformed_event_and_tool_calls() {
        let mut content = String::new();
        let mut model = String::new();
        assert!(accept_frame("not json", &mut content, &mut model).is_err());
        assert!(accept_frame(
            "{\"choices\":[{\"delta\":{\"tool_calls\":[]}}]}",
            &mut content,
            &mut model
        )
        .is_err());
    }

    #[test]
    fn loopback_chat_streams_text_and_refuses_redirect() {
        tauri::async_runtime::block_on(async {
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
        tauri::async_runtime::block_on(async {
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

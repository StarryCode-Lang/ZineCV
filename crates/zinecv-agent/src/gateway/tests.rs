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

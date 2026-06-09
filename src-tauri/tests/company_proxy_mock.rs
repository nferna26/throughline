// Integration test: drive the Company provider arm against a tiny localhost mock
// that stands in for the Throughline proxy. No live proxy required.
//
// Proves (CM1 + CM3):
//   - run_provider_call(Company) POSTs to {base_url}/v1/tutor.
//   - It authenticates with `Authorization: Bearer <license>` (not x-api-key).
//   - The body is locked to claude-sonnet-4-6.
//   - Anthropic-shape SSE relayed by the proxy parses into Delta tokens.
//   - An HTTP 402 surfaces as the CAP_EXHAUSTED_SENTINEL error (→ CapExhausted).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use throughline_lib::ai_client::StreamEvent;
use throughline_lib::ai_providers::{
    run_provider_call, ProviderAuth, ProviderCall, CAP_EXHAUSTED_SENTINEL,
};
use throughline_lib::settings::AiProvider;

/// Spin a one-shot loopback server that captures the request and replies with
/// `response` (a full HTTP response string). Returns (base_url, captured-request).
fn mock_proxy(response: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{port}");
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured_c = captured.clone();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buf = [0u8; 8192];
        let mut total = String::new();
        loop {
            let n = stream.read(&mut buf).expect("read");
            if n == 0 {
                break;
            }
            total.push_str(&String::from_utf8_lossy(&buf[..n]));
            if total.contains("\r\n\r\n") {
                let cl = total
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("Content-Length:")
                            .or_else(|| l.strip_prefix("content-length:"))
                    })
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                let body = total.split("\r\n\r\n").nth(1).unwrap_or("").len();
                if body >= cl {
                    break;
                }
            }
        }
        *captured_c.lock().unwrap() = total.clone();
        stream.write_all(response.as_bytes()).unwrap();
        stream.flush().unwrap();
    });
    (base_url, captured)
}

fn company_call(base_url: String) -> ProviderCall {
    ProviderCall {
        provider: AiProvider::Company,
        model: "claude-sonnet-4-6".to_string(),
        prompt: "Explain this passage.".to_string(),
        max_tokens: Some(200),
        timeout: Duration::from_secs(5),
        auth: ProviderAuth::CompanyLicense("lic_test.deadbeef".to_string()),
        base_url,
    }
}

#[tokio::test]
async fn company_arm_targets_proxy_with_bearer_and_sonnet() {
    let sse = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/event-stream\r\n",
        "Connection: close\r\n",
        "\r\n",
        "event: content_block_delta\r\n",
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
        "event: message_stop\r\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );
    let (base_url, captured) = mock_proxy(sse);

    let mut rx = run_provider_call(company_call(base_url))
        .await
        .expect("dispatch");
    let mut text = String::new();
    while let Some(ev) = rx.recv().await {
        if let StreamEvent::Delta { text: t } = ev {
            text.push_str(&t);
        }
    }
    assert_eq!(
        text, "Hello",
        "Anthropic SSE relayed by the proxy must parse"
    );

    let req = captured.lock().unwrap().clone();
    assert!(req.contains("POST /v1/tutor"), "must hit /v1/tutor: {req}");
    assert!(
        req.to_lowercase()
            .contains("authorization: bearer lic_test.deadbeef"),
        "must Bearer-auth the license, not x-api-key: {req}"
    );
    assert!(
        req.contains("claude-sonnet-4-6"),
        "model locked to Sonnet: {req}"
    );
    assert!(
        !req.to_lowercase().contains("x-api-key"),
        "no raw key on the wire"
    );
}

#[tokio::test]
async fn company_arm_maps_402_to_cap_exhausted() {
    let body = "{\"error\":\"cap_exhausted\",\"reason\":\"exhausted\"}";
    let resp = format!(
        "HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    // Leak to 'static (the helper wants &'static str; fine for a one-shot test).
    let resp: &'static str = Box::leak(resp.into_boxed_str());
    let (base_url, _) = mock_proxy(resp);

    let err = run_provider_call(company_call(base_url))
        .await
        .expect_err("402 must be an error");
    assert!(
        err.to_string().contains(CAP_EXHAUSTED_SENTINEL),
        "402 → cap-exhausted sentinel, got: {err}"
    );
}

// Integration test: drive the Company provider arm against a tiny localhost mock
// that stands in for the Throughline proxy. No live proxy required.
//
// Proves (CM1 + CM3):
//   - run_provider_call(Company) POSTs to {base_url}/v1/tutor.
//   - It authenticates with `Authorization: Bearer <license>` (not x-api-key).
//   - The body is locked to claude-sonnet-4-6.
//   - Anthropic-shape SSE relayed by the proxy parses into Delta tokens.
//   - An HTTP 402 surfaces as the CAP_EXHAUSTED_SENTINEL error (→ CapExhausted).
//
// Lint posture: `company_breaker_test_guard()`'s MutexGuard is deliberately held
// across each test's await points — that is the mechanism that serializes the
// whole async body against the process-global Company breaker. Every
// `#[tokio::test]` here runs on its own single-threaded runtime, so a blocked
// lock parks only that test's thread, never a shared executor.
#![allow(clippy::await_holding_lock)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use throughline_lib::ai_client::{breaker_for, StreamEvent};
use throughline_lib::ai_providers::{
    run_provider_call, test_provider, ProviderAuth, ProviderCall, CAP_EXHAUSTED_SENTINEL,
};
use throughline_lib::commands::ai::{clamp_to_company_relay, COMPANY_RELAY_MAX_OUTPUT_TOKENS};
use throughline_lib::settings::AiProvider;

/// The Company breaker is process-global, so the tests in this binary serialize
/// on one lock and each starts from a Closed breaker — one test's recorded
/// failures must never leak into another's.
fn company_breaker_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    breaker_for(AiProvider::Company).on_success(); // reset to Closed
    guard
}

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

/// A one-shot mock that enforces the relay's shape gate exactly like the
/// proxy's `shape.ts`: read the request, and if its `max_tokens` exceeds
/// `gate`, reply HTTP 400 "max_tokens too large"; otherwise relay a tiny
/// Anthropic-shape SSE stream. Returns (base_url, captured-request).
fn mock_shape_gate_proxy(gate: u32) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
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
        let requested = total
            .split("\"max_tokens\":")
            .nth(1)
            .and_then(|s| {
                s.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u32>()
                    .ok()
            })
            .unwrap_or(0);
        let response = if requested > gate {
            let body = "{\"error\":\"max_tokens too large\"}";
            format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
        } else {
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/event-stream\r\n",
                "Connection: close\r\n",
                "\r\n",
                "event: content_block_delta\r\n",
                "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
                "event: message_stop\r\n",
                "data: {\"type\":\"message_stop\"}\n\n",
            )
            .to_string()
        };
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
    let _g = company_breaker_test_guard();
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

/// CORE-1028: with the Company breaker Open, the Company arm fails fast with a
/// reader-facing unavailability error instead of handing the reader the full
/// request timeout — and it never touches the wire (the mock records zero hits).
#[tokio::test]
async fn company_arm_fails_fast_when_breaker_open_without_touching_the_wire() {
    let _g = company_breaker_test_guard();
    // A live listener that counts connections; the Open breaker must keep it at 0.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{port}");
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let hits_c = hits.clone();
    std::thread::spawn(move || {
        while listener.accept().is_ok() {
            hits_c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    });

    let breaker = breaker_for(AiProvider::Company);
    breaker.on_failure();
    breaker.on_failure();
    breaker.on_failure(); // default threshold (3) → Open

    let err = run_provider_call(company_call(base_url))
        .await
        .expect_err("an Open breaker must fail the call fast");
    assert!(
        err.to_string().contains("unavailable"),
        "fail-fast error mentions unavailability: {err}"
    );
    assert_eq!(
        hits.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "no HTTP request may be issued while the breaker is Open"
    );
    breaker.on_success(); // restore Closed for the rest of the binary
}

/// CORE-1035: a ceiling above the relay's shape gate must reach the wire
/// clamped to the gate — never as a deterministic 400. The mock enforces the
/// gate exactly like the proxy's shape.ts; the clamp under test is the same
/// `clamp_to_company_relay` that `cmd_ai_ask` applies at the call boundary,
/// driven with a synthetic over-limit ceiling so the test still bites after
/// all real mode ceilings fit under the gate.
#[tokio::test]
async fn company_call_with_an_over_limit_ceiling_is_clamped_to_the_relay_gate() {
    let _g = company_breaker_test_guard();
    let over_limit = COMPANY_RELAY_MAX_OUTPUT_TOKENS + 200;

    // Unclamped (what the call boundary sent before the clamp existed): the
    // shape gate rejects the request before any model is reached.
    let (base_url, _) = mock_shape_gate_proxy(COMPANY_RELAY_MAX_OUTPUT_TOKENS);
    let mut call = company_call(base_url);
    call.max_tokens = Some(over_limit);
    let err = run_provider_call(call)
        .await
        .expect_err("the shape gate must reject an over-limit max_tokens");
    assert!(
        err.to_string().contains("400"),
        "gate rejection surfaces as the 400 it is: {err}"
    );
    breaker_for(AiProvider::Company).on_success(); // keep this test self-contained

    // Clamped as cmd_ai_ask does: the same gate passes and the stream answers.
    let (base_url, captured) = mock_shape_gate_proxy(COMPANY_RELAY_MAX_OUTPUT_TOKENS);
    let mut call = company_call(base_url);
    call.max_tokens = Some(clamp_to_company_relay(AiProvider::Company, over_limit));
    let mut rx = run_provider_call(call)
        .await
        .expect("a clamped call passes the shape gate");
    let mut text = String::new();
    while let Some(ev) = rx.recv().await {
        if let StreamEvent::Delta { text: t } = ev {
            text.push_str(&t);
        }
    }
    assert_eq!(text, "Hello", "the clamped call streams normally");

    let req = captured.lock().unwrap().clone();
    assert!(
        req.contains(&format!("\"max_tokens\":{COMPANY_RELAY_MAX_OUTPUT_TOKENS}")),
        "the wire body must carry the clamped gate value: {req}"
    );
}

#[tokio::test]
async fn company_arm_maps_402_to_cap_exhausted() {
    let _g = company_breaker_test_guard();
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

/// CORE-1036: an authoritative client-error verdict (here a 400) proves the
/// relay answered — three of them must not open the breaker and lock every
/// company lens behind the cool-down. Only outage signals (408/429, 5xx,
/// transport failures) may count, mirroring the 402 arm's rationale.
#[tokio::test]
async fn company_4xx_does_not_open_the_breaker() {
    let _g = company_breaker_test_guard();
    let body = "{\"error\":\"max_tokens too large\"}";
    let resp = format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let resp: &'static str = Box::leak(resp.into_boxed_str());

    for i in 0..3 {
        let (base_url, _) = mock_proxy(resp);
        let err = run_provider_call(company_call(base_url))
            .await
            .expect_err("a 400 still surfaces as an error");
        assert!(err.to_string().contains("400"), "call {i}: {err}");
    }
    assert!(
        breaker_for(AiProvider::Company).check().is_ok(),
        "three authoritative 400s must not open the circuit — the relay answered every one"
    );

    // And a fourth call still reaches the wire instead of failing fast
    // (mirrors the hit-counting in the breaker-open test above, via the
    // captured request).
    let (base_url, captured) = mock_proxy(resp);
    let _ = run_provider_call(company_call(base_url)).await;
    let req = captured.lock().unwrap().clone();
    assert!(
        req.contains("POST /v1/tutor"),
        "the fourth call must still reach the wire, not fail fast: {req}"
    );
}

/// CORE-1018: "Test connection" for Company must really probe the relay's
/// /v1/credits with the Bearer license — a live relay answers and the reader
/// sees the active message; nothing is hardcoded.
#[tokio::test]
async fn company_test_probes_credits() {
    let _g = company_breaker_test_guard();
    let body = "{\"ok\":true,\"remaining_fraction\":0.8,\"approx_questions_left\":320}";
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let resp: &'static str = Box::leak(resp.into_boxed_str());
    let (base_url, captured) = mock_proxy(resp);

    let (reachable, model, message) = test_provider(
        AiProvider::Company,
        Some("lic_test.deadbeef".to_string()),
        &base_url,
        "claude-sonnet-4-6",
        Duration::from_secs(5),
    )
    .await;

    assert!(
        reachable,
        "a live relay answering /v1/credits is reachable: {message}"
    );
    assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
    assert!(
        message.contains("Throughline AI"),
        "reader-facing message names Throughline AI: {message}"
    );

    let req = captured.lock().unwrap().clone();
    assert!(
        req.starts_with("GET /v1/credits"),
        "must probe GET /v1/credits, not report statically: {req}"
    );
    assert!(
        req.to_lowercase()
            .contains("authorization: bearer lic_test.deadbeef"),
        "must Bearer-auth the license: {req}"
    );
}

/// CORE-1018: with the relay down (nothing listening), "Test connection" must
/// report failure honestly with a human message — never a static success.
#[tokio::test]
async fn company_test_fails_when_unreachable() {
    let _g = company_breaker_test_guard();
    // Bind then drop a listener so the port is closed → connection refused.
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind");
        l.local_addr().unwrap().port()
    };
    let base_url = format!("http://127.0.0.1:{port}");

    let (reachable, model, message) = test_provider(
        AiProvider::Company,
        Some("lic_test.deadbeef".to_string()),
        &base_url,
        "claude-sonnet-4-6",
        Duration::from_secs(2),
    )
    .await;

    assert!(!reachable, "a dead relay must not report active: {message}");
    assert!(model.is_none());
    assert_eq!(message, "Can't reach Throughline AI right now.");
}

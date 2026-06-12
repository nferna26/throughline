// Integration test: drive the phrases wire (docs/PHRASES_API.md) against a tiny
// localhost mock standing in for the Throughline proxy. No live relay required.
//
// Proves:
//   - fetch_batch(Company) POSTs to {base_url}/v1/phrases with
//     `authorization: Bearer <license>` and the {version, items} body.
//   - A 200 with a partial item list comes back as exactly those phrases.
//   - HTTP 402 maps to the distinct CapHit state; 429 carries Retry-After.
//   - The BYO OpenAI-compatible path parses a strict-JSON chat reply.

use std::io::{Read, Write};
use std::net::TcpListener;

use throughline_lib::phrases::{fetch_batch, PhraseAuth, PhraseFail, PhraseItem};

fn mock_server(response: &'static str) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{port}");
    let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let captured_c = captured.clone();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buf = [0u8; 16384];
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

fn items() -> Vec<PhraseItem> {
    vec![
        PhraseItem {
            opening_hash: "a".repeat(64),
            label: "Chapter I".into(),
            slice: "Begin the morning by saying to thyself".into(),
        },
        PhraseItem {
            opening_hash: "b".repeat(64),
            label: "Chapter II".into(),
            slice: "But I who have seen the nature of the good".into(),
        },
    ]
}

#[tokio::test]
async fn company_wire_speaks_the_contract_and_accepts_partial_responses() {
    let body = r#"{"version":1,"items":[{"opening_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","phrase":"the morning resolve"}],"usage":{"input_tokens":10,"output_tokens":5},"remaining":{"status":"active","remaining_fraction":0.7,"approx_questions_left":280}}"#;
    let response: &'static str = Box::leak(
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_boxed_str(),
    );
    let (base_url, captured) = mock_server(response);

    let auth = PhraseAuth::Company {
        base_url,
        license: "lic_test_123".into(),
    };
    let got = fetch_batch(&auth, &items()).await.expect("200 parses");

    // Partial response: the relay answered one of two items.
    assert_eq!(got.phrases.len(), 1);
    assert_eq!(got.phrases[0].1, "the morning resolve");

    let req = captured.lock().unwrap().clone();
    assert!(req.starts_with("POST /v1/phrases"), "path: {req:.60}");
    assert!(
        req.to_lowercase().contains("authorization: bearer lic_test_123"),
        "Bearer license auth"
    );
    let body_json: serde_json::Value =
        serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).expect("JSON body");
    assert_eq!(body_json["version"], 1);
    assert_eq!(body_json["items"].as_array().unwrap().len(), 2);
    assert_eq!(body_json["items"][0]["label"], "Chapter I");
    assert!(body_json["items"][0]["slice"]
        .as_str()
        .unwrap()
        .starts_with("Begin the morning"));
}

#[tokio::test]
async fn cap_hit_is_the_distinct_402_state() {
    let response = "HTTP/1.1 402 Payment Required\r\ncontent-type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"error\":\"cap_hit\"}\n";
    let (base_url, _) = mock_server(response);
    let auth = PhraseAuth::Company {
        base_url,
        license: "lic".into(),
    };
    let err = fetch_batch(&auth, &items()).await.unwrap_err();
    assert_eq!(err, PhraseFail::CapHit);
}

#[tokio::test]
async fn rate_limit_carries_retry_after() {
    let response = "HTTP/1.1 429 Too Many Requests\r\nretry-after: 30\r\ncontent-type: application/json\r\nContent-Length: 38\r\nConnection: close\r\n\r\n{\"error\":\"rate_limited\",\"retry_after\":30}";
    let (base_url, _) = mock_server(response);
    let auth = PhraseAuth::Company {
        base_url,
        license: "lic".into(),
    };
    let err = fetch_batch(&auth, &items()).await.unwrap_err();
    assert_eq!(
        err,
        PhraseFail::RateLimited {
            retry_after: Some(30)
        }
    );
}

#[tokio::test]
async fn byo_openai_compatible_path_parses_a_strict_json_reply() {
    let inner = r#"[{"opening_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","phrase":"the quiet road"},{"opening_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","phrase":"a stranger at the gate"}]"#;
    let chat = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": inner } }]
    })
    .to_string();
    let response: &'static str = Box::leak(
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            chat.len(),
            chat
        )
        .into_boxed_str(),
    );
    let (base_url, captured) = mock_server(response);

    // The local route enforces loopback — this mock IS loopback, so it passes.
    let auth = PhraseAuth::Local {
        base_url,
        model: "qwen2.5-14b".into(),
    };
    let got = fetch_batch(&auth, &items()).await.expect("parses");
    assert_eq!(got.phrases.len(), 2);
    assert_eq!(got.phrases[1].1, "a stranger at the gate");

    let req = captured.lock().unwrap().clone();
    assert!(req.starts_with("POST /chat/completions"));
    let body_json: serde_json::Value =
        serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).expect("JSON body");
    // The user content is the items array; the system prompt is the shared
    // generation contract. Neither carries anything beyond label + slice.
    let user = body_json["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("Begin the morning"));
    assert!(!user.contains("password"), "sanity");
}

#[tokio::test]
async fn a_non_loopback_local_base_url_is_refused_before_any_send() {
    let auth = PhraseAuth::Local {
        base_url: "https://evil.example.com/v1".into(),
        model: "m".into(),
    };
    let err = fetch_batch(&auth, &items()).await.unwrap_err();
    assert_eq!(err, PhraseFail::Transient);
}

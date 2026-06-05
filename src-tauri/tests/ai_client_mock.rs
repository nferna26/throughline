// Integration test: drive the AI client against a tiny localhost mock HTTP
// server that speaks the OpenAI streaming SSE shape. No live MLX server
// required.
//
// Proves:
//   - The client POSTs to {baseUrl}/chat/completions with the OpenAI shape.
//   - SSE `data: {...}\n\n` chunks are parsed correctly into delta tokens.
//   - The terminal `data: [DONE]` sentinel ends the stream.
//   - The exact prompt text bytes (preview == sent) arrive at the server.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use throughline_lib::ai_client::{run_chat_call, ChatCallOpts, StreamEvent};

#[tokio::test]
async fn mock_server_streams_deltas_to_client() {
    // Bind on an ephemeral loopback port so the loopback check still passes.
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    listener.set_nonblocking(false).unwrap();
    let port = listener.local_addr().unwrap().port();
    let base_url = format!("http://127.0.0.1:{}/v1", port);

    let prompt = "PROMPT-MARKER: this exact string MUST reach the server unchanged.";

    // Accept one connection, read the request, write back canned SSE.
    let received_body = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let received_body_clone = received_body.clone();
    let server_thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buf = [0u8; 8192];
        let mut total = String::new();
        // Read headers + body in one shot — small request, small buffer
        loop {
            let n = stream.read(&mut buf).expect("read");
            if n == 0 {
                break;
            }
            total.push_str(&String::from_utf8_lossy(&buf[..n]));
            if total.contains("\r\n\r\n") {
                // Pull the Content-Length so we know when the body is done.
                let cl = total
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("Content-Length:")
                            .or_else(|| l.strip_prefix("content-length:"))
                    })
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                let body_so_far = total.split("\r\n\r\n").nth(1).unwrap_or("").len();
                if body_so_far >= cl {
                    break;
                }
            }
        }
        *received_body_clone.lock().unwrap() = total.clone();

        let sse = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: text/event-stream\r\n",
            "Cache-Control: no-cache\r\n",
            "Connection: close\r\n",
            "\r\n",
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"index\":0}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"index\":0}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\", world\"},\"index\":0}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}]}\n\n",
            "data: [DONE]\n\n",
        );
        stream.write_all(sse.as_bytes()).expect("write");
        stream.flush().ok();
    });

    let opts = ChatCallOpts {
        base_url: base_url.clone(),
        model: "mock-model".to_string(),
        local_only: true, // 127.0.0.1 is loopback — must pass the gate
        prompt: prompt.to_string(),
        stream: true,
        timeout: Duration::from_secs(5),
        max_tokens: Some(64),
        ..Default::default()
    };
    let mut rx = run_chat_call(opts).await.expect("run_chat_call");

    let mut full = String::new();
    let mut got_done = false;
    let mut got_error: Option<String> = None;
    while let Some(ev) = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap_or(None)
    {
        match ev {
            StreamEvent::Delta { text } => full.push_str(&text),
            StreamEvent::Done => {
                got_done = true;
                break;
            }
            StreamEvent::Error { message } => {
                got_error = Some(message);
                break;
            }
        }
    }

    server_thread.join().expect("server thread");

    assert!(
        got_error.is_none(),
        "client surfaced an error: {:?}",
        got_error
    );
    assert!(got_done, "client did not see [DONE] sentinel");
    assert_eq!(
        full, "Hello, world",
        "deltas did not concatenate to expected text"
    );

    // Verify the actual bytes sent — POST /v1/chat/completions with the exact prompt text.
    let body = received_body.lock().unwrap().clone();
    assert!(
        body.starts_with("POST /v1/chat/completions"),
        "wrong request line: {}",
        body.lines().next().unwrap_or("")
    );
    assert!(
        body.contains("PROMPT-MARKER: this exact string MUST reach the server unchanged."),
        "prompt bytes did not arrive verbatim"
    );
    assert!(body.contains("\"stream\":true"));
    assert!(body.contains("\"model\":\"mock-model\""));
    assert!(
        body.contains("\"max_tokens\":64"),
        "the brevity ceiling must reach the server"
    );
}

#[tokio::test]
async fn remote_url_refused_when_local_only_on() {
    let opts = ChatCallOpts {
        base_url: "https://api.openai.com/v1".to_string(),
        model: "gpt-4".to_string(),
        local_only: true,
        prompt: "anything".to_string(),
        stream: true,
        timeout: Duration::from_secs(1),
        max_tokens: None,
        ..Default::default()
    };
    let err = run_chat_call(opts).await.expect_err("must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("Local-only"),
        "rejection must mention Local-only: {}",
        msg
    );
    assert!(
        msg.contains("api.openai.com"),
        "rejection must name the host: {}",
        msg
    );
}

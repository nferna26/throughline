// AI client — OpenAI-compatible chat completions against a local MLX server
// (LM Studio by default, http://localhost:1234/v1).
//
// **Local-only invariant.** When `local_only=true`, the client refuses any
// base URL whose host is not loopback. This is the hard privacy contract
// added in Shot 4: AI is allowed, but only against a local endpoint, unless
// the user has explicitly turned local-only OFF in settings.
//
// The prompt sent here is the SAME text the Shot 3 stub generates as a
// preview. Do not rewrite prompts — preview text and sent text must match.

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::mpsc;
use url::Url;

use crate::circuit_breaker::{Breaker, BreakerConfig};

/// Process-global breaker for the AI surface. Single user, single endpoint,
/// so one breaker is enough. Lazy-initialized with the production config.
fn breaker() -> &'static Breaker {
    static BREAKER: OnceLock<Breaker> = OnceLock::new();
    BREAKER.get_or_init(|| Breaker::new(BreakerConfig::default()))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Build the OpenAI-shape request body for a prompt + model. Used directly
/// by the unit test that pins `preview text == sent text`.
pub fn build_request_body(model: &str, prompt: &str, stream: bool) -> ChatRequest {
    ChatRequest {
        model: model.to_string(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
        stream,
        temperature: None,
    }
}

/// Loopback check that accepts `localhost`, `127.0.0.0/8`, `::1`, IPv6 literals
/// with brackets, and rejects everything else (including 0.0.0.0, public DNS
/// names, RFC 1918 private ranges, etc. — privacy invariant is loopback-only).
pub fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let cleaned = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(addr) = cleaned.parse::<IpAddr>() {
        return addr.is_loopback();
    }
    false
}

/// Validate the base URL the client is about to call. Returns the parsed Url
/// if it's acceptable, or an explanatory error.
pub fn validate_base_url(base_url: &str, local_only: bool) -> Result<Url> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("AI base URL is empty"));
    }
    let url = Url::parse(trimmed).with_context(|| format!("invalid AI base URL: {}", base_url))?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(anyhow!("AI base URL must be http or https (got {})", scheme));
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("AI base URL has no host"))?
        .to_string();
    if local_only && !is_loopback_host(&host) {
        return Err(anyhow!(
            "Local-only mode is ON, refusing to send to non-loopback host '{}'. \
             Either keep local-only ON and use a localhost endpoint, or explicitly turn local-only OFF in Settings.",
            host
        ));
    }
    Ok(url)
}

/// Streaming chunk emitted to the frontend. Either a delta token or a
/// terminal event (done / error).
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    Delta { text: String },
    Done,
    Error { message: String },
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: Option<StreamDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiBlockingResponse {
    choices: Vec<BlockingChoice>,
}

#[derive(Debug, Deserialize)]
struct BlockingChoice {
    message: BlockingMessage,
}

#[derive(Debug, Deserialize)]
struct BlockingMessage {
    #[serde(default)]
    content: String,
}

/// Parse one SSE data line. Returns:
///   - Ok(Some(delta_text)) when this chunk carries a content delta
///   - Ok(None) when this chunk has no content (function calls, role-only opens, etc.)
///   - Ok(Some("[DONE]")) sentinel — caller treats specially
pub fn parse_sse_data_line(line: &str) -> Result<Option<String>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let payload = trimmed.strip_prefix("data:").map(str::trim).unwrap_or(trimmed);
    if payload == "[DONE]" {
        return Ok(Some("[DONE]".to_string()));
    }
    let chunk: OpenAiStreamChunk = serde_json::from_str(payload)
        .with_context(|| format!("parsing SSE chunk: {}", payload))?;
    let mut text = String::new();
    for ch in &chunk.choices {
        if let Some(delta) = &ch.delta {
            if let Some(c) = &delta.content {
                text.push_str(c);
            }
        }
    }
    if text.is_empty() && chunk.choices.iter().any(|c| c.finish_reason.is_some()) {
        Ok(None)
    } else if text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}

#[derive(Debug, Clone)]
pub struct ChatCallOpts {
    pub base_url: String,
    pub model: String,
    pub local_only: bool,
    pub prompt: String,
    pub stream: bool,
    pub timeout: Duration,
}

/// Run a chat completion call. If `stream` is true, emits `StreamEvent`s on
/// the returned receiver; if streaming fails or is unsupported, falls back to
/// a single blocking call and emits one Delta + Done.
///
/// Always logs an entry to whatever caller-owned audit path the caller chooses;
/// this function itself is IO-only and does not touch the DB.
pub async fn run_chat_call(opts: ChatCallOpts) -> Result<mpsc::Receiver<StreamEvent>> {
    let url = validate_base_url(&opts.base_url, opts.local_only)?;
    // Fail fast if the breaker is Open — don't hand the user a 180s hang.
    if let Err(e) = breaker().check() {
        return Err(anyhow!("AI service unavailable: {}", e));
    }
    let endpoint = format!("{}/chat/completions", url.as_str().trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(opts.timeout)
        .build()
        .context("reqwest client build")?;

    let (tx, rx) = mpsc::channel::<StreamEvent>(64);
    let body = build_request_body(&opts.model, &opts.prompt, opts.stream);

    tokio::spawn(async move {
        // Local-only enforcement is also re-checked at the top of run_chat_call
        // by validate_base_url. Anything we got here is loopback or the user
        // explicitly opted out.
        let resp = client
            .post(&endpoint)
            .bearer_auth("local") // LM Studio ignores; some endpoints require any token
            .json(&body)
            .send()
            .await;
        let resp = match resp {
            Ok(r) => r,
            Err(e) => {
                breaker().on_failure();
                let _ = tx.send(StreamEvent::Error { message: format!("request failed: {}", e) }).await;
                return;
            }
        };
        let status = resp.status();
        if !status.is_success() {
            breaker().on_failure();
            let snippet = resp.text().await.unwrap_or_default();
            let snippet = snippet.chars().take(500).collect::<String>();
            let _ = tx
                .send(StreamEvent::Error {
                    message: format!("HTTP {}: {}", status, snippet),
                })
                .await;
            return;
        }

        if opts.stream {
            let mut stream = resp.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(b) => b,
                    Err(e) => {
                        breaker().on_failure();
                        let _ = tx.send(StreamEvent::Error { message: format!("stream error: {}", e) }).await;
                        return;
                    }
                };
                buf.extend_from_slice(&chunk);
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_bytes = buf.drain(..=pos).collect::<Vec<u8>>();
                    let line = String::from_utf8_lossy(&line_bytes);
                    match parse_sse_data_line(&line) {
                        Ok(Some(text)) if text == "[DONE]" => {
                            breaker().on_success();
                            let _ = tx.send(StreamEvent::Done).await;
                            return;
                        }
                        Ok(Some(text)) => {
                            let _ = tx.send(StreamEvent::Delta { text }).await;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            // Some servers prepend non-SSE preamble; only surface a hard error
                            // when the line starts with "data:" and is malformed.
                            if line.trim_start().starts_with("data:") {
                                breaker().on_failure();
                                let _ = tx
                                    .send(StreamEvent::Error {
                                        message: format!("bad SSE chunk: {}", e),
                                    })
                                    .await;
                                return;
                            }
                        }
                    }
                }
            }
            // Stream ended without a [DONE] sentinel. Some servers (LM Studio
            // for short responses) close cleanly without one. Count it as a
            // success since we got data without an error.
            breaker().on_success();
            let _ = tx.send(StreamEvent::Done).await;
        } else {
            match resp.json::<OpenAiBlockingResponse>().await {
                Ok(j) => {
                    breaker().on_success();
                    let text = j.choices.first().map(|c| c.message.content.clone()).unwrap_or_default();
                    if !text.is_empty() {
                        let _ = tx.send(StreamEvent::Delta { text }).await;
                    }
                    let _ = tx.send(StreamEvent::Done).await;
                }
                Err(e) => {
                    breaker().on_failure();
                    let _ = tx
                        .send(StreamEvent::Error {
                            message: format!("decode blocking response: {}", e),
                        })
                        .await;
                }
            }
        }
    });
    Ok(rx)
}

/// Fetch the full model list from an OpenAI-compatible server's `/models`
/// endpoint. Returns ids only (no metadata) since that's all the dropdown UI
/// needs. Honors local-only.
pub async fn list_models(base_url: &str, local_only: bool) -> Result<Vec<String>> {
    let url = validate_base_url(base_url, local_only)?;
    let endpoint = format!("{}/models", url.as_str().trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()?;
    let resp = client.get(&endpoint).bearer_auth("local").send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("models endpoint returned HTTP {}", resp.status()));
    }
    #[derive(Deserialize)]
    struct ModelsResp { data: Option<Vec<ModelEntry>> }
    #[derive(Deserialize)]
    struct ModelEntry { id: String }
    let parsed: ModelsResp = resp.json().await?;
    let mut ids: Vec<String> = parsed.data.unwrap_or_default().into_iter().map(|m| m.id).collect();
    // Stable order so the dropdown doesn't shuffle between refreshes.
    ids.sort();
    Ok(ids)
}

/// Test reachability of an AI server by hitting `{baseUrl}/models`. Returns
/// (reachable, optional first-listed model id).
pub async fn test_connection(base_url: &str, local_only: bool) -> Result<(bool, Option<String>)> {
    let url = validate_base_url(base_url, local_only)?;
    // Test connection deliberately bypasses the breaker `check()` — the
    // operator pressing "Test connection" wants a real probe even when the
    // breaker is Open. But the outcome STILL feeds the breaker: a successful
    // probe is the cheapest way to close the circuit; a failed probe keeps
    // the breaker informed.
    let endpoint = format!("{}/models", url.as_str().trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()?;
    match client.get(&endpoint).bearer_auth("local").send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                breaker().on_failure();
                return Ok((false, None));
            }
            #[derive(Deserialize)]
            struct ModelsResp { data: Option<Vec<ModelEntry>> }
            #[derive(Deserialize)]
            struct ModelEntry { id: String }
            let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
            let typed: ModelsResp = serde_json::from_value(body).unwrap_or(ModelsResp { data: None });
            let first = typed.data.and_then(|v| v.into_iter().next().map(|m| m.id));
            breaker().on_success();
            Ok((true, first))
        }
        Err(_) => {
            breaker().on_failure();
            Ok((false, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_accepts_localhost_and_loopback_ips() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LocalHost"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.0.0.42"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
    }

    #[test]
    fn loopback_rejects_public_and_private_non_loopback() {
        assert!(!is_loopback_host("0.0.0.0"));
        assert!(!is_loopback_host("192.168.1.10"));
        assert!(!is_loopback_host("10.0.0.5"));
        assert!(!is_loopback_host("api.openai.com"));
        assert!(!is_loopback_host("anthropic.com"));
        assert!(!is_loopback_host("8.8.8.8"));
        assert!(!is_loopback_host("169.254.169.254")); // metadata service
    }

    #[test]
    fn validate_rejects_non_loopback_when_local_only_on() {
        let r = validate_base_url("https://api.openai.com/v1", true);
        assert!(r.is_err(), "must refuse non-loopback when local-only ON");
        let msg = r.unwrap_err().to_string();
        assert!(msg.contains("Local-only"), "error must mention local-only: {}", msg);
        assert!(msg.contains("api.openai.com"), "error must name the rejected host: {}", msg);
    }

    #[test]
    fn validate_accepts_localhost_when_local_only_on() {
        assert!(validate_base_url("http://localhost:1234/v1", true).is_ok());
        assert!(validate_base_url("http://127.0.0.1:1234/v1", true).is_ok());
        assert!(validate_base_url("http://[::1]:1234/v1", true).is_ok());
    }

    #[test]
    fn validate_accepts_remote_when_local_only_off() {
        let r = validate_base_url("https://api.openai.com/v1", false);
        assert!(r.is_ok(), "with local-only OFF, remote must be allowed (opt-in path)");
    }

    #[test]
    fn validate_rejects_empty_or_bad_scheme() {
        assert!(validate_base_url("", true).is_err());
        assert!(validate_base_url("   ", true).is_err());
        assert!(validate_base_url("file:///etc/passwd", true).is_err());
        assert!(validate_base_url("ftp://localhost/v1", true).is_err());
    }

    #[test]
    fn request_body_uses_exact_prompt_text() {
        let prompt = "You are a patient tutor. I'm reading Source: \"X\"…\n\n> selection here";
        let body = build_request_body("qwen-7b", prompt, true);
        assert_eq!(body.model, "qwen-7b");
        assert_eq!(body.messages.len(), 1);
        assert_eq!(body.messages[0].role, "user");
        assert_eq!(body.messages[0].content, prompt, "preview text MUST equal sent text");
        assert!(body.stream);
    }

    #[test]
    fn sse_parsing_extracts_deltas_and_done() {
        let chunk = r#"data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}"#;
        let r = parse_sse_data_line(chunk).unwrap();
        assert_eq!(r.as_deref(), Some("Hello"));
        let r = parse_sse_data_line("data: [DONE]").unwrap();
        assert_eq!(r.as_deref(), Some("[DONE]"));
        let r = parse_sse_data_line("").unwrap();
        assert!(r.is_none());
        let r = parse_sse_data_line(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap();
        assert!(r.is_none());
    }
}

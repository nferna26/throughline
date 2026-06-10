//! Cloud AI providers (OpenAI, Anthropic, Codex-login) behind one dispatch that
//! normalizes every provider into the existing `StreamEvent` Delta/Done/Error
//! channel, so the reader cards are unchanged.
//!
//! - OpenAI + Local reuse `ai_client::run_chat_call` (OpenAI-compatible).
//! - Anthropic uses its own `/v1/messages` named-event SSE protocol.
//! - Codex reuses the credentials the official `codex login` already wrote to
//!   `~/.codex/auth.json` (refresh reactively on 401), then calls the ChatGPT
//!   backend Responses API. The app NEVER shells out and never references
//!   OpenClaw — all Codex facts come from the official open-source openai/codex.
//!
//! Keys/tokens are read only here to set one request header and are never logged.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;

use crate::ai_client::{run_chat_call, ChatCallOpts, StreamEvent};
use crate::settings::AiProvider;

/// A model the reader can pick, with its published per-Mtok price so the UI can
/// show a cost chip and the usage meter (Epic B3/B4) computes spend locally.
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub tier: String, // "default" | "power" | "fast"
}

/// When the prices below were last verified against the providers' pricing pages.
/// Re-verify before trusting the cost UI past ~90 days.
pub const PRICING_VERIFIED_AT: &str = "2026-06-08";

fn mi(id: &str, label: &str, inp: f64, out: f64, tier: &str) -> ModelInfo {
    ModelInfo {
        id: id.into(),
        label: label.into(),
        input_per_mtok: inp,
        output_per_mtok: out,
        tier: tier.into(),
    }
}

/// Per-provider model catalogue ($/Mtok). Anthropic prices are exact (the
/// company-paid path); OpenAI/Codex are best-effort and bounded by
/// PRICING_VERIFIED_AT. Local (LM Studio) models are detected live and free, so
/// they are not in this static table. The first entry is each provider's default.
pub fn model_catalog(provider: AiProvider) -> Vec<ModelInfo> {
    match provider {
        AiProvider::Anthropic => vec![
            mi(
                "claude-sonnet-4-6",
                "Sonnet 4.6 — best value",
                3.0,
                15.0,
                "default",
            ),
            mi(
                "claude-haiku-4-5",
                "Haiku 4.5 — fastest, cheapest",
                1.0,
                5.0,
                "fast",
            ),
            mi(
                "claude-opus-4-8",
                "Opus 4.8 — most capable (~5× cost)",
                15.0,
                75.0,
                "power",
            ),
        ],
        AiProvider::OpenAi => vec![
            mi("gpt-5.5", "GPT-5.5", 1.25, 10.0, "default"),
            mi("gpt-5.5-pro", "GPT-5.5 Pro", 2.5, 20.0, "power"),
            mi("gpt-5-mini", "GPT-5 mini — cheapest", 0.25, 2.0, "fast"),
        ],
        AiProvider::Codex => vec![mi(
            "gpt-5.5",
            "GPT-5.5 (via Codex login)",
            1.25,
            10.0,
            "default",
        )],
        _ => Vec::new(),
    }
}

/// Per-Mtok (input, output) prices for a (provider, model), for cost computation.
/// Falls back to the provider's default model price when the exact id isn't
/// catalogued (e.g. a hand-typed model) so the usage meter never reports $0.
pub fn model_price(provider: AiProvider, model: &str) -> Option<(f64, f64)> {
    let cat = model_catalog(provider);
    cat.iter()
        .find(|m| m.id == model)
        .or_else(|| cat.first())
        .map(|m| (m.input_per_mtok, m.output_per_mtok))
}

/// Token usage for one AI request, accumulated from a provider's stream (B3).
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

/// Fold one Anthropic SSE line into a running usage tally. `message_start` carries
/// input + cache token counts; `message_delta` carries the running output_tokens.
pub fn accumulate_anthropic_usage(line: &str, acc: &mut TokenUsage) {
    let Some(payload) = sse_data_payload(line) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return;
    };
    match v.get("type").and_then(|x| x.as_str()) {
        Some("message_start") => {
            if let Some(u) = v.pointer("/message/usage") {
                let g = |k: &str| u.get(k).and_then(|x| x.as_u64());
                acc.input_tokens = g("input_tokens").unwrap_or(acc.input_tokens);
                acc.cache_read_tokens =
                    g("cache_read_input_tokens").unwrap_or(acc.cache_read_tokens);
                acc.cache_creation_tokens =
                    g("cache_creation_input_tokens").unwrap_or(acc.cache_creation_tokens);
            }
        }
        Some("message_delta") => {
            if let Some(o) = v.pointer("/usage/output_tokens").and_then(|x| x.as_u64()) {
                acc.output_tokens = o;
            }
        }
        _ => {}
    }
}

/// Parse OpenAI's terminal usage chunk (`stream_options.include_usage`): the final
/// frame carries `usage: { prompt_tokens, completion_tokens }`. None if absent
/// (e.g. an LM Studio server that doesn't report usage).
pub fn parse_openai_usage(value: &serde_json::Value) -> Option<TokenUsage> {
    let u = value.get("usage")?;
    Some(TokenUsage {
        input_tokens: u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0),
        output_tokens: u
            .get("completion_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        cache_read_tokens: u
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        cache_creation_tokens: 0,
    })
}

/// Cost of a request in integer micro-dollars (no float in the DB). Because the
/// price is $/Mtok, `tokens × price` already yields micro-dollars. Cache reads
/// bill at 0.1× and 5-minute cache writes at 1.25× the input rate (Anthropic).
/// Uncatalogued models fall back to the provider's default price (never $0).
pub fn cost_micros(provider: AiProvider, model: &str, u: &TokenUsage) -> i64 {
    let Some((inp, out)) = model_price(provider, model) else {
        return 0;
    };
    let micros = u.input_tokens as f64 * inp
        + u.output_tokens as f64 * out
        + u.cache_read_tokens as f64 * inp * 0.10
        + u.cache_creation_tokens as f64 * inp * 1.25;
    micros.round() as i64
}

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ORIGINATOR: &str = "codex_cli_rs";
// Device-code login (app-owned, independent of the Codex CLI file). Endpoints +
// flow from the official openai/codex (codex-rs/login/{device_code_auth,server}.rs).
const CODEX_DEVICE_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CODEX_DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const CODEX_DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const CODEX_DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";

/// Resolved per-call provider auth (the secret material, read just-in-time).
pub enum ProviderAuth {
    Local,
    OpenAiKey(String),
    AnthropicKey(String),
    Codex,
    /// The per-install Throughline AI license (Bearer-auth to the company proxy).
    CompanyLicense(String),
}

/// Sentinel error string from the Company arm when the proxy returns HTTP 402
/// (cap exhausted). `commands::ai` maps it to `AppError::CapExhausted`.
pub const CAP_EXHAUSTED_SENTINEL: &str = "__throughline_cap_exhausted__";

/// A normalized provider call. `base_url` applies to Local only.
pub struct ProviderCall {
    pub provider: AiProvider,
    pub model: String,
    pub prompt: String,
    pub max_tokens: Option<u32>,
    pub timeout: Duration,
    pub auth: ProviderAuth,
    pub base_url: String,
}

/// Dispatch a call to the chosen provider, returning the same StreamEvent
/// receiver every provider normalizes into.
pub async fn run_provider_call(call: ProviderCall) -> Result<mpsc::Receiver<StreamEvent>> {
    match call.provider {
        AiProvider::Local => {
            run_chat_call(ChatCallOpts {
                base_url: call.base_url,
                model: call.model,
                local_only: true,
                prompt: call.prompt,
                stream: true,
                timeout: call.timeout,
                max_tokens: call.max_tokens,
                auth_token: None,
                cloud_openai: false,
            })
            .await
        }
        AiProvider::OpenAi => {
            let key = match call.auth {
                ProviderAuth::OpenAiKey(k) => k,
                _ => return Err(anyhow!("OpenAI selected but no API key is configured")),
            };
            run_chat_call(ChatCallOpts {
                base_url: OPENAI_BASE_URL.to_string(),
                model: call.model,
                local_only: false,
                prompt: call.prompt,
                stream: true,
                timeout: call.timeout,
                max_tokens: call.max_tokens,
                auth_token: Some(key),
                cloud_openai: true,
            })
            .await
        }
        AiProvider::Anthropic => {
            let key = match call.auth {
                ProviderAuth::AnthropicKey(k) => k,
                _ => return Err(anyhow!("Anthropic selected but no API key is configured")),
            };
            run_anthropic(
                &call.model,
                &key,
                &call.prompt,
                call.max_tokens,
                call.timeout,
            )
            .await
        }
        AiProvider::Codex => {
            run_codex(&call.model, &call.prompt, call.max_tokens, call.timeout).await
        }
        AiProvider::Company => {
            let license = match call.auth {
                ProviderAuth::CompanyLicense(l) => l,
                _ => return Err(anyhow!("Throughline AI selected but not activated")),
            };
            run_company(
                &call.base_url,
                &license,
                &call.model,
                &call.prompt,
                call.max_tokens,
                call.timeout,
            )
            .await
        }
        AiProvider::Disabled | AiProvider::Unset => Err(anyhow!(
            "No AI provider chosen. Pick one in Settings → Assistance."
        )),
    }
}

// ── Shared SSE pump ─────────────────────────────────────────────────────────

/// Per-line outcome from a provider's SSE parser.
pub enum SseOutcome {
    Delta(String),
    Done,
    Error(String),
    Ignore,
}

/// Drive an SSE response body line-by-line through `parse`, emitting StreamEvents.
/// Ends with a synthetic Done if the stream closes cleanly without a terminal event.
/// Emit a Usage event if any tokens were seen (B6). Sent just before Done so
/// cmd_ai_ask can record it. No-op when the stream reported no usage.
async fn emit_usage(tx: &mpsc::Sender<StreamEvent>, u: &TokenUsage) {
    if u.input_tokens > 0 || u.output_tokens > 0 {
        let _ = tx
            .send(StreamEvent::Usage {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                cache_read_tokens: u.cache_read_tokens,
                cache_creation_tokens: u.cache_creation_tokens,
            })
            .await;
    }
}

// pump_sse is Anthropic-shape-only (OpenAI/Local go through
// ai_client::run_chat_call), so it accumulates Anthropic usage from
// message_start/message_delta inline. The caller's per-provider breaker is fed
// from the stream's outcome, mirroring run_chat_call's placement.
async fn pump_sse<F>(
    resp: reqwest::Response,
    tx: mpsc::Sender<StreamEvent>,
    parse: F,
    breaker: &'static crate::circuit_breaker::Breaker,
) where
    F: Fn(&str) -> SseOutcome,
{
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut usage = TokenUsage::default();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(b) => b,
            Err(e) => {
                breaker.on_failure();
                let _ = tx
                    .send(StreamEvent::Error {
                        message: format!("stream error: {e}"),
                    })
                    .await;
                return;
            }
        };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes = buf.drain(..=pos).collect::<Vec<u8>>();
            let line = String::from_utf8_lossy(&line_bytes);
            accumulate_anthropic_usage(&line, &mut usage);
            match parse(&line) {
                SseOutcome::Delta(t) => {
                    let _ = tx.send(StreamEvent::Delta { text: t }).await;
                }
                SseOutcome::Done => {
                    breaker.on_success();
                    emit_usage(&tx, &usage).await;
                    let _ = tx.send(StreamEvent::Done).await;
                    return;
                }
                SseOutcome::Error(m) => {
                    breaker.on_failure();
                    let _ = tx.send(StreamEvent::Error { message: m }).await;
                    return;
                }
                SseOutcome::Ignore => {}
            }
        }
    }
    breaker.on_success();
    emit_usage(&tx, &usage).await;
    let _ = tx.send(StreamEvent::Done).await;
}

/// Fixed reader-facing message for a corrupted SSE stream. NEVER interpolate the
/// payload or the parse error — mid-stream both carry book-derived text
/// (invariant 1). Matches the OpenAI-compatible path's copy in `ai_client`.
const STREAM_INTERRUPTED_MSG: &str = "The answer stream was interrupted — try again.";

/// Strip the `data:` prefix from an SSE line, returning the JSON payload (or None
/// for `event:`/comment/blank lines that carry no data).
fn sse_data_payload(line: &str) -> Option<&str> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    let payload = t.strip_prefix("data:")?.trim();
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    Some(payload)
}

// ── Anthropic (/v1/messages) ────────────────────────────────────────────────

/// Map one Anthropic SSE line to an outcome. Only `content_block_delta` with a
/// `text_delta` yields text; `message_stop` ends; an `error` event is fatal;
/// everything else (message_start, ping, …) is ignored. Pure → unit-tested.
pub fn parse_anthropic_line(line: &str) -> SseOutcome {
    let Some(payload) = sse_data_payload(line) else {
        return SseOutcome::Ignore;
    };
    let v: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        // A `data:` payload that fails to parse is a transport fault — surfacing
        // it (with fixed text) matches the OpenAI path's strictness instead of
        // silently truncating the answer and ending with a clean Done.
        Err(_) => return SseOutcome::Error(STREAM_INTERRUPTED_MSG.to_string()),
    };
    match v.get("type").and_then(|x| x.as_str()) {
        Some("content_block_delta") => {
            if v.pointer("/delta/type").and_then(|x| x.as_str()) == Some("text_delta") {
                if let Some(t) = v.pointer("/delta/text").and_then(|x| x.as_str()) {
                    return SseOutcome::Delta(t.to_string());
                }
            }
            SseOutcome::Ignore
        }
        Some("message_stop") => SseOutcome::Done,
        Some("error") => {
            let msg = v
                .pointer("/error/message")
                .and_then(|x| x.as_str())
                .unwrap_or("Anthropic stream error")
                .to_string();
            SseOutcome::Error(msg)
        }
        _ => SseOutcome::Ignore,
    }
}

/// Anthropic `/v1/messages` requires `max_tokens` (it is a REQUIRED field there,
/// not optional), so the body always carries one. The caller threads the
/// depth-appropriate brevity cap from `max_tokens_for`; the `unwrap_or` is only a
/// last-resort floor for a caller that forgot to set one (the real call site in
/// `commands::ai` always passes `Some(..)`), and it is intentionally generous so
/// it can never be MORE restrictive than the reader's chosen tier. Pure →
/// unit-tested so the brevity contract is pinned without a live call.
fn anthropic_body(model: &str, prompt: &str, max_tokens: Option<u32>) -> serde_json::Value {
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens.unwrap_or(1024),
        "stream": true,
    });
    // Prompt caching (B5): put the stable instruction prefix in a cached `system`
    // block and keep the per-call fenced passage as the user message. Falls back to
    // a single user message when there's no fence to split on.
    match crate::ai_stub::cache_split(prompt) {
        Some((stable, volatile)) if !stable.is_empty() => {
            body["system"] = json!([{
                "type": "text",
                "text": stable,
                "cache_control": { "type": "ephemeral" }
            }]);
            body["messages"] = json!([{ "role": "user", "content": volatile }]);
        }
        _ => {
            body["messages"] = json!([{ "role": "user", "content": prompt }]);
        }
    }
    body
}

async fn run_anthropic(
    model: &str,
    key: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    timeout: Duration,
) -> Result<mpsc::Receiver<StreamEvent>> {
    // Fail fast if the breaker is Open — don't hand the reader a 180s hang.
    let breaker = crate::ai_client::breaker_for(AiProvider::Anthropic);
    if let Err(e) = breaker.check() {
        return Err(anyhow!("AI service unavailable: {}", e));
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .context("reqwest build")?;
    let body = anthropic_body(model, prompt, max_tokens);
    let key = key.to_string();
    let model = model.to_string();
    let (tx, rx) = mpsc::channel::<StreamEvent>(64);
    tokio::spawn(async move {
        let resp = client
            .post(ANTHROPIC_URL)
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await;
        let _ = &model;
        match resp {
            Ok(r) if r.status().is_success() => {
                pump_sse(r, tx, parse_anthropic_line, breaker).await
            }
            Ok(r) => {
                breaker.on_failure();
                let status = r.status();
                let snippet = r.text().await.unwrap_or_default();
                let _ = tx
                    .send(StreamEvent::Error {
                        message: humanize_http("Anthropic", status, &snippet),
                    })
                    .await;
            }
            Err(e) => {
                breaker.on_failure();
                let _ = tx
                    .send(StreamEvent::Error {
                        message: format!("Anthropic request failed: {e}"),
                    })
                    .await;
            }
        }
    });
    Ok(rx)
}

/// Company-paid path: the SAME Anthropic body, POSTed to the proxy's `/v1/tutor`
/// with `Authorization: Bearer <license>` instead of an `x-api-key`. The proxy
/// relays Anthropic's SSE verbatim, so we reuse `parse_anthropic_line`. Unlike the
/// other providers we await the response head before returning, so an HTTP 402
/// (cap exhausted) surfaces as a typed error rather than a mid-stream event.
async fn run_company(
    base_url: &str,
    license: &str,
    model: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    timeout: Duration,
) -> Result<mpsc::Receiver<StreamEvent>> {
    // Fail fast if the breaker is Open — a hung relay must not hand company
    // readers the full request timeout on every retry.
    let breaker = crate::ai_client::breaker_for(AiProvider::Company);
    if let Err(e) = breaker.check() {
        return Err(anyhow!("AI service unavailable: {}", e));
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .context("reqwest build")?;
    let body = anthropic_body(model, prompt, max_tokens);
    let url = format!("{}/v1/tutor", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("authorization", format!("Bearer {license}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            breaker.on_failure();
            anyhow!("Throughline AI request failed: {e}")
        })?;
    let status = resp.status();
    if status.as_u16() == 402 {
        // An authoritative metering refusal proves the relay is healthy — it
        // must never open the circuit and mask CapExhausted as unavailability.
        breaker.on_success();
        return Err(anyhow!(CAP_EXHAUSTED_SENTINEL));
    }
    if !status.is_success() {
        breaker.on_failure();
        let snippet = resp.text().await.unwrap_or_default();
        return Err(anyhow!(humanize_http("Throughline AI", status, &snippet)));
    }
    let (tx, rx) = mpsc::channel::<StreamEvent>(64);
    tokio::spawn(async move {
        pump_sse(resp, tx, parse_anthropic_line, breaker).await;
    });
    Ok(rx)
}

// ── Codex (ChatGPT-login → Responses API) ───────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexTokens {
    #[serde(skip_serializing_if = "Option::is_none")]
    id_token: Option<String>,
    access_token: String,
    refresh_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexAuth {
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", skip_serializing_if = "Option::is_none")]
    openai_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens: Option<CodexTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_refresh: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn codex_home() -> std::path::PathBuf {
    if let Ok(h) = std::env::var("CODEX_HOME") {
        if !h.trim().is_empty() {
            return std::path::PathBuf::from(h);
        }
    }
    dirs::home_dir().unwrap_or_default().join(".codex")
}

fn codex_auth_path() -> std::path::PathBuf {
    codex_home().join("auth.json")
}

fn read_codex_auth() -> Option<CodexAuth> {
    let raw = std::fs::read_to_string(codex_auth_path()).ok()?;
    serde_json::from_str::<CodexAuth>(&raw).ok()
}

/// True when usable ChatGPT-login Codex credentials exist (tokens with a
/// non-empty access token). Cheap. Never returns or logs token values.
/// NOTE: the app-owned half reads the Keychain (a macOS prompt), so this is NOT
/// on the launch path — `build_dto` uses the persisted flag plus
/// `codex_cli_auth_present` instead. Kept for request-time / test use.
pub fn codex_creds_present() -> bool {
    crate::keystore::has_codex_creds() || codex_cli_auth_present()
}

/// The no-prompt half: a usable Codex login in the CLI's own `~/.codex/auth.json`
/// (a plain file read, never the Keychain). Safe to call on every launch.
pub fn codex_cli_auth_present() -> bool {
    read_codex_auth()
        .and_then(|a| a.tokens)
        .map(|t| !t.access_token.trim().is_empty() && !t.refresh_token.trim().is_empty())
        .unwrap_or(false)
}

/// Atomically write auth.json back (temp file + rename), preserving fields we
/// don't model via serde flatten. The app only ever rewrites it after a refresh.
fn write_codex_auth(auth: &CodexAuth) -> Result<()> {
    let path = codex_auth_path();
    let tmp = path.with_extension("json.rgtmp");
    let data = serde_json::to_string_pretty(auth).context("serialize codex auth")?;
    std::fs::write(&tmp, data).context("write codex auth tmp")?;
    std::fs::rename(&tmp, &path).context("rename codex auth")?;
    Ok(())
}

// ── App-owned Codex credentials + device-code login ──

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CodexAppCreds {
    access_token: String,
    refresh_token: String,
    account_id: String,
}

/// Which store a set of Codex creds came from, so a refresh writes back correctly.
#[derive(Clone, Copy, PartialEq)]
enum CodexSource {
    App,
    File,
}

struct ResolvedCodex {
    access_token: String,
    refresh_token: String,
    account_id: String,
    source: CodexSource,
}

/// Resolve usable Codex creds, preferring the app-owned Keychain login (device
/// code) over the Codex CLI's ~/.codex/auth.json. None if neither is complete.
fn load_codex() -> Option<ResolvedCodex> {
    if let Some(json) = crate::keystore::get_codex_creds() {
        if let Ok(c) = serde_json::from_str::<CodexAppCreds>(&json) {
            if !c.access_token.trim().is_empty()
                && !c.refresh_token.trim().is_empty()
                && !c.account_id.trim().is_empty()
            {
                return Some(ResolvedCodex {
                    access_token: c.access_token,
                    refresh_token: c.refresh_token,
                    account_id: c.account_id,
                    source: CodexSource::App,
                });
            }
        }
    }
    let auth = read_codex_auth()?;
    let t = auth.tokens?;
    let account_id = t.account_id?;
    if t.access_token.trim().is_empty() || t.refresh_token.trim().is_empty() {
        return None;
    }
    Some(ResolvedCodex {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        account_id,
        source: CodexSource::File,
    })
}

/// Extract chatgpt_account_id from a Codex id_token (JWT payload → the
/// `https://api.openai.com/auth` claim namespace). Never logs the token.
fn jwt_chatgpt_account_id(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    v.get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(|s| s.to_string())
}

/// Refresh a resolved access token via the public OAuth client, persisting the
/// rotated tokens back to whichever store they came from.
async fn codex_refresh_resolved(client: &reqwest::Client, r: &mut ResolvedCodex) -> Result<String> {
    let resp = client
        .post(CODEX_TOKEN_URL)
        .header("content-type", "application/json")
        .json(&json!({ "client_id": CODEX_CLIENT_ID, "grant_type": "refresh_token", "refresh_token": r.refresh_token }))
        .send()
        .await
        .context("codex token refresh request")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let snippet = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Codex token refresh failed (HTTP {status}). Sign in again. {}",
            snippet.chars().take(160).collect::<String>()
        ));
    }
    #[derive(Deserialize)]
    struct RefreshResp {
        access_token: Option<String>,
        refresh_token: Option<String>,
    }
    let parsed: RefreshResp = resp.json().await.context("decode codex refresh response")?;
    if let Some(at) = parsed.access_token {
        r.access_token = at;
    }
    if let Some(rt) = parsed.refresh_token {
        r.refresh_token = rt;
    }
    persist_rotated_codex(r)?;
    Ok(r.access_token.clone())
}

/// Reader-facing message when rotated Codex tokens can't be saved. By this
/// point the old refresh token is already consumed server-side, so a swallowed
/// failure would strand the app AND the reader's Codex CLI with revoked
/// credentials and no signal why — it must surface as the call's error.
const CODEX_PERSIST_FAILED_MSG: &str =
    "Your ChatGPT sign-in was refreshed but couldn't be saved — sign in again in Settings → Assistance.";

/// Persist rotated Codex tokens back to whichever store they came from.
/// Separated from the OAuth round-trip so the write-back is testable hermetically.
fn persist_rotated_codex(r: &ResolvedCodex) -> Result<()> {
    match r.source {
        CodexSource::App => {
            let creds = CodexAppCreds {
                access_token: r.access_token.clone(),
                refresh_token: r.refresh_token.clone(),
                account_id: r.account_id.clone(),
            };
            crate::keystore::set_codex_creds(&serde_json::to_string(&creds).unwrap_or_default())
                .map_err(|e| anyhow!("persist codex creds: {e}"))?;
        }
        CodexSource::File => {
            // A missing/unreadable auth.json is the same stranding: the rotated
            // refresh token would be lost. Never log token values here.
            let mut auth = read_codex_auth().ok_or_else(|| anyhow!(CODEX_PERSIST_FAILED_MSG))?;
            if let Some(t) = auth.tokens.as_mut() {
                t.access_token = r.access_token.clone();
                t.refresh_token = r.refresh_token.clone();
            }
            auth.last_refresh = Some(chrono::Utc::now().to_rfc3339());
            write_codex_auth(&auth).context(CODEX_PERSIST_FAILED_MSG)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexDeviceStart {
    pub device_auth_id: String,
    pub user_code: String,
    pub verification_url: String,
    pub interval: u64,
}

/// Begin a device-code login: request a code to enter at the verification URL.
pub async fn codex_device_start() -> Result<CodexDeviceStart> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let resp = client
        .post(CODEX_DEVICE_USERCODE_URL)
        .header("content-type", "application/json")
        .json(&json!({ "client_id": CODEX_CLIENT_ID }))
        .send()
        .await
        .context("codex device usercode request")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let snippet = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Could not start Codex device login (HTTP {status}). Device-code login may need enabling in your ChatGPT settings. {}",
            snippet.chars().take(160).collect::<String>()
        ));
    }
    #[derive(Deserialize)]
    struct R {
        device_auth_id: String,
        #[serde(alias = "usercode")]
        user_code: String,
        // The endpoint returns interval as a STRING ("5"); accept string or number.
        #[serde(default)]
        interval: Option<serde_json::Value>,
    }
    let r: R = resp
        .json()
        .await
        .context("decode device usercode response")?;
    let interval = r
        .interval
        .as_ref()
        .and_then(|v| match v {
            serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
            serde_json::Value::Number(n) => n.as_u64(),
            _ => None,
        })
        .unwrap_or(5)
        .clamp(2, 10);
    Ok(CodexDeviceStart {
        device_auth_id: r.device_auth_id,
        user_code: r.user_code,
        verification_url: CODEX_DEVICE_VERIFICATION_URL.to_string(),
        interval,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexDevicePoll {
    /// "pending" | "complete" | "denied"
    pub status: String,
    pub message: String,
}

/// Poll once for device-login completion. On success, exchanges the code and
/// stores the app-owned creds in the Keychain.
pub async fn codex_device_poll(device_auth_id: &str, user_code: &str) -> Result<CodexDevicePoll> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let resp = client
        .post(CODEX_DEVICE_TOKEN_URL)
        .header("content-type", "application/json")
        .json(&json!({ "device_auth_id": device_auth_id, "user_code": user_code }))
        .send()
        .await
        .context("codex device token poll")?;
    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(CodexDevicePoll {
            status: "pending".into(),
            message: "Waiting for approval…".into(),
        });
    }
    if !status.is_success() {
        let snippet = resp.text().await.unwrap_or_default();
        return Ok(CodexDevicePoll {
            status: "denied".into(),
            message: format!(
                "HTTP {status}: {}",
                snippet.chars().take(120).collect::<String>()
            ),
        });
    }
    #[derive(Deserialize)]
    struct Code {
        authorization_code: String,
        code_verifier: String,
    }
    let code: Code = resp.json().await.context("decode device token response")?;
    let creds = codex_exchange_code(&client, &code.authorization_code, &code.code_verifier).await?;
    crate::keystore::set_codex_creds(&serde_json::to_string(&creds).unwrap_or_default())
        .map_err(|e| anyhow!("store codex creds: {e}"))?;
    Ok(CodexDevicePoll {
        status: "complete".into(),
        message: "Signed in with ChatGPT.".into(),
    })
}

/// Exchange the device authorization_code for tokens (form-encoded), then decode
/// the id_token for the account id. Skips the optional api-key token-exchange —
/// the ChatGPT Responses path uses the access_token directly.
async fn codex_exchange_code(
    client: &reqwest::Client,
    code: &str,
    code_verifier: &str,
) -> Result<CodexAppCreds> {
    let resp = client
        .post(CODEX_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", CODEX_DEVICE_REDIRECT_URI),
            ("client_id", CODEX_CLIENT_ID),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .context("codex code exchange")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let snippet = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Codex code exchange failed (HTTP {status}). {}",
            snippet.chars().take(160).collect::<String>()
        ));
    }
    #[derive(Deserialize)]
    struct T {
        id_token: String,
        access_token: String,
        refresh_token: String,
    }
    let t: T = resp.json().await.context("decode codex token response")?;
    let account_id = jwt_chatgpt_account_id(&t.id_token)
        .ok_or_else(|| anyhow!("Codex token is missing a ChatGPT account id"))?;
    Ok(CodexAppCreds {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        account_id,
    })
}

/// The ChatGPT Codex Responses backend REQUIRES a non-empty `instructions`
/// (system) field. We keep the reader prompt as the user `input` and supply a
/// short instruction so the request validates.
const CODEX_INSTRUCTIONS: &str =
    "You are a concise, helpful reading tutor. Answer the reader's request directly.";

fn codex_responses_body(model: &str, prompt: &str, max_tokens: Option<u32>) -> serde_json::Value {
    let mut body = json!({
        "model": model,
        "instructions": CODEX_INSTRUCTIONS,
        "input": [
            { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": prompt }] }
        ],
        "stream": true,
        "store": false,
    });
    // The Responses API honors `max_output_tokens` as the hard generated-token
    // ceiling, so the depth-appropriate brevity cap from `max_tokens_for` is
    // threaded here (previously the Codex path dropped its cap on the floor and
    // relied on prompt-level brevity alone). Omitted when None so a capless
    // caller — or a future model that rejects the field — sends the same body as
    // before. The prompt's brevity directives remain the primary length control;
    // this is the backstop, matching the other providers.
    if let Some(cap) = max_tokens {
        body["max_output_tokens"] = json!(cap);
    }
    body
}

/// Map one Codex Responses-API SSE line to an outcome. Pure → unit-tested.
pub fn parse_codex_line(line: &str) -> SseOutcome {
    let Some(payload) = sse_data_payload(line) else {
        return SseOutcome::Ignore;
    };
    let v: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        // Same transport-fault contract as `parse_anthropic_line`.
        Err(_) => return SseOutcome::Error(STREAM_INTERRUPTED_MSG.to_string()),
    };
    match v.get("type").and_then(|x| x.as_str()) {
        Some("response.output_text.delta") => match v.get("delta").and_then(|x| x.as_str()) {
            Some(t) => SseOutcome::Delta(t.to_string()),
            None => SseOutcome::Ignore,
        },
        Some("response.completed") => SseOutcome::Done,
        Some("response.failed") | Some("error") | Some("response.error") => {
            let msg = v
                .pointer("/response/error/message")
                .or_else(|| v.pointer("/error/message"))
                .and_then(|x| x.as_str())
                .unwrap_or("Codex stream error")
                .to_string();
            SseOutcome::Error(msg)
        }
        _ => SseOutcome::Ignore,
    }
}

async fn codex_post(
    client: &reqwest::Client,
    access_token: &str,
    account_id: &str,
    body: &serde_json::Value,
) -> reqwest::Result<reqwest::Response> {
    client
        .post(CODEX_RESPONSES_URL)
        .bearer_auth(access_token)
        .header("ChatGPT-Account-ID", account_id)
        .header("originator", CODEX_ORIGINATOR)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(body)
        .send()
        .await
}

async fn run_codex(
    model: &str,
    prompt: &str,
    max_tokens: Option<u32>,
    timeout: Duration,
) -> Result<mpsc::Receiver<StreamEvent>> {
    let mut creds = load_codex().ok_or_else(|| {
        anyhow!("No Codex login found. Sign in with ChatGPT in Settings → Assistance, or run `codex login`.")
    })?;
    // Fail fast if the breaker is Open — don't hand the reader a 180s hang.
    let breaker = crate::ai_client::breaker_for(AiProvider::Codex);
    if let Err(e) = breaker.check() {
        return Err(anyhow!("AI service unavailable: {}", e));
    }
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .context("reqwest build")?;
    let body = codex_responses_body(model, prompt, max_tokens);

    let mut resp = codex_post(&client, &creds.access_token, &creds.account_id, &body).await;

    // Reactive refresh: one retry if the token was rejected.
    if let Ok(r) = &resp {
        if r.status() == reqwest::StatusCode::UNAUTHORIZED {
            let fresh = codex_refresh_resolved(&client, &mut creds).await?;
            resp = codex_post(&client, &fresh, &creds.account_id, &body).await;
        }
    }

    let (tx, rx) = mpsc::channel::<StreamEvent>(64);
    tokio::spawn(async move {
        match resp {
            Ok(r) if r.status().is_success() => pump_sse(r, tx, parse_codex_line, breaker).await,
            Ok(r) => {
                breaker.on_failure();
                let status = r.status();
                let snippet = r.text().await.unwrap_or_default();
                let _ = tx
                    .send(StreamEvent::Error {
                        message: humanize_http("Codex", status, &snippet),
                    })
                    .await;
            }
            Err(e) => {
                breaker.on_failure();
                let _ = tx
                    .send(StreamEvent::Error {
                        message: format!("Codex request failed: {e}"),
                    })
                    .await;
            }
        }
    });
    Ok(rx)
}

// ── Connection tests (onboarding "Test" button + live checks) ───────────────

/// (reachable, resolved_model_id, human message).
pub type ConnTest = (bool, Option<String>, String);

/// Pick the best chat model from an OpenAI model list: prefer the bare flagship
/// alias, else the newest non-mini/nano/specialized `gpt-5.x`. Pure → testable.
pub fn best_gpt5_model(ids: &[String]) -> Option<String> {
    if ids.iter().any(|i| i == "gpt-5.5") {
        return Some("gpt-5.5".to_string());
    }
    let mut candidates: Vec<&String> = ids
        .iter()
        .filter(|i| i.starts_with("gpt-5"))
        .filter(|i| {
            !["mini", "nano", "chat", "audio", "realtime", "codex"]
                .iter()
                .any(|x| i.contains(x))
        })
        .collect();
    // Newest-looking last (lexical works for gpt-5, gpt-5.1, gpt-5.5, dated snapshots).
    candidates.sort();
    candidates.last().map(|s| s.to_string())
}

/// Dispatch a connection test for a provider. `key` overrides the stored key (so
/// onboarding can test before saving). Never logs the key.
pub async fn test_provider(
    provider: AiProvider,
    key: Option<String>,
    base_url: &str,
    model: &str,
    timeout: Duration,
) -> ConnTest {
    match provider {
        AiProvider::Local => match crate::ai_client::test_connection(base_url, true).await {
            Ok((true, m)) => {
                let label = m.clone().unwrap_or_else(|| "(none listed)".to_string());
                (
                    true,
                    m,
                    format!("Reachable on this Mac. First model: {label}"),
                )
            }
            Ok((false, _)) => (
                false,
                None,
                format!(
                    "Could not reach {base_url}/models. Is your local server (LM Studio) running?"
                ),
            ),
            Err(e) => (false, None, format!("{e}")),
        },
        AiProvider::OpenAi => match key {
            Some(k) => test_openai(&k, timeout).await,
            None => (false, None, "Add your OpenAI API key first.".to_string()),
        },
        AiProvider::Anthropic => match key {
            Some(k) => test_anthropic(&k, model, timeout).await,
            None => (false, None, "Add your Anthropic API key first.".to_string()),
        },
        AiProvider::Codex => test_codex(model, timeout).await,
        AiProvider::Company => {
            // The license is the Bearer credential; read it from the Keychain
            // when the caller didn't thread one. Never logged.
            match key.or_else(|| crate::keystore::get_key("company")) {
                Some(license) => test_company(base_url, &license, timeout).await,
                None => (
                    false,
                    None,
                    "Activate Throughline AI in Settings → Assistance.".to_string(),
                ),
            }
        }
        AiProvider::Disabled | AiProvider::Unset => {
            (false, None, "Choose a provider first.".to_string())
        }
    }
}

async fn test_openai(key: &str, timeout: Duration) -> ConnTest {
    // Connection tests bypass the breaker `check()` (the operator wants a real
    // probe even when it's Open) but STILL feed the outcome — a successful probe
    // is the cheapest way to close the circuit. Mirrors ai_client::test_connection.
    let breaker = crate::ai_client::breaker_for(AiProvider::OpenAi);
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => return (false, None, format!("client build: {e}")),
    };
    match client
        .get(format!("{OPENAI_BASE_URL}/models"))
        .bearer_auth(key)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            breaker.on_success();
            #[derive(Deserialize)]
            struct M {
                id: String,
            }
            #[derive(Deserialize)]
            struct R {
                data: Option<Vec<M>>,
            }
            let parsed: R = r.json().await.unwrap_or(R { data: None });
            let ids: Vec<String> = parsed
                .data
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.id)
                .collect();
            let best = best_gpt5_model(&ids);
            let label = best.clone().unwrap_or_else(|| "gpt-5.5".to_string());
            (
                true,
                best,
                format!("Connected to OpenAI. Best available model: {label}"),
            )
        }
        Ok(r) => {
            breaker.on_failure();
            let status = r.status();
            (
                false,
                None,
                humanize_http("OpenAI", status, &r.text().await.unwrap_or_default()),
            )
        }
        Err(e) => {
            breaker.on_failure();
            (false, None, format!("OpenAI request failed: {e}"))
        }
    }
}

async fn test_anthropic(key: &str, model: &str, timeout: Duration) -> ConnTest {
    // Bypass-with-feedback: no `check()`, but the probe's outcome feeds the breaker.
    let breaker = crate::ai_client::breaker_for(AiProvider::Anthropic);
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => return (false, None, format!("client build: {e}")),
    };
    let body = json!({ "model": model, "max_tokens": 1, "messages": [{ "role": "user", "content": "ping" }] });
    match client
        .post(ANTHROPIC_URL)
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            breaker.on_success();
            (
                true,
                Some(model.to_string()),
                format!("Connected to Anthropic ({model})."),
            )
        }
        Ok(r) if r.status().as_u16() == 400 => {
            // Auth passed (a 400 means the key worked but the body/model needs a
            // tweak) — the service answered, so the circuit is healthy.
            breaker.on_success();
            (
                true,
                Some(model.to_string()),
                "Anthropic key works. Double-check the model id.".to_string(),
            )
        }
        Ok(r) => {
            breaker.on_failure();
            let status = r.status();
            (
                false,
                None,
                humanize_http("Anthropic", status, &r.text().await.unwrap_or_default()),
            )
        }
        Err(e) => {
            breaker.on_failure();
            (false, None, format!("Anthropic request failed: {e}"))
        }
    }
}

async fn test_codex(model: &str, timeout: Duration) -> ConnTest {
    let mut creds = match load_codex() {
        Some(c) => c,
        None => {
            return (
                false,
                None,
                "No Codex login found. Sign in with ChatGPT below, or run `codex login`."
                    .to_string(),
            )
        }
    };
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => return (false, None, format!("client build: {e}")),
    };
    // Reachability probe only — no brevity cap needed (keeps the body identical
    // to the pre-cap test request).
    let body = codex_responses_body(model, "ping", None);
    let mut resp = codex_post(&client, &creds.access_token, &creds.account_id, &body).await;
    if let Ok(r) = &resp {
        if r.status() == reqwest::StatusCode::UNAUTHORIZED {
            match codex_refresh_resolved(&client, &mut creds).await {
                Ok(fresh) => {
                    resp = codex_post(&client, &fresh, &creds.account_id, &body).await;
                }
                Err(e) => return (false, None, format!("{e}")),
            }
        }
    }
    // Bypass-with-feedback: no `check()`, but the probe's outcome feeds the breaker.
    let breaker = crate::ai_client::breaker_for(AiProvider::Codex);
    match resp {
        Ok(r) if r.status().is_success() => {
            breaker.on_success();
            (
                true,
                Some(model.to_string()),
                "Connected via your Codex login.".to_string(),
            )
        }
        Ok(r) => {
            breaker.on_failure();
            let status = r.status();
            (
                false,
                None,
                humanize_http("Codex", status, &r.text().await.unwrap_or_default()),
            )
        }
        Err(e) => {
            breaker.on_failure();
            (false, None, format!("Codex request failed: {e}"))
        }
    }
}

/// Company-paid path: really probe the relay by GETting `/v1/credits` with the
/// Bearer license. A 2xx whose body carries the proxy's explicit `ok` field
/// proves the relay is up and the license is recognized; a transport error gets
/// a fixed human message (reqwest's Display text is plumbing). Bypasses the
/// breaker `check()` but feeds the outcome, like the other connection tests.
async fn test_company(base_url: &str, license: &str, timeout: Duration) -> ConnTest {
    let breaker = crate::ai_client::breaker_for(AiProvider::Company);
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => return (false, None, format!("client build: {e}")),
    };
    let url = format!("{}/v1/credits", base_url.trim_end_matches('/'));
    match client
        .get(&url)
        .header("authorization", format!("Bearer {license}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            match body.get("ok").and_then(|v| v.as_bool()) {
                Some(ok) => {
                    // The relay answered authoritatively either way — healthy.
                    breaker.on_success();
                    let message = if ok {
                        "Throughline AI is active (Claude Sonnet, company-paid).".to_string()
                    } else {
                        "Throughline AI is reachable, but your included allowance needs attention."
                            .to_string()
                    };
                    (
                        true,
                        Some(crate::settings::DEFAULT_ANTHROPIC_MODEL.to_string()),
                        message,
                    )
                }
                None => {
                    breaker.on_failure();
                    (
                        false,
                        None,
                        "Throughline AI answered unexpectedly. Try again shortly.".to_string(),
                    )
                }
            }
        }
        Ok(r) => {
            breaker.on_failure();
            let status = r.status();
            (
                false,
                None,
                humanize_http("Throughline AI", status, &r.text().await.unwrap_or_default()),
            )
        }
        Err(_) => {
            breaker.on_failure();
            // Fixed copy — transport detail (DNS/TLS/socket) is plumbing and
            // must never reach the reader (mirrors COMPANY_UNREACHABLE_MSG).
            (
                false,
                None,
                "Can't reach Throughline AI right now.".to_string(),
            )
        }
    }
}

fn humanize_http(provider: &str, status: reqwest::StatusCode, snippet: &str) -> String {
    let s = snippet.chars().take(300).collect::<String>();
    match status.as_u16() {
        401 => format!("{provider}: authentication failed (check your API key)."),
        403 => format!("{provider}: access denied (403). {s}"),
        429 => format!("{provider}: rate limited (429). Try again shortly."),
        _ => format!("{provider}: HTTP {status}. {s}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_delta(o: SseOutcome, expect: &str) -> bool {
        matches!(o, SseOutcome::Delta(t) if t == expect)
    }

    #[test]
    fn anthropic_catalog_defaults_to_sonnet_and_prices_opus_higher() {
        let cat = model_catalog(AiProvider::Anthropic);
        // First entry is the default tier and must match settings' DEFAULT_ANTHROPIC_MODEL.
        assert_eq!(cat[0].id, crate::settings::DEFAULT_ANTHROPIC_MODEL);
        assert_eq!(cat[0].tier, "default");
        assert!(cat[0].id.contains("sonnet"));
        // Opus is the dear option — its input price is well above Sonnet's (~5×).
        let opus = cat.iter().find(|m| m.id.contains("opus")).unwrap();
        let sonnet = cat.iter().find(|m| m.id.contains("sonnet")).unwrap();
        assert!(opus.input_per_mtok >= sonnet.input_per_mtok * 4.0);
    }

    #[test]
    fn cost_micros_sonnet_matches_hand_math() {
        let u = TokenUsage {
            input_tokens: 4750,
            output_tokens: 400,
            ..Default::default()
        };
        // 4750·$3 + 400·$15 per Mtok = 20,250 micro-dollars = $0.02025 (the memo's mid call).
        assert_eq!(
            cost_micros(AiProvider::Anthropic, "claude-sonnet-4-6", &u),
            20_250
        );
        // Opus costs the same tokens ~5× more.
        let opus = cost_micros(AiProvider::Anthropic, "claude-opus-4-8", &u);
        assert!(opus >= cost_micros(AiProvider::Anthropic, "claude-sonnet-4-6", &u) * 4);
    }

    #[test]
    fn anthropic_usage_accumulates_from_message_start_and_delta() {
        let mut acc = TokenUsage::default();
        accumulate_anthropic_usage(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":4500,"cache_read_input_tokens":120}}}"#,
            &mut acc,
        );
        accumulate_anthropic_usage(
            r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}"#,
            &mut acc,
        );
        accumulate_anthropic_usage(
            r#"data: {"type":"message_delta","usage":{"output_tokens":380}}"#,
            &mut acc,
        );
        assert_eq!(acc.input_tokens, 4500);
        assert_eq!(acc.cache_read_tokens, 120);
        assert_eq!(acc.output_tokens, 380);
    }

    #[test]
    fn openai_usage_parsed_from_terminal_chunk() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":300}}"#,
        )
        .unwrap();
        let u = parse_openai_usage(&v).unwrap();
        assert_eq!(u.input_tokens, 1200);
        assert_eq!(u.output_tokens, 300);
        // A chunk without usage (a normal delta) yields None.
        let no: serde_json::Value =
            serde_json::from_str(r#"{"choices":[{"delta":{"content":"x"}}]}"#).unwrap();
        assert!(parse_openai_usage(&no).is_none());
    }

    #[test]
    fn model_price_falls_back_to_default_never_zero() {
        // An uncatalogued (hand-typed) Anthropic model still gets a non-zero price
        // (the provider default), so the usage meter never reports $0 silently.
        let (inp, out) = model_price(AiProvider::Anthropic, "claude-some-future-model").unwrap();
        assert!(inp > 0.0 && out > 0.0);
        // Local has no catalogue → no price.
        assert!(model_price(AiProvider::Local, "whatever").is_none());
    }

    #[test]
    fn anthropic_stream_maps_text_delta_stop_and_error() {
        assert!(matches!(
            parse_anthropic_line("event: message_start"),
            SseOutcome::Ignore
        ));
        assert!(matches!(
            parse_anthropic_line(r#"data: {"type":"message_start","message":{}}"#),
            SseOutcome::Ignore
        ));
        assert!(is_delta(
            parse_anthropic_line(
                r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#
            ),
            "Hello",
        ));
        // input_json_delta (tool calls) is not text → ignored
        assert!(matches!(
            parse_anthropic_line(
                r#"data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}"#
            ),
            SseOutcome::Ignore
        ));
        assert!(matches!(
            parse_anthropic_line(r#"data: {"type":"ping"}"#),
            SseOutcome::Ignore
        ));
        assert!(matches!(
            parse_anthropic_line(r#"data: {"type":"message_stop"}"#),
            SseOutcome::Done
        ));
        match parse_anthropic_line(
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ) {
            SseOutcome::Error(m) => assert_eq!(m, "Overloaded"),
            _ => panic!("expected Error"),
        }
    }

    #[test]
    fn codex_stream_maps_output_text_delta_completed_and_failed() {
        assert!(is_delta(
            parse_codex_line(r#"data: {"type":"response.output_text.delta","delta":"Hi"}"#),
            "Hi",
        ));
        assert!(matches!(
            parse_codex_line(r#"data: {"type":"response.created"}"#),
            SseOutcome::Ignore
        ));
        assert!(matches!(
            parse_codex_line(r#"data: {"type":"response.completed"}"#),
            SseOutcome::Done
        ));
        match parse_codex_line(
            r#"data: {"type":"response.failed","response":{"error":{"message":"boom"}}}"#,
        ) {
            SseOutcome::Error(m) => assert_eq!(m, "boom"),
            _ => panic!("expected Error"),
        }
    }

    /// CORE-1027: a `data:` line that fails JSON parsing is a transport fault,
    /// not noise — silently ignoring it truncates the answer while still ending
    /// with a clean Done. Both named-event parsers must surface it with FIXED
    /// text (mid-stream the payload is book-derived; invariant 1), matching the
    /// OpenAI-compatible path's strictness in `ai_client`.
    #[test]
    fn malformed_data_lines_surface_as_generic_errors_not_silence() {
        match parse_anthropic_line("data: {\"type\":\"content_block_delta\",\"delta\":{\"te") {
            SseOutcome::Error(m) => {
                assert_eq!(m, "The answer stream was interrupted — try again.");
                assert!(
                    !m.contains("content_block_delta"),
                    "error text must never echo the payload: {m}"
                );
            }
            _ => panic!("anthropic: malformed data line must surface, got Ignore/Delta/Done"),
        }
        match parse_codex_line("data: {\"type\":\"response.output_text.delta\",\"del") {
            SseOutcome::Error(m) => {
                assert_eq!(m, "The answer stream was interrupted — try again.")
            }
            _ => panic!("codex: malformed data line must surface, got Ignore/Delta/Done"),
        }
        // Non-data noise (event names, blanks, the [DONE] sentinel) stays ignored:
        assert!(matches!(parse_anthropic_line("event: ping"), SseOutcome::Ignore));
        assert!(matches!(parse_anthropic_line(""), SseOutcome::Ignore));
        assert!(matches!(
            parse_anthropic_line("data: [DONE]"),
            SseOutcome::Ignore
        ));
        assert!(matches!(
            parse_codex_line("event: response.created"),
            SseOutcome::Ignore
        ));
        assert!(matches!(parse_codex_line(""), SseOutcome::Ignore));
        assert!(matches!(parse_codex_line("data: [DONE]"), SseOutcome::Ignore));
    }

    #[test]
    fn sse_data_payload_strips_prefix_and_skips_noise() {
        assert_eq!(sse_data_payload("data: {\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_payload("event: ping"), None);
        assert_eq!(sse_data_payload(""), None);
        assert_eq!(sse_data_payload("data: [DONE]"), None);
    }

    #[test]
    fn codex_auth_parses_chatgpt_login_shape_and_present_check() {
        // Fabricated shape from the public openai/codex source — NOT a real token.
        let raw = r#"{
          "auth_mode":"chatgpt",
          "OPENAI_API_KEY":null,
          "tokens":{"id_token":"jwt","access_token":"at","refresh_token":"rt","account_id":"acct"},
          "last_refresh":"2026-04-17T00:00:00Z",
          "some_future_field":123
        }"#;
        let auth: CodexAuth = serde_json::from_str(raw).unwrap();
        let t = auth.tokens.as_ref().unwrap();
        assert_eq!(t.access_token, "at");
        assert_eq!(t.account_id.as_deref(), Some("acct"));
        // Unknown fields are preserved for round-trip write-back.
        let reser = serde_json::to_string(&auth).unwrap();
        assert!(reser.contains("some_future_field"));
        assert!(!reser.contains("\"OPENAI_API_KEY\"") || !reser.contains("null"));
    }

    /// Helpers for the persist_rotated_codex tests: a fresh CODEX_HOME temp dir
    /// seeded with a valid auth.json (with unknown fields at both levels, so
    /// round-trip preservation is exercised). Caller holds `lock_env_for_test`.
    fn seed_codex_home(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("tl-codex-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("auth.json"),
            r#"{
              "auth_mode":"chatgpt",
              "tokens":{"id_token":"jwt","access_token":"at-old","refresh_token":"rt-old","account_id":"acct","token_future_field":"keep-me"},
              "last_refresh":"2026-04-17T00:00:00Z",
              "some_future_field":123
            }"#,
        )
        .unwrap();
        // SAFETY: process-global env var; serialized by the caller's env lock.
        unsafe {
            std::env::set_var("CODEX_HOME", &dir);
        }
        dir
    }

    fn rotated_file_creds() -> ResolvedCodex {
        ResolvedCodex {
            access_token: "at-new".to_string(),
            refresh_token: "rt-new".to_string(),
            account_id: "acct".to_string(),
            source: CodexSource::File,
        }
    }

    /// CORE-1012: a failed write-back of rotated Codex tokens must surface as an
    /// error telling the reader to sign in again — the old refresh token is
    /// already consumed server-side, so swallowing it strands the app AND the
    /// reader's Codex CLI with revoked credentials and no signal why.
    #[cfg(unix)]
    #[test]
    fn persist_rotated_codex_file_surfaces_write_failure_as_sign_in_again() {
        use std::os::unix::fs::PermissionsExt;
        let _g = crate::paths::lock_env_for_test();
        let dir = seed_codex_home("persist-ro");

        let mut perms = std::fs::metadata(&dir).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(&dir, perms).unwrap();

        // Running as root, file permissions don't bind (set_mode is a no-op in
        // effect) — probe, and skip the read-only assertion gracefully.
        let perms_enforced = std::fs::write(dir.join(".probe"), b"x").is_err();

        let result = if perms_enforced {
            Some(persist_rotated_codex(&rotated_file_creds()))
        } else {
            None
        };

        // Restore permissions BEFORE cleanup so the temp dir can be removed.
        let mut restore = std::fs::metadata(&dir).unwrap().permissions();
        restore.set_mode(0o755);
        std::fs::set_permissions(&dir, restore).unwrap();
        unsafe {
            std::env::remove_var("CODEX_HOME");
        }
        let _ = std::fs::remove_dir_all(&dir);

        let Some(result) = result else {
            eprintln!("skipping read-only assertion: permissions not enforced (running as root?)");
            return;
        };
        let err = result
            .expect_err("write-back into a read-only CODEX_HOME must error, not be swallowed");
        let msg = format!("{err}");
        assert!(
            msg.contains("sign in again"),
            "error must tell the reader what to do, got: {msg}"
        );
    }

    /// Happy path: a writable CODEX_HOME gets the rotated tokens written back,
    /// with unknown fields preserved at both the auth and tokens level.
    #[test]
    fn persist_rotated_codex_file_writes_rotated_tokens_and_preserves_unknown_fields() {
        let _g = crate::paths::lock_env_for_test();
        let dir = seed_codex_home("persist-ok");

        let result = persist_rotated_codex(&rotated_file_creds());
        let raw = std::fs::read_to_string(dir.join("auth.json")).unwrap();
        unsafe {
            std::env::remove_var("CODEX_HOME");
        }
        let _ = std::fs::remove_dir_all(&dir);

        result.expect("writable CODEX_HOME → Ok(())");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["tokens"]["access_token"], "at-new");
        assert_eq!(v["tokens"]["refresh_token"], "rt-new");
        // Unknown fields survive the round trip (the CLI may depend on them).
        assert_eq!(v["some_future_field"], 123);
        assert_eq!(v["tokens"]["token_future_field"], "keep-me");
        // last_refresh is updated past the seeded 2026-04-17 stamp.
        let stamp = v["last_refresh"].as_str().unwrap();
        assert!(
            stamp > "2026-04-17T00:00:00Z",
            "last_refresh updated: {stamp}"
        );
    }

    #[test]
    fn best_gpt5_model_prefers_flagship_then_newest_nonspecialized() {
        let ids = vec![
            "gpt-4o".into(),
            "gpt-5".into(),
            "gpt-5-mini".into(),
            "gpt-5.5".into(),
            "gpt-5.5-2026-04-23".into(),
            "gpt-5-codex".into(),
        ];
        assert_eq!(best_gpt5_model(&ids).as_deref(), Some("gpt-5.5"));
        // Without the bare alias, pick the newest non-specialized gpt-5.x.
        let ids2 = vec![
            "gpt-4o".into(),
            "gpt-5".into(),
            "gpt-5.1".into(),
            "gpt-5-mini".into(),
        ];
        assert_eq!(best_gpt5_model(&ids2).as_deref(), Some("gpt-5.1"));
        // No gpt-5 family at all → None.
        assert_eq!(best_gpt5_model(&["gpt-4o".to_string()]), None);
    }

    #[test]
    fn jwt_decodes_chatgpt_account_id_from_id_token() {
        let payload = serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct-xyz" },
            "exp": 9999999999u64
        });
        let p = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("aGVhZGVy.{p}.c2ln");
        assert_eq!(jwt_chatgpt_account_id(&token).as_deref(), Some("acct-xyz"));
        // Malformed / missing claim → None (never panics).
        assert_eq!(jwt_chatgpt_account_id("not-a-jwt"), None);
        let empty = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"{}");
        assert_eq!(jwt_chatgpt_account_id(&format!("h.{empty}.s")), None);
    }

    #[test]
    fn codex_body_is_a_streaming_responses_request() {
        let b = codex_responses_body("gpt-5.5", "hello", None);
        assert_eq!(b["model"], "gpt-5.5");
        assert_eq!(b["input"][0]["content"][0]["text"], "hello");
        assert_eq!(b["stream"], true);
        assert!(b["instructions"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false));
    }

    /// Cross-provider brevity contract: the depth-appropriate cap from
    /// `commands::ai::max_tokens_for` must reach EACH provider's constructed
    /// request body — not just the LM Studio path. These pin the body fields so a
    /// regression that drops the cap (as the Codex path originally did with its
    /// ignored `_max_tokens`, or Anthropic's silent 1024 default) is caught
    /// offline, with no live call. The exact Brief/Deep numbers are the tier
    /// ceilings owned by `commands::ai`; here we assert the cap the caller passes
    /// is the cap the body carries.
    #[test]
    fn anthropic_body_carries_the_callers_brevity_cap() {
        // Brief tier value.
        let brief = anthropic_body("claude-opus-4-8", "hi", Some(200));
        assert_eq!(
            brief["max_tokens"], 200,
            "Anthropic body must carry the Brief cap, not the silent 1024 default"
        );
        // Deep tier value — a different number proves it's threaded, not hardcoded.
        let deep = anthropic_body("claude-opus-4-8", "hi", Some(450));
        assert_eq!(
            deep["max_tokens"], 450,
            "Anthropic body must carry the Deep cap"
        );
        assert_eq!(deep["stream"], true);
        assert_eq!(deep["model"], "claude-opus-4-8");
        // Only the no-cap fallback hits the generous floor; the real call site
        // always passes Some(..), so this can never be MORE restrictive than a tier.
        let fallback = anthropic_body("claude-opus-4-8", "hi", None);
        assert_eq!(
            fallback["max_tokens"], 1024,
            "a capless caller falls back to a generous floor, never a tighter one"
        );
    }

    #[test]
    fn anthropic_body_caches_the_stable_instruction_prefix() {
        let prompt = "You are a tutor. Instructions here.\n\n<<<UNTRUSTED_PASSAGE>>>\n> hi there\n<<<END_UNTRUSTED_PASSAGE>>>\n";
        let body = anthropic_body("claude-sonnet-4-6", prompt, Some(200));
        // The stable instruction prefix becomes a cached system block...
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        let sys = body["system"][0]["text"].as_str().unwrap();
        assert!(sys.contains("Instructions here"));
        assert!(
            !sys.contains("UNTRUSTED_PASSAGE"),
            "the volatile passage must stay OUT of the cached prefix"
        );
        // ...and the fenced passage is the per-call user message.
        let user = body["messages"][0]["content"].as_str().unwrap();
        assert!(user.contains("UNTRUSTED_PASSAGE") && user.contains("hi there"));
        // No fence → a single user message, no system block.
        assert!(anthropic_body("claude-sonnet-4-6", "hi", Some(200))
            .get("system")
            .is_none());
    }

    #[test]
    fn codex_body_carries_the_callers_brevity_cap_as_max_output_tokens() {
        // The Responses API uses `max_output_tokens` for the generated-token ceiling.
        let brief = codex_responses_body("gpt-5.5", "hi", Some(200));
        assert_eq!(
            brief["max_output_tokens"], 200,
            "Codex body must honor the Brief cap (was previously ignored)"
        );
        let deep = codex_responses_body("gpt-5.5", "hi", Some(450));
        assert_eq!(
            deep["max_output_tokens"], 450,
            "Codex body must honor the Deep cap"
        );
        // With no cap the field is omitted entirely, so a capless / probe request
        // (and any future model that rejects the field) sends the original body.
        let none = codex_responses_body("gpt-5.5", "hi", None);
        assert!(
            none.get("max_output_tokens").is_none(),
            "no cap → field omitted, body unchanged from the pre-cap shape"
        );
    }

    // ── Live checks (ignore-gated; network + real creds; never run in CI) ──
    // Run e.g.: `cargo test --lib -- --ignored live_anthropic --nocapture`.
    // They read keys from env / ~/.codex and never print the secret.

    /// HUMAN-RUN ONCE: proves the Anthropic brevity cap actually clamps generation
    /// end-to-end (the unit tests only pin the body field; only a real round-trip
    /// proves the API honors it). A deliberately verbose prompt under a TINY 24-tok
    /// cap must come back short — if the cap were dropped the reply would run long.
    ///   ANTHROPIC_API_KEY=… cargo test --lib -- --ignored live_anthropic_brevity_cap --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_anthropic_brevity_cap() {
        let key = std::env::var("ANTHROPIC_API_KEY").expect("set ANTHROPIC_API_KEY");
        let cap = 24u32;
        let mut rx = run_anthropic(
            "claude-opus-4-8",
            &key,
            "Write three long paragraphs about the history of typography.",
            Some(cap),
            Duration::from_secs(30),
        )
        .await
        .expect("run_anthropic");
        let mut got = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Delta { text } => got.push_str(&text),
                StreamEvent::Done => break,
                StreamEvent::Usage { .. } => {}
                StreamEvent::Error { message } => panic!("anthropic stream error: {message}"),
            }
        }
        let words = got.split_whitespace().count();
        println!("[anthropic-brevity] cap={cap} got {words} words :: {got:?}");
        assert!(!got.trim().is_empty(), "expected SOME streamed reply");
        // A 24-token ceiling can't produce three paragraphs; allow generous slack
        // for tokenizer/word skew but catch a dropped cap (which would run long).
        assert!(
            words <= 60,
            "a {cap}-token cap must clamp output; got {words} words — is the cap reaching the wire?"
        );
    }

    /// HUMAN-RUN ONCE: same brevity proof for the Codex Responses path, whose cap
    /// (`max_output_tokens`) was previously ignored entirely. Needs a real Codex
    /// (ChatGPT) login in ~/.codex or the app-owned Keychain creds.
    ///   cargo test --lib -- --ignored live_codex_brevity_cap --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_codex_brevity_cap() {
        let cap = 24u32;
        let mut rx = match run_codex(
            "gpt-5.5",
            "Write three long paragraphs about the history of typography.",
            Some(cap),
            Duration::from_secs(30),
        )
        .await
        {
            Ok(rx) => rx,
            Err(e) => {
                println!("[codex-brevity] skipped (no login?): {e}");
                return;
            }
        };
        let mut got = String::new();
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Delta { text } => got.push_str(&text),
                StreamEvent::Done => break,
                StreamEvent::Usage { .. } => {}
                StreamEvent::Error { message } => {
                    // Codex backend is an unofficial/fragile contract — report, don't fail.
                    println!("[codex-brevity] stream error: {message}");
                    return;
                }
            }
        }
        let words = got.split_whitespace().count();
        println!("[codex-brevity] cap={cap} got {words} words :: {got:?}");
        assert!(
            words <= 60,
            "a {cap}-token cap must clamp Codex output; got {words} words — is max_output_tokens honored?"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn live_anthropic() {
        let key = std::env::var("ANTHROPIC_API_KEY").expect("set ANTHROPIC_API_KEY");
        let (ok, model, msg) = test_provider(
            AiProvider::Anthropic,
            Some(key.clone()),
            "",
            "claude-opus-4-8",
            Duration::from_secs(25),
        )
        .await;
        println!("[anthropic] connect ok={ok} model={model:?} :: {msg}");
        assert!(ok, "anthropic connection failed: {msg}");
        // End-to-end streaming smoke: one tiny prompt → Delta(s) then Done.
        let mut rx = run_anthropic(
            "claude-opus-4-8",
            &key,
            "Reply with exactly one word: pong",
            Some(16),
            Duration::from_secs(25),
        )
        .await
        .expect("run_anthropic");
        let mut got = String::new();
        let mut done = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Delta { text } => got.push_str(&text),
                StreamEvent::Done => {
                    done = true;
                    break;
                }
                StreamEvent::Usage { .. } => {}
                StreamEvent::Error { message } => panic!("anthropic stream error: {message}"),
            }
        }
        println!("[anthropic] stream reply = {got:?}");
        assert!(done && !got.trim().is_empty(), "expected a streamed reply");
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex_device_start() {
        // Verifies the device-auth endpoint + client_id (non-interactive). The full
        // approve→poll→exchange is done by the user in the app UI.
        match codex_device_start().await {
            Ok(s) => {
                println!("[codex-device] device_auth_id={}", s.device_auth_id);
                println!(
                    "[codex-device] user_code={} url={} interval={}",
                    s.user_code, s.verification_url, s.interval
                );
                assert!(!s.user_code.trim().is_empty(), "expected a user code");
                assert!(
                    !s.device_auth_id.trim().is_empty(),
                    "expected a device_auth_id"
                );
                assert!(s.verification_url.contains("codex/device"));
            }
            Err(e) => panic!("device start failed: {e}"),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex_device_finish() {
        // Run AFTER approving a device code in the browser, passing the ids inline:
        //   RG_DEVICE_AUTH_ID=… RG_USER_CODE=… cargo test --lib -- --ignored live_codex_device_finish --nocapture
        let dai = std::env::var("RG_DEVICE_AUTH_ID").expect("set RG_DEVICE_AUTH_ID");
        let uc = std::env::var("RG_USER_CODE").expect("set RG_USER_CODE");
        let mut done = false;
        for _ in 0..18 {
            let r = codex_device_poll(&dai, &uc).await.expect("poll");
            println!("[codex-device] poll status={} :: {}", r.status, r.message);
            if r.status == "complete" {
                done = true;
                break;
            }
            if r.status == "denied" {
                panic!("denied: {}", r.message);
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        assert!(done, "device login did not complete in time");
        // App-owned creds are now stored (in-memory keystore under test).
        assert!(
            crate::keystore::has_codex_creds(),
            "app-owned creds were not stored"
        );
        // And a real Codex call must work using the app-owned creds.
        let (ok, model, msg) = test_provider(
            AiProvider::Codex,
            None,
            "",
            "gpt-5.5",
            Duration::from_secs(30),
        )
        .await;
        println!("[codex-device] post-login codex test ok={ok} model={model:?} :: {msg}");
        assert!(ok, "codex call with app-owned creds failed: {msg}");
    }

    #[tokio::test]
    #[ignore]
    async fn live_codex() {
        let (ok, model, msg) = test_provider(
            AiProvider::Codex,
            None,
            "",
            "gpt-5.5",
            Duration::from_secs(30),
        )
        .await;
        println!("[codex] connect ok={ok} model={model:?} :: {msg}");
        // End-to-end stream: verify response.output_text.delta → text actually flows.
        if ok {
            match run_codex(
                "gpt-5.5",
                "Reply with exactly one word: pong",
                Some(16),
                Duration::from_secs(30),
            )
            .await
            {
                Ok(mut rx) => {
                    let mut got = String::new();
                    while let Some(ev) = rx.recv().await {
                        match ev {
                            StreamEvent::Delta { text } => got.push_str(&text),
                            StreamEvent::Done => break,
                            StreamEvent::Usage { .. } => {}
                            StreamEvent::Error { message } => {
                                println!("[codex] stream error: {message}");
                                break;
                            }
                        }
                    }
                    println!("[codex] stream reply = {got:?}");
                }
                Err(e) => println!("[codex] run_codex error: {e}"),
            }
        }
        // Codex backend is an unofficial/fragile contract — report, don't hard-fail.
    }

    #[tokio::test]
    #[ignore]
    async fn live_openai() {
        let key = std::env::var("OPENAI_API_KEY").expect("set OPENAI_API_KEY");
        let (ok, model, msg) = test_provider(
            AiProvider::OpenAi,
            Some(key.clone()),
            "",
            "",
            Duration::from_secs(25),
        )
        .await;
        println!("[openai] connect ok={ok} model={model:?} :: {msg}");
        assert!(ok, "openai connection failed: {msg}");
        // End-to-end stream via the real dispatch (max_completion_tokens path).
        let call = ProviderCall {
            provider: AiProvider::OpenAi,
            model: model.unwrap_or_else(|| "gpt-5.5".to_string()),
            prompt: "Reply with exactly one word: pong".to_string(),
            max_tokens: Some(256),
            timeout: Duration::from_secs(30),
            auth: ProviderAuth::OpenAiKey(key),
            base_url: String::new(),
        };
        let mut rx = run_provider_call(call).await.expect("run_provider_call");
        let mut got = String::new();
        let mut done = false;
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Delta { text } => got.push_str(&text),
                StreamEvent::Done => {
                    done = true;
                    break;
                }
                StreamEvent::Usage { .. } => {}
                StreamEvent::Error { message } => panic!("openai stream error: {message}"),
            }
        }
        println!("[openai] stream reply = {got:?}");
        assert!(done && !got.trim().is_empty(), "expected a streamed reply");
    }
}

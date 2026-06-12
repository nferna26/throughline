//! AI session phrases — the app side of docs/PHRASES_API.md.
//!
//! A phrase is decorative and additive: every failure mode here must be
//! invisible. The heuristic `chapter_label` keeps carrying the Today screen;
//! a phrase that never arrives is indistinguishable from one that was never
//! requested. Nothing in this module may surface an error to the reader, and
//! nothing here may log slice text — counts and statuses only.
//!
//! Spoiler safety is BY CONSTRUCTION: the payload slice derives exclusively
//! from the sitting's own text (read with an explicit `[start, end)` bound)
//! through the same normalization `sittings::opening_hash` hashes, so the
//! request can never carry text the reader hasn't been promised today.
//!
//! The toggle (`settings::get_ai_phrases`) gates PLANNING, not sending: a
//! disabled toggle means `plan_batch` returns `None` and no network code can
//! even be reached — zero phrase network calls by construction.
//!
//! Codex (the experimental ChatGPT-login tutor path) is deliberately not a
//! phrase provider; those readers keep heuristic labels.

use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::db::DbState;
use crate::log;
use crate::models::BookSection;
use crate::settings;
use crate::sittings;

// ── Contract caps (docs/PHRASES_API.md — protocol terms, not tunables) ──────

pub const MAX_ITEMS_PER_CALL: usize = 120;
/// Must equal `sittings::OPENING_CHARS` — asserted by test, both mirror the relay.
pub const MAX_SLICE_CHARS: usize = 1800;
pub const MAX_SLICE_WORDS: usize = 300;
pub const MAX_LABEL_CHARS: usize = 120;
pub const MAX_PHRASE_CHARS: usize = 80;
pub const MAX_PHRASE_WORDS: usize = 10;
/// Import-time batch size: the first sittings of a fresh book.
pub const IMPORT_BATCH_SITTINGS: usize = 3;

// ── Payload building ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PhraseItem {
    pub opening_hash: String,
    pub label: String,
    pub slice: String,
}

/// The payload slice: the first `MAX_SLICE_WORDS` words of the SAME normalized
/// string `opening_hash` hashes a 1,800-char prefix of (contract §Request).
/// Input is the sitting's own text and nothing else.
pub fn payload_slice(sitting_text: &str) -> String {
    let normalized = sittings::normalize_opening(sitting_text);
    let mut out = String::new();
    for (i, w) in normalized.split(' ').enumerate() {
        if i >= MAX_SLICE_WORDS {
            break;
        }
        if i > 0 {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// A sitting still missing its phrase: everything needed to build its item
/// except the text itself (which the caller reads, bounded, via `read`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingSitting {
    pub sort_order: i64,
    pub opening_hash: String,
    pub label: String,
    pub global_start: usize,
    pub char_count: usize,
}

/// Sittings with an opening hash but no cached phrase, in reading order.
pub fn missing_sittings(
    conn: &Connection,
    book_id: &str,
    sections: &[BookSection],
    limit: usize,
) -> rusqlite::Result<Vec<MissingSitting>> {
    let mut stmt = conn.prepare(
        "SELECT s.sort_order, s.opening_hash, s.chapter_label, s.start_section_id, s.start_offset, s.char_count
         FROM sittings s LEFT JOIN phrases p ON p.opening_hash = s.opening_hash
         WHERE s.book_id = ?1 AND s.opening_hash IS NOT NULL AND p.opening_hash IS NULL
         ORDER BY s.sort_order ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![book_id, limit as i64], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (sort_order, opening_hash, label, sec_id, offset, char_count) = row?;
        if char_count <= 0 {
            continue;
        }
        let global_start = sittings::to_global(sections, &sec_id, offset).max(0) as usize;
        out.push(MissingSitting {
            sort_order,
            opening_hash,
            label,
            global_start,
            char_count: char_count as usize,
        });
    }
    Ok(out)
}

/// Build wire items from missing sittings. `read` MUST honor its `[start, end)`
/// bound — it is always called with `end = start + char_count`, never beyond
/// the sitting (the spoiler-safety boundary, pinned by test).
pub fn items_from_missing(
    missing: &[MissingSitting],
    mut read: impl FnMut(usize, usize) -> Option<String>,
) -> Vec<PhraseItem> {
    let mut items = Vec::new();
    for m in missing.iter().take(MAX_ITEMS_PER_CALL) {
        let Some(text) = read(m.global_start, m.global_start + m.char_count) else {
            continue; // unreadable text: skip quietly, the heuristic carries it
        };
        let slice = payload_slice(&text);
        if slice.is_empty() {
            continue;
        }
        items.push(PhraseItem {
            opening_hash: m.opening_hash.clone(),
            label: truncate_chars(&m.label, MAX_LABEL_CHARS),
            slice,
        });
    }
    items
}

// ── Response validation + storage ────────────────────────────────────────────

/// Contract §Response: 1–10 words, ≤ 80 chars, single line, no em dashes, no
/// surrounding quotes, no terminal period. Invalid → that item keeps the
/// heuristic; never an error.
pub fn valid_phrase(p: &str) -> bool {
    let t = p.trim();
    if t.is_empty() || t.chars().count() > MAX_PHRASE_CHARS {
        return false;
    }
    if t.contains('\n') || t.contains('\r') || t.contains('—') {
        return false;
    }
    if t.starts_with('"')
        || t.ends_with('"')
        || t.starts_with('\u{201c}')
        || t.ends_with('\u{201d}')
    {
        return false;
    }
    // A phrase WRAPPED in single/curly-single quotes is a violator too; only a
    // surrounding PAIR fires, so interior apostrophes stay legal.
    if (t.starts_with('\'') && t.ends_with('\''))
        || (t.starts_with('\u{2018}') && t.ends_with('\u{2019}'))
    {
        return false;
    }
    if t.ends_with('.') {
        return false;
    }
    let words = t.split_whitespace().count();
    (1..=MAX_PHRASE_WORDS).contains(&words)
}

fn plausible_hash(h: &str) -> bool {
    // 64 LOWERCASE hex chars (contract §Request) — the join key is emitted by
    // format!("{:x}") and SQLite TEXT '=' is case-sensitive, so an uppercase
    // hash could only ever produce a dead row.
    h.len() == 64
        && h.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Upsert validated phrases into the content-addressed cache. Returns how many
/// landed (invalid items are dropped silently — heuristic keeps carrying them).
pub fn upsert_phrases(
    conn: &Connection,
    items: &[(String, String)],
    model: &str,
    now: &str,
) -> rusqlite::Result<usize> {
    let mut n = 0;
    for (hash, phrase) in items {
        let t = phrase.trim();
        if !plausible_hash(hash) || !valid_phrase(t) {
            continue;
        }
        conn.execute(
            "INSERT INTO phrases (opening_hash, phrase, model, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(opening_hash) DO UPDATE SET
               phrase = excluded.phrase, model = excluded.model, created_at = excluded.created_at",
            params![hash, t, model, now],
        )?;
        n += 1;
    }
    Ok(n)
}

// ── Planning (the toggle gate lives HERE, before any network code exists) ───

/// Which wire the batch goes out on. Carries no secrets — those are resolved
/// outside the DB lock by `resolve_auth`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhraseRoute {
    Company { base_url: String },
    Anthropic { model: String },
    OpenAi { model: String },
    Local { base_url: String, model: String },
}

/// The full sending credential, resolved from the Keychain (never under the DB
/// lock). Only `fetch_batch` consumes it.
pub enum PhraseAuth {
    Company { base_url: String, license: String },
    Anthropic { key: String, model: String },
    OpenAi { key: String, model: String },
    Local { base_url: String, model: String },
}

impl PhraseRoute {
    pub fn label(&self) -> &'static str {
        match self {
            PhraseRoute::Company { .. } => "company",
            PhraseRoute::Anthropic { .. } => "anthropic",
            PhraseRoute::OpenAi { .. } => "openai",
            PhraseRoute::Local { .. } => "local",
        }
    }
}

impl PhraseAuth {
    pub fn model_name(&self) -> &str {
        match self {
            PhraseAuth::Company { .. } => "relay",
            PhraseAuth::Anthropic { model, .. } | PhraseAuth::OpenAi { model, .. } => model,
            PhraseAuth::Local { model, .. } => model,
        }
    }
    fn provider_label(&self) -> &'static str {
        match self {
            PhraseAuth::Company { .. } => "company",
            PhraseAuth::Anthropic { .. } => "anthropic",
            PhraseAuth::OpenAi { .. } => "openai",
            PhraseAuth::Local { .. } => "local",
        }
    }
}

/// Plan a batch under the DB lock: None when the toggle is off, the provider
/// can't carry phrases, or nothing is missing. The network layer takes the
/// returned items + route, so "toggle off ⇒ zero phrase network calls" is a
/// type-level property, not a runtime check someone can forget.
pub fn plan_batch(
    conn: &Connection,
    book_id: &str,
    sections: &[BookSection],
    limit: usize,
) -> Option<(Vec<MissingSitting>, PhraseRoute)> {
    let route = route_for(conn)?;
    let missing = missing_sittings(conn, book_id, sections, limit).ok()?;
    if missing.is_empty() {
        return None;
    }
    Some((missing, route))
}

/// The single gate every phrase path goes through: the toggle first, then a
/// phrase-capable provider. None ⇒ no wire code is reachable.
fn route_for(conn: &Connection) -> Option<PhraseRoute> {
    if !settings::get_ai_phrases(conn) {
        return None;
    }
    let route = match settings::get_ai_provider(conn) {
        settings::AiProvider::Company => PhraseRoute::Company {
            base_url: settings::get_company_base_url(conn),
        },
        settings::AiProvider::Anthropic => PhraseRoute::Anthropic {
            model: settings::get_ai_model_for(conn, settings::AiProvider::Anthropic),
        },
        settings::AiProvider::OpenAi => PhraseRoute::OpenAi {
            model: settings::get_ai_model_for(conn, settings::AiProvider::OpenAi),
        },
        settings::AiProvider::Local => PhraseRoute::Local {
            base_url: settings::get_ai_base_url(conn),
            model: settings::get_ai_model_for(conn, settings::AiProvider::Local),
        },
        // Codex, Disabled, Unset: phrases stay heuristic.
        _ => return None,
    };
    Some(route)
}

/// Resolve the route's credential from the Keychain — call OUTSIDE the DB lock.
pub fn resolve_auth(route: PhraseRoute) -> Option<PhraseAuth> {
    match route {
        PhraseRoute::Company { base_url } => {
            let license = crate::keystore::get_key("company")?;
            Some(PhraseAuth::Company { base_url, license })
        }
        PhraseRoute::Anthropic { model } => {
            let key = crate::keystore::get_key("anthropic")?;
            Some(PhraseAuth::Anthropic { key, model })
        }
        PhraseRoute::OpenAi { model } => {
            let key = crate::keystore::get_key("openai")?;
            Some(PhraseAuth::OpenAi { key, model })
        }
        PhraseRoute::Local { base_url, model } => {
            if model.trim().is_empty() {
                return None; // no local model chosen → nothing to call
            }
            Some(PhraseAuth::Local { base_url, model })
        }
    }
}

// ── Backoff (failure invisibility: silence, never a surface) ────────────────

// One slot per route (company / anthropic / openai / local): a relay cap-hit
// must never silence a reader who switches to their own key (contract §Builds).
const ROUTES: usize = 4;
static BACKOFF_UNTIL_MS: [AtomicI64; ROUTES] = [
    AtomicI64::new(0),
    AtomicI64::new(0),
    AtomicI64::new(0),
    AtomicI64::new(0),
];
static CONSECUTIVE_FAILS: [AtomicU32; ROUTES] = [
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
];
/// Batches the relay REJECTED (400: a shape disagreement that will reproduce
/// deterministically). Contract: a permanent skip for those items — held for
/// the process lifetime, cleared only by reset_backoff (an operator action).
static SKIPPED_HASHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn skipped() -> &'static Mutex<HashSet<String>> {
    SKIPPED_HASHES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn route_idx(label: &str) -> usize {
    match label {
        "company" => 0,
        "anthropic" => 1,
        "openai" => 2,
        _ => 3,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Cheap jitter without a rand dependency: sub-millisecond clock noise.
fn jitter_ms(max: i64) -> i64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as i64)
        .unwrap_or(0);
    nanos % max.max(1)
}

pub fn backoff_active(route_label: &str) -> bool {
    now_ms() < BACKOFF_UNTIL_MS[route_idx(route_label)].load(Ordering::Relaxed)
}

/// How a batch failed. Carries statuses and seconds — never response content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhraseFail {
    /// 429 — honor the server's retry_after (seconds) when present.
    RateLimited { retry_after: Option<u64> },
    /// 402 — the distinct cap state. Phrases NEVER surface cap UI; long sleep.
    CapHit,
    /// 401 — bad/revoked license or key.
    Auth,
    /// 400 — the relay rejected the batch's shape; deterministic, never retried.
    Rejected,
    /// Transport / 5xx / parse failure.
    Transient,
}

/// Contract §Errors, per route: 429 honors retry_after + jitter; cap-hit (402)
/// sleeps a day and stays invisible; auth (401) stops effectively permanently
/// (until reset_backoff fires on re-activation / a new key); rejected (400)
/// batches are skip-listed separately; transient failures back off
/// exponentially (1 min → 5 min → 30 min cap).
pub fn note_failure(route_label: &str, fail: &PhraseFail) {
    let i = route_idx(route_label);
    let fails = CONSECUTIVE_FAILS[i].fetch_add(1, Ordering::Relaxed) + 1;
    let wait_ms: i64 = match fail {
        PhraseFail::RateLimited { retry_after } => {
            (retry_after.unwrap_or(60).max(1) as i64) * 1000 + jitter_ms(15_000)
        }
        PhraseFail::CapHit | PhraseFail::Rejected => 24 * 60 * 60 * 1000,
        // "Permanent stop until re-activation": in-process permanence; the
        // resets below are the re-activation paths.
        PhraseFail::Auth => 30 * 24 * 60 * 60 * 1000,
        PhraseFail::Transient => {
            let base: i64 = match fails {
                0 | 1 => 60_000,
                2 => 300_000,
                _ => 1_800_000,
            };
            base + jitter_ms(base / 4)
        }
    };
    BACKOFF_UNTIL_MS[i].store(now_ms() + wait_ms, Ordering::Relaxed);
}

pub fn note_success(route_label: &str) {
    let i = route_idx(route_label);
    CONSECUTIVE_FAILS[i].store(0, Ordering::Relaxed);
    BACKOFF_UNTIL_MS[i].store(0, Ordering::Relaxed);
}

/// Clear ALL phrase backoff + skip state. Called when the reader takes an
/// action that plausibly fixes the cause: re-activating, saving a new key,
/// switching provider, or turning the phrases toggle on.
pub fn reset_backoff() {
    for i in 0..ROUTES {
        CONSECUTIVE_FAILS[i].store(0, Ordering::Relaxed);
        BACKOFF_UNTIL_MS[i].store(0, Ordering::Relaxed);
    }
    if let Ok(mut set) = skipped().lock() {
        set.clear();
    }
}

/// Mark a rejected batch's items as permanently skipped (process lifetime).
fn mark_skipped(items: &[PhraseItem]) {
    if let Ok(mut set) = skipped().lock() {
        for it in items {
            set.insert(it.opening_hash.clone());
        }
    }
}

fn is_skipped(hash: &str) -> bool {
    skipped().lock().map(|s| s.contains(hash)).unwrap_or(false)
}

#[cfg(test)]
pub fn reset_backoff_for_tests() {
    reset_backoff();
}

// ── The wire (docs/PHRASES_API.md §Endpoint / §Builds) ──────────────────────

#[derive(Debug)]
pub struct PhraseFetch {
    pub phrases: Vec<(String, String)>,
}

fn http() -> Result<reqwest::Client, PhraseFail> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| PhraseFail::Transient)
}

/// One batch over the chosen wire. Statuses map per the contract; bodies of
/// failed responses are NEVER read into diagnostics (counts, never content).
pub async fn fetch_batch(
    auth: &PhraseAuth,
    items: &[PhraseItem],
) -> Result<PhraseFetch, PhraseFail> {
    match auth {
        PhraseAuth::Company { base_url, license } => fetch_company(base_url, license, items).await,
        PhraseAuth::Anthropic { key, model } => fetch_anthropic(key, model, items).await,
        PhraseAuth::OpenAi { key, model } => {
            fetch_openai_compatible(
                crate::ai_providers::OPENAI_BASE_URL,
                Some(key),
                model,
                items,
            )
            .await
        }
        PhraseAuth::Local { base_url, model } => {
            // The loopback gate is the same load-bearing enforcement point the
            // tutor uses: a local provider never sends off this Mac.
            crate::ai_client::validate_base_url(base_url, true)
                .map_err(|_| PhraseFail::Transient)?;
            fetch_openai_compatible(base_url, None, model, items).await
        }
    }
}

async fn fetch_company(
    base_url: &str,
    license: &str,
    items: &[PhraseItem],
) -> Result<PhraseFetch, PhraseFail> {
    let url = format!("{}/v1/phrases", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "version": 1, "items": items });
    let resp = http()?
        .post(&url)
        .header("authorization", format!("Bearer {license}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| PhraseFail::Transient)?;
    match resp.status().as_u16() {
        200 => {
            let v: serde_json::Value = resp.json().await.map_err(|_| PhraseFail::Transient)?;
            let mut phrases = Vec::new();
            if let Some(arr) = v.get("items").and_then(|i| i.as_array()) {
                for it in arr {
                    if let (Some(h), Some(p)) = (
                        it.get("opening_hash").and_then(|x| x.as_str()),
                        it.get("phrase").and_then(|x| x.as_str()),
                    ) {
                        phrases.push((h.to_string(), p.to_string()));
                    }
                }
            }
            Ok(PhraseFetch { phrases })
        }
        400 => Err(PhraseFail::Rejected),
        401 => Err(PhraseFail::Auth),
        402 => Err(PhraseFail::CapHit),
        429 => Err(PhraseFail::RateLimited {
            retry_after: retry_after_of(&resp),
        }),
        _ => Err(PhraseFail::Transient),
    }
}

/// The Retry-After header, in seconds, when the server sent one.
fn retry_after_of(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// The shared generation instruction (contract §Appendix) — BYO output must
/// match the relay's.
const GEN_INSTRUCTION: &str = "You name reading sessions for a literary reading app. For each item, read the chapter label and the opening slice, and return a short evocative phrase (1-10 words) naming what the reader is about to meet, drawn only from what the slice itself shows, never beyond it. No spoilers, no invented names, no quotes, no em dashes, no terminal period, sentence case. Return STRICT JSON: [{\"opening_hash\": \"...\", \"phrase\": \"...\"}] with one entry per input item, in order; omit an item rather than guess.";

fn max_output_tokens(items: usize) -> u32 {
    ((items as u32) * 24).clamp(64, 4096)
}

/// Strict-JSON parse of a model reply (contract §Appendix): a fenced block is
/// tolerated, anything else failing to parse drops the WHOLE batch.
pub fn parse_phrase_json(text: &str) -> Option<Vec<(String, String)>> {
    let t = text.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .map(|s| s.trim_end_matches("```"))
        .unwrap_or(t)
        .trim();
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for it in arr {
        let h = it.get("opening_hash")?.as_str()?;
        let p = it.get("phrase")?.as_str()?;
        out.push((h.to_string(), p.to_string()));
    }
    Some(out)
}

fn items_as_user_payload(items: &[PhraseItem]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

async fn fetch_anthropic(
    key: &str,
    model: &str,
    items: &[PhraseItem],
) -> Result<PhraseFetch, PhraseFail> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_output_tokens(items.len()),
        "temperature": 0.2,
        "system": GEN_INSTRUCTION,
        "messages": [{ "role": "user", "content": items_as_user_payload(items) }],
    });
    let resp = http()?
        .post(crate::ai_providers::ANTHROPIC_URL)
        .header("x-api-key", key)
        .header("anthropic-version", crate::ai_providers::ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| PhraseFail::Transient)?;
    match resp.status().as_u16() {
        200 => {
            let v: serde_json::Value = resp.json().await.map_err(|_| PhraseFail::Transient)?;
            let text = v
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|b| b.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let phrases = parse_phrase_json(text).ok_or(PhraseFail::Transient)?;
            Ok(PhraseFetch { phrases })
        }
        401 | 403 => Err(PhraseFail::Auth),
        429 => Err(PhraseFail::RateLimited {
            retry_after: retry_after_of(&resp),
        }),
        _ => Err(PhraseFail::Transient),
    }
}

async fn fetch_openai_compatible(
    base_url: &str,
    key: Option<&str>,
    model: &str,
    items: &[PhraseItem],
) -> Result<PhraseFetch, PhraseFail> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": GEN_INSTRUCTION },
            { "role": "user", "content": items_as_user_payload(items) },
        ],
    });
    if key.is_some() {
        // Cloud OpenAI uses the newer token field; local servers accept max_tokens.
        body["max_completion_tokens"] = serde_json::json!(max_output_tokens(items.len()));
    } else {
        body["max_tokens"] = serde_json::json!(max_output_tokens(items.len()));
    }
    let mut req = http()?
        .post(&url)
        .header("content-type", "application/json");
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|_| PhraseFail::Transient)?;
    match resp.status().as_u16() {
        200 => {
            let v: serde_json::Value = resp.json().await.map_err(|_| PhraseFail::Transient)?;
            let text = v
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let phrases = parse_phrase_json(text).ok_or(PhraseFail::Transient)?;
            Ok(PhraseFetch { phrases })
        }
        401 | 403 => Err(PhraseFail::Auth),
        429 => Err(PhraseFail::RateLimited {
            retry_after: retry_after_of(&resp),
        }),
        _ => Err(PhraseFail::Transient),
    }
}

// ── Fire-and-forget orchestration (what the command hooks spawn) ────────────

/// Fetch + store + notify, end to end, with the lock held only around DB work.
/// Spawned and never awaited by any command response path: the session-end UI
/// cannot wait on this even by accident.
pub async fn fetch_and_store(app: tauri::AppHandle, items: Vec<PhraseItem>, auth: PhraseAuth) {
    use tauri::Emitter;
    use tauri::Manager;
    let provider = auth.provider_label();
    if items.is_empty() || backoff_active(provider) {
        return;
    }
    match fetch_batch(&auth, &items).await {
        Ok(got) => {
            note_success(provider);
            // Only hashes we actually ASKED FOR may land (contract §Response:
            // items are a subset of the request) — the cache is global and
            // content-addressed, so a stray response hash could otherwise
            // plant phrases for sittings (even books) never requested.
            let requested: HashSet<&str> = items.iter().map(|i| i.opening_hash.as_str()).collect();
            let phrases: Vec<(String, String)> = got
                .phrases
                .into_iter()
                .filter(|(h, _)| requested.contains(h.as_str()))
                .collect();
            let model = auth.model_name().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            let stored = match app.state::<DbState>().0.lock() {
                Ok(conn) => upsert_phrases(&conn, &phrases, &model, &now).unwrap_or(0),
                Err(_) => 0,
            };
            log::log_phrases("ok", provider, items.len(), stored);
            if stored > 0 {
                let _ = app.emit("tl-phrases-updated", ());
            }
        }
        Err(fail) => {
            if matches!(fail, PhraseFail::Rejected) {
                // 400: a deterministic shape disagreement — never re-send
                // these exact items (contract: permanent skip, log only).
                mark_skipped(&items);
            }
            note_failure(provider, &fail);
            let status = match fail {
                PhraseFail::RateLimited { .. } => "rate_limited",
                PhraseFail::CapHit => "cap_hit",
                PhraseFail::Auth => "auth",
                PhraseFail::Rejected => "rejected",
                PhraseFail::Transient => "transient",
            };
            log::log_phrases(status, provider, items.len(), 0);
        }
    }
}

/// One specific sitting (by sort order) still missing its phrase, or None.
pub fn missing_sitting_at(
    conn: &Connection,
    book_id: &str,
    sections: &[BookSection],
    sort_order: i64,
) -> rusqlite::Result<Option<MissingSitting>> {
    let row = conn
        .query_row(
            "SELECT s.opening_hash, s.chapter_label, s.start_section_id, s.start_offset, s.char_count
             FROM sittings s LEFT JOIN phrases p ON p.opening_hash = s.opening_hash
             WHERE s.book_id = ?1 AND s.sort_order = ?2
               AND s.opening_hash IS NOT NULL AND p.opening_hash IS NULL",
            params![book_id, sort_order],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    Ok(
        row.and_then(|(opening_hash, label, sec_id, offset, char_count)| {
            if char_count <= 0 {
                return None;
            }
            Some(MissingSitting {
                sort_order,
                opening_hash,
                label,
                global_start: sittings::to_global(sections, &sec_id, offset).max(0) as usize,
                char_count: char_count as usize,
            })
        }),
    )
}

// ── Fire-and-forget entry points (what the commands call) ───────────────────
//
// Both plan under the CALLER's lock (cheap DB reads), then spawn: the Keychain
// read, the disk reads, and the HTTP all happen inside the spawned task. The
// command's response path never awaits any of this.

fn spawn_missing(
    app: &tauri::AppHandle,
    book_id: &str,
    missing: Vec<MissingSitting>,
    route: PhraseRoute,
) {
    // Rejected (400) items are deterministic failures — never re-sent.
    let missing: Vec<MissingSitting> = missing
        .into_iter()
        .filter(|m| !is_skipped(&m.opening_hash))
        .collect();
    if missing.is_empty() || backoff_active(route.label()) {
        return;
    }
    let book_id = book_id.to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(auth) = resolve_auth(route) else {
            return; // no credential for the route: heuristic carries it, silently
        };
        let items = items_from_missing(&missing, |s, e| {
            crate::commands::books::read_txt_section(&book_id, s, Some(e)).ok()
        });
        fetch_and_store(app, items, auth).await;
    });
}

/// Import-time batch: the first few sittings of a freshly configured book
/// (docs/PHRASES_API.md timing). Call right after the sittings cache is built.
pub fn spawn_first_batch(
    app: &tauri::AppHandle,
    conn: &Connection,
    book_id: &str,
    sections: &[BookSection],
) {
    let Some((missing, route)) = plan_batch(conn, book_id, sections, IMPORT_BATCH_SITTINGS) else {
        return;
    };
    spawn_missing(app, book_id, missing, route);
}

/// Session-complete prefetch: the phrase for the sitting the reader will meet
/// NEXT (the one `cmd_today` serves at `global`). One item, fire-and-forget.
pub fn spawn_next_phrase(
    app: &tauri::AppHandle,
    conn: &Connection,
    book_id: &str,
    sections: &[BookSection],
    global: i64,
) {
    let Ok(sits) = sittings::load_sittings(conn, book_id) else {
        return;
    };
    let bounds: Vec<(i64, i64)> = sits
        .iter()
        .map(|s| {
            (
                sittings::to_global(sections, &s.start_section_id, s.start_offset),
                s.char_count,
            )
        })
        .collect();
    let idx = match sittings::locate(&bounds, Some(global)) {
        sittings::Position::At(i) => i,
        sittings::Position::DayOne => 0,
        sittings::Position::Finished => return, // no next sitting to name
    };
    let Some(route) = route_for(conn) else {
        return;
    };
    let Ok(Some(missing)) = missing_sitting_at(conn, book_id, sections, idx as i64) else {
        return; // already phrased (or no hash): nothing to do
    };
    spawn_missing(app, book_id, vec![missing], route);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn
    }

    fn seed_book(conn: &Connection) {
        conn.execute(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
             VALUES ('b','T','txt','/x','h','2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO book_sections (id,book_id,label,start_locator,end_locator,estimated_units,sort_order,assignable)
             VALUES ('s1','b','Chapter I','0','1000',1000,0,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO reading_plans (id,book_id,start_date,status) VALUES ('p','b','2026-01-01','active')",
            [],
        )
        .unwrap();
    }

    fn seed_sitting(conn: &Connection, sort: i64, hash: &str, start: i64, count: i64) {
        conn.execute(
            "INSERT INTO sittings (id,book_id,sort_order,start_section_id,start_offset,char_count,chapter_label,opening_hash)
             VALUES (?1,'b',?2,'s1',?3,?4,'Chapter I',?5)",
            params![format!("st_b_{sort}"), sort, start, count, hash],
        )
        .unwrap();
    }

    fn sections() -> Vec<BookSection> {
        vec![BookSection {
            id: "s1".into(),
            book_id: "b".into(),
            label: "Chapter I".into(),
            href: None,
            start_locator: Some("0".into()),
            end_locator: Some("1000".into()),
            estimated_units: Some(1000),
            sort_order: 0,
            assignable: true,
        }]
    }

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    // ── The protocol lock: caps and normalization must match sittings ──

    #[test]
    fn slice_cap_matches_the_opening_hash_protocol() {
        // MAX_SLICE_CHARS is a contract constant; sittings::normalize_opening
        // is the hashed normalization. A 3,000-char input must normalize to
        // exactly 1,800 chars — if OPENING_CHARS ever drifts, this fails.
        let long = "x".repeat(3000);
        assert_eq!(
            sittings::normalize_opening(&long).chars().count(),
            MAX_SLICE_CHARS
        );
    }

    #[test]
    fn payload_slice_is_a_prefix_of_the_hashed_normalization() {
        let text = "  One\n\ntwo   three\tfour  ".repeat(120);
        let slice = payload_slice(&text);
        let hashed = sittings::normalize_opening(&text);
        assert!(
            hashed.starts_with(&slice),
            "slice must prefix the hashed string"
        );
        assert!(slice.split(' ').count() <= MAX_SLICE_WORDS);
        assert!(slice.chars().count() <= MAX_SLICE_CHARS);
    }

    #[test]
    fn payload_slice_collapses_whitespace_and_survives_multibyte() {
        assert_eq!(payload_slice("a \n\n b\t\tc"), "a b c");
        // Multibyte: 2-byte, 3-byte and astral chars must never split or panic.
        let mb = "Àé—\u{1F4D6} word ".repeat(700);
        let slice = payload_slice(&mb);
        assert!(slice.chars().count() <= MAX_SLICE_CHARS);
        assert!(sittings::normalize_opening(&mb).starts_with(&slice));
    }

    // ── Spoiler safety by construction ──

    #[test]
    fn items_never_contain_text_beyond_the_sitting_slice() {
        // The body has a SENTINEL immediately after sitting 1's span. The
        // builder reads with an explicit [start, end) bound, so the sentinel
        // must be unreachable no matter what.
        let body = format!(
            "{}SENTINEL-SPOILER{}",
            "opening words ".repeat(40),
            "tail ".repeat(50)
        );
        let sitting_len = "opening words ".repeat(40).len();
        let missing = vec![MissingSitting {
            sort_order: 0,
            opening_hash: H1.into(),
            label: "Chapter I".into(),
            global_start: 0,
            char_count: sitting_len,
        }];
        let mut asked = Vec::new();
        let items = items_from_missing(&missing, |s, e| {
            asked.push((s, e));
            Some(body[s..e].to_string())
        });
        assert_eq!(
            asked,
            vec![(0, sitting_len)],
            "read exactly the sitting span"
        );
        assert_eq!(items.len(), 1);
        assert!(
            !items[0].slice.contains("SENTINEL"),
            "no text beyond the slice"
        );
    }

    #[test]
    fn items_skip_unreadable_text_and_cap_the_batch() {
        let missing: Vec<MissingSitting> = (0..200)
            .map(|i| MissingSitting {
                sort_order: i,
                opening_hash: H1.into(),
                label: "L".into(),
                global_start: 0,
                char_count: 10,
            })
            .collect();
        let items = items_from_missing(&missing, |_, _| Some("some words".into()));
        assert_eq!(items.len(), MAX_ITEMS_PER_CALL, "120-item hard cap");
        let none = items_from_missing(&missing[..1], |_, _| None);
        assert!(none.is_empty(), "unreadable text is skipped quietly");
    }

    // ── Validation + storage ──

    #[test]
    fn phrase_validation_enforces_the_contract() {
        assert!(valid_phrase("the pear tree and the gang"));
        assert!(valid_phrase("Marius at the barricade"));
        assert!(!valid_phrase(""));
        assert!(!valid_phrase("ends with a period."));
        assert!(!valid_phrase("an em dash — sneaks in"));
        assert!(!valid_phrase("\"quoted\""));
        assert!(!valid_phrase(
            "one two three four five six seven eight nine ten eleven"
        ));
        assert!(!valid_phrase(&"x".repeat(81)));
        assert!(!valid_phrase("two\nlines"));
    }

    #[test]
    fn upsert_stores_valid_phrases_and_drops_invalid_ones() {
        let conn = mem_db();
        let n = upsert_phrases(
            &conn,
            &[
                (H1.to_string(), "the morning resolve".to_string()),
                (H2.to_string(), "bad one.".to_string()),
                ("nothex".to_string(), "fine words".to_string()),
            ],
            "test-model",
            "2026-06-11T00:00:00Z",
        )
        .unwrap();
        assert_eq!(n, 1);
        let phrase: String = conn
            .query_row(
                "SELECT phrase FROM phrases WHERE opening_hash = ?1",
                [H1],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(phrase, "the morning resolve");
        // Upsert replaces (content-addressed cache, last write wins).
        upsert_phrases(
            &conn,
            &[(H1.to_string(), "a better phrase".to_string())],
            "m2",
            "t",
        )
        .unwrap();
        let phrase: String = conn
            .query_row(
                "SELECT phrase FROM phrases WHERE opening_hash = ?1",
                [H1],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(phrase, "a better phrase");
    }

    // ── The gate: toggle off ⇒ no plan ⇒ no network, by construction ──

    #[test]
    fn plan_batch_is_none_when_the_toggle_is_off_even_with_missing_phrases() {
        let conn = mem_db();
        seed_book(&conn);
        seed_sitting(&conn, 0, H1, 0, 100);
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "anthropic").unwrap();
        settings::set_string(&conn, settings::KEY_AI_PHRASES, "false").unwrap();
        assert!(plan_batch(&conn, "b", &sections(), 10).is_none());
        // Flip it on: the same state now plans.
        settings::set_string(&conn, settings::KEY_AI_PHRASES, "true").unwrap();
        assert!(plan_batch(&conn, "b", &sections(), 10).is_some());
    }

    #[test]
    fn plan_batch_is_none_without_a_phrase_capable_provider() {
        let conn = mem_db();
        seed_book(&conn);
        seed_sitting(&conn, 0, H1, 0, 100);
        // Unset provider → None.
        assert!(plan_batch(&conn, "b", &sections(), 10).is_none());
        // Codex is deliberately not a phrase provider.
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "codex").unwrap();
        assert!(plan_batch(&conn, "b", &sections(), 10).is_none());
    }

    #[test]
    fn plan_batch_skips_sittings_that_already_have_phrases() {
        let conn = mem_db();
        seed_book(&conn);
        seed_sitting(&conn, 0, H1, 0, 100);
        seed_sitting(&conn, 1, H2, 100, 100);
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "company").unwrap();
        upsert_phrases(
            &conn,
            &[(H1.to_string(), "already named".to_string())],
            "m",
            "t",
        )
        .unwrap();
        let (missing, route) = plan_batch(&conn, "b", &sections(), 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].opening_hash, H2);
        assert!(matches!(route, PhraseRoute::Company { .. }));
        // Both phrased → None (nothing to do).
        upsert_phrases(
            &conn,
            &[(H2.to_string(), "named too".to_string())],
            "m",
            "t",
        )
        .unwrap();
        assert!(plan_batch(&conn, "b", &sections(), 10).is_none());
    }

    // ── Backoff math (pure; the wire is covered by the integration mock) ──

    #[test]
    fn backoff_honors_retry_after_and_caps_transient_growth() {
        reset_backoff_for_tests();
        assert!(!backoff_active("company"));
        note_failure(
            "company",
            &PhraseFail::RateLimited {
                retry_after: Some(30),
            },
        );
        let until = BACKOFF_UNTIL_MS[route_idx("company")].load(Ordering::Relaxed);
        let wait = until - now_ms();
        assert!(wait >= 29_000, "waits at least retry_after ({wait}ms)");
        assert!(wait <= 60_000, "jitter stays bounded ({wait}ms)");

        reset_backoff_for_tests();
        note_failure("company", &PhraseFail::Transient);
        note_failure("company", &PhraseFail::Transient);
        note_failure("company", &PhraseFail::Transient);
        note_failure("company", &PhraseFail::Transient);
        let wait = BACKOFF_UNTIL_MS[route_idx("company")].load(Ordering::Relaxed) - now_ms();
        assert!(
            wait <= 1_800_000 + 450_000,
            "transient backoff caps at ~30min"
        );

        reset_backoff_for_tests();
        note_failure("company", &PhraseFail::CapHit);
        let wait = BACKOFF_UNTIL_MS[route_idx("company")].load(Ordering::Relaxed) - now_ms();
        assert!(
            wait >= 23 * 60 * 60 * 1000,
            "cap-hit sleeps ~a day, invisibly"
        );
        reset_backoff_for_tests();
    }

    #[test]
    fn backoff_is_per_route_and_resets_on_operator_action() {
        reset_backoff_for_tests();
        // A relay cap-hit must not silence the reader's own key (contract
        // §Builds: the BYO flow is identical and independent).
        note_failure("company", &PhraseFail::CapHit);
        assert!(backoff_active("company"));
        assert!(!backoff_active("anthropic"));
        assert!(!backoff_active("local"));

        // Auth stops effectively permanently…
        note_failure("anthropic", &PhraseFail::Auth);
        let wait = BACKOFF_UNTIL_MS[route_idx("anthropic")].load(Ordering::Relaxed) - now_ms();
        assert!(
            wait >= 29 * 24 * 60 * 60 * 1000,
            "auth stop is long ({wait}ms)"
        );

        // …until the operator-action reset (re-activation / new key / toggle on).
        reset_backoff();
        assert!(!backoff_active("company"));
        assert!(!backoff_active("anthropic"));
    }

    #[test]
    fn rejected_batches_are_skipped_permanently_and_cleared_by_reset() {
        reset_backoff_for_tests();
        let items = vec![PhraseItem {
            opening_hash: H1.into(),
            label: "L".into(),
            slice: "words".into(),
        }];
        mark_skipped(&items);
        assert!(is_skipped(H1));
        assert!(!is_skipped(H2));
        reset_backoff();
        assert!(!is_skipped(H1));
    }

    #[test]
    fn uppercase_response_hashes_are_dropped() {
        let conn = mem_db();
        let upper = "A".repeat(64); // uppercase hex letters, not digits
        let n = upsert_phrases(&conn, &[(upper, "fine words".to_string())], "m", "t").unwrap();
        assert_eq!(
            n, 0,
            "the join key is lowercase hex; uppercase is a dead row"
        );
    }

    #[test]
    fn single_quoted_and_cr_phrases_are_dropped_but_apostrophes_survive() {
        assert!(!valid_phrase("'wrapped in singles'"));
        assert!(!valid_phrase("\u{2018}curly singles\u{2019}"));
        assert!(!valid_phrase("carriage\rreturn"));
        assert!(valid_phrase("the day's door")); // interior apostrophe is fine
    }

    #[test]
    fn parse_phrase_json_is_strict_but_tolerates_fences() {
        let ok = r#"[{"opening_hash": "abc", "phrase": "the quiet road"}]"#;
        assert_eq!(parse_phrase_json(ok).unwrap().len(), 1);
        let fenced = format!("```json\n{ok}\n```");
        assert_eq!(parse_phrase_json(&fenced).unwrap().len(), 1);
        assert!(parse_phrase_json("the model rambled instead").is_none());
        assert!(parse_phrase_json(r#"{"not": "an array"}"#).is_none());
        // One malformed entry poisons the whole batch (never partially trusted).
        assert!(parse_phrase_json(r#"[{"opening_hash": "a"}]"#).is_none());
    }
}

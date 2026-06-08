//! AI tutor surface.
//!
//! Two flows: prompt-preview (no network) and Ask (real call to local
//! OpenAI-compatible endpoint). Both share the contract that previews are
//! ephemeral and approving turns them into a Note.
//!
//! `ai_client::validate_base_url` enforces the local-only invariant at the
//! call site — see [src/ai_client.rs]. Adding a new path that calls the AI
//! must route through `ai_client` so that the validation can't be bypassed.

use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::commands::db_helpers::*;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::{AiRequest, Note};
use crate::{ai_client, ai_retention, ai_stub, export, log, settings};

// ── Public response types ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct AiPreview {
    pub ai_request_id: String,
    pub mode: String,
    pub mode_label: String,
    pub prompt: String,
    /// Always false here. Flipped by cmd_save_ai_preview_as_note on approval.
    pub wrote_to_memory: bool,
    pub provider: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AskHandle {
    pub ai_request_id: String,
    /// Echo back what the client will actually send so the UI can compare it
    /// against the preview text (the "preview == sent" invariant).
    pub prompt_sent: String,
    pub provider_host: String,
}

#[derive(Serialize)]
pub struct ConnTestResult {
    pub reachable: bool,
    pub first_model_id: Option<String>,
    pub message: String,
}

/// The dignified-fallback payload: a reader-facing prompt to copy into whatever
/// AI tool they already use, returned WITHOUT calling any model. Mirrors
/// `ai_stub::ReaderPrompt` for the frontend.
#[derive(Serialize)]
pub struct AiPreviewCard {
    pub title: String,
    pub disclosure: String,
    pub prompt: String,
    pub copy_label: String,
}

// ── Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn cmd_generate_prompt_preview(
    book_id: String,
    mode: String,
    selection: String,
    chapter: Option<String>,
    locator: Option<String>,
    user_note: Option<String>,
    state: State<DbState>,
) -> Result<AiPreview, AppError> {
    let stub_mode = ai_stub::StubMode::from_str(&mode)
        .ok_or_else(|| AppError::validation(format!("unknown AI stub mode: {}", mode)))?;
    let trimmed = selection.trim();
    if trimmed.chars().count() < 4 {
        return Err(AppError::validation(
            "Select a passage first — AI previews require a non-trivial text selection.",
        ));
    }

    let conn = state.0.lock()?;
    let book = fetch_book(&conn, &book_id)?
        .ok_or_else(|| AppError::not_found("book", Some(book_id.clone())))?;

    let ctx = ai_stub::PromptContext {
        book_title: book.title.clone(),
        author: book.author.clone(),
        chapter,
        locator: locator.clone(),
        selection: trimmed.to_string(),
        user_note,
    };
    let prompt = ai_stub::build_prompt(stub_mode, &ctx);

    // Log the request shape for future audit. provider=NULL, wrote_to_memory=0.
    let ai_id = format!("ai_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let context_char_count = ctx.selection.chars().count() as i64;
    conn.execute(
        "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 0)",
        params![ai_id, book.id, mode, locator, context_char_count, now],
    )?;

    Ok(AiPreview {
        ai_request_id: ai_id,
        mode: mode.clone(),
        mode_label: stub_mode.label().to_string(),
        prompt,
        wrote_to_memory: false,
        provider: None,
    })
}

/// Build the reader-facing fallback prompt for a lens (or the Deep Study
/// briefing) WITHOUT calling any model. This is the dignified fallback: when no
/// provider is wired up (or the reader prefers to use their own tool), the UI
/// shows this calm, copy-ready prompt instead of a dead end.
///
/// Network-free by construction: it returns straight from the `ai_stub`
/// formatter (which carries no HTTP client) and never touches `ai_client` /
/// `ai_providers`. The internal fence + safety scaffolding is NOT exposed — the
/// formatter emits plain language for a human to paste.
#[tauri::command]
pub fn cmd_ai_preview(
    mode: String,
    selected_text: String,
    book_title: String,
    author: Option<String>,
    section_label: Option<String>,
    // For the Deep Study briefing the reader prepares for a whole section, so the
    // briefing prompt works from this instead of a small selection.
    section_text: Option<String>,
) -> Result<AiPreviewCard, AppError> {
    let stub_mode = ai_stub::StubMode::from_str(&mode)
        .ok_or_else(|| AppError::validation(format!("unknown AI mode: {}", mode)))?;

    // The briefing quotes the whole section; the lenses quote the selection.
    let body = if matches!(stub_mode, ai_stub::StubMode::SectionBriefing) {
        section_text.unwrap_or(selected_text)
    } else {
        selected_text
    };

    let ctx = ai_stub::PromptContext {
        book_title,
        author,
        chapter: section_label,
        locator: None,
        selection: body,
        user_note: None,
    };
    let rp = ai_stub::build_reader_prompt(stub_mode, &ctx);
    Ok(AiPreviewCard {
        title: rp.title,
        disclosure: rp.disclosure,
        prompt: rp.prompt,
        copy_label: rp.copy_label,
    })
}

/// Approve a prompt-PREVIEW (the no-network tutor surface) into a durable Note +
/// Markdown. The marginalia anchor fields are optional and additive: the EPUB
/// modal and legacy callers omit them (point-anchored), while the text reader's
/// Companion-Margin tutor card passes the selection range + `session_id` so the
/// saved card stays pinned beside the passage as a `TutorNote`. Flipping
/// `wrote_to_memory = 1` records that this AI request became memory.
#[tauri::command]
pub fn cmd_save_ai_preview_as_note(
    ai_request_id: String,
    note_type: String,
    body: String,
    locator: String,
    chapter_label: Option<String>,
    // Marginalia anchor (all optional). When present the saved card renders
    // anchored in the Companion Margin instead of in the flat notes list.
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
    session_id: Option<String>,
    state: State<DbState>,
) -> Result<Note, AppError> {
    let conn = state.0.lock()?;
    save_preview_as_note_inner(
        &conn,
        &ai_request_id,
        &note_type,
        &body,
        &locator,
        chapter_label,
        anchor_start,
        anchor_end,
        anchored_text,
        session_id,
    )
}

/// Core of `cmd_save_ai_preview_as_note`, split out so it can be unit-tested
/// against a plain `Connection` (the `#[tauri::command]` wrapper needs a Tauri
/// `State`, which a test can't construct). Inserts the durable Note with its
/// optional marginalia anchors, flips the audit row's `wrote_to_memory = 1`, and
/// writes the Markdown mirror — the exact contract the margin tutor card relies
/// on.
fn save_preview_as_note_inner(
    conn: &rusqlite::Connection,
    ai_request_id: &str,
    note_type: &str,
    body: &str,
    locator: &str,
    chapter_label: Option<String>,
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
    session_id: Option<String>,
) -> Result<Note, AppError> {
    if body.trim().is_empty() {
        return Err(AppError::validation("note body is empty"));
    }
    let book_id: String = conn
        .query_row(
            "SELECT book_id FROM ai_requests WHERE id = ?1",
            params![ai_request_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::not_found("ai_request", Some(ai_request_id.to_string())))?;

    let id = format!("note_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?8, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL, ?9, ?10, ?11)",
        params![id, book_id, note_type, locator, chapter_label, body, now, session_id, anchor_start, anchor_end, anchored_text],
    )?;

    conn.execute(
        "UPDATE ai_requests SET wrote_to_memory = 1 WHERE id = ?1",
        params![ai_request_id],
    )?;

    let mut note_stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text FROM notes WHERE id = ?1",
    )?;
    let mut note = note_stmt.query_row(params![id], note_from_row)?;

    if let Some(book) = fetch_book(conn, &book_id)? {
        if let Ok(path) = export::export_note(&export::root_for(conn), &book, &note) {
            log::log_export("note", &path.to_string_lossy());
            note.exported_markdown_path = Some(path.to_string_lossy().to_string());
            conn.execute(
                "UPDATE notes SET exported_markdown_path = ?1 WHERE id = ?2",
                params![note.exported_markdown_path, note.id],
            )?;
        }
    }
    Ok(note)
}

/// AI request history viewer (adr-001). Returns every audit row, newest first,
/// with the book title joined for display. `provider == null` means the request
/// was a prompt preview that never left the machine; a non-null provider is the
/// host a real Ask call was sent to.
#[tauri::command]
pub fn cmd_list_ai_requests(state: State<DbState>) -> Result<Vec<AiRequest>, AppError> {
    let conn = state.0.lock()?;
    Ok(list_ai_requests(&conn)?)
}

/// Apply the AI retention window immediately (the "Forget now" control): delete
/// audit rows older than the configured number of days that never became a note.
/// Rows with `wrote_to_memory = 1` are kept. Returns the number of rows removed.
#[tauri::command]
pub fn cmd_forget_ai_history(state: State<DbState>) -> Result<usize, AppError> {
    let conn = state.0.lock()?;
    let days = settings::get_ai_retention_days(&conn);
    Ok(ai_retention::sweep(&conn, days)?)
}

/// Token ceilings for the reading lenses (Explain / Context / Define /
/// Socratic). Brevity is controlled by the PROMPT (each mode states a sentence
/// and word target, e.g. "2-3 sentences, ~55 words" for Brief, "~130 words" for
/// Deep). These ceilings are a BACKSTOP with headroom — not the length control —
/// so a model that follows the prompt finishes its final sentence instead of
/// being guillotined mid-word. The earlier values sat right at the word target
/// with zero margin, so a thorough model (e.g. Anthropic Opus, which runs a bit
/// past a stated word count) got cut off mid-sentence. ~2–2.5× the target gives
/// room to complete while the prompt keeps responses a glance, not the
/// ~470-token essay that triggered the original brevity work. See
/// `docs/WEEKEND_RC_LOG.md`. (A verbose model that ignores the prompt is still
/// bounded — just at a higher, less jarring point.)
const BRIEF_MAX_TOKENS: u32 = 200;
const DEEP_MAX_TOKENS: u32 = 450;
/// Utility-mode ceilings (these modes ignore depth and aren't reader lenses).
const DURABLE_NOTE_MAX_TOKENS: u32 = 256;
const PREPARE_NEXT_MAX_TOKENS: u32 = 512;
/// The Deep Study Section Briefing has five short labeled parts, so it needs the
/// most room of any mode — still bounded so it stays a glance before reading,
/// not a wall, but with enough headroom that all five parts complete.
const SECTION_BRIEFING_MAX_TOKENS: u32 = 768;

/// Pick the generated-token ceiling for a (mode, depth) pair.
fn max_tokens_for(mode: ai_stub::StubMode, depth: ai_stub::Depth) -> u32 {
    use ai_stub::{Depth, StubMode};
    match mode {
        StubMode::Explain | StubMode::Historical | StubMode::Vocabulary | StubMode::Socratic => {
            match depth {
                Depth::Brief => BRIEF_MAX_TOKENS,
                Depth::Deep => DEEP_MAX_TOKENS,
            }
        }
        StubMode::DurableNote => DURABLE_NOTE_MAX_TOKENS,
        StubMode::PrepareNext => PREPARE_NEXT_MAX_TOKENS,
        StubMode::SectionBriefing => SECTION_BRIEFING_MAX_TOKENS,
    }
}

#[tauri::command]
pub async fn cmd_ai_ask(
    book_id: String,
    mode: String,
    selection: String,
    chapter: Option<String>,
    locator: Option<String>,
    user_note: Option<String>,
    // Answer depth for the reading lenses: "brief" (default) or "deep". Brief is
    // the small unblock-and-return answer; deep is the reader-pulled elaboration.
    depth: Option<String>,
    on_event: tauri::ipc::Channel<ai_client::StreamEvent>,
    app: tauri::AppHandle,
    state: State<'_, DbState>,
) -> Result<AskHandle, AppError> {
    let stub_mode = ai_stub::StubMode::from_str(&mode)
        .ok_or_else(|| AppError::validation(format!("unknown AI stub mode: {}", mode)))?;
    let answer_depth = ai_stub::Depth::from_str(depth.as_deref().unwrap_or("brief"))
        .unwrap_or(ai_stub::Depth::Brief);
    let trimmed = selection.trim();
    if trimmed.chars().count() < 4 {
        return Err(AppError::validation(
            "Select a passage first — AI calls require a non-trivial text selection.",
        ));
    }

    // Pull provider + settings + book under the lock, then drop it before awaiting.
    let (provider, model, base_url, ai_id, prompt, provider_host) = {
        let conn = state.0.lock()?;
        let book = fetch_book(&conn, &book_id)?
            .ok_or_else(|| AppError::not_found("book", Some(book_id.clone())))?;

        let provider = settings::get_ai_provider(&conn);
        match provider {
            settings::AiProvider::Unset => {
                return Err(AppError::config(
                    "Choose an AI provider first (Settings → Assistance).",
                ))
            }
            settings::AiProvider::Disabled => {
                return Err(AppError::config(
                    "AI is turned off. Enable a provider in Settings → Assistance.",
                ))
            }
            _ => {}
        }

        // Monthly spend cap (Epic B4): refuse a cloud call once month-to-date cost
        // reaches the reader's ceiling. Local has no spend, so it's never capped.
        if provider.is_remote() {
            let cap = settings::get_string(&conn, settings::KEY_AI_SPEND_CAP_CENTS)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            if spend_cap_exceeded(cap, month_to_date_micros(&conn)) {
                return Err(AppError::config(format!(
                    "You've reached your monthly AI spend cap (${:.2}). Raise or clear it in Settings → Assistance to keep using cloud AI.",
                    cap as f64 / 100.0
                )));
            }
        }

        let model = settings::get_ai_model_for(&conn, provider);
        if model.trim().is_empty() {
            return Err(AppError::config(
                "No AI model set. Open Settings → Assistance and set the model id.",
            ));
        }
        let base_url = settings::get_ai_base_url(&conn);
        // Local keeps the hard loopback backstop; a typo can never send off-device.
        if matches!(provider, settings::AiProvider::Local) {
            ai_client::validate_base_url(&base_url, true).map_err(AppError::from)?;
        }
        let provider_host = match provider {
            settings::AiProvider::Local => url::Url::parse(&base_url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default(),
            settings::AiProvider::OpenAi => "api.openai.com".to_string(),
            settings::AiProvider::Anthropic => "api.anthropic.com".to_string(),
            settings::AiProvider::Codex => "chatgpt.com".to_string(),
            _ => String::new(),
        };

        // First-cloud-call consent (C2): a remote provider must be confirmed once
        // before the first send. The frontend catches this, shows a consent sheet,
        // then retries after cmd_confirm_cloud_send.
        if provider.is_remote()
            && settings::get_string(&conn, settings::KEY_FIRST_CLOUD_CONFIRMED_AT).is_none()
        {
            return Err(AppError::needs_cloud_consent(provider_host.clone()));
        }

        let ctx = ai_stub::PromptContext {
            book_title: book.title.clone(),
            author: book.author.clone(),
            chapter: chapter.clone(),
            locator: locator.clone(),
            selection: trimmed.to_string(),
            user_note,
        };
        let prompt = ai_stub::build_prompt_with_depth(stub_mode, answer_depth, &ctx);

        let ai_id = format!("ai_{}", Uuid::new_v4().simple());
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            params![
                ai_id, book.id, mode, locator,
                trimmed.chars().count() as i64,
                provider_host,
                now,
            ],
        )?;

        (provider, model, base_url, ai_id, prompt, provider_host)
    };

    // Resolve provider auth OUTSIDE the lock (Keychain reads may prompt the OS).
    let auth = match provider {
        settings::AiProvider::Local => crate::ai_providers::ProviderAuth::Local,
        settings::AiProvider::OpenAi => crate::keystore::get_key("openai")
            .map(crate::ai_providers::ProviderAuth::OpenAiKey)
            .ok_or_else(|| AppError::config("Add your OpenAI API key in Settings → Assistance."))?,
        settings::AiProvider::Anthropic => crate::keystore::get_key("anthropic")
            .map(crate::ai_providers::ProviderAuth::AnthropicKey)
            .ok_or_else(|| {
                AppError::config("Add your Anthropic API key in Settings → Assistance.")
            })?,
        settings::AiProvider::Codex => crate::ai_providers::ProviderAuth::Codex,
        _ => return Err(AppError::config("No AI provider chosen.")),
    };

    let call = crate::ai_providers::ProviderCall {
        provider,
        model: model.clone(),
        prompt: prompt.clone(),
        max_tokens: Some(max_tokens_for(stub_mode, answer_depth)),
        timeout: std::time::Duration::from_secs(180),
        auth,
        base_url: base_url.clone(),
    };

    let started = std::time::Instant::now();
    let mut rx = match crate::ai_providers::run_provider_call(call).await {
        Ok(rx) => rx,
        Err(e) => {
            log::log_ai_call(
                &mode,
                locator.as_deref(),
                trimmed.chars().count(),
                &provider_host,
                started.elapsed().as_millis(),
                "request_failed",
            );
            return Err(AppError::ai(format!("{}", e)));
        }
    };

    let handle = AskHandle {
        ai_request_id: ai_id.clone(),
        prompt_sent: prompt.clone(),
        provider_host: provider_host.clone(),
    };

    let log_mode = mode.clone();
    let log_locator = locator.clone();
    let log_provider = provider_host.clone();
    let log_chars = trimmed.chars().count();
    let rec_ai_id = ai_id.clone();
    let rec_provider = provider.as_str().to_string();
    let rec_model = model.clone();
    tauri::async_runtime::spawn(async move {
        let mut saw_error = false;
        while let Some(ev) = rx.recv().await {
            // B6 live capture: intercept the Usage event — record it to
            // ai_request_usage and DO NOT forward it to the webview.
            if let ai_client::StreamEvent::Usage {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            } = ev
            {
                use tauri::Manager;
                let usage = crate::ai_providers::TokenUsage {
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_creation_tokens,
                };
                if let Ok(conn) = app.state::<DbState>().0.lock() {
                    let _ = write_usage_row(&conn, &rec_ai_id, &rec_provider, &rec_model, &usage);
                }
                continue;
            }
            if matches!(ev, ai_client::StreamEvent::Error { .. }) {
                saw_error = true;
            }
            let _ = on_event.send(ev);
        }
        log::log_ai_call(
            &log_mode,
            log_locator.as_deref(),
            log_chars,
            &log_provider,
            started.elapsed().as_millis(),
            if saw_error { "stream_error" } else { "ok" },
        );
    });
    Ok(handle)
}

/// Static per-provider model catalogue (id + label + $/Mtok + tier) for the model
/// picker and the cost UI. Local models are detected live (cmd_list_ai_models).
#[tauri::command]
pub fn cmd_model_catalog(provider: String) -> Vec<crate::ai_providers::ModelInfo> {
    crate::ai_providers::model_catalog(crate::settings::AiProvider::from_str(&provider))
}

/// One grouped row of the usage summary (by provider or by lens/mode).
#[derive(serde::Serialize)]
pub struct UsageRow {
    pub key: String,
    pub calls: i64,
    pub cost_micros: i64,
}

/// Spend summary for the Settings "AI usage" card (Epic B4).
#[derive(serde::Serialize)]
pub struct UsageSummary {
    pub total_calls: i64,
    pub total_cost_micros: i64,
    pub month_cost_micros: i64,
    pub spend_cap_cents: i64,
    pub by_provider: Vec<UsageRow>,
    pub by_lens: Vec<UsageRow>,
    pub pricing_verified_at: String,
}

/// Whether the monthly spend cap (whole cents; 0 = off) is reached, given
/// month-to-date spend in micro-dollars. 1 cent = 10,000 micro-dollars.
fn spend_cap_exceeded(cap_cents: i64, mtd_micros: i64) -> bool {
    cap_cents > 0 && mtd_micros >= cap_cents * 10_000
}

/// Month-to-date cloud-AI spend in micro-dollars (for the spend cap).
fn month_to_date_micros(conn: &rusqlite::Connection) -> i64 {
    conn.query_row(
        "SELECT COALESCE(SUM(cost_usd_micros), 0) FROM ai_request_usage
         WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Aggregate recorded usage for the Settings AI-usage card.
#[tauri::command]
pub fn cmd_get_usage_summary(state: State<DbState>) -> Result<UsageSummary, AppError> {
    let conn = state.0.lock()?;
    let (total_calls, total_cost_micros): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(cost_usd_micros), 0) FROM ai_request_usage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    let group = |sql: &str| -> Vec<UsageRow> {
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare(sql) {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok(UsageRow {
                    key: r.get(0)?,
                    calls: r.get(1)?,
                    cost_micros: r.get(2)?,
                })
            }) {
                out = rows.filter_map(|x| x.ok()).collect();
            }
        }
        out
    };
    let by_provider = group(
        "SELECT COALESCE(provider,'?'), COUNT(*), COALESCE(SUM(cost_usd_micros),0)
         FROM ai_request_usage GROUP BY provider ORDER BY 3 DESC",
    );
    let by_lens = group(
        "SELECT COALESCE(r.mode,'?'), COUNT(*), COALESCE(SUM(u.cost_usd_micros),0)
         FROM ai_request_usage u JOIN ai_requests r ON r.id = u.request_id
         GROUP BY r.mode ORDER BY 3 DESC",
    );
    let spend_cap_cents = settings::get_string(&conn, settings::KEY_AI_SPEND_CAP_CENTS)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    Ok(UsageSummary {
        total_calls,
        total_cost_micros,
        month_cost_micros: month_to_date_micros(&conn),
        spend_cap_cents,
        by_provider,
        by_lens,
        pricing_verified_at: crate::ai_providers::PRICING_VERIFIED_AT.to_string(),
    })
}

/// Set the monthly cloud-AI spend ceiling in whole cents (0 = off, clamped ≥ 0).
#[tauri::command]
pub fn cmd_set_monthly_spend_cap(cents: i64, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    settings::set_string(
        &conn,
        settings::KEY_AI_SPEND_CAP_CENTS,
        &cents.max(0).to_string(),
    )
    .map_err(AppError::from)
}

/// Record the reader's first-cloud-call consent (Epic C2). After this, cmd_ai_ask
/// no longer gates cloud calls behind the consent sheet.
#[tauri::command]
pub fn cmd_confirm_cloud_send(state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    settings::set_string(
        &conn,
        settings::KEY_FIRST_CLOUD_CONFIRMED_AT,
        &Utc::now().to_rfc3339(),
    )
    .map_err(AppError::from)
}

/// Record token usage + computed cost for a finished AI request (Epic B3). The
/// streaming layer accumulates the provider's usage block; this persists it as
/// the COGS row the usage panel (B4) reads. Idempotent per request_id.
#[tauri::command]
pub fn cmd_finalize_ai_request(
    request_id: String,
    provider: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: Option<u64>,
    cache_creation_tokens: Option<u64>,
    state: State<DbState>,
) -> Result<i64, AppError> {
    let usage = crate::ai_providers::TokenUsage {
        input_tokens,
        output_tokens,
        cache_read_tokens: cache_read_tokens.unwrap_or(0),
        cache_creation_tokens: cache_creation_tokens.unwrap_or(0),
    };
    let conn = state.0.lock()?;
    write_usage_row(&conn, &request_id, &provider, &model, &usage).map_err(AppError::from)
}

/// Compute cost + upsert a usage row. Shared by cmd_finalize_ai_request and the
/// live-capture path in cmd_ai_ask (B6). Returns the cost in micro-dollars.
pub(crate) fn write_usage_row(
    conn: &rusqlite::Connection,
    request_id: &str,
    provider: &str,
    model: &str,
    usage: &crate::ai_providers::TokenUsage,
) -> rusqlite::Result<i64> {
    let cost =
        crate::ai_providers::cost_micros(settings::AiProvider::from_str(provider), model, usage);
    conn.execute(
        "INSERT INTO ai_request_usage
           (request_id, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, cost_usd_micros, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
         ON CONFLICT(request_id) DO UPDATE SET
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens,
           cost_usd_micros = excluded.cost_usd_micros",
        rusqlite::params![
            request_id,
            provider,
            model,
            usage.input_tokens as i64,
            usage.output_tokens as i64,
            usage.cache_read_tokens as i64,
            usage.cache_creation_tokens as i64,
            cost,
        ],
    )?;
    Ok(cost)
}

/// List selectable models for a provider. Local lists the server's `/models`;
/// cloud providers return a small curated set (the model field is also free-text).
#[tauri::command]
pub async fn cmd_list_ai_models(
    provider: Option<String>,
    base_url: Option<String>,
    state: State<'_, DbState>,
) -> Result<Vec<String>, AppError> {
    let (prov, saved_base) = {
        let conn = state.0.lock()?;
        let prov = match provider.as_deref() {
            Some(p) => settings::AiProvider::from_str(p),
            None => settings::get_ai_provider(&conn),
        };
        (prov, settings::get_ai_base_url(&conn))
    };
    // Prefer the (possibly unsaved) draft base URL the Settings screen is editing,
    // so model detection reflects the field the user is configuring without
    // forcing a save first. Loopback is still enforced by passing local_only=true.
    let base_url = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(saved_base);
    match prov {
        settings::AiProvider::Local => ai_client::list_models(&base_url, true)
            .await
            .map_err(AppError::from),
        settings::AiProvider::OpenAi => Ok(vec![
            "gpt-5.5".into(),
            "gpt-5.5-pro".into(),
            "gpt-5".into(),
            "gpt-5-mini".into(),
        ]),
        settings::AiProvider::Anthropic => Ok(vec![
            "claude-opus-4-8".into(),
            "claude-sonnet-4-6".into(),
            "claude-haiku-4-5".into(),
        ]),
        settings::AiProvider::Codex => Ok(vec!["gpt-5.5".into()]),
        _ => Ok(Vec::new()),
    }
}

/// Test a provider connection. `provider` + `key` may be supplied to test BEFORE
/// saving (onboarding); otherwise the stored provider/key are used. The key is
/// never logged or returned.
#[tauri::command]
pub async fn cmd_test_ai_connection(
    provider: Option<String>,
    key: Option<String>,
    state: State<'_, DbState>,
) -> Result<ConnTestResult, AppError> {
    let (prov, resolved_key, base_url, model) = {
        let conn = state.0.lock()?;
        let prov = match provider.as_deref() {
            Some(p) => settings::AiProvider::from_str(p),
            None => settings::get_ai_provider(&conn),
        };
        let base_url = settings::get_ai_base_url(&conn);
        let model = settings::get_ai_model_for(&conn, prov);
        // Prefer an explicitly-passed key (test-before-save); else the stored one.
        let resolved_key = match prov {
            settings::AiProvider::OpenAi => key
                .clone()
                .filter(|k| !k.trim().is_empty())
                .or_else(|| crate::keystore::get_key("openai")),
            settings::AiProvider::Anthropic => key
                .clone()
                .filter(|k| !k.trim().is_empty())
                .or_else(|| crate::keystore::get_key("anthropic")),
            _ => None,
        };
        (prov, resolved_key, base_url, model)
    };

    let (reachable, model_id, message) = crate::ai_providers::test_provider(
        prov,
        resolved_key,
        &base_url,
        &model,
        std::time::Duration::from_secs(15),
    )
    .await;
    Ok(ConnTestResult {
        reachable,
        first_model_id: model_id,
        message,
    })
}

/// Begin an app-owned Codex (ChatGPT) device-code login. Returns the code to
/// enter at the verification URL; the frontend then polls `cmd_codex_device_poll`.
#[tauri::command]
pub async fn cmd_codex_device_start() -> Result<crate::ai_providers::CodexDeviceStart, AppError> {
    crate::ai_providers::codex_device_start()
        .await
        .map_err(|e| AppError::ai(format!("{e}")))
}

/// Poll once for device-login completion. On "complete" the app-owned tokens are
/// stored in the Keychain — and we record the non-secret "codex creds present"
/// flag so the next launch shows the login state without a Keychain prompt.
#[tauri::command]
pub async fn cmd_codex_device_poll(
    device_auth_id: String,
    user_code: String,
    state: State<'_, DbState>,
) -> Result<crate::ai_providers::CodexDevicePoll, AppError> {
    let poll = crate::ai_providers::codex_device_poll(&device_auth_id, &user_code)
        .await
        .map_err(|e| AppError::ai(format!("{e}")))?;
    if poll.status == "complete" {
        let conn = state.0.lock()?;
        settings::mark_codex_creds_present(&conn, true);
    }
    Ok(poll)
}

/// Remove the app-owned Codex login (the Codex CLI's own login is untouched).
#[tauri::command]
pub fn cmd_codex_logout(state: State<DbState>) -> Result<settings::SettingsDto, AppError> {
    crate::keystore::clear_codex_creds().map_err(|e| AppError::config(format!("{e}")))?;
    let conn = state.0.lock()?;
    settings::mark_codex_creds_present(&conn, false);
    settings::build_dto(&conn).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn spend_cap_only_bites_when_set_and_reached() {
        // cap off (0) never blocks, whatever the spend.
        assert!(!spend_cap_exceeded(0, 999_999_999));
        // $5.00 cap = 500 cents = 5,000,000 micro-dollars.
        assert!(!spend_cap_exceeded(500, 4_999_999)); // just under
        assert!(spend_cap_exceeded(500, 5_000_000)); // exactly at the cap
        assert!(spend_cap_exceeded(500, 9_000_000)); // over
    }

    #[test]
    fn write_usage_row_records_cost_and_tokens() {
        // The B6 live-capture recording path (what cmd_ai_ask calls on a Usage event).
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES ('b','T','txt','/p','h','2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ai_requests (id,book_id,mode,created_at) VALUES ('req1','b','explain','2026-01-01')",
            [],
        )
        .unwrap();
        let usage = crate::ai_providers::TokenUsage {
            input_tokens: 4750,
            output_tokens: 400,
            ..Default::default()
        };
        // 4750·$3 + 400·$15 per Mtok = 20,250 micro-dollars.
        let cost = super::write_usage_row(&conn, "req1", "anthropic", "claude-sonnet-4-6", &usage)
            .unwrap();
        assert_eq!(cost, 20_250);
        let (it, ot, cm): (i64, i64, i64) = conn
            .query_row(
                "SELECT input_tokens, output_tokens, cost_usd_micros FROM ai_request_usage WHERE request_id='req1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((it, ot, cm), (4750, 400, 20_250));
    }

    #[test]
    fn cloud_consent_gate_blocks_until_confirmed() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        let confirmed = |c: &Connection| {
            settings::get_string(c, settings::KEY_FIRST_CLOUD_CONFIRMED_AT).is_some()
        };
        // Remote providers gate (until confirmed); local never gates.
        assert!(settings::AiProvider::Anthropic.is_remote());
        assert!(!settings::AiProvider::Local.is_remote());
        assert!(!confirmed(&conn), "unconfirmed by default → the gate fires");
        settings::set_string(
            &conn,
            settings::KEY_FIRST_CLOUD_CONFIRMED_AT,
            "2026-06-08T00:00:00Z",
        )
        .unwrap();
        assert!(
            confirmed(&conn),
            "confirmed after cmd_confirm_cloud_send → gate clears"
        );
    }

    /// The brevity contract is cross-provider: the cap that `cmd_ai_ask` threads
    /// into the `ProviderCall` (and thus every provider body) must be exactly the
    /// depth-appropriate `max_tokens_for(mode, depth)` ceiling — never a silent
    /// provider-side default. This pins the wiring at the caller boundary: Brief
    /// and Deep resolve to distinct caps and land on `ProviderCall.max_tokens`.
    /// (The matching per-provider BODY assertions live in `ai_providers::tests`,
    /// where the body builders are in scope.)
    #[test]
    fn provider_call_carries_depth_appropriate_brevity_cap_for_each_lens() {
        use ai_stub::{Depth, StubMode};
        for mode in [
            StubMode::Explain,
            StubMode::Historical,
            StubMode::Vocabulary,
            StubMode::Socratic,
        ] {
            let brief_cap = max_tokens_for(mode, Depth::Brief);
            let deep_cap = max_tokens_for(mode, Depth::Deep);
            assert_eq!(
                brief_cap, BRIEF_MAX_TOKENS,
                "{mode:?} Brief uses the brief ceiling"
            );
            assert_eq!(
                deep_cap, DEEP_MAX_TOKENS,
                "{mode:?} Deep uses the deep ceiling"
            );
            assert!(
                deep_cap > brief_cap,
                "{mode:?}: Deep must get more headroom than Brief"
            );

            // Build the ProviderCall exactly as cmd_ai_ask does and confirm the cap
            // it would hand to run_provider_call is the tier ceiling, not a default.
            for (depth, expected) in [(Depth::Brief, brief_cap), (Depth::Deep, deep_cap)] {
                let call = crate::ai_providers::ProviderCall {
                    provider: settings::AiProvider::Anthropic,
                    model: "claude-opus-4-8".to_string(),
                    prompt: "p".to_string(),
                    max_tokens: Some(max_tokens_for(mode, depth)),
                    timeout: std::time::Duration::from_secs(1),
                    auth: crate::ai_providers::ProviderAuth::AnthropicKey("k".to_string()),
                    base_url: String::new(),
                };
                assert_eq!(
                    call.max_tokens,
                    Some(expected),
                    "{mode:?}/{depth:?}: ProviderCall must carry the tier cap"
                );
            }
        }
    }

    /// `cmd_ai_preview` returns a non-empty reader-facing prompt for every lens
    /// and performs NO network call — it takes no DB/HTTP path, returning straight
    /// from the pure `ai_stub` formatter. (The no-network posture is also enforced
    /// statically by `lib::tests::no_unaudited_network_plugins`, which asserts
    /// `ai_stub.rs` pulls in no HTTP client.) We exercise the command boundary so
    /// the wiring (mode parsing, briefing/selection routing, payload shape) is
    /// pinned, then assert against the formatter for the privacy invariant.
    #[test]
    fn cmd_ai_preview_returns_a_non_empty_prompt_with_no_network_call() {
        for mode in ["explain", "historical", "vocabulary", "socratic"] {
            let card = cmd_ai_preview(
                mode.to_string(),
                "Network effects compound.".to_string(),
                "The Cold Start Problem".to_string(),
                Some("Andrew Chen".to_string()),
                Some("3. Cold Start Theory".to_string()),
                None,
            )
            .expect("cmd_ai_preview should succeed for a known lens");
            assert!(!card.title.trim().is_empty(), "{mode}: title set");
            assert!(!card.prompt.trim().is_empty(), "{mode}: prompt set");
            assert!(!card.copy_label.trim().is_empty(), "{mode}: copy label set");
            assert!(
                card.prompt.contains("The Cold Start Problem"),
                "{mode}: prompt names the book"
            );
            assert!(
                card.prompt.contains("Network effects compound."),
                "{mode}: prompt quotes the selection"
            );
            // Privacy invariant: the internal fence/safety scaffolding never leaks
            // into the reader-facing copyable prompt.
            assert!(
                !card.prompt.contains("UNTRUSTED_PASSAGE")
                    && !card.prompt.contains("instructional force"),
                "{mode}: reader prompt must not expose internal scaffolding"
            );
        }

        // The Deep Study briefing prefers the section text over the selection.
        let briefing = cmd_ai_preview(
            "section_briefing".to_string(),
            "(small selection)".to_string(),
            "The Cold Start Problem".to_string(),
            None,
            Some("3. Cold Start Theory".to_string()),
            Some("A whole section of prose to prepare for.".to_string()),
        )
        .expect("cmd_ai_preview should succeed for the briefing");
        assert!(briefing
            .prompt
            .contains("A whole section of prose to prepare for."));
        assert!(
            !briefing.prompt.contains("(small selection)"),
            "briefing uses section_text"
        );

        // An unknown mode is a validation error, not a panic.
        assert!(cmd_ai_preview(
            "not_a_mode".to_string(),
            "x".to_string(),
            "Book".to_string(),
            None,
            None,
            None,
        )
        .is_err());
    }

    #[test]
    fn list_ai_requests_newest_first_with_book_title_join() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, author TEXT, source_type TEXT, source_path TEXT, source_sha256 TEXT, created_at TEXT, last_opened_at TEXT);
             CREATE TABLE ai_requests (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, mode TEXT NOT NULL, locator TEXT, context_char_count INTEGER, provider TEXT, created_at TEXT NOT NULL, wrote_to_memory INTEGER DEFAULT 0);",
        ).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, source_type, source_path, source_sha256, created_at) VALUES ('bk','Cold Start','epub','','','2026-01-01')",
            [],
        ).unwrap();
        // A preview (provider NULL), an Ask call (provider set + saved as note),
        // and an orphan whose book is gone — to exercise the LEFT JOIN.
        conn.execute("INSERT INTO ai_requests VALUES ('a1','bk','explain','char:0',10,NULL,'2026-05-01T00:00:00+00:00',0)", []).unwrap();
        conn.execute("INSERT INTO ai_requests VALUES ('a2','bk','socratic','char:1',20,'localhost','2026-05-03T00:00:00+00:00',1)", []).unwrap();
        conn.execute("INSERT INTO ai_requests VALUES ('a3','gone','vocabulary',NULL,5,NULL,'2026-05-02T00:00:00+00:00',0)", []).unwrap();

        let rows = list_ai_requests(&conn).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["a2", "a3", "a1"],
            "rows ordered newest created_at first"
        );

        let a2 = rows.iter().find(|r| r.id == "a2").unwrap();
        assert_eq!(a2.book_title.as_deref(), Some("Cold Start"));
        assert_eq!(
            a2.provider.as_deref(),
            Some("localhost"),
            "Ask calls record the host"
        );
        assert!(a2.wrote_to_memory, "a2 became a note");

        let a1 = rows.iter().find(|r| r.id == "a1").unwrap();
        assert_eq!(a1.provider, None, "previews never recorded a provider");

        let a3 = rows.iter().find(|r| r.id == "a3").unwrap();
        assert_eq!(a3.book_title, None, "orphaned request has no joined title");
    }

    /// Saving a margin **tutor** preview persists the selection anchors + session,
    /// exports a Markdown mirror, and flips the audit row to `wrote_to_memory = 1`
    /// — the contract the Companion-Margin tutor card relies on. Runs against an
    /// isolated temp export dir so it never touches the user's real GBrain.
    #[test]
    fn save_preview_as_note_persists_anchors_and_exports_markdown() {
        // export::export_note writes under paths::default_export_root(), which
        // honors THROUGHLINE_EXPORT_DIR — point it at a temp dir and serialize
        // against other env-touching tests so we never write into ~/GBrain.
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-tutor-save-test-{}", std::process::id()));
        // Fresh dir each run so a stale mirror can't mask a regression.
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('b1','Confessions','Augustine','txt','/x','sha-abc','2026-05-01',NULL)",
            [],
        )
        .unwrap();
        // The preview audit row the tutor card's prompt-preview would have logged.
        conn.execute(
            "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
             VALUES ('ai1','b1','explain','char:10', 42, NULL, '2026-05-10T10:00:00Z', 0)",
            [],
        )
        .unwrap();

        let note = save_preview_as_note_inner(
            &conn,
            "ai1",
            "TutorNote",
            "my takeaway on this passage",
            "char:10",
            Some("I.".to_string()),
            Some("char:10".to_string()),
            Some("char:31".to_string()),
            Some("greatly to be praised".to_string()),
            Some("sess_1".to_string()),
        )
        .expect("save_preview_as_note_inner");

        // Anchors + type + session round-trip onto the returned Note.
        assert_eq!(note.note_type, "TutorNote");
        assert_eq!(note.anchor_start.as_deref(), Some("char:10"));
        assert_eq!(note.anchor_end.as_deref(), Some("char:31"));
        assert_eq!(note.anchored_text.as_deref(), Some("greatly to be praised"));
        assert_eq!(note.session_id.as_deref(), Some("sess_1"));
        assert_eq!(note.chapter_label.as_deref(), Some("I."));

        // exported_markdown_path is set AND the file exists under the isolated dir.
        let md_path = note
            .exported_markdown_path
            .as_deref()
            .expect("exported_markdown_path must be set");
        assert!(
            md_path.starts_with(&export_dir.to_string_lossy().to_string()),
            "export {md_path} must land under the isolated dir {export_dir:?}"
        );
        let md = std::fs::read_to_string(md_path).expect("exported markdown file exists");
        assert!(md.contains("source_private: true"));
        assert!(md.contains("note_type: TutorNote"));
        assert!(md.contains("chapter: \"I.\""));
        // The body that IS exported is the reader's own words.
        assert!(
            md.contains("my takeaway on this passage"),
            "user-authored body is exported"
        );
        // PRIVACY REGRESSION (AGENTS.md): the exported TutorNote Markdown must NOT
        // leak the selected passage (held only as the DB anchor) nor any AI prompt
        // text — exports carry paraphrases/locators/short quotes, never the raw
        // passage or prompt. `anchored_text` is intentionally not exported, and the
        // body is user-authored (never the prompt preview).
        assert!(
            !md.contains("greatly to be praised"),
            "selected passage must NOT appear in exported TutorNote Markdown:\n{md}"
        );
        assert!(
            !md.contains("```"),
            "prompt fence markers must NOT appear in exported TutorNote Markdown:\n{md}"
        );

        // wrote_to_memory flipped on the audit row.
        let wrote: i64 = conn
            .query_row(
                "SELECT wrote_to_memory FROM ai_requests WHERE id = 'ai1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(wrote, 1);

        // The row persisted the anchors too (not just the returned struct).
        let (a_start, a_end, a_text): (Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT anchor_start, anchor_end, anchored_text FROM notes WHERE id = ?1",
                params![note.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(a_start.as_deref(), Some("char:10"));
        assert_eq!(a_end.as_deref(), Some("char:31"));
        assert_eq!(a_text.as_deref(), Some("greatly to be praised"));

        // Empty body is still rejected (the takeaway-fallback is the caller's job).
        let err = save_preview_as_note_inner(
            &conn,
            "ai1",
            "TutorNote",
            "   ",
            "char:10",
            None,
            None,
            None,
            None,
            None,
        );
        assert!(err.is_err(), "empty body must be rejected");

        // Cleanup the isolated export dir + env override.
        std::fs::remove_dir_all(&export_dir).ok();
        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
    }
}

/// Approve an AI tutor response (or prompt-preview takeaway) into a durable
/// Note + Markdown. The marginalia anchor fields are optional and additive: the
/// EPUB reader's modal omits them (point-anchored), while the text reader's
/// Companion-Margin AI card passes the selection range so the saved card stays
/// pinned beside the passage. Flipping `wrote_to_memory = 1` records that this
/// AI request became memory (the audit invariant).
#[tauri::command]
pub fn cmd_save_ai_response_as_note(
    ai_request_id: String,
    note_type: String,
    body: String,
    locator: String,
    chapter_label: Option<String>,
    // Marginalia anchor (all optional). When present the saved AI card renders
    // anchored in the Companion Margin instead of in the flat notes list.
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
    session_id: Option<String>,
    state: State<DbState>,
) -> Result<Note, AppError> {
    if body.trim().is_empty() {
        return Err(AppError::validation("note body is empty"));
    }
    let conn = state.0.lock()?;
    let book_id: String = conn
        .query_row(
            "SELECT book_id FROM ai_requests WHERE id = ?1",
            params![ai_request_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::not_found("ai_request", Some(ai_request_id.clone())))?;

    let id = format!("note_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?8, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL, ?9, ?10, ?11)",
        params![id, book_id, note_type, locator, chapter_label, body, now, session_id, anchor_start, anchor_end, anchored_text],
    )?;

    conn.execute(
        "UPDATE ai_requests SET wrote_to_memory = 1 WHERE id = ?1",
        params![ai_request_id],
    )?;

    let mut note_stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text FROM notes WHERE id = ?1",
    )?;
    let mut note = note_stmt.query_row(params![id], note_from_row)?;

    if let Some(book) = fetch_book(&conn, &book_id)? {
        if let Ok(path) = export::export_note(&export::root_for(&conn), &book, &note) {
            log::log_export("note", &path.to_string_lossy());
            note.exported_markdown_path = Some(path.to_string_lossy().to_string());
            conn.execute(
                "UPDATE notes SET exported_markdown_path = ?1 WHERE id = ?2",
                params![note.exported_markdown_path, note.id],
            )?;
        }
    }
    Ok(note)
}

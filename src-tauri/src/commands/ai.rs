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
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

use crate::commands::db_helpers::*;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::AiRequest;
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

/// Map a provider-dispatch error to an AppError. The Company arm signals an
/// exhausted cap with `CAP_EXHAUSTED_SENTINEL`; everything else is a generic Ai error.
pub(crate) fn classify_provider_error(e: &anyhow::Error) -> AppError {
    if format!("{e}").contains(crate::ai_providers::CAP_EXHAUSTED_SENTINEL) {
        AppError::cap_exhausted()
    } else {
        AppError::ai(format!("{e}"))
    }
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

    let conn = state.lock()?;
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
) -> Result<crate::commands::notes::SavedNote, AppError> {
    let conn = state.lock()?;
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
) -> Result<crate::commands::notes::SavedNote, AppError> {
    save_ai_note_inner(
        conn,
        ai_request_id,
        &[],
        note_type,
        body,
        locator,
        chapter_label,
        anchor_start,
        anchor_end,
        anchored_text,
        session_id,
    )
}

/// R11-6: the full save, with EVERY contributing AI request audited. A tutor
/// card's saved body can combine the BRIEF and the DEEP tier — two separate
/// `cmd_ai_ask` calls, two audit rows. Each contributing row must exist and
/// belong to the SAME BOOK as the primary (a cross-book id is a caller bug —
/// the whole save refuses), and every one is flipped `wrote_to_memory = 1`
/// in the SAME transaction as the note insert: the audit invariant covers
/// all contributors, not just the primary.
#[allow(clippy::too_many_arguments)]
fn save_ai_note_inner(
    conn: &rusqlite::Connection,
    ai_request_id: &str,
    contributing_request_ids: &[String],
    note_type: &str,
    body: &str,
    locator: &str,
    chapter_label: Option<String>,
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
    session_id: Option<String>,
) -> Result<crate::commands::notes::SavedNote, AppError> {
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
    // R11-6: validate every contributor BEFORE anything mutates — same book,
    // real row. Duplicates and the primary itself are tolerated (dedup below).
    let mut contributors: Vec<&str> = vec![ai_request_id];
    for extra in contributing_request_ids {
        if !contributors.contains(&extra.as_str()) {
            contributors.push(extra.as_str());
        }
    }
    for cid in &contributors {
        let contributor_book: String = conn
            .query_row(
                "SELECT book_id FROM ai_requests WHERE id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .map_err(|_| AppError::not_found("ai_request", Some((*cid).to_string())))?;
        if contributor_book != book_id {
            return Err(AppError::validation(format!(
                "contributing AI request {cid} belongs to a different book — refusing to save a cross-book note"
            )));
        }
    }

    let id = format!("note_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    // R4 crash-safe mirror contract: the note INSERT, the audit flag, and the
    // durable dirty-book mark commit in ONE transaction, before the export
    // attempt — a crash before the export leaves the mark, and launch heals
    // the mirror (same contract as commands::notes::commit_note_insert).
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?8, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL, ?9, ?10, ?11)",
        params![id, book_id, note_type, locator, chapter_label, body, now, session_id, anchor_start, anchor_end, anchored_text],
    )?;
    // R11-6: EVERY contributor becomes memory in this same transaction.
    for cid in &contributors {
        tx.execute(
            "UPDATE ai_requests SET wrote_to_memory = 1 WHERE id = ?1",
            params![cid],
        )?;
    }
    crate::settings::ledger_add(&tx, crate::settings::KEY_PENDING_BOOK_EXPORTS, &book_id)
        .map_err(AppError::from)?;
    tx.commit()?;

    let mut note_stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text FROM notes WHERE id = ?1",
    )?;
    let mut note = note_stmt.query_row(params![id], note_from_row)?;

    // Regenerate the book's literature note (per-book, idempotent merge) and point
    // the row's mirror path at the shared book file. A failed export is TYPED,
    // never swallowed (DATA-004): the note is durable in SQLite either way, and
    // the card shows the export outcome with a retry.
    let now_export = Utc::now().to_rfc3339();
    match export::export_book_durably(conn, &export::root_for(conn), &book_id, &now_export) {
        Ok(path) => {
            log::log_export("book", &path.to_string_lossy());
            note.exported_markdown_path = Some(path.to_string_lossy().to_string());
            conn.execute(
                "UPDATE notes SET exported_markdown_path = ?1 WHERE id = ?2",
                params![note.exported_markdown_path, note.id],
            )?;
            Ok(crate::commands::notes::SavedNote {
                note,
                export: export::ExportOutcome::exported(),
            })
        }
        Err(e) => Ok(crate::commands::notes::SavedNote {
            note,
            export: export::ExportOutcome::failed(&e),
        }),
    }
}

/// AI request history viewer (adr-001). Returns every audit row, newest first,
/// with the book title joined for display. `provider == null` means the request
/// was a prompt preview that never left the machine; a non-null provider is the
/// host a real Ask call was sent to.
#[tauri::command]
pub fn cmd_list_ai_requests(state: State<DbState>) -> Result<Vec<AiRequest>, AppError> {
    let conn = state.lock()?;
    Ok(list_ai_requests(&conn)?)
}

/// Apply the AI retention window immediately (the "Forget now" control): delete
/// audit rows older than the configured number of days that never became a note.
/// Rows with `wrote_to_memory = 1` are kept. Returns the number of rows removed.
#[tauri::command]
pub fn cmd_forget_ai_history(state: State<DbState>) -> Result<usize, AppError> {
    let conn = state.lock()?;
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

/// The company relay's shape gate: it rejects any request whose `max_tokens`
/// exceeds this with HTTP 400 ("max_tokens too large") before the model is
/// reached. Mirrors `MAX_OUTPUT_TOKENS = "800"` in
/// throughline-ai-proxy/wrangler.toml as of 2026-06-10 — if the proxy gate
/// moves, move this with it. The contract test below pins every mode ceiling
/// under it, and `clamp_to_company_relay` keeps even future drift from turning
/// into a deterministic 400 for company readers.
pub const COMPANY_RELAY_MAX_OUTPUT_TOKENS: u32 = 800;

/// Cap a per-mode ceiling at the relay's shape gate for company calls — a
/// ceiling raised for BYO headroom must never become a guaranteed rejection on
/// the paid path. BYO providers keep the full ceiling.
pub fn clamp_to_company_relay(provider: settings::AiProvider, max_tokens: u32) -> u32 {
    if matches!(provider, settings::AiProvider::Company) {
        max_tokens.min(COMPANY_RELAY_MAX_OUTPUT_TOKENS)
    } else {
        max_tokens
    }
}

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
    // R6-1: the consent binding from the sheet's EnvelopePreview, present only
    // on the retry that follows a NeedsCloudConsent rejection. Validated at
    // THIS send boundary against what this call actually resolves to.
    consent: Option<ConsentBinding>,
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
        let conn = state.lock()?;
        let book = fetch_book(&conn, &book_id)?
            .ok_or_else(|| AppError::not_found("book", Some(book_id.clone())))?;

        let provider = settings::get_ai_provider(&conn);
        match provider {
            settings::AiProvider::Unset => {
                return Err(AppError::config(
                    "Choose an AI provider first (Settings → Reading assistant).",
                ))
            }
            settings::AiProvider::Disabled => {
                return Err(AppError::config(
                    "AI is turned off. Enable a provider in Settings → Reading assistant.",
                ))
            }
            _ => {}
        }

        // Monthly spend cap (Epic B4): refuse a cloud call once month-to-date cost
        // reaches the reader's ceiling. Local has no spend, so it's never capped.
        // Company is exempt: the proxy meters it server-side (the authoritative
        // cap), and this gate's refusal speaks dollars — which company mode must
        // never surface.
        if local_spend_cap_applies(provider) {
            let cap = settings::get_string(&conn, settings::KEY_AI_SPEND_CAP_CENTS)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            if spend_cap_exceeded(cap, month_to_date_micros(&conn)) {
                return Err(AppError::config(format!(
                    "You've reached your monthly AI spend cap (${:.2}). Raise or clear it in Settings → Reading assistant to keep using cloud AI.",
                    cap as f64 / 100.0
                )));
            }
        }

        let model = settings::get_ai_model_for(&conn, provider);
        if model.trim().is_empty() {
            return Err(AppError::config(
                "No AI model set. Open Settings → Reading assistant and set the model id.",
            ));
        }
        let base_url = if matches!(provider, settings::AiProvider::Company) {
            // R7-2: the company origin is a code constant — never a stored,
            // reroutable value. run_provider_call re-validates it at the
            // send boundary.
            settings::company_base_url()
        } else {
            settings::get_ai_base_url(&conn)
        };
        // Local keeps the hard loopback backstop; a typo can never send off-device.
        if matches!(provider, settings::AiProvider::Local) {
            ai_client::validate_base_url(&base_url, true).map_err(AppError::from)?;
        }

        // ONE authoritative resolution for this call: provider, canonical host,
        // exact envelope, fingerprint — the same constructor the consent sheet
        // previewed (PRIV-A11Y-009: what the reader confirmed is what is sent).
        let resolved = resolve_outbound(
            &conn,
            &book.title,
            book.author.clone(),
            stub_mode,
            answer_depth,
            trimmed,
            chapter.clone(),
            user_note,
        );

        // First-cloud-call consent (C2 / CORE-1177 / R6-1): a remote provider
        // must be confirmed before the first send. The frontend catches the
        // NeedsCloudConsent rejection, shows the consent sheet with the exact
        // envelope, then retries THIS command carrying the sheet's binding —
        // validated just above the dispatch, against this very call. Fires for
        // freshly-activated company users too (activation never writes consent).
        enforce_bound_cloud_consent(&conn, &resolved, consent.as_ref())?;

        let provider_host = resolved.host.clone();
        let prompt = resolved.envelope.prompt;

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
            .ok_or_else(|| {
                AppError::config("Add your OpenAI API key in Settings → Reading assistant.")
            })?,
        settings::AiProvider::Anthropic => crate::keystore::get_key("anthropic")
            .map(crate::ai_providers::ProviderAuth::AnthropicKey)
            .ok_or_else(|| {
                AppError::config("Add your Anthropic API key in Settings → Reading assistant.")
            })?,
        settings::AiProvider::Codex => crate::ai_providers::ProviderAuth::Codex,
        settings::AiProvider::Company => crate::keystore::get_key("company")
            .map(crate::ai_providers::ProviderAuth::CompanyLicense)
            .ok_or_else(|| {
                AppError::config("Activate Throughline AI in Settings → Reading assistant.")
            })?,
        _ => return Err(AppError::config("No AI provider chosen.")),
    };

    let call = crate::ai_providers::ProviderCall {
        provider,
        model: model.clone(),
        prompt: prompt.clone(),
        max_tokens: Some(clamp_to_company_relay(
            provider,
            max_tokens_for(stub_mode, answer_depth),
        )),
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
            return Err(classify_provider_error(&e));
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
                if let Ok(conn) = app.state::<DbState>().lock() {
                    record_stream_usage_row(&conn, &rec_ai_id, &rec_provider, &rec_model, &usage);
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

/// The local monthly spend cap governs the reader's own BYO cloud spend. Company
/// mode is metered server-side (the proxy cap is authoritative) and must never
/// surface a dollar-denominated refusal, so it is exempt. Local never spends.
fn local_spend_cap_applies(provider: settings::AiProvider) -> bool {
    provider.is_remote() && !matches!(provider, settings::AiProvider::Company)
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
    let conn = state.lock()?;
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
    let conn = state.lock()?;
    settings::set_string(
        &conn,
        settings::KEY_AI_SPEND_CAP_CENTS,
        &cents.max(0).to_string(),
    )
    .map_err(AppError::from)
}

// ── First-cloud consent, bound to the exact ask (R6-1 / CORE-1177) ──────

/// What the reader confirmed on the consent sheet, passed back with the ask
/// itself. Captured verbatim from `cmd_outbound_envelope`'s `EnvelopePreview`,
/// so the sheet can only ever confirm a binding the backend itself issued.
#[derive(Deserialize)]
pub struct ConsentBinding {
    pub provider: String,
    pub host: String,
    pub fingerprint: String,
}

/// The authoritative outbound resolution for one ask: active provider, the
/// canonical destination host, the EXACT envelope, and a fingerprint over all
/// three. Both the consent preview (`cmd_outbound_envelope`) and the send gate
/// inside `cmd_ai_ask` resolve through THIS function, so what the reader
/// reviewed and what the gate validates can never be two constructions.
pub(crate) struct ResolvedSend {
    pub provider: settings::AiProvider,
    pub host: String,
    pub envelope: ai_stub::OutboundEnvelope,
    pub fingerprint: String,
}

/// SHA-256 over provider id, destination host, and the complete prompt —
/// NUL-separated so no field can masquerade as another's suffix.
fn send_fingerprint(provider: settings::AiProvider, host: &str, prompt: &str) -> String {
    let mut h = Sha256::new();
    h.update(provider.as_str().as_bytes());
    h.update([0u8]);
    h.update(host.as_bytes());
    h.update([0u8]);
    h.update(prompt.as_bytes());
    format!("{:x}", h.finalize())
}

fn resolve_outbound(
    conn: &rusqlite::Connection,
    book_title: &str,
    author: Option<String>,
    stub_mode: ai_stub::StubMode,
    answer_depth: ai_stub::Depth,
    selection: &str,
    chapter: Option<String>,
    user_note: Option<String>,
) -> ResolvedSend {
    let provider = settings::get_ai_provider(conn);
    // ONE host derivation for previews, gates, and audit rows: the enum's
    // canonical remote host, or the local base URL's host for Local.
    let host = match provider {
        settings::AiProvider::Local => url::Url::parse(&settings::get_ai_base_url(conn))
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        p => p.remote_host().unwrap_or_default().to_string(),
    };
    let ctx = ai_stub::PromptContext {
        book_title: book_title.to_string(),
        author,
        chapter,
        locator: None, // never rides in the outbound prompt (pinned in ai_stub tests)
        selection: selection.trim().to_string(),
        user_note,
    };
    let envelope = ai_stub::build_envelope(stub_mode, answer_depth, &ctx);
    let fingerprint = send_fingerprint(provider, &host, &envelope.prompt);
    ResolvedSend {
        provider,
        host,
        envelope,
        fingerprint,
    }
}

/// The first-cloud-consent gate, bound to the exact ask (R6-1). A remote send
/// requires remembered consent; absent that, the ask may carry the binding the
/// reader confirmed on the consent sheet. The binding must equal — provider,
/// canonical host, AND envelope fingerprint — what THIS call is about to send.
/// Any drift (provider switched, destination changed, selection edited between
/// preview and dispatch) fails closed: nothing egresses, no consent is
/// recorded, and the error names the CURRENT destination so the sheet shows a
/// fresh matching preview. `KEY_FIRST_CLOUD_CONFIRMED_AT` is written here and
/// only here, only after a binding validates — consent is remembered exactly
/// when the confirmed send is the send that happens (CORE-1177's promise,
/// delivered without the old confirm→ask race).
fn enforce_bound_cloud_consent(
    conn: &rusqlite::Connection,
    current: &ResolvedSend,
    provided: Option<&ConsentBinding>,
) -> Result<(), AppError> {
    if !cloud_consent_required(conn, current.provider) {
        return Ok(());
    }
    let Some(b) = provided else {
        return Err(AppError::needs_cloud_consent(current.host.clone()));
    };
    if b.provider != current.provider.as_str()
        || b.host != current.host
        || b.fingerprint != current.fingerprint
    {
        return Err(AppError::NeedsCloudConsent {
            host: current.host.clone(),
            message: format!(
                "The destination or passage changed since you reviewed this send — nothing was sent. Review the fresh preview for {} and confirm again.",
                current.host
            ),
        });
    }
    settings::set_string(
        conn,
        settings::KEY_FIRST_CLOUD_CONFIRMED_AT,
        &Utc::now().to_rfc3339(),
    )?;
    Ok(())
}

// ── Company mode (the $20 bundle) ────────────────────────────────────────

#[derive(Serialize)]
pub struct CompanyStatus {
    /// Company is the active provider.
    pub provider_active: bool,
    /// A license is stored (from the persisted flag, no Keychain prompt).
    pub has_license: bool,
}

#[derive(Serialize, Default)]
pub struct CompanyCredits {
    pub status: String, // active | exhausted | expired | revoked | uninit | unknown
    /// 0.0–1.0 of the included allowance remaining. The proxy sends fractions and
    /// question estimates only — dollar amounts never reach the client.
    pub remaining_fraction: f64,
    pub approx_questions_left: i64,
}

/// Parse the proxy's /v1/credits payload. Status comes only from the explicit
/// `ok`/`reason` fields (never inferred from numbers); missing numerics read as
/// 0 — the conservative side for an eligibility-ish display.
fn parse_company_credits(body: &serde_json::Value) -> CompanyCredits {
    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let reason = body.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    let status = if ok {
        "active".to_string()
    } else if !reason.is_empty() {
        reason.to_string()
    } else {
        "unknown".to_string()
    };
    CompanyCredits {
        status,
        remaining_fraction: body
            .get("remaining_fraction")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0),
        approx_questions_left: body
            .get("approx_questions_left")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
    }
}

fn company_http() -> Result<reqwest::Client, AppError> {
    // R8-3: never follow a redirect — a 307/308 would re-send activation
    // tokens or the Bearer license to an arbitrary Location host.
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::ai(format!("http client: {e}")))
}

/// R7-2: EVERY company relay endpoint is built here — from the code-constant
/// origin, gated by `validate_company_destination` at the call site — so no
/// stored value can reroute a passage or the Keychain license.
pub(crate) fn company_endpoint(path: &str) -> Result<String, AppError> {
    let url = format!("{}{path}", settings::company_base_url());
    crate::ai_client::validate_company_destination(&url)
        .map_err(|e| AppError::config(format!("{e:#}")))?;
    Ok(url)
}

/// Reader-facing transport-failure copy for every company relay call. A fixed
/// sentence: reqwest's Display text (DNS, TLS, socket detail) is plumbing and
/// must never reach the activation banner or setup sheet.
const COMPANY_UNREACHABLE_MSG: &str =
    "Couldn't reach Throughline AI — check that this Mac is online, then try again.";

/// Map a non-2xx activation status to reader copy (P1-4). A valid, portable code can
/// hit the multi-device throttle (429, retry_after up to a day) or a transient cap-DO
/// hiccup (503/5xx); telling a paying reader their good code is "invalid" at the $20
/// first-run moment sends them to support instead of back for a retry. Only a genuine
/// 4xx no (invalid / expired / already used / revoked) is permanent.
fn activation_error_message(status: u16) -> &'static str {
    if status == 429 {
        "Too many activations recently. Please wait a little while, then try again."
    } else if (500..600).contains(&status) {
        "Throughline AI is briefly unavailable. Please try again in a moment."
    } else {
        "That activation code is invalid, expired, or already used."
    }
}

/// The consent/preview surface for a tutor ask (PRIV-A11Y-009): the EXACT
/// outbound envelope `cmd_ai_ask` would send for these arguments — destination
/// host, every book-derived field, the FULL bounded selection, and the complete
/// prompt text. Pure read: writes no consent, no audit row, sends nothing.
#[derive(serde::Serialize)]
pub struct EnvelopePreview {
    /// The host the request would go to (the provider mapping the ask uses).
    pub host: String,
    /// The active provider id the envelope was resolved for (R6-1) — the
    /// consent sheet's disclosure/attribution derive from THIS, never from
    /// separately-cached frontend state.
    pub provider: String,
    /// Fingerprint over provider + host + exact prompt. The frontend passes it
    /// back verbatim as the ConsentBinding; cmd_ai_ask recomputes and compares
    /// at the send boundary, so a confirm can only ever authorize THIS send.
    pub fingerprint: String,
    pub envelope: ai_stub::OutboundEnvelope,
}

#[tauri::command]
pub fn cmd_outbound_envelope(
    book_id: String,
    mode: String,
    selection: String,
    chapter: Option<String>,
    user_note: Option<String>,
    depth: Option<String>,
    state: State<DbState>,
) -> Result<EnvelopePreview, AppError> {
    let stub_mode = ai_stub::StubMode::from_str(&mode)
        .ok_or_else(|| AppError::validation(format!("unknown AI stub mode: {}", mode)))?;
    let answer_depth = ai_stub::Depth::from_str(depth.as_deref().unwrap_or("brief"))
        .unwrap_or(ai_stub::Depth::Brief);
    let conn = state.lock()?;
    let book = fetch_book(&conn, &book_id)?
        .ok_or_else(|| AppError::not_found("book", Some(book_id.clone())))?;
    let resolved = resolve_outbound(
        &conn,
        &book.title,
        book.author,
        stub_mode,
        answer_depth,
        &selection,
        chapter,
        user_note,
    );
    Ok(EnvelopePreview {
        host: resolved.host,
        provider: resolved.provider.as_str().to_string(),
        fingerprint: resolved.fingerprint,
        envelope: resolved.envelope,
    })
}

/// Exchange a single-use activation token (deep link or typed code) for a durable
/// license, store it in the Keychain, and switch the active provider to Company.
///
/// CORE-1177: activation grants the ENTITLEMENT (license, provider, LOCAL_ONLY off) but
/// NOT cloud-send consent. Consent is a separate, explicit act captured at the reader's
/// first real send by cmd_ai_ask's bound-consent gate (enforce_bound_cloud_consent), so
/// the privacy promise is actually delivered (the consent sheet shows the passage before
/// anything leaves the Mac). This fn must never write KEY_FIRST_CLOUD_CONFIRMED_AT.
#[tauri::command]
pub async fn cmd_activate_company(
    activation_token: String,
    state: State<'_, DbState>,
) -> Result<CompanyStatus, AppError> {
    let token = activation_token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::validation("Enter your activation code."));
    }
    let resp = company_http()?
        .post(company_endpoint("/v1/activate")?)
        .json(&serde_json::json!({ "activation_token": token }))
        .send()
        .await
        .map_err(|_| AppError::ai(COMPANY_UNREACHABLE_MSG))?;
    if !resp.status().is_success() {
        return Err(AppError::validation(activation_error_message(
            resp.status().as_u16(),
        )));
    }
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let license = body
        .get("license")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if license.is_empty() {
        return Err(AppError::ai("Activation returned no license."));
    }
    crate::keystore::set_key("company", &license).map_err(|e| AppError::io(format!("{e}")))?;
    {
        let conn = state.lock()?;
        apply_company_activation(&conn, &Utc::now().to_rfc3339())?;
    }
    Ok(CompanyStatus {
        provider_active: true,
        has_license: true,
    })
}

/// Apply the ENTITLEMENT settings for company activation (CORE-1177): the active provider,
/// the activated flag, LOCAL_ONLY off, and (first time only) the provider-chosen stamp.
/// It deliberately writes NO consent flag: KEY_FIRST_CLOUD_CONFIRMED_AT is owned solely by
/// cmd_ai_ask's bound-consent gate (enforce_bound_cloud_consent), so cloud-send consent is
/// captured at the reader's first real send — validated against the exact envelope the
/// sheet showed — never granted as a side effect of activation.
fn apply_company_activation(conn: &rusqlite::Connection, now: &str) -> Result<(), AppError> {
    settings::set_string(conn, settings::KEY_AI_PROVIDER, "company")?;
    settings::set_string(conn, settings::KEY_COMPANY_ACTIVATED, "1")?;
    settings::set_string(conn, settings::KEY_LOCAL_ONLY, "false")?;
    if settings::get_string(conn, settings::KEY_AI_PROVIDER_CHOSEN_AT).is_none() {
        settings::set_string(conn, settings::KEY_AI_PROVIDER_CHOSEN_AT, now)?;
    }
    Ok(())
}

/// The first-cloud-consent gate (Epic C2 / CORE-1177): a remote provider must have an
/// explicit in-app confirmation (KEY_FIRST_CLOUD_CONFIRMED_AT, written only by
/// enforce_bound_cloud_consent after a binding validates) before ANY relay egress.
/// Because activation grants the entitlement but not consent, this stays true right
/// after activation until the reader confirms the first send. Pure, so cmd_ai_ask's
/// gate is unit-testable.
fn cloud_consent_required(conn: &rusqlite::Connection, provider: settings::AiProvider) -> bool {
    provider.is_remote()
        && settings::get_string(conn, settings::KEY_FIRST_CLOUD_CONFIRMED_AT).is_none()
}

fn company_status_db_bits(conn: &rusqlite::Connection) -> (bool, bool) {
    (
        matches!(
            settings::get_ai_provider(conn),
            settings::AiProvider::Company
        ),
        settings::get_string(conn, settings::KEY_COMPANY_ACTIVATED).as_deref() == Some("1"),
    )
}

fn company_status_from_bits(
    provider_active: bool,
    activation_flag: bool,
    keychain_license_present: bool,
) -> CompanyStatus {
    CompanyStatus {
        provider_active,
        has_license: activation_flag && keychain_license_present,
    }
}

/// Whether company mode is selected and a usable license is present. The DB flag
/// says activation once succeeded; Keychain presence says future tutor/credits
/// calls can actually authenticate. UI "activated" must imply both.
#[tauri::command]
pub fn cmd_company_status(state: State<DbState>) -> Result<CompanyStatus, AppError> {
    let (provider_active, activation_flag) = {
        let conn = state.lock()?;
        company_status_db_bits(&conn)
    };
    Ok(company_status_from_bits(
        provider_active,
        activation_flag,
        crate::keystore::has_key("company"),
    ))
}

/// Open the system browser at the URL (reader-initiated, validated https only).
/// A narrow targeted exec, not a general shell surface.
#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}
#[cfg(not(target_os = "macos"))]
fn open_in_browser(_url: &str) {}

/// Start a $20 Checkout: ask the proxy for a session URL and open it in the
/// browser. Returns the URL too, so the UI can offer a "continue here" fallback.
#[tauri::command]
pub async fn cmd_company_checkout(_state: State<'_, DbState>) -> Result<String, AppError> {
    let resp = company_http()?
        .post(company_endpoint("/v1/checkout")?)
        .send()
        .await
        .map_err(|_| AppError::ai(COMPANY_UNREACHABLE_MSG))?;
    if !resp.status().is_success() {
        return Err(AppError::ai(
            "Couldn't start checkout. Try again in a moment.",
        ));
    }
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !url.starts_with("https://") {
        return Err(AppError::ai("Checkout returned no URL."));
    }
    open_in_browser(&url);
    Ok(url)
}

/// Read-only credits view for the fuel gauge (the server is authoritative).
#[tauri::command]
pub async fn cmd_company_credits(_state: State<'_, DbState>) -> Result<CompanyCredits, AppError> {
    let license = crate::keystore::get_key("company")
        .ok_or_else(|| AppError::config("Throughline AI isn't activated."))?;
    let resp = company_http()?
        .get(company_endpoint("/v1/credits")?)
        .header("authorization", format!("Bearer {license}"))
        .send()
        .await
        .map_err(|_| AppError::ai(COMPANY_UNREACHABLE_MSG))?;
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    Ok(parse_company_credits(&body))
}

/// The cap-hit screen's quiet third door. Fixed recipient + subject and a short
/// editable greeting — a compile-time constant, so by construction it can never
/// carry usage data, book identity, or passage content.
const SUPPORT_EMAIL_MAILTO: &str = "mailto:nick@readthroughline.com\
?subject=Throughline%20%E2%80%94%20request%20for%20more%20included%20allowance\
&body=Hi%20Nick%2C%0A%0AI%27ve%20used%20up%20my%20included%20Throughline%20AI%20and%20would%20like%20more%20headroom.%0A%0A";

/// Open the reader's mail client for the "more included allowance" request.
/// A narrow targeted exec of one fixed mailto: URL, mirroring `open_in_browser`
/// — not a general shell/open surface, and no dynamic input.
#[tauri::command]
pub fn cmd_open_support_email() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(SUPPORT_EMAIL_MAILTO)
            .spawn();
    }
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
    let conn = state.lock()?;
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

fn record_stream_usage_row(
    conn: &rusqlite::Connection,
    request_id: &str,
    provider: &str,
    model: &str,
    usage: &crate::ai_providers::TokenUsage,
) -> Option<i64> {
    match write_usage_row(conn, request_id, provider, model, usage) {
        Ok(cost) => Some(cost),
        Err(e) => {
            tracing::warn!(
                category = "ai_usage_write",
                request_id = request_id,
                provider = provider,
                model = model,
                error = %e,
                "ai_usage_write_failed"
            );
            None
        }
    }
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
        let conn = state.lock()?;
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

/// Resolve the inputs for a connection test from the saved settings plus the
/// caller's draft overrides — READ-ONLY, so probing can never mutate settings.
/// Split from `cmd_test_ai_connection` so the no-persist draft contract is
/// unit-testable against a plain `Connection` (mirrors `cmd_list_ai_models`).
fn resolve_conn_test_inputs(
    conn: &rusqlite::Connection,
    provider: Option<&str>,
    key: Option<String>,
    base_url: Option<String>,
) -> (settings::AiProvider, Option<String>, String, String) {
    let prov = match provider {
        Some(p) => settings::AiProvider::from_str(p),
        None => settings::get_ai_provider(conn),
    };
    // The Company relay has its own endpoint (and its license is read inside
    // test_provider's Company arm). Local may probe an unsaved draft base URL —
    // loopback-validated downstream exactly like the saved path — WITHOUT
    // writing it. Everything else probes the saved base URL.
    let base_url = match prov {
        settings::AiProvider::Company => settings::company_base_url(),
        settings::AiProvider::Local => base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| settings::get_ai_base_url(conn)),
        _ => settings::get_ai_base_url(conn),
    };
    let model = settings::get_ai_model_for(conn, prov);
    // Prefer an explicitly-passed key (test-before-save); else the stored one.
    let resolved_key = match prov {
        settings::AiProvider::OpenAi => key
            .filter(|k| !k.trim().is_empty())
            .or_else(|| crate::keystore::get_key("openai")),
        settings::AiProvider::Anthropic => key
            .filter(|k| !k.trim().is_empty())
            .or_else(|| crate::keystore::get_key("anthropic")),
        _ => None,
    };
    (prov, resolved_key, base_url, model)
}

/// Test a provider connection. `provider` + `key` may be supplied to test BEFORE
/// saving (onboarding); `base_url` is an optional draft for the Local arm so the
/// LM Studio detect flow can probe without persisting (CORE-1034). The key is
/// never logged or returned.
#[tauri::command]
pub async fn cmd_test_ai_connection(
    provider: Option<String>,
    key: Option<String>,
    base_url: Option<String>,
    state: State<'_, DbState>,
) -> Result<ConnTestResult, AppError> {
    let (prov, resolved_key, base_url, model) = {
        let conn = state.lock()?;
        resolve_conn_test_inputs(&conn, provider.as_deref(), key, base_url)
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
        let conn = state.lock()?;
        settings::mark_codex_creds_present(&conn, true);
    }
    Ok(poll)
}

/// Remove the app-owned Codex login (the Codex CLI's own login is untouched).
#[tauri::command]
pub fn cmd_codex_logout(state: State<DbState>) -> Result<settings::SettingsDto, AppError> {
    crate::keystore::clear_codex_creds().map_err(|e| AppError::config(format!("{e}")))?;
    let conn = state.lock()?;
    settings::mark_codex_creds_present(&conn, false);
    settings::build_dto(&conn).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn cap_exhausted_sentinel_maps_to_cap_exhausted_error() {
        let capped = classify_provider_error(&anyhow::anyhow!(
            crate::ai_providers::CAP_EXHAUSTED_SENTINEL
        ));
        assert_eq!(capped.kind(), "CapExhausted");
        // Anything else stays a generic Ai error.
        let other = classify_provider_error(&anyhow::anyhow!("connection refused"));
        assert_eq!(other.kind(), "Ai");
    }

    #[test]
    fn local_spend_cap_exempts_company_mode() {
        use settings::AiProvider;
        // BYO cloud providers are governed by the reader's local monthly cap…
        assert!(local_spend_cap_applies(AiProvider::OpenAi));
        assert!(local_spend_cap_applies(AiProvider::Anthropic));
        assert!(local_spend_cap_applies(AiProvider::Codex));
        // …but Company is metered server-side (the proxy cap is authoritative) and
        // must never hit the dollar-denominated local refusal. Local never spends.
        assert!(!local_spend_cap_applies(AiProvider::Company));
        assert!(!local_spend_cap_applies(AiProvider::Local));
    }

    #[test]
    fn company_status_requires_keychain_license_not_just_db_flag() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        crate::keystore::clear_key("company").unwrap();
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "company").unwrap();
        settings::set_string(&conn, settings::KEY_COMPANY_ACTIVATED, "1").unwrap();

        let (provider_active, activation_flag) = company_status_db_bits(&conn);
        let status = company_status_from_bits(
            provider_active,
            activation_flag,
            crate::keystore::has_key("company"),
        );

        assert!(
            status.provider_active,
            "the selected provider can still be company"
        );
        assert!(
            !status.has_license,
            "DB activation without the Keychain license must not render as activated"
        );

        crate::keystore::set_key("company", "lic_test.abc").unwrap();
        let status = company_status_from_bits(
            provider_active,
            activation_flag,
            crate::keystore::has_key("company"),
        );
        assert!(
            status.has_license,
            "the happy path remains active when DB flag and Keychain license agree"
        );
        crate::keystore::clear_key("company").unwrap();
    }

    #[test]
    fn parse_company_credits_reads_explicit_fields_only() {
        // Active license: status from ok, fraction + questions pass through.
        let active = parse_company_credits(&serde_json::json!({
            "ok": true, "remaining_fraction": 0.75, "approx_questions_left": 300,
            "expires_at": "2028-06-08T00:00:00Z"
        }));
        assert_eq!(active.status, "active");
        assert!((active.remaining_fraction - 0.75).abs() < f64::EPSILON);
        assert_eq!(active.approx_questions_left, 300);

        // Exhausted: status comes from the explicit reason, never inferred.
        let spent = parse_company_credits(&serde_json::json!({
            "ok": false, "reason": "exhausted", "remaining_fraction": 0.0,
            "approx_questions_left": 0
        }));
        assert_eq!(spent.status, "exhausted");
        assert_eq!(spent.remaining_fraction, 0.0);

        // Garbage / missing fields: conservative — unknown status, zeroed numbers.
        let junk = parse_company_credits(&serde_json::json!({ "surprise": 1 }));
        assert_eq!(junk.status, "unknown");
        assert_eq!(junk.remaining_fraction, 0.0);
        assert_eq!(junk.approx_questions_left, 0);
    }

    #[test]
    fn support_email_mailto_is_fixed_and_content_free() {
        // The tertiary cap-hit door: fixed recipient + subject, short editable
        // body. A compile-time constant, so by construction it can never carry
        // usage data, book identity, or passage content.
        assert!(SUPPORT_EMAIL_MAILTO.starts_with("mailto:nick@readthroughline.com?"));
        assert!(SUPPORT_EMAIL_MAILTO.contains(
            "subject=Throughline%20%E2%80%94%20request%20for%20more%20included%20allowance"
        ));
        assert!(SUPPORT_EMAIL_MAILTO.contains("&body="));
        // No dollars anywhere near the reader-facing door.
        assert!(!SUPPORT_EMAIL_MAILTO.contains('$') && !SUPPORT_EMAIL_MAILTO.contains("%24"));
    }

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
    fn stream_usage_write_failure_is_logged_not_silently_dropped() {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::Context;
        use tracing_subscriber::prelude::*;
        use tracing_subscriber::{Layer, Registry};

        struct CaptureLayer {
            events: Arc<Mutex<Vec<BTreeMap<String, String>>>>,
        }

        impl<S> Layer<S> for CaptureLayer
        where
            S: Subscriber,
        {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldCapture::default();
                event.record(&mut visitor);
                self.events.lock().unwrap().push(visitor.fields);
            }
        }

        #[derive(Default)]
        struct FieldCapture {
            fields: BTreeMap<String, String>,
        }

        impl Visit for FieldCapture {
            fn record_str(&mut self, field: &Field, value: &str) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }

            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                self.fields
                    .insert(field.name().to_string(), format!("{value:?}"));
            }
        }

        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute("DROP TABLE ai_request_usage", []).unwrap();
        let usage = crate::ai_providers::TokenUsage {
            input_tokens: 10,
            output_tokens: 5,
            ..Default::default()
        };
        let events = Arc::new(Mutex::new(Vec::new()));
        let subscriber = Registry::default().with(CaptureLayer {
            events: Arc::clone(&events),
        });

        let result = tracing::subscriber::with_default(subscriber, || {
            record_stream_usage_row(
                &conn,
                "req_missing_usage_table",
                "anthropic",
                "claude-sonnet-4-6",
                &usage,
            )
        });

        assert!(
            result.is_none(),
            "the live stream path should notice the missed usage write"
        );
        let events = events.lock().unwrap();
        assert!(
            events.iter().any(|fields| {
                fields
                    .get("category")
                    .is_some_and(|v| v == "ai_usage_write")
                    && fields
                        .get("request_id")
                        .is_some_and(|v| v == "req_missing_usage_table")
                    && fields
                        .get("message")
                        .is_some_and(|v| v.contains("ai_usage_write_failed"))
                    && fields
                        .get("error")
                        .is_some_and(|v| v.contains("ai_request_usage"))
            }),
            "missing usage writes must produce a structured local log event, got {events:?}"
        );
    }

    /// CORE-1034: the connection test may probe a DRAFT base URL (the LM Studio
    /// panel's default endpoint) without persisting it — merely opening the
    /// recovery panel must never overwrite a reader's saved custom URL. The
    /// draft applies to the Local arm only; Company keeps its relay endpoint.
    #[test]
    fn conn_test_draft_base_url_probes_without_persisting() {
        // Env lock: company_base_url() has a test-only env seam another test
        // exercises — serialize so this test's constant assertion can't race it.
        let _g = crate::paths::lock_env_for_test();
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        // A reader running their local server on a custom port.
        settings::set_string(&conn, settings::KEY_AI_BASE_URL, "http://localhost:8080/v1").unwrap();

        let (prov, _key, base_url, _model) = resolve_conn_test_inputs(
            &conn,
            Some("local"),
            None,
            Some("http://localhost:1234/v1".to_string()),
        );
        assert!(matches!(prov, settings::AiProvider::Local));
        assert_eq!(
            base_url, "http://localhost:1234/v1",
            "the draft is what gets probed"
        );
        // Probing is read-only: the saved custom URL survives untouched.
        assert_eq!(
            settings::get_string(&conn, settings::KEY_AI_BASE_URL).as_deref(),
            Some("http://localhost:8080/v1"),
            "a draft probe must never write KEY_AI_BASE_URL"
        );

        // No draft → the saved URL is probed (unchanged behavior); blank too.
        let (_, _, saved, _) = resolve_conn_test_inputs(&conn, Some("local"), None, None);
        assert_eq!(saved, "http://localhost:8080/v1");
        let (_, _, blank, _) =
            resolve_conn_test_inputs(&conn, Some("local"), None, Some("  ".to_string()));
        assert_eq!(blank, "http://localhost:8080/v1");

        // The draft never leaks into another provider's probe.
        let (_, _, company, _) = resolve_conn_test_inputs(
            &conn,
            Some("company"),
            None,
            Some("http://localhost:1234/v1".to_string()),
        );
        assert_eq!(company, settings::DEFAULT_COMPANY_BASE_URL);
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
            "confirmed after a validated bound consent → gate clears"
        );
    }

    /// R6-1: the consent gate is bound to the EXACT ask. A binding whose
    /// provider, host, or envelope fingerprint differs from what THIS call
    /// resolves to fails closed — NeedsCloudConsent naming the CURRENT host,
    /// and no consent recorded. Only the matching binding records consent.
    #[test]
    fn bound_consent_rejects_every_drift_and_records_only_on_match() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "anthropic").unwrap();

        let resolve = |conn: &Connection, selection: &str| {
            resolve_outbound(
                conn,
                "Confessions",
                Some("Augustine".to_string()),
                ai_stub::StubMode::Explain,
                ai_stub::Depth::Brief,
                selection,
                Some("Book I".to_string()),
                None,
            )
        };
        let consented = |conn: &Connection| {
            settings::get_string(conn, settings::KEY_FIRST_CLOUD_CONFIRMED_AT).is_some()
        };
        let current = resolve(&conn, "the weight of habit drags the soul");
        assert_eq!(current.host, "api.anthropic.com");

        // No binding at all → the plain consent rejection (the sheet trigger).
        let err = enforce_bound_cloud_consent(&conn, &current, None).unwrap_err();
        assert_eq!(err.kind(), "NeedsCloudConsent");
        assert!(!consented(&conn), "no binding → nothing recorded");

        // Provider drift: the reader confirmed OpenAI, the call resolves Anthropic.
        let drifted_provider = ConsentBinding {
            provider: "openai".to_string(),
            host: current.host.clone(),
            fingerprint: current.fingerprint.clone(),
        };
        let err =
            enforce_bound_cloud_consent(&conn, &current, Some(&drifted_provider)).unwrap_err();
        match &err {
            AppError::NeedsCloudConsent { host, message } => {
                assert_eq!(host, "api.anthropic.com", "error names the CURRENT host");
                assert!(message.contains("nothing was sent"));
            }
            other => panic!("expected NeedsCloudConsent, got {other:?}"),
        }
        assert!(!consented(&conn), "provider drift → no consent armed");

        // Host drift (e.g. the provider row changed under the sheet).
        let drifted_host = ConsentBinding {
            provider: "anthropic".to_string(),
            host: "api.openai.com".to_string(),
            fingerprint: current.fingerprint.clone(),
        };
        assert!(enforce_bound_cloud_consent(&conn, &current, Some(&drifted_host)).is_err());
        assert!(!consented(&conn), "host drift → no consent armed");

        // Envelope drift: the selection changed between preview and dispatch.
        let stale_envelope = resolve(&conn, "a DIFFERENT passage entirely");
        let drifted_fp = ConsentBinding {
            provider: "anthropic".to_string(),
            host: current.host.clone(),
            fingerprint: stale_envelope.fingerprint,
        };
        assert!(enforce_bound_cloud_consent(&conn, &current, Some(&drifted_fp)).is_err());
        assert!(!consented(&conn), "fingerprint drift → no consent armed");

        // The exact binding the preview issued → send authorized, consent recorded.
        let bound = ConsentBinding {
            provider: current.provider.as_str().to_string(),
            host: current.host.clone(),
            fingerprint: current.fingerprint.clone(),
        };
        enforce_bound_cloud_consent(&conn, &current, Some(&bound)).unwrap();
        assert!(consented(&conn), "validated bound ask records consent");

        // Once remembered, later asks pass with no binding at all.
        enforce_bound_cloud_consent(&conn, &current, None).unwrap();
    }

    /// R6-1: the fingerprint is deterministic for identical asks and distinct
    /// across provider, host, and prompt — the three drift axes it must catch.
    /// Local (on-device) asks never gate regardless of binding presence.
    #[test]
    fn send_fingerprint_covers_all_three_axes_and_local_never_gates() {
        let a = send_fingerprint(settings::AiProvider::Anthropic, "api.anthropic.com", "P");
        assert_eq!(
            a,
            send_fingerprint(settings::AiProvider::Anthropic, "api.anthropic.com", "P"),
            "deterministic"
        );
        assert_ne!(
            a,
            send_fingerprint(settings::AiProvider::OpenAi, "api.anthropic.com", "P"),
            "provider-sensitive"
        );
        assert_ne!(
            a,
            send_fingerprint(settings::AiProvider::Anthropic, "api.openai.com", "P"),
            "host-sensitive"
        );
        assert_ne!(
            a,
            send_fingerprint(settings::AiProvider::Anthropic, "api.anthropic.com", "Q"),
            "prompt-sensitive"
        );

        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "local").unwrap();
        let local = resolve_outbound(
            &conn,
            "Confessions",
            None,
            ai_stub::StubMode::Explain,
            ai_stub::Depth::Brief,
            "some passage",
            None,
            None,
        );
        enforce_bound_cloud_consent(&conn, &local, None).unwrap();
        assert!(
            settings::get_string(&conn, settings::KEY_FIRST_CLOUD_CONFIRMED_AT).is_none(),
            "local asks neither require nor record cloud consent"
        );
    }

    /// R7-2: a HOSTILE origin planted in the database — with remembered
    /// consent already granted — reroutes NOTHING. The company origin is a
    /// code constant (the old `company_base_url` row is inert), and even a
    /// hostile URL reaching the send boundary is refused by the destination
    /// gate BEFORE any request is built or the license attached: zero
    /// request, zero license disclosure.
    #[test]
    fn hostile_company_origin_with_remembered_consent_sends_nothing() {
        let _g = crate::paths::lock_env_for_test();
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "company").unwrap();
        settings::set_string(
            &conn,
            settings::KEY_FIRST_CLOUD_CONFIRMED_AT,
            "2026-07-01T00:00:00Z",
        )
        .unwrap();
        // The poisoned row (the removed override key): nothing reads it.
        settings::set_string(&conn, "company_base_url", "https://evil.example").unwrap();

        assert_eq!(
            settings::company_base_url(),
            settings::DEFAULT_COMPANY_BASE_URL,
            "the stored row is inert — the origin is the code constant"
        );
        let (_, _, resolved_base, _) = resolve_conn_test_inputs(&conn, Some("company"), None, None);
        assert_eq!(
            resolved_base,
            settings::DEFAULT_COMPANY_BASE_URL,
            "the probe/ask resolution ignores the poisoned row too"
        );

        // The send-boundary gate: every non-canonical destination is refused
        // before a request exists to carry anything.
        for hostile in [
            "https://evil.example/v1/messages",
            "http://ai.readthroughline.com/v1/messages", // scheme downgrade
            "https://ai.readthroughline.com:8443/v1/messages", // explicit port
            "https://ai.readthroughline.com.evil.example/v1/messages", // suffix trick
            "https://evil.example/?u=ai.readthroughline.com", // host in query
        ] {
            assert!(
                crate::ai_client::validate_company_destination(hostile).is_err(),
                "{hostile} must be refused"
            );
        }
        crate::ai_client::validate_company_destination(&format!(
            "{}/v1/messages",
            settings::DEFAULT_COMPANY_BASE_URL
        ))
        .expect("the canonical origin passes");
    }

    /// R7-2: preview host, consent binding, audit provider_host, and every
    /// company endpoint (activation / credits / checkout / feedback / tutor)
    /// derive from ONE constant — they cannot disagree.
    #[test]
    fn company_destinations_cannot_disagree() {
        let _g = crate::paths::lock_env_for_test();
        let origin_host = url::Url::parse(&settings::company_base_url())
            .unwrap()
            .host_str()
            .unwrap()
            .to_string();
        assert_eq!(
            Some(origin_host.as_str()),
            settings::AiProvider::Company.remote_host(),
            "the request origin host IS the consent/audit host"
        );
        for path in [
            "/v1/activate",
            "/v1/credits",
            "/v1/checkout",
            "/v1/feedback",
            "/v1/messages",
        ] {
            let url = company_endpoint(path).expect("canonical endpoint validates");
            assert_eq!(
                url,
                format!("{}{path}", settings::DEFAULT_COMPANY_BASE_URL),
                "every endpoint is built from the one constant"
            );
        }
    }

    /// R7-2: the TEST-ONLY origin seam exists for hermetic relay mocks (it is
    /// compiled out of production builds), and the destination gate follows
    /// it — loopback http allowed only there.
    #[test]
    fn test_origin_seam_is_followed_by_the_destination_gate() {
        let _g = crate::paths::lock_env_for_test();
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe { std::env::set_var("THROUGHLINE_TEST_COMPANY_ORIGIN", "http://127.0.0.1:8099") };
        let seam = settings::company_base_url();
        let gate = crate::ai_client::validate_company_destination(&format!("{seam}/v1/messages"));
        let mismatched =
            crate::ai_client::validate_company_destination("https://evil.example/v1/messages");
        unsafe { std::env::remove_var("THROUGHLINE_TEST_COMPANY_ORIGIN") };
        assert_eq!(seam, "http://127.0.0.1:8099");
        gate.expect("the injected loopback mock origin is usable under cfg(test)");
        assert!(
            mismatched.is_err(),
            "a non-seam destination still fails the gate"
        );
    }

    /// R8-3: the activation/credits/checkout client NEVER follows a redirect
    /// — a 307 pointing at a second listener leaves that listener with ZERO
    /// requests (activation tokens and the Bearer license never re-send to
    /// an arbitrary Location host).
    #[test]
    fn company_client_never_follows_redirects() {
        use std::io::{Read, Write};
        let sink = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let sink_port = sink.local_addr().unwrap().port();
        let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hit_c = hit.clone();
        std::thread::spawn(move || {
            if sink.accept().is_ok() {
                hit_c.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });

        let redirecting = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let a_port = redirecting.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = redirecting.accept() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{sink_port}/v1/activate\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let resp = company_http()
                .unwrap()
                .post(format!("http://127.0.0.1:{a_port}/v1/activate"))
                .header("authorization", "Bearer lic_test.deadbeef")
                .json(&serde_json::json!({ "activation_token": "tok_secret" }))
                .send()
                .await
                .expect("the redirect response itself resolves");
            assert_eq!(resp.status().as_u16(), 307, "redirect NOT followed");
        });
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !hit.load(std::sync::atomic::Ordering::SeqCst),
            "the redirect target must receive ZERO token/license requests"
        );
    }

    /// R6-1: the preview command and the ask gate resolve through the SAME
    /// constructor — same provider, host, and fingerprint for the same inputs —
    /// so the sheet can never preview one send while the gate validates another.
    #[test]
    fn preview_and_gate_resolve_identically() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        settings::set_string(&conn, settings::KEY_AI_PROVIDER, "company").unwrap();
        let once = resolve_outbound(
            &conn,
            "Confessions",
            Some("Augustine".to_string()),
            ai_stub::StubMode::SectionBriefing,
            ai_stub::Depth::Brief,
            "  the section text  ",
            Some("Book II".to_string()),
            None,
        );
        let twice = resolve_outbound(
            &conn,
            "Confessions",
            Some("Augustine".to_string()),
            ai_stub::StubMode::SectionBriefing,
            ai_stub::Depth::Brief,
            "the section text",
            Some("Book II".to_string()),
            None,
        );
        assert_eq!(once.host, "ai.readthroughline.com");
        assert_eq!(once.provider.as_str(), "company");
        assert_eq!(
            once.fingerprint, twice.fingerprint,
            "same inputs (modulo trim) → same fingerprint from preview and gate alike"
        );
        assert_eq!(once.envelope.prompt, twice.envelope.prompt);
    }

    /// CORE-1177: activation grants the entitlement (provider, activated flag,
    /// LOCAL_ONLY off, provider-chosen stamp) but must NOT write cloud-send consent.
    #[test]
    fn activation_grants_entitlement_but_not_consent() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        apply_company_activation(&conn, "2026-07-07T00:00:00Z").unwrap();

        assert_eq!(
            settings::get_string(&conn, settings::KEY_AI_PROVIDER).as_deref(),
            Some("company")
        );
        assert_eq!(
            settings::get_string(&conn, settings::KEY_COMPANY_ACTIVATED).as_deref(),
            Some("1")
        );
        assert_eq!(
            settings::get_string(&conn, settings::KEY_LOCAL_ONLY).as_deref(),
            Some("false")
        );
        assert!(settings::get_string(&conn, settings::KEY_AI_PROVIDER_CHOSEN_AT).is_some());
        // The load-bearing assertion: consent is NOT granted by activation.
        assert!(
            settings::get_string(&conn, settings::KEY_FIRST_CLOUD_CONFIRMED_AT).is_none(),
            "activation must NOT write cloud-send consent (CORE-1177)"
        );
    }

    /// CORE-1177: the "no relay egress without consent" invariant holds immediately
    /// after activation — cmd_ai_ask's gate (cloud_consent_required) still fires, so a
    /// remote provider returns needs_cloud_consent until the reader confirms the send.
    #[test]
    fn cloud_consent_gate_fires_right_after_activation_and_clears_on_confirm() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        apply_company_activation(&conn, "2026-07-07T00:00:00Z").unwrap();

        // Freshly activated company user (remote) is still gated at first send.
        assert!(
            cloud_consent_required(&conn, settings::AiProvider::Company),
            "no relay egress without consent, even right after activation"
        );
        // That gate is exactly what cmd_ai_ask returns to the frontend.
        assert_eq!(
            AppError::needs_cloud_consent("ai.example.com").kind(),
            "NeedsCloudConsent"
        );
        // Local is on-device and never gates.
        assert!(!cloud_consent_required(&conn, settings::AiProvider::Local));

        // The explicit confirmation (written only by the bound-consent gate) clears it.
        settings::set_string(
            &conn,
            settings::KEY_FIRST_CLOUD_CONFIRMED_AT,
            "2026-07-07T00:01:00Z",
        )
        .unwrap();
        assert!(!cloud_consent_required(
            &conn,
            settings::AiProvider::Company
        ));
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

    /// CORE-1035: the relay's shape gate rejects any `max_tokens` above its
    /// `MAX_OUTPUT_TOKENS` before the request reaches the model, so every
    /// (mode, depth) ceiling the app can attach must fit under the documented
    /// gate — otherwise a whole lens deterministically 400s for company readers
    /// (the v0.4.0 Section-briefing outage). This is the app's half of the
    /// cross-repo contract; the proxy's half lives in wrangler.toml.
    #[test]
    fn every_mode_ceiling_fits_the_relay_contract() {
        use ai_stub::{Depth, StubMode};
        for mode in [
            StubMode::Explain,
            StubMode::Historical,
            StubMode::Vocabulary,
            StubMode::Socratic,
            StubMode::DurableNote,
            StubMode::PrepareNext,
            StubMode::SectionBriefing,
        ] {
            for depth in [Depth::Brief, Depth::Deep] {
                let cap = max_tokens_for(mode, depth);
                assert!(
                    cap <= COMPANY_RELAY_MAX_OUTPUT_TOKENS,
                    "{mode:?}/{depth:?}: ceiling {cap} exceeds the relay shape gate \
                     ({COMPANY_RELAY_MAX_OUTPUT_TOKENS}) — every company call in this \
                     mode would 400 before reaching the model"
                );
            }
        }
    }

    /// The call-boundary clamp protects against future drift: even if a ceiling
    /// is raised past the relay gate for BYO headroom (as happened to
    /// SectionBriefing), the company arm sends at most the gate value, while
    /// BYO providers keep the full ceiling.
    #[test]
    fn company_clamp_bounds_a_hypothetical_over_limit_ceiling() {
        let over = COMPANY_RELAY_MAX_OUTPUT_TOKENS + 200;
        assert_eq!(
            clamp_to_company_relay(settings::AiProvider::Company, over),
            COMPANY_RELAY_MAX_OUTPUT_TOKENS,
            "a company call must never carry max_tokens above the relay gate"
        );
        assert_eq!(
            clamp_to_company_relay(settings::AiProvider::Anthropic, over),
            over,
            "BYO providers keep their full headroom"
        );
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

    /// R11-6: a save whose body combines the BRIEF and DEEP tiers marks
    /// EVERY contributing audit row `wrote_to_memory = 1` in the SAME
    /// transaction — and refuses a contributor from a different book with
    /// NOTHING marked or inserted.
    #[test]
    fn save_marks_every_contributing_ai_request_and_refuses_cross_book_ids() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-contrib-save-{}", std::process::id()));
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
        conn.execute(
            "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('b2','Meditations','Marcus','txt','/y','sha-def','2026-05-01',NULL)",
            [],
        )
        .unwrap();
        for (id, book) in [("ai_brief", "b1"), ("ai_deep", "b1"), ("ai_foreign", "b2")] {
            conn.execute(
                "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
                 VALUES (?1, ?2, 'explain', 'char:10', 42, 'localhost', '2026-05-10T10:00:00Z', 0)",
                params![id, book],
            )
            .unwrap();
        }
        let wrote = |id: &str| -> bool {
            conn.query_row(
                "SELECT wrote_to_memory FROM ai_requests WHERE id = ?1",
                params![id],
                |r| r.get::<_, bool>(0),
            )
            .unwrap()
        };

        // A CROSS-BOOK contributor refuses the WHOLE save: nothing inserted,
        // nothing marked.
        let err = save_ai_note_inner(
            &conn,
            "ai_brief",
            &["ai_foreign".to_string()],
            "TutorNote",
            "brief text\n\ndeep text",
            "char:10",
            None,
            None,
            None,
            None,
            None,
        );
        let refusal = err
            .err()
            .expect("cross-book contributor must refuse the save");
        assert!(
            format!("{refusal:?}").contains("different book"),
            "the refusal names the cause: {refusal:?}"
        );
        let notes: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notes, 0, "nothing was inserted");
        assert!(!wrote("ai_brief") && !wrote("ai_deep") && !wrote("ai_foreign"));

        // BRIEF + DEEP from the same book: BOTH rows become memory.
        save_ai_note_inner(
            &conn,
            "ai_brief",
            &["ai_deep".to_string(), "ai_brief".to_string()], // dupes tolerated
            "TutorNote",
            "brief text\n\ndeep text",
            "char:10",
            None,
            None,
            None,
            None,
            None,
        )
        .expect("brief+deep save succeeds");
        assert!(wrote("ai_brief"), "the brief contributor is marked");
        assert!(wrote("ai_deep"), "the deep contributor is marked TOO");
        assert!(!wrote("ai_foreign"), "the foreign row is untouched");

        std::fs::remove_dir_all(&export_dir).ok();
        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
    }

    /// Saving a margin **tutor** preview persists the selection anchors + session,
    /// exports a Markdown mirror, and flips the audit row to `wrote_to_memory = 1`
    /// — the contract the Companion-Margin tutor card relies on. Runs against an
    /// isolated temp export dir so it never touches the user's real export folder.
    #[test]
    fn save_preview_as_note_persists_anchors_and_exports_markdown() {
        // export::export_book_literature_note writes under
        // paths::default_export_root(), which honors THROUGHLINE_EXPORT_DIR —
        // point it at a temp dir and serialize against other env-touching tests
        // so we never write into the export folder.
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
        assert!(
            note.export.ok,
            "isolated export dir -> mirror write succeeds"
        );
        let note = note.note;

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
        // The literature note renders the chapter as a heading and the saved tutor
        // card as a reader-facing "Tutor" callout — never the raw `TutorNote` enum.
        assert!(md.contains("## I."), "chapter becomes a heading:\n{md}");
        assert!(md.contains("> [!abstract] Tutor"), "Tutor callout:\n{md}");
        assert!(
            !md.contains("] TutorNote"),
            "raw DB enum must not be a reader-facing label:\n{md}"
        );
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

    /// P1-4: activation must distinguish a transient/throttle relay response (retry)
    /// from a permanent bad code. Before the fix every non-2xx said "invalid".
    #[test]
    fn activation_error_message_distinguishes_transient_from_permanent() {
        // 429 throttle + 5xx transient => retry copy, never "invalid".
        for s in [429u16, 500, 502, 503] {
            let m = activation_error_message(s).to_ascii_lowercase();
            assert!(
                !m.contains("invalid"),
                "status {s} must not brand the code invalid"
            );
            assert!(
                m.contains("try again") || m.contains("wait"),
                "status {s} must invite a retry: {m}"
            );
        }
        // Genuine 4xx no (incl. 403 revoked, 410 gone) => the permanent invalid copy.
        for s in [400u16, 401, 403, 404, 410] {
            assert!(
                activation_error_message(s).contains("invalid, expired, or already used"),
                "status {s} must be the permanent message"
            );
        }
        // House style: no em/en dashes in any branch.
        for s in [429u16, 503, 400] {
            let m = activation_error_message(s);
            assert!(!m.contains('\u{2014}') && !m.contains('\u{2013}'));
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
    // R11-6 (additive, optional): every OTHER AI request whose output is part
    // of the saved body (the deep tier beside the brief). Each must belong to
    // the same book; each is marked wrote_to_memory with the note's insert.
    contributing_request_ids: Option<Vec<String>>,
    state: State<DbState>,
) -> Result<crate::commands::notes::SavedNote, AppError> {
    let conn = state.lock()?;
    // Same contract as cmd_save_ai_preview_as_note (this command was a verbatim
    // duplicate of it before the DATA-004 typed-outcome change unified them).
    save_ai_note_inner(
        &conn,
        &ai_request_id,
        &contributing_request_ids.unwrap_or_default(),
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

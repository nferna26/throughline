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
    tauri::async_runtime::spawn(async move {
        let mut saw_error = false;
        while let Some(ev) = rx.recv().await {
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

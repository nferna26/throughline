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

#[tauri::command]
pub fn cmd_save_ai_preview_as_note(
    ai_request_id: String,
    note_type: String,
    body: String,
    locator: String,
    chapter_label: Option<String>,
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
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL)",
        params![id, book_id, note_type, locator, chapter_label, body, now],
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
        if let Ok(path) = export::export_note(&book, &note) {
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

#[tauri::command]
pub async fn cmd_ai_ask(
    book_id: String,
    mode: String,
    selection: String,
    chapter: Option<String>,
    locator: Option<String>,
    user_note: Option<String>,
    on_event: tauri::ipc::Channel<ai_client::StreamEvent>,
    state: State<'_, DbState>,
) -> Result<AskHandle, AppError> {
    let stub_mode = ai_stub::StubMode::from_str(&mode)
        .ok_or_else(|| AppError::validation(format!("unknown AI stub mode: {}", mode)))?;
    let trimmed = selection.trim();
    if trimmed.chars().count() < 4 {
        return Err(AppError::validation(
            "Select a passage first — AI calls require a non-trivial text selection.",
        ));
    }

    // Pull settings + book under the lock, then drop it before awaiting.
    let (_book, base_url, model, local_only, ai_id, prompt) = {
        let conn = state.0.lock()?;
        let book = fetch_book(&conn, &book_id)?
            .ok_or_else(|| AppError::not_found("book", Some(book_id.clone())))?;

        let base_url = settings::get_ai_base_url(&conn);
        let model = settings::get_ai_model(&conn);
        if model.trim().is_empty() {
            return Err(AppError::config(
                "No AI model name set. Open Settings → AI and type the model id loaded in your local server (e.g. 'qwen2.5-7b-instruct').",
            ));
        }
        let local_only = settings::get_local_only(&conn);

        let ctx = ai_stub::PromptContext {
            book_title: book.title.clone(),
            author: book.author.clone(),
            chapter: chapter.clone(),
            locator: locator.clone(),
            selection: trimmed.to_string(),
            user_note,
        };
        let prompt = ai_stub::build_prompt(stub_mode, &ctx);

        let parsed = ai_client::validate_base_url(&base_url, local_only).map_err(AppError::from)?;
        let provider_host = parsed.host_str().unwrap_or("").to_string();

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

        (book, base_url, model, local_only, ai_id, prompt)
    };

    let opts = ai_client::ChatCallOpts {
        base_url: base_url.clone(),
        model: model.clone(),
        local_only,
        prompt: prompt.clone(),
        stream: true,
        timeout: std::time::Duration::from_secs(180),
    };

    let started = std::time::Instant::now();
    let provider_host = url::Url::parse(&base_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let mut rx = match ai_client::run_chat_call(opts).await {
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

#[tauri::command]
pub async fn cmd_list_ai_models(state: State<'_, DbState>) -> Result<Vec<String>, AppError> {
    let (base_url, local_only) = {
        let conn = state.0.lock()?;
        (settings::get_ai_base_url(&conn), settings::get_local_only(&conn))
    };
    ai_client::list_models(&base_url, local_only).await.map_err(AppError::from)
}

#[tauri::command]
pub async fn cmd_test_ai_connection(state: State<'_, DbState>) -> Result<ConnTestResult, AppError> {
    let (base_url, local_only) = {
        let conn = state.0.lock()?;
        (settings::get_ai_base_url(&conn), settings::get_local_only(&conn))
    };
    match ai_client::test_connection(&base_url, local_only).await {
        Ok((true, model)) => Ok(ConnTestResult {
            reachable: true,
            first_model_id: model.clone(),
            message: format!(
                "Reachable. First model id: {}",
                model.unwrap_or_else(|| "(no models listed)".to_string())
            ),
        }),
        Ok((false, _)) => Ok(ConnTestResult {
            reachable: false,
            first_model_id: None,
            message: format!("Could not reach {}/models. Is your local server running?", base_url),
        }),
        Err(e) => Err(AppError::ai(format!("{}", e))),
    }
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
        assert_eq!(ids, vec!["a2", "a3", "a1"], "rows ordered newest created_at first");

        let a2 = rows.iter().find(|r| r.id == "a2").unwrap();
        assert_eq!(a2.book_title.as_deref(), Some("Cold Start"));
        assert_eq!(a2.provider.as_deref(), Some("localhost"), "Ask calls record the host");
        assert!(a2.wrote_to_memory, "a2 became a note");

        let a1 = rows.iter().find(|r| r.id == "a1").unwrap();
        assert_eq!(a1.provider, None, "previews never recorded a provider");

        let a3 = rows.iter().find(|r| r.id == "a3").unwrap();
        assert_eq!(a3.book_title, None, "orphaned request has no joined title");
    }
}

#[tauri::command]
pub fn cmd_save_ai_response_as_note(
    ai_request_id: String,
    note_type: String,
    body: String,
    locator: String,
    chapter_label: Option<String>,
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
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL)",
        params![id, book_id, note_type, locator, chapter_label, body, now],
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
        if let Ok(path) = export::export_note(&book, &note) {
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

//! Note CRUD + quote-length warning.

use chrono::Utc;
use rusqlite::params;
use tauri::State;
use uuid::Uuid;

use crate::commands::db_helpers::*;
use crate::db::DbState;
use crate::error::AppError;
use crate::export;
use crate::log;
use crate::models::{Book, Note};

#[tauri::command]
pub fn cmd_save_note(
    book_id: String,
    session_id: Option<String>,
    note_type: String,
    locator: String,
    chapter_label: Option<String>,
    body: String,
    short_quote: Option<String>,
    state: State<DbState>,
) -> Result<Note, AppError> {
    let conn = state.0.lock()?;
    let id = format!("note_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, NULL)",
        params![id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, now],
    )?;

    let mut stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path
         FROM notes WHERE id = ?1",
    )?;
    let mut note = stmt.query_row(params![id], note_from_row)?;

    let book_opt: Option<Book> = fetch_book(&conn, &note.book_id)?;
    if let Some(book) = book_opt {
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

#[tauri::command]
pub fn cmd_list_notes(book_id: String, state: State<DbState>) -> Result<Vec<Note>, AppError> {
    let conn = state.0.lock()?;
    let mut stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path
         FROM notes WHERE book_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![book_id], note_from_row)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

#[tauri::command]
pub fn cmd_quote_warns(quote: String) -> Result<bool, AppError> {
    Ok(export::quote_too_long(&quote))
}

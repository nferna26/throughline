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
use crate::models::Note;

#[tauri::command]
pub fn cmd_save_note(
    book_id: String,
    session_id: Option<String>,
    note_type: String,
    locator: String,
    chapter_label: Option<String>,
    body: String,
    short_quote: Option<String>,
    // Marginalia anchor (all optional; additive in API v2). `locator` stays the
    // primary point; anchor_start/end describe a selection range and
    // anchored_text is the exact highlighted excerpt.
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
    state: State<DbState>,
) -> Result<Note, AppError> {
    let conn = state.0.lock()?;
    let id = format!("note_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, NULL, ?10, ?11, ?12)",
        params![id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, now, anchor_start, anchor_end, anchored_text],
    )?;

    let note = read_note(&conn, &id)?;
    Ok(reexport_note(&conn, note)?)
}

/// Update an existing note in place (autosave / edit on a marginalia card).
/// COALESCE semantics: a `None` field is left unchanged, so the frontend can
/// PATCH just the body during autosave without clobbering type/quote. Re-exports
/// to the SAME stable file so the Markdown mirror updates rather than duplicates.
#[tauri::command]
pub fn cmd_update_note(
    note_id: String,
    note_type: Option<String>,
    body: Option<String>,
    short_quote: Option<String>,
    anchored_text: Option<String>,
    state: State<DbState>,
) -> Result<Note, AppError> {
    let conn = state.0.lock()?;
    let now = Utc::now().to_rfc3339();
    let n = conn.execute(
        "UPDATE notes SET
           note_type = COALESCE(?2, note_type),
           body = COALESCE(?3, body),
           short_quote = COALESCE(?4, short_quote),
           anchored_text = COALESCE(?5, anchored_text),
           updated_at = ?6
         WHERE id = ?1",
        params![note_id, note_type, body, short_quote, anchored_text, now],
    )?;
    if n == 0 {
        return Err(AppError::not_found("note", Some(note_id)));
    }
    let note = read_note(&conn, &note_id)?;
    Ok(reexport_note(&conn, note)?)
}

/// Delete a note and remove its exported Markdown mirror (so the notebook and
/// the export stay in sync — no orphan files). Idempotent: deleting a missing
/// note is a no-op success.
#[tauri::command]
pub fn cmd_delete_note(note_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    let exported: Option<String> = conn
        .query_row(
            "SELECT exported_markdown_path FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id])?;
    if let Some(path) = exported {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

fn read_note(conn: &rusqlite::Connection, id: &str) -> Result<Note, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text
         FROM notes WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![id], note_from_row)?)
}

/// Export `note` to its stable Markdown file and persist the path on the row.
/// Shared by save and update so both keep the mirror current.
fn reexport_note(conn: &rusqlite::Connection, mut note: Note) -> Result<Note, AppError> {
    if let Some(book) = fetch_book(conn, &note.book_id)? {
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
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations;
    use rusqlite::Connection;

    fn migrated() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::apply_pending(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('b1','T',NULL,'txt','/x','sha','2026-05-29',NULL)",
            [],
        )
        .unwrap();
        conn
    }

    fn insert_note(conn: &Connection, id: &str, anchor: Option<(&str, &str, &str)>) {
        let (start, end, text) = match anchor {
            Some((s, e, t)) => (Some(s.to_string()), Some(e.to_string()), Some(t.to_string())),
            None => (None, None, None),
        };
        conn.execute(
            "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
             VALUES (?1,'b1',NULL,'MarginNote',?2,'Chapter 1','my note',NULL,'2026-05-29T10:00:00Z','2026-05-29T10:00:00Z',NULL,?3,?4,?5)",
            params![id, start.clone().unwrap_or_else(|| "char:0".into()), start, end, text],
        )
        .unwrap();
    }

    #[test]
    fn anchor_columns_round_trip_through_hydrator() {
        let conn = migrated();
        insert_note(&conn, "note_a", Some(("char:120", "char:180", "a highlighted run")));
        let note = read_note(&conn, "note_a").unwrap();
        assert_eq!(note.anchor_start.as_deref(), Some("char:120"));
        assert_eq!(note.anchor_end.as_deref(), Some("char:180"));
        assert_eq!(note.anchored_text.as_deref(), Some("a highlighted run"));
        assert_eq!(note.note_type, "MarginNote");
    }

    #[test]
    fn legacy_note_without_anchor_reads_as_none() {
        let conn = migrated();
        insert_note(&conn, "note_b", None);
        let note = read_note(&conn, "note_b").unwrap();
        assert!(note.anchor_start.is_none());
        assert!(note.anchor_end.is_none());
        assert!(note.anchored_text.is_none());
    }

    #[test]
    fn update_coalesce_keeps_unprovided_fields() {
        let conn = migrated();
        insert_note(&conn, "note_c", Some(("char:0", "char:9", "hi")));
        // Mirror cmd_update_note's COALESCE UPDATE: patch body only.
        conn.execute(
            "UPDATE notes SET
               note_type = COALESCE(?2, note_type),
               body = COALESCE(?3, body),
               short_quote = COALESCE(?4, short_quote),
               anchored_text = COALESCE(?5, anchored_text),
               updated_at = ?6
             WHERE id = ?1",
            params!["note_c", Option::<String>::None, Some("edited body"), Option::<String>::None, Option::<String>::None, "2026-05-29T11:00:00Z"],
        )
        .unwrap();
        let note = read_note(&conn, "note_c").unwrap();
        assert_eq!(note.body, "edited body", "body patched");
        assert_eq!(note.note_type, "MarginNote", "type preserved by COALESCE");
        assert_eq!(note.anchored_text.as_deref(), Some("hi"), "anchor preserved");
        assert_ne!(note.updated_at, note.created_at, "updated_at advanced");
    }

    #[test]
    fn delete_removes_row() {
        let conn = migrated();
        insert_note(&conn, "note_d", None);
        conn.execute("DELETE FROM notes WHERE id = ?1", params!["note_d"]).unwrap();
        assert!(read_note(&conn, "note_d").is_err(), "row is gone");
    }
}

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
    reexport_note(&conn, note)
}

/// Update an existing note in place (autosave / edit on a marginalia card).
/// COALESCE semantics: a `None` field is left unchanged, so the frontend can
/// PATCH just the body during autosave without clobbering type/quote. Because
/// `None` means "unchanged", the dedicated `clear_*` flags (additive, API-minor)
/// are the only way to NULL `short_quote` / `anchored_text` once set. Re-exports
/// to the SAME stable file so the Markdown mirror updates rather than duplicates.
#[tauri::command]
pub fn cmd_update_note(
    note_id: String,
    note_type: Option<String>,
    body: Option<String>,
    short_quote: Option<String>,
    anchored_text: Option<String>,
    clear_short_quote: Option<bool>,
    clear_anchored_text: Option<bool>,
    state: State<DbState>,
) -> Result<Note, AppError> {
    let conn = state.0.lock()?;
    update_note_impl(
        &conn,
        &note_id,
        note_type,
        body,
        short_quote,
        anchored_text,
        clear_short_quote,
        clear_anchored_text,
    )
}

/// `cmd_update_note`'s actual body, extracted so it is testable against an
/// in-memory DB (the `#[tauri::command]` wrapper above just locks and delegates).
#[allow(clippy::too_many_arguments)]
fn update_note_impl(
    conn: &rusqlite::Connection,
    note_id: &str,
    note_type: Option<String>,
    body: Option<String>,
    short_quote: Option<String>,
    anchored_text: Option<String>,
    clear_short_quote: Option<bool>,
    clear_anchored_text: Option<bool>,
) -> Result<Note, AppError> {
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
        return Err(AppError::not_found("note", Some(note_id.to_string())));
    }
    // Clears apply AFTER the COALESCE patch (CORE-1023): a flagged field is
    // NULLed even in the same call that patched other fields.
    if clear_short_quote.unwrap_or(false) {
        conn.execute(
            "UPDATE notes SET short_quote = NULL WHERE id = ?1",
            params![note_id],
        )?;
    }
    if clear_anchored_text.unwrap_or(false) {
        conn.execute(
            "UPDATE notes SET anchored_text = NULL WHERE id = ?1",
            params![note_id],
        )?;
    }
    let note = read_note(conn, note_id)?;
    reexport_note(conn, note)
}

/// Delete a note and regenerate its book's literature note so the deleted note's
/// fence is merged OUT of `Books/{slug}.md` (reader edits outside the fences
/// survive). Idempotent: deleting a missing note is a no-op success.
#[tauri::command]
pub fn cmd_delete_note(note_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    // The owning book, captured BEFORE the row is gone, so we can re-merge its file.
    let book_id: Option<String> = conn
        .query_row(
            "SELECT book_id FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get::<_, String>(0),
        )
        .ok();
    conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id])?;
    if let Some(book_id) = book_id {
        let now = Utc::now().to_rfc3339();
        if let Ok(path) =
            export::export_book_literature_note(&conn, &export::root_for(&conn), &book_id, &now)
        {
            log::log_export("book", &path.to_string_lossy());
        }
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

/// Regenerate the note's book-level LITERATURE NOTE (`Books/{slug}.md`) and
/// persist that file's path on the row. The export is per-BOOK now, not per-note:
/// every note change idempotently re-merges the whole book file (the note's fence
/// is replaced/inserted in place; reader edits outside the fences survive), so the
/// `exported_markdown_path` column points at the shared book file.
fn reexport_note(conn: &rusqlite::Connection, mut note: Note) -> Result<Note, AppError> {
    let now = Utc::now().to_rfc3339();
    if let Ok(path) =
        export::export_book_literature_note(conn, &export::root_for(conn), &note.book_id, &now)
    {
        log::log_export("book", &path.to_string_lossy());
        note.exported_markdown_path = Some(path.to_string_lossy().to_string());
        conn.execute(
            "UPDATE notes SET exported_markdown_path = ?1 WHERE id = ?2",
            params![note.exported_markdown_path, note.id],
        )?;
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
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn cmd_quote_warns(quote: String) -> Result<bool, AppError> {
    Ok(export::quote_too_long(&quote))
}

/// Result of a full-library export: how many book literature notes were
/// (re)generated and the export root they landed under.
#[derive(serde::Serialize)]
pub struct LibraryExportResult {
    pub exported: usize,
    pub root: String,
}

/// Regenerate EVERY book's literature note (`Books/{slug}.md`) idempotently —
/// the "Export library" action. Each book is re-merged in place, so reader edits
/// outside the note fences survive. Returns the count exported and the root path.
#[tauri::command]
pub fn cmd_export_library(state: State<DbState>) -> Result<LibraryExportResult, AppError> {
    let conn = state.0.lock()?;
    export_library_inner(&conn)
}

/// `cmd_export_library`'s body, split out so it is testable against a plain
/// `Connection` (the command wrapper just locks and delegates).
fn export_library_inner(conn: &rusqlite::Connection) -> Result<LibraryExportResult, AppError> {
    let root = export::root_for(conn);
    let now = Utc::now().to_rfc3339();
    let mut book_ids: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id FROM books ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            book_ids.push(r?);
        }
    }
    let mut exported = 0usize;
    for book_id in &book_ids {
        if export::export_book_literature_note(conn, &root, book_id, &now).is_ok() {
            exported += 1;
        }
    }
    Ok(LibraryExportResult {
        exported,
        root: root.to_string_lossy().to_string(),
    })
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
            Some((s, e, t)) => (
                Some(s.to_string()),
                Some(e.to_string()),
                Some(t.to_string()),
            ),
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
        insert_note(
            &conn,
            "note_a",
            Some(("char:120", "char:180", "a highlighted run")),
        );
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

    /// Point the Markdown mirror at an isolated temp dir for the duration of
    /// `f` (update_note_impl re-exports through `paths::default_export_root()`,
    /// which honors THROUGHLINE_EXPORT_DIR) and serialize against other
    /// env-touching tests so nothing ever lands in the user's real export folder.
    fn with_isolated_export_dir(label: &str, f: impl FnOnce()) {
        let _g = crate::paths::lock_env_for_test();
        let export_dir = std::env::temp_dir().join(format!("tl-{label}-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }
        f();
        std::fs::remove_dir_all(&export_dir).ok();
        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
    }

    #[test]
    fn update_coalesce_keeps_unprovided_fields() {
        with_isolated_export_dir("note-coalesce-test", || {
            let conn = migrated();
            insert_note(&conn, "note_c", Some(("char:0", "char:9", "hi")));
            // Patch body only: None everywhere else — clear flags included —
            // leaves every other field unchanged.
            let note = update_note_impl(
                &conn,
                "note_c",
                None,
                Some("edited body".to_string()),
                None,
                None,
                None,
                None,
            )
            .unwrap();
            assert_eq!(note.body, "edited body", "body patched");
            assert_eq!(note.note_type, "MarginNote", "type preserved by COALESCE");
            assert_eq!(
                note.anchored_text.as_deref(),
                Some("hi"),
                "anchor preserved"
            );
            assert_ne!(note.updated_at, note.created_at, "updated_at advanced");
        });
    }

    /// CORE-1023 / P3-25: COALESCE semantics alone can never CLEAR a field, so
    /// the dedicated clear flags must NULL short_quote / anchored_text — and the
    /// re-exported Markdown mirror must drop the quote block with it.
    #[test]
    fn update_clear_flags_null_quote_and_anchor_and_update_the_mirror() {
        with_isolated_export_dir("note-clear-test", || {
            let conn = migrated();
            // A MarginNote (not a Highlight): its BODY and its reader short_quote
            // both export, so clearing the quote is observable in the mirror while
            // the body survives. (A Highlight exports its anchored passage as the
            // quote, not body+short_quote, so it can't exercise this clear path.)
            conn.execute(
                "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
                 VALUES ('note_q','b1',NULL,'MarginNote','char:5','Chapter 1','my note','keep me','2026-05-29T10:00:00Z','2026-05-29T10:00:00Z',NULL,'char:5','char:12','anchored run')",
                [],
            )
            .unwrap();

            // Clear the quote only: body/type/anchor untouched.
            let note = update_note_impl(&conn, "note_q", None, None, None, None, Some(true), None)
                .unwrap();
            assert!(note.short_quote.is_none(), "short_quote cleared");
            assert_eq!(note.body, "my note", "body untouched");
            assert_eq!(note.note_type, "MarginNote", "type untouched");
            assert_eq!(
                note.anchored_text.as_deref(),
                Some("anchored run"),
                "anchored_text untouched by the quote clear"
            );
            // The Markdown mirror re-exported without the quote block.
            let md_path = note
                .exported_markdown_path
                .as_deref()
                .expect("mirror re-exported");
            let md = std::fs::read_to_string(md_path).expect("exported markdown exists");
            assert!(
                !md.contains("keep me"),
                "the mirror must drop the cleared quote block:\n{md}"
            );
            assert!(md.contains("my note"), "body still exported");

            // Clear the anchored text with the second flag.
            let note = update_note_impl(&conn, "note_q", None, None, None, None, None, Some(true))
                .unwrap();
            assert!(note.anchored_text.is_none(), "anchored_text cleared");
            assert!(note.short_quote.is_none(), "short_quote stays cleared");
        });
    }

    #[test]
    fn delete_removes_row() {
        let conn = migrated();
        insert_note(&conn, "note_d", None);
        conn.execute("DELETE FROM notes WHERE id = ?1", params!["note_d"])
            .unwrap();
        assert!(read_note(&conn, "note_d").is_err(), "row is gone");
    }
}

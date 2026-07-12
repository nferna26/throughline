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
) -> Result<SavedNote, AppError> {
    let conn = state.lock()?;
    save_note_impl(
        &conn,
        &book_id,
        session_id,
        &note_type,
        &locator,
        chapter_label,
        &body,
        short_quote,
        anchor_start,
        anchor_end,
        anchored_text,
    )
}

/// `cmd_save_note`'s actual body, extracted for hermetic tests (the wrapper
/// just locks and delegates).
#[allow(clippy::too_many_arguments)]
fn save_note_impl(
    conn: &rusqlite::Connection,
    book_id: &str,
    session_id: Option<String>,
    note_type: &str,
    locator: &str,
    chapter_label: Option<String>,
    body: &str,
    short_quote: Option<String>,
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
) -> Result<SavedNote, AppError> {
    let note = commit_note_insert(
        conn,
        book_id,
        session_id,
        note_type,
        locator,
        chapter_label,
        body,
        short_quote,
        anchor_start,
        anchor_end,
        anchored_text,
    )?;
    reexport_note(conn, note)
}

/// R4 CRASH-SAFE MIRROR CONTRACT, phase 1 of note creation: the row INSERT and
/// the durable dirty-book mark commit in ONE transaction, BEFORE any export is
/// attempted. A crash between this commit and the export leaves the mark, so
/// the launch retry heals the stale mirror. (The old order — mutate, attempt
/// export, mark only on export FAILURE — left a crash window with a stale
/// mirror and no mark at all.) Extracted so tests can stop exactly here.
#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_note_insert(
    conn: &rusqlite::Connection,
    book_id: &str,
    session_id: Option<String>,
    note_type: &str,
    locator: &str,
    chapter_label: Option<String>,
    body: &str,
    short_quote: Option<String>,
    anchor_start: Option<String>,
    anchor_end: Option<String>,
    anchored_text: Option<String>,
) -> Result<Note, AppError> {
    let id = format!("note_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, NULL, ?10, ?11, ?12)",
        params![id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, now, anchor_start, anchor_end, anchored_text],
    )?;
    crate::settings::ledger_add(&tx, crate::settings::KEY_PENDING_BOOK_EXPORTS, book_id)
        .map_err(AppError::from)?;
    tx.commit()?;
    read_note(conn, &id)
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
) -> Result<SavedNote, AppError> {
    let conn = state.lock()?;
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
) -> Result<SavedNote, AppError> {
    let now = Utc::now().to_rfc3339();
    // R4: the patch, the clears, and the durable dirty-book mark commit in ONE
    // transaction, before the export attempt (see commit_note_insert).
    let tx = conn.unchecked_transaction()?;
    let n = tx.execute(
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
        tx.execute(
            "UPDATE notes SET short_quote = NULL WHERE id = ?1",
            params![note_id],
        )?;
    }
    if clear_anchored_text.unwrap_or(false) {
        tx.execute(
            "UPDATE notes SET anchored_text = NULL WHERE id = ?1",
            params![note_id],
        )?;
    }
    let book_id: String = tx.query_row(
        "SELECT book_id FROM notes WHERE id = ?1",
        params![note_id],
        |r| r.get(0),
    )?;
    crate::settings::ledger_add(&tx, crate::settings::KEY_PENDING_BOOK_EXPORTS, &book_id)
        .map_err(AppError::from)?;
    tx.commit()?;
    let note = read_note(conn, note_id)?;
    reexport_note(conn, note)
}

/// Delete a note and regenerate its book's literature note so the deleted note's
/// fence is merged OUT of `Books/{slug}.md` (reader edits outside the fences
/// survive). Idempotent: deleting a missing note is a no-op success. Returns the
/// TYPED export outcome (DATA-004): the row deletion is durable either way; a
/// failed re-merge means the file still shows the removed note until a retry
/// (any later export of the book re-merges idempotently).
#[tauri::command]
pub fn cmd_delete_note(
    note_id: String,
    state: State<DbState>,
) -> Result<export::ExportOutcome, AppError> {
    let conn = state.lock()?;
    delete_note_impl(&conn, &note_id)
}

/// Stage a CONFIRMED note removal durably (TRUST-029): written the moment the
/// reader confirms, so quitting inside the Undo window cannot resurrect the
/// note — the launch sweep commits it. Undo calls the unstage command.
#[tauri::command]
pub fn cmd_stage_note_delete(note_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    crate::settings::ledger_add(&conn, crate::settings::KEY_PENDING_NOTE_DELETES, &note_id)
        .map_err(AppError::from)
}

/// Undo within the window: remove the staged id (the note was never deleted).
#[tauri::command]
pub fn cmd_unstage_note_delete(note_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    crate::settings::ledger_remove(&conn, crate::settings::KEY_PENDING_NOTE_DELETES, &note_id)
        .map_err(AppError::from)
}

/// `cmd_delete_note`'s body, extracted for hermetic tests (also the launch
/// sweep's commit path for staged deletions).
pub(crate) fn delete_note_impl(
    conn: &rusqlite::Connection,
    note_id: &str,
) -> Result<export::ExportOutcome, AppError> {
    let Some(book_id) = commit_note_delete(conn, note_id)? else {
        return Ok(export::ExportOutcome::exported()); // no-op delete: nothing to merge
    };
    let now = Utc::now().to_rfc3339();
    match export::export_book_durably(conn, &export::root_for(conn), &book_id, &now) {
        Ok(path) => {
            log::log_export("book", &path.to_string_lossy());
            Ok(export::ExportOutcome::exported())
        }
        Err(e) => Ok(export::ExportOutcome::failed(&e)),
    }
}

/// R4 CRASH-SAFE MIRROR CONTRACT, phase 1 of note deletion: the row DELETE,
/// the pending-delete unstage, and the durable dirty-book mark commit in ONE
/// transaction, before the re-merge export runs (see [`commit_note_insert`]).
/// Returns the owning book id (None for a no-op delete of a missing row).
pub(crate) fn commit_note_delete(
    conn: &rusqlite::Connection,
    note_id: &str,
) -> Result<Option<String>, AppError> {
    let tx = conn.unchecked_transaction()?;
    // The owning book, captured BEFORE the row is gone, so we can re-merge its file.
    let book_id: Option<String> = tx
        .query_row(
            "SELECT book_id FROM notes WHERE id = ?1",
            params![note_id],
            |r| r.get::<_, String>(0),
        )
        .ok();
    tx.execute("DELETE FROM notes WHERE id = ?1", params![note_id])?;
    // Committing clears the pending-delete stage (idempotent when absent).
    let _ = crate::settings::ledger_remove(&tx, crate::settings::KEY_PENDING_NOTE_DELETES, note_id);
    if let Some(book_id) = &book_id {
        crate::settings::ledger_add(&tx, crate::settings::KEY_PENDING_BOOK_EXPORTS, book_id)
            .map_err(AppError::from)?;
    }
    tx.commit()?;
    Ok(book_id)
}

fn read_note(conn: &rusqlite::Connection, id: &str) -> Result<Note, AppError> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text
         FROM notes WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![id], note_from_row)?)
}

/// A durable note save/update plus the TYPED outcome of its Markdown mirror
/// write (DATA-004): the row's durability and the file's freshness are separate
/// facts, so the response carries both instead of a single conflated success.
#[derive(serde::Serialize)]
pub struct SavedNote {
    pub note: Note,
    pub export: export::ExportOutcome,
}

/// Regenerate the note's book-level LITERATURE NOTE (`Books/{slug}.md`) and
/// persist that file's path on the row. The export is per-BOOK now, not per-note:
/// every note change idempotently re-merges the whole book file (the note's fence
/// is replaced/inserted in place; reader edits outside the fences survive), so the
/// `exported_markdown_path` column points at the shared book file.
///
/// An export failure is NOT swallowed and NOT fatal: the note is already durable
/// in SQLite, so the outcome reports `export.ok = false` with a reader-facing
/// message and the caller shows a retry. Retrying any save/update re-runs this
/// merge idempotently.
fn reexport_note(conn: &rusqlite::Connection, mut note: Note) -> Result<SavedNote, AppError> {
    let now = Utc::now().to_rfc3339();
    match export::export_book_durably(conn, &export::root_for(conn), &note.book_id, &now) {
        Ok(path) => {
            log::log_export("book", &path.to_string_lossy());
            note.exported_markdown_path = Some(path.to_string_lossy().to_string());
            conn.execute(
                "UPDATE notes SET exported_markdown_path = ?1 WHERE id = ?2",
                params![note.exported_markdown_path, note.id],
            )?;
            Ok(SavedNote {
                note,
                export: export::ExportOutcome::exported(),
            })
        }
        Err(e) => Ok(SavedNote {
            note,
            export: export::ExportOutcome::failed(&e),
        }),
    }
}

#[tauri::command]
pub fn cmd_list_notes(book_id: String, state: State<DbState>) -> Result<Vec<Note>, AppError> {
    let conn = state.lock()?;
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
/// (re)generated, WHICH books failed (by display title — never a misleading
/// all-good count, DATA-004), and the export root they landed under.
#[derive(serde::Serialize)]
pub struct LibraryExportResult {
    pub exported: usize,
    /// Display titles of books whose export failed. Empty means full success.
    pub failed: Vec<String>,
    pub root: String,
}

/// Regenerate EVERY book's literature note (`Books/{slug}.md`) idempotently —
/// the "Export library" action. Each book is re-merged in place, so reader edits
/// outside the note fences survive. Returns the count exported and the root path.
#[tauri::command]
pub fn cmd_export_library(state: State<DbState>) -> Result<LibraryExportResult, AppError> {
    let conn = state.lock()?;
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
    let mut failed: Vec<String> = Vec::new();
    for book_id in &book_ids {
        match export::export_book_durably(conn, &root, book_id, &now) {
            Ok(_) => exported += 1,
            Err(_) => {
                let title: String = conn
                    .query_row(
                        "SELECT title FROM books WHERE id = ?1",
                        params![book_id],
                        |r| r.get(0),
                    )
                    .unwrap_or_else(|_| book_id.clone());
                failed.push(title);
            }
        }
    }
    Ok(LibraryExportResult {
        exported,
        failed,
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
            let saved = update_note_impl(
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
            assert!(saved.export.ok, "isolated export dir -> mirror updated");
            let note = saved.note;
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
            let saved = update_note_impl(&conn, "note_q", None, None, None, None, Some(true), None)
                .unwrap();
            assert!(saved.export.ok, "isolated export dir -> mirror updated");
            let note = saved.note;
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
                .unwrap()
                .note;
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

    // ── DATA-004: typed outcomes — durable row vs Markdown mirror ──

    /// A save whose Markdown export fails must still be DURABLE in SQLite and
    /// must report the failure in the typed outcome — never a bare success.
    #[test]
    fn save_note_with_broken_export_target_is_durable_and_reports_failure() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-note-savefail-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        // Books as a stray FILE: every literature-note export fails against it.
        std::fs::write(export_dir.join("Books"), b"in the way").unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        let saved = save_note_impl(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:3",
            Some("Chapter 1".into()),
            "durable words",
            None,
            None,
            None,
            None,
        )
        .expect("the DB save itself succeeds");

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();

        assert!(
            !saved.export.ok,
            "export failure must be reported, not swallowed"
        );
        let msg = saved.export.message.as_deref().unwrap_or_default();
        assert!(
            msg.contains("Saved in Throughline"),
            "message must affirm the durable save: {msg}"
        );
        // The row is durable with the body intact.
        let body: String = conn
            .query_row(
                "SELECT body FROM notes WHERE id = ?1",
                params![saved.note.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(body, "durable words");
    }

    /// Deleting a note whose re-merge fails must report the typed failure and
    /// leave the previously exported file byte-identical (stale, never gone).
    #[cfg(unix)]
    #[test]
    fn delete_note_export_failure_keeps_prior_file_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-note-delfail-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        let saved = save_note_impl(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:3",
            None,
            "words",
            None,
            None,
            None,
            None,
        )
        .expect("save");
        assert!(saved.export.ok, "clean dir → export ok");
        let md_path = saved.note.exported_markdown_path.clone().unwrap();
        let before = std::fs::read(&md_path).unwrap();

        let books = export_dir.join("Books");
        std::fs::set_permissions(&books, std::fs::Permissions::from_mode(0o555)).unwrap();
        let perms_enforced = std::fs::write(books.join(".probe"), b"x").is_err();
        let outcome = if perms_enforced {
            Some(delete_note_impl(&conn, &saved.note.id).expect("delete itself succeeds"))
        } else {
            None
        };
        std::fs::set_permissions(&books, std::fs::Permissions::from_mode(0o755)).unwrap();
        let after = std::fs::read(&md_path).unwrap();

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();

        let Some(outcome) = outcome else {
            eprintln!("skipping delete-failure assertion: permissions not enforced (root?)");
            return;
        };
        assert!(!outcome.ok, "the failed re-merge must be reported");
        assert!(
            read_note(&conn, &saved.note.id).is_err(),
            "the row deletion is durable regardless"
        );
        assert_eq!(before, after, "prior file bytes preserved on failure");
    }

    /// The full-library export must name every failed book — a bare success
    /// count that silently omits failures is a misleading result.
    #[test]
    fn library_export_reports_each_failed_book() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir = std::env::temp_dir().join(format!("tl-lib-mixed-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(export_dir.join("Books")).unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated(); // book b1 ("T")
        conn.execute(
            "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('b2','Broken Book',NULL,'txt','/y','sha2','2026-05-30',NULL)",
            [],
        )
        .unwrap();
        // Sabotage exactly book b2: its destination path exists as a DIRECTORY,
        // so its read fails (not NotFound) while b1 exports cleanly.
        let b2 = crate::commands::db_helpers::fetch_book(&conn, "b2")
            .unwrap()
            .unwrap();
        let b2_dest = export::book_note_path(&export_dir, &b2);
        std::fs::create_dir_all(&b2_dest).unwrap();

        let result = export_library_inner(&conn).expect("library export returns a result");

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();

        assert_eq!(result.exported, 1, "only the clean book counts as exported");
        assert_eq!(
            result.failed,
            vec!["Broken Book".to_string()],
            "every failed book is reported by title"
        );
    }

    // ── TRUST-029: confirmed removals survive quit/relaunch; Undo restores ──

    /// Confirm (stage) → "quit" → the launch sweep commits: the row is gone and
    /// the shared export re-merged. Unstage (Undo) before the sweep → survives.
    #[test]
    fn staged_note_delete_commits_at_launch_and_unstage_restores() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir = std::env::temp_dir().join(format!("tl-staged-del-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        let doomed = save_note_impl(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:1",
            None,
            "doomed words",
            None,
            None,
            None,
            None,
        )
        .expect("save doomed");
        let spared = save_note_impl(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:9",
            None,
            "spared words",
            None,
            None,
            None,
            None,
        )
        .expect("save spared");
        let md_path = doomed.note.exported_markdown_path.clone().unwrap();

        // The reader confirms BOTH removals (X), then Undoes one, then "quits".
        crate::settings::ledger_add(
            &conn,
            crate::settings::KEY_PENDING_NOTE_DELETES,
            &doomed.note.id,
        )
        .unwrap();
        crate::settings::ledger_add(
            &conn,
            crate::settings::KEY_PENDING_NOTE_DELETES,
            &spared.note.id,
        )
        .unwrap();
        crate::settings::ledger_remove(
            &conn,
            crate::settings::KEY_PENDING_NOTE_DELETES,
            &spared.note.id,
        )
        .unwrap();

        // "Relaunch": the sweep commits what stayed staged.
        let (notes_done, books_done) = crate::commands::commit_pending_deletes(&conn).unwrap();
        assert_eq!((notes_done, books_done), (1, 0));

        assert!(
            read_note(&conn, &doomed.note.id).is_err(),
            "confirmed removal is REMOVED after relaunch"
        );
        assert!(
            read_note(&conn, &spared.note.id).is_ok(),
            "Undo (unstage) restored the other"
        );
        let md = std::fs::read_to_string(&md_path).unwrap();
        assert!(
            !md.contains("doomed words"),
            "export re-merged without the removed note"
        );
        assert!(
            md.contains("spared words"),
            "surviving note's fence remains"
        );
        // The ledger drained; a second sweep is a no-op.
        assert_eq!(
            crate::commands::commit_pending_deletes(&conn).unwrap(),
            (0, 0)
        );

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();
    }

    // ── DATA-005: durable dirty-book export ledger + launch retry ──

    /// INJECTED export failure (Books as a stray file): the failed mirror must
    /// leave a DURABLE dirty mark, and the launch retry
    /// (`retry_pending_exports`, exactly what `run()` calls) must heal the file
    /// and clear the mark once the export target works again — the reader never
    /// has to press "try again".
    #[test]
    fn failed_export_marks_book_dirty_and_launch_retry_heals_it() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-dirty-ledger-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        // Injected failure: Books as a FILE fails every literature-note export.
        std::fs::write(export_dir.join("Books"), b"in the way").unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        let saved = save_note_impl(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:3",
            None,
            "durable words",
            None,
            None,
            None,
            None,
        )
        .expect("the DB save itself succeeds");
        assert!(!saved.export.ok, "broken target → export failure reported");
        assert_eq!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS),
            vec!["b1".to_string()],
            "the failure left a DURABLE dirty mark for the book"
        );

        // Relaunch #1 with the target STILL broken: the retry fails again and
        // the mark survives — never silently dropped.
        assert_eq!(crate::commands::retry_pending_exports(&conn), (0, 1));
        assert_eq!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS),
            vec!["b1".to_string()]
        );

        // The target recovers; relaunch #2 heals the mirror and drains the mark.
        std::fs::remove_file(export_dir.join("Books")).unwrap();
        assert_eq!(crate::commands::retry_pending_exports(&conn), (1, 0));
        assert!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS)
                .is_empty(),
            "healed → mark cleared"
        );
        let books_dir = export_dir.join("Books");
        let md_file = std::fs::read_dir(&books_dir)
            .expect("Books dir exists after healing")
            .filter_map(|e| e.ok())
            .find(|e| e.path().extension().is_some_and(|x| x == "md"))
            .expect("the healed mirror exists");
        let md = std::fs::read_to_string(md_file.path()).unwrap();
        assert!(md.contains("durable words"), "mirror caught up with the DB");

        // A later successful export path also keeps the ledger empty (idempotent).
        assert_eq!(crate::commands::retry_pending_exports(&conn), (0, 0));

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();
    }

    /// R4 CRASH SEAM: the process stops immediately AFTER the note mutation
    /// commits and BEFORE any export runs (the exact window the old
    /// mark-on-export-failure design left unprotected). The durable dirty mark
    /// commits WITH the mutation, so the relaunch retry heals the mirror.
    #[test]
    fn crash_between_commit_and_export_leaves_a_mark_and_relaunch_heals() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir = std::env::temp_dir().join(format!("tl-crash-seam-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        // Phase 1 ONLY (the transaction) — the "crash" is simply never
        // running the export phase.
        let note = commit_note_insert(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:3",
            None,
            "words that must reach the mirror",
            None,
            None,
            None,
            None,
        )
        .expect("commit phase");
        assert_eq!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS),
            vec!["b1".to_string()],
            "the dirty mark committed WITH the row"
        );
        assert!(
            !export_dir.join("Books").exists(),
            "no export ran — the mirror is stale, exactly like a crash"
        );

        // "Relaunch": the launch retry heals the mirror and clears the mark.
        assert_eq!(crate::commands::retry_pending_exports(&conn), (1, 0));
        let books_dir = export_dir.join("Books");
        let md_file = std::fs::read_dir(&books_dir)
            .expect("Books dir exists after healing")
            .flatten()
            .find(|e| e.path().extension().is_some_and(|x| x == "md"))
            .expect("healed mirror exists");
        let md = std::fs::read_to_string(md_file.path()).unwrap();
        assert!(md.contains("words that must reach the mirror"));
        assert!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS)
                .is_empty()
        );

        // The DELETE phase has the same contract: crash after commit → mark.
        assert_eq!(
            commit_note_delete(&conn, &note.id).expect("delete commit phase"),
            Some("b1".to_string())
        );
        assert_eq!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS),
            vec!["b1".to_string()],
            "the delete's dirty mark committed WITH the row removal"
        );
        assert_eq!(crate::commands::retry_pending_exports(&conn), (1, 0));
        let md = std::fs::read_to_string(md_file.path()).unwrap();
        assert!(
            !md.contains("words that must reach the mirror"),
            "the healed mirror re-merged the deletion"
        );

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();
    }

    /// R5: the mirror rename alone is not durable — the export's parent
    /// directory is fsynced BEFORE the dirty mark is cleared. An injected
    /// fsync failure must keep the LEDGER DIRTY (the file is present but not
    /// proven durable), and the launch retry then heals it idempotently.
    #[test]
    fn export_fsync_failure_keeps_the_ledger_dirty_until_a_durable_retry() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-fsync-dirty-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        let note = commit_note_insert(
            &conn,
            "b1",
            None,
            "MarginNote",
            "char:3",
            None,
            "durably mirrored words",
            None,
            None,
            None,
            None,
        )
        .expect("commit phase");
        let _ = note;

        // The export itself succeeds; the DURABILITY fsync is injected to fail.
        let root = crate::export::root_for(&conn);
        let result = crate::export::export_book_durably_with(
            &conn,
            &root,
            "b1",
            "2026-07-10T00:00:00Z",
            |_| Err(std::io::Error::other("injected fsync failure")),
        );
        let err = result.expect_err("a failed durability fsync must be an error");
        assert!(
            format!("{err:#}").contains("fsync export dir"),
            "names the failed step: {err:#}"
        );
        // The mirror FILE exists (the rename landed) …
        let md_present = std::fs::read_dir(export_dir.join("Books"))
            .unwrap()
            .flatten()
            .any(|e| e.path().extension().is_some_and(|x| x == "md"));
        assert!(md_present, "the rename itself landed");
        // … but the ledger stays DIRTY: not-proven-durable is not clean.
        assert_eq!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS),
            vec!["b1".to_string()],
            "the mark must survive an unproven export"
        );

        // The launch retry (real fsync) heals and clears the mark.
        assert_eq!(crate::commands::retry_pending_exports(&conn), (1, 0));
        assert!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS)
                .is_empty()
        );

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();
    }

    /// A dirty mark for a book that no longer exists (removed after the failed
    /// export) has no mirror to heal: the launch retry clears it instead of
    /// erroring forever.
    #[test]
    fn dirty_mark_for_a_removed_book_is_cleared_not_retried_forever() {
        let _g = crate::paths::lock_env_for_test();
        let export_dir = std::env::temp_dir().join(format!("tl-dirty-gone-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = migrated();
        crate::settings::ledger_add(
            &conn,
            crate::settings::KEY_PENDING_BOOK_EXPORTS,
            "gone_book",
        )
        .unwrap();
        assert_eq!(crate::commands::retry_pending_exports(&conn), (0, 0));
        assert!(
            crate::settings::ledger_ids(&conn, crate::settings::KEY_PENDING_BOOK_EXPORTS)
                .is_empty()
        );

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        std::fs::remove_dir_all(&export_dir).ok();
    }
}

//! Tauri command surface.
//!
//! Each submodule owns a cohesive group of commands and the row-shaped DB
//! helpers it relies on. `db_helpers` holds the cross-cutting hydration +
//! insert helpers used by more than one command module.
//!
//! Registration with Tauri happens in `crate::run()` via the
//! `tauri::generate_handler!` macro referencing `commands::<module>::<fn>`.

pub mod ai;
pub mod backups;
pub mod books;
pub mod db_helpers;
pub mod discover;
pub mod feedback;
pub mod notes;
pub mod plans;
pub mod sessions;
pub mod settings_cmds;

/// TRUST-029: commit every staged (reader-CONFIRMED) note/book removal. Runs at
/// launch, before any command can observe the rows — so a quit inside the Undo
/// window leaves the removal removed, exactly as confirmed. Returns
/// (notes_committed, books_committed). Individual failures are logged and the
/// id stays staged for the next launch (never silently dropped).
pub fn commit_pending_deletes(
    conn: &rusqlite::Connection,
) -> Result<(usize, usize), crate::error::AppError> {
    let mut notes_done = 0usize;
    for id in crate::settings::ledger_ids(conn, crate::settings::KEY_PENDING_NOTE_DELETES) {
        match notes::delete_note_impl(conn, &id) {
            Ok(_) => notes_done += 1,
            Err(e) => tracing::warn!("staged note delete could not commit: {e}"),
        }
    }
    let mut books_done = 0usize;
    for id in crate::settings::ledger_ids(conn, crate::settings::KEY_PENDING_BOOK_DELETES) {
        match books::delete_book_completely(conn, &id) {
            Ok(()) => books_done += 1,
            Err(e) => tracing::warn!("staged book delete could not commit: {e}"),
        }
    }
    Ok((notes_done, books_done))
}

/// DATA-005: re-run the Markdown mirror for every book the dirty-export ledger
/// marks (an export failed after a durable row change and the reader may never
/// have pressed "try again"). Runs at launch, AFTER `commit_pending_deletes`,
/// so books removed by the sweep fall into the gone-book branch here. Returns
/// (healed, still_dirty). A book that no longer exists has no mirror to heal —
/// its mark is cleared. A retry that fails again keeps its mark (never
/// silently dropped) for the next launch.
pub fn retry_pending_exports(conn: &rusqlite::Connection) -> (usize, usize) {
    let mut healed = 0usize;
    let mut still_dirty = 0usize;
    let now = chrono::Utc::now().to_rfc3339();
    let root = crate::export::root_for(conn);
    for book_id in crate::settings::ledger_ids(conn, crate::settings::KEY_PENDING_BOOK_EXPORTS) {
        let exists = conn
            .query_row(
                "SELECT 1 FROM books WHERE id = ?1",
                rusqlite::params![book_id],
                |_| Ok(()),
            )
            .is_ok();
        if !exists {
            let _ = crate::settings::ledger_remove(
                conn,
                crate::settings::KEY_PENDING_BOOK_EXPORTS,
                &book_id,
            );
            continue;
        }
        // export_book_durably clears the mark on success and re-marks on failure.
        match crate::export::export_book_durably(conn, &root, &book_id, &now) {
            Ok(_) => healed += 1,
            Err(e) => {
                still_dirty += 1;
                tracing::warn!(category = "export", "launch export retry failed: {e:#}");
            }
        }
    }
    (healed, still_dirty)
}

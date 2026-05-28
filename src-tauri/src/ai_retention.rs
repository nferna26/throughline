//! AI request audit retention — cto-kb `adr-001-reading-gym-ai-requests-retention`.
//!
//! Every prompt preview and Ask call is logged to `ai_requests` so the user can
//! audit what the local-only AI surface was asked. Without a bound, that audit
//! trail grows forever and ephemeral previews never fade — drifting from the
//! PRD's "ephemeral unless approved" posture. This module bounds it: a sweep
//! runs once per launch (see `lib::run`) deleting rows older than the configured
//! window.
//!
//! **The load-bearing predicate** (adr-001): delete `created_at < cutoff AND
//! wrote_to_memory = 0`. Rows with `wrote_to_memory = 1` became durable Notes;
//! they mirror the notes table's lifetime and are kept regardless of age. So
//! the audit join "which previews became notes" survives, while discarded
//! previews actually fade.

use rusqlite::{params, Connection};

/// Default retention window in days. A user can shrink (stricter) or grow
/// (longer audit) this in Settings.
pub const DEFAULT_RETENTION_DAYS: i64 = 90;

/// Delete audit rows older than `days` that never became a note. Returns the
/// number of rows removed. `days <= 0` disables the sweep (keep everything) so
/// a user can opt into an unbounded audit trail.
///
/// `datetime(created_at)` normalizes the stored RFC3339 timestamp (with `T` and
/// `+00:00` offset) to UTC before comparing against `datetime('now', '-N days')`,
/// so the comparison is correct regardless of the textual format.
pub fn sweep(conn: &Connection, days: i64) -> rusqlite::Result<usize> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = format!("-{} days", days);
    let removed = conn.execute(
        "DELETE FROM ai_requests
         WHERE wrote_to_memory = 0
           AND datetime(created_at) < datetime('now', ?1)",
        params![cutoff],
    )?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE ai_requests (
                id TEXT PRIMARY KEY, book_id TEXT NOT NULL, mode TEXT NOT NULL,
                locator TEXT, context_char_count INTEGER, provider TEXT,
                created_at TEXT NOT NULL, wrote_to_memory INTEGER DEFAULT 0
             );",
        ).unwrap();
    }

    fn insert(conn: &Connection, id: &str, created_at: &str, wrote: i64) {
        conn.execute(
            "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
             VALUES (?1, 'b', 'explain', 'char:0', 10, NULL, ?2, ?3)",
            params![id, created_at, wrote],
        ).unwrap();
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM ai_requests", [], |r| r.get(0)).unwrap()
    }

    /// The load-bearing invariant: old + never-saved rows are swept; old + saved
    /// (wrote_to_memory=1) rows are kept; recent rows are kept regardless.
    #[test]
    fn sweep_deletes_old_unsaved_keeps_saved_and_recent() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        insert(&conn, "old_unsaved", "2020-01-01T00:00:00+00:00", 0); // → deleted
        insert(&conn, "old_saved",   "2020-01-01T00:00:00+00:00", 1); // → kept (mirrors a note)
        let recent = chrono::Utc::now().to_rfc3339();
        insert(&conn, "recent_unsaved", &recent, 0);                  // → kept (within window)

        let removed = sweep(&conn, 90).unwrap();
        assert_eq!(removed, 1, "exactly the old unsaved row should be swept");
        assert_eq!(count(&conn), 2);
        // The kept ids are the saved-old one and the recent one.
        let kept: Vec<String> = conn
            .prepare("SELECT id FROM ai_requests ORDER BY id").unwrap()
            .query_map([], |r| r.get::<_, String>(0)).unwrap()
            .filter_map(|r| r.ok()).collect();
        assert_eq!(kept, vec!["old_saved".to_string(), "recent_unsaved".to_string()]);
    }

    /// `days <= 0` is an explicit opt-out: keep the full audit trail.
    #[test]
    fn sweep_disabled_when_days_non_positive() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        insert(&conn, "old", "2000-01-01T00:00:00+00:00", 0);
        assert_eq!(sweep(&conn, 0).unwrap(), 0);
        assert_eq!(sweep(&conn, -5).unwrap(), 0);
        assert_eq!(count(&conn), 1, "nothing swept when retention is disabled");
    }
}

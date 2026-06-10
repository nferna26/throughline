//! AI request audit retention — cto-kb `adr-001-throughline-ai-requests-retention`.
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
    // One transaction for child + parent deletes: `ai_request_usage` references
    // `ai_requests` with no cascade and `foreign_keys = ON`, so the children of
    // every about-to-be-swept row must go first — otherwise the parent DELETE
    // aborts wholesale and the retention promise silently stops holding.
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM ai_request_usage
         WHERE request_id IN (
            SELECT id FROM ai_requests
            WHERE wrote_to_memory = 0
              AND datetime(created_at) < datetime('now', ?1))",
        params![cutoff],
    )?;
    let removed = tx.execute(
        "DELETE FROM ai_requests
         WHERE wrote_to_memory = 0
           AND datetime(created_at) < datetime('now', ?1)",
        params![cutoff],
    )?;
    tx.commit()?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_providers::TokenUsage;

    /// The REAL schema with FK enforcement, exactly as production opens the DB.
    /// An earlier hand-rolled schema here had no ai_request_usage table and no
    /// foreign_keys pragma — which is how the usage-FK sweep abort stayed
    /// invisible to the suite.
    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, source_type, source_path, source_sha256, created_at)
             VALUES ('b', 'T', 'txt', '/p', 'h', '2026-01-01')",
            [],
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, created_at: &str, wrote: i64) {
        conn.execute(
            "INSERT INTO ai_requests (id, book_id, mode, locator, context_char_count, provider, created_at, wrote_to_memory)
             VALUES (?1, 'b', 'explain', 'char:0', 10, NULL, ?2, ?3)",
            params![id, created_at, wrote],
        ).unwrap();
    }

    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM ai_requests", [], |r| r.get(0))
            .unwrap()
    }

    /// The load-bearing invariant: old + never-saved rows are swept; old + saved
    /// (wrote_to_memory=1) rows are kept; recent rows are kept regardless.
    #[test]
    fn sweep_deletes_old_unsaved_keeps_saved_and_recent() {
        let conn = conn();
        insert(&conn, "old_unsaved", "2020-01-01T00:00:00+00:00", 0); // → deleted
        insert(&conn, "old_saved", "2020-01-01T00:00:00+00:00", 1); // → kept (mirrors a note)
        let recent = chrono::Utc::now().to_rfc3339();
        insert(&conn, "recent_unsaved", &recent, 0); // → kept (within window)

        let removed = sweep(&conn, 90).unwrap();
        assert_eq!(removed, 1, "exactly the old unsaved row should be swept");
        assert_eq!(count(&conn), 2);
        // The kept ids are the saved-old one and the recent one.
        let kept: Vec<String> = conn
            .prepare("SELECT id FROM ai_requests ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(
            kept,
            vec!["old_saved".to_string(), "recent_unsaved".to_string()]
        );
    }

    /// `days <= 0` is an explicit opt-out: keep the full audit trail.
    #[test]
    fn sweep_disabled_when_days_non_positive() {
        let conn = conn();
        insert(&conn, "old", "2000-01-01T00:00:00+00:00", 0);
        assert_eq!(sweep(&conn, 0).unwrap(), 0);
        assert_eq!(sweep(&conn, -5).unwrap(), 0);
        assert_eq!(count(&conn), 1, "nothing swept when retention is disabled");
    }

    /// REGRESSION (review P1-2 / CORE-1000): every cloud Ask writes an
    /// `ai_request_usage` child row, and the FK to `ai_requests` has no cascade.
    /// The sweep must remove those children first — otherwise the parent DELETE
    /// aborts wholesale (one usage-bearing old row blocks sweeping EVERYTHING,
    /// forever, and the reader-facing "Forget now" button errors).
    #[test]
    fn sweep_succeeds_when_old_rows_have_usage_children() {
        let conn = conn();
        insert(&conn, "req_old_usage", "2020-01-01T00:00:00+00:00", 0);
        crate::commands::ai::write_usage_row(
            &conn,
            "req_old_usage",
            "anthropic",
            "claude-sonnet-4-6",
            &TokenUsage {
                input_tokens: 100,
                output_tokens: 50,
                ..Default::default()
            },
        )
        .expect("usage child row");
        insert(&conn, "req_old_plain", "2020-01-01T00:00:00+00:00", 0);
        insert(&conn, "req_old_saved", "2020-01-01T00:00:00+00:00", 1);
        let recent = chrono::Utc::now().to_rfc3339();
        insert(&conn, "req_recent", &recent, 0);

        let removed = sweep(&conn, 90).expect("sweep must not abort on the usage FK");
        assert_eq!(removed, 2, "both old unsaved rows are swept");

        let usage_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_request_usage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            usage_left, 0,
            "the swept request's usage child goes with it"
        );

        let kept: Vec<String> = conn
            .prepare("SELECT id FROM ai_requests ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(
            kept,
            vec!["req_old_saved".to_string(), "req_recent".to_string()],
            "saved-old and recent rows survive"
        );
    }
}

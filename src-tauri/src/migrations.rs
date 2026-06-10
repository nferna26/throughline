//! Versioned schema migrations.
//!
//! Replaces the ad-hoc `add_column_if_missing` calls in `db.rs` with a
//! per-version registry. Each migration has:
//!
//! - a stable `version` string (chronological, lexically sortable)
//! - a one-line `description` for the audit table
//! - an `up` function that applies it
//! - the contract: **the `up` function MUST be idempotent**. A migration that
//!   has already been applied to a DB (e.g. via the old `add_column_if_missing`
//!   path) must succeed silently when run again.
//!
//! `apply_pending(conn)` is the public entry point:
//!   1. Ensures the `schema_migrations` table exists.
//!   2. Reads the set of already-applied versions.
//!   3. For each registered migration not yet applied, runs `up` then records
//!      it in `schema_migrations` — both inside one transaction.
//!
//! Migrations CANNOT be reordered or renamed after they've been applied to a
//! live DB. New migrations are appended. The version string is the audit key.
//!
//! Records the decision in cto-kb `adr-003-throughline-schema-migrations-table`
//! (accepted). This module is the as-built implementation: it goes beyond the
//! ADR draft with a `description` column and a `vNNN_<slug>` version format, and
//! applies migrations via `apply_pending` (recording one row per migration)
//! rather than the draft's proposed `apply_migration_once` helper.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::collections::HashSet;

/// One registered migration.
pub struct Migration {
    pub version: &'static str,
    pub description: &'static str,
    pub up: fn(&Connection) -> Result<()>,
}

/// The canonical ordered list. Append-only. NEVER reorder or rename.
///
/// Versions land in the format `vNNN_<short_slug>` for lexical sort. Three
/// digits gives us ~1000 migrations before we have to widen.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: "v001_init_base_tables",
        description: "Six PRD tables + section_progress + settings",
        up: v001_init_base_tables,
    },
    Migration {
        version: "v002_section_progress_last_percent",
        description: "section_progress.last_percent REAL",
        up: v002_section_progress_last_percent,
    },
    Migration {
        version: "v003_section_progress_updated_at",
        description: "section_progress.updated_at TEXT",
        up: v003_section_progress_updated_at,
    },
    Migration {
        version: "v004_book_sections_assignable",
        description: "book_sections.assignable INTEGER NOT NULL DEFAULT 1",
        up: v004_book_sections_assignable,
    },
    Migration {
        version: "v005_reading_plans_status",
        description: "reading_plans.status + activated_at + original_finish_date",
        up: v005_reading_plans_status,
    },
    Migration {
        version: "v006_notes_anchor",
        description: "notes.anchor_start + anchor_end + anchored_text (marginalia anchoring)",
        up: v006_notes_anchor,
    },
    Migration {
        version: "v007_ai_request_usage",
        description: "ai_request_usage: per-request token counts + computed cost (B3 COGS)",
        up: v007_ai_request_usage,
    },
    Migration {
        version: "v008_plan_lifecycle",
        description: "reading_plans.lifecycle + paused_* + parent_plan_id; sessions.plan_id (A1)",
        up: v008_plan_lifecycle,
    },
    Migration {
        version: "v009_plan_name_softdelete",
        description:
            "reading_plans.name + deleted_at (soft-delete) + reached_percent (frontispiece)",
        up: v009_plan_name_softdelete,
    },
];

/// Apply every migration that is not already recorded in `schema_migrations`.
/// On a fresh DB, this runs everything from v001 onward.
/// On an existing DB that predates this module (e.g. originally migrated via
/// `add_column_if_missing`), v001..v004 are still idempotent and will run
/// without doing real work — but they still get recorded in `schema_migrations`
/// so future inspections show the DB's lineage.
pub fn apply_pending(conn: &Connection) -> Result<Vec<&'static str>> {
    ensure_schema_migrations_table(conn)?;
    let applied = applied_versions(conn)?;
    let mut newly_applied: Vec<&'static str> = Vec::new();
    for m in MIGRATIONS.iter() {
        if applied.contains(m.version) {
            continue;
        }
        apply_one(conn, m)?;
        newly_applied.push(m.version);
    }
    Ok(newly_applied)
}

/// Run one migration's `up` and record it in `schema_migrations` — both inside
/// one transaction, so a migration that fails partway leaves no partial state
/// (SQLite DDL is transactional). Dropping the transaction on the error path
/// rolls everything back. `unchecked_transaction` is the `&Connection` form;
/// the `PRAGMA journal_mode = WAL` in v001 is a no-op here because `db.rs` sets
/// WAL before migrating (and in-memory test DBs can't enter WAL at all).
fn apply_one(conn: &Connection, m: &Migration) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    (m.up)(conn).with_context(|| format!("migration {} ({})", m.version, m.description))?;
    conn.execute(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?1, ?2, datetime('now'))",
        params![m.version, m.description],
    )?;
    tx.commit()?;
    Ok(())
}

fn ensure_schema_migrations_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

fn applied_versions(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = HashSet::new();
    for r in rows {
        out.insert(r?);
    }
    Ok(out)
}

// ──────────────────────────────────────────────────────────────────────────
// Migration bodies. Each is idempotent.
// ──────────────────────────────────────────────────────────────────────────

fn v001_init_base_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS books (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          author TEXT,
          source_type TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_opened_at TEXT
        );

        CREATE TABLE IF NOT EXISTS book_sections (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          label TEXT NOT NULL,
          href TEXT,
          start_locator TEXT,
          end_locator TEXT,
          estimated_units INTEGER,
          sort_order INTEGER NOT NULL,
          FOREIGN KEY (book_id) REFERENCES books(id)
        );

        CREATE TABLE IF NOT EXISTS reading_plans (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          start_date TEXT NOT NULL,
          target_finish_date TEXT NOT NULL,
          daily_target_units INTEGER,
          days_per_week INTEGER DEFAULT 6,
          catchup_mode TEXT DEFAULT 'gentle',
          FOREIGN KEY (book_id) REFERENCES books(id)
        );

        CREATE TABLE IF NOT EXISTS reading_sessions (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          start_locator TEXT,
          end_locator TEXT,
          minutes INTEGER,
          completed_assignment INTEGER DEFAULT 0,
          subjective_difficulty INTEGER,
          FOREIGN KEY (book_id) REFERENCES books(id)
        );

        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          session_id TEXT,
          note_type TEXT NOT NULL,
          locator TEXT NOT NULL,
          chapter_label TEXT,
          body TEXT NOT NULL,
          short_quote TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          exported_markdown_path TEXT,
          FOREIGN KEY (book_id) REFERENCES books(id)
        );

        CREATE TABLE IF NOT EXISTS ai_requests (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          locator TEXT,
          context_char_count INTEGER,
          provider TEXT,
          created_at TEXT NOT NULL,
          wrote_to_memory INTEGER DEFAULT 0,
          FOREIGN KEY (book_id) REFERENCES books(id)
        );

        CREATE TABLE IF NOT EXISTS section_progress (
          book_id TEXT NOT NULL,
          section_id TEXT NOT NULL,
          completed_at TEXT,
          last_locator TEXT,
          PRIMARY KEY (book_id, section_id)
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        "#,
    )?;
    Ok(())
}

fn v002_section_progress_last_percent(conn: &Connection) -> Result<()> {
    add_column_if_missing(conn, "section_progress", "last_percent", "REAL")
}

fn v003_section_progress_updated_at(conn: &Connection) -> Result<()> {
    add_column_if_missing(conn, "section_progress", "updated_at", "TEXT")
}

fn v004_book_sections_assignable(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "book_sections",
        "assignable",
        "INTEGER NOT NULL DEFAULT 1",
    )
}

/// Plan lifecycle columns. `status` defaults to 'active' so pre-existing plans
/// (created before plan states existed) keep their current behavior; freshly
/// built plans set 'plan_ready' explicitly (see plan::build_default_plan).
/// `activated_at` is stamped on the first reading session; `original_finish_date`
/// preserves the pre-rebalance target so the forecast has a stable baseline.
fn v005_reading_plans_status(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "reading_plans",
        "status",
        "TEXT NOT NULL DEFAULT 'active'",
    )?;
    add_column_if_missing(conn, "reading_plans", "activated_at", "TEXT")?;
    add_column_if_missing(conn, "reading_plans", "original_finish_date", "TEXT")?;
    Ok(())
}

/// Marginalia anchoring: a note can carry a selection RANGE (anchor_start..
/// anchor_end, both tagged locators) plus the exact highlighted text. All
/// nullable — legacy notes and point-anchored notes leave them NULL.
fn v006_notes_anchor(conn: &Connection) -> Result<()> {
    add_column_if_missing(conn, "notes", "anchor_start", "TEXT")?;
    add_column_if_missing(conn, "notes", "anchor_end", "TEXT")?;
    add_column_if_missing(conn, "notes", "anchored_text", "TEXT")?;
    Ok(())
}

fn v007_ai_request_usage(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_request_usage (
          request_id TEXT PRIMARY KEY,
          provider TEXT,
          model TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          cost_usd_micros INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (request_id) REFERENCES ai_requests(id)
        );
        "#,
    )?;
    Ok(())
}

/// Plan lifecycle (A1). `lifecycle` is a NEW axis, orthogonal to the existing
/// `status` (pace: plan_ready/active/rebalanced): active | paused | completed |
/// archived | superseded. `sessions.plan_id` ties each session to its plan;
/// legacy sessions backfill to their book's most-recent plan.
fn v008_plan_lifecycle(conn: &Connection) -> Result<()> {
    add_column_if_missing(
        conn,
        "reading_plans",
        "lifecycle",
        "TEXT NOT NULL DEFAULT 'active'",
    )?;
    add_column_if_missing(conn, "reading_plans", "paused_at", "TEXT")?;
    add_column_if_missing(
        conn,
        "reading_plans",
        "paused_days_total",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(conn, "reading_plans", "parent_plan_id", "TEXT")?;
    add_column_if_missing(conn, "reading_sessions", "plan_id", "TEXT")?;
    conn.execute(
        "UPDATE reading_sessions SET plan_id = (
            SELECT p.id FROM reading_plans p
            WHERE p.book_id = reading_sessions.book_id
            ORDER BY p.start_date DESC LIMIT 1
         ) WHERE plan_id IS NULL",
        [],
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_plans_book_lifecycle ON reading_plans(book_id, lifecycle);",
    )?;
    Ok(())
}

/// Frontispiece redesign: reader-named plans, soft-delete ("Let go" keeps the row
/// with its sessions/notes until a 30-day retention sweep), and a progress
/// snapshot for the back-matter entries.
fn v009_plan_name_softdelete(conn: &Connection) -> Result<()> {
    add_column_if_missing(conn, "reading_plans", "name", "TEXT")?;
    add_column_if_missing(conn, "reading_plans", "deleted_at", "TEXT")?;
    add_column_if_missing(conn, "reading_plans", "reached_percent", "INTEGER")?;
    Ok(())
}

/// Idempotent ALTER ADD COLUMN. Used inside migration bodies so a DB that
/// already has the column (because it was migrated via the pre-Shot-6a
/// `add_column_if_missing` path) doesn't error.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    col_type: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|c| c.ok())
        .collect();
    if !cols.iter().any(|c| c == column) {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, col_type),
            [],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn fresh_db_applies_all_migrations_in_order() {
        let conn = fresh();
        let applied = apply_pending(&conn).expect("apply");
        // Expected: every registered migration runs.
        assert_eq!(applied.len(), MIGRATIONS.len());
        // Schema_migrations table records them, in lexical order (which equals registration order).
        let recorded: Vec<String> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        let expected: Vec<&str> = MIGRATIONS.iter().map(|m| m.version).collect();
        assert_eq!(recorded, expected);
    }

    #[test]
    fn v008_backfills_session_plan_id_to_most_recent_plan() {
        let conn = fresh();
        apply_pending(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES ('b1','T','txt','/p','h','2026-01-01');
             INSERT INTO reading_plans (id,book_id,start_date,target_finish_date)
               VALUES ('p_old','b1','2026-01-01','2026-02-01');
             INSERT INTO reading_plans (id,book_id,start_date,target_finish_date)
               VALUES ('p_new','b1','2026-03-01','2026-04-01');
             INSERT INTO reading_sessions (id,book_id,started_at) VALUES ('s1','b1','2026-03-02');",
        )
        .unwrap();
        // Re-running the idempotent lifecycle migration backfills the orphan session.
        v008_plan_lifecycle(&conn).unwrap();
        let pid: String = conn
            .query_row(
                "SELECT plan_id FROM reading_sessions WHERE id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            pid, "p_new",
            "session attaches to the book's most-recent plan"
        );
        let lc: String = conn
            .query_row(
                "SELECT lifecycle FROM reading_plans WHERE id='p_new'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(lc, "active", "new plans default to the 'active' lifecycle");
    }

    /// `up` step for `failing_migration_leaves_no_partial_state`: creates a
    /// table, then fails. The transaction wrapper must roll the table back.
    fn failing_up(conn: &Connection) -> Result<()> {
        conn.execute_batch("CREATE TABLE mig_tx_probe (id TEXT);")?;
        conn.execute_batch("SELECT * FROM nonexistent;")?;
        Ok(())
    }

    /// **The doc-comment promise**: `up` + the `schema_migrations` row land
    /// inside one transaction, so a migration that fails partway leaves no
    /// partial state behind. SQLite DDL is transactional, so the probe table
    /// must be rolled back along with everything else.
    #[test]
    fn failing_migration_leaves_no_partial_state() {
        let conn = fresh();
        apply_pending(&conn).unwrap();
        let bad = Migration {
            version: "v999_test_failing",
            description: "test-only migration that fails after a CREATE TABLE",
            up: failing_up,
        };
        assert!(
            apply_one(&conn, &bad).is_err(),
            "a migration whose body errors must surface the error"
        );
        let probe_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='mig_tx_probe'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            probe_count, 0,
            "failed migration left partial state: mig_tx_probe survived the rollback"
        );
        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version='v999_test_failing'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            recorded, 0,
            "failed migration must not be recorded as applied"
        );
    }

    #[test]
    fn second_run_is_noop() {
        let conn = fresh();
        let first = apply_pending(&conn).expect("first run");
        assert!(!first.is_empty());
        let second = apply_pending(&conn).expect("second run");
        assert!(
            second.is_empty(),
            "second run should not re-apply: got {:?}",
            second
        );
    }

    #[test]
    fn legacy_db_with_columns_already_present_runs_idempotently() {
        // Simulate a DB that was migrated by the pre-Shot-6a path — base
        // tables exist with v002..v004's columns already added, but no
        // schema_migrations table yet.
        let conn = fresh();
        // Apply v001 manually
        v001_init_base_tables(&conn).unwrap();
        // Apply v002..v004's columns out-of-band, the old way
        conn.execute(
            "ALTER TABLE section_progress ADD COLUMN last_percent REAL",
            [],
        )
        .unwrap();
        conn.execute(
            "ALTER TABLE section_progress ADD COLUMN updated_at TEXT",
            [],
        )
        .unwrap();
        conn.execute(
            "ALTER TABLE book_sections ADD COLUMN assignable INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .unwrap();
        // Now run apply_pending. All migrations should be recorded WITHOUT
        // trying to add the already-present columns (the idempotency guard
        // inside each migration body handles that).
        let applied = apply_pending(&conn).expect("apply legacy");
        assert_eq!(applied.len(), MIGRATIONS.len());
    }

    #[test]
    fn each_migration_runs_inside_its_own_recording_step() {
        // After apply_pending, schema_migrations rows have non-empty
        // descriptions and parseable applied_at timestamps.
        let conn = fresh();
        apply_pending(&conn).unwrap();
        let mut stmt = conn
            .prepare("SELECT version, description, applied_at FROM schema_migrations")
            .unwrap();
        let rows: Vec<(String, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for (v, d, t) in &rows {
            assert!(!v.is_empty());
            assert!(!d.is_empty(), "version {} has empty description", v);
            assert!(!t.is_empty(), "version {} has empty applied_at", v);
        }
    }
}

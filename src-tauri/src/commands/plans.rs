//! Plan lifecycle commands (Epic A2). The `lifecycle` column (v008) is the axis
//! these manage — active | paused | completed | archived | superseded — distinct
//! from the pace `status`. They make multiple plans per book inspectable and
//! manageable (the v1.1 blocker): see, pause, resume, archive, delete.

use serde::Serialize;
use tauri::State;

use crate::db::DbState;
use crate::error::AppError;

#[derive(Serialize)]
pub struct PlanSummary {
    pub id: String,
    pub book_id: String,
    pub name: String,
    pub lifecycle: String,
    pub status: String,
    pub start_date: String,
    pub paused_days_total: i64,
    pub session_count: i64,
    pub note_count: i64,
    /// Progress snapshot taken when the plan was paused/archived (back-matter).
    /// The live plan's current day/percent/pace comes from cmd_today instead.
    pub reached_percent: Option<i64>,
}

const PLAN_SELECT: &str = "SELECT p.id, p.book_id, COALESCE(p.name, ''), p.lifecycle, p.status,
        p.start_date, p.paused_days_total,
        (SELECT COUNT(*) FROM reading_sessions s WHERE s.plan_id = p.id),
        (SELECT COUNT(*) FROM notes n WHERE n.session_id IN
           (SELECT id FROM reading_sessions s WHERE s.plan_id = p.id)),
        p.reached_percent
     FROM reading_plans p";

fn row_to_summary(r: &rusqlite::Row) -> rusqlite::Result<PlanSummary> {
    Ok(PlanSummary {
        id: r.get(0)?,
        book_id: r.get(1)?,
        name: r.get(2)?,
        lifecycle: r.get(3)?,
        status: r.get(4)?,
        start_date: r.get(5)?,
        paused_days_total: r.get(6)?,
        session_count: r.get(7)?,
        note_count: r.get(8)?,
        reached_percent: r.get(9)?,
    })
}

/// Snapshot the book's current progress % onto a plan (for back-matter display)
/// at the moment it stops being live — pause or archive.
fn snapshot_reached_percent(conn: &rusqlite::Connection, plan_id: &str) -> rusqlite::Result<()> {
    let book_id: String = match conn.query_row(
        "SELECT book_id FROM reading_plans WHERE id = ?1",
        [plan_id],
        |r| r.get(0),
    ) {
        Ok(b) => b,
        Err(_) => return Ok(()),
    };
    let assignable: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_sections WHERE book_id = ?1 AND assignable = 1",
            [&book_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let completed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM section_progress WHERE book_id = ?1 AND completed_at IS NOT NULL",
            [&book_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let pct = if assignable > 0 {
        (completed * 100 / assignable).clamp(0, 100)
    } else {
        0
    };
    conn.execute(
        "UPDATE reading_plans SET reached_percent = ?1 WHERE id = ?2",
        rusqlite::params![pct, plan_id],
    )?;
    Ok(())
}

/// Every plan for a book, active first, with attached session + note counts so the
/// UI can warn before a destructive delete.
#[tauri::command]
pub fn cmd_list_plans_for_book(
    book_id: String,
    state: State<DbState>,
) -> Result<Vec<PlanSummary>, AppError> {
    let conn = state.lock()?;
    let sql = format!(
        "{PLAN_SELECT} WHERE p.book_id = ?1 AND p.deleted_at IS NULL
         ORDER BY (p.lifecycle = 'active') DESC, p.start_date DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(AppError::from)?;
    let rows = stmt
        .query_map([&book_id], row_to_summary)
        .map_err(AppError::from)?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

/// Create a fresh plan-ready plan for a book (a new "attempt"). The caller decides
/// what happens to any existing live plan (keep / pause / replace) first; this just
/// inserts the new one, which becomes the live plan (lifecycle defaults to active).
#[tauri::command]
pub fn cmd_start_new_plan(book_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    let plan = crate::plan::build_default_plan(&book_id);
    crate::commands::db_helpers::insert_plan(&conn, &plan).map_err(AppError::from)?;
    Ok(())
}

/// The book's live plan (the most recent `lifecycle = 'active'`), if any.
#[tauri::command]
pub fn cmd_get_active_plan(
    book_id: String,
    state: State<DbState>,
) -> Result<Option<PlanSummary>, AppError> {
    let conn = state.lock()?;
    let sql = format!(
        "{PLAN_SELECT} WHERE p.book_id = ?1 AND p.lifecycle = 'active' AND p.deleted_at IS NULL
         ORDER BY p.start_date DESC LIMIT 1"
    );
    let r = conn.query_row(&sql, [&book_id], row_to_summary).ok();
    Ok(r)
}

/// `cmd_pause_plan`'s UPDATE, with "today" injected (CORE-1014: the pause day
/// credit is a reader-local day boundary, so the date comes from
/// `plan::app_today()` as a SQL param — never SQLite's UTC `date('now')`).
/// Extracted so tests drive it with explicit dates.
fn pause_plan_on(
    conn: &rusqlite::Connection,
    plan_id: &str,
    today: chrono::NaiveDate,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE reading_plans SET lifecycle = 'paused', paused_at = ?2,
           status = CASE WHEN status IN ('active','rebalanced') THEN 'paused' ELSE status END
         WHERE id = ?1 AND lifecycle = 'active'",
        rusqlite::params![plan_id, today.to_string()],
    )
}

/// `cmd_resume_plan`'s UPDATE — same local-day seam as `pause_plan_on`.
fn resume_plan_on(
    conn: &rusqlite::Connection,
    plan_id: &str,
    today: chrono::NaiveDate,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE reading_plans SET
           paused_days_total = paused_days_total +
             CAST(julianday(?2) - julianday(paused_at) AS INTEGER),
           lifecycle = 'active',
           status = CASE WHEN status = 'paused' THEN 'active' ELSE status END,
           paused_at = NULL
         WHERE id = ?1 AND lifecycle = 'paused' AND paused_at IS NOT NULL",
        rusqlite::params![plan_id, today.to_string()],
    )
}

/// Pause an active plan. The position-based model has no pace clock or finish
/// date, so pausing simply marks the plan paused (lifecycle + status); a
/// never-started plan keeps its `plan_ready` status.
#[tauri::command]
pub fn cmd_pause_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    pause_plan_on(&conn, &plan_id, crate::plan::app_today()).map_err(AppError::from)?;
    snapshot_reached_percent(&conn, &plan_id).ok();
    Ok(())
}

/// Resume a paused plan: mark it active again and accumulate the paused span into
/// paused_days_total (there is no finish date to extend now).
#[tauri::command]
pub fn cmd_resume_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    resume_plan_on(&conn, &plan_id, crate::plan::app_today()).map_err(AppError::from)?;
    Ok(())
}

/// Archive a plan (kept for history, not deleted; never the live plan after this).
#[tauri::command]
pub fn cmd_archive_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    conn.execute(
        "UPDATE reading_plans SET lifecycle = 'archived' WHERE id = ?1",
        [&plan_id],
    )
    .map_err(AppError::from)?;
    snapshot_reached_percent(&conn, &plan_id).ok();
    Ok(())
}

/// "Let go": soft-delete the plan — kept, with its sessions + notes, until the
/// 30-day retention sweep. Reversible via cmd_restore_plan (the Undo window).
#[tauri::command]
pub fn cmd_delete_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    conn.execute(
        "UPDATE reading_plans SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL",
        [&plan_id],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// Undo a "Let go" (restore a soft-deleted plan within the retention window).
#[tauri::command]
pub fn cmd_restore_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.lock()?;
    conn.execute(
        "UPDATE reading_plans SET deleted_at = NULL WHERE id = ?1",
        [&plan_id],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// Hard-purge plans soft-deleted longer than `days` ago, with their sessions +
/// notes. Mirrors ai_retention::sweep; `days <= 0` disables it. Returns plans purged.
///
/// DATA-003: `exported_markdown_path` points at the SHARED per-book literature
/// note (`Books/{slug}.md`) — one file per book carrying EVERY note's fence
/// plus the reader's own prose outside the fences. The old sweep unlinked that
/// path per purged note, deleting surviving notes' fences and irreplaceable
/// reader prose on a mere launch. The sweep now NEVER unlinks an exported
/// file: it deletes the expired rows in one transaction, then re-merges each
/// affected book's note once — the merge drops the purged fences in place and
/// preserves everything else. A re-merge failure leaves the previous file
/// bytes intact (the export writer is atomic) and never fails the sweep.
pub fn sweep_deleted_plans(conn: &rusqlite::Connection, days: i64) -> anyhow::Result<usize> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = format!("-{days} days");

    // Books whose exported note must be re-merged after the rows go.
    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.book_id FROM notes n
         WHERE n.session_id IN (
            SELECT s.id FROM reading_sessions s JOIN reading_plans p ON p.id = s.plan_id
            WHERE p.deleted_at IS NOT NULL AND p.deleted_at < datetime('now', ?1))",
    )?;
    let affected_books: Vec<String> = stmt
        .query_map([&cutoff], |r| r.get::<_, String>(0))?
        .filter_map(|x| x.ok())
        .collect();
    drop(stmt);

    // Delete notes → sessions → plans atomically: a failure part-way must not
    // leave notes orphaned from already-purged sessions or plans.
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM notes WHERE session_id IN (
            SELECT s.id FROM reading_sessions s JOIN reading_plans p ON p.id = s.plan_id
            WHERE p.deleted_at IS NOT NULL AND p.deleted_at < datetime('now', ?1))",
        [&cutoff],
    )?;
    tx.execute(
        "DELETE FROM reading_sessions WHERE plan_id IN (
            SELECT id FROM reading_plans WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?1))",
        [&cutoff],
    )?;
    let purged = tx.execute(
        "DELETE FROM reading_plans WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?1)",
        [&cutoff],
    )?;
    // R4 crash-safe mirror contract: the destructive purge and the durable
    // dirty-book marks commit ATOMICALLY — a crash before the re-merge below
    // leaves the marks, and the launch retry heals every affected mirror.
    for book_id in &affected_books {
        crate::settings::ledger_add(&tx, crate::settings::KEY_PENDING_BOOK_EXPORTS, book_id)?;
    }
    tx.commit()?;

    // Re-merge each affected book once, AFTER the commit, so the file reflects
    // exactly the surviving rows — through the DURABLE export (never the raw
    // writer): success clears the mark; failure keeps it for the launch retry.
    // Failure is logged (id only, never content) and skipped: the atomic
    // writer has already guaranteed the old bytes are still on disk, which
    // beats aborting the launch sweep.
    if !affected_books.is_empty() {
        let root = crate::export::root_for(conn);
        let now = chrono::Utc::now().to_rfc3339();
        for book_id in &affected_books {
            if let Err(e) = crate::export::export_book_durably(conn, &root, book_id, &now) {
                tracing::warn!(
                    category = "retention",
                    book_id = %book_id,
                    "plan sweep: post-purge re-merge failed (previous export kept): {e:#}"
                );
            }
        }
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;
    use rusqlite::Connection;

    use super::{pause_plan_on, resume_plan_on};

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO books (id,title,source_type,source_path,source_sha256,created_at)
               VALUES ('b1','T','txt','/p','h','2026-01-01');
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle)
               VALUES ('p1','b1','2026-01-01','active','active');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn pause_then_resume_tracks_paused_days() {
        let conn = db();
        // Paused on Jan 5, resumed on Jan 10 — explicit dates (CORE-1014: the
        // helpers take the local day as a param; no wall clock in the test).
        conn.execute(
            "UPDATE reading_plans SET lifecycle='paused', paused_at='2026-01-05' WHERE id='p1'",
            [],
        )
        .unwrap();
        resume_plan_on(&conn, "p1", d(2026, 1, 10)).unwrap();
        let (total, lifecycle): (i64, String) = conn
            .query_row(
                "SELECT paused_days_total, lifecycle FROM reading_plans WHERE id='p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(total, 5, "the 5 paused days are tracked");
        assert_eq!(lifecycle, "active");
    }

    fn status_of(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT status FROM reading_plans WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Pausing marks the plan paused (lifecycle + status) and resuming restores
    /// active; the paused span accumulates into paused_days_total. Drives the real
    /// command helpers with explicit local days (pause Jan 5, resume Jan 10).
    #[test]
    fn pause_writes_status_paused_and_resume_restores_active() {
        let conn = db();
        let pause = |conn: &Connection, id: &str| pause_plan_on(conn, id, d(2026, 1, 5)).unwrap();
        let resume =
            |conn: &Connection, id: &str| resume_plan_on(conn, id, d(2026, 1, 10)).unwrap();

        pause(&conn, "p1");
        assert_eq!(
            status_of(&conn, "p1"),
            "paused",
            "pausing must stop the pace clock via status"
        );

        resume(&conn, "p1");
        assert_eq!(
            status_of(&conn, "p1"),
            "active",
            "resume must restart the pace clock"
        );
        // Paused days are tracked (there is no finish date to extend now).
        let total: i64 = conn
            .query_row(
                "SELECT paused_days_total FROM reading_plans WHERE id='p1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(total, 5);

        // PRIORITY 0 guard: a never-started (plan_ready) plan keeps plan_ready
        // through a pause/resume round-trip — pausing must never be the thing
        // that starts a pace clock.
        conn.execute(
            "INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle)
               VALUES ('p_ready','b1','2026-01-01','plan_ready','active')",
            [],
        )
        .unwrap();
        pause(&conn, "p_ready");
        assert_eq!(status_of(&conn, "p_ready"), "plan_ready");
        resume(&conn, "p_ready");
        assert_eq!(
            status_of(&conn, "p_ready"),
            "plan_ready",
            "plan_ready must survive pause → resume"
        );
    }

    fn count(conn: &Connection, where_clause: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {where_clause}"), [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn delete_is_soft_and_restorable() {
        let conn = db();
        conn.execute(
            "UPDATE reading_plans SET deleted_at=datetime('now') WHERE id='p1'",
            [],
        )
        .unwrap();
        assert_eq!(
            count(&conn, "reading_plans WHERE id='p1' AND deleted_at IS NULL"),
            0
        );
        assert_eq!(
            count(&conn, "reading_plans WHERE id='p1'"),
            1,
            "soft delete keeps the row"
        );
        conn.execute("UPDATE reading_plans SET deleted_at=NULL WHERE id='p1'", [])
            .unwrap();
        assert_eq!(
            count(&conn, "reading_plans WHERE id='p1' AND deleted_at IS NULL"),
            1,
            "restore"
        );
    }

    /// DATA-003 fixture: an isolated export root, one book whose REAL shared
    /// `Books/{slug}.md` carries an expired plan's fence, a surviving plan's
    /// fence, and sentinel reader prose typed outside the fences. Returns
    /// (env-locked guard, export_dir, conn, shared file path). Caller cleans up.
    fn sweep_fixture(
        tag: &str,
    ) -> (
        std::sync::MutexGuard<'static, ()>,
        std::path::PathBuf,
        Connection,
        std::path::PathBuf,
    ) {
        let g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-sweep-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }

        let conn = db();
        conn.execute_batch(
            "INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle,deleted_at)
               VALUES ('p_old','b1','2026-01-01','archived','archived',datetime('now','-40 days'));
             INSERT INTO reading_sessions (id,book_id,started_at,plan_id) VALUES ('s_old','b1','2026-01-02','p_old');
             INSERT INTO notes (id,book_id,session_id,note_type,locator,chapter_label,body,created_at,updated_at)
               VALUES ('n_old','b1','s_old','MarginNote','char:0','Chapter I','expired-plan words','2026-01-02','2026-01-02');
             INSERT INTO reading_sessions (id,book_id,started_at,plan_id) VALUES ('s_live','b1','2026-01-03','p1');
             INSERT INTO notes (id,book_id,session_id,note_type,locator,chapter_label,body,created_at,updated_at)
               VALUES ('n_live','b1','s_live','MarginNote','char:9','Chapter II','surviving words','2026-01-03','2026-01-03');",
        )
        .unwrap();

        // Build the REAL shared literature note through the production
        // exporter, then record it on both rows the way cmd_save_note does.
        let shared = crate::export::export_book_literature_note(
            &conn,
            &export_dir,
            "b1",
            "2026-06-01T00:00:00Z",
        )
        .expect("initial shared export");
        conn.execute(
            "UPDATE notes SET exported_markdown_path = ?1",
            [shared.to_string_lossy().to_string()],
        )
        .unwrap();

        // The reader's own prose, OUTSIDE the fences — the irreplaceable bytes
        // the old sweep destroyed.
        let mut md = std::fs::read_to_string(&shared).unwrap();
        md.push_str("\nSENTINEL: the reader's own closing thoughts.\n");
        std::fs::write(&shared, &md).unwrap();

        (g, export_dir, conn, shared)
    }

    fn cleanup_sweep_fixture(export_dir: &std::path::Path) {
        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
        let _ = std::fs::remove_dir_all(export_dir);
    }

    /// DATA-003: the sweep must purge only the expired plan's rows and RE-MERGE
    /// the shared book note — never unlink it. The surviving note's fence and
    /// the reader's sentinel prose stay; a repeated sweep changes nothing.
    #[test]
    fn sweep_re_merges_the_shared_book_note_and_preserves_reader_prose() {
        let (_g, export_dir, conn, shared) = sweep_fixture("remerge");

        let precondition = std::fs::read_to_string(&shared).unwrap();
        assert!(precondition.contains("tl-n-n_old"), "expired fence present");
        assert!(precondition.contains("tl-n-n_live"), "live fence present");
        assert!(precondition.contains("SENTINEL"), "reader prose present");

        let purged = super::sweep_deleted_plans(&conn, 30).unwrap();
        assert_eq!(purged, 1, "only the plan past the 30-day window is purged");
        assert_eq!(count(&conn, "reading_plans WHERE id='p_old'"), 0);
        assert_eq!(count(&conn, "reading_sessions WHERE id='s_old'"), 0);
        assert_eq!(count(&conn, "notes WHERE id='n_old'"), 0);
        assert_eq!(count(&conn, "notes WHERE id='n_live'"), 1, "live note kept");

        assert!(
            shared.exists(),
            "the SHARED book file must never be unlinked"
        );
        let after = std::fs::read_to_string(&shared).unwrap();
        assert!(
            !after.contains("tl-n-n_old"),
            "the purged note's fence is merged away"
        );
        assert!(
            !after.contains("expired-plan words"),
            "the purged note's content is gone"
        );
        assert!(
            after.contains("tl-n-n_live") && after.contains("surviving words"),
            "the surviving note's fence remains"
        );
        assert!(
            after.contains("SENTINEL: the reader's own closing thoughts."),
            "reader prose outside the fences is preserved verbatim"
        );

        // Idempotence: a second sweep purges nothing and leaves the same bytes.
        let again = super::sweep_deleted_plans(&conn, 30).unwrap();
        assert_eq!(again, 0, "repeated sweep is a no-op");
        assert_eq!(
            std::fs::read_to_string(&shared).unwrap(),
            after,
            "repeated sweep leaves the file byte-identical"
        );

        cleanup_sweep_fixture(&export_dir);
    }

    /// DATA-003 fail-safe: when the post-purge re-merge cannot write (injected
    /// read-only Books/ dir), the sweep still completes the row purge and the
    /// PREVIOUS file bytes remain fully intact — a failure may leave the file
    /// stale, never gone or truncated.
    #[cfg(unix)]
    #[test]
    fn sweep_export_failure_preserves_the_previous_file_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let (_g, export_dir, conn, shared) = sweep_fixture("exportfail");
        let before = std::fs::read(&shared).unwrap();

        let books_dir = export_dir.join("Books");
        std::fs::set_permissions(&books_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let perms_enforced = std::fs::write(books_dir.join(".probe"), b"x").is_err();

        let result = if perms_enforced {
            Some(super::sweep_deleted_plans(&conn, 30))
        } else {
            None
        };

        std::fs::set_permissions(&books_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let after = std::fs::read(&shared).unwrap();
        cleanup_sweep_fixture(&export_dir);

        let Some(result) = result else {
            eprintln!("skipping export-failure assertion: permissions not enforced (root?)");
            return;
        };
        let purged = result.expect("a re-merge failure must not abort the sweep");
        assert_eq!(purged, 1, "rows are purged even when the re-merge fails");
        assert_eq!(count(&conn, "notes WHERE id='n_old'"), 0);
        assert_eq!(
            before, after,
            "a failed re-merge must leave the previous export bytes untouched"
        );
    }
}

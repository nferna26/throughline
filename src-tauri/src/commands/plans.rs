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
    pub target_finish_date: String,
    pub paused_days_total: i64,
    pub session_count: i64,
    pub note_count: i64,
    /// Progress snapshot taken when the plan was paused/archived (back-matter).
    /// The live plan's current day/percent/pace comes from cmd_today instead.
    pub reached_percent: Option<i64>,
}

const PLAN_SELECT: &str = "SELECT p.id, p.book_id, COALESCE(p.name, ''), p.lifecycle, p.status,
        p.start_date, p.target_finish_date, p.paused_days_total,
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
        target_finish_date: r.get(6)?,
        paused_days_total: r.get(7)?,
        session_count: r.get(8)?,
        note_count: r.get(9)?,
        reached_percent: r.get(10)?,
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
    let conn = state.0.lock()?;
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
    let conn = state.0.lock()?;
    let sections =
        crate::commands::db_helpers::list_sections(&conn, &book_id).map_err(AppError::from)?;
    let plan = crate::plan::build_default_plan(&book_id, &sections);
    crate::commands::db_helpers::insert_plan(&conn, &plan).map_err(AppError::from)?;
    Ok(())
}

/// The book's live plan (the most recent `lifecycle = 'active'`), if any.
#[tauri::command]
pub fn cmd_get_active_plan(
    book_id: String,
    state: State<DbState>,
) -> Result<Option<PlanSummary>, AppError> {
    let conn = state.0.lock()?;
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
           target_finish_date = date(target_finish_date,
             '+' || CAST(julianday(?2) - julianday(paused_at) AS INTEGER) || ' days'),
           paused_days_total = paused_days_total +
             CAST(julianday(?2) - julianday(paused_at) AS INTEGER),
           lifecycle = 'active',
           status = CASE WHEN status = 'paused' THEN 'active' ELSE status END,
           paused_at = NULL
         WHERE id = ?1 AND lifecycle = 'paused' AND paused_at IS NOT NULL",
        rusqlite::params![plan_id, today.to_string()],
    )
}

/// Pause an active plan (its pace clock stops; resume extends the finish date).
/// CORE-1003: pace/forecast gating keys on `status` (plan::compute), so the
/// pause must write status='paused' too — otherwise Today keeps counting
/// "Behind · N days" through the pause. A never-started plan keeps its
/// `plan_ready` status (the never-behind guarantee survives a pause round-trip).
#[tauri::command]
pub fn cmd_pause_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    pause_plan_on(&conn, &plan_id, crate::plan::app_today()).map_err(AppError::from)?;
    snapshot_reached_percent(&conn, &plan_id).ok();
    Ok(())
}

/// Resume a paused plan: add the paused days back to the finish date (so the
/// reader keeps the same remaining time) and to paused_days_total.
#[tauri::command]
pub fn cmd_resume_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    resume_plan_on(&conn, &plan_id, crate::plan::app_today()).map_err(AppError::from)?;
    Ok(())
}

/// Archive a plan (kept for history, not deleted; never the live plan after this).
#[tauri::command]
pub fn cmd_archive_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
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
    let conn = state.0.lock()?;
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
    let conn = state.0.lock()?;
    conn.execute(
        "UPDATE reading_plans SET deleted_at = NULL WHERE id = ?1",
        [&plan_id],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// Hard-purge plans soft-deleted longer than `days` ago, with their sessions +
/// notes. Mirrors ai_retention::sweep; `days <= 0` disables it. Returns plans purged.
pub fn sweep_deleted_plans(conn: &rusqlite::Connection, days: i64) -> rusqlite::Result<usize> {
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = format!("-{days} days");
    // CORE-1033: the purged notes' exported Markdown mirrors go with them —
    // same contract as cmd_delete_note, so the notebook and the export stay in
    // sync with no orphan files. Best-effort: a missing or unremovable file
    // must never abort the sweep.
    let mut stmt = conn.prepare(
        "SELECT exported_markdown_path FROM notes
         WHERE exported_markdown_path IS NOT NULL AND session_id IN (
            SELECT s.id FROM reading_sessions s JOIN reading_plans p ON p.id = s.plan_id
            WHERE p.deleted_at IS NOT NULL AND p.deleted_at < datetime('now', ?1))",
    )?;
    let mirrors: Vec<String> = stmt
        .query_map([&cutoff], |r| r.get::<_, String>(0))?
        .filter_map(|x| x.ok())
        .collect();
    for path in mirrors {
        let _ = std::fs::remove_file(&path);
    }
    conn.execute(
        "DELETE FROM notes WHERE session_id IN (
            SELECT s.id FROM reading_sessions s JOIN reading_plans p ON p.id = s.plan_id
            WHERE p.deleted_at IS NOT NULL AND p.deleted_at < datetime('now', ?1))",
        [&cutoff],
    )?;
    conn.execute(
        "DELETE FROM reading_sessions WHERE plan_id IN (
            SELECT id FROM reading_plans WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?1))",
        [&cutoff],
    )?;
    conn.execute(
        "DELETE FROM reading_plans WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?1)",
        [&cutoff],
    )
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
             INSERT INTO reading_plans (id,book_id,start_date,target_finish_date,status,lifecycle)
               VALUES ('p1','b1','2026-01-01','2026-02-01','active','active');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn pause_then_resume_extends_finish_by_paused_days() {
        let conn = db();
        // Paused on Jan 5, resumed on Jan 10 — explicit dates (CORE-1014: the
        // helpers take the local day as a param; no wall clock in the test).
        conn.execute(
            "UPDATE reading_plans SET lifecycle='paused', paused_at='2026-01-05' WHERE id='p1'",
            [],
        )
        .unwrap();
        resume_plan_on(&conn, "p1", d(2026, 1, 10)).unwrap();
        let (finish, total, lifecycle): (String, i64, String) = conn
            .query_row(
                "SELECT target_finish_date, paused_days_total, lifecycle FROM reading_plans WHERE id='p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(finish, "2026-02-06", "finish extended by the 5 paused days");
        assert_eq!(total, 5);
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

    /// CORE-1003: pace/forecast gating keys on `status` (plan::compute), so the
    /// pause UPDATE must write status='paused' — not just lifecycle — and the
    /// resume UPDATE must set it back to 'active'. Otherwise a reader who pauses
    /// their only plan watches "Behind · N days" keep growing during the pause.
    /// Drives the real command helpers with explicit local days (pause Jan 5,
    /// resume Jan 10 — 5 paused days for resume to add back).
    #[test]
    fn pause_writes_status_paused_and_resume_restores_active() {
        let conn = db();
        let pause = |conn: &Connection, id: &str| pause_plan_on(conn, id, d(2026, 1, 5)).unwrap();
        let resume = |conn: &Connection, id: &str| resume_plan_on(conn, id, d(2026, 1, 10)).unwrap();

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
        // The finish-date math still holds alongside the status writes.
        let (finish, total): (String, i64) = conn
            .query_row(
                "SELECT target_finish_date, paused_days_total FROM reading_plans WHERE id='p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(finish, "2026-02-06", "finish extended by the 5 paused days");
        assert_eq!(total, 5);

        // PRIORITY 0 guard: a never-started (plan_ready) plan keeps plan_ready
        // through a pause/resume round-trip — pausing must never be the thing
        // that starts a pace clock.
        conn.execute(
            "INSERT INTO reading_plans (id,book_id,start_date,target_finish_date,status,lifecycle)
               VALUES ('p_ready','b1','2026-01-01','2026-02-01','plan_ready','active')",
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

    #[test]
    fn sweep_purges_only_plans_past_the_window() {
        // CORE-1033: purged notes take their exported Markdown mirrors with
        // them (same contract as cmd_delete_note — no orphan files once the
        // row is gone). The mirrors live in an isolated export dir so the test
        // never touches the user's real GBrain; env vars are process-global,
        // so serialize against other env-touching tests.
        let _g = crate::paths::lock_env_for_test();
        let export_dir =
            std::env::temp_dir().join(format!("tl-sweep-mirror-test-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(export_dir.join("Notes")).unwrap();
        // SAFETY: env vars are process-global; the lock above serializes access.
        unsafe {
            std::env::set_var("THROUGHLINE_EXPORT_DIR", &export_dir);
        }
        let old_mirror = export_dir.join("Notes").join("n_old.md");
        let rec_mirror = export_dir.join("Notes").join("n_rec.md");
        std::fs::write(&old_mirror, "# old").unwrap();
        std::fs::write(&rec_mirror, "# recent").unwrap();

        let conn = db();
        conn.execute_batch(
            "INSERT INTO reading_plans (id,book_id,start_date,target_finish_date,status,lifecycle,deleted_at)
               VALUES ('p_old','b1','2026-01-01','2026-02-01','archived','archived',datetime('now','-40 days'));
             INSERT INTO reading_plans (id,book_id,start_date,target_finish_date,status,lifecycle,deleted_at)
               VALUES ('p_rec','b1','2026-01-01','2026-02-01','archived','archived',datetime('now','-5 days'));
             INSERT INTO reading_sessions (id,book_id,started_at,plan_id) VALUES ('s_old','b1','2026-01-02','p_old');
             INSERT INTO notes (id,book_id,session_id,note_type,locator,body,created_at,updated_at)
               VALUES ('n_old','b1','s_old','reflection','char:0','x','2026-01-02','2026-01-02');
             INSERT INTO reading_sessions (id,book_id,started_at,plan_id) VALUES ('s_rec','b1','2026-01-02','p_rec');
             INSERT INTO notes (id,book_id,session_id,note_type,locator,body,created_at,updated_at)
               VALUES ('n_rec','b1','s_rec','reflection','char:0','y','2026-01-02','2026-01-02');",
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET exported_markdown_path = ?1 WHERE id = 'n_old'",
            [old_mirror.to_string_lossy().to_string()],
        )
        .unwrap();
        conn.execute(
            "UPDATE notes SET exported_markdown_path = ?1 WHERE id = 'n_rec'",
            [rec_mirror.to_string_lossy().to_string()],
        )
        .unwrap();

        let purged = super::sweep_deleted_plans(&conn, 30).unwrap();
        assert_eq!(purged, 1, "only the plan past the 30-day window is purged");
        assert_eq!(count(&conn, "reading_plans WHERE id='p_old'"), 0);
        assert_eq!(
            count(&conn, "reading_sessions WHERE id='s_old'"),
            0,
            "its sessions purged"
        );
        assert_eq!(
            count(&conn, "notes WHERE id='n_old'"),
            0,
            "its notes purged"
        );
        assert!(
            !old_mirror.exists(),
            "the purged note's Markdown mirror is removed with the row"
        );
        assert_eq!(
            count(&conn, "reading_plans WHERE id='p_rec'"),
            1,
            "in-window kept"
        );
        assert_eq!(count(&conn, "notes WHERE id='n_rec'"), 1, "its notes kept");
        assert!(
            rec_mirror.exists(),
            "a kept note's Markdown mirror is untouched"
        );

        unsafe {
            std::env::remove_var("THROUGHLINE_EXPORT_DIR");
        }
    }
}

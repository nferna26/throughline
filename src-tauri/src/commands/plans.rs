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
    pub lifecycle: String,
    pub status: String,
    pub start_date: String,
    pub target_finish_date: String,
    pub paused_days_total: i64,
    pub session_count: i64,
    pub note_count: i64,
}

const PLAN_SELECT: &str = "SELECT p.id, p.book_id, p.lifecycle, p.status, p.start_date,
        p.target_finish_date, p.paused_days_total,
        (SELECT COUNT(*) FROM reading_sessions s WHERE s.plan_id = p.id),
        (SELECT COUNT(*) FROM notes n WHERE n.session_id IN
           (SELECT id FROM reading_sessions s WHERE s.plan_id = p.id))
     FROM reading_plans p";

fn row_to_summary(r: &rusqlite::Row) -> rusqlite::Result<PlanSummary> {
    Ok(PlanSummary {
        id: r.get(0)?,
        book_id: r.get(1)?,
        lifecycle: r.get(2)?,
        status: r.get(3)?,
        start_date: r.get(4)?,
        target_finish_date: r.get(5)?,
        paused_days_total: r.get(6)?,
        session_count: r.get(7)?,
        note_count: r.get(8)?,
    })
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

/// Pause an active plan (its pace clock stops; resume extends the finish date).
#[tauri::command]
pub fn cmd_pause_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    conn.execute(
        "UPDATE reading_plans SET lifecycle = 'paused', paused_at = date('now')
         WHERE id = ?1 AND lifecycle = 'active'",
        [&plan_id],
    )
    .map_err(AppError::from)?;
    Ok(())
}

/// Resume a paused plan: add the paused days back to the finish date (so the
/// reader keeps the same remaining time) and to paused_days_total.
#[tauri::command]
pub fn cmd_resume_plan(plan_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    conn.execute(
        "UPDATE reading_plans SET
           target_finish_date = date(target_finish_date,
             '+' || CAST(julianday(date('now')) - julianday(paused_at) AS INTEGER) || ' days'),
           paused_days_total = paused_days_total +
             CAST(julianday(date('now')) - julianday(paused_at) AS INTEGER),
           lifecycle = 'active',
           paused_at = NULL
         WHERE id = ?1 AND lifecycle = 'paused' AND paused_at IS NOT NULL",
        [&plan_id],
    )
    .map_err(AppError::from)?;
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
    use rusqlite::Connection;

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
        // Pretend it was paused 5 days ago.
        conn.execute(
            "UPDATE reading_plans SET lifecycle='paused', paused_at=date('now','-5 days') WHERE id='p1'",
            [],
        )
        .unwrap();
        // Resume math (the cmd_resume_plan SQL).
        conn.execute(
            "UPDATE reading_plans SET
               target_finish_date = date(target_finish_date,
                 '+' || CAST(julianday(date('now')) - julianday(paused_at) AS INTEGER) || ' days'),
               paused_days_total = paused_days_total +
                 CAST(julianday(date('now')) - julianday(paused_at) AS INTEGER),
               lifecycle='active', paused_at=NULL
             WHERE id='p1' AND lifecycle='paused'",
            [],
        )
        .unwrap();
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

    fn count(conn: &Connection, where_clause: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {where_clause}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn delete_is_soft_and_restorable() {
        let conn = db();
        conn.execute("UPDATE reading_plans SET deleted_at=datetime('now') WHERE id='p1'", [])
            .unwrap();
        assert_eq!(count(&conn, "reading_plans WHERE id='p1' AND deleted_at IS NULL"), 0);
        assert_eq!(count(&conn, "reading_plans WHERE id='p1'"), 1, "soft delete keeps the row");
        conn.execute("UPDATE reading_plans SET deleted_at=NULL WHERE id='p1'", []).unwrap();
        assert_eq!(count(&conn, "reading_plans WHERE id='p1' AND deleted_at IS NULL"), 1, "restore");
    }

    #[test]
    fn sweep_purges_only_plans_past_the_window() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO reading_plans (id,book_id,start_date,target_finish_date,status,lifecycle,deleted_at)
               VALUES ('p_old','b1','2026-01-01','2026-02-01','archived','archived',datetime('now','-40 days'));
             INSERT INTO reading_plans (id,book_id,start_date,target_finish_date,status,lifecycle,deleted_at)
               VALUES ('p_rec','b1','2026-01-01','2026-02-01','archived','archived',datetime('now','-5 days'));
             INSERT INTO reading_sessions (id,book_id,started_at,plan_id) VALUES ('s_old','b1','2026-01-02','p_old');
             INSERT INTO notes (id,book_id,session_id,note_type,locator,body,created_at,updated_at)
               VALUES ('n_old','b1','s_old','reflection','char:0','x','2026-01-02','2026-01-02');",
        )
        .unwrap();
        let purged = super::sweep_deleted_plans(&conn, 30).unwrap();
        assert_eq!(purged, 1, "only the plan past the 30-day window is purged");
        assert_eq!(count(&conn, "reading_plans WHERE id='p_old'"), 0);
        assert_eq!(count(&conn, "reading_sessions WHERE id='s_old'"), 0, "its sessions purged");
        assert_eq!(count(&conn, "notes WHERE id='n_old'"), 0, "its notes purged");
        assert_eq!(count(&conn, "reading_plans WHERE id='p_rec'"), 1, "in-window kept");
    }
}

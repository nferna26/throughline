//! Session and section-progress commands. `cmd_start_session`/`cmd_end_session`
//! bracket a reading sitting; `cmd_save_section_progress` records mid-session
//! position; `cmd_restart_current_section` clears progress for a section.
//! `cmd_extend_finish_date` lives here too — it adjusts plan dates which are
//! plan-domain, but it's also the recovery action a user takes after a session
//! ends behind pace, so logically it belongs with the reading-progress flow.

use chrono::Utc;
use rusqlite::params;
use tauri::State;
use uuid::Uuid;

use crate::commands::db_helpers::*;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::{Book, ReadingSession};
use crate::{export, log, recovery};

#[tauri::command]
pub fn cmd_save_section_progress(
    book_id: String,
    section_id: String,
    locator: String,
    percent: Option<f64>,
    state: State<DbState>,
) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO section_progress (book_id, section_id, completed_at, last_locator, last_percent, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5)
         ON CONFLICT(book_id, section_id) DO UPDATE SET
           last_locator = excluded.last_locator,
           last_percent = excluded.last_percent,
           updated_at = excluded.updated_at",
        params![book_id, section_id, locator, percent, now],
    )?;
    Ok(())
}

#[tauri::command]
pub fn cmd_extend_finish_date(
    book_id: String,
    add_days: i64,
    state: State<DbState>,
) -> Result<recovery::RecomputedPlan, AppError> {
    let conn = state.0.lock()?;
    let plan = fetch_plan_for_book(&conn, &book_id)?
        .ok_or_else(|| AppError::not_found("plan", Some(book_id.clone())))?;
    let sections = list_sections(&conn, &book_id)?;
    let completed = list_completed_section_ids(&conn, &book_id)?;
    let today = chrono::Utc::now().naive_utc().date();
    let recomputed = recovery::extend_finish_date(
        &plan,
        sections.len() as i64,
        completed.len() as i64,
        today,
        add_days,
    )?;
    conn.execute(
        "UPDATE reading_plans
           SET target_finish_date = ?1, daily_target_units = ?2,
               status = 'rebalanced',
               original_finish_date = COALESCE(original_finish_date, ?3)
         WHERE id = ?4",
        params![recomputed.new_target_finish_date, recomputed.new_daily_target_units, plan.target_finish_date, plan.id],
    )?;
    Ok(recomputed)
}

#[tauri::command]
pub fn cmd_restart_current_section(book_id: String, section_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    conn.execute(
        "DELETE FROM section_progress WHERE book_id = ?1 AND section_id = ?2",
        params![book_id, section_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn cmd_start_session(book_id: String, section_id: Option<String>, start_locator: Option<String>, state: State<DbState>) -> Result<ReadingSession, AppError> {
    let conn = state.0.lock()?;
    let id = format!("sess_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let start_loc = start_locator.or_else(|| section_id.as_ref().and_then(|sid| {
        conn.query_row(
            "SELECT start_locator FROM book_sections WHERE id = ?1",
            params![sid],
            |r| r.get::<_, Option<String>>(0),
        ).ok().flatten()
    }));
    conn.execute(
        "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty)
         VALUES (?1, ?2, ?3, NULL, ?4, NULL, NULL, 0, NULL)",
        params![id, book_id, now, start_loc],
    )?;
    // Bump last_opened_at so this book becomes "active" on the Today screen.
    bump_last_opened_at(&conn, &book_id)?;
    // Activate the plan on the first reading session: plan_ready → active and
    // stamp activated_at, so the pace clock starts HERE, not at import. Legacy
    // 'active' plans (no plan_ready state) are left untouched.
    conn.execute(
        "UPDATE reading_plans SET status = 'active', activated_at = COALESCE(activated_at, ?1)
         WHERE book_id = ?2 AND status = 'plan_ready'",
        params![now, book_id],
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty
         FROM reading_sessions WHERE id = ?1",
    )?;
    Ok(stmt.query_row(params![id], session_from_row)?)
}

#[tauri::command]
pub fn cmd_end_session(
    session_id: String,
    end_locator: Option<String>,
    minutes: Option<i64>,
    completed_section_ids: Option<Vec<String>>,
    summary_sentence: Option<String>,
    state: State<DbState>,
) -> Result<ReadingSession, AppError> {
    let conn = state.0.lock()?;
    let now = Utc::now().to_rfc3339();
    let completed: Vec<String> = completed_section_ids.unwrap_or_default();
    let touched_any = !completed.is_empty();
    conn.execute(
        "UPDATE reading_sessions SET ended_at = ?1, end_locator = ?2, minutes = ?3, completed_assignment = ?4
         WHERE id = ?5",
        params![now, end_locator, minutes, if touched_any { 1 } else { 0 }, session_id],
    )?;

    for sec_id in &completed {
        let book_id: Option<String> = conn.query_row(
            "SELECT book_id FROM book_sections WHERE id = ?1",
            params![sec_id],
            |r| r.get(0),
        ).ok();
        if let Some(book_id) = book_id {
            conn.execute(
                "INSERT INTO section_progress (book_id, section_id, completed_at, last_locator)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(book_id, section_id) DO UPDATE SET completed_at = excluded.completed_at, last_locator = excluded.last_locator",
                params![book_id, sec_id, now, end_locator],
            )?;
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty
         FROM reading_sessions WHERE id = ?1",
    )?;
    let session = stmt.query_row(params![session_id], session_from_row)?;

    // If every assignable section is now complete, mark the plan completed.
    let (assignable_total, assignable_done): (i64, i64) = conn
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM book_sections WHERE book_id = ?1 AND assignable = 1),
               (SELECT COUNT(*) FROM book_sections bs
                  JOIN section_progress sp ON sp.book_id = bs.book_id AND sp.section_id = bs.id
                  WHERE bs.book_id = ?1 AND bs.assignable = 1 AND sp.completed_at IS NOT NULL)",
            params![session.book_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    if assignable_total > 0 && assignable_done >= assignable_total {
        conn.execute(
            "UPDATE reading_plans SET status = 'completed' WHERE book_id = ?1 AND status != 'completed'",
            params![session.book_id],
        )
        .ok();
    }

    if let Ok(Some(book)) = (|| -> rusqlite::Result<Option<Book>> {
        let mut s = conn.prepare(
            "SELECT id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at FROM books WHERE id = ?1",
        )?;
        let mut rows = s.query(params![session.book_id])?;
        if let Some(row) = rows.next()? { Ok(Some(book_from_row(row)?)) } else { Ok(None) }
    })() {
        if let Ok(p) = export::export_session(&export::root_for(&conn), &book, &session, summary_sentence.as_deref()) {
            log::log_export("session", &p.to_string_lossy());
        }
    }
    Ok(session)
}

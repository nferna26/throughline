//! Session and section-progress commands. `cmd_start_session`/`cmd_end_session`
//! bracket a reading sitting; `cmd_save_section_progress` records mid-session
//! position; `cmd_restart_current_section` clears progress for a section. Reading
//! progress also advances the position-based `reading_position` (furthest + last
//! read), which is what Today's "what's next" derives from.

use chrono::Utc;
use rusqlite::{params, Connection};
use tauri::State;
use uuid::Uuid;

use crate::commands::db_helpers::*;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::{Book, ReadingSession};
use crate::{export, log, sittings};

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
    // Advance the durable, position-based progress (furthest is MAX-clamped,
    // last_read is exact). `locator` is a global body offset.
    if let Ok(global) = locator.trim().parse::<i64>() {
        let sections = list_sections(&conn, &book_id)?;
        let _ = sittings::record_progress(&conn, &book_id, &sections, global, &now);
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_restart_current_section(
    book_id: String,
    section_id: String,
    state: State<DbState>,
) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    conn.execute(
        "DELETE FROM section_progress WHERE book_id = ?1 AND section_id = ?2",
        params![book_id, section_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn cmd_start_session(
    book_id: String,
    section_id: Option<String>,
    start_locator: Option<String>,
    state: State<DbState>,
) -> Result<ReadingSession, AppError> {
    let conn = state.0.lock()?;
    start_session_on(
        &conn,
        &book_id,
        section_id.as_deref(),
        start_locator.as_deref(),
    )
}

fn live_plan_id_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM reading_plans
         WHERE book_id = ?1 AND lifecycle = 'active' AND deleted_at IS NULL
         ORDER BY start_date DESC, id DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

fn start_session_on(
    conn: &Connection,
    book_id: &str,
    section_id: Option<&str>,
    start_locator: Option<&str>,
) -> Result<ReadingSession, AppError> {
    let id = format!("sess_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let plan_id = live_plan_id_for_book(conn, book_id)?;
    let start_loc = start_locator.map(str::to_string).or_else(|| {
        section_id.and_then(|sid| {
            conn.query_row(
                "SELECT start_locator FROM book_sections WHERE id = ?1",
                params![sid],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        })
    });
    conn.execute(
        "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty, plan_id)
         VALUES (?1, ?2, ?3, NULL, ?4, NULL, NULL, 0, NULL, ?5)",
        params![id, book_id, now, start_loc, plan_id],
    )?;
    // Bump last_opened_at so this book becomes "active" on the Today screen.
    bump_last_opened_at(conn, book_id)?;
    // Activate the plan on the first reading session: plan_ready → active and
    // stamp activated_at, so the pace clock starts HERE, not at import. Legacy
    // 'active' plans (no plan_ready state) are left untouched.
    if let Some(plan_id) = &plan_id {
        conn.execute(
            "UPDATE reading_plans SET status = 'active', activated_at = COALESCE(activated_at, ?1)
             WHERE id = ?2 AND status = 'plan_ready'",
            params![now, plan_id],
        )?;
    }
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
    app: tauri::AppHandle,
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
        let book_id: Option<String> = conn
            .query_row(
                "SELECT book_id FROM book_sections WHERE id = ?1",
                params![sec_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(book_id) = book_id {
            conn.execute(
                "INSERT INTO section_progress (book_id, section_id, completed_at, last_locator)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(book_id, section_id) DO UPDATE SET completed_at = excluded.completed_at, last_locator = excluded.last_locator",
                params![book_id, sec_id, now, end_locator],
            )?;
        }
    }

    // Advance the durable, position-based progress to where the session ended, so
    // tomorrow's Today resumes at the next sitting. `end_locator` is a global offset.
    if let Some(global) = end_locator
        .as_deref()
        .and_then(|l| l.trim().parse::<i64>().ok())
    {
        if let Ok(book_id) = conn.query_row(
            "SELECT book_id FROM reading_sessions WHERE id = ?1",
            params![session_id],
            |r| r.get::<_, String>(0),
        ) {
            let sections = list_sections(&conn, &book_id)?;
            let _ = sittings::record_progress(&conn, &book_id, &sections, global, &now);
            // Fire-and-forget: prefetch the NEXT sitting's phrase (Stage 3,
            // docs/PHRASES_API.md timing). Spawned, never awaited — the recap
            // UI cannot wait on this even by accident.
            crate::phrases::spawn_next_phrase(&app, &conn, &book_id, &sections, global);
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty
         FROM reading_sessions WHERE id = ?1",
    )?;
    let session = stmt.query_row(params![session_id], session_from_row)?;

    // If every assignable section is now complete, mark the plan completed.
    complete_plan_if_book_done(&conn, &session.book_id);

    if let Ok(Some(book)) = (|| -> rusqlite::Result<Option<Book>> {
        let mut s = conn.prepare(
            "SELECT id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at FROM books WHERE id = ?1",
        )?;
        let mut rows = s.query(params![session.book_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(book_from_row(row)?))
        } else {
            Ok(None)
        }
    })() {
        if let Ok(p) = export::export_session(
            &export::root_for(&conn),
            &book,
            &session,
            summary_sentence.as_deref(),
        ) {
            log::log_export("session", &p.to_string_lossy());
        }
    }
    Ok(session)
}

/// When every assignable section of `book_id` is complete, mark its plan
/// `completed`. Best-effort — a failure here must never fail the session end.
fn complete_plan_if_book_done(conn: &Connection, book_id: &str) {
    let (assignable_total, assignable_done): (i64, i64) = conn
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM book_sections WHERE book_id = ?1 AND assignable = 1),
               (SELECT COUNT(*) FROM book_sections bs
                  JOIN section_progress sp ON sp.book_id = bs.book_id AND sp.section_id = bs.id
                  WHERE bs.book_id = ?1 AND bs.assignable = 1 AND sp.completed_at IS NOT NULL)",
            params![book_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    if assignable_total > 0 && assignable_done >= assignable_total {
        // Lifecycle filter (CORE-1022): only the live plan may flip — archived /
        // superseded / let-go plans are "earlier attempts" history, not today's.
        conn.execute(
            "UPDATE reading_plans SET status = 'completed'
             WHERE book_id = ?1 AND status != 'completed'
               AND lifecycle = 'active' AND deleted_at IS NULL",
            params![book_id],
        )
        .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn start_session_links_to_live_plan_for_history_counts() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
               VALUES ('b1','T',NULL,'txt','/x','sha','2026-01-01',NULL);
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle)
               VALUES ('p_old','b1','2026-03-01','plan_ready','archived');
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle,deleted_at)
               VALUES ('p_gone','b1','2026-04-01','plan_ready','active',datetime('now'));
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle)
               VALUES ('p_live','b1','2026-02-01','plan_ready','active');
             INSERT INTO book_sections (id,book_id,label,start_locator,sort_order,assignable)
               VALUES ('sec1','b1','S1','char:42',0,1);",
        )
        .unwrap();

        let session = start_session_on(&conn, "b1", Some("sec1"), None).unwrap();

        let session_plan: Option<String> = conn
            .query_row(
                "SELECT plan_id FROM reading_sessions WHERE id = ?1",
                [&session.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(session_plan.as_deref(), Some("p_live"));
        assert_eq!(session.start_locator.as_deref(), Some("char:42"));

        let status = |id: &str| -> (String, Option<String>) {
            conn.query_row(
                "SELECT status, activated_at FROM reading_plans WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        let (live_status, live_activated_at) = status("p_live");
        assert_eq!(live_status, "active");
        assert!(live_activated_at.is_some());
        assert_eq!(
            status("p_old").0,
            "plan_ready",
            "archived attempts must not be activated by a new session"
        );
        assert_eq!(
            status("p_gone").0,
            "plan_ready",
            "let-go attempts must not be activated by a new session"
        );

        conn.execute(
            "INSERT INTO notes (id,book_id,session_id,note_type,locator,body,created_at,updated_at)
             VALUES ('n1','b1',?1,'Observation','char:42','kept note','2026-06-12','2026-06-12')",
            [&session.id],
        )
        .unwrap();
        let (session_count, note_count): (i64, i64) = conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM reading_sessions s WHERE s.plan_id = 'p_live'),
                    (SELECT COUNT(*) FROM notes n WHERE n.session_id IN
                       (SELECT id FROM reading_sessions s WHERE s.plan_id = 'p_live'))",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(session_count, 1);
        assert_eq!(note_count, 1);
    }

    /// CORE-1022 / P3-24: when the last assignable section completes, only the
    /// LIVE plan may flip to 'completed'. Archived and let-go (soft-deleted)
    /// plans are the book's history — the "earlier attempts" record — and
    /// rewriting their status corrupts it.
    #[test]
    fn plan_completion_skips_archived_and_let_go_plans() {
        let conn = Connection::open_in_memory().unwrap();
        crate::migrations::apply_pending(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO books (id,title,author,source_type,source_path,source_sha256,created_at,last_opened_at)
               VALUES ('b1','T',NULL,'txt','/x','sha','2026-01-01',NULL);
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle)
               VALUES ('p_live','b1','2026-01-01','active','active');
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle)
               VALUES ('p_old','b1','2026-01-01','active','archived');
             INSERT INTO reading_plans (id,book_id,start_date,status,lifecycle,deleted_at)
               VALUES ('p_gone','b1','2026-01-01','active','active',datetime('now'));
             INSERT INTO book_sections (id,book_id,label,sort_order,assignable)
               VALUES ('s1','b1','S1',0,1);
             INSERT INTO section_progress (book_id,section_id,completed_at,last_locator)
               VALUES ('b1','s1','2026-01-05T10:00:00Z',NULL);",
        )
        .unwrap();

        complete_plan_if_book_done(&conn, "b1");

        let status = |id: &str| -> String {
            conn.query_row(
                "SELECT status FROM reading_plans WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(status("p_live"), "completed", "the live plan completes");
        assert_eq!(
            status("p_old"),
            "active",
            "an archived plan's history must not be rewritten"
        );
        assert_eq!(
            status("p_gone"),
            "active",
            "a let-go (soft-deleted) plan must not be rewritten"
        );
    }
}

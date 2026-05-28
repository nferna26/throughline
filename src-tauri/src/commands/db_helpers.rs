//! Shared row hydrators, insert helpers, and small fetch primitives. Used by
//! every command module. All functions return `rusqlite::Result<_>`; callers
//! convert into `AppError` via `?` at the IPC boundary.

use chrono::Utc;
use rusqlite::{params, Connection};

use crate::models::{Book, BookSection, Note, ReadingPlan, ReadingSession};

// ── Row hydrators ──────────────────────────────────────────────────────

pub fn book_from_row(row: &rusqlite::Row) -> rusqlite::Result<Book> {
    Ok(Book {
        id: row.get(0)?,
        title: row.get(1)?,
        author: row.get(2)?,
        source_type: row.get(3)?,
        source_path: row.get(4)?,
        source_sha256: row.get(5)?,
        created_at: row.get(6)?,
        last_opened_at: row.get(7)?,
    })
}

pub fn section_from_row(row: &rusqlite::Row) -> rusqlite::Result<BookSection> {
    let assignable: i64 = row.get::<_, Option<i64>>(8)?.unwrap_or(1);
    Ok(BookSection {
        id: row.get(0)?,
        book_id: row.get(1)?,
        label: row.get(2)?,
        href: row.get(3)?,
        start_locator: row.get(4)?,
        end_locator: row.get(5)?,
        estimated_units: row.get(6)?,
        sort_order: row.get(7)?,
        assignable: assignable != 0,
    })
}

pub fn plan_from_row(row: &rusqlite::Row) -> rusqlite::Result<ReadingPlan> {
    Ok(ReadingPlan {
        id: row.get(0)?,
        book_id: row.get(1)?,
        start_date: row.get(2)?,
        target_finish_date: row.get(3)?,
        daily_target_units: row.get(4)?,
        days_per_week: row.get(5)?,
        catchup_mode: row.get(6)?,
    })
}

pub fn session_from_row(row: &rusqlite::Row) -> rusqlite::Result<ReadingSession> {
    let completed: i64 = row.get(7)?;
    Ok(ReadingSession {
        id: row.get(0)?,
        book_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        start_locator: row.get(4)?,
        end_locator: row.get(5)?,
        minutes: row.get(6)?,
        completed_assignment: completed != 0,
        subjective_difficulty: row.get(8)?,
    })
}

pub fn note_from_row(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        book_id: row.get(1)?,
        session_id: row.get(2)?,
        note_type: row.get(3)?,
        locator: row.get(4)?,
        chapter_label: row.get(5)?,
        body: row.get(6)?,
        short_quote: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        exported_markdown_path: row.get(10)?,
    })
}

// ── Insert helpers ─────────────────────────────────────────────────────

pub fn insert_book(conn: &Connection, b: &Book) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![b.id, b.title, b.author, b.source_type, b.source_path, b.source_sha256, b.created_at, b.last_opened_at],
    )?;
    Ok(())
}

pub fn insert_section(conn: &Connection, s: &BookSection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator, s.estimated_units, s.sort_order, if s.assignable { 1 } else { 0 }],
    )?;
    Ok(())
}

pub fn insert_plan(conn: &Connection, p: &ReadingPlan) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reading_plans (id, book_id, start_date, target_finish_date, daily_target_units, days_per_week, catchup_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![p.id, p.book_id, p.start_date, p.target_finish_date, p.daily_target_units, p.days_per_week, p.catchup_mode],
    )?;
    Ok(())
}

// ── Fetch helpers ──────────────────────────────────────────────────────

pub fn list_sections(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<BookSection>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable
         FROM book_sections WHERE book_id = ?1 ORDER BY sort_order ASC",
    )?;
    let rows = stmt.query_map(params![book_id], section_from_row)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn list_completed_section_ids(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT section_id FROM section_progress WHERE book_id = ?1 AND completed_at IS NOT NULL",
    )?;
    let rows = stmt.query_map(params![book_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

/// "Active" book selector. We prefer the most recently *opened* book so a
/// just-imported book becomes today's book until the user opens a different
/// one (which bumps that one's `last_opened_at`). Falls back to `created_at`
/// when a book has never been opened — which is the case immediately after
/// import. Either way the import flow's `bump_last_opened_at(book.id)` makes
/// the new book win the tiebreaker.
pub fn fetch_active_book(conn: &Connection) -> rusqlite::Result<Option<Book>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at
         FROM books
         ORDER BY COALESCE(last_opened_at, created_at) DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        Ok(Some(book_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn bump_last_opened_at(conn: &Connection, book_id: &str) -> rusqlite::Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE books SET last_opened_at = ?1 WHERE id = ?2",
        params![now, book_id],
    )?;
    Ok(())
}

pub fn fetch_plan_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Option<ReadingPlan>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, start_date, target_finish_date, daily_target_units, days_per_week, catchup_mode
         FROM reading_plans WHERE book_id = ?1 ORDER BY start_date DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(params![book_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(plan_from_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn fetch_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Option<Book>> {
    let mut s = conn.prepare(
        "SELECT id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at FROM books WHERE id = ?1",
    )?;
    let mut rows = s.query(params![book_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(book_from_row(row)?))
    } else { Ok(None) }
}

/// Find an already-imported book by its source file's SHA-256. Returns the
/// **oldest** match so re-imports collapse onto the original. Used by import
/// dedup: both importers store the hash of the raw copied source file, so the
/// hash of the file on disk matches this column exactly.
pub fn fetch_book_by_sha(conn: &Connection, sha: &str) -> rusqlite::Result<Option<Book>> {
    let mut s = conn.prepare(
        "SELECT id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at
         FROM books WHERE source_sha256 = ?1 ORDER BY created_at ASC LIMIT 1",
    )?;
    let mut rows = s.query(params![sha])?;
    if let Some(row) = rows.next()? {
        Ok(Some(book_from_row(row)?))
    } else { Ok(None) }
}

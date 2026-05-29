//! Book lifecycle commands: import, list, today, sections, raw bytes.
//!
//! `cmd_today` is the dominant read — it composes the active book, its plan,
//! the assigned section, the recovery bundle, and the streak summary into one
//! `TodayCard`. `cmd_assignable_sections` is the canonical reading sequence
//! both readers index into.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use tauri::State;

use crate::commands::db_helpers::*;
use crate::db::DbState;
use crate::error::AppError;
use crate::models::{Book, BookSection, ImportOutcome, ReadingPlan, TodayCard};
use crate::{epub_classify, export, import, log, models, paths, plan, recovery, settings};

#[tauri::command]
pub fn cmd_import_book(path: String, state: State<DbState>) -> Result<ImportOutcome, AppError> {
    eprintln!("[rg] cmd_import_book called with path={}", path);
    let src = PathBuf::from(&path);

    // Dedup (skip & switch): if a book with this file's SHA-256 is already
    // imported, make it the active book and return it instead of creating a
    // duplicate. Hashing the source directly matches the stored hash because
    // both importers store the hash of the raw copied file.
    if let Ok(sha) = import::hash_file(&src) {
        let conn = state.0.lock()?;
        if let Some(existing) = fetch_book_by_sha(&conn, &sha)? {
            eprintln!(
                "[rg] cmd_import_book: dedup hit (sha {}…) -> existing book_id={}",
                &sha[..8.min(sha.len())],
                existing.id
            );
            bump_last_opened_at(&conn, &existing.id)?;
            return Ok(ImportOutcome { book: existing, created: false });
        }
    }

    let result = match import::import_any(&src) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[rg] cmd_import_book: import_any failed: {:#}", e);
            return Err(AppError::io(format!("import failed: {:#}", e)));
        }
    };
    eprintln!(
        "[rg] cmd_import_book: imported '{}' [{}] with {} sections",
        result.book.title, result.book.source_type, result.sections.len()
    );
    let conn = state.0.lock()?;
    insert_book(&conn, &result.book)?;
    for s in &result.sections {
        insert_section(&conn, s)?;
    }
    let p = plan::build_default_plan(&result.book.id, &result.sections);
    insert_plan(&conn, &p)?;
    // Make the freshly imported book the active one on the Today screen.
    bump_last_opened_at(&conn, &result.book.id)?;
    if let Ok(path) = export::export_book(&result.book) {
        log::log_export("book", &path.to_string_lossy());
    }
    log::log_import(
        &result.book.id,
        &result.book.title,
        &result.book.source_type,
        result.sections.len(),
        &result.book.source_sha256,
    );
    eprintln!("[rg] cmd_import_book: OK book_id={}", result.book.id);
    Ok(ImportOutcome { book: result.book, created: true })
}

/// Configure a freshly imported book's plan from the Book Setup Sheet: set the
/// target finish date, days-per-week, and recompute the daily section target;
/// persist the reading rhythm (session minutes) and margin-help preference.
///
/// IMPORTANT: this does NOT activate the plan — status stays `plan_ready`, so
/// the book remains "not behind" until the first reading session. The pace
/// clock starts at activation, not here (Priority 0 invariant).
#[tauri::command]
pub fn cmd_configure_plan(
    book_id: String,
    target_finish_date: String,
    days_per_week: i64,
    session_minutes: i64,
    margin_help: Option<String>,
    state: State<DbState>,
) -> Result<ReadingPlan, AppError> {
    let conn = state.0.lock()?;
    let plan = fetch_plan_for_book(&conn, &book_id)?
        .ok_or_else(|| AppError::not_found("plan", Some(book_id.clone())))?;

    let finish = chrono::NaiveDate::parse_from_str(target_finish_date.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::validation(format!("invalid finish date: {target_finish_date:?} (expected YYYY-MM-DD)")))?;
    let today = chrono::Utc::now().naive_utc().date();
    if finish < today {
        return Err(AppError::validation("finish date cannot be in the past".to_string()));
    }
    let dpw = days_per_week.clamp(1, 7);
    let mins = session_minutes.clamp(5, 120);

    // Recompute the daily section target against the chosen window. Completed
    // sections (normally 0 for a fresh import) are preserved.
    let sections = list_sections(&conn, &book_id)?;
    let assignable = sections.iter().filter(|s| s.assignable).count() as i64;
    let completed = list_completed_section_ids(&conn, &book_id)?.len() as i64;
    let remaining = (assignable - completed).max(0);
    let daily_target = plan::daily_target_for(remaining, today, finish);

    conn.execute(
        "UPDATE reading_plans SET target_finish_date = ?1, days_per_week = ?2, daily_target_units = ?3 WHERE id = ?4",
        params![finish.to_string(), dpw, daily_target, plan.id],
    )?;
    settings::set_string(&conn, settings::KEY_READING_RHYTHM_MINUTES, &mins.to_string())
        .map_err(|e| AppError::internal(e.to_string()))?;
    if let Some(help) = margin_help.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        settings::set_string(&conn, settings::KEY_MARGIN_HELP, help)
            .map_err(|e| AppError::internal(e.to_string()))?;
    }

    fetch_plan_for_book(&conn, &book_id)?
        .ok_or_else(|| AppError::not_found("plan", Some(book_id)))
}

/// For EPUBs: return the raw bytes so the frontend can hand them to epub.js.
#[tauri::command]
pub fn cmd_read_book_bytes(book_id: String, state: State<DbState>) -> Result<Vec<u8>, AppError> {
    let conn = state.0.lock()?;
    let source_type: String = conn.query_row(
        "SELECT source_type FROM books WHERE id = ?1",
        params![book_id],
        |r| r.get(0),
    )?;
    let filename = match source_type.as_str() {
        "epub" => "source.epub",
        "txt" => "source.txt",
        other => return Err(AppError::validation(format!("unknown source type: {}", other))),
    };
    let path = paths::book_dir(&book_id)?.join(filename);
    Ok(fs::read(&path)?)
}

#[tauri::command]
pub fn cmd_today(state: State<DbState>) -> Result<Option<TodayCard>, AppError> {
    let conn = state.0.lock()?;
    let Some(book) = fetch_active_book(&conn)? else {
        return Ok(None);
    };
    let Some(plan) = fetch_plan_for_book(&conn, &book.id)? else {
        return Ok(None);
    };
    let sections = list_sections(&conn, &book.id)?;
    let completed = list_completed_section_ids(&conn, &book.id)?;
    let computed = plan::compute(&plan, &sections, &completed)?;

    let section = computed.assigned_section_index.and_then(|i| sections.get(i).cloned());
    let section_completed = section
        .as_ref()
        .map(|s| completed.contains(&s.id))
        .unwrap_or(false);
    let est_minutes = section
        .as_ref()
        .and_then(|s| s.estimated_units)
        .map(|u| import::estimate_minutes_for_chars(u as usize))
        .unwrap_or(20);

    // Resume locator: per-section last position (if any)
    let (resume_locator, resume_percent): (Option<String>, Option<f64>) = if let Some(s) = &section {
        conn.query_row(
            "SELECT last_locator, last_percent FROM section_progress WHERE book_id = ?1 AND section_id = ?2",
            params![book.id, s.id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<f64>>(1)?)),
        ).unwrap_or((None, None))
    } else {
        (None, None)
    };

    let streak = compute_streak(&conn, &book.id)?;
    let session_minutes = crate::settings::get_reading_rhythm_minutes(&conn);

    // Recovery options ONLY when the plan is active and the forecast says a real
    // rebalance is warranted — never for a plan-ready/just-started book. The
    // forecast (observed rate vs target) is the single source of "are we slipping",
    // replacing the old should-have-done linear deficit.
    let needs_recovery = computed
        .forecast
        .as_ref()
        .map_or(false, |f| matches!(f.state.as_str(), "needs_rebalance" | "plan_unrealistic"));
    let days_behind = computed.forecast.as_ref().map_or(0, |f| f.days_late).max(0);
    let recovery = if needs_recovery {
        let today = chrono::Utc::now().naive_utc().date();
        let finish = chrono::NaiveDate::parse_from_str(&plan.target_finish_date, "%Y-%m-%d")
            .unwrap_or(today);
        Some(recovery::build_bundle(days_behind.max(1), today, section.is_some(), finish))
    } else {
        None
    };

    Ok(Some(TodayCard {
        book,
        plan,
        section,
        section_completed,
        estimated_minutes: est_minutes,
        session_minutes,
        monthly_pct: computed.monthly_pct,
        pace: computed.pace,
        day_index: computed.day_index,
        total_days: computed.total_days,
        streak,
        recovery,
        resume_locator,
        resume_percent,
        plan_status: computed.plan_status.clone(),
        forecast: computed.forecast.clone(),
    }))
}

fn compute_streak(conn: &Connection, book_id: &str) -> rusqlite::Result<models::StreakSummary> {
    let mut stmt = conn.prepare(
        "SELECT DATE(started_at) AS d, COALESCE(SUM(minutes), 0)
         FROM reading_sessions
         WHERE book_id = ?1 AND DATE(started_at) >= DATE('now', '-6 days')
         GROUP BY d",
    )?;
    let mut days = 0i64;
    let mut minutes = 0i64;
    let mut rows = stmt.query(params![book_id])?;
    while let Some(row) = rows.next()? {
        days += 1;
        minutes += row.get::<_, i64>(1)?;
    }
    Ok(models::StreakSummary { days_read_last_7: days, minutes_last_7: minutes })
}

#[tauri::command]
pub fn cmd_read_section_text(book_id: String, section_id: String, state: State<DbState>) -> Result<String, AppError> {
    let conn = state.0.lock()?;
    let mut stmt = conn.prepare("SELECT start_locator, end_locator FROM book_sections WHERE id = ?1 AND book_id = ?2")?;
    let (start, end): (Option<String>, Option<String>) = stmt
        .query_row(params![section_id, book_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let start: usize = start.unwrap_or_else(|| "0".to_string()).parse().unwrap_or(0);
    let end: Option<usize> = end.and_then(|s| s.parse().ok());

    let src_path = paths::book_dir(&book_id)?.join("source.txt");
    let body = fs::read_to_string(&src_path)?;
    let end = end.unwrap_or(body.len()).min(body.len());
    let start = start.min(end);
    Ok(body[start..end].to_string())
}

#[tauri::command]
pub fn cmd_list_sections(book_id: String, state: State<DbState>) -> Result<Vec<BookSection>, AppError> {
    let conn = state.0.lock()?;
    Ok(list_sections(&conn, &book_id)?)
}

/// **Canonical reading sequence.** Returns ONLY the assignable subset of
/// `book_sections`, in spine order. Both readers MUST index into this list —
/// it is the single source of truth for initial reader position, Next/Prev
/// navigation, today-target display, and session-complete tracking.
///
/// Lazy reclassify: if the book is an EPUB whose existing rows look pre-2.5
/// (every section currently assignable), re-parse `source.epub` and update
/// `assignable` in place. One-shot per stale book.
#[tauri::command]
pub fn cmd_assignable_sections(book_id: String, state: State<DbState>) -> Result<Vec<BookSection>, AppError> {
    let conn = state.0.lock()?;
    Ok(canonical_assignable_sections(&conn, &book_id)?)
}

fn canonical_assignable_sections(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<BookSection>> {
    let all = list_sections(conn, book_id)?;
    let all_assignable = !all.is_empty() && all.iter().all(|s| s.assignable);
    let source_type: Option<String> = conn.query_row(
        "SELECT source_type FROM books WHERE id = ?1",
        params![book_id],
        |r| r.get::<_, String>(0),
    ).ok();

    let needs_reclassify = matches!(source_type.as_deref(), Some("epub")) && all_assignable;
    let working = if needs_reclassify {
        match reclassify_epub_in_place(conn, book_id) {
            Ok(()) => list_sections(conn, book_id)?,
            Err(e) => {
                eprintln!("reclassify failed for {}: {} — falling back to original list", book_id, e);
                all
            }
        }
    } else {
        all
    };
    Ok(working.into_iter().filter(|s| s.assignable).collect())
}

fn reclassify_epub_in_place(conn: &Connection, book_id: &str) -> anyhow::Result<()> {
    let src = paths::book_dir(book_id).map_err(|e| anyhow::anyhow!("{}", e))?.join("source.epub");
    if !src.exists() {
        return Err(anyhow::anyhow!("source.epub missing for {}", book_id));
    }
    let doc = epub::doc::EpubDoc::new(&src)
        .map_err(|e| anyhow::anyhow!("re-parse {:?}: {}", src, e))?;

    let mut toc_label_by_href: HashMap<String, String> = HashMap::new();
    let mut toc_pairs: Vec<(String, String)> = Vec::new();
    walk_toc_for_labels(&doc.toc, &mut toc_pairs, 0);
    for (label, href) in &toc_pairs {
        let key = strip_fragment(href);
        toc_label_by_href.entry(key).or_insert_with(|| label.clone());
    }

    #[derive(Clone)]
    struct SpineMeta { idref: String, linear: bool, label: Option<String> }
    let mut spine_meta_by_href: HashMap<String, SpineMeta> = HashMap::new();
    for item in &doc.spine {
        if let Some(res) = doc.resources.get(&item.idref) {
            let href = strip_fragment(&res.path.to_string_lossy());
            let label = toc_label_by_href.get(&href).cloned();
            spine_meta_by_href.insert(
                href,
                SpineMeta { idref: item.idref.clone(), linear: item.linear, label },
            );
        }
    }

    let mut updates: Vec<(String, bool)> = Vec::new();
    let mut any_assignable = false;
    for (sec_id, sec_href) in list_section_id_href(conn, book_id)? {
        let new_assignable = if let Some(href) = sec_href {
            let key = strip_fragment(&href);
            if let Some(meta) = spine_meta_by_href.get(&key) {
                !epub_classify::is_front_back_matter(meta.label.as_deref(), &meta.idref, meta.linear)
            } else {
                true
            }
        } else {
            true
        };
        if new_assignable { any_assignable = true; }
        updates.push((sec_id, new_assignable));
    }
    if !any_assignable {
        return Err(anyhow::anyhow!("reclassification would mark every section non-assignable; refusing"));
    }

    for (sec_id, new_assignable) in updates {
        conn.execute(
            "UPDATE book_sections SET assignable = ?1 WHERE id = ?2",
            params![if new_assignable { 1 } else { 0 }, sec_id],
        )?;
    }
    Ok(())
}

fn list_section_id_href(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<(String, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, href FROM book_sections WHERE book_id = ?1 ORDER BY sort_order ASC",
    )?;
    let rows = stmt.query_map(params![book_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

fn strip_fragment(href: &str) -> String {
    match href.find('#') {
        Some(i) => href[..i].to_string(),
        None => href.to_string(),
    }
}

fn walk_toc_for_labels(nav: &[epub::doc::NavPoint], out: &mut Vec<(String, String)>, depth: usize) {
    for n in nav {
        let label = n.label.trim().to_string();
        let href = n.content.to_string_lossy().to_string();
        if !label.is_empty() && !href.is_empty() {
            out.push((label, href));
        }
        if depth < 1 {
            walk_toc_for_labels(&n.children, out, depth + 1);
        }
    }
}

#[tauri::command]
pub fn cmd_list_books(state: State<DbState>) -> Result<Vec<Book>, AppError> {
    let conn = state.0.lock()?;
    let mut stmt = conn.prepare(
        "SELECT id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at FROM books ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], book_from_row)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

/// Make `book_id` the active book — the one `cmd_today` composes its card from.
/// Switching books in the Today header is conceptually "opening" that book, the
/// same `last_opened_at` signal that import and `cmd_start_session` already
/// emit, so the selection survives the next `cmd_today` with no extra state.
fn activate_book(conn: &Connection, book_id: &str) -> Result<(), AppError> {
    if fetch_book(conn, book_id)?.is_none() {
        return Err(AppError::not_found("book", Some(book_id.to_string())));
    }
    bump_last_opened_at(conn, book_id)?;
    Ok(())
}

/// Book-switcher command. Bumps the target book's `last_opened_at` so the next
/// `cmd_today` returns it. Returns `()` — the frontend re-invokes `cmd_today`.
#[tauri::command]
pub fn cmd_set_active_book(book_id: String, state: State<DbState>) -> Result<(), AppError> {
    let conn = state.0.lock()?;
    activate_book(&conn, &book_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The book switcher's contract: activating a book makes it the active book
    /// (the one `cmd_today` reads from), and activating an unknown id is a
    /// `NotFound` rather than a silent no-op that leaves the user on the wrong
    /// book. Exercises the same `bump_last_opened_at` path the command uses.
    #[test]
    fn activate_book_changes_active_and_rejects_unknown() {
        let conn = rusqlite::Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT, author TEXT, source_type TEXT,
                source_path TEXT, source_sha256 TEXT, created_at TEXT, last_opened_at TEXT
             );",
        ).unwrap();
        // `a` was created later than `b` and neither has been opened, so `a`
        // wins the COALESCE(last_opened_at, created_at) tiebreaker initially.
        conn.execute(
            "INSERT INTO books (id, title, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('a', 'Book A', 'txt', '', '', '2026-01-02T00:00:00Z', NULL),
                    ('b', 'Book B', 'txt', '', '', '2026-01-01T00:00:00Z', NULL)",
            [],
        ).unwrap();
        assert_eq!(fetch_active_book(&conn).unwrap().unwrap().id, "a");

        // Switching to `b` bumps its last_opened_at to now → it becomes active.
        activate_book(&conn, "b").expect("activate existing book");
        assert_eq!(fetch_active_book(&conn).unwrap().unwrap().id, "b");

        // Unknown id is a NotFound, and leaves the active book unchanged.
        let err = activate_book(&conn, "ghost").expect_err("unknown book must error");
        assert!(matches!(err, AppError::NotFound { .. }));
        assert_eq!(fetch_active_book(&conn).unwrap().unwrap().id, "b");
    }

    /// Import dedup keys on `source_sha256` and resolves to the OLDEST matching
    /// row, so a re-import of the same file collapses onto the original book
    /// rather than creating yet another duplicate.
    #[test]
    fn fetch_book_by_sha_finds_oldest_and_misses_unknown() {
        let conn = rusqlite::Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT, author TEXT, source_type TEXT,
                source_path TEXT, source_sha256 TEXT, created_at TEXT, last_opened_at TEXT
             );",
        ).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('b_old', 'Dup', 'epub', '', 'deadbeef', '2026-01-01T00:00:00Z', NULL),
                    ('b_new', 'Dup', 'epub', '', 'deadbeef', '2026-02-01T00:00:00Z', NULL)",
            [],
        ).unwrap();

        let found = fetch_book_by_sha(&conn, "deadbeef").unwrap().expect("should find by sha");
        assert_eq!(found.id, "b_old", "dedup must resolve to the oldest matching import");
        assert!(fetch_book_by_sha(&conn, "no-such-hash").unwrap().is_none());
    }

    /// **CONTRACT**: The list the reader navigates over (returned by
    /// `cmd_assignable_sections`) MUST equal `sections.filter(assignable)`.
    /// If a future change leaks front matter back into the reader's nav
    /// sequence, this test fails loudly.
    #[test]
    fn canonical_list_equals_filter_assignable() {
        let conn = rusqlite::Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT, author TEXT, source_type TEXT,
                source_path TEXT, source_sha256 TEXT, created_at TEXT, last_opened_at TEXT
             );
             CREATE TABLE book_sections (
                id TEXT PRIMARY KEY, book_id TEXT, label TEXT, href TEXT,
                start_locator TEXT, end_locator TEXT, estimated_units INTEGER,
                sort_order INTEGER, assignable INTEGER NOT NULL DEFAULT 1
             );",
        ).unwrap();
        // Cold-Start-shaped seed: 51 sections, the leading 3 and trailing 5 marked non-assignable
        // (= 8 skipped, 43 assignable), plus source_type = 'txt' so the lazy EPUB reclassifier doesn't fire.
        conn.execute(
            "INSERT INTO books (id, title, source_type, source_path, source_sha256, created_at) VALUES ('b', 't', 'txt', '', '', '')",
            [],
        ).unwrap();
        let skip_idx: std::collections::HashSet<i64> = [0, 1, 2, 45, 47, 48, 49, 50].into_iter().collect();
        for i in 0..51i64 {
            let assignable = if skip_idx.contains(&i) { 0 } else { 1 };
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, sort_order, assignable)
                 VALUES (?1, 'b', ?2, ?3, ?4)",
                params![format!("sec_{}", i), format!("Section {}", i), i, assignable],
            ).unwrap();
        }

        let canonical = canonical_assignable_sections(&conn, "b").expect("canonical");
        let all = list_sections(&conn, "b").expect("list");
        let filtered: Vec<&BookSection> = all.iter().filter(|s| s.assignable).collect();

        assert_eq!(canonical.len(), filtered.len(), "canonical length must equal filter(assignable)");
        for (a, b) in canonical.iter().zip(filtered.iter()) {
            assert_eq!(a.id, b.id, "canonical order must match spine-ordered assignable filter");
            assert!(a.assignable, "front matter must never appear in canonical list");
        }
        assert_eq!(canonical.len(), 43);
        assert_eq!(canonical[0].id, "sec_3");
    }

    /// Pre-2.5 EPUB rows (everything `assignable=1`) without an actual source.epub on disk
    /// should NOT silently mark everything non-assignable. The reclassifier refuses any
    /// result that would empty the canonical list.
    #[test]
    fn canonical_list_safe_when_reclassify_fails() {
        let conn = rusqlite::Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE books (
                id TEXT PRIMARY KEY, title TEXT, author TEXT, source_type TEXT,
                source_path TEXT, source_sha256 TEXT, created_at TEXT, last_opened_at TEXT
             );
             CREATE TABLE book_sections (
                id TEXT PRIMARY KEY, book_id TEXT, label TEXT, href TEXT,
                start_locator TEXT, end_locator TEXT, estimated_units INTEGER,
                sort_order INTEGER, assignable INTEGER NOT NULL DEFAULT 1
             );",
        ).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, source_type, source_path, source_sha256, created_at)
             VALUES ('b_stale', 't', 'epub', '/nonexistent.epub', '', '')",
            [],
        ).unwrap();
        for i in 0..5i64 {
            conn.execute(
                "INSERT INTO book_sections (id, book_id, label, sort_order, assignable)
                 VALUES (?1, 'b_stale', ?2, ?3, 1)",
                params![format!("sec_{}", i), format!("Section {}", i), i],
            ).unwrap();
        }
        let canonical = canonical_assignable_sections(&conn, "b_stale").expect("canonical");
        assert_eq!(canonical.len(), 5);
    }
}

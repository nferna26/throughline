// Shot 1 REAL-TEXT probe — the AGENTS.md "one job" run against the genuine
// public-domain Augustine *Confessions* (Project Gutenberg #3296), not a
// synthesized fixture. This is the closest a headless agent can get to the live
// app: it drives the SAME command-layer functions the Tauri UI invokes
// (import::import_txt, plan::build_default_plan/compute, commands::books::
// read_txt_section, export::export_note) end-to-end and asserts the real-world
// behavior the manual QA checklist (docs/SHOT1_RC.md M1–M11) describes.
//
// It exercises, against the real file:
//   M1  import + chapter-like sectioning (BOOK/CHAPTER headings, not "Part N")
//   M3  Today is "plan ready / not behind" before any session (Priority 0)
//   M4  open day-1 section → real prose, no Gutenberg header bleed
//   M8  a TutorNote saves ONLY user-authored words (never the prompt/passage)
//   M9  exported Markdown is safe: source_private:true, locator, chapter, and
//       NOT the raw selected passage nor a ``` prompt fence
//   +   a normal session (completes a section) AND a rescue session (completes
//       zero sections but still ends — "that counts")
//
// GUARDRAIL: runs entirely under an ISOLATED temp data + export dir, so it can
// never touch the user's real DB or ~/GBrain.
//
// Usage: cargo run --example shot1_realtext -- /path/to/confessions.txt
//   (the real .txt is fetched out-of-band to /tmp; this binary never downloads)

use std::env;
use std::path::PathBuf;

use chrono::Utc;
use rusqlite::params;
use uuid::Uuid;

use throughline_lib::*;

/// A label is "chapter-like" if it reads as a real structural heading from the
/// book — a BOOK/CHAPTER/Roman-numeral heading — rather than the even-chunk
/// fallback the importer uses when it can't find headings ("Part N").
fn looks_chapter_like(label: &str) -> bool {
    let l = label.trim();
    let upper = l.to_uppercase();
    !upper.starts_with("PART ")
        && (upper.starts_with("BOOK ")
            || upper.starts_with("CHAPTER ")
            || upper.starts_with("CHAP")
            // a Roman-numeral-ish heading (possibly "— pt N" suffixed)
            || l.chars().take_while(|c| *c != ' ' && *c != '\u{2014}' && *c != '-')
                .all(|c| matches!(c, 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M' | '.'))
                && l.chars().any(|c| "IVXLCDM".contains(c)))
}

// `furthest` is a breadcrumb for the crash-report line; its intermediate writes
// are intentional, so silence the per-assignment "value never read" lint here.
#[allow(unused_assignments)]
fn main() -> anyhow::Result<()> {
    // GUARDRAIL: first line of main(). Isolates DATA + EXPORT under the OS temp
    // dir and panics if it didn't take — the real DB / ~/GBrain stay untouched.
    let isolated = bin_guardrail::init_isolated_data_dir("shot1_realtext");

    // Deterministic cleanup: the isolated dir is PID-scoped, so a recycled PID
    // from a prior crashed run can leave a half-migrated `reading.db` behind,
    // which then SIGBUSes on mmap. Remove it (the guardrail above already pinned
    // the path under the OS temp dir) and ensure the export root exists.
    if let Ok(db) = paths::db_path() {
        let _ = std::fs::remove_file(&db);
    }
    let _ = std::fs::create_dir_all(isolated.join("export"));

    let path = env::args().nth(1).map(PathBuf::from).ok_or_else(|| {
        anyhow::anyhow!("usage: cargo run --example shot1_realtext -- /path/to/confessions.txt")
    })?;
    if !path.exists() {
        return Err(anyhow::anyhow!("source file does not exist: {:?}", path));
    }

    // Tracks the furthest completed step for the crash-report line at the end;
    // intermediate writes are intentional breadcrumbs, so silence the
    // "value never read" lint on the reassignments.
    let mut furthest = "start";
    println!("==> REAL-TEXT probe against {:?}", path);
    println!("    isolated data/export root = {:?}", isolated);

    // ── M1: import the REAL text + chapter-like sectioning ─────────────────
    let result = import::import_txt(&path)?;
    let book = result.book.clone();
    let sections = result.sections.clone();
    furthest = "imported";

    assert_eq!(book.source_type, "txt", "Shot 1 is text-first");
    assert!(
        !book.source_sha256.is_empty(),
        "imported source must be SHA-256 hashed"
    );
    let assignable: Vec<&models::BookSection> = sections.iter().filter(|s| s.assignable).collect();
    assert!(
        assignable.len() >= 3,
        "real text must sectionize into multiple chapters, got {}",
        assignable.len()
    );
    // Real Gutenberg Confessions has BOOK I..XIII headings → the importer must
    // pick those up, NOT fall back to even "Part N" chunks.
    let part_like = assignable
        .iter()
        .filter(|s| s.label.to_uppercase().starts_with("PART "))
        .count();
    let chapterish = assignable
        .iter()
        .filter(|s| looks_chapter_like(&s.label))
        .count();
    println!("    title={:?} author={:?}", book.title, book.author);
    println!(
        "    sections={} assignable={} chapter_like={} part_like={}",
        sections.len(),
        assignable.len(),
        chapterish,
        part_like
    );
    println!(
        "    first 6 section labels: {:?}",
        assignable
            .iter()
            .take(6)
            .map(|s| s.label.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        chapterish >= 3,
        "sectioning must be chapter-like (BOOK/CHAPTER headings), got {} chapter-like of {}",
        chapterish,
        assignable.len()
    );
    assert_eq!(
        part_like, 0,
        "real text with BOOK headings must NOT fall back to even 'Part N' chunks"
    );

    // Persist via the same schema the app uses.
    let conn = db::open_and_migrate()?;
    conn.execute(
        "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![book.id, book.title, book.author, book.source_type, book.source_path, book.source_sha256, book.created_at, book.last_opened_at],
    )?;
    for s in &sections {
        conn.execute(
            "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator, s.estimated_units, s.sort_order, if s.assignable {1} else {0}],
        )?;
    }

    // ── 30-day plan ────────────────────────────────────────────────────────
    let plan = plan::build_default_plan(&book.id, &sections);
    conn.execute(
        "INSERT INTO reading_plans (id, book_id, start_date, target_finish_date, daily_target_units, days_per_week, catchup_mode, status, activated_at, original_finish_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![plan.id, plan.book_id, plan.start_date, plan.target_finish_date, plan.daily_target_units, plan.days_per_week, plan.catchup_mode, plan.status, plan.activated_at, plan.original_finish_date],
    )?;
    assert_eq!(plan::total_days(&plan), 30, "AGENTS.md: 30-day plan");
    furthest = "planned";

    // ── M3: Today is plan-ready / NOT behind before any session ────────────
    let computed = plan::compute(&plan, &sections, &[])?;
    assert_eq!(
        plan.status, "plan_ready",
        "fresh import is plan_ready, not active"
    );
    assert_eq!(
        computed.plan_status, "plan_ready",
        "computed plan_status mirrors plan_ready"
    );
    assert!(
        matches!(computed.pace, models::PaceState::NotStarted),
        "a freshly imported book must never read as behind, got {:?}",
        computed.pace
    );
    assert!(
        computed.forecast.is_none(),
        "no slip forecast before activation"
    );
    println!(
        "    Today: plan_status={} pace=NotStarted (calm, not behind) ✓",
        computed.plan_status
    );

    // ── M4: open day-1 section → real prose, no header bleed ───────────────
    let day1_idx = computed
        .assigned_section_index
        .expect("plan assigns a day-1 section");
    let day1 = sections[day1_idx].clone();
    assert!(day1.assignable, "day 1 must be an assignable section");
    assert!(
        looks_chapter_like(&day1.label),
        "day-1 label must be chapter-like, got {:?}",
        day1.label
    );
    let start: usize = day1
        .start_locator
        .as_deref()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    let end: Option<usize> = day1.end_locator.as_deref().and_then(|s| s.parse().ok());
    let body = commands::books::read_txt_section(&book.id, start, end)?;
    assert!(
        body.trim().chars().count() > 200,
        "day-1 section must render real prose"
    );
    assert!(
        !body.contains("START OF THE PROJECT GUTENBERG"),
        "PG header must not bleed into section text"
    );
    assert!(
        !body.contains("Project Gutenberg License"),
        "PG license must not bleed into section text"
    );
    println!(
        "    DAY 1 → {:?} ({} chars, no header bleed) ✓",
        day1.label,
        body.trim().chars().count()
    );
    furthest = "opened-day1";

    // ── Normal session: complete the day-1 section ─────────────────────────
    let now = Utc::now().to_rfc3339();
    let sess_full = format!("sess_{}", Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
        params![sess_full, book.id, now, now, format!("char:{}", start), format!("char:{}", end.unwrap_or(start)), 25_i64, 1_i64],
    )?;
    conn.execute(
        "INSERT INTO section_progress (book_id, section_id, completed_at, last_locator)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id, section_id) DO UPDATE SET completed_at = excluded.completed_at, last_locator = excluded.last_locator",
        params![book.id, day1.id, now, format!("char:{}", end.unwrap_or(start))],
    )?;
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM section_progress WHERE book_id = ?1 AND completed_at IS NOT NULL",
        params![book.id],
        |r| r.get(0),
    )?;
    assert_eq!(done, 1, "normal session completes exactly one section");

    // ── Rescue session: completes ZERO sections but still ends ("that counts")
    let sess_rescue = format!("sess_{}", Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
        params![sess_rescue, book.id, now, now, format!("char:{}", start), format!("char:{}", start), 10_i64, 0_i64],
    )?;
    let (ended, completed_assignment): (Option<String>, i64) = conn.query_row(
        "SELECT ended_at, completed_assignment FROM reading_sessions WHERE id = ?1",
        params![sess_rescue],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert!(ended.is_some(), "a rescue session still ends");
    assert_eq!(
        completed_assignment, 0,
        "rescue session forces no completion — and that counts"
    );
    let total_sessions: i64 = conn.query_row(
        "SELECT COUNT(*) FROM reading_sessions WHERE book_id = ?1",
        params![book.id],
        |r| r.get(0),
    )?;
    assert_eq!(
        total_sessions, 2,
        "both the normal and rescue sittings persisted"
    );
    println!("    sessions: 1 normal (1 section done) + 1 rescue (0 sections, still ended) ✓");
    furthest = "sessions";

    // ── M8/M9: a TutorNote saves ONLY user words; export leaks no passage ──
    // The "selected passage" is a real run from the day-1 section — exactly the
    // kind of text that must NEVER reach the exported Markdown. The note body is
    // the reader's own words (what the fixed tutor card requires).
    let passage: String = body.trim().chars().skip(20).take(80).collect();
    assert!(
        passage.len() > 20,
        "need a real passage to prove it is not exported"
    );
    let user_words = "My own paraphrase: the restless heart is the book's first note to itself.";
    let tutor = models::Note {
        id: format!("note_{}", Uuid::new_v4().simple()),
        book_id: book.id.clone(),
        session_id: Some(sess_full.clone()),
        note_type: "TutorNote".to_string(),
        locator: format!("char:{}", start + 20),
        chapter_label: Some(day1.label.clone()),
        body: user_words.to_string(),
        short_quote: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        exported_markdown_path: None,
        anchor_start: Some(format!("char:{}", start + 20)),
        anchor_end: Some(format!("char:{}", start + 20 + passage.chars().count())),
        anchored_text: Some(passage.clone()), // stored in DB only — must NOT export
    };
    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13)",
        params![tutor.id, tutor.book_id, tutor.session_id, tutor.note_type, tutor.locator, tutor.chapter_label, tutor.body, tutor.short_quote, tutor.created_at, tutor.updated_at, tutor.anchor_start, tutor.anchor_end, tutor.anchored_text],
    )?;
    let md_path = export::export_book_literature_note(
        &conn,
        &export::root_for(&conn),
        &book.id,
        &now,
    )?;
    let md = std::fs::read_to_string(&md_path)?;
    furthest = "exported";

    // Export landed in the isolated dir, never ~/GBrain.
    let sys_temp = std::env::temp_dir();
    assert!(
        md_path.starts_with(&sys_temp),
        "export escaped isolation: {:?}",
        md_path
    );
    // Required safe literature-note frontmatter + a reader-facing Tutor callout
    // (never the raw `TutorNote` enum) + the user's own words present.
    for needle in [
        "type: reading-source",
        "source_private: true",
        "> [!abstract] Tutor",
        "throughline_book_id: ",
        &format!("## {}", day1.label),
    ] {
        assert!(
            md.contains(needle),
            "exported TutorNote missing `{}`:\n{}",
            needle,
            md
        );
    }
    assert!(
        !md.contains("] TutorNote"),
        "the raw DB enum `TutorNote` must never be a reader-facing label:\n{}",
        md
    );
    assert!(
        md.contains(user_words),
        "the reader's own words must be exported"
    );
    // PRIVACY (AGENTS.md): the raw selected passage must NOT appear, and no AI
    // prompt fence should leak.
    assert!(
        !md.contains(passage.trim()),
        "PRIVACY VIOLATION: the selected passage leaked into exported Markdown"
    );
    assert!(
        !md.contains("```"),
        "no prompt fence markers in exported Markdown"
    );
    println!("    TutorNote export: user words present; raw passage absent; source_private:true ✓");
    println!("    exported → {}", md_path.display());

    println!("\n==> SHOT 1 REAL-TEXT OK (furthest step: {})", furthest);
    println!("    real import → chapter-like sections → 30-day plan → calm Today →");
    println!("    day-1 prose → normal+rescue sessions → safe TutorNote export");
    Ok(())
}

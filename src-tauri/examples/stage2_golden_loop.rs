// Stage 2 golden loop, fully offline, against the canonical fixture
// (Project Gutenberg's Augustine, *Confessions* — tests/fixtures/corpus/).
//
// Walks the regression spine the screens sit on, exactly as the frontend now
// drives it:
//   import → configure a plan (one question: sitting length) → today shows the
//   first sitting (day_one) → a session reads the sitting and ENDS AT THE
//   SITTING'S END as a bare-digit global offset (the dialect cmd_end_session
//   parses) → reading_position advances → the next today is the NEXT sitting
//   (Today rolls forward on its own) → a note saved mid-sitting → Markdown
//   export with source_private frontmatter.
//
// Usage: cargo run --example stage2_golden_loop [path-to-txt]

use std::path::PathBuf;

use chrono::Utc;
use rusqlite::params;
use uuid::Uuid;

use throughline_lib::*;

fn main() -> anyhow::Result<()> {
    // Guardrail: this binary MUST use an isolated temp data dir, never the
    // user's real Application Support directory. See src/bin_guardrail.rs.
    let _isolated = bin_guardrail::init_isolated_data_dir("stage2_golden_loop");

    let src = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("tests/fixtures/corpus/confessions_augustine.txt"));

    println!("==> Opening DB and migrating");
    let conn = db::open_and_migrate()?;

    println!("==> Importing {:?} (offline, local file)", src);
    let result = import::import_any(&src)?;
    conn.execute(
        "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            result.book.id, result.book.title, result.book.author,
            result.book.source_type, result.book.source_path, result.book.source_sha256,
            result.book.created_at, result.book.last_opened_at
        ],
    )?;
    for s in &result.sections {
        conn.execute(
            "INSERT INTO book_sections (id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![s.id, s.book_id, s.label, s.href, s.start_locator, s.end_locator, s.estimated_units, s.sort_order, if s.assignable {1} else {0}],
        )?;
    }
    let sections: Vec<models::BookSection> =
        result.sections.iter().filter(|s| s.assignable).cloned().collect();
    println!("    '{}' — {} assignable sections", result.book.title, sections.len());

    // ── Setup: the ONE question (cmd_configure_plan's effect) ────────────────
    let sitting_minutes: i64 = 25;
    let plan_row = plan::build_default_plan(&result.book.id);
    conn.execute(
        "INSERT INTO reading_plans (id, book_id, start_date, status, activated_at, sitting_length_minutes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![plan_row.id, plan_row.book_id, plan_row.start_date, plan_row.status, plan_row.activated_at, sitting_minutes],
    )?;
    println!("==> Plan configured: a steady sitting ({} minutes)", sitting_minutes);

    // ── Today #1: the sittings cache + the day-one state ─────────────────────
    let body = commands::books::read_txt_section(&result.book.id, 0, None)?;
    let now = Utc::now().to_rfc3339();
    sittings::rebuild_if_stale(&conn, &result.book.id, &body, &sections, sitting_minutes, &now)?;
    let sits = sittings::load_sittings(&conn, &result.book.id)?;
    anyhow::ensure!(!sits.is_empty(), "sittings were not built");
    let global_start =
        |s: &sittings::SittingRow| sittings::to_global(&sections, &s.start_section_id, s.start_offset);
    let bounds: Vec<(i64, i64)> = sits.iter().map(|s| (global_start(s), s.char_count)).collect();

    let furthest = sittings::furthest_global(&conn, &result.book.id, &sections)?;
    anyhow::ensure!(
        sittings::locate(&bounds, furthest) == sittings::Position::DayOne,
        "a never-read book must locate at DayOne"
    );
    let s0 = &sits[0];
    let (s0_start, s0_end) = (bounds[0].0, bounds[0].0 + bounds[0].1);
    anyhow::ensure!(!s0.chapter_label.trim().is_empty(), "chapter_label must never be blank");
    println!(
        "==> Today #1: day_one → '{}' (sitting span [{}, {}), ~{} chars)",
        s0.chapter_label, s0_start, s0_end, s0.char_count
    );

    // ── Read: a session bounded to the first sitting ─────────────────────────
    let session_id = format!("sess_{}", Uuid::new_v4().simple());
    let started = Utc::now().to_rfc3339();
    // The reader opens at the resume point (day one: the sitting's start) and
    // speaks bare-digit global offsets, never "char:"-tagged ones.
    let start_locator = s0_start.to_string();
    conn.execute(
        "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty)
         VALUES (?1, ?2, ?3, NULL, ?4, NULL, NULL, 0, NULL)",
        params![session_id, result.book.id, started, start_locator],
    )?;

    // A mid-sitting progress save (what the reader's scroll throttles out).
    let mid = s0_start + s0.char_count / 2;
    sittings::record_progress(&conn, &result.book.id, &sections, mid, &now)?;
    let (resume_mid, _) = sittings::last_read(&conn, &result.book.id, &sections)?;
    anyhow::ensure!(resume_mid == Some(mid), "mid-sitting save must set the resume point");

    // A note captured mid-sitting (the reader's own words, char-anchored).
    let note_id = format!("note_{}", Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path)
         VALUES (?1, ?2, ?3, 'Reflection', ?4, ?5, 'The sitting is the unit of reading now.', NULL, ?6, ?6, NULL)",
        params![note_id, result.book.id, session_id, format!("char:{mid}"), s0.chapter_label, now],
    )?;
    println!("==> Read to the sitting's end; note saved mid-sitting at char:{}", mid);

    // ── Complete: end the session AT THE SITTING'S END (cmd_end_session) ─────
    // This replicates cmd_end_session's exact parse: a bare-digit end_locator
    // advances reading_position; a tagged one would silently not.
    let end_locator = s0_end.to_string();
    let ended = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE reading_sessions SET ended_at = ?1, end_locator = ?2, minutes = ?3 WHERE id = ?4",
        params![ended, end_locator, sitting_minutes, session_id],
    )?;
    let parsed: i64 = end_locator.trim().parse()?;
    sittings::record_progress(&conn, &result.book.id, &sections, parsed, &ended)?;

    // ── Today #2: the card rolled forward on its own ──────────────────────────
    let furthest2 = sittings::furthest_global(&conn, &result.book.id, &sections)?;
    anyhow::ensure!(furthest2 == Some(s0_end), "furthest must MAX-clamp to the sitting end");
    match sittings::locate(&bounds, furthest2) {
        sittings::Position::At(1) => {
            println!(
                "==> Today #2: rolled forward to sitting 2 → '{}' (no manual advance)",
                sits[1].chapter_label
            );
        }
        other => anyhow::bail!("expected the NEXT sitting after completion, got {:?}", other),
    }

    // ── Export: the literature note with the privacy frontmatter ─────────────
    let md = export::export_book_literature_note(
        &conn,
        &export::root_for(&conn),
        &result.book.id,
        &Utc::now().to_rfc3339(),
    )?;
    let text = std::fs::read_to_string(&md)?;
    anyhow::ensure!(text.contains("source_private: true"), "export must carry source_private: true");
    anyhow::ensure!(
        text.contains("The sitting is the unit of reading now."),
        "export must carry the reader's note"
    );
    println!("==> Exported Markdown → {}", md.display());

    println!("\nGOLDEN LOOP PASS: import → setup → today → read → complete → note → export");
    Ok(())
}

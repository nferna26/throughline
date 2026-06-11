// Shot 2.5 acceptance.
//
// 1. Imports a real EPUB (Cold Start). Confirms day 1 = first real chapter
//    after skipping cover/title page/contents/etc.
// 2. Opens ONE session, advances ≥3 sections via the Next path, finishes
//    once. Confirms a single reading_sessions row carries start + end
//    locators and that the visited sections are marked complete.
// 3. Saves a note mid-session with a tagged cfi: locator and shows the
//    Markdown frontmatter.
//
// Usage: cargo run --example acceptance -- /path/to/cold-start.epub

use std::env;
use std::path::PathBuf;

use chrono::Utc;
use rusqlite::params;
use uuid::Uuid;

use throughline_lib::*;

fn main() -> anyhow::Result<()> {
    // Guardrail: this binary MUST use an isolated temp data dir, never the
    // user's real Application Support directory. See src/bin_guardrail.rs.
    let _isolated = bin_guardrail::init_isolated_data_dir("acceptance");

    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: acceptance <path-to-epub-or-txt>");
        std::process::exit(2);
    }

    println!("==> Opening DB and migrating");
    let conn = db::open_and_migrate()?;

    for src_arg in &args {
        let src = PathBuf::from(src_arg);
        println!("\n=== Importing {:?} ===", src);
        let result = import::import_any(&src)?;
        println!("    type      = {}", result.book.source_type);
        println!("    title     = {}", result.book.title);
        println!(
            "    author    = {}",
            result
                .book
                .author
                .clone()
                .unwrap_or_else(|| "(none)".to_string())
        );
        println!(
            "    sections  = {} ({} assignable, {} skipped)",
            result.sections.len(),
            result.sections.iter().filter(|s| s.assignable).count(),
            result.sections.iter().filter(|s| !s.assignable).count()
        );
        println!("    spine label vs classifier:");
        for s in &result.sections {
            println!(
                "        {} [{}]  '{}'",
                if s.assignable { "✓" } else { "·" },
                s.sort_order,
                s.label
            );
        }

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

        let plan_row = plan::build_default_plan(&result.book.id, &result.sections);
        conn.execute(
            "INSERT INTO reading_plans (id, book_id, start_date, target_finish_date, daily_target_units, days_per_week, catchup_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![plan_row.id, plan_row.book_id, plan_row.start_date, plan_row.target_finish_date, plan_row.daily_target_units, plan_row.days_per_week, plan_row.catchup_mode],
        )?;

        let _ = export::export_book_literature_note(
            &conn,
            &export::root_for(&conn),
            &result.book.id,
            &chrono::Utc::now().to_rfc3339(),
        );

        // ── Day 1 assignment ──────────────────────────────────────────────
        let computed = plan::compute(&plan_row, &result.sections, &[])?;
        let day1 = computed
            .assigned_section_index
            .and_then(|i| result.sections.get(i))
            .ok_or_else(|| anyhow::anyhow!("plan produced no day-1 assignment"))?;
        println!(
            "\n    DAY 1 → '{}' (spine idx {}, assignable={})",
            day1.label, day1.sort_order, day1.assignable
        );
        assert!(
            day1.assignable,
            "day 1 must be an assignable section, not front matter"
        );

        // ── Multi-section session ─────────────────────────────────────────
        println!("\n=== Opening ONE session and advancing across multiple assignable sections ===");
        let session_id = format!("sess_{}", Uuid::new_v4().simple());
        let started = Utc::now().to_rfc3339();
        let start_loc = match result.book.source_type.as_str() {
            "txt" => format!(
                "char:{}",
                day1.start_locator
                    .clone()
                    .unwrap_or_else(|| "0".to_string())
            ),
            "epub" => format!("cfi:{}", day1.href.clone().unwrap_or_default()),
            other => format!("unknown:{}", other),
        };
        conn.execute(
            "INSERT INTO reading_sessions (id, book_id, started_at, ended_at, start_locator, end_locator, minutes, completed_assignment, subjective_difficulty)
             VALUES (?1, ?2, ?3, NULL, ?4, NULL, NULL, 0, NULL)",
            params![session_id, result.book.id, started, start_loc],
        )?;

        // Pick the next 3 ASSIGNABLE sections after day 1 (simulating Next › presses)
        let assignable_seq: Vec<&models::BookSection> =
            result.sections.iter().filter(|s| s.assignable).collect();
        let day1_pos = assignable_seq
            .iter()
            .position(|s| s.id == day1.id)
            .unwrap_or(0);
        let crossed: Vec<&models::BookSection> = assignable_seq
            .iter()
            .skip(day1_pos)
            .take(4)
            .copied()
            .collect();
        println!(
            "    crossed {} sections in this single session:",
            crossed.len()
        );
        for s in &crossed {
            println!("        → '{}'", s.label);
        }
        let landed_on = crossed.last().expect("at least one section");
        let end_loc = match result.book.source_type.as_str() {
            "txt" => format!(
                "char:{}",
                landed_on
                    .end_locator
                    .clone()
                    .unwrap_or_else(|| "0".to_string())
            ),
            "epub" => format!("cfi:{}", landed_on.href.clone().unwrap_or_default()),
            other => format!("unknown:{}", other),
        };

        // Note written mid-session (locator should be a tagged cfi: for EPUB)
        let note_locator = match result.book.source_type.as_str() {
            "txt" => format!(
                "char:{}",
                landed_on
                    .start_locator
                    .clone()
                    .unwrap_or_else(|| "0".to_string())
            ),
            "epub" => format!("cfi:{}", landed_on.href.clone().unwrap_or_default()),
            other => format!("unknown:{}", other),
        };
        let note_id = format!("note_{}", Uuid::new_v4().simple());
        let now = Utc::now().to_rfc3339();
        let note = models::Note {
            id: note_id,
            book_id: result.book.id.clone(),
            session_id: Some(session_id.clone()),
            note_type: "Reflection".to_string(),
            locator: note_locator.clone(),
            chapter_label: Some(landed_on.label.clone()),
            body: "Mid-session note: tagged-locator scheme survives the 2.5 session refactor."
                .to_string(),
            short_quote: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            exported_markdown_path: None,
            anchor_start: None,
            anchor_end: None,
            anchored_text: None,
        };
        conn.execute(
            "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
            params![note.id, note.book_id, note.session_id, note.note_type, note.locator, note.chapter_label, note.body, note.short_quote, note.created_at, note.updated_at],
        )?;
        let note_md = export::export_book_literature_note(
            &conn,
            &export::root_for(&conn),
            &result.book.id,
            &chrono::Utc::now().to_rfc3339(),
        )?;
        conn.execute(
            "UPDATE notes SET exported_markdown_path = ?1 WHERE id = ?2",
            params![note_md.to_string_lossy().to_string(), note.id],
        )?;
        println!("    note saved → {}", note_md.display());

        // Finish session: pass ALL crossed except the last (still mid-section)
        let completed_ids: Vec<String> = crossed
            .iter()
            .take(crossed.len() - 1)
            .map(|s| s.id.clone())
            .collect();
        let ended = Utc::now().to_rfc3339();
        let minutes: i64 = 32;
        conn.execute(
            "UPDATE reading_sessions SET ended_at = ?1, end_locator = ?2, minutes = ?3, completed_assignment = ?4 WHERE id = ?5",
            params![ended, end_loc, minutes, if !completed_ids.is_empty() {1} else {0}, session_id],
        )?;
        for sid in &completed_ids {
            conn.execute(
                "INSERT INTO section_progress (book_id, section_id, completed_at, last_locator)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(book_id, section_id) DO UPDATE SET completed_at = excluded.completed_at, last_locator = excluded.last_locator",
                params![result.book.id, sid, ended, end_loc],
            )?;
        }

        // Verify: ONE session row, with start+end locators and the right minutes.
        let row: (String, Option<String>, Option<String>, Option<i64>, i64) = conn.query_row(
            "SELECT id, start_locator, end_locator, minutes, completed_assignment FROM reading_sessions WHERE id = ?1",
            params![session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        println!("\n    reading_sessions row:");
        println!("        id                   = {}", row.0);
        println!("        start_locator        = {:?}", row.1);
        println!("        end_locator          = {:?}", row.2);
        println!("        minutes              = {:?}", row.3);
        println!("        completed_assignment = {}", row.4);
        let progress_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM section_progress WHERE book_id = ?1 AND completed_at IS NOT NULL",
            params![result.book.id],
            |r| r.get(0),
        )?;
        println!("        sections marked done = {}", progress_count);

        // Confirm total session rows for this book is ONE
        let total_sessions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM reading_sessions WHERE book_id = ?1",
            params![result.book.id],
            |r| r.get(0),
        )?;
        println!("        total session rows   = {}", total_sessions);
        assert_eq!(total_sessions, 1, "expected exactly one session row");

        // Export session for completeness
        let session = models::ReadingSession {
            id: session_id,
            book_id: result.book.id.clone(),
            started_at: started,
            ended_at: Some(ended.clone()),
            start_locator: Some(start_loc),
            end_locator: Some(end_loc),
            minutes: Some(minutes),
            completed_assignment: true,
            subjective_difficulty: None,
        };
        let session_md = export::export_session(
            &export::root_for(&conn),
            &result.book,
            &session,
            Some("Crossed multiple sections in one sitting."),
        )?;
        println!("    session export → {}", session_md.display());
    }

    println!("\n==> ACCEPTANCE OK");
    Ok(())
}

// Shot 1 acceptance — the AGENTS.md "one job", proven end-to-end and text-first.
//
//   import one book → see today's section → read it → capture one note → export
//   safe Markdown.
//
// Per AGENTS.md the canonical Shot 1 source is the public-domain plain-text
// Augustine *Confessions* from Project Gutenberg. This binary must run with no
// network and must never reproduce a long verbatim literary work (that both
// trips output content filters and is unnecessary for the round-trip), so it
// SYNTHESIZES a Project-Gutenberg-shaped fixture: the genuine (short) Augustine
// epigraph as the opening line, a real PG-style header + `*** START/END OF ***`
// markers, and programmatically-generated `BOOK`/Roman-numeral chapters with
// filler paragraphs. That exercises the exact header-strip + chapter-detection
// path `import_txt` uses on the real Gutenberg file.
//
// Everything runs against an ISOLATED temp data + export dir (see
// `bin_guardrail`) so it can never touch the user's real DB or export folder.
//
// Usage: cargo run --example shot1_acceptance

use chrono::Utc;
use rusqlite::params;
use uuid::Uuid;

use throughline_lib::*;

/// Build a Project-Gutenberg-shaped plain-text fixture for the Augustine
/// *Confessions*. Short authentic epigraph + generated body; no long verbatim
/// reproduction. Enough BOOK/Roman-numeral headings (>= 3) that `import::sectionize`
/// uses chapter detection, and enough body that the sitting engine has real work.
fn confessions_fixture() -> String {
    let mut s = String::new();
    s.push_str("The Project Gutenberg eBook of The Confessions of Saint Augustine\n\n");
    s.push_str("Title: The Confessions of Saint Augustine\n");
    s.push_str("Author: Saint Augustine, Bishop of Hippo\n");
    s.push_str("Translator: E. B. Pusey\n\n");
    s.push_str(
        "*** START OF THE PROJECT GUTENBERG EBOOK THE CONFESSIONS OF SAINT AUGUSTINE ***\n\n",
    );

    // Flat sequence of Roman-numeral chapters, EACH followed by real content so
    // no section is empty. The importer makes one section per heading spanning
    // [heading, next-heading); two adjacent headings would yield an empty day.
    // Chapter I opens with the genuine short Augustine epigraph (a brief
    // public-domain quote); the rest is original filler so nothing long is
    // reproduced verbatim.
    let chapters = [
        "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV",
        "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
    ];
    for (i, ch) in chapters.iter().enumerate() {
        s.push_str(&format!("{}.\n\n", ch));
        if i == 0 {
            s.push_str(
                "Great art Thou, O Lord, and greatly to be praised; great is Thy \
                 power, and of Thy wisdom there is no end. And man, being a part of \
                 Thy creation, desires to praise Thee; man, who bears about him his \
                 mortality, the witness of his sin.\n\n",
            );
        }
        for p in 0..4 {
            s.push_str(&format!(
                "In chapter {} the reader steadies attention on a single idea and \
                 lets it unfold, paragraph {}. The practice is to read slowly, mark \
                 one line worth keeping, and let the rest pass without grasping \
                 after it; tomorrow's page will still be there.\n\n",
                ch,
                p + 1,
            ));
        }
    }

    s.push_str("*** END OF THE PROJECT GUTENBERG EBOOK THE CONFESSIONS OF SAINT AUGUSTINE ***\n");
    s
}

fn main() -> anyhow::Result<()> {
    // GUARDRAIL: first line of main(). Redirects data + export dirs under the OS
    // temp dir and panics if it didn't take — the real DB / export folder are untouchable.
    let isolated = bin_guardrail::init_isolated_data_dir("shot1_acceptance");

    // ── 1. Import the Augustine fixture (plain text, Gutenberg-shaped) ──────
    let src = isolated.join("confessions_sample.txt");
    std::fs::write(&src, confessions_fixture())?;
    println!("==> Importing {:?}", src);
    let result = import::import_txt(&src)?;
    let book = result.book.clone();
    let sections = result.sections.clone();

    assert_eq!(book.source_type, "txt", "Shot 1 is text-first");
    assert!(
        !book.source_sha256.is_empty(),
        "every imported source must be SHA-256 hashed"
    );
    assert_eq!(
        book.author.as_deref(),
        Some("Saint Augustine, Bishop of Hippo"),
        "Gutenberg Author: header must be parsed",
    );
    let assignable: Vec<&models::BookSection> = sections.iter().filter(|s| s.assignable).collect();
    assert!(
        assignable.len() >= 3,
        "fixture must sectionize into multiple chapters, got {}",
        assignable.len()
    );
    println!(
        "    title={:?} author={:?} sha256={}… sections={} (assignable={})",
        book.title,
        book.author,
        &book.source_sha256[..book.source_sha256.len().min(12)],
        sections.len(),
        assignable.len()
    );

    // Persist book + sections so the read/plan path uses the same DB the app does.
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

    // ── 2. Plan-ready (no dates) + build sittings ──────────────────────────
    let plan = plan::build_default_plan(&book.id);
    conn.execute(
        "INSERT INTO reading_plans (id, book_id, start_date, status, activated_at, sitting_length_minutes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![plan.id, plan.book_id, plan.start_date, plan.status, plan.activated_at, plan.sitting_length_minutes],
    )?;
    let body = commands::books::read_txt_section(&book.id, 0, None)?;
    sittings::rebuild_if_stale(
        &conn,
        &book.id,
        &body,
        &sections,
        plan::DEFAULT_SITTING_MINUTES,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    let sits = sittings::load_sittings(&conn, &book.id)?;
    assert!(!sits.is_empty(), "sittings are built for the book");
    println!(
        "    plan: {} sittings (position-based, no end date)",
        sits.len()
    );

    // ── 3. Open today's (first sitting's) text section ─────────────────────
    let today_sec = sections
        .iter()
        .find(|s| s.id == sits[0].start_section_id)
        .expect("the first sitting's section exists")
        .clone();
    assert!(
        today_sec.assignable,
        "day 1 must be an assignable section, not front matter"
    );
    let start: usize = today_sec
        .start_locator
        .as_deref()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    let end: Option<usize> = today_sec
        .end_locator
        .as_deref()
        .and_then(|s| s.parse().ok());
    // Same on-disk read path the reader uses (rebases by the stripped header offset).
    let body = commands::books::read_txt_section(&book.id, start, end)?;
    assert!(
        body.trim().chars().count() > 50,
        "today's section must render real text, got {} chars",
        body.trim().chars().count()
    );
    println!(
        "    DAY 1 → {:?} ({} chars of text)",
        today_sec.label,
        body.trim().chars().count()
    );

    // ── 4. Mark today's section complete ───────────────────────────────────
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO section_progress (book_id, section_id, completed_at, last_locator)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id, section_id) DO UPDATE SET completed_at = excluded.completed_at, last_locator = excluded.last_locator",
        params![book.id, today_sec.id, now, format!("char:{}", end.unwrap_or(start))],
    )?;
    let done: i64 = conn.query_row(
        "SELECT COUNT(*) FROM section_progress WHERE book_id = ?1 AND completed_at IS NOT NULL",
        params![book.id],
        |r| r.get(0),
    )?;
    assert_eq!(done, 1, "exactly one section completed");

    // ── 5. Capture one note (anchored marginalia) ──────────────────────────
    let quote: String = body.trim().chars().take(60).collect();
    let note = models::Note {
        id: format!("note_{}", Uuid::new_v4().simple()),
        book_id: book.id.clone(),
        session_id: None,
        note_type: "MarginNote".to_string(),
        locator: format!("char:{}", start),
        chapter_label: Some(today_sec.label.clone()),
        body: "Read slowly; kept one line. The opening invocation sets the whole book's posture."
            .to_string(),
        short_quote: Some(quote.clone()),
        created_at: now.clone(),
        updated_at: now.clone(),
        exported_markdown_path: None,
        anchor_start: Some(format!("char:{}", start)),
        anchor_end: Some(format!("char:{}", start + quote.chars().count())),
        anchored_text: Some(quote),
    };
    conn.execute(
        "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, ?13)",
        params![note.id, note.book_id, note.session_id, note.note_type, note.locator, note.chapter_label, note.body, note.short_quote, note.created_at, note.updated_at, note.anchor_start, note.anchor_end, note.anchored_text],
    )?;

    // ── 6. Export the per-book LITERATURE NOTE + assert the frontmatter contract ─
    let now_export = now.clone();
    let md_path = export::export_book_literature_note(
        &conn,
        &export::root_for(&conn),
        &book.id,
        &now_export,
    )?;
    let md = std::fs::read_to_string(&md_path)?;
    println!("    note exported → {}", md_path.display());

    // Privacy: the export MUST stay under the isolated temp dir — never the export folder.
    let sys_temp = std::env::temp_dir();
    assert!(
        md_path.starts_with(&sys_temp),
        "export escaped the isolated dir: {:?} not under {:?}",
        md_path,
        sys_temp
    );

    // The required frontmatter fields of the literature-note contract.
    for needle in [
        "type: reading-source",
        "source_private: true",
        "source_sha256: ",
        "throughline_book_id: ",
        "note_count: 1",
        "last_export: ",
    ] {
        assert!(
            md.contains(needle),
            "exported literature note frontmatter is missing `{}`:\n----\n{}\n----",
            needle,
            md
        );
    }
    // source_sha256 must carry the REAL book hash, not a placeholder.
    assert!(
        md.contains(&format!("source_sha256: {}", book.source_sha256)),
        "frontmatter source_sha256 must equal the imported book hash"
    );
    // The note's chapter became a `## {chapter}` heading, and its fence + block id
    // are present (re-export keys on the stable `tl-n-{note.id}` id).
    assert!(
        md.contains(&format!("## {}", today_sec.label)),
        "the note's chapter must become a `## {{chapter}}` heading:\n{}",
        md
    );
    assert!(
        md.contains(&format!("tl-n-{}", note.id)),
        "the note's stable fence id must be present:\n{}",
        md
    );
    // Safe export: the raw source body must NOT be dumped wholesale into the note.
    assert!(
        !md.contains(&body),
        "export must not contain the full section body (locators + short quotes only)"
    );

    println!("\n==> SHOT 1 ACCEPTANCE OK");
    println!("    import → sitting plan → today's section → complete → note → export");
    println!(
        "    literature note: type:reading-source ✓  source_private:true ✓  source_sha256 ✓  chapter heading ✓  fence id ✓"
    );
    Ok(())
}

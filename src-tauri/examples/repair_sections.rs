// One-shot operator repair: re-run the (fixed) sectionizer on a txt book's saved
// source and replace its DB sections. Fixes books imported before the
// Table-of-Contents sectionize fix, whose sections were degenerate contents-list
// stubs with no body text (the reader showed only a heading, no prose).
//
// Non-destructive: the immutable source.txt is untouched; only the derived
// book_sections rows are rebuilt, using the SAME body window (body_offsets.json)
// the reader maps locators against, so positions line up. Books that already
// have reading history are skipped (unless named explicitly) so an established
// reading position is never disturbed.
//
// Usage:
//   cargo run --example repair_sections                 # all unread txt books
//   cargo run --example repair_sections -- <book_id>    # one specific book
use rusqlite::params;
use std::fs;
use std::path::Path;
use throughline_lib::*;

fn main() -> anyhow::Result<()> {
    let target = std::env::args().nth(1); // None => all unread txt books
    let conn = db::open_and_migrate()?;

    let mut stmt = conn.prepare(
        "SELECT id, title, source_path FROM books WHERE source_type = 'txt' ORDER BY created_at ASC",
    )?;
    let books: Vec<(String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    for (id, title, source_path) in books {
        if let Some(t) = &target {
            if t != &id {
                continue;
            }
        }

        let sessions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM reading_sessions WHERE book_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let notes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE book_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if (sessions > 0 || notes > 0) && target.is_none() {
            println!("→ skip '{title}' [{id}] — has reading history ({sessions} sessions, {notes} notes)");
            continue;
        }

        let src = Path::new(&source_path);
        let dir = src.parent().expect("book dir");
        let raw = fs::read_to_string(src)?;
        let offsets: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("body_offsets.json"))?)?;
        let body_start = offsets["body_start"].as_u64().unwrap_or(0) as usize;
        let body_end =
            (offsets["body_end"].as_u64().unwrap_or(raw.len() as u64) as usize).min(raw.len());
        let body = &raw[body_start..body_end];

        let new_secs = import::sectionize(body);
        let assignable_flags = import::classify_assignable(&new_secs, body);
        let before: i64 = conn.query_row(
            "SELECT COUNT(*) FROM book_sections WHERE book_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        println!(
            "→ '{title}' [{id}]: {before} old sections → {} new",
            new_secs.len()
        );

        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM book_sections WHERE book_id = ?1", params![id])?;
        for (i, (label, s, e)) in new_secs.iter().enumerate() {
            let sec = models::BookSection {
                id: format!("sec_{}", uuid::Uuid::new_v4().simple()),
                book_id: id.clone(),
                label: label.clone(),
                href: None,
                start_locator: Some(s.to_string()),
                end_locator: Some(e.to_string()),
                estimated_units: Some((e - s) as i64),
                sort_order: i as i64,
                assignable: assignable_flags[i],
            };
            commands::db_helpers::insert_section(&tx, &sec)?;
        }
        tx.commit()?;

        for (i, (label, s, e)) in new_secs.iter().take(3).enumerate() {
            let snip: String = body[*s..*e]
                .chars()
                .filter(|c| !c.is_control())
                .take(46)
                .collect();
            println!("    [{i}] {label} ({} chars): {}", e - s, snip.trim());
        }
    }
    Ok(())
}

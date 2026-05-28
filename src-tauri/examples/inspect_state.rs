// Inspect the live DB for a book: shows the full sections list (with assignable
// flags) vs the canonical assignable-only list the reader walks. If the book is
// an EPUB with stale assignable=1 across the board, the canonical command will
// trigger a lazy reclassify in place; this binary will reflect the new state on
// a second run.
use rusqlite::params;
use reading_gym_lib::*;

fn main() -> anyhow::Result<()> {
    let conn = db::open_and_migrate()?;

    let mut stmt = conn.prepare("SELECT id, title, source_type FROM books ORDER BY created_at ASC")?;
    let books: Vec<(String, String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    for (book_id, title, source_type) in &books {
        println!("\n=== {} [{}] ({}) ===", title, source_type, book_id);
        let sections = conn
            .prepare(
                "SELECT id, label, assignable, sort_order FROM book_sections
                 WHERE book_id = ?1 ORDER BY sort_order ASC",
            )?
            .query_map(params![book_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let total = sections.len();
        let n_assignable_before = sections.iter().filter(|(_, _, a, _)| *a == 1).count();
        println!("    sections: {} total, {} assignable before canonical fetch", total, n_assignable_before);
        if n_assignable_before == total && source_type == "epub" {
            println!("    → this looks pre-2.5 (every section assignable). Canonical fetch will lazy-reclassify.");
        }

        // Touch the canonical fetch path the readers use. The function lives in lib.rs
        // and is exposed via the `cmd_assignable_sections` Tauri command; we can't call
        // the command directly outside Tauri, but we can re-run the same logic by
        // querying again after the next reader open — for now this print is sufficient
        // diagnostic. We instead simulate the canonical filter manually:
        let canonical: Vec<&(String, String, i64, i64)> = sections.iter().filter(|(_, _, a, _)| *a == 1).collect();
        println!("    canonical list (assignable-only, in spine order): {} entries", canonical.len());
        for (i, (_id, label, _a, sort)) in canonical.iter().take(10).enumerate() {
            println!("        [{}] spine_idx={} '{}'", i, sort, label);
        }
        if canonical.len() > 10 {
            println!("        … ({} more)", canonical.len() - 10);
        }
    }
    Ok(())
}

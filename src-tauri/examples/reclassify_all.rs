// One-shot: run the canonical-list fetch for every book in the DB. This
// triggers the lazy EPUB reclassifier in lib::canonical_assignable_sections
// for any stale pre-2.5 row. Safe to run repeatedly — it's a no-op once the
// data is current.
use rusqlite::params;
use reading_gym_lib::*;

fn main() -> anyhow::Result<()> {
    let conn = db::open_and_migrate()?;
    let mut stmt = conn.prepare("SELECT id, title FROM books ORDER BY created_at ASC")?;
    let books: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, title) in books {
        println!("\n→ '{}' [{}]", title, id);
        // Sections in DB before
        let before: i64 = conn.query_row(
            "SELECT SUM(assignable) FROM book_sections WHERE book_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM book_sections WHERE book_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        println!("    before: {} of {} assignable", before, total);

        // Use the public API surface exactly the way Tauri would.
        let canonical = invoke_canonical(&conn, &id)?;
        println!("    canonical length: {}", canonical.len());
        if !canonical.is_empty() {
            println!("    first 5 canonical entries:");
            for (i, s) in canonical.iter().take(5).enumerate() {
                println!("        [{}] spine_idx={} '{}'", i, s.sort_order, s.label);
            }
        }

        let after: i64 = conn.query_row(
            "SELECT SUM(assignable) FROM book_sections WHERE book_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        println!("    after:  {} of {} assignable {}",
            after, total,
            if after != before { "(lazy reclassify applied)" } else { "" });
    }
    Ok(())
}

// Bypass the Tauri State<>; reach into the pure function the command calls.
fn invoke_canonical(conn: &rusqlite::Connection, book_id: &str) -> anyhow::Result<Vec<models::BookSection>> {
    // canonical_assignable_sections is not pub from the lib crate; we re-implement
    // the same path here using public helpers + a direct UPDATE so the diagnostic
    // doesn't drag in private items. (Production code calls the cmd_ from JS.)
    use std::collections::HashMap;

    // Step 1: load current rows
    let mut all: Vec<models::BookSection> = conn
        .prepare(
            "SELECT id, book_id, label, href, start_locator, end_locator, estimated_units, sort_order, assignable
             FROM book_sections WHERE book_id = ?1 ORDER BY sort_order ASC",
        )?
        .query_map(params![book_id], |r| {
            let assignable: i64 = r.get::<_, Option<i64>>(8)?.unwrap_or(1);
            Ok(models::BookSection {
                id: r.get(0)?, book_id: r.get(1)?, label: r.get(2)?,
                href: r.get(3)?, start_locator: r.get(4)?, end_locator: r.get(5)?,
                estimated_units: r.get(6)?, sort_order: r.get(7)?,
                assignable: assignable != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let source_type: Option<String> = conn.query_row(
        "SELECT source_type FROM books WHERE id = ?1",
        params![book_id], |r| r.get(0),
    ).ok();

    let all_assignable = !all.is_empty() && all.iter().all(|s| s.assignable);
    if matches!(source_type.as_deref(), Some("epub")) && all_assignable {
        // Re-parse spine + TOC, recompute assignable per href.
        let src = paths::book_dir(book_id)?.join("source.epub");
        if src.exists() {
            let doc = epub::doc::EpubDoc::new(&src)?;
            let mut toc_pairs: Vec<(String, String)> = Vec::new();
            walk_toc(&doc.toc, &mut toc_pairs, 0);
            let mut label_by_href: HashMap<String, String> = HashMap::new();
            for (l, h) in &toc_pairs {
                label_by_href.entry(strip_frag(h)).or_insert_with(|| l.clone());
            }
            let mut meta_by_href: HashMap<String, (String, bool, Option<String>)> = HashMap::new();
            for item in &doc.spine {
                if let Some(res) = doc.resources.get(&item.idref) {
                    let h = strip_frag(&res.path.to_string_lossy());
                    let label = label_by_href.get(&h).cloned();
                    meta_by_href.insert(h, (item.idref.clone(), item.linear, label));
                }
            }

            let mut updates: Vec<(String, bool)> = Vec::new();
            let mut any = false;
            for s in &all {
                let new_a = if let Some(h) = &s.href {
                    if let Some((idref, linear, label)) = meta_by_href.get(&strip_frag(h)) {
                        !epub_classify::is_front_back_matter(label.as_deref(), idref, *linear)
                    } else { true }
                } else { true };
                if new_a { any = true; }
                updates.push((s.id.clone(), new_a));
            }
            if any {
                for (sid, new_a) in &updates {
                    conn.execute(
                        "UPDATE book_sections SET assignable = ?1 WHERE id = ?2",
                        params![if *new_a {1} else {0}, sid],
                    )?;
                }
                for s in all.iter_mut() {
                    if let Some((_, na)) = updates.iter().find(|(sid, _)| sid == &s.id) {
                        s.assignable = *na;
                    }
                }
            }
        }
    }
    Ok(all.into_iter().filter(|s| s.assignable).collect())
}

fn strip_frag(h: &str) -> String {
    match h.find('#') { Some(i) => h[..i].to_string(), None => h.to_string() }
}
fn walk_toc(nav: &[epub::doc::NavPoint], out: &mut Vec<(String, String)>, depth: usize) {
    for n in nav {
        let label = n.label.trim().to_string();
        let href = n.content.to_string_lossy().to_string();
        if !label.is_empty() && !href.is_empty() {
            out.push((label, href));
        }
        if depth < 1 { walk_toc(&n.children, out, depth + 1); }
    }
}

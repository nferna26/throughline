//! Build a book's "sittings" — the time-sized reading units the reader sits down
//! with — from the chapter backbone (`book_sections`) and the body text, sized to
//! the reader's chosen sitting length.
//!
//! `plan_sittings` is pure: given the body and the sections, it extracts break
//! points (chapter boundaries + paragraph gaps), runs the [`crate::chunker`], and
//! labels each sitting from the chapter(s) it covers. Boundaries are stored
//! SECTION-RELATIVE (start_section_id + offset within that section) so a
//! normalization tweak in one chapter cannot move the reader's place in another;
//! `char_count` is the span and `est_minutes` is derived at read time.
//!
//! `rebuild_if_stale` is the only DB-touching piece: it compares the book's
//! current (content_fingerprint, sitting_length, chunker_version) tuple against
//! `sittings_meta` and, on a mismatch, DELETEs and recomputes. Sittings are a
//! derived cache: nothing durable references a sitting id.

use crate::chunker::{self, Break, BreakKind};
use crate::models::BookSection;
use rusqlite::{params, Connection, OptionalExtension};

/// Opening-slice cap for the phrase cache key. Must match the relay side exactly
/// (the relay hashes the same normalized slice), so changing this is a protocol
/// change, not a local tweak.
const OPENING_CHARS: usize = 1800;

/// A sitting ready to persist. Section-relative start; `char_count` drives
/// `est_minutes` at read time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedSitting {
    pub sort_order: i64,
    pub start_section_id: String,
    pub start_offset: i64,
    pub char_count: i64,
    pub chapter_label: String,
    pub opening_hash: String,
}

struct SecBound {
    id: String,
    label: String,
    start: usize,
    end: usize,
    assignable: bool,
}

/// Global `[start, end)` byte bounds per section, filling gaps so a missing
/// locator falls back to the previous section's end / the next section's start.
fn section_bounds(body_len: usize, sections: &[BookSection]) -> Vec<SecBound> {
    let mut out: Vec<SecBound> = Vec::with_capacity(sections.len());
    for (i, s) in sections.iter().enumerate() {
        let start = parse_loc(s.start_locator.as_deref())
            .unwrap_or_else(|| out.last().map(|b| b.end).unwrap_or(0));
        let end = parse_loc(s.end_locator.as_deref())
            .or_else(|| sections.get(i + 1).and_then(|n| parse_loc(n.start_locator.as_deref())))
            .unwrap_or(body_len)
            .min(body_len);
        let start = start.min(end);
        out.push(SecBound {
            id: s.id.clone(),
            label: s.label.clone(),
            start,
            end,
            assignable: s.assignable,
        });
    }
    out
}

fn parse_loc(s: Option<&str>) -> Option<usize> {
    s.and_then(|x| x.trim().parse::<usize>().ok())
}

/// Plan the sittings for a book. Pure over `body` + `sections`.
pub fn plan_sittings(body: &str, sections: &[BookSection], sitting_minutes: i64) -> Vec<PlannedSitting> {
    let body_len = body.len();
    let bounds = section_bounds(body_len, sections);
    let assignable: Vec<&SecBound> = bounds.iter().filter(|b| b.assignable).collect();
    if assignable.is_empty() {
        return Vec::new();
    }
    let span_start = assignable.first().unwrap().start;
    let span_end = assignable.last().unwrap().end.min(body_len);
    if span_start >= span_end {
        return Vec::new();
    }

    // Break points within the assignable span: chapter starts (preferred ends) and
    // paragraph boundaries (the fallback the chunker uses to split long chapters).
    let mut breaks: Vec<Break> = Vec::new();
    for b in &bounds {
        if b.start > span_start && b.start < span_end {
            breaks.push(Break { offset: b.start, kind: BreakKind::Chapter });
        }
    }
    let bytes = body.as_bytes();
    let mut i = span_start;
    while i < span_end {
        match body[i..span_end].find("\n\n") {
            Some(rel) => {
                let pos = i + rel;
                let mut after = pos;
                while after < span_end && bytes[after] == b'\n' {
                    after += 1;
                }
                if after > span_start && after < span_end {
                    breaks.push(Break { offset: after, kind: BreakKind::Paragraph });
                }
                i = after.max(pos + 1);
            }
            None => break,
        }
    }

    let target = chunker::target_chars_for_minutes(sitting_minutes);
    let sittings = chunker::chunk(span_end, &breaks, span_start, target);

    sittings
        .into_iter()
        .enumerate()
        .map(|(idx, s)| {
            let (sec_id, sec_start) = bounds
                .iter()
                .find(|b| s.start >= b.start && s.start < b.end)
                .or_else(|| bounds.iter().rev().find(|b| s.start >= b.start))
                .map(|b| (b.id.clone(), b.start))
                .unwrap_or_else(|| (bounds.first().map(|b| b.id.clone()).unwrap_or_default(), 0));
            PlannedSitting {
                sort_order: idx as i64,
                start_section_id: sec_id,
                start_offset: (s.start - sec_start) as i64,
                char_count: s.char_count() as i64,
                chapter_label: label_for(s.start, s.end, &bounds),
                opening_hash: opening_hash(slice(body, s.start, s.end)),
            }
        })
        .collect()
}

/// The always-present heuristic label for a sitting spanning global `[start, end)`.
fn label_for(start: usize, end: usize, bounds: &[SecBound]) -> String {
    let overlapped: Vec<&SecBound> = bounds.iter().filter(|b| b.start < end && b.end > start).collect();
    match overlapped.as_slice() {
        [] => "Reading".to_string(),
        [b] => {
            if start > b.start {
                format!("{}, continued", b.label)
            } else {
                b.label.clone()
            }
        }
        many => many.first().unwrap().label.clone(),
    }
}

/// Stable cache key for a sitting's opening slice: whitespace-collapsed, capped,
/// SHA-256 hex. Mirrored by the relay so a phrase computed either side matches.
pub fn opening_hash(text: &str) -> String {
    sha256_hex(normalize_opening(text).as_bytes())
}

pub fn normalize_opening(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(OPENING_CHARS).collect()
}

/// Fingerprint of the normalized body. Changes when the text or the parse changes,
/// which is what triggers a re-chunk.
pub fn content_fingerprint(body: &str) -> String {
    sha256_hex(body.as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Char-boundary-safe byte slice.
fn slice(body: &str, start: usize, end: usize) -> &str {
    let snap = |i: usize| {
        let mut i = i.min(body.len());
        while i > 0 && !body.is_char_boundary(i) {
            i -= 1;
        }
        i
    };
    &body[snap(start)..snap(end.max(start))]
}

/// Rebuild a book's sittings iff its (fingerprint, sitting_length, chunker_version)
/// tuple no longer matches `sittings_meta`. DELETE + recompute; nothing durable
/// references a sitting id, so this is always safe.
pub fn rebuild_if_stale(
    conn: &Connection,
    book_id: &str,
    body: &str,
    sections: &[BookSection],
    sitting_minutes: i64,
    now: &str,
) -> rusqlite::Result<bool> {
    let fingerprint = content_fingerprint(body);
    let current: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT content_fingerprint, sitting_length_minutes, chunker_version FROM sittings_meta WHERE book_id = ?1",
            params![book_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let have_rows: i64 =
        conn.query_row("SELECT count(*) FROM sittings WHERE book_id = ?1", params![book_id], |r| r.get(0))?;
    let fresh = have_rows > 0
        && matches!(&current, Some((fp, m, v))
            if *fp == fingerprint && *m == sitting_minutes && *v == chunker::CHUNKER_VERSION);
    if fresh {
        return Ok(false);
    }

    let planned = plan_sittings(body, sections, sitting_minutes);
    conn.execute("DELETE FROM sittings WHERE book_id = ?1", params![book_id])?;
    for p in &planned {
        conn.execute(
            "INSERT INTO sittings
               (id, book_id, sort_order, start_section_id, start_offset, char_count, chapter_label, opening_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                format!("st_{book_id}_{}", p.sort_order),
                book_id,
                p.sort_order,
                p.start_section_id,
                p.start_offset,
                p.char_count,
                p.chapter_label,
                p.opening_hash,
            ],
        )?;
    }
    conn.execute(
        "INSERT INTO sittings_meta (book_id, content_fingerprint, sitting_length_minutes, chunker_version, built_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id) DO UPDATE SET
           content_fingerprint = excluded.content_fingerprint,
           sitting_length_minutes = excluded.sitting_length_minutes,
           chunker_version = excluded.chunker_version,
           built_at = excluded.built_at",
        params![book_id, fingerprint, sitting_minutes, chunker::CHUNKER_VERSION, now],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(id: &str, label: &str, start: usize, end: usize, assignable: bool) -> BookSection {
        BookSection {
            id: id.into(),
            book_id: "b".into(),
            label: label.into(),
            href: None,
            start_locator: Some(start.to_string()),
            end_locator: Some(end.to_string()),
            estimated_units: Some((end - start) as i64),
            sort_order: 0,
            assignable,
        }
    }

    /// A body of two chapters, three + two paragraphs of ~1080 chars each.
    fn make_body() -> (String, Vec<BookSection>) {
        let para = || "lorem ipsum dolor sit amet consectetur ".repeat(28); // ~1100 chars
        let ch1 = format!("{}\n\n{}\n\n{}", para(), para(), para());
        let ch2 = format!("{}\n\n{}", para(), para());
        let body = format!("{ch1}\n\n{ch2}");
        let ch2_start = ch1.len() + 2;
        let sections = vec![
            section("s1", "Chapter I", 0, ch1.len(), true),
            section("s2", "Chapter II", ch2_start, body.len(), true),
        ];
        (body, sections)
    }

    /// Resolve a planned sitting's section-relative anchor against a section set,
    /// returning the text it points at (char-safe).
    fn resolve<'a>(p: &PlannedSitting, sections: &[BookSection], body: &'a str) -> &'a str {
        let base: usize = sections
            .iter()
            .find(|s| s.id == p.start_section_id)
            .and_then(|s| parse_loc(s.start_locator.as_deref()))
            .unwrap_or(0);
        let start = base + p.start_offset as usize;
        slice(body, start, start + p.char_count as usize)
    }

    #[test]
    fn plans_contiguous_sittings_with_labels_and_no_runt() {
        let (body, sections) = make_body();
        let plan = plan_sittings(&body, &sections, 1); // 1 min ~ 1000 chars
        assert!(plan.len() >= 3, "expected several sittings, got {}", plan.len());
        // Contiguous, full coverage of [0, body.len()).
        let mut cursor = 0usize;
        for p in &plan {
            let base = parse_loc(sections.iter().find(|s| s.id == p.start_section_id).unwrap().start_locator.as_deref()).unwrap();
            assert_eq!(base + p.start_offset as usize, cursor, "sittings must be contiguous");
            assert!(p.char_count > 0, "no empty sitting");
            assert!(!p.chapter_label.is_empty(), "label always present");
            cursor += p.char_count as usize;
        }
        assert_eq!(cursor, body.len(), "sittings cover the whole assignable span");
        // No runt: the last sitting isn't trivially short.
        let last = plan.last().unwrap();
        assert!(last.char_count as usize >= 400, "no runt final sitting");
        // Labels reflect chapter then continuation then chapter two.
        assert_eq!(plan[0].chapter_label, "Chapter I");
        assert!(plan.iter().any(|p| p.chapter_label == "Chapter I, continued"));
        assert!(plan.iter().any(|p| p.chapter_label.starts_with("Chapter II")));
    }

    #[test]
    fn front_matter_is_excluded_from_sittings() {
        let (body, mut sections) = make_body();
        // Prepend a non-assignable front-matter section covering the first chapter's
        // start; make chapter one start later. Simplest: mark s1 non-assignable.
        sections[0].assignable = false;
        let plan = plan_sittings(&body, &sections, 1);
        // Every sitting begins inside chapter II (the only assignable section).
        assert!(plan.iter().all(|p| p.start_section_id == "s2"), "only assignable content is chunked");
    }

    #[test]
    fn opening_hash_is_stable_and_whitespace_insensitive() {
        let a = opening_hash("  The   second   night \n at the castle.  ");
        let b = opening_hash("The second night at the castle.");
        assert_eq!(a, b, "whitespace is normalized out of the hash");
        assert_eq!(a.len(), 64, "sha-256 hex");
    }

    /// The done-criterion: section-relative locators survive a re-parse that shifts
    /// every global offset. After prepending a header (which moves all global
    /// offsets), each stored locator still resolves to identical text.
    #[test]
    fn locators_resolve_to_identical_text_after_reparse_shifts_offsets() {
        let (body1, sections1) = make_body();
        let plan = plan_sittings(&body1, &sections1, 1);
        let texts1: Vec<&str> = plan.iter().map(|p| resolve(p, &sections1, &body1)).collect();

        // Re-parse: same content, but a header prepended shifts all global offsets.
        let header = "A PUBLISHER'S PREFACE, NEWLY ADDED.\n\n";
        let body2 = format!("{header}{body1}");
        let shift = header.len();
        let sections2: Vec<BookSection> = sections1
            .iter()
            .map(|s| {
                let mut s2 = s.clone();
                s2.start_locator = Some((parse_loc(s.start_locator.as_deref()).unwrap() + shift).to_string());
                s2.end_locator = Some((parse_loc(s.end_locator.as_deref()).unwrap() + shift).to_string());
                s2
            })
            .collect();

        // Resolve the SAME planned anchors against the shifted sections/body.
        for (p, t1) in plan.iter().zip(&texts1) {
            let t2 = resolve(p, &sections2, &body2);
            assert_eq!(t2, *t1, "section-relative locator must resolve to identical text after re-parse");
        }
    }
}

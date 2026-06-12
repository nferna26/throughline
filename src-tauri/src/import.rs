use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use uuid::Uuid;

use crate::gutenberg_markup;
use crate::models::{Book, BookSection};
use crate::paths;

/// Approximate words-per-minute for "serious reading" pace
pub const WPM: i64 = 200;
/// Upper bound on a .txt source file (bytes). `import_txt` reads the whole
/// file into memory, so an accidental multi-GB drop (a log, a dataset) would
/// balloon memory and stall the app. 100 MB is ~30× War & Peace (~3.2 MB) —
/// far past any real book. EPUBs have their own accumulated-extraction cap
/// (`import_epub::MAX_EXTRACTED_BODY_BYTES`).
pub const MAX_TXT_BYTES: u64 = 100 * 1024 * 1024;

/// Pure guard for the .txt size cap: is a file of `len` bytes importable?
pub fn txt_size_ok(len: u64) -> bool {
    len <= MAX_TXT_BYTES
}
/// Target section length in characters (~10–15 min reading)
pub const TARGET_SECTION_CHARS: usize = 9_000;
/// Minimum prose (chars) that must follow a heading for it to count as a real
/// chapter start. A real chapter is followed by a chapter's worth of text; a
/// Table-of-Contents entry is followed almost immediately by the next heading.
/// This is what separates "Chapter 1 … Chapter 24" in a contents list from the
/// actual chapter bodies far below it.
const MIN_CHAPTER_GAP_CHARS: usize = 200;

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportManifest {
    pub book_id: String,
    pub title: String,
    pub author: Option<String>,
    pub source_type: String,
    pub source_filename: String,
    pub source_sha256: String,
    pub imported_at: String,
    pub total_chars: usize,
    pub section_count: usize,
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).with_context(|| format!("open {:?}", path))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Try to extract title/author from a Project Gutenberg header.
/// Returns (title, author, body_offset) where body_offset is the char index
/// where the actual book begins (after "*** START OF ..." line, if present).
pub fn extract_gutenberg_meta(text: &str) -> (Option<String>, Option<String>, usize) {
    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut body_offset: usize = 0;

    for line in text.lines().take(200) {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Title:") {
            title = Some(rest.trim().to_string());
        } else if let Some(rest) = l.strip_prefix("Author:") {
            author = Some(rest.trim().to_string());
        }
    }

    // Find body start
    if let Some(idx) = text.find("*** START OF") {
        if let Some(nl) = text[idx..].find('\n') {
            body_offset = idx + nl + 1;
        }
    }

    // Find body end (trim Gutenberg footer)
    (title, author, body_offset)
}

pub fn body_end_offset(text: &str) -> usize {
    if let Some(idx) = text.find("*** END OF") {
        idx
    } else {
        text.len()
    }
}

/// Split body text into sections.
///
/// In order of preference:
///   1. Heading detection (`^Chapter N`, `^CHAPTER N`, `Book N`, Roman numerals) —
///      the tuned `detect_chapters` path. Kept FIRST so books with explicit
///      chapter markers (Moby Dick, Dracula, …) section exactly as before.
///   2. INFERRED BOOK STRUCTURE (`book_structure::analyze`) — used only when
///      heading detection found < 3 chapters (the fallback territory). A
///      recognised title page + table of contents is carved into a leading
///      FRONT-MATTER section, and the body is split on chapters matched from the
///      contents list (the Walden fix: chapter names like `Economy`/`Reading`
///      that the `CHAPTER N` detector can't see).
///   3. ~equal length chunks of TARGET_SECTION_CHARS (no detectable structure).
///
/// Every path keeps the sectionizer invariants: boundaries on UTF-8 char
/// boundaries (via `snap_to_boundary` / line starts), no word splitting, and a
/// contiguous run that ends at `body.len()`.
pub fn sectionize(body: &str) -> Vec<(String, usize, usize)> {
    sectionize_with_roles(body).0
}

/// Like [`sectionize`], but also returns the book-typography role marks
/// (`title` / `byline` / `contents-*` / `chapter-*` / `body-first`) when — and
/// ONLY when — the inferred-structure path was used to section the body. Returning
/// roles and sections together guarantees they can never diverge: a book sectioned
/// by `detect_chapters` keeps the generic-heading roles it always had (no
/// book-structure roles), and a book sectioned by inferred structure gets the
/// richer roles for exactly the sections it produced. `import_txt` uses this;
/// `sectionize` is the public invariant-tested entry that discards the roles.
pub fn sectionize_with_roles(
    body: &str,
) -> (
    Vec<(String, usize, usize)>,
    Vec<crate::gutenberg_markup::Mark>,
) {
    let chapters = detect_chapters(body);
    if chapters.len() >= 3 {
        return (chapters, Vec::new());
    }
    // Heading detection came up short — try inferring the book's structure (the
    // Walden case: a real title page + contents list whose chapter names are plain
    // Title-Case lines the heading detector can't recognise).
    let structure = crate::book_structure::analyze(body);
    if let Some(secs) = sectionize_from_structure(body, &structure) {
        return (secs, structure.role_marks);
    }
    (chunk_evenly(body), Vec::new())
}

/// Build sections from an inferred [`BookStructure`](crate::book_structure):
/// a leading FRONT-MATTER section (`[0, front_matter_end)` — the title page +
/// contents, classified non-assignable because it carries no flowing prose) plus
/// one section per detected chapter. Returns `None` when the analyzer found no
/// trustworthy chapter structure, so the caller falls back to heading detection /
/// even chunking unchanged. Huge chapters are split the same way `detect_chapters`
/// splits them, so daily reading stays reasonable.
fn sectionize_from_structure(
    body: &str,
    structure: &crate::book_structure::BookStructure,
) -> Option<Vec<(String, usize, usize)>> {
    if structure.chapters.is_empty() {
        return None;
    }
    let first_chapter = structure.chapters[0].0;
    let mut sections: Vec<(String, usize, usize)> = Vec::new();

    // Leading front-matter section (title page + contents). Only when there is
    // real front matter before the first chapter; it abuts the first chapter at
    // `first_chapter` (a line start → a char boundary, never mid-word).
    if first_chapter > 0 {
        let label = first_nonempty_line(&body[..first_chapter])
            .unwrap_or_else(|| "Front Matter".to_string());
        sections.push((label, 0, first_chapter));
    }

    // One section per chapter, abutting at the next chapter's start (last → len).
    for (i, (start, label)) in structure.chapters.iter().enumerate() {
        let end = structure
            .chapters
            .get(i + 1)
            .map(|(s, _)| *s)
            .unwrap_or_else(|| body.len());
        if end > *start {
            sections.push((label.clone(), *start, end));
        }
    }

    Some(refine_oversized_sections(body, sections))
}

/// Per-section "assignable" flags (true = part of the reading plan). Front matter —
/// a LEADING run of dedication / title page / table of contents / copyright /
/// epigraph / translator title-poem — is marked non-assignable so the plan's
/// day-1 starts on real content (Preface/Foreword/Introduction/Prologue/chapters
/// are kept). `raw` is the output of `sectionize`; `body` is the same text.
pub fn classify_assignable(raw: &[(String, usize, usize)], body: &str) -> Vec<bool> {
    let mut flags = vec![true; raw.len()];
    for (i, (label, s, e)) in raw.iter().enumerate() {
        let sec = body.get(*s..*e).unwrap_or("");
        if is_leading_front_matter(label, sec) {
            flags[i] = false;
        } else {
            break; // first real-content section; everything after stays assignable
        }
    }
    // Never emit an empty plan (e.g. an all-verse book): if the heuristic would
    // drop every section, keep them all assignable.
    if flags.iter().all(|f| !f) {
        return vec![true; raw.len()];
    }
    flags
}

/// A LEADING section is front matter when its label is a known marker (reusing the
/// EPUB classifier — dedication / contents / title page / copyright / epigraph /
/// "about the author" …) OR it lacks substantial flowing prose (a title page,
/// contents list, dedication, or short title-poem). Preface / Foreword /
/// Introduction / Prologue carry real prose, so they pass and become day-1.
fn is_leading_front_matter(label: &str, section_body: &str) -> bool {
    if crate::epub_classify::is_front_back_matter(Some(label), label, true) {
        return true;
    }
    !section_has_substantial_prose(section_body)
}

/// True when a section's body (after its first/heading line) reads as real flowing
/// prose: enough text, several sentence terminators, and at least one prose-length
/// line. Verse, contents lists, and title pages all fail this.
fn section_has_substantial_prose(section_body: &str) -> bool {
    let after = section_body
        .trim_start()
        .split_once('\n')
        .map(|(_, rest)| rest)
        .unwrap_or("");
    let prose_chars = after.chars().filter(|c| !c.is_whitespace()).count();
    let terminators = after
        .bytes()
        .filter(|b| matches!(b, b'.' | b'!' | b'?'))
        .count();
    let has_long_line = after.lines().any(|l| l.trim().chars().count() > 60);
    prose_chars >= 300 && terminators >= 2 && has_long_line
}

fn detect_chapters(body: &str) -> Vec<(String, usize, usize)> {
    // Heading lines, as (line_start, line_end_before_newline, trimmed_label).
    let mut headings: Vec<(usize, usize, String)> = Vec::new();
    let mut line_start = 0usize;
    for (i, c) in body.char_indices() {
        if c == '\n' {
            let l = body[line_start..i].trim();
            if is_chapter_heading(l) {
                headings.push((line_start, i, l.to_string()));
            }
            line_start = i + 1;
        }
    }
    if line_start < body.len() {
        let l = body[line_start..].trim();
        if is_chapter_heading(l) {
            headings.push((line_start, body.len(), l.to_string()));
        }
    }
    if headings.is_empty() {
        return Vec::new();
    }

    let n = headings.len();

    // Strip a leading TABLE OF CONTENTS, robustly across real-world structures.
    //
    // A contents list is a PACKED RUN of headings at the very top — consecutive
    // entries a line or two apart, with no prose between them. The body is where
    // headings are separated by a chapter's worth of text. So: find the leading
    // run of headings each within MIN of the next, and (if it's clearly a list)
    // drop the whole run. Computing it on RAW positions catches the run's LAST
    // entry even when front matter sits between the list and Chapter 1 — the case
    // that leaked "CHAPTER 135"/"CHAPTER XXVII" in as section 0.
    //
    // Two guards keep this from harming real books:
    //  - The run must be >= 3. A multi-volume work ("BOOK ONE" immediately
    //    followed by "CHAPTER I", then prose) makes a run of only 2, so its
    //    volumes — including chapters whose numbers restart each book — are kept.
    //  - The run's LAST entry is RECOVERED if its title-insensitive key does not
    //    recur in the body: then it isn't a contents stub but a real first section
    //    that sat flush against the list (an epistolary novel's opening Letter).
    let mut run = 1usize;
    while run < n && headings[run].0 - headings[run - 1].0 < MIN_CHAPTER_GAP_CHARS {
        run += 1;
    }
    let mut keep = vec![true; n];
    if run >= 3 && run < n {
        for k in keep.iter_mut().take(run) {
            *k = false;
        }
        let last_key = heading_key(&headings[run - 1].2);
        let recurs_in_body = headings[run..]
            .iter()
            .any(|h| heading_key(&h.2) == last_key);
        // Recover the run's last entry as a real opening section ONLY when it is
        // not a contents-list tail. A leaked TOC tail is the HIGHEST chapter
        // number — or a terminal "Epilogue" — standing BEFORE the real opening
        // chapters ("CHAPTER XXVII"/"CHAPTER IX" before "CHAPTER I", "Epilogue"
        // before "CHAPTER 1"). Truncated / label-varied text can hide the
        // recurrence, so this natural-order check is what catches those leaks;
        // the epistolary case (a real "Letter 3" flush against the list) stays in
        // order and is still recovered.
        let last_label = &headings[run - 1].2;
        let later_min = headings[run..]
            .iter()
            .filter_map(|h| chapter_number(&h.2))
            .min();
        let out_of_order = last_label.trim().to_uppercase().starts_with("EPILOGUE")
            || matches!((chapter_number(last_label), later_min), (Some(l), Some(m)) if l > m);
        if !recurs_in_body && !out_of_order {
            keep[run - 1] = true;
        }
    }

    let kept: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    if kept.is_empty() {
        // Everything looked like a list (e.g. a bare index) — let the caller
        // fall back to even chunking rather than emit empty sections.
        return Vec::new();
    }

    let first = headings[kept[0]].0;
    // End of the leading TOC block: just past the last dropped heading that sits
    // before the first real chapter, so the contents list itself isn't shown.
    let toc_end = (0..n)
        .filter(|&i| !keep[i] && headings[i].0 < first)
        .map(|i| (headings[i].1 + 1).min(first))
        .max()
        .unwrap_or(0);

    let mut sections: Vec<(String, usize, usize)> = Vec::new();

    // Front matter between the contents/TOC and the first real chapter — a
    // preface, or the opening Letters in an epistolary novel. Keep it as its own
    // section so nothing is lost; label it from its first line.
    if first > toc_end + MIN_CHAPTER_GAP_CHARS {
        let label =
            first_nonempty_line(&body[toc_end..first]).unwrap_or_else(|| "Opening".to_string());
        sections.push((label, toc_end, first));
    }

    for (j, &i) in kept.iter().enumerate() {
        let start = headings[i].0;
        let end = if j + 1 < kept.len() {
            headings[kept[j + 1]].0
        } else {
            body.len()
        };
        if end > start {
            sections.push((headings[i].2.clone(), start, end));
        }
    }

    // Fold heading-only stubs forward. A structural heading immediately followed
    // by another heading (e.g. "BOOK ONE: 1805" then "CHAPTER I", no prose between)
    // would otherwise be its own ~20-char section; merge it into the following
    // section as a label prefix so the volume context is kept and there are no
    // empty sections (the multi-volume case).
    const MIN_SECTION_CHARS: usize = 120;
    let mut folded: Vec<(String, usize, usize)> = Vec::new();
    let mut carry: Option<(usize, String)> = None;
    for (label, s, e) in sections {
        let (start, label) = match carry.take() {
            Some((st, prefix)) => (st, format!("{prefix} · {label}")),
            None => (s, label),
        };
        if e - start < MIN_SECTION_CHARS {
            carry = Some((start, label));
        } else {
            folded.push((label, start, e));
        }
    }
    if let Some((start, label)) = carry {
        match folded.last_mut() {
            Some(last) => last.2 = body.len(), // trailing stub → extend previous section
            None => folded.push((label, start, body.len())),
        }
    }
    refine_oversized_sections(body, folded)
}

/// Split any section longer than `TARGET_SECTION_CHARS * 3` into ~target-sized
/// parts so daily reading stays reasonable. Each interior split is snapped to a
/// clean reading boundary (paragraph / sentence / word — never mid-word, always a
/// UTF-8 char boundary), and the same snapped value is reused as one part's end
/// and the next part's start, so the parts stay abutting (no overlap/gap). Shared
/// by `detect_chapters` and the inferred-structure path so both keep the
/// sectionizer invariants identically.
fn refine_oversized_sections(
    body: &str,
    sections: Vec<(String, usize, usize)>,
) -> Vec<(String, usize, usize)> {
    let mut refined: Vec<(String, usize, usize)> = Vec::new();
    for (label, s, e) in sections {
        let len = e - s;
        if len > TARGET_SECTION_CHARS * 3 {
            let parts = len.div_ceil(TARGET_SECTION_CHARS);
            let part_len = len / parts;
            let split = |p: usize| snap_to_boundary(body, s + p * part_len);
            for p in 0..parts {
                let ps = if p == 0 { s } else { split(p) };
                let pe = if p == parts - 1 { e } else { split(p + 1) };
                refined.push((format!("{} — pt {}", label, p + 1), ps, pe));
            }
        } else {
            refined.push((label, s, e));
        }
    }
    refined
}

/// First non-empty line of a slice, lightly de-marked (Gutenberg uses `_italics_`)
/// and capped — used to label a front-matter section. Falls back to "Opening".
fn first_nonempty_line(s: &str) -> Option<String> {
    s.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| {
        let cleaned = l.trim_matches(|c| c == '_' || c == '*' || c == '#').trim();
        if cleaned.is_empty() || cleaned.chars().count() > 60 {
            "Opening".to_string()
        } else {
            cleaned.to_string()
        }
    })
}

fn is_chapter_heading(line: &str) -> bool {
    if line.is_empty() || line.len() > 80 {
        return false;
    }
    let upper = line.to_uppercase();
    if upper.starts_with("CHAPTER ") || upper.starts_with("CHAP. ") {
        return true;
    }
    if upper.starts_with("BOOK ") && line.split_whitespace().count() <= 6 {
        return true;
    }
    // Epistolary openings ("Letter 1", "Letter the First") — bounded word count
    // so prose like "Letter to the editor about…" isn't mistaken for a heading.
    if upper.starts_with("LETTER ") && line.split_whitespace().count() <= 4 {
        return true;
    }
    // Standalone structural headings. Recognising these means a contents list's
    // "Epilogue"/"Prologue" line is deduped out of the front-matter region (so a
    // book's opening section is labelled from its real first line, not a stray
    // TOC entry), and the real Epilogue/Prologue becomes its own section.
    if (upper.starts_with("EPILOGUE")
        || upper.starts_with("PROLOGUE")
        || upper.starts_with("PREFACE")
        || upper.starts_with("FOREWORD")
        || upper.starts_with("INTRODUCTION"))
        && line.split_whitespace().count() <= 3
    {
        return true;
    }
    // Roman-numeral only lines (common in Augustine)
    if is_roman_numeral_line(line) {
        return true;
    }
    false
}

/// A title-insensitive key for matching a contents-list entry to its body
/// heading: "CHAPTER XXVII. Mina Harker's Journal" and "CHAPTER XXVII" both key
/// to "chapter xxvii". Falls back to the lowercased label up to the first period.
fn heading_key(label: &str) -> String {
    let l = label.trim().to_lowercase();
    for kw in [
        "chapter ", "chap. ", "letter ", "book ", "part ", "canto ", "act ", "scene ",
    ] {
        if let Some(rest) = l.strip_prefix(kw) {
            let tok = rest
                .split(|c: char| !c.is_alphanumeric())
                .find(|s| !s.is_empty())
                .unwrap_or("");
            return format!("{kw}{tok}");
        }
    }
    l.split('.').next().unwrap_or(&l).trim().to_string()
}

/// The ordinal of a NUMBERED heading ("CHAPTER XXVII" → 27, "BOOK II" → 2,
/// "Letter 3" → 3). None for unnumbered headings (a preface, a title, Epilogue).
/// Used to spot a leaked contents-list tail — a high chapter number standing
/// before the real opening chapters.
fn chapter_number(label: &str) -> Option<u32> {
    let up = label.trim().to_uppercase();
    for kw in ["CHAPTER ", "CHAP. ", "BOOK ", "PART ", "LETTER ", "CANTO "] {
        if let Some(rest) = up.strip_prefix(kw) {
            let tok = rest
                .split(|c: char| !c.is_alphanumeric())
                .find(|s| !s.is_empty())?;
            if let Ok(n) = tok.parse::<u32>() {
                return Some(n);
            }
            return roman_to_u32(tok);
        }
    }
    None
}

/// Parse a roman numeral ("XXVII" → 27). None if it isn't well-formed roman.
fn roman_to_u32(s: &str) -> Option<u32> {
    let val = |c: char| match c {
        'I' => 1,
        'V' => 5,
        'X' => 10,
        'L' => 50,
        'C' => 100,
        'D' => 500,
        'M' => 1000,
        _ => 0,
    };
    let cs: Vec<i64> = s.chars().map(val).collect();
    if cs.is_empty() || cs.contains(&0) {
        return None;
    }
    let mut total = 0i64;
    for i in 0..cs.len() {
        if i + 1 < cs.len() && cs[i] < cs[i + 1] {
            total -= cs[i];
        } else {
            total += cs[i];
        }
    }
    u32::try_from(total).ok().filter(|&n| n > 0)
}

/// Render 1..=100 as a canonical roman numeral (used to reject non-canonical
/// spellings that happen to be made of roman letters).
fn to_roman(mut n: u32) -> String {
    const T: &[(u32, &str)] = &[
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ];
    let mut s = String::new();
    for &(v, r) in T {
        while n >= v {
            s.push_str(r);
            n -= v;
        }
    }
    s
}

/// Parse a CANONICAL roman numeral in the 1..=100 chapter range. Rejects English
/// words made of roman letters ("MIX"=1009, "DID"=999, "CIVIC") and non-canonical
/// spellings — the over-matching the review flagged.
fn parse_roman(raw: &str) -> Option<u32> {
    let s: String = raw.trim().trim_end_matches('.').trim().to_uppercase();
    if s.is_empty() || s.len() > 8 {
        return None;
    }
    let val = |c: char| match c {
        'I' => 1,
        'V' => 5,
        'X' => 10,
        'L' => 50,
        'C' => 100,
        'D' => 500,
        'M' => 1000,
        _ => 0,
    };
    let v: Vec<u32> = s.chars().map(val).collect();
    if v.contains(&0) {
        return None;
    }
    let mut total = 0i64;
    for i in 0..v.len() {
        if i + 1 < v.len() && v[i] < v[i + 1] {
            total -= v[i] as i64;
        } else {
            total += v[i] as i64;
        }
    }
    let n = u32::try_from(total)
        .ok()
        .filter(|&n| (1..=100).contains(&n))?;
    (to_roman(n) == s).then_some(n)
}

fn is_roman_numeral_line(line: &str) -> bool {
    let t = line.trim();
    // A bare single letter (notably "I", the pronoun) is a heading only if it
    // carries a trailing period; "II"+ may stand alone.
    let core = t.trim_end_matches('.').trim();
    if core.chars().count() < 2 && !t.ends_with('.') {
        return false;
    }
    parse_roman(t).is_some()
}

fn chunk_evenly(body: &str) -> Vec<(String, usize, usize)> {
    let len = body.len();
    if len == 0 {
        return Vec::new();
    }
    let n = len.div_ceil(TARGET_SECTION_CHARS).max(1);
    let chunk = len / n;
    let mut out = Vec::with_capacity(n);
    // Each section starts where the previous one ENDED (after snapping), not at the
    // raw chunk boundary — otherwise the snap forward (up to ~500 bytes) duplicated
    // that text into the next section. Carrying prev_end forward keeps coverage gap-
    // and overlap-free: section[i].end == section[i+1].start, last end == len.
    let mut prev_end = 0usize;
    for i in 0..n {
        let s = prev_end;
        let snapped_end = if i == n - 1 {
            len
        } else {
            snap_to_boundary(body, (i + 1) * chunk)
        };
        prev_end = snapped_end;
        out.push((format!("Part {}", i + 1), s, snapped_end));
    }
    out
}

/// Snap a byte index DOWN to the nearest UTF-8 char boundary of `body`
/// (`std::str::floor_char_boundary` is still unstable). Section locators are
/// used to slice the body, so every split point MUST land on a boundary or the
/// slice panics; snapping down also keeps abutment intact because the same
/// snapped value is shared by a section's end and the next section's start.
fn floor_char_boundary(body: &str, idx: usize) -> usize {
    let mut idx = idx.min(body.len());
    while idx > 0 && !body.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// How far a single snap may walk while looking for the next split point or
/// skipping a whitespace run. Prose has whitespace within a few chars; only
/// pathological input (minified blobs, whitespace-free runs, mile-long
/// whitespace runs) reaches the cap — and for those a capped split is the
/// correct trade, because an unbounded walk made every snap O(body) and
/// sectionize O(body²) (100 MB of NUL bytes took 887s in the CORE-1029 red run).
/// Sectionize calls snap O(body / TARGET_SECTION_CHARS) times, so the bounded
/// walks add at most ~body/9 bytes of total scanning — linear.
const SNAP_WALK_WINDOW: usize = 1_000;

/// Snap a byte index FORWARD to a clean reading boundary so a section never
/// starts or ends in the middle of a word. Preference, nearest-first within a
/// bounded window: a PARAGRAPH break (blank line) > a SENTENCE end (`.?!` then
/// whitespace) > a WORD boundary (the start of the next word, after whitespace).
/// The result is always a valid UTF-8 char boundary, and the char just before it
/// is never a word character abutting a word character at it — so `body[..b]` and
/// `body[b..]` split cleanly. All windows are far below TARGET_SECTION_CHARS
/// (9_000), so a snap can never collapse a section into the next one — and every
/// scan in here is window-bounded, so one call is O(window) no matter the input.
fn snap_to_boundary(body: &str, idx: usize) -> usize {
    let len = body.len();
    if idx == 0 || idx >= len {
        return floor_char_boundary(body, idx);
    }
    let bytes = body.as_bytes();
    // Skip a whitespace run, never walking more than SNAP_WALK_WINDOW: stopping
    // mid-run still splits between whitespace chars, so no word is ever cut.
    let skip_ws = |from: usize| {
        let lim = (from + SNAP_WALK_WINDOW).min(len);
        let mut k = from;
        while k < lim && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        k
    };

    // 1. Paragraph break (blank line) -> first real char of the next paragraph.
    let para_window = 1_000.min(len - idx);
    for j in 0..para_window {
        let pos = idx + j;
        if bytes[pos] == b'\n' && pos + 1 < len && bytes[pos + 1] == b'\n' {
            return floor_char_boundary(body, skip_ws(pos + 2));
        }
    }

    // 2. Sentence end (`.`/`!`/`?` then whitespace) -> next sentence's first char.
    let sent_window = 400.min(len - idx);
    for j in 0..sent_window {
        let pos = idx + j;
        if matches!(bytes[pos], b'.' | b'!' | b'?')
            && pos + 1 < len
            && bytes[pos + 1].is_ascii_whitespace()
        {
            let k = skip_ws(pos + 1);
            if k < len {
                return floor_char_boundary(body, k);
            }
        }
    }

    // 3. Word boundary: advance to the first whitespace within the window, then
    //    to the start of the next word. The char before the split is then
    //    whitespace, so no word is ever cut.
    let limit = (idx + SNAP_WALK_WINDOW).min(len);
    let mut pos = idx;
    while pos < limit && !bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if pos < limit {
        let k = skip_ws(pos);
        if k < len {
            return floor_char_boundary(body, k);
        }
        return floor_char_boundary(body, idx);
    }

    // 4. No whitespace within the window: accept the first non-word adjacency
    //    instead (a split is clean as long as the chars on both sides aren't
    //    both alphanumeric — punctuation, dashes, symbols all qualify).
    let start = floor_char_boundary(body, idx);
    let end = floor_char_boundary(body, limit);
    let mut prev = body[..start].chars().next_back();
    for (off, ch) in body[start..end].char_indices() {
        let p = start + off;
        if p >= idx {
            if let Some(pc) = prev {
                if !(pc.is_alphanumeric() && ch.is_alphanumeric()) {
                    return p;
                }
            }
        }
        prev = Some(ch);
    }

    // 5. The whole window is one solid run of word characters (pathological —
    //    base64-ish blobs, not prose): an in-word split is unavoidable, and
    //    walking further is the quadratic stall, so split codepoint-safely here.
    floor_char_boundary(body, idx)
}

pub struct ImportResult {
    pub book: Book,
    pub sections: Vec<BookSection>,
}

pub fn import_any(src_path: &Path) -> Result<ImportResult> {
    let ext = src_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "txt" => import_txt(src_path),
        "epub" => crate::import_epub::import_epub(src_path),
        other => Err(anyhow!(
            "unsupported file type: .{} (supported: .txt, .epub)",
            other
        )),
    }
}

pub fn import_txt(src_path: &Path) -> Result<ImportResult> {
    paths::ensure_dirs()?;
    if !src_path.exists() {
        return Err(anyhow!("source file does not exist: {:?}", src_path));
    }
    // Size cap BEFORE the whole-file read: a mistaken multi-GB drop (a log, a
    // dataset) must be refused up front, not ballooned into memory.
    let len = fs::metadata(src_path)
        .with_context(|| format!("read metadata for {:?}", src_path))?
        .len();
    if !txt_size_ok(len) {
        return Err(anyhow!(
            "This file is {} MB — too large to be a book. Throughline can import text files up to {} MB.",
            len.div_ceil(1024 * 1024),
            MAX_TXT_BYTES / (1024 * 1024)
        ));
    }
    let raw = fs::read_to_string(src_path).context("read source as utf-8")?;
    let (meta_title, meta_author, body_start) = extract_gutenberg_meta(&raw);
    let body_end = body_end_offset(&raw);
    let body = &raw[body_start..body_end];

    let title = meta_title.unwrap_or_else(|| {
        src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    });

    let book_id = format!("book_{}", Uuid::new_v4().simple());
    let book_dir = paths::book_dir(&book_id)?;
    fs::create_dir_all(&book_dir)?;
    let dest = book_dir.join("source.txt");
    fs::copy(src_path, &dest).context("copy source into app data")?;
    // Make read-only (immutability hint; honour with `chmod 444`)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest)?.permissions();
        perms.set_mode(0o444);
        let _ = fs::set_permissions(&dest, perms);
    }

    let sha = hash_file(&dest)?;

    // Clean Project Gutenberg markup BEFORE sectionizing so the stored section
    // text and its offsets are consistent: drop `[Illustration]` markers and
    // strip `_…_` italic delimiters (recording `em` marks), then detect heading
    // lines. This mirrors the EPUB importer, which produces clean section text +
    // per-section StyleRanges; here the cleaned body lives in a DERIVED
    // `reader.txt` (the raw `source.txt` stays the immutable SHA anchor).
    let cleaned = gutenberg_markup::clean_body(body);
    let body = cleaned.text.as_str();
    let mut marks = cleaned.marks;

    // Sectionize the CLEANED body (offsets index `body`). When heading detection
    // comes up short, the analyzer carves a leading front-matter section + chapter
    // sections and returns the book-typography role marks for exactly those
    // sections; otherwise it keeps the heading-detect / even-chunk paths and
    // returns no roles. Roles and sections always come from the SAME decision, so
    // they can't diverge.
    let (raw_sections, role_marks) = sectionize_with_roles(body);

    // The book-structure roles (title/byline/contents-*/chapter-*/body-first) are
    // richer than the generic heading detector, so where a book-structure BLOCK
    // role already covers a line we suppress the generic `h1`/`h2` heading mark for
    // it (one role per paragraph; the reader's `blockRoleFor` takes the first block
    // range that covers a paragraph).
    let covered_by_role = |m: &gutenberg_markup::Mark| {
        role_marks
            .iter()
            .any(|r| is_block_role(&r.kind) && r.start <= m.start && r.end >= m.end)
    };
    marks.extend(
        gutenberg_markup::detect_headings(body)
            .into_iter()
            .filter(|h| !covered_by_role(h)),
    );
    marks.extend(role_marks);
    let assignable_flags = classify_assignable(&raw_sections, body);
    // Translate body-offset em/heading marks into per-section StyleRanges
    // (section-relative UTF-16 offsets), persisted through the SAME structure.json
    // path the EPUB importer uses, so cmd_read_section_structure returns them.
    let per_section_ranges = gutenberg_markup::marks_to_section_ranges(body, &marks, &raw_sections);
    let now = Utc::now().to_rfc3339();
    let mut sections: Vec<BookSection> = Vec::with_capacity(raw_sections.len());
    let mut structure: std::collections::HashMap<String, Vec<crate::models::StyleRange>> =
        std::collections::HashMap::new();
    for (i, (label, s, e)) in raw_sections.iter().enumerate() {
        // locators are stored as char offsets into the (cleaned) body
        let id = format!("sec_{}", Uuid::new_v4().simple());
        if let Some(ranges) = per_section_ranges.get(i) {
            if !ranges.is_empty() {
                structure.insert(id.clone(), ranges.clone());
            }
        }
        sections.push(BookSection {
            id,
            book_id: book_id.clone(),
            label: label.clone(),
            href: None,
            start_locator: Some(s.to_string()),
            end_locator: Some(e.to_string()),
            estimated_units: Some((e - s) as i64),
            sort_order: i as i64,
            assignable: assignable_flags[i],
        });
    }

    // Write the DERIVED cleaned body (read-only) the reader renders, plus the
    // structure sidecar. The reader reads `reader.txt` when present; offsets index
    // it directly, so its body marker is body_start = 0 (no header to skip).
    let reader_path = book_dir.join("reader.txt");
    fs::write(&reader_path, body).context("write derived reader.txt")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&reader_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o444);
            let _ = fs::set_permissions(&reader_path, perms);
        }
    }
    fs::write(
        book_dir.join("structure.json"),
        serde_json::to_string(&structure)?,
    )?;

    let manifest = ImportManifest {
        book_id: book_id.clone(),
        title: title.clone(),
        author: meta_author.clone(),
        source_type: "txt".to_string(),
        source_filename: src_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("source.txt")
            .to_string(),
        source_sha256: sha.clone(),
        imported_at: now.clone(),
        total_chars: body.len(),
        section_count: sections.len(),
    };
    fs::write(
        book_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    // Body-offset marker: the reader renders the cleaned `reader.txt`, whose
    // section offsets index it from 0 (the header was already excluded by
    // cleaning the [body_start, body_end) slice of the raw source).
    fs::write(
        book_dir.join("body_offsets.json"),
        serde_json::to_string(&serde_json::json!({
            "body_start": 0usize,
            "body_end": body.len(),
        }))?,
    )?;

    let book = Book {
        id: book_id,
        title,
        author: meta_author,
        source_type: "txt".to_string(),
        source_path: dest.to_string_lossy().to_string(),
        source_sha256: sha,
        created_at: now,
        last_opened_at: None,
    };
    Ok(ImportResult { book, sections })
}

/// True when a `StyleRange.kind` is a BLOCK role (applied to a whole paragraph),
/// as opposed to an inline span (`em`/`strong`). Mirrors the frontend
/// `isBlockRole` / `BLOCK_ROLES` map and the book-typography vocabulary so the
/// `.txt` path suppresses a generic heading only where a richer block role
/// already covers the paragraph.
fn is_block_role(kind: &str) -> bool {
    matches!(
        kind,
        "h1" | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "blockquote"
            | "pre"
            | "title"
            | "subtitle"
            | "byline"
            | "contents-label"
            | "contents-part"
            | "contents-item"
            | "epigraph"
            | "chapter-label"
            | "chapter-title"
            | "body-first"
    )
}

pub fn estimate_minutes_for_chars(n: usize) -> i64 {
    // ~5 chars/word, 200 wpm
    let words = (n as f64) / 5.0;
    ((words / WPM as f64).ceil() as i64).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ~560 chars of filler so a real chapter clears MIN_CHAPTER_GAP_CHARS.
    fn prose() -> String {
        "A sentence of reasonable length to fill the chapter body. ".repeat(10)
    }

    #[test]
    fn letter_headings_are_detected_but_not_prose() {
        assert!(is_chapter_heading("Letter 1"));
        assert!(is_chapter_heading("Letter the First"));
        assert!(!is_chapter_heading(
            "Letter to the editor about a small matter"
        ));
        // Existing behaviours stay intact.
        assert!(is_chapter_heading("Chapter 1"));
        assert!(is_chapter_heading("BOOK I"));
    }

    #[test]
    fn toc_entries_are_skipped_and_chapters_keep_their_text() {
        // A contents list (Chapter 1/2/3 stacked) followed by the real chapters.
        let p = prose();
        let body = format!(
            "Contents\n\nChapter 1\nChapter 2\nChapter 3\n\nChapter 1\n\n{p}\n\nChapter 2\n\n{p}\n\nChapter 3\n\n{p}\n"
        );
        let secs = sectionize(&body);
        let summary: Vec<(&str, usize)> =
            secs.iter().map(|(l, s, e)| (l.as_str(), e - s)).collect();
        assert_eq!(secs.len(), 3, "expected 3 real chapters, got {summary:?}");
        for (label, s, e) in &secs {
            assert!(label.starts_with("Chapter"), "unexpected label {label:?}");
            assert!(
                e - s > MIN_CHAPTER_GAP_CHARS,
                "TOC stub leaked through: {label} = {} chars",
                e - s
            );
        }
        // The first section is the real Chapter 1 body, not the 9-char TOC line.
        assert!(
            secs[0].1 > 0,
            "first section should start after the dropped TOC"
        );
    }

    #[test]
    fn front_matter_before_the_first_chapter_is_kept() {
        // No chapter heading on the preface, but it must not be lost.
        let p = prose();
        let preface = "This edition was prepared with care over many quiet evenings. ".repeat(8);
        let body = format!(
            "Preface\n\n{preface}\n\nChapter 1\n\n{p}\n\nChapter 2\n\n{p}\n\nChapter 3\n\n{p}\n"
        );
        let secs = sectionize(&body);
        assert!(
            secs.len() >= 4,
            "preface + 3 chapters expected, got {}",
            secs.len()
        );
        assert_eq!(secs[0].0, "Preface");
        assert_eq!(secs[0].1, 0, "front matter should start at the body start");
        assert!(secs[1].0.starts_with("Chapter"));
    }

    #[test]
    fn frankenstein_like_toc_then_letters_then_chapters() {
        let p = prose();
        let body = format!(
            "Contents\n\nLetter 1\nLetter 2\nChapter 1\nChapter 2\n\nLetter 1\n\n{p}\n\nLetter 2\n\n{p}\n\nChapter 1\n\n{p}\n\nChapter 2\n\n{p}\n"
        );
        let labels: Vec<String> = sectionize(&body).into_iter().map(|(l, _, _)| l).collect();
        assert_eq!(
            labels,
            vec!["Letter 1", "Letter 2", "Chapter 1", "Chapter 2"]
        );
    }

    #[test]
    fn plain_chapters_without_a_toc_are_unchanged() {
        let p = prose();
        let body = format!("Chapter 1\n\n{p}\n\nChapter 2\n\n{p}\n\nChapter 3\n\n{p}\n");
        let secs = sectionize(&body);
        assert_eq!(secs.len(), 3);
        assert_eq!(secs[0].0, "Chapter 1");
        assert_eq!(
            secs[0].1, 0,
            "no spurious front-matter section when chapter 1 is at the top"
        );
    }

    #[test]
    fn moby_dick_toc_last_entry_before_front_matter_is_not_section_zero() {
        // Moby Dick shape: a CONTENTS list of every chapter (and the Epilogue),
        // THEN front matter (Etymology/Extracts, no heading), THEN the real
        // chapters. The contents' LAST entry ("CHAPTER 3. The End.") sits a big
        // gap (the front matter) before the body, so the gap test alone kept it
        // as section 0 — the reported bug. Dedup-by-label drops it.
        let p = prose();
        let extracts = "“A whale.” —Some old book. ".repeat(40); // front matter, no heading
        let body = format!(
            "CONTENTS\n\nCHAPTER 1. Loomings.\nCHAPTER 2. The Mat.\nCHAPTER 3. The End.\nEpilogue\n\n{extracts}\n\n\
             CHAPTER 1. Loomings.\n\n{p}\n\nCHAPTER 2. The Mat.\n\n{p}\n\nCHAPTER 3. The End.\n\n{p}\n\nEpilogue\n\n{p}\n"
        );
        let labels: Vec<String> = sectionize(&body).into_iter().map(|(l, _, _)| l).collect();
        // The first section must NOT be the last chapter pulled from the contents.
        assert_ne!(
            labels.first().map(String::as_str),
            Some("CHAPTER 3. The End."),
            "TOC last-entry leaked as section 0: {labels:?}"
        );
        // Real chapters appear once each, in order.
        let pos = |name: &str| labels.iter().position(|l| l == name);
        assert!(
            pos("CHAPTER 1. Loomings.") < pos("CHAPTER 2. The Mat."),
            "out of order: {labels:?}"
        );
        assert!(
            pos("CHAPTER 2. The Mat.") < pos("CHAPTER 3. The End."),
            "out of order: {labels:?}"
        );
        // The front-matter section is labelled from real content, not the stray
        // "Epilogue" contents line (which Epilogue-detection deduped away).
        assert_ne!(labels.first().map(String::as_str), Some("Epilogue"));
    }

    #[test]
    fn multi_volume_restarting_chapters_keeps_every_volume() {
        // Two volumes whose chapter numbers RESTART, no TOC. Nothing may be
        // dropped as a "duplicate" — the multi-volume bug the review caught.
        let p = prose();
        let body = format!(
            "BOOK ONE\n\nCHAPTER I\n\n{p}\n\nCHAPTER II\n\n{p}\n\nBOOK TWO\n\nCHAPTER I\n\n{p}\n\nCHAPTER II\n\n{p}\n"
        );
        let secs = sectionize(&body);
        let labels: Vec<String> = secs.iter().map(|(l, _, _)| l.clone()).collect();
        assert_eq!(secs.len(), 4, "lost a volume or split wrong: {labels:?}");
        assert_eq!(secs[0].1, 0, "first volume's prefix was lost");
        // Book headings fold into their first chapter (volume context kept), no stubs.
        assert!(
            labels[0].contains("BOOK ONE") && labels[0].contains("CHAPTER I"),
            "{labels:?}"
        );
        assert!(labels[2].contains("BOOK TWO"), "{labels:?}");
        for (l, s, e) in &secs {
            assert!(e - s > 120, "degenerate section {l}");
        }
    }

    #[test]
    fn roman_contents_with_titles_before_front_matter_is_dropped() {
        // Dracula shape: the contents read "CHAPTER I. Jonathan's Journal" but the
        // body heading is just "CHAPTER I" (title on its own). The titles mean the
        // labels don't match, so this is caught by the leading-run drop, and the
        // title-insensitive key keeps the run's last entry from being recovered.
        let p = prose();
        let extracts = "Quoted matter from an old book. ".repeat(30); // front matter, no heading
        let body = format!(
            "CONTENTS\n\nCHAPTER I. Jonathan's Journal\nCHAPTER II. The Letter\nCHAPTER III. The End\n\n{extracts}\n\n\
             CHAPTER I\n\n{p}\n\nCHAPTER II\n\n{p}\n\nCHAPTER III\n\n{p}\n"
        );
        let labels: Vec<String> = sectionize(&body).into_iter().map(|(l, _, _)| l).collect();
        assert!(
            !labels[0].contains("The End"),
            "contents' last entry leaked as section 0: {labels:?}"
        );
        let pos = |s: &str| labels.iter().position(|l| l == s);
        assert!(pos("CHAPTER I") < pos("CHAPTER II"), "{labels:?}");
        assert!(pos("CHAPTER II") < pos("CHAPTER III"), "{labels:?}");
    }

    #[test]
    fn chunk_sections_do_not_overlap_and_cover_the_whole_body() {
        // A chapterless body forces the even-chunk path. Each section must start
        // exactly where the previous ended (no ~500-byte snap-forward duplication)
        // and together they must cover the body with no gaps. This guards the
        // overlap bug where the next section restarted at the un-snapped boundary.
        let para =
            "The river of paragraphs flows on without any chapter heading at all. ".repeat(6);
        let body = std::iter::repeat_n(para.as_str(), 60)
            .collect::<Vec<_>>()
            .join("\n\n");
        let secs = chunk_evenly(&body);
        assert!(
            secs.len() >= 2,
            "need multiple chunks to test boundaries, got {}",
            secs.len()
        );
        assert_eq!(secs[0].1, 0, "first section starts at the body start");
        assert_eq!(
            secs.last().unwrap().2,
            body.len(),
            "last section ends at the body end"
        );
        for w in secs.windows(2) {
            assert_eq!(w[0].2, w[1].1, "sections must abut: no overlap, no gap");
        }
        for (label, s, e) in &secs {
            assert!(e > s, "degenerate empty section {label}: {s}..{e}");
        }
    }

    #[test]
    fn chunk_locators_are_char_boundaries_for_dense_multibyte_body() {
        // A long run of multibyte glyphs with NO paragraph break forces
        // snap_to_boundary onto its word/char-boundary fallback. Before the fix that
        // fallback returned a byte offset that could slice through a codepoint,
        // so body[start..end] (used to read the section) would panic. Every
        // locator must now land on a UTF-8 char boundary.
        let body: String = "é—🜨à"
            .chars()
            .cycle()
            .take(12_000) // >> TARGET_SECTION_CHARS so n >= 2 boundaries exist
            .collect();
        let secs = chunk_evenly(&body);
        assert!(secs.len() >= 2, "need a real boundary, got {}", secs.len());
        for (label, s, e) in &secs {
            assert!(
                body.is_char_boundary(*s) && body.is_char_boundary(*e),
                "section {label} {s}..{e} crosses a codepoint"
            );
            // Must be sliceable without panicking.
            let _ = &body[*s..*e];
            assert!(e > s, "degenerate section {label}");
        }
        assert_eq!(secs[0].1, 0);
        assert_eq!(secs.last().unwrap().2, body.len());
        for w in secs.windows(2) {
            assert_eq!(w[0].2, w[1].1, "sections must abut");
        }
    }

    #[test]
    fn snap_to_boundary_never_walks_to_a_far_word_boundary() {
        // O(n²) stall guard (follow-up to CORE-1029): on text whose next
        // whitespace is far away — minified files, whitespace-free blobs — the
        // word fallback must give up within its bounded window and hard-split,
        // not walk to the distant whitespace. Per-call walks to EOF made
        // sectionize quadratic: 100 MB of NUL bytes took 887s in the CORE-1029
        // red run.
        let body = format!("{}{}", "x".repeat(50_000), " tail");
        let out = snap_to_boundary(&body, 100);
        assert!(
            out <= 100 + 1_000,
            "split {out} walked to the far whitespace — the scan is unbounded"
        );
    }

    #[test]
    fn snap_to_boundary_never_walks_through_a_long_whitespace_run() {
        // Same stall, other shape: a paragraph break followed by an enormous
        // whitespace run must not be skipped to its end.
        let body = format!("para one.\n\n{}next", " ".repeat(50_000));
        let out = snap_to_boundary(&body, 5);
        assert!(
            out <= 5 + 2_000,
            "split {out} walked the whole whitespace run"
        );
    }

    #[test]
    fn floor_char_boundary_snaps_down_to_a_codepoint_start() {
        let s = "aé🜨b"; // bytes: a(1) é(2) 🜨(4) b(1) => len 8
        assert_eq!(floor_char_boundary(s, 0), 0);
        assert_eq!(floor_char_boundary(s, 1), 1); // boundary before 'é'
        assert_eq!(floor_char_boundary(s, 2), 1); // mid-'é' -> back to 1
        assert_eq!(floor_char_boundary(s, 3), 3); // boundary before '🜨'
        assert_eq!(floor_char_boundary(s, 5), 3); // mid-'🜨' -> back to 3
        assert_eq!(floor_char_boundary(s, 7), 7); // boundary before 'b'
        assert_eq!(floor_char_boundary(s, 99), s.len()); // clamps to len
    }

    #[test]
    fn txt_size_ok_boundary() {
        assert!(
            txt_size_ok(MAX_TXT_BYTES),
            "exactly at the cap is importable"
        );
        assert!(!txt_size_ok(MAX_TXT_BYTES + 1), "one byte over is refused");
    }

    /// A multi-GB .txt (mistaken drop of a log/dataset) must be refused up
    /// front with a friendly message — not read whole into memory. The fixture
    /// is a sparse file (`set_len`, instant on APFS, no real bytes written).
    #[test]
    fn import_txt_rejects_files_over_the_size_cap() {
        // import_txt calls paths::ensure_dirs(), which reads THROUGHLINE_DATA_DIR.
        let _g = paths::lock_env_for_test();
        let dir = std::env::temp_dir().join(format!("tl-txt-cap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let big = dir.join("not-a-book.txt");
        let f = fs::File::create(&big).unwrap();
        f.set_len(MAX_TXT_BYTES + 1).unwrap();
        drop(f);
        let msg = match import_txt(&big) {
            Ok(_) => panic!("an over-cap .txt must be refused"),
            Err(e) => format!("{e:#}"),
        };
        assert!(
            msg.contains("too large to be a book"),
            "error must say the file is too large to be a book, got: {msg}"
        );
        assert!(
            msg.contains("100 MB"),
            "error must name the limit in plain language, got: {msg}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end: importing a Project Gutenberg-style `.txt` yields a derived
    /// `reader.txt` whose section text is CLEAN (no `_` italics, no
    /// `[Illustration]`) and a `structure.json` whose em/heading ranges slice the
    /// section text to exactly the styled phrases — the same shape the EPUB
    /// importer produces. Reads back through the real `read_txt_section` path.
    #[test]
    fn import_txt_produces_clean_reader_text_and_style_ranges() {
        use crate::models::StyleRange;
        let _g = paths::lock_env_for_test();
        let dir = std::env::temp_dir().join(format!("tl-txt-pg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("austen-preface.txt");
        // A PG header, then a preface with an [Illustration] marker and two italic
        // spans, then enough body for the sectionizer to keep one section.
        let raw = "Title: Northanger Abbey\nAuthor: Jane Austen\n\n\
*** START OF THE PROJECT GUTENBERG EBOOK NORTHANGER ABBEY ***\n\n\
PREFACE.\n\n\
[Illustration]\n\n\
_Walt Whitman has somewhere a fine and just distinction._ The humour of \
_Northanger Abbey_, its completeness, is plain to every reader who comes to \
it after the others. It is the work of a writer in full command of her craft, \
and the preface that follows says as much in its own quiet way about the book \
and its long history before the world finally met it in print.\n\n\
*** END OF THE PROJECT GUTENBERG EBOOK NORTHANGER ABBEY ***\n";
        fs::write(&src, raw).unwrap();

        let result = import_txt(&src).expect("import a PG-style .txt");
        let book_id = result.book.id.clone();
        let book_dir = paths::book_dir(&book_id).unwrap();

        // A derived reader.txt exists and is clean; the immutable source.txt still
        // carries the raw markup (it is the SHA anchor, never mutated).
        let reader = fs::read_to_string(book_dir.join("reader.txt")).expect("reader.txt written");
        assert!(
            !reader.contains('_'),
            "reader.txt kept underscores: {reader:?}"
        );
        assert!(
            !reader.contains("[Illustration"),
            "reader.txt kept the illustration marker: {reader:?}"
        );
        let source = fs::read_to_string(book_dir.join("source.txt")).unwrap();
        assert!(
            source.contains("[Illustration]") && source.contains('_'),
            "source.txt must stay the raw, immutable copy"
        );

        // Reading the first section through the real reader path returns clean text.
        let first = &result.sections[0];
        let start: usize = first.start_locator.as_deref().unwrap().parse().unwrap();
        let end: Option<usize> = first.end_locator.as_deref().and_then(|s| s.parse().ok());
        let section_text =
            crate::commands::books::read_txt_section(&book_id, start, end).expect("read section");
        assert!(!section_text.contains('_'));
        assert!(!section_text.contains("[Illustration"));
        assert!(section_text.contains("Walt Whitman has somewhere"));
        assert!(section_text.contains("Northanger Abbey"));

        // structure.json carries em + heading ranges that slice the section text.
        let structure_raw =
            fs::read_to_string(book_dir.join("structure.json")).expect("structure.json");
        let structure: std::collections::HashMap<String, Vec<StyleRange>> =
            serde_json::from_str(&structure_raw).unwrap();
        let ranges = structure.get(&first.id).expect("first section has ranges");
        let u16_slice = |r: &StyleRange| -> String {
            let utf16: Vec<u16> = section_text.encode_utf16().collect();
            String::from_utf16(&utf16[r.start as usize..r.end as usize]).unwrap()
        };
        let ems: Vec<String> = ranges
            .iter()
            .filter(|r| r.kind == "em")
            .map(u16_slice)
            .collect();
        assert!(
            ems.iter()
                .any(|s| s == "Walt Whitman has somewhere a fine and just distinction."),
            "em must cover the Walt Whitman sentence, got {ems:?}"
        );
        assert!(
            ems.iter().any(|s| s == "Northanger Abbey"),
            "em must cover 'Northanger Abbey', got {ems:?}"
        );
        let heading = ranges
            .iter()
            .find(|r| r.kind == "h1" || r.kind == "h2")
            .expect("a heading range");
        assert_eq!(u16_slice(heading), "PREFACE.");

        fs::remove_dir_all(&dir).ok();
        let _ = fs::remove_dir_all(book_dir);
    }

    #[test]
    fn roman_detection_rejects_ordinary_words_and_bare_i() {
        assert!(is_chapter_heading("II."));
        assert!(is_chapter_heading("XiV.")); // case-insensitive, 14
        assert!(!is_chapter_heading("I")); // bare pronoun, no period
        assert!(!is_chapter_heading("MIX")); // English word made of roman letters
        assert!(!is_chapter_heading("DID"));
        assert!(!is_chapter_heading("CIVIC"));
    }

    /// Build a Walden-shaped body: the consecutive-line title block + a `Contents`
    /// list whose chapter names are plain Title-Case lines (the shape the
    /// `CHAPTER N` detector can't see), then those chapters with prose.
    fn walden_body() -> String {
        let economy = "When I wrote the following pages, or rather the bulk of them, I lived alone, in the woods, a mile from any neighbor, in a house which I had built myself, on the shore of Walden Pond, in Concord, Massachusetts, and earned my living by the labor of my hands only. ".repeat(4);
        let reading = "With a little more deliberation in the choice of their pursuits, all men would perhaps become essentially students and observers, for certainly their nature and destiny are interesting to all alike. ".repeat(4);
        let conclusion = "To the sick the doctors wisely recommend a change of air and scenery. Thank Heaven, here is not all the world. ".repeat(4);
        format!(
            "WALDEN\nand\nON THE DUTY OF CIVIL DISOBEDIENCE\nby Henry David Thoreau\n\n\
             Contents\n\n\
             WALDEN\n\n\
             Economy\n\
             Reading\n\
             Conclusion\n\n\
             Economy\n\n\
             {economy}\n\n\
             Reading\n\n\
             {reading}\n\n\
             Conclusion\n\n\
             {conclusion}\n"
        )
    }

    /// The Walden fix, end to end: a non-assignable FRONT-MATTER section carrying
    /// the title-page + contents roles, and a FIRST ASSIGNABLE section that is the
    /// first real chapter (Economy) with a `chapter-title` over "Economy" and a
    /// `body-first` over its opening paragraph — offsets slicing exactly, and the
    /// title/contents text living ONLY in the (non-assignable) front matter.
    #[test]
    fn walden_front_matter_is_separated_and_first_chapter_is_today() {
        let body = walden_body();
        let raw_sections = sectionize(&body);
        let flags = classify_assignable(&raw_sections, &body);

        // A leading NON-ASSIGNABLE front-matter section exists (title + contents).
        assert!(
            !flags[0],
            "front matter must be non-assignable: {raw_sections:?}"
        );
        let (_, fm_s, fm_e) = &raw_sections[0];
        let fm = &body[*fm_s..*fm_e];
        assert!(fm.contains("WALDEN") && fm.contains("Contents"));
        // The front matter holds NO chapter prose — the Walden bug.
        assert!(
            !fm.contains("When I wrote the following pages"),
            "front matter leaked Economy prose: {raw_sections:?}"
        );

        // The first ASSIGNABLE section is the first real chapter (Economy).
        let day1 = flags
            .iter()
            .position(|&a| a)
            .expect("an assignable section");
        let (label, s1, e1) = &raw_sections[day1];
        assert_eq!(
            label, "Economy",
            "first assignable section should be Economy"
        );
        let chapter = &body[*s1..*e1];
        assert!(chapter.starts_with("Economy"));
        assert!(chapter.contains("When I wrote the following pages"));
        // The title/contents text is NOT in the first assignable section.
        assert!(!chapter.contains("Contents"));
        assert!(!chapter.contains("ON THE DUTY OF CIVIL DISOBEDIENCE"));

        // The book-typography roles for the front matter + first chapter slice the
        // body to exactly the styled phrases (byte-offset marks → bytes here).
        let (_, role_marks) = sectionize_with_roles(&body);
        let role_slices = |kind: &str| -> Vec<String> {
            role_marks
                .iter()
                .filter(|m| m.kind == kind)
                .map(|m| body[m.start..m.end].to_string())
                .collect()
        };
        assert_eq!(role_slices("title"), vec!["WALDEN".to_string()]);
        assert_eq!(
            role_slices("byline"),
            vec!["by Henry David Thoreau".to_string()]
        );
        assert_eq!(role_slices("contents-label"), vec!["Contents".to_string()]);
        assert!(
            role_slices("contents-item").contains(&"Economy".to_string()),
            "contents-item must list Economy"
        );
        // chapter-title covers exactly "Economy"; body-first opens the chapter.
        assert!(role_slices("chapter-title").contains(&"Economy".to_string()));
        let body_first = role_slices("body-first");
        assert!(
            body_first
                .iter()
                .any(|s| s.starts_with("When I wrote the following pages")),
            "body-first must cover the Economy opening paragraph: {body_first:?}"
        );

        // Every role mark lands fully inside one section and on a char boundary.
        for m in &role_marks {
            assert!(body.is_char_boundary(m.start) && body.is_char_boundary(m.end));
        }
    }

    /// A book with explicit CHAPTER headings still sections per chapter through the
    /// tuned `detect_chapters` path (the inferred-structure path must not steal it).
    #[test]
    fn book_with_clear_chapter_headings_still_sections_per_chapter() {
        let p = "A sentence of reasonable length to fill the chapter body. ".repeat(10);
        let body = format!(
            "CHAPTER I\n\n{p}\n\nCHAPTER II\n\n{p}\n\nCHAPTER III\n\n{p}\n\nCHAPTER IV\n\n{p}\n"
        );
        let secs = sectionize(&body);
        assert_eq!(secs.len(), 4, "expected 4 chapter sections: {secs:?}");
        assert_eq!(secs[0].0, "CHAPTER I");
        assert_eq!(secs[3].0, "CHAPTER IV");
        // No book-structure roles when the heading path handled it.
        let (_, roles) = sectionize_with_roles(&body);
        assert!(
            roles.is_empty(),
            "heading-detected book must carry no inferred roles"
        );
    }

    /// An unstructured prose blob (no headings, no contents) still falls back to
    /// even Part-N chunks — the inferred-structure path stays out of its way.
    #[test]
    fn unstructured_prose_blob_falls_back_to_part_chunks() {
        let para =
            "The river of paragraphs flows on without any chapter heading at all. ".repeat(8);
        let body = std::iter::repeat_n(para.as_str(), 80)
            .collect::<Vec<_>>()
            .join("\n\n");
        let secs = sectionize(&body);
        assert!(secs.len() >= 2, "expected multiple chunks: {}", secs.len());
        assert!(
            secs.iter().all(|(l, _, _)| l.starts_with("Part ")),
            "expected Part-N chunk labels: {:?}",
            secs.iter().map(|(l, _, _)| l).collect::<Vec<_>>()
        );
        let (_, roles) = sectionize_with_roles(&body);
        assert!(
            roles.is_empty(),
            "an unstructured blob carries no inferred roles"
        );
    }
}

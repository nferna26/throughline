use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use uuid::Uuid;

use crate::models::{Book, BookSection};
use crate::paths;

/// Approximate words-per-minute for "serious reading" pace
pub const WPM: i64 = 200;
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
/// First try chapter detection (`^Chapter N`, `^CHAPTER N`, `Book N`, etc.).
/// Fall back to ~equal length chunks of TARGET_SECTION_CHARS.
pub fn sectionize(body: &str) -> Vec<(String, usize, usize)> {
    let chapters = detect_chapters(body);
    if chapters.len() >= 3 {
        return chapters;
    }
    chunk_evenly(body)
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
        if !recurs_in_body {
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
    let sections = folded;

    // If chapters are huge (>30k chars), split them further to keep daily reading reasonable
    let mut refined: Vec<(String, usize, usize)> = Vec::new();
    for (label, s, e) in sections {
        let len = e - s;
        if len > TARGET_SECTION_CHARS * 3 {
            let parts = len.div_ceil(TARGET_SECTION_CHARS);
            let part_len = len / parts;
            // Snap each interior split to a clean reading boundary (paragraph /
            // sentence / word — never mid-word, always a char boundary). The same
            // snapped value is reused as this part's end and the next part's
            // start, so the parts stay abutting (no overlap/gap).
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
    if (upper.starts_with("EPILOGUE") || upper.starts_with("PROLOGUE"))
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

/// Snap a byte index FORWARD to a clean reading boundary so a section never
/// starts or ends in the middle of a word. Preference, nearest-first within a
/// bounded window: a PARAGRAPH break (blank line) > a SENTENCE end (`.?!` then
/// whitespace) > a WORD boundary (the start of the next word, after whitespace).
/// The result is always a valid UTF-8 char boundary, and the char just before it
/// is never a word character abutting a word character at it — so `body[..b]` and
/// `body[b..]` split cleanly. All windows are far below TARGET_SECTION_CHARS
/// (9_000), so a snap can never collapse a section into the next one.
fn snap_to_boundary(body: &str, idx: usize) -> usize {
    let len = body.len();
    if idx == 0 || idx >= len {
        return floor_char_boundary(body, idx);
    }
    let bytes = body.as_bytes();

    // 1. Paragraph break (blank line) -> first real char of the next paragraph.
    let para_window = 1_000.min(len - idx);
    for j in 0..para_window {
        let pos = idx + j;
        if bytes[pos] == b'\n' && pos + 1 < len && bytes[pos + 1] == b'\n' {
            let mut k = pos + 2;
            while k < len && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            return floor_char_boundary(body, k);
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
            let mut k = pos + 1;
            while k < len && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < len {
                return floor_char_boundary(body, k);
            }
        }
    }

    // 3. Word boundary: advance to the first whitespace at/after idx, then to the
    //    start of the next word. The char before the split is then whitespace, so
    //    no word is ever cut. (Prose has whitespace within a few chars; bounded by len.)
    let mut pos = idx;
    while pos < len && !bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    while pos < len && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if pos < len {
        return floor_char_boundary(body, pos);
    }

    // 4. No whitespace ahead (a pathological single-token tail): a word split is
    //    unavoidable, so fall back to a codepoint-safe split.
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

    // Sectionize
    let raw_sections = sectionize(body);
    let now = Utc::now().to_rfc3339();
    let mut sections: Vec<BookSection> = Vec::with_capacity(raw_sections.len());
    for (i, (label, s, e)) in raw_sections.iter().enumerate() {
        // locators are stored as char offsets into the body
        let id = format!("sec_{}", Uuid::new_v4().simple());
        sections.push(BookSection {
            id,
            book_id: book_id.clone(),
            label: label.clone(),
            href: None,
            start_locator: Some(s.to_string()),
            end_locator: Some(e.to_string()),
            estimated_units: Some((e - s) as i64),
            sort_order: i as i64,
            assignable: true,
        });
    }

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
    // Also save a body-offset marker so reader knows where book body begins in source.txt
    fs::write(
        book_dir.join("body_offsets.json"),
        serde_json::to_string(&serde_json::json!({
            "body_start": body_start,
            "body_end": body_end,
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
    fn roman_detection_rejects_ordinary_words_and_bare_i() {
        assert!(is_chapter_heading("II."));
        assert!(is_chapter_heading("XiV.")); // case-insensitive, 14
        assert!(!is_chapter_heading("I")); // bare pronoun, no period
        assert!(!is_chapter_heading("MIX")); // English word made of roman letters
        assert!(!is_chapter_heading("DID"));
        assert!(!is_chapter_heading("CIVIC"));
    }
}

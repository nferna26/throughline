//! Book-structure inference for the plain-text (`.txt`, Project Gutenberg) path.
//!
//! The EPUB importer gets real structure for free (the publisher's markup tells
//! it what is a title page, a contents list, a chapter heading). A Project
//! Gutenberg `.txt` has none of that — it is a flat river of lines. This module
//! recovers the same structure from the CLEANED body so the reader can typeset a
//! `.txt` book the way it typesets an EPUB: a real title page, a contents page,
//! chapter sections, and the book-typography vocabulary on each role.
//!
//! It is the answer to "the Walden fix": Walden's title block
//! (`WALDEN` / `and` / `ON THE DUTY OF CIVIL DISOBEDIENCE` / `by Henry David
//! Thoreau`) is four CONSECUTIVE non-blank lines, so the per-line heading
//! detector (`gutenberg_markup::detect_headings`, which requires a line to
//! `stands_alone`) saw nothing, and Walden's chapter names are plain Title-Case
//! lines (`Economy`, `Reading`, …) that the `CHAPTER N` detector never matched —
//! so the whole front matter plus the first chapter landed in one even-chunked
//! "Part 1".
//!
//! Everything here is a PURE function over `&str` (no filesystem, no network) and
//! produces only BYTE-offset spans into the cleaned body — never mutating the
//! text. The byte spans become:
//!   - section boundaries (consumed by `import::sectionize`), and
//!   - role [`Mark`]s (translated to per-section [`StyleRange`]s by the same
//!     `gutenberg_markup::marks_to_section_ranges` path the EPUB importer uses).
//!
//! The book-typography vocabulary it emits (additive `StyleRange.kind` strings,
//! no enum / no schema / no IPC bump) — matching the EPUB path and the frontend
//! role→class map:
//!   block roles: `title`, `subtitle`, `byline`, `contents-label`,
//!   `contents-part`, `contents-item`, `epigraph`, `chapter-label`,
//!   `chapter-title`, `body-first`.

use crate::gutenberg_markup::Mark;

/// A logical line of the cleaned body: its trimmed text plus the byte span of
/// that trimmed text within the body (so a role mark covers exactly the words,
/// never the surrounding whitespace — the same span shape `detect_headings` uses).
#[derive(Debug, Clone)]
struct Line<'a> {
    text: &'a str,
    /// Byte offset of the trimmed text's first char in the body.
    start: usize,
    /// Byte offset just past the trimmed text's last char in the body.
    end: usize,
    /// Byte offset of the raw line's start (the char after the previous '\n').
    raw_start: usize,
    /// True when the line above this one is blank or the body edge.
    blank_before: bool,
    /// True when the line below this one is blank or the body edge.
    blank_after: bool,
}

/// The structure recovered from a cleaned `.txt` body.
#[derive(Debug, Default)]
pub struct BookStructure {
    /// Byte offset where front matter (title page + contents + a leading epigraph)
    /// ends and the first real chapter begins. 0 when no front matter was found.
    pub front_matter_end: usize,
    /// Detected chapter starts as `(byte_start, label)`, in document order, each
    /// at a real chapter heading at or after `front_matter_end`. Empty when the
    /// body has no detectable chapter structure (caller falls back to chunking).
    pub chapters: Vec<(usize, String)>,
    /// Typography role marks (byte offsets into the body), to be translated to
    /// per-section `StyleRange`s alongside the em/heading marks.
    pub role_marks: Vec<Mark>,
}

/// Split the body into logical lines, recording each line's trimmed span and
/// whether it is flanked by blank lines (its own paragraph).
fn logical_lines(body: &str) -> Vec<Line<'_>> {
    let mut lines: Vec<Line<'_>> = Vec::new();
    let mut raw_start = 0usize;
    let bytes = body.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    while i <= n {
        if i == n || bytes[i] == b'\n' {
            let raw = &body[raw_start..i];
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                let lead = raw.len() - raw.trim_start().len();
                let start = raw_start + lead;
                lines.push(Line {
                    text: trimmed,
                    start,
                    end: start + trimmed.len(),
                    raw_start,
                    blank_before: false,
                    blank_after: false,
                });
            }
            raw_start = i + 1;
        }
        i += 1;
    }
    // Compute blank_before / blank_after from the GAP between consecutive
    // non-blank lines: a gap of more than one line means a blank line sat between.
    let count = lines.len();
    for idx in 0..count {
        let blank_before = if idx == 0 {
            // Anything before the first non-blank line is leading blank space.
            true
        } else {
            // A blank line sat between if the raw start jumped more than one line.
            let prev_end = lines[idx - 1].end;
            body[prev_end..lines[idx].raw_start].matches('\n').count() >= 2
        };
        let blank_after = if idx + 1 == count {
            true
        } else {
            let next_raw = lines[idx + 1].raw_start;
            body[lines[idx].end..next_raw].matches('\n').count() >= 2
        };
        lines[idx].blank_before = blank_before;
        lines[idx].blank_after = blank_after;
    }
    lines
}

/// Recognise the book-typography structure of a cleaned `.txt` body.
///
/// Conservative by default: it only carves front matter and TOC-driven chapters
/// when the evidence is strong (a short opening title block, an explicit
/// `Contents` heading followed by a list whose entries reappear as body headings).
/// When nothing convincing is found it returns an empty structure and the caller
/// keeps its existing chapter-detection / even-chunk behaviour unchanged.
pub fn analyze(body: &str) -> BookStructure {
    let lines = logical_lines(body);
    if lines.is_empty() {
        return BookStructure::default();
    }

    let mut out = BookStructure::default();

    // 1. Title block: the opening run of non-blank lines, up to the first blank
    //    line, when it reads like a title page (a prominent title line; optional
    //    `and` connector / subtitle / byline). Walden's four consecutive lines.
    let title_block_end = detect_title_block(&lines, &mut out.role_marks);

    // 2. Contents block + the chapter names it lists.
    let toc = detect_contents(&lines, title_block_end, &mut out.role_marks);

    // 3. A leading epigraph (a short quoted/italic block) sitting in the front
    //    matter region, before the first chapter.
    let region_after_toc = toc.as_ref().map(|t| t.block_end).unwrap_or(title_block_end);

    // 4. Chapters: prefer matching the contents list against later body lines
    //    (Walden's plain Title-Case chapter names); else fall back to the
    //    existing `CHAPTER N` / Roman-numeral heading detector handled by the
    //    caller (we return no chapters and let it run).
    let chapter_names: Vec<String> = toc.as_ref().map(|t| t.items.clone()).unwrap_or_default();
    let body_chapters = match_chapters_in_body(&lines, &chapter_names, region_after_toc);

    // Front matter ends at the first real chapter (if we found one after the
    // TOC); otherwise at the end of the TOC/title block we recognised.
    let first_chapter_start = body_chapters.first().map(|(s, _)| *s);
    out.front_matter_end = first_chapter_start.unwrap_or(region_after_toc);

    // 5. Epigraph: only when there is a clear gap of front matter between the TOC
    //    and the first chapter that reads as a short quoted block.
    if let Some(first_ch) = first_chapter_start {
        detect_epigraph(&lines, region_after_toc, first_ch, &mut out.role_marks);
    }

    // 6. Chapter roles: chapter-title over each chapter heading line, and a
    //    body-first over the first prose paragraph of each chapter.
    if !body_chapters.is_empty() {
        emit_chapter_roles(body, &lines, &body_chapters, &mut out.role_marks);
        out.chapters = body_chapters;
    }

    out
}

/// True when a line reads as the book's prominent title: short, and either
/// ALL-CAPS or Title-Cased, with few words. (`WALDEN`, `ON THE DUTY OF CIVIL
/// DISOBEDIENCE`.)
fn looks_like_title_line(line: &str) -> bool {
    let words = line.split_whitespace().count();
    if words == 0 || words > 12 || line.chars().count() > 80 {
        return false;
    }
    // Must carry letters and end without sentence punctuation (a title, not prose).
    if !line.chars().any(|c| c.is_alphabetic()) {
        return false;
    }
    if line.ends_with('.') && !is_all_caps(line) {
        return false;
    }
    // A structural section label (PREFACE / CONTENTS / CHAPTER I / …) is a heading,
    // never the book's title — leave it for the heading detector / chapter logic.
    if is_structural_label(line) {
        return false;
    }
    is_all_caps(line) || is_title_case(line)
}

/// True when a line is a structural SECTION label, not a book title: the standard
/// front/back-matter words (PREFACE, CONTENTS, INTRODUCTION, …) or a chapter/part
/// marker (CHAPTER I, BOOK II, PART ONE). These are headings, so the title-page
/// detector must skip them.
fn is_structural_label(line: &str) -> bool {
    let up = line.trim().trim_end_matches('.').trim().to_uppercase();
    const LABELS: &[&str] = &[
        "PREFACE",
        "CONTENTS",
        "TABLE OF CONTENTS",
        "INTRODUCTION",
        "FOREWORD",
        "PROLOGUE",
        "EPILOGUE",
        "DEDICATION",
        "APPENDIX",
        "INDEX",
        "AFTERWORD",
        "CONCLUSION",
        "NOTES",
        "GLOSSARY",
        "THE END",
        "FINIS",
    ];
    if LABELS.contains(&up.as_str()) {
        return true;
    }
    let words = line.split_whitespace().count();
    const MARKERS: &[&str] = &[
        "CHAPTER ", "CHAP. ", "BOOK ", "PART ", "CANTO ", "ACT ", "SCENE ", "LETTER ",
    ];
    words <= 4 && MARKERS.iter().any(|m| up.starts_with(m))
}

/// True when a line has at least one letter and no lowercase letters.
fn is_all_caps(line: &str) -> bool {
    let mut saw = false;
    for c in line.chars() {
        if c.is_alphabetic() {
            saw = true;
            if c.is_lowercase() {
                return false;
            }
        }
    }
    saw
}

/// True when every word starts uppercase (allowing short lowercase connectives
/// like "of", "the", "and", "to", "on", "a"). A loose Title-Case test for
/// titles/chapter names ("Where I Lived, and What I Lived For").
fn is_title_case(line: &str) -> bool {
    const SMALL: &[&str] = &[
        "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the",
        "to", "with", "nor",
    ];
    let mut saw_word = false;
    for (i, w) in line.split_whitespace().enumerate() {
        let core: String = w.chars().filter(|c| c.is_alphabetic()).collect();
        if core.is_empty() {
            continue; // pure punctuation token (e.g. "—")
        }
        saw_word = true;
        let first = core.chars().next().unwrap();
        if first.is_uppercase() {
            continue;
        }
        // A lowercase word is allowed only as an interior small connective.
        if i > 0 && SMALL.contains(&core.to_lowercase().as_str()) {
            continue;
        }
        return false;
    }
    saw_word
}

/// True when a line is the italic connector `and` standing alone (Walden's
/// "WALDEN / and / ON THE DUTY…"). Handled as a `subtitle` role per the contract.
fn is_and_connector(line: &str) -> bool {
    line.eq_ignore_ascii_case("and")
}

/// True when a line is a byline ("by Henry David Thoreau", "BY THE AUTHOR").
fn is_byline(line: &str) -> bool {
    let lower = line.to_lowercase();
    (lower.starts_with("by ") || lower == "by")
        && line.split_whitespace().count() <= 8
        && line.chars().count() <= 80
}

/// Detect the opening title block. Returns the byte offset just past the block
/// (the start of the first blank-separated region after it) or `0` if none.
/// Emits `title` / `subtitle` / `byline` role marks.
fn detect_title_block(lines: &[Line<'_>], marks: &mut Vec<Mark>) -> usize {
    // The title block is the opening run of consecutive non-blank lines (up to a
    // blank line). Require it to start with a title line, be short, and consist
    // only of title-ish lines / the `and` connector / a byline.
    let mut run_end = 0usize; // index just past the last line of the opening run
    while run_end < lines.len() && !(run_end > 0 && lines[run_end].blank_before) {
        run_end += 1;
    }
    if run_end == 0 {
        return 0;
    }
    let block = &lines[..run_end];
    // The opening block must be small (a title page header, not a paragraph) and
    // its first line must be a title.
    if block.len() > 6 || !looks_like_title_line(block[0].text) {
        return 0;
    }
    // Every line must be a recognised title-page element; otherwise this is just
    // a short opening paragraph, not a title page — leave it alone.
    let all_title_page = block.iter().enumerate().all(|(i, l)| {
        looks_like_title_line(l.text) || is_and_connector(l.text) || (i > 0 && is_byline(l.text))
    });
    if !all_title_page {
        return 0;
    }

    // Require a strong title-page signal so a single capitalised opening line of an
    // unstructured book isn't mistaken for a title page. Either the block itself
    // carries a byline / `and`-connector / a second title line, OR a `Contents`
    // label follows it within the next couple of lines (the classic PG title page
    // → table of contents shape).
    let has_internal_signal = block.len() >= 2
        && block
            .iter()
            .enumerate()
            .any(|(i, l)| is_and_connector(l.text) || (i > 0 && is_byline(l.text)))
        || block.len() >= 3;
    let contents_follows = lines
        .get(run_end)
        .map(|l| {
            let u = l.text.to_uppercase();
            u == "CONTENTS" || u == "TABLE OF CONTENTS"
        })
        .unwrap_or(false);
    if !has_internal_signal && !contents_follows {
        return 0;
    }

    let mut title_seen = false;
    for l in block {
        let kind = if is_byline(l.text) && title_seen {
            "byline"
        } else if is_and_connector(l.text) {
            // The lone lowercase connector and any secondary title both ride the
            // `subtitle` role (the frontend styles a lone "and" as the connector).
            "subtitle"
        } else if !title_seen {
            title_seen = true;
            "title"
        } else {
            "subtitle"
        };
        push_block_mark(marks, kind, l);
    }

    // End of the title block = start of the next blank-separated region. The run's
    // last line's end, snapped past following whitespace via the next line's raw
    // start, keeps the block its own region.
    block.last().map(|l| l.end).unwrap_or(0)
}

/// A recognised contents block.
struct Contents {
    /// Byte offset just past the end of the contents block.
    block_end: usize,
    /// The chapter-name entries listed (trimmed of numbering / page numbers).
    items: Vec<String>,
}

/// Detect a `Contents` / `Table of Contents` block: the label line, then the run
/// of short non-prose entry lines that follow it (within the front-matter
/// region). Emits `contents-label` / `contents-part` / `contents-item` marks.
fn detect_contents(lines: &[Line<'_>], after: usize, marks: &mut Vec<Mark>) -> Option<Contents> {
    // Find the contents label line at or after `after`.
    let label_idx = lines.iter().position(|l| {
        l.start >= after && {
            let u = l.text.to_uppercase();
            (u == "CONTENTS" || u == "TABLE OF CONTENTS") && l.text.split_whitespace().count() <= 3
        }
    })?;

    // Collect the entry run: subsequent lines that read as contents entries (short,
    // non-prose — a chapter name, possibly with a part header). A contents list is
    // a PACKED run; the body chapters that follow it are entry-shaped headings each
    // OPENING a chapter's worth of prose. So the run stops the moment an entry line
    // is immediately followed by a prose paragraph (its next non-blank line is
    // prose) — that line is the FIRST body chapter heading, not a contents entry.
    // Accumulate accepted entries first, then emit marks (so a body heading that
    // ends the run is never tagged `contents-item`).
    let mut entries: Vec<(usize, &'static str)> = Vec::new(); // (line idx, role)
    let mut idx = label_idx + 1;
    let mut blank_gap_runs = 0usize;
    while idx < lines.len() {
        let l = &lines[idx];
        // Stop the moment THIS line is flowing prose (the list is over).
        if looks_like_prose(l.text) {
            break;
        }
        if l.blank_before && idx > label_idx + 1 {
            blank_gap_runs += 1;
            if blank_gap_runs > 2 {
                break;
            }
        }
        // A part header or a chapter-name entry?
        let role = if is_contents_part(l.text) {
            "contents-part"
        } else if is_contents_item(l.text) {
            "contents-item"
        } else {
            // Not an entry and not prose (e.g. a stray symbol line) — stop.
            break;
        };
        // If this entry is IMMEDIATELY followed by a prose paragraph, it is the
        // first BODY chapter heading flush against the list — end the run BEFORE
        // it (a real contents entry is followed by another entry, never prose).
        if role == "contents-item" && next_nonblank_is_prose(lines, idx) {
            break;
        }
        entries.push((idx, role));
        idx += 1;
    }

    let item_count = entries
        .iter()
        .filter(|(_, r)| *r == "contents-item")
        .count();
    if item_count < 2 {
        // Not enough of a list to trust as a contents block.
        return None;
    }

    // Confirmed a real list: emit the label + every accepted entry's role mark.
    push_block_mark(marks, "contents-label", &lines[label_idx]);
    let mut items: Vec<String> = Vec::new();
    let mut last_entry_end = lines[label_idx].end;
    for (i, role) in &entries {
        let l = &lines[*i];
        push_block_mark(marks, role, l);
        if *role == "contents-item" {
            items.push(normalize_contents_item(l.text));
        }
        last_entry_end = l.end;
    }

    Some(Contents {
        block_end: last_entry_end,
        items,
    })
}

/// True when the next non-blank line after `idx` reads as a prose paragraph
/// (long, sentence-shaped). Used to detect that an entry-shaped line is really a
/// BODY chapter heading (followed by prose), ending the contents run.
fn next_nonblank_is_prose(lines: &[Line<'_>], idx: usize) -> bool {
    lines
        .get(idx + 1)
        .map(|l| looks_like_prose(l.text))
        .unwrap_or(false)
}

/// True for a contents PART header — a short ALL-CAPS line that is not a per-line
/// page-numbered entry (e.g. "WALDEN" sitting above the Walden chapter list).
fn is_contents_part(line: &str) -> bool {
    is_all_caps(line)
        && line.split_whitespace().count() <= 6
        && line.chars().count() <= 60
        && !line.chars().any(|c| c.is_ascii_digit())
}

/// True for a contents ENTRY line: a short non-prose line naming a chapter. May
/// carry a leading number / trailing page number ("1. Economy 3", "Economy").
fn is_contents_item(line: &str) -> bool {
    if line.chars().count() > 70 || line.is_empty() {
        return false;
    }
    // Must have letters (a real name), and must not read as flowing prose.
    if !line.chars().any(|c| c.is_alphabetic()) || looks_like_prose(line) {
        return false;
    }
    // Reject lines that are just a number / roman numeral (those are body chapter
    // markers, not contents names).
    let core = line.trim_end_matches('.').trim();
    if core.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return false;
    }
    true
}

/// Strip a leading entry number and trailing page number off a contents item,
/// leaving the chapter NAME used to match the body ("1. Economy ...... 3" →
/// "Economy"). Keeps interior words intact.
fn normalize_contents_item(line: &str) -> String {
    let mut s = line.trim();
    // Drop a leading "N." / "N " / roman-numeral ordinal.
    if let Some(rest) = strip_leading_ordinal(s) {
        s = rest.trim_start();
    }
    // Drop trailing dotted leaders and a page number ("Economy ..... 3").
    let s = s.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ' ');
    s.trim().to_string()
}

/// Strip a leading "N." / "N" / "IV." ordinal token, returning the remainder.
fn strip_leading_ordinal(s: &str) -> Option<&str> {
    let (first, rest) = s.split_once(char::is_whitespace)?;
    let core = first.trim_end_matches('.');
    let is_num = !core.is_empty() && core.chars().all(|c| c.is_ascii_digit());
    let is_roman = !core.is_empty()
        && core.chars().all(|c| {
            matches!(
                c.to_ascii_uppercase(),
                'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M'
            )
        });
    if is_num || is_roman {
        Some(rest)
    } else {
        None
    }
}

/// True when a line reads as a sentence of flowing prose: long enough and ending
/// in sentence punctuation (or simply long). Used to STOP a contents run and to
/// reject prose from heading/title roles.
fn looks_like_prose(line: &str) -> bool {
    let chars = line.chars().count();
    if chars > 90 {
        return true;
    }
    chars > 45 && line.ends_with(['.', '!', '?', '"', '”', '’'])
}

/// A normalised key for matching a contents name to a body line: lowercased,
/// alphanumerics only (so "Where I Lived, and What I Lived For" matches whether
/// or not punctuation/spacing differs slightly).
fn match_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Match the contents list against later body lines: each chapter name should
/// reappear (in order) as a standalone Title-Case / ALL-CAPS line that opens a
/// chapter's worth of prose. Returns `(byte_start, label)` for each match found,
/// in document order. Empty when fewer than 3 names match (untrusted structure).
fn match_chapters_in_body(
    lines: &[Line<'_>],
    names: &[String],
    after: usize,
) -> Vec<(usize, String)> {
    if names.len() < 3 {
        return Vec::new();
    }
    let keys: Vec<String> = names.iter().map(|n| match_key(n)).collect();

    // Candidate body heading lines: a standalone line (blank before & after, or at
    // least blank-before) past the front-matter region, whose key matches a
    // contents name. Walk the contents names in order, advancing through body
    // lines, so a name that also appears inside prose isn't mistaken for the head.
    let mut result: Vec<(usize, String)> = Vec::new();
    let mut name_i = 0usize;
    for l in lines {
        if l.start < after {
            continue;
        }
        if name_i >= keys.len() {
            break;
        }
        // A chapter head stands on its own line (blank before), is not prose, and
        // matches the next expected contents name.
        if !l.blank_before {
            continue;
        }
        if looks_like_prose(l.text) {
            continue;
        }
        let key = match_key(l.text);
        if key.is_empty() {
            continue;
        }
        // Try to match this line to the next expected name, or skip ahead a little
        // if a name was omitted in the body (tolerant, in-order match).
        let mut matched = None;
        for (offset, k) in keys[name_i..].iter().enumerate().take(3) {
            if &key == k {
                matched = Some(name_i + offset);
                break;
            }
        }
        if let Some(mi) = matched {
            result.push((l.raw_start, names[mi].clone()));
            name_i = mi + 1;
        }
    }

    // Require at least 3 in-order matches to trust this as real chapter structure.
    if result.len() < 3 {
        return Vec::new();
    }
    result
}

/// Emit `chapter-title` over each chapter heading line and `body-first` over the
/// first prose paragraph that follows it (within the chapter).
fn emit_chapter_roles(
    body: &str,
    lines: &[Line<'_>],
    chapters: &[(usize, String)],
    marks: &mut Vec<Mark>,
) {
    for (ci, (ch_start, _label)) in chapters.iter().enumerate() {
        let ch_end = chapters
            .get(ci + 1)
            .map(|(s, _)| *s)
            .unwrap_or_else(|| body.len());
        // Find the heading line (the line whose raw_start == ch_start) and the
        // first prose paragraph after it.
        let head_idx = lines.iter().position(|l| l.raw_start == *ch_start);
        let Some(head_idx) = head_idx else { continue };
        push_block_mark(marks, "chapter-title", &lines[head_idx]);

        // body-first: the first line after the heading that begins a prose
        // paragraph (blank before, has a word char, isn't another heading-ish line)
        // — span its WHOLE paragraph (to its paragraph break).
        for l in &lines[head_idx + 1..] {
            if l.start >= ch_end {
                break;
            }
            if !l.blank_before {
                continue;
            }
            if !l.text.chars().any(|c| c.is_alphanumeric()) {
                continue;
            }
            // The paragraph runs from this line's start to the end of its
            // blank-flanked run.
            let para_end = paragraph_end(lines, head_idx + 1, l, ch_end);
            if para_end > l.start {
                marks.push(Mark {
                    kind: "body-first".into(),
                    start: l.start,
                    end: para_end,
                });
            }
            break;
        }
    }
}

/// The byte offset of the end of the paragraph that begins at line `first`,
/// searching forward from `from_idx` until the next blank line or `limit`.
fn paragraph_end(lines: &[Line<'_>], from_idx: usize, first: &Line<'_>, limit: usize) -> usize {
    let mut end = first.end;
    let mut started = false;
    for l in &lines[from_idx..] {
        if l.start < first.start {
            continue;
        }
        if l.start >= limit {
            break;
        }
        if started && l.blank_before {
            break;
        }
        end = l.end.min(limit);
        started = true;
    }
    end
}

/// Detect a leading epigraph: a short quoted / italic block sitting in the
/// front-matter region between the TOC and the first chapter. Emits an
/// `epigraph` role over its paragraph. Conservative: only a clearly-quoted block.
fn detect_epigraph(lines: &[Line<'_>], after: usize, before: usize, marks: &mut Vec<Mark>) {
    // Find the first non-empty paragraph in (after, before) and require it to be
    // quoted (opens with a quote mark) or short and italic-styled. Keep it tight.
    for (i, l) in lines.iter().enumerate() {
        if l.start < after {
            continue;
        }
        if l.start >= before {
            return;
        }
        if !l.blank_before {
            continue;
        }
        let looks_quoted = l.text.starts_with(['"', '“', '\'', '‘']);
        if !looks_quoted {
            return; // first front-matter paragraph isn't a quote — no epigraph
        }
        let para_end = paragraph_end(lines, i, l, before);
        if para_end > l.start {
            marks.push(Mark {
                kind: "epigraph".into(),
                start: l.start,
                end: para_end,
            });
        }
        return;
    }
}

/// Push a BLOCK role mark spanning exactly a line's trimmed text. Block roles are
/// emitted to span their whole paragraph's text (like `h1`/`h2`), so the frontend
/// `blockRoleFor` recognises the paragraph's role.
fn push_block_mark(marks: &mut Vec<Mark>, kind: &str, line: &Line<'_>) {
    marks.push(Mark {
        kind: kind.into(),
        start: line.start,
        end: line.end,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Walden-shaped body: title block (4 consecutive lines), a Contents block
    /// with a part header and chapter-name list, then the Economy chapter + prose.
    fn walden_body() -> String {
        let economy_prose = "When I wrote the following pages, or rather the bulk of them, I lived alone, in the woods, a mile from any neighbor, in a house which I had built myself, on the shore of Walden Pond, in Concord, Massachusetts, and earned my living by the labor of my hands only. ".repeat(3);
        let reading_prose = "With a little more deliberation in the choice of their pursuits, all men would perhaps become essentially students and observers, for certainly their nature and destiny are interesting to all alike. ".repeat(3);
        let conclusion_prose = "To the sick the doctors wisely recommend a change of air and scenery. Thank Heaven, here is not all the world. ".repeat(3);
        format!(
            "WALDEN\nand\nON THE DUTY OF CIVIL DISOBEDIENCE\nby Henry David Thoreau\n\n\
             Contents\n\n\
             WALDEN\n\n\
             Economy\n\
             Reading\n\
             Conclusion\n\n\
             Economy\n\n\
             {economy_prose}\n\n\
             Reading\n\n\
             {reading_prose}\n\n\
             Conclusion\n\n\
             {conclusion_prose}\n"
        )
    }

    #[test]
    fn walden_title_block_is_recognised() {
        let body = walden_body();
        let s = analyze(&body);
        let kinds: Vec<&str> = s.role_marks.iter().map(|m| m.kind.as_str()).collect();
        assert!(kinds.contains(&"title"), "no title role: {kinds:?}");
        assert!(kinds.contains(&"subtitle"), "no subtitle role: {kinds:?}");
        assert!(kinds.contains(&"byline"), "no byline role: {kinds:?}");
        // The title mark covers exactly "WALDEN".
        let title = s.role_marks.iter().find(|m| m.kind == "title").unwrap();
        assert_eq!(&body[title.start..title.end], "WALDEN");
        let byline = s.role_marks.iter().find(|m| m.kind == "byline").unwrap();
        assert_eq!(&body[byline.start..byline.end], "by Henry David Thoreau");
    }

    #[test]
    fn walden_contents_block_is_recognised() {
        let body = walden_body();
        let s = analyze(&body);
        let kinds: Vec<&str> = s.role_marks.iter().map(|m| m.kind.as_str()).collect();
        assert!(
            kinds.contains(&"contents-label"),
            "no contents-label: {kinds:?}"
        );
        assert!(
            kinds.contains(&"contents-part"),
            "no contents-part: {kinds:?}"
        );
        assert!(
            kinds.iter().filter(|k| **k == "contents-item").count() >= 3,
            "expected >= 3 contents-item: {kinds:?}"
        );
        let label = s
            .role_marks
            .iter()
            .find(|m| m.kind == "contents-label")
            .unwrap();
        assert_eq!(&body[label.start..label.end], "Contents");
    }

    #[test]
    fn walden_chapters_are_detected_from_the_contents_list() {
        let body = walden_body();
        let s = analyze(&body);
        let labels: Vec<&str> = s.chapters.iter().map(|(_, l)| l.as_str()).collect();
        assert_eq!(labels, vec!["Economy", "Reading", "Conclusion"]);
        // Front matter ends exactly at the first chapter (the body "Economy").
        let first = s.chapters[0].0;
        assert_eq!(s.front_matter_end, first);
        // …and the front-matter region contains NO Economy prose.
        let fm = &body[..s.front_matter_end];
        assert!(
            !fm.contains("When I wrote the following pages"),
            "front matter leaked chapter prose"
        );
    }

    #[test]
    fn walden_chapter_title_and_body_first_roles() {
        let body = walden_body();
        let s = analyze(&body);
        let titles: Vec<&str> = s
            .role_marks
            .iter()
            .filter(|m| m.kind == "chapter-title")
            .map(|m| &body[m.start..m.end])
            .collect();
        assert!(
            titles.contains(&"Economy"),
            "chapter-title for Economy: {titles:?}"
        );
        let bf = s
            .role_marks
            .iter()
            .find(|m| m.kind == "body-first")
            .expect("a body-first role");
        assert!(
            body[bf.start..bf.end].starts_with("When I wrote the following pages"),
            "body-first should open the Economy chapter: {:?}",
            &body[bf.start..bf.end.min(bf.start + 40)]
        );
    }

    #[test]
    fn ordinary_prose_opening_is_not_a_title_page() {
        // A book that opens directly with prose has no title block to carve.
        let body = "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.\n\nThere were a king with a large jaw and a queen with a plain face.";
        let s = analyze(body);
        assert_eq!(s.front_matter_end, 0, "no front matter in a prose opening");
        assert!(s.chapters.is_empty());
        assert!(
            s.role_marks.iter().all(|m| m.kind != "title"),
            "prose opening must not get a title role"
        );
    }

    #[test]
    fn no_contents_means_no_toc_roles() {
        let body = "WALDEN\nby Henry David Thoreau\n\nWhen I wrote the following pages I lived alone in the woods near the pond, far from any neighbour, and earned my living with my hands.";
        let s = analyze(body);
        assert!(
            s.role_marks.iter().all(|m| !m.kind.starts_with("contents")),
            "no contents block, so no contents roles"
        );
        // The title block can still be recognised.
        assert!(s.role_marks.iter().any(|m| m.kind == "title"));
    }

    #[test]
    fn title_case_chapter_name_with_small_connectives_is_title_case() {
        assert!(is_title_case("Where I Lived, and What I Lived For"));
        assert!(is_title_case("The Ponds"));
        assert!(!is_title_case("when I wrote the following pages"));
    }

    #[test]
    fn normalize_contents_item_strips_ordinal_and_page_number() {
        assert_eq!(normalize_contents_item("1. Economy ...... 3"), "Economy");
        assert_eq!(normalize_contents_item("Reading"), "Reading");
        assert_eq!(
            normalize_contents_item("II. Where I Lived 42"),
            "Where I Lived"
        );
    }
}

//! Pure parsing of Project Gutenberg plain-text markup, so a `.txt` import yields
//! the SAME shape the EPUB importer already produces: clean section text (no
//! Gutenberg cruft) plus per-section [`StyleRange`]s (`em` for italics, `h1`/`h2`
//! for headings) in section-relative UTF-16 offsets.
//!
//! Two phases, both pure functions over `&str` so they can be unit-tested with no
//! filesystem or network:
//!
//!   1. [`clean_body`] — rewrites the body, dropping Project Gutenberg
//!      `[Illustration]` markers and the `_…_` italic delimiters, recording an
//!      `em` mark over each italic span. Marks are BYTE offsets into the cleaned
//!      body (the same unit `sectionize` and `slice_body` use).
//!   2. [`detect_headings`] — scans the cleaned body for short standalone
//!      chapter/section heads (`PREFACE.`, `CHAPTER I`, an ALL-CAPS short line, a
//!      Roman-numeral line) and records an `h1`/`h2` mark spanning exactly that
//!      line's text.
//!
//! [`marks_to_section_ranges`] then translates the body-offset marks into
//! per-section [`StyleRange`]s: the `kind` plus a section-relative UTF-16 span,
//! exactly what `cmd_read_section_structure` returns for EPUB-derived books.
//!
//! `=bold=` is intentionally NOT handled: it is rare in PG texts and, unlike `_`,
//! collides with ordinary prose uses of `=` (equations, "x = y"), so mapping it
//! would risk corrupting real text for negligible benefit.

use crate::models::StyleRange;

/// A style mark recorded against the CLEANED body, in BYTE offsets (the unit
/// `sectionize`/`slice_body` work in). Translated to section-relative UTF-16
/// [`StyleRange`]s by [`marks_to_section_ranges`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub kind: String,
    /// Byte offset into the cleaned body where the marked span starts.
    pub start: usize,
    /// Byte offset into the cleaned body where the marked span ends (exclusive).
    pub end: usize,
}

/// Result of cleaning a Gutenberg body: the rewritten text plus the `em` marks
/// (byte offsets into `text`) recorded while stripping `_…_` delimiters.
#[derive(Debug, Default, Clone)]
pub struct CleanedBody {
    pub text: String,
    pub marks: Vec<Mark>,
}

/// Clean a Project Gutenberg body: drop `[Illustration]`/`[Illustration: …]`
/// markers (and bare `[…]` editorial image placeholders), collapsing the blank
/// lines around them so no empty paragraph gap is left; and remove the `_…_`
/// italic delimiters, recording an `em` mark over each inner span. A stray
/// unmatched `_` is left literal (never paired). Marks index `text` (cleaned).
pub fn clean_body(body: &str) -> CleanedBody {
    // Phase A: remove illustration / bracket placeholders, line-aware so the
    // surrounding blank lines collapse to a single paragraph break.
    let no_illustrations = strip_bracket_placeholders(body);

    // Phase B: strip `_…_` italic delimiters, recording an em mark per span.
    let mut text = String::with_capacity(no_illustrations.len());
    let mut marks: Vec<Mark> = Vec::new();
    let bytes = no_illustrations.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    // Pending open underscore: (byte index in `text` just after the delimiter).
    let mut open: Option<usize> = None;
    while i < n {
        let c = bytes[i];
        if c == b'_' {
            match open.take() {
                None => {
                    // Opening delimiter — drop it; remember where the span starts.
                    open = Some(text.len());
                }
                Some(span_start) => {
                    // Closing delimiter — drop it; record an em over the inner
                    // span, trimmed so the styled run doesn't start/end on a space
                    // (mirrors the EPUB extractor flushing leading space outside).
                    let span_end = text.len();
                    if let Some((s, e)) = trim_span(&text, span_start, span_end) {
                        marks.push(Mark {
                            kind: "em".into(),
                            start: s,
                            end: e,
                        });
                    }
                }
            }
            i += 1;
            continue;
        }
        // Copy this UTF-8 codepoint verbatim into the cleaned text.
        let ch_len = utf8_len(c);
        text.push_str(&no_illustrations[i..i + ch_len]);
        i += ch_len;
    }
    // An unmatched trailing `_` (open is Some): its delimiter was already dropped,
    // which would silently italicise to end-of-body. Restore it as a literal so a
    // stray underscore is preserved rather than swallowing the rest of the text.
    if let Some(span_start) = open {
        text.insert(span_start, '_');
    }

    CleanedBody { text, marks }
}

/// Detect heading lines on the CLEANED body and return `h1`/`h2` marks spanning
/// exactly each heading line's trimmed text (byte offsets into `body`).
///
/// Conservative by design (it must not style ordinary short prose lines): a line
/// qualifies only when it is a structural head — a chapter/section marker, a
/// standalone label like `PREFACE`/`CONTENTS`, a lone Roman-numeral line, or a
/// short ALL-CAPS line — AND it stands alone (its own paragraph: blank line, or
/// body edge, on each side). The first qualifying line in the body is `h1` (the
/// section/title head); the rest are `h2` (chapter heads).
pub fn detect_headings(body: &str) -> Vec<Mark> {
    let mut marks: Vec<Mark> = Vec::new();
    let mut first = true;
    let mut line_start = 0usize;
    let bytes = body.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    // Walk byte-by-byte splitting on '\n' so byte offsets stay exact.
    while i <= n {
        let at_end = i == n;
        if at_end || bytes[i] == b'\n' {
            let line = &body[line_start..i];
            let trimmed = line.trim();
            if !trimmed.is_empty()
                && looks_like_heading(trimmed)
                && stands_alone(body, line_start, i)
            {
                // Span exactly the trimmed text (skip leading/trailing whitespace).
                let lead = line.len() - line.trim_start().len();
                let s = line_start + lead;
                let e = s + trimmed.len();
                let kind = if first { "h1" } else { "h2" };
                first = false;
                marks.push(Mark {
                    kind: kind.into(),
                    start: s,
                    end: e,
                });
            }
            line_start = i + 1;
        }
        i += 1;
    }
    marks
}

/// Translate body-offset marks (from [`clean_body`] + [`detect_headings`]) into
/// per-section [`StyleRange`]s in section-relative **UTF-16** offsets, given the
/// sectionizer's `(label, start_byte, end_byte)` spans over the SAME cleaned
/// body. A mark contributes to a section only when it lies fully within that
/// section's byte range; offsets are rebased to the section start and converted
/// from bytes to UTF-16 code units so they match the reader's JS string units.
pub fn marks_to_section_ranges(
    body: &str,
    marks: &[Mark],
    sections: &[(String, usize, usize)],
) -> Vec<Vec<StyleRange>> {
    sections
        .iter()
        .map(|(_, sec_start, sec_end)| {
            let mut ranges: Vec<StyleRange> = Vec::new();
            for m in marks {
                // Fully inside this section (heading/em never straddle a section
                // boundary in practice; clamp defensively and skip if it would).
                if m.start < *sec_start || m.end > *sec_end || m.end <= m.start {
                    continue;
                }
                let start_u16 = utf16_len(&body[*sec_start..m.start]);
                let end_u16 = utf16_len(&body[*sec_start..m.end]);
                if end_u16 > start_u16 {
                    ranges.push(StyleRange {
                        kind: m.kind.clone(),
                        start: start_u16 as u32,
                        end: end_u16 as u32,
                    });
                }
            }
            // Stable, document order: by start then by length (block role before
            // the inline spans it contains, matching the EPUB extractor's order).
            ranges.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
            ranges
        })
        .collect()
}

/// Number of UTF-16 code units in `s` (the reader's string unit).
fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// Length in bytes of the UTF-8 codepoint whose lead byte is `b`.
fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// Trim leading/trailing ASCII-and-Unicode whitespace off a `[start, end)` byte
/// span of `text`, returning the tightened span, or None if it is all whitespace.
fn trim_span(text: &str, start: usize, end: usize) -> Option<(usize, usize)> {
    let slice = &text[start..end];
    let trimmed = slice.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lead = slice.len() - slice.trim_start().len();
    let s = start + lead;
    let e = s + trimmed.len();
    Some((s, e))
}

/// Remove Project Gutenberg `[Illustration]` / `[Illustration: …]` markers and
/// bare `[…]` single-line editorial image placeholders, collapsing the blank
/// lines around a marker that owned its own line so no empty paragraph remains.
///
/// Only brackets that span a SINGLE line are treated as placeholders (a real
/// sentence rarely opens `[` and closes `]` with no inner newline AND nothing
/// else on the line); a bracket run carrying other words on its line is left
/// alone. Inline `[Illustration]` (mid-paragraph) is removed in place.
fn strip_bracket_placeholders(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    for (idx, line) in body.split('\n').enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        out.push_str(&strip_brackets_in_line(line));
    }
    collapse_blank_runs(&out)
}

/// Remove `[…]` image placeholders that appear within a single line. A bracket
/// group qualifies when it is balanced on this line and either (a) is an
/// `[Illustration…]` marker or (b) is the WHOLE line's content (a bare `[…]`
/// editorial placeholder). Other bracketed text (e.g. a citation "[1]" mixed
/// into prose) is preserved.
fn strip_brackets_in_line(line: &str) -> String {
    let trimmed = line.trim();
    // Whole-line bracket placeholder: "[Illustration]", "[Illustration: a ship]",
    // or a bare "[ … ]" editorial note occupying the entire line.
    if trimmed.starts_with('[') && trimmed.ends_with(']') && balanced_brackets(trimmed) {
        return String::new();
    }
    // Inline [Illustration…] markers: remove each balanced [Illustration…] group.
    if !line.contains("[Illustration") {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < line.len() {
        if line[i..].starts_with("[Illustration") {
            // Consume to the matching ']' (depth-aware for nested brackets).
            let mut depth = 0i32;
            let mut j = i;
            let mut closed = None;
            while j < line.len() {
                match bytes[j] {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            closed = Some(j + 1);
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            if let Some(after) = closed {
                i = after;
                // Drop a single following space so "before [Illustration] after"
                // collapses to "before after", not "before  after".
                if line[i..].starts_with(' ') {
                    i += 1;
                }
                continue;
            }
        }
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&line[i..i + ch_len]);
        i += ch_len;
    }
    // Tidy a trailing space left when the marker ended the line.
    out.trim_end().to_string()
}

/// True when every `[` in `s` has a matching `]` and they never close below zero.
fn balanced_brackets(s: &str) -> bool {
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

/// Collapse runs of 3+ consecutive newlines (which a removed standalone marker
/// leaves behind, e.g. `…text\n\n\n\n…`) down to a single blank line (`\n\n`), and
/// trim leading/trailing blank lines — so a stripped `[Illustration]` never opens
/// an empty paragraph gap. Interior single blank lines (paragraph breaks) stay.
fn collapse_blank_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut newline_run = 0usize;
    for c in s.chars() {
        if c == '\n' {
            newline_run += 1;
            // Emit at most two newlines (one blank line) for any longer run.
            if newline_run <= 2 {
                out.push('\n');
            }
        } else {
            newline_run = 0;
            out.push(c);
        }
    }
    out.trim_matches('\n').to_string()
}

/// True when the line `[line_start, line_end)` stands alone as its own paragraph:
/// the lines immediately above and below are blank (or the body edge). This keeps
/// heading detection from styling a short line that is really the first line of a
/// flowing paragraph.
fn stands_alone(body: &str, line_start: usize, line_end: usize) -> bool {
    let before_blank = {
        let before = &body[..line_start];
        // Strip the single trailing '\n' that ends the previous line, then the
        // char before that must be a newline (blank line) or the start of body.
        match before.strip_suffix('\n') {
            None => true, // line is the first line of the body
            Some(rest) => rest.is_empty() || rest.ends_with('\n'),
        }
    };
    let after_blank = {
        let after = &body[line_end..];
        match after.strip_prefix('\n') {
            None => true, // line is the last line of the body (no trailing newline)
            Some(rest) => rest.is_empty() || rest.starts_with('\n'),
        }
    };
    before_blank && after_blank
}

/// A conservative heading test for a single trimmed line, mirroring the
/// `import.rs` chapter detector and the teaser's `looks_like_heading` idiom so a
/// `.txt` heading styles consistently with how the sectionizer slices chapters.
/// Matches: chapter/book/letter/part/canto/act/scene markers, standalone
/// structural labels (PREFACE/CONTENTS/PROLOGUE/…), a lone Roman-numeral/numeric
/// line, or a SHORT all-caps line. Kept narrow to avoid styling ordinary prose.
fn looks_like_heading(line: &str) -> bool {
    if line.len() > 80 {
        return false; // real prose, not a heading
    }
    let upper = line.to_uppercase();
    let words = line.split_whitespace().count();
    const MARKERS: &[&str] = &[
        "CHAPTER ", "CHAP. ", "BOOK ", "PART ", "LETTER ", "CANTO ", "ACT ", "SCENE ",
    ];
    if words <= 6 && MARKERS.iter().any(|m| upper.starts_with(m)) {
        return true;
    }
    const STANDALONE: &[&str] = &[
        "PROLOGUE",
        "EPILOGUE",
        "CONTENTS",
        "PREFACE",
        "FOREWORD",
        "INTRODUCTION",
        "DEDICATION",
        "APPENDIX",
        "INDEX",
        "THE END",
        "FINIS",
    ];
    if words <= 4 && STANDALONE.iter().any(|s| upper.starts_with(s)) {
        return true;
    }
    // A line made only of digits / Roman-numeral letters / punctuation/whitespace
    // ("IV.", "12", "XXVII") is a section marker, not prose.
    let core = line.trim().trim_end_matches('.').trim();
    if core.len() >= 2
        && core.chars().all(|c| {
            c.is_ascii_digit()
                || matches!(
                    c.to_ascii_uppercase(),
                    'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M'
                )
                || c.is_whitespace()
                || c == '.'
        })
    {
        return true;
    }
    // A SHORT all-caps line (a section title set in capitals) is a heading. Kept
    // short (<= 7 words) so a shouted sentence of real prose isn't swallowed.
    if words <= 7 && is_all_caps(line) {
        return true;
    }
    false
}

/// True when a line has at least one letter and every cased letter is uppercase.
fn is_all_caps(line: &str) -> bool {
    let mut saw_letter = false;
    for c in line.chars() {
        if c.is_alphabetic() {
            saw_letter = true;
            if c.is_lowercase() {
                return false;
            }
        }
    }
    saw_letter
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UTF-16 slice of a section's text by a [`StyleRange`], for asserting that an
    /// emitted range indexes the cleaned text exactly.
    fn u16_slice(text: &str, r: &StyleRange) -> String {
        let utf16: Vec<u16> = text.encode_utf16().collect();
        String::from_utf16(&utf16[r.start as usize..r.end as usize]).unwrap()
    }

    /// The headline fixture: a PG Austen-style preface with an `[Illustration]`
    /// marker and `_italic_` spans (one multi-word, one adjacent to punctuation).
    /// After cleaning + structure, the stored text carries no `_`/`[Illustration]`,
    /// and the em/heading ranges slice back to exactly the styled phrases.
    #[test]
    fn austen_preface_cleans_and_styles() {
        let body = "PREFACE.\n\n[Illustration]\n\n\
            _Walt Whitman has somewhere a fine and just distinction._ The \
            humour of _Northanger Abbey_, its completeness, is plain.";
        let cleaned = clean_body(body);
        // No underscores, no illustration marker, no empty gap where it sat.
        assert!(!cleaned.text.contains('_'), "underscores survived: {:?}", cleaned.text);
        assert!(
            !cleaned.text.contains("[Illustration"),
            "illustration marker survived: {:?}",
            cleaned.text
        );
        assert!(
            !cleaned.text.contains("\n\n\n"),
            "blank gap left where the marker was: {:?}",
            cleaned.text
        );

        // Two em marks: the long italic sentence and "Northanger Abbey".
        let headings = detect_headings(&cleaned.text);
        let mut marks = cleaned.marks.clone();
        marks.extend(headings);
        // One section spanning the whole cleaned body.
        let sections = vec![("PREFACE.".to_string(), 0usize, cleaned.text.len())];
        let ranges = marks_to_section_ranges(&cleaned.text, &marks, &sections);
        let secranges = &ranges[0];

        let ems: Vec<&StyleRange> = secranges.iter().filter(|r| r.kind == "em").collect();
        assert_eq!(ems.len(), 2, "expected 2 em ranges, got {secranges:?}");
        let slices: Vec<String> = ems.iter().map(|r| u16_slice(&cleaned.text, r)).collect();
        assert!(
            slices.iter().any(|s| s == "Walt Whitman has somewhere a fine and just distinction."),
            "first em must cover the Walt Whitman sentence, got {slices:?}"
        );
        assert!(
            slices.iter().any(|s| s == "Northanger Abbey"),
            "second em must cover 'Northanger Abbey', got {slices:?}"
        );

        // A heading range over 'PREFACE.' (h1 — the first/section head).
        let h = secranges
            .iter()
            .find(|r| r.kind == "h1" || r.kind == "h2")
            .expect("a heading range");
        assert_eq!(
            u16_slice(&cleaned.text, h),
            "PREFACE.",
            "heading range must span exactly the PREFACE. line"
        );
        assert_eq!(h.kind, "h1", "the first heading is the section head (h1)");
    }

    /// A multi-LINE italic span (PG wraps `_…_` across line breaks) is paired and
    /// stripped, and the em covers the whole inner phrase across the line break.
    #[test]
    fn multiline_italic_span_is_paired() {
        let body = "He read _Walt Whitman\nhas somewhere_ and paused.";
        let cleaned = clean_body(body);
        assert!(!cleaned.text.contains('_'));
        assert_eq!(cleaned.marks.len(), 1);
        let m = &cleaned.marks[0];
        assert_eq!(&cleaned.text[m.start..m.end], "Walt Whitman\nhas somewhere");
    }

    /// A stray unmatched `_` is NOT treated as an italic open: it survives as a
    /// literal underscore rather than silently italicising the rest of the body.
    #[test]
    fn unmatched_underscore_is_left_literal() {
        let body = "a snake_case identifier appears here.";
        let cleaned = clean_body(body);
        assert_eq!(cleaned.text, body, "lone underscore must be preserved");
        assert!(cleaned.marks.is_empty(), "no em from an unmatched underscore");
    }

    /// `[Illustration: a ship]` (and the blank lines around it) are removed
    /// without leaving an empty paragraph gap.
    #[test]
    fn captioned_illustration_marker_is_removed_and_gap_collapsed() {
        let body = "First paragraph.\n\n[Illustration: a ship at sea]\n\nSecond paragraph.";
        let cleaned = clean_body(body);
        assert_eq!(cleaned.text, "First paragraph.\n\nSecond paragraph.");
    }

    /// An inline `[Illustration]` mid-sentence is removed in place (no double space).
    #[test]
    fn inline_illustration_marker_is_removed_in_place() {
        let body = "The hall [Illustration] was vast.";
        let cleaned = clean_body(body);
        assert_eq!(cleaned.text, "The hall was vast.");
    }

    /// A bare `[ … ]` editorial placeholder on its own line is dropped; a real
    /// bracketed citation embedded in prose ("see note [1]") is preserved.
    #[test]
    fn bare_bracket_line_dropped_but_inline_citation_kept() {
        let dropped = clean_body("Para one.\n\n[ a transcriber note ]\n\nPara two.");
        assert_eq!(dropped.text, "Para one.\n\nPara two.");
        let kept = clean_body("As shown in the note [1] this holds.");
        assert_eq!(kept.text, "As shown in the note [1] this holds.");
    }

    /// A `CHAPTER` line is detected as a heading; the first heading in the body is
    /// h1 and subsequent ones are h2.
    #[test]
    fn chapter_lines_are_headings_first_h1_rest_h2() {
        let body = "PREFACE.\n\nSome opening prose here.\n\nCHAPTER I\n\nThe story begins.";
        let headings = detect_headings(body);
        assert_eq!(headings.len(), 2, "PREFACE. and CHAPTER I");
        assert_eq!(&body[headings[0].start..headings[0].end], "PREFACE.");
        assert_eq!(headings[0].kind, "h1");
        assert_eq!(&body[headings[1].start..headings[1].end], "CHAPTER I");
        assert_eq!(headings[1].kind, "h2");
    }

    /// Heading detection must NOT style a short line that is really the first line
    /// of a flowing paragraph (no blank line after it).
    #[test]
    fn short_first_line_of_a_paragraph_is_not_a_heading() {
        // "THE DOG" is all-caps and short, but it runs straight into prose, so it
        // is a paragraph opener, not a standalone heading.
        let body = "THE DOG ran across the wide green field and barked loudly at the geese.";
        let headings = detect_headings(body);
        assert!(
            headings.is_empty(),
            "a short line that flows into prose is not a heading: {headings:?}"
        );
    }

    /// Roman-numeral standalone lines (Augustine-style) are headings.
    #[test]
    fn roman_numeral_line_is_a_heading() {
        let body = "Opening words.\n\nIV.\n\nThe fourth meditation.";
        let headings = detect_headings(body);
        assert_eq!(headings.len(), 1);
        assert_eq!(&body[headings[0].start..headings[0].end], "IV.");
    }

    /// Section translation rebases marks to section-relative UTF-16 offsets and
    /// drops marks that fall outside a section.
    #[test]
    fn marks_translate_to_section_relative_utf16() {
        // Two sections; an em in each. Multibyte text guards the byte→UTF-16 math.
        let body = "Café _crème_ here.\n\nNext _word_ there.";
        let cleaned = clean_body(body);
        assert!(!cleaned.text.contains('_'));
        let split = cleaned.text.find("\n\n").unwrap();
        let sections = vec![
            ("A".to_string(), 0usize, split),
            ("B".to_string(), split + 2, cleaned.text.len()),
        ];
        let ranges = marks_to_section_ranges(&cleaned.text, &cleaned.marks, &sections);
        assert_eq!(ranges[0].len(), 1, "section A has one em");
        assert_eq!(ranges[1].len(), 1, "section B has one em");
        // Section B's em offsets are relative to B, not the whole body.
        let b_text = &cleaned.text[split + 2..];
        let utf16: Vec<u16> = b_text.encode_utf16().collect();
        let r = &ranges[1][0];
        let slice = String::from_utf16(&utf16[r.start as usize..r.end as usize]).unwrap();
        assert_eq!(slice, "word");
    }
}

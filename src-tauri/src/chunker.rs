//! Sitting chunker: split a book body into reading "sittings" sized to the
//! reader's chosen sitting length, ending each at the best natural boundary.
//!
//! This is the core of the sitting-length-driven reading model. A reader picks
//! how much feels right at a sitting (about 10 / 25 / 60 minutes); we turn that
//! into a target span and walk the body, ending every sitting at the cleanest
//! break near the target: a chapter boundary if one is close, else a sub-heading,
//! else a paragraph. We never split mid-paragraph. Short chapters merge into one
//! sitting; long chapters split at their internal headings/paragraphs.
//!
//! It is a PURE function over a precomputed list of break candidates, so EPUB and
//! .txt share it. The only format-specific work is extracting the break points
//! (chapter starts, sub-headings, paragraph gaps) that feed in. Offsets are byte
//! offsets into the concatenated body and are treated as ~characters for the
//! reading-time estimate, matching the existing `import` convention.

/// Words per minute and chars per word, matching `import::WPM` so a 25-minute
/// sitting targets ~25_000 chars (200 wpm x 5 chars/word x 25 min).
pub const WPM: usize = 200;
pub const CHARS_PER_WORD: usize = 5;

/// Bumped whenever the chunking algorithm changes in a way that should rebuild a
/// book's sittings on next open. Stored in `sittings_meta.chunker_version`; an
/// open whose stored version differs triggers a re-chunk.
pub const CHUNKER_VERSION: i64 = 1;

/// Fraction of the target span a break may fall on either side of the ideal end
/// and still count as "near enough to end here".
const WINDOW_TOLERANCE: f64 = 0.5;
/// A trailing remainder smaller than this fraction of the target is folded into
/// the preceding sitting rather than left as a runt.
const MIN_TAIL_FRACTION: f64 = 0.5;

/// Convert a sitting length in minutes to a target span in bytes/chars.
pub fn target_chars_for_minutes(minutes: i64) -> usize {
    (minutes.max(1) as usize) * WPM * CHARS_PER_WORD
}

/// Reading-time estimate for a span, mirroring `import::estimate_minutes_for_chars`.
pub fn minutes_for_chars(n: usize) -> i64 {
    let words = (n as f64) / CHARS_PER_WORD as f64;
    ((words / WPM as f64).ceil() as i64).max(1)
}

/// How strong a place to end a sitting. The body end and a chapter boundary are
/// the cleanest; a sub-heading next; a paragraph gap last.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BreakKind {
    Chapter,
    Heading,
    Paragraph,
}

impl BreakKind {
    fn rank(self) -> u8 {
        match self {
            BreakKind::Chapter => 3,
            BreakKind::Heading => 2,
            BreakKind::Paragraph => 1,
        }
    }
}

/// A candidate place to end a sitting, at a byte offset into the body.
#[derive(Clone, Copy, Debug)]
pub struct Break {
    pub offset: usize,
    pub kind: BreakKind,
}

/// One computed sitting: a byte span `[start, end)` of the body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sitting {
    pub start: usize,
    pub end: usize,
}

impl Sitting {
    pub fn char_count(&self) -> usize {
        self.end.saturating_sub(self.start)
    }
    pub fn est_minutes(&self) -> i64 {
        minutes_for_chars(self.char_count())
    }
}

/// Chunk the body span `[start, body_len)` into sittings of about `target_chars`
/// each, ending every sitting at the best available break near the target.
///
/// `breaks` are candidate end points (chapter/heading/paragraph), each at a byte
/// offset into the body. They need not be sorted and may include offsets outside
/// `(start, body_len)`; those are ignored. The body end is always an implicit
/// terminal break, so the final sitting always closes cleanly.
///
/// Guarantees: every returned sitting is non-empty, sittings are contiguous and
/// cover `[start, body_len)` exactly, and no sitting ends in the interior of a
/// run that has no break (we only ever end on a supplied break or the body end).
pub fn chunk(body_len: usize, breaks: &[Break], start: usize, target_chars: usize) -> Vec<Sitting> {
    let mut out = Vec::new();
    if start >= body_len {
        return out;
    }
    let target = target_chars.max(1);

    // Sorted, de-duplicated breaks strictly inside the readable span. Keep the
    // strongest kind when two break kinds land on the same offset.
    let mut pts: Vec<Break> = breaks
        .iter()
        .copied()
        .filter(|b| b.offset > start && b.offset < body_len)
        .collect();
    pts.sort_by(|a, b| a.offset.cmp(&b.offset).then(b.kind.rank().cmp(&a.kind.rank())));
    pts.dedup_by(|a, b| a.offset == b.offset);

    let mut cursor = start;
    while cursor < body_len {
        let ideal = cursor + target;
        // If the rest of the body is within one (tolerant) target, take it all.
        if ideal + (target as f64 * MIN_TAIL_FRACTION) as usize >= body_len {
            out.push(Sitting { start: cursor, end: body_len });
            break;
        }

        let lo = cursor + (target as f64 * (1.0 - WINDOW_TOLERANCE)) as usize;
        let hi = (cursor + (target as f64 * (1.0 + WINDOW_TOLERANCE)) as usize).min(body_len);

        // Candidates that fall within the acceptance window [lo, hi].
        let in_window: Vec<&Break> =
            pts.iter().filter(|b| b.offset >= lo && b.offset <= hi).collect();

        let end = if let Some(best) = in_window.into_iter().max_by(|a, b| {
            a.kind
                .rank()
                .cmp(&b.kind.rank())
                // Among equal strength, prefer the one nearest the ideal end.
                .then_with(|| {
                    let da = (a.offset as i64 - ideal as i64).abs();
                    let db = (b.offset as i64 - ideal as i64).abs();
                    db.cmp(&da)
                })
        }) {
            best.offset
        } else {
            // No clean break in the window: end at the first break at or after lo
            // (accepting an overshoot) so we never cut mid-paragraph. If there is
            // none before the body end, the body end closes this sitting.
            pts.iter()
                .find(|b| b.offset >= lo)
                .map(|b| b.offset)
                .unwrap_or(body_len)
        };

        out.push(Sitting { start: cursor, end });
        cursor = end;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paras(every: usize, body_len: usize) -> Vec<Break> {
        (1..)
            .map(|i| i * every)
            .take_while(|&o| o < body_len)
            .map(|offset| Break { offset, kind: BreakKind::Paragraph })
            .collect()
    }

    fn assert_contiguous(sittings: &[Sitting], start: usize, body_len: usize) {
        assert!(!sittings.is_empty(), "expected at least one sitting");
        assert_eq!(sittings.first().unwrap().start, start);
        assert_eq!(sittings.last().unwrap().end, body_len);
        for w in sittings.windows(2) {
            assert_eq!(w[0].end, w[1].start, "sittings must be contiguous");
        }
        for s in sittings {
            assert!(s.end > s.start, "every sitting non-empty: {s:?}");
        }
    }

    #[test]
    fn target_and_estimate_round_trip() {
        assert_eq!(target_chars_for_minutes(25), 25_000);
        assert_eq!(target_chars_for_minutes(10), 10_000);
        assert_eq!(target_chars_for_minutes(60), 60_000);
        // 25_000 chars -> 5_000 words / 200 wpm = 25 min.
        assert_eq!(minutes_for_chars(25_000), 25);
        assert_eq!(minutes_for_chars(0), 1, "never zero minutes");
    }

    #[test]
    fn even_paragraph_split_lands_near_target() {
        let body = 100_000;
        let breaks = paras(1_000, body); // a paragraph every 1k
        let s = chunk(body, &breaks, 0, 25_000);
        assert_contiguous(&s, 0, body);
        // ~4 sittings, each within tolerance of 25k.
        assert!((3..=5).contains(&s.len()), "got {} sittings", s.len());
        for w in &s[..s.len() - 1] {
            let n = w.char_count();
            assert!((12_500..=37_500).contains(&n), "sitting {n} out of window");
        }
    }

    #[test]
    fn prefers_a_chapter_break_near_the_target() {
        let body = 60_000;
        let mut breaks = paras(1_000, body);
        breaks.push(Break { offset: 24_000, kind: BreakKind::Chapter });
        let s = chunk(body, &breaks, 0, 25_000);
        assert_contiguous(&s, 0, body);
        // The first sitting should end on the chapter at 24k, not a nearer paragraph.
        assert_eq!(s[0].end, 24_000, "should end on the chapter break");
    }

    #[test]
    fn short_chapters_merge_into_one_sitting() {
        let body = 60_000;
        // Five short "chapters" of 5k each at the front, then paragraphs.
        let mut breaks = paras(1_000, body);
        for i in 1..=5 {
            breaks.push(Break { offset: i * 5_000, kind: BreakKind::Chapter });
        }
        let s = chunk(body, &breaks, 0, 25_000);
        assert_contiguous(&s, 0, body);
        // First sitting must NOT stop at the first 5k chapter; it merges toward 25k.
        assert!(s[0].end >= 20_000, "short chapters should merge, got end {}", s[0].end);
    }

    #[test]
    fn long_chapter_splits_at_internal_headings() {
        let body = 80_000;
        // One chapter spanning the whole body, with sub-headings every 20k.
        let mut breaks = paras(2_000, body);
        for i in 1..=3 {
            breaks.push(Break { offset: i * 20_000, kind: BreakKind::Heading });
        }
        let s = chunk(body, &breaks, 0, 25_000);
        assert_contiguous(&s, 0, body);
        // A heading should win over nearby paragraphs as the sitting end.
        assert_eq!(s[0].end, 20_000, "should split on the sub-heading");
    }

    #[test]
    fn no_internal_breaks_yields_one_unsplittable_sitting() {
        let body = 50_000;
        let s = chunk(body, &[], 0, 25_000);
        // Nothing to break on: a single sitting covering the whole body.
        assert_eq!(s, vec![Sitting { start: 0, end: 50_000 }]);
    }

    #[test]
    fn does_not_leave_a_runt_final_sitting() {
        let body = 30_000;
        let breaks = paras(5_000, body);
        let s = chunk(body, &breaks, 0, 25_000);
        assert_contiguous(&s, 0, body);
        // 30k with a 25k target would leave a 5k runt; instead it's one sitting.
        assert_eq!(s.len(), 1, "tiny tail must fold in, got {s:?}");
    }

    #[test]
    fn resumes_from_a_mid_book_start_position() {
        let body = 60_000;
        let breaks = paras(1_000, body);
        let s = chunk(body, &breaks, 10_000, 25_000);
        assert_contiguous(&s, 10_000, body);
        assert!(s[0].start == 10_000);
    }

    #[test]
    fn sparse_breaks_overshoot_rather_than_cut_mid_paragraph() {
        let body = 100_000;
        // Only one paragraph break, far past the first target window.
        let breaks = vec![Break { offset: 60_000, kind: BreakKind::Paragraph }];
        let s = chunk(body, &breaks, 0, 25_000);
        assert_contiguous(&s, 0, body);
        // First sitting overshoots to the only clean break rather than cutting at 25k.
        assert_eq!(s[0].end, 60_000);
    }
}

// Property/invariant tests over the TXT sectionizer (`import::sectionize`, the
// public entry that dispatches to chapter detection or even-chunking).
//
// The v0.3 `chunk_evenly` overlap bug — where a section restarted at the raw,
// un-snapped chunk boundary and so DUPLICATED ~500 bytes into the next section —
// is exactly the class of defect these tests pin down. For EVERY input the
// sections must:
//   (1) END at the body's end and form a CONTIGUOUS, abutting run that ends at
//       last.end == body.len(). They need NOT start at 0: when the sectionizer
//       detects chapters it intentionally DROPS leading front-matter / TOC, so the
//       first section can begin after the dropped prefix. (The even-chunk path —
//       no headings — does cover from 0; that stronger guarantee is checked in
//       `no_headings_fixture_takes_the_chunk_evenly_path`.)
//   (2) ABUT with no overlap and no internal gaps: section[i].end == section[i+1].start;
//   (3) start/end on UTF-8 char boundaries of the body (body.is_char_boundary);
//   (4) be non-degenerate: start < end (no empty sections).
//
// Coverage comes from two directions: a set of small COMMITTED fixtures shaped
// like real Project Gutenberg bodies (network-free — these are checked-in text,
// never downloaded), and a proptest strategy that builds many varied bodies
// (random headings / lengths / whitespace / multibyte unicode).

use throughline_lib::import::sectionize;

/// Assert the four sectionizer invariants for `sections` against `body`.
/// `ctx` labels the failing case (fixture name or generated body excerpt).
fn assert_sectionizer_invariants(ctx: &str, body: &str, sections: &[(String, usize, usize)]) {
    if body.is_empty() {
        assert!(
            sections.is_empty(),
            "[{ctx}] empty body must yield no sections, got {sections:?}"
        );
        return;
    }
    assert!(
        !sections.is_empty(),
        "[{ctx}] non-empty body ({} bytes) yielded no sections",
        body.len()
    );

    // (1) coverage: the emitted sections end at the body's end. They need NOT
    // start at 0 — when the sectionizer detects chapters it intentionally drops
    // leading front-matter / TOC, so the first section can begin after the dropped
    // prefix. The contiguity (no internal gaps) is enforced by the abutment check
    // below; the chunk path's stronger "covers from 0" guarantee is asserted in
    // `no_headings_fixture_takes_the_chunk_evenly_path`.
    assert_eq!(
        sections.last().unwrap().2,
        body.len(),
        "[{ctx}] last section must end at body.len()={}, got {}",
        body.len(),
        sections.last().unwrap().2
    );

    for (i, (label, start, end)) in sections.iter().enumerate() {
        // (4) non-degenerate.
        assert!(
            start < end,
            "[{ctx}] degenerate section {i} {label:?}: {start}..{end}"
        );
        // (3) char-boundary locators (so slicing body[start..end] never panics).
        assert!(
            body.is_char_boundary(*start),
            "[{ctx}] section {i} {label:?} start {start} is not a UTF-8 char boundary"
        );
        assert!(
            body.is_char_boundary(*end),
            "[{ctx}] section {i} {label:?} end {end} is not a UTF-8 char boundary"
        );
        // Slicing must not panic — proves the locators are usable as offsets.
        let _ = &body[*start..*end];
    }

    // (2) abut: no overlap, no gaps.
    for w in sections.windows(2) {
        assert_eq!(
            w[0].2, w[1].1,
            "[{ctx}] sections must abut with no overlap/gap: {:?} then {:?}",
            w[0], w[1]
        );
    }

    // (5) NO WORD SPLIT: no internal boundary cuts through a word. For each
    // boundary b (a section's end == the next section's start), the char ending
    // just before b and the char starting at b must not BOTH be word characters —
    // every split must land on whitespace/punctuation, never inside a run of
    // letters. This is the "Part 3 opens mid-word ('erant…')" bug.
    for w in sections.windows(2) {
        let b = w[0].2;
        if b == 0 || b >= body.len() {
            continue;
        }
        let before = body[..b].chars().next_back();
        let after = body[b..].chars().next();
        if let (Some(bc), Some(ac)) = (before, after) {
            assert!(
                !(is_word_char(bc) && is_word_char(ac)),
                "[{ctx}] boundary at {b} splits a word ({bc:?}|{ac:?}): {:?} then {:?}",
                w[0],
                w[1]
            );
        }
    }
}

/// A "word character" for the no-word-split invariant: any Unicode alphanumeric.
/// A boundary falling between two of these cuts a word in half.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

// ----------------------------------------------------------------------------
// Committed fixtures (real Gutenberg shapes; small, checked-in, never fetched).
// ----------------------------------------------------------------------------

/// Each fixture is the already-extracted book *body* (the slice `import_txt`
/// passes to `sectionize`, after Gutenberg header/footer stripping).
const FIXTURES: &[(&str, &str)] = &[
    (
        "toc_then_chapters",
        include_str!("fixtures/toc_then_chapters.txt"),
    ),
    (
        "multi_volume_restarting",
        include_str!("fixtures/multi_volume_restarting.txt"),
    ),
    (
        "no_headings_prose",
        include_str!("fixtures/no_headings_prose.txt"),
    ),
    (
        "heavy_front_matter",
        include_str!("fixtures/heavy_front_matter.txt"),
    ),
    (
        "accented_multibyte",
        include_str!("fixtures/accented_multibyte.txt"),
    ),
];

// ----------------------------------------------------------------------------
// Real public-domain book corpus (committed; network-free). Each book is the
// PG-header/footer-stripped body trimmed to ~80 KB — large, real, hard-wrapped
// text that reliably produces the chunk_evenly / refine-split boundaries where
// the word-splitting bug lives. Fetched once at build time, never at test time.
// ----------------------------------------------------------------------------
#[rustfmt::skip]
const CORPUS: &[(&str, &str)] = &[
    ("meditations", include_str!("fixtures/corpus/meditations.txt")),
    ("confessions_augustine", include_str!("fixtures/corpus/confessions_augustine.txt")),
    ("modest_proposal", include_str!("fixtures/corpus/modest_proposal.txt")),
    ("moby_dick", include_str!("fixtures/corpus/moby_dick.txt")),
    ("war_and_peace", include_str!("fixtures/corpus/war_and_peace.txt")),
    ("pride_and_prejudice", include_str!("fixtures/corpus/pride_and_prejudice.txt")),
    ("frankenstein", include_str!("fixtures/corpus/frankenstein.txt")),
    ("dracula", include_str!("fixtures/corpus/dracula.txt")),
    ("sherlock_holmes", include_str!("fixtures/corpus/sherlock_holmes.txt")),
    ("don_quijote_es", include_str!("fixtures/corpus/don_quijote_es.txt")),
    ("les_miserables", include_str!("fixtures/corpus/les_miserables.txt")),
    ("the_prince", include_str!("fixtures/corpus/the_prince.txt")),
    ("beyond_good_and_evil", include_str!("fixtures/corpus/beyond_good_and_evil.txt")),
];

/// A section reads as real reading content (not a title page / contents list /
/// dedication / short verse): substantial flowing prose after its heading line.
fn looks_like_real_prose(section_body: &str) -> bool {
    let after = section_body
        .trim_start()
        .split_once('\n')
        .map(|(_, r)| r)
        .unwrap_or("");
    let chars = after.chars().filter(|c| !c.is_whitespace()).count();
    let terms = after
        .bytes()
        .filter(|b| matches!(b, b'.' | b'!' | b'?'))
        .count();
    let long_line = after.lines().any(|l| l.trim().chars().count() > 60);
    chars >= 250 && terms >= 2 && long_line
}

/// The reading plan's day-1 (first assignable section) must be real content, never
/// a dedication / TOC / title page / title-poem.
#[test]
fn plan_day_one_is_real_content_not_front_matter() {
    for (name, body) in CORPUS {
        let raw = sectionize(body);
        let flags = throughline_lib::import::classify_assignable(&raw, body);
        let day1 = flags
            .iter()
            .position(|&a| a)
            .unwrap_or_else(|| panic!("[{name}] no assignable section — plan would be empty"));
        let (label, s, e) = &raw[day1];
        eprintln!("[day1] {name}: section {day1} {label:?}");
        assert!(
            looks_like_real_prose(&body[*s..*e]),
            "[{name}] day-1 section {label:?} is not real prose (likely front matter): {:?}",
            body[*s..*e].chars().take(80).collect::<String>()
        );
    }
}

/// The reported case: Beyond Good and Evil's day-1 must be the Preface (real
/// Nietzsche), not the "FROM THE HEIGHTS" dedication poem.
#[test]
fn beyond_good_and_evil_day_one_is_the_preface_not_the_dedication_poem() {
    let body = CORPUS
        .iter()
        .find(|(n, _)| *n == "beyond_good_and_evil")
        .unwrap()
        .1;
    let raw = sectionize(body);
    let flags = throughline_lib::import::classify_assignable(&raw, body);
    let day1 = flags.iter().position(|&a| a).unwrap();
    let (_, s, e) = &raw[day1];
    assert!(
        body[*s..*e].contains("Truth is a woman"),
        "BG&E day-1 should be the Preface, got: {:?}",
        body[*s..*e].chars().take(80).collect::<String>()
    );
    // …and it must NOT be labelled with the leaked TOC entry ("WHAT IS NOBLE")
    // nor the dedication poem ("FROM THE HEIGHTS … POEM").
    let label = raw[day1].0.to_uppercase();
    assert!(
        !label.contains("NOBLE") && !label.contains("HEIGHTS") && !label.contains("POEM"),
        "BG&E day-1 label is a leaked TOC entry / dedication poem: {:?}",
        raw[day1].0
    );
}

/// Parse a numbered-chapter ordinal: "CHAPTER XXVII. …" → 27, "CHAPTER 3" → 3.
/// None for unnumbered labels (Preface, a title, folded multi-chapter labels).
fn chapter_ordinal(label: &str) -> Option<u32> {
    let up = label.trim().to_uppercase();
    let rest = up.strip_prefix("CHAPTER ")?;
    let tok = rest
        .split(|c: char| !c.is_alphanumeric())
        .find(|t| !t.is_empty())?;
    if let Ok(n) = tok.parse::<u32>() {
        return Some(n);
    }
    roman_to_u32(tok)
}

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

/// No leaked table-of-contents entry as a section label. A contents list's tail
/// (the highest chapter number, or a terminal label like "Epilogue") must never
/// become day-1 sitting BEFORE the real opening chapters. Over every corpus book:
/// the first assignable section must not be a back-matter label, and if it's a
/// numbered chapter its ordinal must not exceed a later section's chapter ordinal.
#[test]
fn sectionize_does_not_leak_a_toc_entry_as_a_section_label() {
    for (name, body) in CORPUS {
        let raw = sectionize(body);
        let flags = throughline_lib::import::classify_assignable(&raw, body);
        let day1 = flags.iter().position(|&a| a).unwrap();
        let (label, _, _) = &raw[day1];
        eprintln!("[toc] {name}: day-1 = {label:?}");
        assert!(
            !label.to_uppercase().starts_with("EPILOGUE"),
            "[{name}] day-1 is a leaked back-matter label: {label:?}"
        );
        if let Some(d1) = chapter_ordinal(label) {
            if let Some(next) = raw[day1 + 1..]
                .iter()
                .find_map(|(l, _, _)| chapter_ordinal(l))
            {
                assert!(
                    d1 <= next,
                    "[{name}] day-1 chapter {d1} ({label:?}) is out of order before a later CHAPTER {next} — a leaked TOC entry"
                );
            }
        }
    }
}

/// The bug this change targets: a section must never start or end in the middle
/// of a word. Runs the full invariant set over 12 real public-domain books.
/// Run with `-- --nocapture` to see each book's section count + which path it took.
#[test]
fn sectionize_never_splits_a_word_across_a_boundary() {
    for (name, body) in CORPUS {
        let sections = sectionize(body);
        let labels: Vec<&str> = sections
            .iter()
            .take(3)
            .map(|(l, _, _)| l.as_str())
            .collect();
        eprintln!(
            "[corpus] {name}: {} sections; first labels {labels:?}",
            sections.len()
        );
        assert_sectionizer_invariants(name, body, &sections);
    }
}

#[test]
fn sectionize_covers_body_without_overlap_or_gaps_for_fixtures() {
    for (name, body) in FIXTURES {
        let sections = sectionize(body);
        assert_sectionizer_invariants(name, body, &sections);
    }
}

#[test]
fn sectionize_locators_are_char_boundaries_for_fixtures() {
    // Redundant with the combined check above, but named for the specific
    // invariant so a regression points straight at char-boundary handling —
    // the multibyte fixture exercises the snap/split byte arithmetic.
    for (name, body) in FIXTURES {
        let sections = sectionize(body);
        if body.is_empty() {
            continue;
        }
        for (i, (label, start, end)) in sections.iter().enumerate() {
            assert!(
                body.is_char_boundary(*start) && body.is_char_boundary(*end),
                "[{name}] section {i} {label:?} {start}..{end} crosses a UTF-8 char boundary"
            );
        }
    }
}

#[test]
fn no_headings_fixture_takes_the_chunk_evenly_path() {
    // Guard that the chapterless fixtures actually exercise the even-chunk path
    // (the home of the v0.3 overlap bug) and produce more than one section, so
    // the abutment invariant has real boundaries to check.
    for name in ["no_headings_prose", "accented_multibyte"] {
        let (_, body) = FIXTURES.iter().find(|(n, _)| *n == name).unwrap();
        let sections = sectionize(body);
        assert!(
            sections.len() >= 2,
            "[{name}] expected multiple even chunks, got {}",
            sections.len()
        );
        // "Part N" labels are chunk_evenly's signature.
        assert!(
            sections.iter().all(|(l, _, _)| l.starts_with("Part ")),
            "[{name}] expected chunk_evenly 'Part N' labels: {:?}",
            sections.iter().map(|(l, _, _)| l).collect::<Vec<_>>()
        );
        // The chunk path has NO front-matter to drop, so it covers the whole body
        // from 0 to len (the stronger guarantee the general helper omits).
        assert_eq!(
            sections.first().unwrap().1,
            0,
            "[{name}] chunk path must cover from 0, got {}",
            sections.first().unwrap().1
        );
        assert_eq!(
            sections.last().unwrap().2,
            body.len(),
            "[{name}] chunk path must cover to body.len()={}, got {}",
            body.len(),
            sections.last().unwrap().2
        );
    }
}

// ----------------------------------------------------------------------------
// Generative coverage (proptest). Builds varied bodies — mixed headings, prose,
// whitespace runs, and multibyte unicode — and asserts the four invariants.
// ----------------------------------------------------------------------------

mod generative {
    use super::assert_sectionizer_invariants;
    use proptest::prelude::*;
    use throughline_lib::import::sectionize;

    // A pool of multibyte and ASCII glyphs so generated prose places non-ASCII
    // codepoints densely enough that a naive byte-offset split would land
    // mid-codepoint (the char-boundary invariant's adversary).
    const GLYPHS: &[&str] = &[
        "a", "e", "i", "o", "u", " ", "é", "è", "à", "ç", "ñ", "œ", "—", "“", "”", "…", "🜨",
    ];

    /// A "paragraph" of 1..=120 glyphs drawn from the pool.
    fn paragraph() -> impl Strategy<Value = String> {
        prop::collection::vec(prop::sample::select(GLYPHS), 1..120).prop_map(|g| g.concat())
    }

    /// A heading line that the sectionizer may or may not recognise.
    fn heading() -> impl Strategy<Value = String> {
        prop_oneof![
            (1u32..40).prop_map(|n| format!("CHAPTER {n}")),
            (1u32..20).prop_map(|n| format!("Chapter {n}")),
            (1u32..10).prop_map(|n| format!("BOOK {n}")),
            (1u32..10).prop_map(|n| format!("Letter {n}")),
            Just("PROLOGUE".to_string()),
            Just("EPILOGUE".to_string()),
            Just("II.".to_string()),
            Just("XiV.".to_string()),
            // Non-heading lines that share heading-ish letters, to keep the
            // detector honest about what it folds vs. splits.
            Just("CONTENTS".to_string()),
            Just("Préface".to_string()),
        ]
    }

    /// One block: an optional heading followed by some paragraphs, joined by a
    /// randomly sized run of blank lines / spaces (so snap-to-paragraph has both
    /// hits and misses to handle).
    fn block() -> impl Strategy<Value = String> {
        (
            prop::option::of(heading()),
            prop::collection::vec(paragraph(), 0..6),
            1usize..4,
        )
            .prop_map(|(h, paras, gaps)| {
                let sep = "\n".repeat(gaps);
                let mut out = String::new();
                if let Some(h) = h {
                    out.push_str(&h);
                    out.push('\n');
                }
                out.push_str(&paras.join(&sep));
                out
            })
    }

    /// A whole body: many blocks joined by blank-line separators. Bounded so the
    /// suite stays fast but large enough to drive multi-chunk splitting.
    fn body() -> impl Strategy<Value = String> {
        prop::collection::vec(block(), 1..40).prop_map(|blocks| blocks.join("\n\n"))
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(400))]

        #[test]
        fn sectionize_covers_body_without_overlap_or_gaps(body in body()) {
            let sections = sectionize(&body);
            let ctx: String = body.chars().take(48).collect();
            assert_sectionizer_invariants(&ctx, &body, &sections);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(400))]

        // Dense multibyte bodies with sparse paragraph breaks: maximises the
        // chance a raw byte chunk/split boundary falls inside a codepoint, so
        // invariant (3) is genuinely under pressure.
        #[test]
        fn sectionize_locators_are_char_boundaries(
            // Long single run of multibyte glyphs, no headings, few breaks —
            // pushes through chunk_evenly's snap fallback and the refine split.
            glyphs in prop::collection::vec(prop::sample::select(GLYPHS), 4000..16000),
        ) {
            let body: String = glyphs.concat();
            let sections = sectionize(&body);
            let ctx: String = body.chars().take(48).collect();
            assert_sectionizer_invariants(&ctx, &body, &sections);
        }
    }
}

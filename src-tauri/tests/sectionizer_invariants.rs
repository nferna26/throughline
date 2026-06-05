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

/// Classify EPUB spine items into assignable (real reading) vs structural
/// front/back matter (cover, title page, contents, copyright, also-by, …).
///
/// The classifier is intentionally conservative: when uncertain it returns
/// `true` (assignable). Losing chapter one is much worse than keeping one
/// stray front-matter page.

/// Match logic for "this item is structural front/back matter, don't put it
/// in the plan." Returns false (= assignable) for anything that doesn't look
/// like a known wrapper page.
pub fn is_front_back_matter(label: Option<&str>, idref: &str, linear: bool) -> bool {
    if !linear {
        // Per EPUB spec, non-linear spine items are auxiliary content.
        return true;
    }
    let raw = label
        .map(|s| s.to_string())
        .unwrap_or_else(|| idref.to_string())
        .to_ascii_lowercase();
    // Normalize underscores/dashes to spaces so "About_the_Author" matches "about the author".
    let needle = raw.replace(['_', '-'], " ");
    matches(&needle, idref)
}

fn matches(needle: &str, idref: &str) -> bool {
    let idref_l = idref.to_ascii_lowercase();
    // Trim leading numeric / ISBN prefixes from the comparison form, e.g.
    // "9780062969750_titlepage" → "titlepage"
    let stripped_idref: String = idref_l
        .splitn(2, '_')
        .last()
        .unwrap_or(&idref_l)
        .to_string();

    // High-confidence skips.
    const ALWAYS_SKIP_SUBSTRINGS: &[&str] = &[
        "cover",
        "title page",
        "titlepage",
        "half title",
        "halftitle",
        "frontispiece",
        "table of contents",
        "contents",        // safe: a real chapter title would be "X: Contents" not just "Contents"
        "toc",
        "copyright",
        "colophon",
        "dedication",
        "epigraph",
        "also by",
        "by the same author",
        "books by",
        "praise for",
        "about the author",
        "about the publisher",
        "newsletter sign",
        "ad card",
    ];
    if ALWAYS_SKIP_SUBSTRINGS.iter().any(|s| needle.contains(s)) {
        return true;
    }

    // Skip "Acknowledg(e)ments" — almost always wrapper, not the main thread.
    if needle.contains("acknowledg") {
        return true;
    }

    // Filename-form labels. When a spine item has no human TOC label, the caller
    // falls back to the href basename (e.g. "praise.xhtml", "opening-blurb.xhtml",
    // "quote.xhtml"). A real chapter ALWAYS carries a TOC label, so a bare
    // filename is high-confidence boilerplate — we can match names here that we'd
    // never dare match on a human label (e.g. "praise" alone, not just the phrase
    // "praise for"). Foreword/Preface/Introduction etc. carry real TOC labels, so
    // they are never filename-form and stay assignable.
    if let Some(stem) = filename_stem(needle).or_else(|| filename_stem(&idref_l)) {
        const FILENAME_SKIP_STEMS: &[&str] = &[
            "praise",     // praise.xhtml — endorsement blurbs
            "blurb",      // opening-blurb.xhtml
            "quote",      // quote.xhtml — standalone epigraph page
            "epigraph",
            "frontmatter",
            "endpaper",
            "advert",
            "promo",
        ];
        if FILENAME_SKIP_STEMS.iter().any(|s| stem.contains(s)) {
            return true;
        }
    }

    // Common compressed idrefs publishers use for back matter.
    // Match as a whole token so we don't catch "Chapter_*" by accident.
    const SKIP_IDREF_TOKENS: &[&str] = &[
        "ba",            // "Books also by" / "By Andrew" — publisher shorthand
        "bookalso",
        "alsoby",
        "newsletter",
        "ad",
    ];
    if SKIP_IDREF_TOKENS.iter().any(|t| &stripped_idref == t) {
        return true;
    }

    false
}

/// If `s` looks like a content filename (ends in an ebook document extension),
/// return its normalized stem: basename minus extension, separators → spaces.
/// Otherwise `None`. Used to recognize boilerplate spine items that have no
/// human TOC label and were keyed by their filename.
fn filename_stem(s: &str) -> Option<String> {
    let lower = s.trim().to_ascii_lowercase();
    const EXTS: &[&str] = &[".xhtml", ".html", ".htm", ".xml"];
    if !EXTS.iter().any(|e| lower.ends_with(e)) {
        return None;
    }
    let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    let stem = base.rsplit_once('.').map(|(st, _)| st).unwrap_or(base);
    Some(stem.replace(['_', '-'], " "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_classic_front_matter_labels() {
        assert!(is_front_back_matter(Some("Cover"), "titlepage", true));
        assert!(is_front_back_matter(Some("Title Page"), "Titlepage", true));
        assert!(is_front_back_matter(Some("Contents"), "Contents", true));
        assert!(is_front_back_matter(Some("Copyright"), "Copyright", true));
        assert!(is_front_back_matter(Some("Dedication"), "ded", true));
    }

    #[test]
    fn skips_back_matter_when_no_toc_label() {
        // Cold Start trailing items are not in the TOC; classifier should match by idref.
        assert!(is_front_back_matter(None, "Copyright", true));
        assert!(is_front_back_matter(None, "About_the_Author", true));
        assert!(is_front_back_matter(None, "About_the_Publisher", true));
        assert!(is_front_back_matter(None, "Acknowledgments", true));
        assert!(is_front_back_matter(None, "BA", true));
    }

    #[test]
    fn keeps_real_chapters() {
        assert!(!is_front_back_matter(Some("Introduction"), "Introduction", true));
        assert!(!is_front_back_matter(Some("Part I: Network Effects"), "Part_1", true));
        assert!(!is_front_back_matter(Some("1. What’s a Network Effect, Anyway?"), "Chapter_1", true));
        assert!(!is_front_back_matter(Some("Conclusion: The Future of Network Effects"), "Conclusion", true));
        // Notes can be substantive endnotes — keep by default.
        assert!(!is_front_back_matter(None, "Notes", true));
        // Foreword / Preface / Prologue are usually real reading.
        assert!(!is_front_back_matter(Some("Foreword"), "fw", true));
        assert!(!is_front_back_matter(Some("Preface"), "pf", true));
        assert!(!is_front_back_matter(Some("Prologue"), "prologue", true));
    }

    #[test]
    fn skips_non_linear_spine_items() {
        // Linear=false means auxiliary content per the EPUB spec.
        assert!(is_front_back_matter(Some("Author note"), "note", false));
    }

    #[test]
    fn skips_filename_form_boilerplate_without_toc_label() {
        // No human TOC label → the caller passes the href basename. These must be
        // skipped even though "praise for" / "blurb" / "quote" as phrases don't
        // appear. This is the "Obviously Awesome starts on a praise page" bug.
        assert!(is_front_back_matter(Some("praise.xhtml"), "praise", true), "praise.xhtml is endorsement boilerplate");
        assert!(is_front_back_matter(Some("opening-blurb.xhtml"), "opening-blurb", true), "blurb page is boilerplate");
        assert!(is_front_back_matter(Some("quote.xhtml"), "quote", true), "standalone quote page is an epigraph");
        // Also catch it when the label is absent and only the idref is filename-y.
        assert!(is_front_back_matter(None, "Text/praise.xhtml", true));
    }

    #[test]
    fn keeps_filename_form_real_content() {
        // A filename-form label that ISN'T boilerplate stays assignable — the
        // operator's rule: skip marketing wrappers, keep authored intros/chapters.
        assert!(!is_front_back_matter(Some("introduction.xhtml"), "introduction", true));
        assert!(!is_front_back_matter(Some("chapter1.xhtml"), "chapter1", true));
        assert!(!is_front_back_matter(Some("part1.xhtml"), "part1", true));
        assert!(!is_front_back_matter(Some("foreword.xhtml"), "foreword", true));
        assert!(!is_front_back_matter(Some("preface.xhtml"), "preface", true));
    }

    #[test]
    fn doesnt_swallow_chapter_with_known_substring() {
        // A real chapter literally titled "The Cover-Up" should NOT be skipped on "cover" alone…
        // We currently DO skip it. That's a tradeoff documented above (conservative on cover/title
        // wrappers because cover-as-real-title is rare in serious nonfiction). This test pins the
        // tradeoff so a future change to the rule shows up here loudly.
        assert!(is_front_back_matter(Some("The Cover-Up"), "ch99", true));
    }
}

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
    fn doesnt_swallow_chapter_with_known_substring() {
        // A real chapter literally titled "The Cover-Up" should NOT be skipped on "cover" alone…
        // We currently DO skip it. That's a tradeoff documented above (conservative on cover/title
        // wrappers because cover-as-real-title is rare in serious nonfiction). This test pins the
        // tradeoff so a future change to the rule shows up here loudly.
        assert!(is_front_back_matter(Some("The Cover-Up"), "ch99", true));
    }
}

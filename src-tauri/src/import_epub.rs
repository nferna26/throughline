use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

use crate::epub_classify::is_front_back_matter;
use crate::import::{hash_file, ImportManifest, ImportResult};
use crate::models::{Book, BookSection, StyleRange};
use crate::paths;

/// Heuristic DRM detection: presence of `META-INF/encryption.xml` (Adobe ADEPT)
/// or `META-INF/rights.xml`. We refuse rather than try to crack anything.
fn looks_drm_protected(epub_path: &Path) -> Result<bool> {
    let f = fs::File::open(epub_path)?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| anyhow!("zip read: {}", e))?;
    // Either marker means the EPUB is DRM-protected. Some encryption.xml only
    // marks fonts as obfuscated, which is technically not DRM on content; we
    // refuse anyway in Shot 2 (users can convert via a tool of their choosing).
    // We deliberately do NOT inspect the file body, only its presence.
    for i in 0..zip.len() {
        let name = zip
            .by_index_raw(i)
            .map(|e| e.name().to_string())
            .unwrap_or_default();
        if name.eq_ignore_ascii_case("META-INF/encryption.xml")
            || name.eq_ignore_ascii_case("META-INF/rights.xml")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn strip_fragment(href: &str) -> String {
    match href.find('#') {
        Some(i) => href[..i].to_string(),
        None => href.to_string(),
    }
}

fn pretty_idref(idref: &str) -> Option<String> {
    // Turn "9780062969750_Chapter_3" → "Chapter 3"
    let tail = idref.splitn(2, '_').last().unwrap_or(idref);
    if tail.is_empty() {
        None
    } else {
        Some(tail.replace('_', " "))
    }
}

fn flatten_toc(nav: &[epub::doc::NavPoint], out: &mut Vec<(String, String)>, depth: usize) {
    // Keep depths 0..=1 to avoid spamming sub-sections; bigger trees still
    // produce useful day-by-day slices because spine fallback kicks in for tiny TOCs.
    for n in nav {
        let label = n.label.trim().to_string();
        let href = n.content.to_string_lossy().to_string();
        if !label.is_empty() && !href.is_empty() {
            out.push((label, href));
        }
        if depth < 1 {
            flatten_toc(&n.children, out, depth + 1);
        }
    }
}

pub fn import_epub(src_path: &Path) -> Result<ImportResult> {
    paths::ensure_dirs()?;
    if !src_path.exists() {
        return Err(anyhow!("source file does not exist: {:?}", src_path));
    }

    if looks_drm_protected(src_path).unwrap_or(false) {
        return Err(anyhow!(
            "this EPUB looks DRM-protected (encryption.xml or rights.xml is present). Throughline refuses to process DRM-protected files. Please use a DRM-free EPUB."
        ));
    }

    // Open with the epub crate to validate + extract metadata + spine + toc.
    // `mut` so we can pull each section's XHTML back out to estimate its length.
    let mut doc = epub::doc::EpubDoc::new(src_path)
        .with_context(|| format!("failed to parse EPUB {:?}", src_path))?;
    let title = doc
        .mdata("title")
        .map(|m| m.value.clone())
        .or_else(|| doc.get_title())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());
    let author = doc.mdata("creator").map(|m| m.value.clone());

    // Build sections from the SPINE (the actual reading order). Shared with the
    // lazy backfill so import and backfill can never diverge on order/labels.
    let sections_input = build_spine_entries(&doc);
    if sections_input.is_empty() {
        return Err(anyhow!("EPUB has no readable sections"));
    }

    // Copy source.epub into app data
    let book_id = format!("book_{}", Uuid::new_v4().simple());
    let book_dir = paths::book_dir(&book_id)?;
    fs::create_dir_all(&book_dir)?;
    let dest = book_dir.join("source.epub");
    fs::copy(src_path, &dest).context("copy EPUB into app data")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest)?.permissions();
        perms.set_mode(0o444);
        let _ = fs::set_permissions(&dest, perms);
    }

    let sha = hash_file(&dest)?;
    let now = Utc::now().to_rfc3339();

    // Extract each spine item to clean plain text (hand-rolled, entity-decoding,
    // never-erroring) and concatenate into a single `source.txt` body — so EPUBs
    // read through the SAME plain-text path (cmd_read_section_text → slice_body →
    // TextReader) as .txt books, retiring the epub.js iframe entirely. Section
    // locators are BYTE offsets into the concatenated body (the slicer is
    // byte-indexed, matching import_txt). Heading/blockquote/emphasis ranges are
    // captured per section (UTF-16 offsets relative to the section's own text) for
    // offset-safe styling. estimated_units stays a char count for reading-time math.
    let (body, extracts) = extract_sections(&mut doc, &sections_input)?;
    let total_chars: usize = extracts.iter().map(|e| e.char_count).sum();
    let mut structure: HashMap<String, Vec<StyleRange>> = HashMap::new();
    let mut sections: Vec<BookSection> = Vec::with_capacity(sections_input.len());
    for (i, (entry, ex)) in sections_input.iter().zip(&extracts).enumerate() {
        let sec_id = format!("sec_{}", Uuid::new_v4().simple());
        if !ex.ranges.is_empty() {
            structure.insert(sec_id.clone(), ex.ranges.clone());
        }
        sections.push(BookSection {
            id: sec_id,
            book_id: book_id.clone(),
            label: entry.label.clone(),
            href: Some(entry.href.clone()),
            start_locator: Some(ex.start.to_string()),
            end_locator: Some(ex.end.to_string()),
            estimated_units: if ex.char_count > 0 {
                Some(ex.char_count as i64)
            } else {
                None
            },
            sort_order: i as i64,
            assignable: entry.assignable,
        });
    }

    // Write the derived plain-text body alongside the immutable source.epub, plus
    // the structure sidecar and a body-offset marker (body_start = 0; EPUB text has
    // no Gutenberg-style header to skip). source.txt is the reader's source;
    // source.epub stays the integrity/SHA anchor and is never modified or exported.
    write_epub_text_artifacts(&book_dir, &body, &structure)?;

    let manifest = ImportManifest {
        book_id: book_id.clone(),
        title: title.clone(),
        author: author.clone(),
        source_type: "epub".to_string(),
        source_filename: src_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("source.epub")
            .to_string(),
        source_sha256: sha.clone(),
        imported_at: now.clone(),
        total_chars, // sum of per-section stripped-text lengths (0 if none read)
        section_count: sections.len(),
    };
    fs::write(
        book_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let book = Book {
        id: book_id,
        title,
        author,
        source_type: "epub".to_string(),
        source_path: dest.to_string_lossy().to_string(),
        source_sha256: sha,
        created_at: now,
        last_opened_at: None,
    };
    Ok(ImportResult { book, sections })
}

/// A spine item resolved to a reading section: its resource id, display label
/// (TOC-derived when possible), fragment-stripped href, and whether it counts
/// toward the plan. Shared by import and the lazy backfill so they never diverge.
#[derive(Debug, Clone)]
pub struct SpineEntry {
    pub idref: String,
    pub label: String,
    pub href: String,
    pub assignable: bool,
}

/// One section's extraction result: BYTE offsets into the concatenated body, a
/// char count (reading-time unit), and its UTF-16 style ranges.
struct SectionExtract {
    start: usize,
    end: usize,
    char_count: usize,
    ranges: Vec<StyleRange>,
}

/// Build reading sections from the spine (authoritative reading order), labelling
/// each by its TOC entry when one exists. Dedupes consecutive same-href entries,
/// and if EVERY item looked like front matter (classifier struck out) keeps them
/// all assignable rather than producing an empty plan.
fn build_spine_entries<R: std::io::Read + std::io::Seek>(
    doc: &epub::doc::EpubDoc<R>,
) -> Vec<SpineEntry> {
    let mut toc_pairs: Vec<(String, String)> = Vec::new();
    flatten_toc(&doc.toc, &mut toc_pairs, 0);
    let mut toc_label_by_href: HashMap<String, String> = HashMap::new();
    for (label, href) in &toc_pairs {
        let key = strip_fragment(href);
        toc_label_by_href
            .entry(key)
            .or_insert_with(|| label.clone());
    }
    let mut entries: Vec<SpineEntry> = Vec::new();
    for (i, item) in doc.spine.iter().enumerate() {
        let Some(res) = doc.resources.get(&item.idref) else {
            continue;
        };
        let href = res.path.to_string_lossy().to_string();
        let href_no_frag = strip_fragment(&href);
        let toc_label = toc_label_by_href.get(&href_no_frag).cloned();
        let label = toc_label.clone().unwrap_or_else(|| {
            pretty_idref(&item.idref).unwrap_or_else(|| format!("Section {}", i + 1))
        });
        let assignable = !is_front_back_matter(toc_label.as_deref(), &item.idref, item.linear);
        entries.push(SpineEntry {
            idref: item.idref.clone(),
            label,
            href: href_no_frag,
            assignable,
        });
    }
    entries.dedup_by(|a, b| a.href == b.href);
    if !entries.is_empty() && !entries.iter().any(|e| e.assignable) {
        tracing::warn!(
            category = "import",
            "classifier marked every spine item as front matter — keeping all as assignable"
        );
        for e in entries.iter_mut() {
            e.assignable = true;
        }
    }
    entries
}

/// Upper bound on the total extracted plain-text body (bytes). The `epub` crate
/// reads each spine resource fully into memory with no caller-visible declared
/// size, so we bound the ACCUMULATED extracted text instead — a backstop against
/// a maliciously crafted zip-bomb EPUB exhausting memory. ~500 MB of stripped
/// prose is far past any real book.
const MAX_EXTRACTED_BODY_BYTES: usize = 500 * 1024 * 1024;

/// Extract every spine item to clean text, concatenated into one body (sections
/// joined by a blank line). Returns the body plus per-section byte offsets +
/// style ranges, aligned 1:1 with `entries`. Errors if the accumulated body
/// exceeds `MAX_EXTRACTED_BODY_BYTES` (zip-bomb / OOM guard).
fn extract_sections<R: std::io::Read + std::io::Seek>(
    doc: &mut epub::doc::EpubDoc<R>,
    entries: &[SpineEntry],
) -> Result<(String, Vec<SectionExtract>)> {
    // The EPUB3 navigation document's resource path (fragment-stripped), used to
    // recognise the table-of-contents spine item by href. None for EPUB2.
    let nav_href = doc.get_nav_id().and_then(|id| {
        doc.resources
            .get(&id)
            .map(|r| strip_fragment(&r.path.to_string_lossy()))
    });
    let mut body = String::new();
    let mut out: Vec<SectionExtract> = Vec::with_capacity(entries.len());
    for entry in entries {
        let kind = section_kind_for(entry, nav_href.as_deref());
        // TODO(CORE-1029): `get_resource_str` decompresses a spine member fully
        // into memory BEFORE the accumulated check below can see it, so one
        // multi-GB member still allocates once before being refused. Bounding
        // it up front needs a declared-size API from the `epub` crate.
        let extracted = doc
            .get_resource_str(&entry.idref)
            .map(|(html, _mime)| extract_section_with_kind(&html, kind))
            .unwrap_or_default();
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        let start = body.len();
        body.push_str(&extracted.text);
        let end = body.len();
        if end > MAX_EXTRACTED_BODY_BYTES {
            return Err(anyhow!(
                "EPUB extracted text exceeds {} MB; refusing to import (possible zip bomb)",
                MAX_EXTRACTED_BODY_BYTES / (1024 * 1024)
            ));
        }
        let char_count = extracted.text.chars().count();
        out.push(SectionExtract {
            start,
            end,
            char_count,
            ranges: extracted.ranges,
        });
    }
    Ok((body, out))
}

/// Decide a spine item's book-typesetting role from signals available before we
/// open its XHTML: the EPUB3 nav document href, the item's assignability (the
/// classifier already told us whether it's front/back matter), and label/idref
/// hints. This is the HEURISTIC layer; an authoritative inline `epub:type`
/// landmark inside the XHTML can still promote a `Plain` result during
/// extraction (see `promote_kind_from_epubtype`).
///
/// • An assignable (body) item → `Chapter`.
/// • The nav document, or a "contents"/"toc"-labelled item → `Toc`.
/// • A "title page"/"titlepage"/"half title" item → `TitlePage`.
/// • An "epigraph"-labelled item → `Epigraph`.
/// • Everything else (copyright, dedication, about-the-author, …) → `Plain`.
fn section_kind_for(entry: &SpineEntry, nav_href: Option<&str>) -> SectionKind {
    if entry.assignable {
        return SectionKind::Chapter;
    }
    // Front/back matter: refine into a typeset role when we recognise one.
    if let Some(nav) = nav_href {
        if entry.href == nav {
            return SectionKind::Toc;
        }
    }
    // Normalize label + idref to a lowercase, separator-free needle (same shape the
    // classifier uses) so "Title_Page" and "title-page" both match.
    let hay = format!("{} {}", entry.label, entry.idref)
        .to_ascii_lowercase()
        .replace(['_', '-'], " ");
    if hay.contains("title page") || hay.contains("titlepage") || hay.contains("half title") {
        return SectionKind::TitlePage;
    }
    if hay.contains("table of contents") || hay.contains("contents") || has_token(&hay, "toc") {
        return SectionKind::Toc;
    }
    if hay.contains("epigraph") {
        return SectionKind::Epigraph;
    }
    SectionKind::Plain
}

/// True when `needle` appears as a whole space-delimited token in `hay` (so "toc"
/// matches "toc" / "front toc" but never "protocol").
fn has_token(hay: &str, needle: &str) -> bool {
    hay.split_ascii_whitespace().any(|t| t == needle)
}

#[cfg(unix)]
fn set_readonly(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o444);
        let _ = fs::set_permissions(path, perms);
    }
}
#[cfg(not(unix))]
fn set_readonly(_path: &Path) {}

/// Write the derived plain-text body (read-only), the structure sidecar, and the
/// body-offset marker (body_start = 0 for EPUBs). Shared by import + backfill.
fn write_epub_text_artifacts(
    book_dir: &Path,
    body: &str,
    structure: &HashMap<String, Vec<StyleRange>>,
) -> Result<()> {
    let txt = book_dir.join("source.txt");
    fs::write(&txt, body).context("write derived source.txt")?;
    set_readonly(&txt);
    fs::write(
        book_dir.join("structure.json"),
        serde_json::to_string(structure)?,
    )?;
    fs::write(
        book_dir.join("body_offsets.json"),
        serde_json::to_string(
            &serde_json::json!({ "body_start": 0usize, "body_end": body.len() }),
        )?,
    )?;
    Ok(())
}

/// One-time backfill for EPUBs imported BEFORE the text pivot: they have an
/// immutable `source.epub` but no `source.txt` (and NULL section locators).
/// Regenerate the derived text + structure from `source.epub` and fill in the
/// EXISTING rows' byte locators in place — preserving section ids, so completion
/// tracking and anchored notes survive. No-op when `source.txt` already exists or
/// there is no `source.epub`. Runs under the caller's DB lock. Returns whether it
/// generated anything. Refuses (errors) on a section-count mismatch rather than
/// mis-aligning offsets.
pub fn ensure_epub_text(conn: &rusqlite::Connection, book_id: &str) -> Result<bool> {
    let book_dir = paths::book_dir(book_id).map_err(|e| anyhow!("{}", e))?;
    if book_dir.join("source.txt").exists() {
        return Ok(false);
    }
    let epub_path = book_dir.join("source.epub");
    if !epub_path.exists() {
        return Ok(false);
    }
    let mut doc = epub::doc::EpubDoc::new(&epub_path)
        .with_context(|| format!("reopen EPUB {:?} for text backfill", epub_path))?;
    let entries = build_spine_entries(&doc);
    let (body, extracts) = extract_sections(&mut doc, &entries)?;

    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM book_sections WHERE book_id = ?1 ORDER BY sort_order ASC")?;
        let rows = stmt.query_map([book_id], |r| r.get::<_, String>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    if ids.len() != extracts.len() {
        return Err(anyhow!(
            "section count mismatch for {} (db {} vs epub {}); refusing text backfill",
            book_id,
            ids.len(),
            extracts.len()
        ));
    }

    let mut structure: HashMap<String, Vec<StyleRange>> = HashMap::new();
    for (id, ex) in ids.iter().zip(&extracts) {
        if !ex.ranges.is_empty() {
            structure.insert(id.clone(), ex.ranges.clone());
        }
    }
    write_epub_text_artifacts(&book_dir, &body, &structure)?;
    for (id, ex) in ids.iter().zip(&extracts) {
        conn.execute(
            "UPDATE book_sections SET start_locator = ?1, end_locator = ?2, estimated_units = ?3 WHERE id = ?4",
            rusqlite::params![
                ex.start.to_string(),
                ex.end.to_string(),
                if ex.char_count > 0 { Some(ex.char_count as i64) } else { None },
                id
            ],
        )?;
    }
    Ok(true)
}

/// Clean plain text extracted from one spine item's XHTML, plus the inline/block
/// style ranges (UTF-16 offsets into `text`) for offset-safe styling.
#[derive(Debug, Default, Clone)]
pub struct ExtractedSection {
    pub text: String,
    pub ranges: Vec<StyleRange>,
}

/// The book-typesetting role of a whole spine item, derived at the call site from
/// the EPUB's own semantics (the nav document, the classifier's front/back-matter
/// verdict, and label/idref hints). It tells the extractor which NEW block roles
/// (`title`/`subtitle`/`byline`, `contents-*`, `epigraph`, `chapter-*`,
/// `body-first`) it may emit for THIS document. Inline `epub:type` attributes
/// inside the XHTML refine this further (and can promote a `Plain` section that
/// turns out to carry `epub:type="titlepage"` / `"toc"`). `Plain` emits only the
/// legacy h1–h6/blockquote/pre/em/strong ranges — exactly as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SectionKind {
    /// The title page: main title → `title`, secondary title → `subtitle`,
    /// author line → `byline`.
    TitlePage,
    /// The table of contents / nav document: the "Contents" heading →
    /// `contents-label`, part groupings → `contents-part`, each entry →
    /// `contents-item`.
    Toc,
    /// A standalone epigraph page: its quoted block → `epigraph`.
    Epigraph,
    /// An assignable body spine item (a chapter): the opening heading →
    /// `chapter-title` (a kicker above it → `chapter-label`), and the first prose
    /// paragraph after it → `body-first`. Interior headings stay h2–h6.
    Chapter,
    /// Front/back matter with no special typesetting (copyright, dedication,
    /// "about the author", …) — legacy ranges only.
    #[default]
    Plain,
}

/// Decode one HTML/XML entity name (the part between `&` and `;`). Handles the
/// XML predefined entities, numeric refs (`#123`, `#x1F`), and the common
/// typographic/accented HTML named entities EPUBs use. Unknown names → None
/// (the caller leaves them literal, which never corrupts the stream).
fn decode_one_entity(ent: &str) -> Option<String> {
    if let Some(num) = ent.strip_prefix('#') {
        let cp = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        return char::from_u32(cp).map(|c| c.to_string());
    }
    let c = match ent {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{00A0}',
        "shy" => '\u{00AD}',
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "hellip" => '\u{2026}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "ldquo" => '\u{201C}',
        "rdquo" => '\u{201D}',
        "laquo" => '\u{00AB}',
        "raquo" => '\u{00BB}',
        "bull" => '\u{2022}',
        "middot" => '\u{00B7}',
        "copy" => '\u{00A9}',
        "reg" => '\u{00AE}',
        "trade" => '\u{2122}',
        "deg" => '\u{00B0}',
        "sect" => '\u{00A7}',
        "para" => '\u{00B6}',
        "dagger" => '\u{2020}',
        "Dagger" => '\u{2021}',
        "eacute" => 'é',
        "egrave" => 'è',
        "ecirc" => 'ê',
        "agrave" => 'à',
        "acirc" => 'â',
        "ccedil" => 'ç',
        "ocirc" => 'ô',
        "ouml" => 'ö',
        "uuml" => 'ü',
        "auml" => 'ä',
        "iuml" => 'ï',
        "icirc" => 'î',
        "ugrave" => 'ù',
        "ntilde" => 'ñ',
        "szlig" => 'ß',
        "oelig" => '\u{0153}',
        "aelig" => '\u{00E6}',
        "euro" => '\u{20AC}',
        "pound" => '\u{00A3}',
        _ => return None,
    };
    Some(c.to_string())
}

/// Decode all entities in a text run. Cheap fast-path when there is no `&`.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            if let Some(semi) = (i + 1..(i + 12).min(chars.len())).find(|&j| chars[j] == ';') {
                let ent: String = chars[i + 1..semi].iter().collect();
                if let Some(decoded) = decode_one_entity(&ent) {
                    out.push_str(&decoded);
                    i = semi + 1;
                    continue;
                }
            }
            out.push('&');
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Accumulator that turns a stream of decoded text + tag events into clean,
/// blank-line-separated paragraphs while tracking UTF-16 style ranges.
#[derive(Default)]
struct Extractor {
    out: String,
    u16: u32,
    pending_space: bool,
    at_para_start: bool,
    inline_stack: Vec<(String, u32)>,
    block_stack: Vec<(String, u32)>,
    ranges: Vec<StyleRange>,
    skip: Option<String>,
    // ---- book-typography role state ----
    // The document's role (set by the caller). Drives which NEW block roles this
    // section may emit. `Plain` → legacy behaviour only.
    kind: SectionKind,
    // Has the chapter's opening heading (its `chapter-title`) been claimed yet?
    // Gates which heading becomes the title vs an interior h2–h6.
    saw_chapter_title: bool,
    // Has any chapter heading/kicker been seen? The FIRST plain prose paragraph
    // after it becomes `body-first` exactly once.
    saw_chapter_heading: bool,
    body_first_done: bool,
    // On a TitlePage, the first title-ish block is `title`, the next a `subtitle`.
    saw_title: bool,
    // Depth of currently-open `<p>`/`<li>` elements that pushed a roled range onto
    // the block stack, innermost last. A close pops a range iff the matching open
    // pushed one. (h1–h6/blockquote keep their own always-tracked path.)
    roled_pl_stack: Vec<bool>,
    // Code-block state. `code` is Some while inside a code container (`<pre>` or a
    // block whose class is code-ish, e.g. `table.processedcode`). `code_verbatim`
    // preserves whitespace (true for <pre>); otherwise we collapse the XHTML
    // pretty-print whitespace and take line breaks from row/line elements.
    code: Option<String>,
    code_closer: String,
    code_depth: u32,
    code_verbatim: bool,
    code_pending_space: bool,
    code_skip: Option<String>,
}

/// A block element whose class marks it as a code listing (publisher-agnostic-ish:
/// `processedcode`, `programlisting`, `sourceCode`, `code`, …).
fn is_code_class(class: &str) -> bool {
    let c = class.to_ascii_lowercase();
    c.contains("code")
        || c.contains("programlisting")
        || c.contains("listing")
        || c.contains("sourcecode")
}

/// A code sub-element that is a line-number / prefix gutter, not code text.
fn is_gutter_class(class: &str) -> bool {
    let c = class.to_ascii_lowercase();
    c.contains("codeinfo")
        || c.contains("codeprefix")
        || c.contains("lineno")
        || c.contains("linenum")
        || c.contains("gutter")
}

/// Trim trailing space on each line and drop leading/trailing blank lines, keeping
/// interior blank lines and any leading indentation (for verbatim `<pre>`).
fn normalize_code(buf: &str) -> String {
    let lines: Vec<&str> = buf.split('\n').map(|l| l.trim_end()).collect();
    let first = lines.iter().position(|l| !l.is_empty()).unwrap_or(0);
    let last = lines
        .iter()
        .rposition(|l| !l.is_empty())
        .map(|i| i + 1)
        .unwrap_or(0);
    if first >= last {
        return String::new();
    }
    lines[first..last].join("\n")
}

/// Extract a named attribute's value from a tag's inner text (quote-aware so
/// multi-token values like `cf methodname` survive). `attr` must be lowercase and
/// include the `=` (e.g. `"class="`). Empty when absent. The match requires the
/// char before `attr` to be a tag boundary (`<` start, whitespace, or `/`) so
/// `class=` never matches inside `someclass=` and `epub:type=` is found whether
/// the source writes `epub:type` or a default-namespaced `type`.
fn attr_of(raw: &str, attr: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(attr) {
        let p = from + rel;
        let ok_boundary = p == 0
            || lower[..p]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '/');
        if !ok_boundary {
            from = p + attr.len();
            continue;
        }
        let rest = &raw[p + attr.len()..];
        let bytes = rest.as_bytes();
        if bytes.is_empty() {
            return String::new();
        }
        let q = bytes[0];
        if q == b'"' || q == b'\'' {
            return rest[1..]
                .find(q as char)
                .map(|end| rest[1..1 + end].to_string())
                .unwrap_or_default();
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        return rest[..end].to_string();
    }
    String::new()
}

/// Extract the `class` attribute value from a tag's inner text. Empty when absent.
fn class_of(raw: &str) -> String {
    attr_of(raw, "class=")
}

/// Extract the `epub:type` (or default-namespaced `type`) attribute — the EPUB3
/// structural-semantics vocabulary (`titlepage`, `toc`, `epigraph`, `title`,
/// `subtitle`, `bridgehead`, …). EPUBs may declare the epub namespace under any
/// prefix; `epub:type` is by far the most common, so we match it directly and
/// fall back to a bare `type=` only on elements where a plain HTML `type` is
/// meaningless (handled by the caller). Returns lowercase, space-separated.
fn epubtype_of(raw: &str) -> String {
    let v = attr_of(raw, "epub:type=");
    if !v.is_empty() {
        return v.to_ascii_lowercase();
    }
    String::new()
}

impl Extractor {
    fn new(kind: SectionKind) -> Self {
        Extractor {
            at_para_start: true,
            kind,
            ..Default::default()
        }
    }
    fn append_char(&mut self, c: char) {
        self.out.push(c);
        self.u16 += c.len_utf16() as u32;
    }
    /// Append already-entity-decoded text, collapsing whitespace runs to a single
    /// space, suppressing leading space at a paragraph start, and dropping soft
    /// hyphens / zero-width characters.
    fn push_text(&mut self, s: &str) {
        if self.skip.is_some() {
            return;
        }
        if self.code.is_some() {
            if self.code_skip.is_none() {
                self.code_push(s);
            }
            return;
        }
        for c in s.chars() {
            if c == '\u{00AD}' || c == '\u{200B}' || c == '\u{FEFF}' {
                continue;
            }
            if c.is_whitespace() || c == '\u{00A0}' {
                self.pending_space = true;
            } else {
                if self.pending_space && !self.at_para_start {
                    self.append_char(' ');
                }
                self.pending_space = false;
                self.at_para_start = false;
                self.append_char(c);
            }
        }
    }
    /// Append text into the current code buffer. Verbatim for `<pre>` (preserve
    /// indentation + newlines); collapsing for class-based code (the source
    /// whitespace is XHTML pretty-printing, not code — line breaks come from row
    /// elements instead).
    fn code_push(&mut self, s: &str) {
        if self.code_verbatim {
            let buf = self.code.as_mut().unwrap();
            for c in s.chars() {
                if c == '\u{200B}' || c == '\u{FEFF}' {
                    continue;
                }
                buf.push(c);
            }
            return;
        }
        for c in s.chars() {
            if c == '\u{200B}' || c == '\u{FEFF}' || c == '\u{00AD}' {
                continue;
            }
            if c.is_whitespace() || c == '\u{00A0}' {
                self.code_pending_space = true;
            } else {
                let buf = self.code.as_mut().unwrap();
                if self.code_pending_space && !buf.is_empty() && !buf.ends_with('\n') {
                    buf.push(' ');
                }
                buf.push(c);
                self.code_pending_space = false;
            }
        }
    }
    /// End the current code line (single newline; never leading/duplicate).
    fn code_newline(&mut self) {
        self.code_pending_space = false;
        if let Some(buf) = self.code.as_mut() {
            if !buf.is_empty() && !buf.ends_with('\n') {
                buf.push('\n');
            }
        }
    }
    fn open_code(&mut self, name: &str, verbatim: bool) {
        self.para_break();
        self.code = Some(String::new());
        self.code_closer = name.to_string();
        self.code_depth = 1;
        self.code_verbatim = verbatim;
        self.code_pending_space = false;
        self.code_skip = None;
    }
    fn close_code(&mut self) {
        let buf = self.code.take().unwrap_or_default();
        self.code_skip = None;
        self.code_depth = 0;
        let code = normalize_code(&buf);
        if !code.is_empty() {
            self.para_break();
            let start = self.u16;
            for c in code.chars() {
                self.append_char(c);
            }
            let end = self.u16;
            self.ranges.push(StyleRange {
                kind: "pre".into(),
                start,
                end,
            });
            self.at_para_start = false;
            self.para_break();
        }
    }
    /// End the current paragraph: a single blank line between blocks, never
    /// leading/trailing/doubled.
    fn para_break(&mut self) {
        self.pending_space = false;
        if !self.out.is_empty() && !self.at_para_start {
            self.out.push('\n');
            self.out.push('\n');
            self.u16 += 2;
            self.at_para_start = true;
        }
    }
    fn open_inline(&mut self, kind: &str) {
        // Flush a pending inter-word space FIRST so it sits OUTSIDE the range —
        // the styled run begins at the first real character, not a leading space.
        if self.pending_space && !self.at_para_start {
            self.append_char(' ');
            self.pending_space = false;
        }
        self.inline_stack.push((kind.to_string(), self.u16));
    }
    fn close_inline(&mut self, kind: &str) {
        if let Some(pos) = self.inline_stack.iter().rposition(|(k, _)| k == kind) {
            let (_, start) = self.inline_stack.remove(pos);
            if self.u16 > start {
                self.ranges.push(StyleRange {
                    kind: kind.to_string(),
                    start,
                    end: self.u16,
                });
            }
        }
    }
    fn open_block(&mut self, kind: &str, track: bool) {
        self.para_break();
        if track {
            self.block_stack.push((kind.to_string(), self.u16));
        }
    }
    fn close_block(&mut self, track: bool) {
        if track {
            if let Some((kind, start)) = self.block_stack.pop() {
                if self.u16 > start {
                    self.ranges.push(StyleRange {
                        kind,
                        start,
                        end: self.u16,
                    });
                }
            }
        }
        self.para_break();
    }
    /// Open a block whose role was decided up front (a NEW book-typography role,
    /// or a legacy heading kept under a new name). Always tracked: its range spans
    /// exactly its paragraph, like a heading.
    fn open_roled_block(&mut self, role: &str, marks_heading: bool) {
        self.para_break();
        self.block_stack.push((role.to_string(), self.u16));
        if marks_heading {
            self.saw_chapter_heading = true;
        }
    }
    /// Open an `<h1>`–`<h6>` / `<blockquote>`. In a roled section these can carry
    /// a NEW book-typography role (chapter-title, contents-label, epigraph, …);
    /// otherwise they keep their legacy tag name. Either way the block is tracked
    /// and its range spans exactly its paragraph (so it remains a `p[data-offset]`
    /// in the reader — the role is a class, never a heading tag).
    fn open_heading_or_quote(&mut self, name: &str, etype: &str, class: &str) {
        let is_heading = matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
        let role = if self.kind == SectionKind::Plain {
            None
        } else {
            self.decide_block_role(name, etype, class)
        };
        match role {
            Some(r) => {
                // A chapter-title / chapter-label heading also arms `body-first`.
                let marks_heading = self.kind == SectionKind::Chapter
                    && (r == "chapter-title" || r == "chapter-label");
                self.open_roled_block(&r, marks_heading);
            }
            None => {
                // Legacy heading/blockquote. On a chapter page an interior heading
                // that isn't the title still marks that a heading has been seen so a
                // late first paragraph won't be mis-tagged before any heading.
                if is_heading && self.kind == SectionKind::Chapter {
                    self.saw_chapter_heading = true;
                }
                self.open_block(name, true);
            }
        }
    }
    /// Decide the book-typography role for a block element that is OPENING, from
    /// the section kind, the element's `epub:type`, its tag name, and position.
    /// Returns `(role, marks_heading)` when a NEW role applies; None means "fall
    /// through to legacy handling" (h1–h6/blockquote tracked by tag, prose plain).
    ///
    /// Pure intent → easy to keep aligned with the txt path and the frontend's
    /// role→class map. The role STRINGS here are the shared vocabulary.
    fn decide_block_role(&mut self, name: &str, etype: &str, class: &str) -> Option<String> {
        let is_heading = matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
        let class_l = class.to_ascii_lowercase();
        let has = |needle: &str| etype.split_ascii_whitespace().any(|t| t == needle);
        // A leading lowercase "and" between two titles is the italic connector the
        // frontend styles; it rides the `subtitle` role (handled by the caller's
        // text check, not here).
        match self.kind {
            SectionKind::TitlePage => {
                // epub:type is authoritative on a title page.
                if has("title") || (!self.saw_title && (is_heading || class_l.contains("title")))
                {
                    // The first title-ish block is the main title; a later one is a
                    // secondary title (subtitle).
                    if self.saw_title {
                        return Some("subtitle".into());
                    }
                    self.saw_title = true;
                    return Some("title".into());
                }
                if has("subtitle") || class_l.contains("subtitle") {
                    return Some("subtitle".into());
                }
                if has("author") || has("z3998:author") || class_l.contains("author") {
                    return Some("byline".into());
                }
                // A bare <p> on a title page after the title is usually the byline.
                if name == "p" && self.saw_title {
                    return Some("byline".into());
                }
                None
            }
            SectionKind::Toc => {
                if has("title") || (is_heading && !self.saw_title) {
                    self.saw_title = true;
                    return Some("contents-label".into());
                }
                // Nested list headings / part labels.
                if class_l.contains("part") || has("part") {
                    return Some("contents-part".into());
                }
                // Each entry line: a list item or a paragraph row in the nav/toc.
                if matches!(name, "li" | "p") {
                    return Some("contents-item".into());
                }
                None
            }
            SectionKind::Epigraph => {
                // The quoted block (blockquote OR the page's paragraphs) is the epigraph.
                if has("epigraph") || matches!(name, "blockquote" | "p") {
                    return Some("epigraph".into());
                }
                None
            }
            SectionKind::Chapter => {
                // A small kicker above the title (epub:type label/ordinal, or a
                // label-ish class) → chapter-label; it does NOT consume the title.
                if !self.saw_chapter_title
                    && (has("label") || has("ordinal") || class_l.contains("chapter-label"))
                {
                    return Some("chapter-label".into());
                }
                if is_heading && !self.saw_chapter_title {
                    // First heading of the chapter is its title.
                    self.saw_chapter_title = true;
                    return Some("chapter-title".into());
                }
                // Interior headings stay legacy h2–h6 (None → legacy path).
                None
            }
            SectionKind::Plain => None,
        }
    }
    fn handle_tag(
        &mut self,
        name: &str,
        class: &str,
        etype: &str,
        is_close: bool,
        is_selfclose: bool,
    ) {
        if let Some(sk) = &self.skip {
            if is_close && name == sk.as_str() {
                self.skip = None;
            }
            return;
        }
        // ---- inside a code block: capture code text, lines from row elements ----
        if self.code.is_some() {
            if let Some(gk) = self.code_skip.clone() {
                if is_close && name == gk {
                    self.code_skip = None;
                }
                return;
            }
            if !is_close && !is_selfclose && is_gutter_class(class) {
                self.code_skip = Some(name.to_string()); // line-number / prefix gutter
                return;
            }
            if name == self.code_closer {
                if is_close {
                    self.code_depth = self.code_depth.saturating_sub(1);
                    if self.code_depth == 0 {
                        self.close_code()
                    } else {
                        self.code_newline()
                    }
                } else if !is_selfclose {
                    self.code_depth += 1;
                }
                return;
            }
            match name {
                "tr" | "div" | "p" | "li" | "dd" | "dt" if is_close => self.code_newline(),
                "br" => self.code_newline(),
                _ => {}
            }
            return;
        }
        // ---- entering a code block? ----
        if !is_close && !is_selfclose {
            if name == "pre" {
                self.open_code(name, true);
                return;
            }
            if (name == "table" || name == "div" || name == "p") && is_code_class(class) {
                self.open_code(name, false);
                return;
            }
        }
        // ---- normal prose ----
        match name {
            "script" | "style" | "head" | "title" if !is_close && !is_selfclose => {
                self.skip = Some(name.to_string());
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" => {
                if is_close {
                    self.close_block(true)
                } else {
                    self.open_heading_or_quote(name, etype, class)
                }
            }
            "p" | "li" => {
                if is_close {
                    // Pop the matching open frame; emit a range iff that open took a
                    // NEW book-typography role (title/byline/contents-item/…).
                    let roled = self.roled_pl_stack.pop().unwrap_or(false);
                    self.close_block(roled);
                } else {
                    let role = if self.kind == SectionKind::Plain {
                        None
                    } else {
                        self.decide_block_role(name, etype, class)
                    };
                    match role {
                        Some(r) => {
                            self.roled_pl_stack.push(true);
                            self.open_roled_block(&r, false);
                        }
                        None => {
                            // First plain prose paragraph after a chapter heading →
                            // body-first (once). Otherwise an untracked block.
                            if name == "p"
                                && self.kind == SectionKind::Chapter
                                && self.saw_chapter_heading
                                && !self.body_first_done
                            {
                                self.body_first_done = true;
                                self.roled_pl_stack.push(true);
                                self.open_roled_block("body-first", false);
                            } else {
                                self.roled_pl_stack.push(false);
                                self.open_block(name, false);
                            }
                        }
                    }
                }
            }
            "div" | "ul" | "ol" | "dd" | "dt" | "section" | "article" | "header" | "footer"
            | "nav" | "aside" | "main" | "figure" | "figcaption" | "table" | "tr" | "td" | "th"
            | "caption" => {
                if is_close {
                    self.close_block(false)
                } else {
                    self.open_block(name, false)
                }
            }
            "hr" => self.para_break(),
            "br" => self.pending_space = true,
            "strong" | "b" => {
                if is_close {
                    self.close_inline("strong")
                } else if !is_selfclose {
                    self.open_inline("strong")
                }
            }
            "em" | "i" => {
                if is_close {
                    self.close_inline("em")
                } else if !is_selfclose {
                    self.open_inline("em")
                }
            }
            _ => {} // pre-close w/o open, span, a, sup, sub, code, img (void) — no-op
        }
    }
    fn finish(mut self) -> ExtractedSection {
        let trimmed = self.out.trim_end();
        let len_u16 = trimmed.encode_utf16().count() as u32;
        self.out.truncate(trimmed.len());
        // On a title page, a lone connective "and" line between two titles rides the
        // `subtitle` role (the frontend renders it as the italic connector). It is
        // decided here, by text, because its content is unknown when the block opens.
        if self.kind == SectionKind::TitlePage {
            let units: Vec<u16> = self.out.encode_utf16().collect();
            for r in self.ranges.iter_mut() {
                if r.kind == "byline" || r.kind == "title" {
                    let (s, e) = (r.start as usize, (r.end as usize).min(units.len()));
                    if s < e {
                        if let Ok(text) = String::from_utf16(&units[s..e]) {
                            if text.trim().eq_ignore_ascii_case("and") {
                                r.kind = "subtitle".into();
                            }
                        }
                    }
                }
            }
        }
        let ranges: Vec<StyleRange> = self
            .ranges
            .into_iter()
            .filter_map(|mut r| {
                r.end = r.end.min(len_u16);
                if r.end > r.start {
                    Some(r)
                } else {
                    None
                }
            })
            .collect();
        ExtractedSection {
            text: self.out,
            ranges,
        }
    }
}

/// If the XHTML's structural root (`<body>`/`<section>`) carries an authoritative
/// EPUB3 `epub:type` landmark, return the section kind it implies. Only the
/// page-defining landmarks promote a section here; finer inline `epub:type`s
/// (`title`, `subtitle`, …) are handled per-block during extraction. Scans only
/// the document prefix (the body tag appears early), so it stays cheap.
fn promote_kind_from_epubtype(html: &str) -> Option<SectionKind> {
    let lower = html.to_ascii_lowercase();
    // Limit to a prefix: the <body>/landmark tag is near the top; this also avoids
    // matching an `epub:type="title"` on some inline element deep in the prose.
    let scan = &lower[..lower.len().min(4096)];
    if !scan.contains("epub:type=") {
        return None;
    }
    // Order matters: titlepage before a generic "title".
    if scan.contains("\"titlepage\"")
        || scan.contains("'titlepage'")
        || scan.contains("titlepage ")
    {
        return Some(SectionKind::TitlePage);
    }
    if scan.contains("\"toc\"") || scan.contains("'toc'") || scan.contains(">toc<") {
        return Some(SectionKind::Toc);
    }
    if scan.contains("epigraph") {
        return Some(SectionKind::Epigraph);
    }
    None
}

/// Convert one spine item's XHTML into clean plain text plus offset-safe style
/// ranges, treating the document as plain prose (legacy h1–h6/blockquote/pre/em/
/// strong ranges only). Thin wrapper over [`extract_section_with_kind`] so all
/// existing callers/tests keep their exact behaviour.
pub fn extract_section(html: &str) -> ExtractedSection {
    extract_section_with_kind(html, SectionKind::Plain)
}

/// Convert one spine item's XHTML into clean plain text plus offset-safe style
/// ranges. A hand-rolled scanner (no XML parser) so it never errors on the HTML
/// named entities (`&nbsp;`, `&mdash;`, …) that strict XML parsers reject, and so
/// UTF-16 offsets can be tracked exactly as characters are emitted. Block
/// elements become blank-line-separated paragraphs (what `splitParagraphs` +
/// `sectionize` expect); script/style/head are skipped; images are dropped.
///
/// `kind` is the document's book-typesetting role (decided by the caller from the
/// EPUB's own semantics). It selects which NEW block roles may be emitted. A
/// body-level `epub:type` (`titlepage`/`toc`/`epigraph`) inside the XHTML can
/// PROMOTE a `Plain` document to the matching kind — the authoritative EPUB3
/// signal wins when the heuristic was silent.
pub fn extract_section_with_kind(html: &str, kind: SectionKind) -> ExtractedSection {
    let chars: Vec<char> = html.chars().collect();
    let n = chars.len();
    // Promote a Plain document if its body/root carries an authoritative
    // `epub:type` landmark. Cheap, case-insensitive substring scan of the prefix.
    let kind = if kind == SectionKind::Plain {
        promote_kind_from_epubtype(html).unwrap_or(kind)
    } else {
        kind
    };
    let mut ex = Extractor::new(kind);
    let starts_with = |i: usize, pat: &str| -> bool {
        let p: Vec<char> = pat.chars().collect();
        i + p.len() <= n && chars[i..i + p.len()] == p[..]
    };
    let find_from = |i: usize, pat: &str| -> Option<usize> {
        let p: Vec<char> = pat.chars().collect();
        if p.is_empty() || i >= n {
            return None;
        }
        (i..=n.saturating_sub(p.len())).find(|&j| chars[j..j + p.len()] == p[..])
    };
    // Case-insensitive search (for matching </script>/</style> closes).
    let find_ci = |i: usize, pat_lower: &str| -> Option<usize> {
        let p: Vec<char> = pat_lower.chars().collect();
        if p.is_empty() || i >= n {
            return None;
        }
        (i..=n.saturating_sub(p.len())).find(|&j| {
            chars[j..j + p.len()]
                .iter()
                .zip(&p)
                .all(|(c, pc)| c.to_ascii_lowercase() == *pc)
        })
    };
    let mut i = 0;
    while i < n {
        if chars[i] == '<' {
            if starts_with(i, "<!--") {
                i = find_from(i + 4, "-->").map(|j| j + 3).unwrap_or(n);
                continue;
            }
            if starts_with(i, "<![CDATA[") {
                let end = find_from(i + 9, "]]>").unwrap_or(n);
                let cdata: String = chars[i + 9..end.min(n)].iter().collect();
                ex.push_text(&cdata);
                i = if end < n { end + 3 } else { n };
                continue;
            }
            if i + 1 < n && (chars[i + 1] == '!' || chars[i + 1] == '?') {
                i = find_from(i + 1, ">").map(|j| j + 1).unwrap_or(n);
                continue;
            }
            // Ordinary tag: read to the next '>'.
            let close = find_from(i + 1, ">").unwrap_or(n);
            let raw: String = chars[i + 1..close.min(n)].iter().collect();
            let is_close = raw.starts_with('/');
            let is_selfclose = raw.trim_end().ends_with('/');
            let name: String = raw
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect::<String>()
                .to_ascii_lowercase();
            let after = if close < n { close + 1 } else { n };
            // script/style content is RAW (may contain '<', e.g. `x = 1 < 2`), so a
            // generic tag scan would mis-parse it. Skip straight to the matching
            // close tag instead of entering the per-char skip state.
            if !is_close && !is_selfclose && (name == "script" || name == "style") {
                let needle = format!("</{name}");
                i = match find_ci(after, &needle) {
                    Some(k) => find_from(k, ">").map(|g| g + 1).unwrap_or(n),
                    None => n,
                };
                continue;
            }
            if !name.is_empty() {
                let raw_lower = raw.to_ascii_lowercase();
                let class = if raw_lower.contains("class=") {
                    class_of(&raw)
                } else {
                    String::new()
                };
                // `epub:type` is only consulted for roled sections (the kind is
                // anything but Plain) and only on opening tags — skip the parse
                // otherwise so legacy extraction stays exactly as fast.
                let etype = if !is_close && raw_lower.contains("epub:type=") {
                    epubtype_of(&raw)
                } else {
                    String::new()
                };
                ex.handle_tag(&name, &class, &etype, is_close, is_selfclose);
            }
            i = after;
        } else {
            let next = find_from(i, "<").unwrap_or(n);
            let run: String = chars[i..next].iter().collect();
            ex.push_text(&decode_entities(&run));
            i = next;
        }
    }
    ex.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn text_of(html: &str) -> String {
        extract_section(html).text
    }

    /// Write a minimal zip containing exactly `members` (each an empty stored
    /// entry) to a unique temp path and return that path. Mirrors how a real EPUB
    /// carries its META-INF markers, without needing a fixture file.
    fn write_zip_with(members: &[&str]) -> std::path::PathBuf {
        use zip::write::SimpleFileOptions;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for name in members {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(b"").unwrap();
            }
            zip.finish().unwrap();
        }
        let path = std::env::temp_dir().join(format!(
            "throughline_drm_test_{}.zip",
            Uuid::new_v4().simple()
        ));
        fs::write(&path, buf.into_inner()).unwrap();
        path
    }

    #[test]
    fn drm_detected_for_encryption_rights_both_and_not_for_neither() {
        // The bug: a rights.xml-only EPUB was a false negative because the old
        // code discarded the OR flag and only re-checked encryption.xml.
        let enc = write_zip_with(&["mimetype", "META-INF/encryption.xml"]);
        let rights = write_zip_with(&["mimetype", "META-INF/rights.xml"]);
        let both = write_zip_with(&["META-INF/encryption.xml", "META-INF/rights.xml"]);
        let neither = write_zip_with(&["mimetype", "META-INF/container.xml"]);

        assert!(
            looks_drm_protected(&enc).unwrap(),
            "encryption.xml-only must be DRM"
        );
        assert!(
            looks_drm_protected(&rights).unwrap(),
            "rights.xml-only must be DRM"
        );
        assert!(
            looks_drm_protected(&both).unwrap(),
            "both markers must be DRM"
        );
        assert!(
            !looks_drm_protected(&neither).unwrap(),
            "no markers must not be DRM"
        );

        for p in [enc, rights, both, neither] {
            let _ = fs::remove_file(p);
        }
    }

    #[test]
    fn extracts_paragraphs_with_blank_line_separators() {
        let s = extract_section("<p>Hello world</p><p>Second para</p>");
        assert_eq!(s.text, "Hello world\n\nSecond para");
        assert!(s.ranges.is_empty());
    }

    #[test]
    fn collapses_whitespace_and_strips_tag_attributes() {
        assert_eq!(
            text_of("<p class=\"x\">Hello\n\n   world</p>"),
            "Hello world"
        );
    }

    #[test]
    fn skips_script_style_and_drops_images() {
        assert_eq!(
            text_of("<div><style>p{color:red}</style><script>var x=1<2;</script><p>Read<img src=\"a.png\"/> me</p></div>"),
            "Read me"
        );
        assert_eq!(text_of("<div><br/><img src=\"a.png\"/></div>"), "");
        assert_eq!(text_of(""), "");
    }

    #[test]
    fn decodes_html_named_and_numeric_entities() {
        assert_eq!(
            text_of("<p>Tom &amp; Jerry &mdash; &#8220;hi&#x2019;&nbsp;there</p>"),
            "Tom & Jerry — “hi’ there"
        );
        // A soft hyphen entity is decoded then dropped (no invisible break).
        assert_eq!(text_of("<p>encyclo&shy;pedia</p>"), "encyclopedia");
    }

    #[test]
    fn records_heading_range_over_its_paragraph() {
        let s = extract_section("<h2>Chapter One</h2><p>Body text here.</p>");
        assert_eq!(s.text, "Chapter One\n\nBody text here.");
        let h = s.ranges.iter().find(|r| r.kind == "h2").expect("h2 range");
        assert_eq!(
            (h.start, h.end),
            (0, "Chapter One".encode_utf16().count() as u32)
        );
    }

    #[test]
    fn records_inline_emphasis_ranges_in_utf16_units() {
        let s = extract_section("<p>The marathon demands <em>respect</em> always.</p>");
        assert_eq!(s.text, "The marathon demands respect always.");
        let em = s.ranges.iter().find(|r| r.kind == "em").expect("em range");
        let start = "The marathon demands ".encode_utf16().count() as u32;
        let end = "The marathon demands respect".encode_utf16().count() as u32;
        assert_eq!((em.start, em.end), (start, end));
        // The styled substring is exactly "respect".
        let utf16: Vec<u16> = s.text.encode_utf16().collect();
        let slice = String::from_utf16(&utf16[em.start as usize..em.end as usize]).unwrap();
        assert_eq!(slice, "respect");
    }

    #[test]
    fn maps_b_to_strong_and_i_to_em() {
        let s = extract_section("<p><b>bold</b> and <i>ital</i></p>");
        assert!(s
            .ranges
            .iter()
            .any(|r| r.kind == "strong" && r.start == 0 && r.end == 4));
        assert!(s.ranges.iter().any(|r| r.kind == "em"));
    }

    #[test]
    fn no_trailing_or_leading_blank_lines() {
        let s = extract_section("\n  <div>\n  <p>  Only para  </p>\n  </div>\n");
        assert_eq!(s.text, "Only para");
    }

    #[test]
    fn pre_block_preserves_indentation_and_newlines_as_one_code_block() {
        let html = "<p>Before.</p><pre>fn main() {\n    println!(\"hi\");\n}</pre><p>After.</p>";
        let s = extract_section(html);
        // The <pre> becomes ONE block with its newlines + indentation intact.
        assert!(
            s.text.contains("fn main() {\n    println!(\"hi\");\n}"),
            "got: {:?}",
            s.text
        );
        // It's surrounded by blank lines (its own paragraph) and tagged "pre".
        assert!(s.text.starts_with("Before.\n\n"));
        assert!(s.text.ends_with("\n\nAfter."));
        let code = s
            .ranges
            .iter()
            .find(|r| r.kind == "pre")
            .expect("pre range");
        let utf16: Vec<u16> = s.text.encode_utf16().collect();
        let slice = String::from_utf16(&utf16[code.start as usize..code.end as usize]).unwrap();
        assert_eq!(slice, "fn main() {\n    println!(\"hi\");\n}");
    }

    #[test]
    fn table_code_listing_becomes_single_spaced_lines_gutter_stripped() {
        // The Pragmatic format Release It! uses: a table where each row is a code
        // line, with a line-number gutter cell and keywords in <strong class="kw">.
        let html = "<table class=\"processedcode\">\
            <tr><td class=\"codeinfo\"><span class=\"codeprefix\">&#160;</span></td>\
                <td class=\"codeline\">\u{200b}<strong class=\"kw\">public</strong> class Foo {</td></tr>\
            <tr><td class=\"codeinfo\"><span class=\"codeprefix\">&#160;</span></td>\
                <td class=\"codeline\">int x = 1;</td></tr>\
            <tr><td class=\"codeinfo\"></td><td class=\"codeline\">}</td></tr>\
            </table>";
        let s = extract_section(html);
        // Single-spaced (no blank line between code lines), gutter nbsp dropped,
        // keyword text kept but NOT bolded (no emphasis range inside code).
        assert_eq!(s.text, "public class Foo {\nint x = 1;\n}");
        assert!(
            s.ranges.iter().any(|r| r.kind == "pre"),
            "table code → a pre range"
        );
        assert!(
            !s.ranges.iter().any(|r| r.kind == "strong"),
            "code keywords must not become bold"
        );
    }

    #[test]
    fn section_byte_offsets_slice_exactly_with_multibyte_text() {
        // Sections concatenated into one body must slice back out EXACTLY by their
        // BYTE offsets (the reader's slicer is byte-indexed). This is the bug the
        // review flagged: char-count offsets would mis-slice any non-ASCII prose.
        let a = extract_section("<p>Café — a tÊst</p>").text;
        let b = extract_section("<p>Naïve déjà vu, résumé.</p>").text;
        let mut body = String::new();
        body.push_str(&a);
        let (a_s, a_e) = (0usize, body.len());
        body.push_str("\n\n");
        let b_s = body.len();
        body.push_str(&b);
        let b_e = body.len();
        // Byte slicing (what slice_body does) returns each section verbatim.
        assert_eq!(&body[a_s..a_e], a);
        assert_eq!(&body[b_s..b_e], b);
        // Guard: these strings really are multibyte (byte len > char count), so the
        // test would FAIL if offsets were ever computed as char counts.
        assert!(a.len() > a.chars().count(), "test text must be multibyte");
        assert!(b.len() > b.chars().count(), "test text must be multibyte");
    }

    #[test]
    fn estimated_units_track_real_prose_length() {
        let html = "<html><body><p>The quick brown fox jumps over the lazy dog.</p></body></html>";
        let n = extract_section(html).text.chars().count();
        assert_eq!(
            n,
            "The quick brown fox jumps over the lazy dog."
                .chars()
                .count()
        );
        assert_eq!(crate::import::estimate_minutes_for_chars(n), 1);
    }

    // ---- book-typography role emission (the new vocabulary) ----

    /// Slice the exact substring a range spans, in UTF-16 units (what the reader
    /// measures in). Asserts the range really covers that text and nothing else.
    fn role_slice(s: &ExtractedSection, kind: &str) -> (String, u32, u32) {
        let r = s
            .ranges
            .iter()
            .find(|r| r.kind == kind)
            .unwrap_or_else(|| panic!("expected a {kind} range; got {:?}", s.ranges));
        let units: Vec<u16> = s.text.encode_utf16().collect();
        let text = String::from_utf16(&units[r.start as usize..r.end as usize]).unwrap();
        (text, r.start, r.end)
    }

    #[test]
    fn title_page_emits_title_subtitle_byline_slicing_exactly() {
        // A Walden-style title page: main title, the italic "and" connector, a
        // secondary title, then the author line — front matter (kind = TitlePage).
        let html = "<section epub:type=\"titlepage\">\
            <h1 epub:type=\"title\">WALDEN</h1>\
            <p class=\"and\">and</p>\
            <h2 epub:type=\"subtitle\">ON THE DUTY OF CIVIL DISOBEDIENCE</h2>\
            <p epub:type=\"author\">by Henry David Thoreau</p>\
            </section>";
        let s = extract_section_with_kind(html, SectionKind::TitlePage);
        assert_eq!(
            s.text,
            "WALDEN\n\nand\n\nON THE DUTY OF CIVIL DISOBEDIENCE\n\nby Henry David Thoreau"
        );
        assert_eq!(role_slice(&s, "title").0, "WALDEN");
        assert_eq!(role_slice(&s, "byline").0, "by Henry David Thoreau");
        // Both the explicit secondary title AND the lone "and" connector ride
        // `subtitle`; assert the connector specifically is present.
        let units: Vec<u16> = s.text.encode_utf16().collect();
        let subtitles: Vec<String> = s
            .ranges
            .iter()
            .filter(|r| r.kind == "subtitle")
            .map(|r| String::from_utf16(&units[r.start as usize..r.end as usize]).unwrap())
            .collect();
        assert!(
            subtitles.iter().any(|t| t == "and"),
            "the connector rides subtitle"
        );
        assert!(
            subtitles
                .iter()
                .any(|t| t == "ON THE DUTY OF CIVIL DISOBEDIENCE"),
            "the secondary title rides subtitle"
        );
    }

    #[test]
    fn title_page_without_epubtype_uses_heading_and_class_hints() {
        // EPUB2 / no epub:type: the first heading is the title, a class-tagged
        // subtitle is the subtitle, a bare <p> after the title is the byline.
        let html = "<div><h1>Walden</h1><h2 class=\"subtitle\">Life in the Woods</h2>\
            <p>by Henry David Thoreau</p></div>";
        let s = extract_section_with_kind(html, SectionKind::TitlePage);
        assert_eq!(role_slice(&s, "title").0, "Walden");
        assert_eq!(role_slice(&s, "subtitle").0, "Life in the Woods");
        assert_eq!(role_slice(&s, "byline").0, "by Henry David Thoreau");
    }

    #[test]
    fn toc_emits_contents_label_and_one_item_per_entry() {
        // A nav document: the "Contents" heading + a list of chapter entries.
        let html = "<nav epub:type=\"toc\"><h1>Contents</h1>\
            <ol><li><a href=\"c1.xhtml\">Economy</a></li>\
            <li><a href=\"c2.xhtml\">Where I Lived</a></li>\
            <li><a href=\"c3.xhtml\">Reading</a></li></ol></nav>";
        let s = extract_section_with_kind(html, SectionKind::Toc);
        assert_eq!(role_slice(&s, "contents-label").0, "Contents");
        let items: Vec<&StyleRange> =
            s.ranges.iter().filter(|r| r.kind == "contents-item").collect();
        assert_eq!(items.len(), 3, "one contents-item per entry; got {:?}", s.ranges);
        let units: Vec<u16> = s.text.encode_utf16().collect();
        let texts: Vec<String> = items
            .iter()
            .map(|r| String::from_utf16(&units[r.start as usize..r.end as usize]).unwrap())
            .collect();
        assert_eq!(texts, vec!["Economy", "Where I Lived", "Reading"]);
    }

    #[test]
    fn toc_emits_contents_part_groupings() {
        let html = "<nav epub:type=\"toc\"><h1>Contents</h1>\
            <p epub:type=\"part\">Walden</p>\
            <ul><li>Economy</li><li>Reading</li></ul>\
            <p class=\"toc-part\">On the Duty of Civil Disobedience</p>\
            <ul><li>Resistance to Civil Government</li></ul></nav>";
        let s = extract_section_with_kind(html, SectionKind::Toc);
        let parts: Vec<String> = {
            let units: Vec<u16> = s.text.encode_utf16().collect();
            s.ranges
                .iter()
                .filter(|r| r.kind == "contents-part")
                .map(|r| String::from_utf16(&units[r.start as usize..r.end as usize]).unwrap())
                .collect()
        };
        assert_eq!(
            parts,
            vec!["Walden", "On the Duty of Civil Disobedience"]
        );
        assert_eq!(
            s.ranges.iter().filter(|r| r.kind == "contents-item").count(),
            3
        );
    }

    #[test]
    fn epigraph_page_emits_epigraph_range() {
        let html = "<section epub:type=\"epigraph\"><blockquote>\
            I went to the woods because I wished to live deliberately.\
            </blockquote></section>";
        let s = extract_section_with_kind(html, SectionKind::Epigraph);
        assert_eq!(
            role_slice(&s, "epigraph").0,
            "I went to the woods because I wished to live deliberately."
        );
        // Must NOT also carry a legacy blockquote range for the same text.
        assert!(
            !s.ranges.iter().any(|r| r.kind == "blockquote"),
            "epigraph supersedes the legacy blockquote role"
        );
    }

    #[test]
    fn chapter_emits_chapter_title_and_body_first_offsets_exact() {
        // The handoff's canonical example: <h1>Economy</h1><p>first…</p><p>second…</p>.
        let html = "<h1>Economy</h1>\
            <p>When I wrote the following pages, I lived alone.</p>\
            <p>The second paragraph continues the thought.</p>";
        let s = extract_section_with_kind(html, SectionKind::Chapter);
        assert_eq!(
            s.text,
            "Economy\n\nWhen I wrote the following pages, I lived alone.\n\n\
             The second paragraph continues the thought."
        );
        // chapter-title spans exactly "Economy", from offset 0.
        let (title, ts, te) = role_slice(&s, "chapter-title");
        assert_eq!(title, "Economy");
        assert_eq!((ts, te), (0, "Economy".encode_utf16().count() as u32));
        // body-first spans exactly the FIRST prose paragraph, in UTF-16 units.
        let (first, bs, be) = role_slice(&s, "body-first");
        assert_eq!(first, "When I wrote the following pages, I lived alone.");
        let expect_start =
            "Economy\n\n".encode_utf16().count() as u32;
        assert_eq!(bs, expect_start);
        assert_eq!(
            be - bs,
            "When I wrote the following pages, I lived alone."
                .encode_utf16()
                .count() as u32
        );
        // Only the FIRST paragraph is body-first; the second stays plain.
        assert_eq!(s.ranges.iter().filter(|r| r.kind == "body-first").count(), 1);
    }

    #[test]
    fn chapter_emits_chapter_label_above_title() {
        let html = "<p epub:type=\"label\">BOOK I</p>\
            <h1>Economy</h1>\
            <p>First prose paragraph here.</p>";
        let s = extract_section_with_kind(html, SectionKind::Chapter);
        assert_eq!(role_slice(&s, "chapter-label").0, "BOOK I");
        assert_eq!(role_slice(&s, "chapter-title").0, "Economy");
        assert_eq!(role_slice(&s, "body-first").0, "First prose paragraph here.");
    }

    #[test]
    fn chapter_interior_headings_stay_legacy() {
        // Only the opening heading is chapter-title; a deeper heading stays h2.
        let html = "<h1>Economy</h1><p>First.</p><h2>A subsection</h2><p>More.</p>";
        let s = extract_section_with_kind(html, SectionKind::Chapter);
        assert_eq!(role_slice(&s, "chapter-title").0, "Economy");
        assert_eq!(role_slice(&s, "h2").0, "A subsection");
        // body-first is the first paragraph, not the one after the interior heading.
        assert_eq!(role_slice(&s, "body-first").0, "First.");
        assert_eq!(s.ranges.iter().filter(|r| r.kind == "body-first").count(), 1);
    }

    #[test]
    fn body_level_epubtype_promotes_a_plain_section() {
        // A document handed to us as Plain (heuristic was silent) but whose body
        // declares the authoritative landmark must still typeset correctly.
        let html = "<html><body epub:type=\"titlepage\">\
            <h1 epub:type=\"title\">WALDEN</h1>\
            <p epub:type=\"author\">by Henry David Thoreau</p></body></html>";
        let s = extract_section_with_kind(html, SectionKind::Plain);
        assert_eq!(role_slice(&s, "title").0, "WALDEN");
        assert_eq!(role_slice(&s, "byline").0, "by Henry David Thoreau");
    }

    #[test]
    fn plain_section_emits_only_legacy_ranges() {
        // Backward-compat spine: a Plain document with a heading + emphasis yields
        // the SAME ranges as before (no new roles leak in).
        let html = "<h1>Copyright</h1><p>All rights <em>reserved</em>.</p>";
        let plain = extract_section_with_kind(html, SectionKind::Plain);
        let legacy = extract_section(html); // public wrapper, must match
        assert_eq!(plain.text, legacy.text);
        assert_eq!(plain.ranges, legacy.ranges);
        assert!(plain.ranges.iter().any(|r| r.kind == "h1"));
        assert!(plain.ranges.iter().any(|r| r.kind == "em"));
        assert!(
            !plain
                .ranges
                .iter()
                .any(|r| matches!(r.kind.as_str(), "title" | "chapter-title" | "body-first")),
            "no new roles in a Plain section"
        );
    }

    #[test]
    fn roles_preserve_text_and_offsets_with_multibyte() {
        // A role must never mutate the section text or its byte length — the body
        // slicer and note anchoring depend on it. Multibyte title proves offsets
        // are UTF-16 units, not byte or char counts.
        let html = "<h1>Économie</h1><p>Première phrase « ici ».</p>";
        let s = extract_section_with_kind(html, SectionKind::Chapter);
        assert_eq!(s.text, "Économie\n\nPremière phrase « ici ».");
        let (title, ts, te) = role_slice(&s, "chapter-title");
        assert_eq!(title, "Économie");
        assert_eq!((ts, te), (0, "Économie".encode_utf16().count() as u32));
        let (first, _, _) = role_slice(&s, "body-first");
        assert_eq!(first, "Première phrase « ici ».");
    }

    #[test]
    fn section_kind_for_classifies_by_signals() {
        let chapter = SpineEntry {
            idref: "chapter_1".into(),
            label: "Economy".into(),
            href: "ch1.xhtml".into(),
            assignable: true,
        };
        assert_eq!(section_kind_for(&chapter, None), SectionKind::Chapter);

        let title = SpineEntry {
            idref: "titlepage".into(),
            label: "Title Page".into(),
            href: "title.xhtml".into(),
            assignable: false,
        };
        assert_eq!(section_kind_for(&title, None), SectionKind::TitlePage);

        let toc_label = SpineEntry {
            idref: "toc".into(),
            label: "Contents".into(),
            href: "contents.xhtml".into(),
            assignable: false,
        };
        assert_eq!(section_kind_for(&toc_label, None), SectionKind::Toc);

        // The nav document is recognised by href even with no "contents" label.
        let nav = SpineEntry {
            idref: "nav".into(),
            label: "Navigation".into(),
            href: "nav.xhtml".into(),
            assignable: false,
        };
        assert_eq!(
            section_kind_for(&nav, Some("nav.xhtml")),
            SectionKind::Toc
        );

        let epi = SpineEntry {
            idref: "epigraph".into(),
            label: "Epigraph".into(),
            href: "epi.xhtml".into(),
            assignable: false,
        };
        assert_eq!(section_kind_for(&epi, None), SectionKind::Epigraph);

        // Unrecognised front matter stays Plain (legacy ranges only).
        let copyright = SpineEntry {
            idref: "copyright".into(),
            label: "Copyright".into(),
            href: "copy.xhtml".into(),
            assignable: false,
        };
        assert_eq!(section_kind_for(&copyright, None), SectionKind::Plain);
    }

    #[test]
    fn attr_of_respects_token_boundaries() {
        // `epub:type=` must be found, but `someclass=` must NOT match `class=`.
        assert_eq!(attr_of("<p someclass=\"x\" class=\"real\">", "class="), "real");
        assert_eq!(
            epubtype_of("<h1 epub:type=\"title\" class=\"t\">"),
            "title"
        );
        // Absent → empty, never a panic.
        assert_eq!(epubtype_of("<p>"), "");
    }
}

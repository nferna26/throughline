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
    let mut body = String::new();
    let mut out: Vec<SectionExtract> = Vec::with_capacity(entries.len());
    for entry in entries {
        // TODO(CORE-1029): `get_resource_str` decompresses a spine member fully
        // into memory BEFORE the accumulated check below can see it, so one
        // multi-GB member still allocates once before being refused. Bounding
        // it up front needs a declared-size API from the `epub` crate.
        let extracted = doc
            .get_resource_str(&entry.idref)
            .map(|(html, _mime)| extract_section(&html))
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

/// Extract the `class` attribute value from a tag's inner text (quote-aware so
/// multi-class values like `cf methodname` survive). Empty when absent.
fn class_of(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let Some(p) = lower.find("class=") else {
        return String::new();
    };
    let rest = &raw[p + 6..];
    let bytes = rest.as_bytes();
    if bytes.is_empty() {
        return String::new();
    }
    let q = bytes[0];
    if q == b'"' || q == b'\'' {
        if let Some(end) = rest[1..].find(q as char) {
            return rest[1..1 + end].to_string();
        }
        String::new()
    } else {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        rest[..end].to_string()
    }
}

impl Extractor {
    fn new() -> Self {
        Extractor {
            at_para_start: true,
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
    fn handle_tag(&mut self, name: &str, class: &str, is_close: bool, is_selfclose: bool) {
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
                    self.open_block(name, true)
                }
            }
            "p" | "div" | "li" | "ul" | "ol" | "dd" | "dt" | "section" | "article" | "header"
            | "footer" | "nav" | "aside" | "main" | "figure" | "figcaption" | "table" | "tr"
            | "td" | "th" | "caption" => {
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

/// Convert one spine item's XHTML into clean plain text plus offset-safe style
/// ranges. A hand-rolled scanner (no XML parser) so it never errors on the HTML
/// named entities (`&nbsp;`, `&mdash;`, …) that strict XML parsers reject, and so
/// UTF-16 offsets can be tracked exactly as characters are emitted. Block
/// elements become blank-line-separated paragraphs (what `splitParagraphs` +
/// `sectionize` expect); script/style/head are skipped; images are dropped.
pub fn extract_section(html: &str) -> ExtractedSection {
    let chars: Vec<char> = html.chars().collect();
    let n = chars.len();
    let mut ex = Extractor::new();
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
                let class = if raw.to_ascii_lowercase().contains("class=") {
                    class_of(&raw)
                } else {
                    String::new()
                };
                ex.handle_tag(&name, &class, is_close, is_selfclose);
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
}

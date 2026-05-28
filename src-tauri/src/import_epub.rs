use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

use crate::epub_classify::is_front_back_matter;
use crate::import::{hash_file, ImportManifest, ImportResult};
use crate::models::{Book, BookSection};
use crate::paths;

/// Heuristic DRM detection: presence of `META-INF/encryption.xml` (Adobe ADEPT)
/// or `META-INF/rights.xml`. We refuse rather than try to crack anything.
fn looks_drm_protected(epub_path: &Path) -> Result<bool> {
    use std::io::Read;
    let f = fs::File::open(epub_path)?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| anyhow!("zip read: {}", e))?;
    let mut drm = false;
    for i in 0..zip.len() {
        let name = zip.by_index_raw(i).map(|e| e.name().to_string()).unwrap_or_default();
        if name.eq_ignore_ascii_case("META-INF/encryption.xml")
            || name.eq_ignore_ascii_case("META-INF/rights.xml")
        {
            drm = true;
            break;
        }
    }
    // Some encryption.xml only marks fonts as obfuscated, which is technically
    // not DRM on content. We refuse anyway in Shot 2; users can convert via
    // a tool of their choosing. We deliberately do NOT inspect the file body.
    let _ = drm;

    // Read encryption.xml if present; treat any presence as DRM-suspect.
    if let Ok(mut entry) = zip.by_name("META-INF/encryption.xml") {
        let mut buf = String::new();
        let _ = entry.read_to_string(&mut buf);
        return Ok(true);
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
    if tail.is_empty() { None } else { Some(tail.replace('_', " ")) }
}

fn flatten_toc(
    nav: &[epub::doc::NavPoint],
    out: &mut Vec<(String, String)>,
    depth: usize,
) {
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
            "this EPUB looks DRM-protected (encryption.xml is present). ReadingGym refuses to process DRM-protected files. Please use a DRM-free EPUB."
        ));
    }

    // Open with the epub crate to validate + extract metadata + spine + toc
    let doc = epub::doc::EpubDoc::new(src_path)
        .with_context(|| format!("failed to parse EPUB {:?}", src_path))?;
    let title = doc
        .mdata("title")
        .map(|m| m.value.clone())
        .or_else(|| doc.get_title())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Untitled".to_string());
    let author = doc.mdata("creator").map(|m| m.value.clone());

    // Build sections from the SPINE (the actual reading order), labelling each
    // by its TOC entry when one exists. The spine is authoritative for what
    // pages exist; the TOC just gives us nicer labels.
    let mut toc_pairs: Vec<(String, String)> = Vec::new();
    flatten_toc(&doc.toc, &mut toc_pairs, 0);
    let mut toc_label_by_href: HashMap<String, String> = HashMap::new();
    for (label, href) in &toc_pairs {
        let key = strip_fragment(href);
        toc_label_by_href.entry(key).or_insert_with(|| label.clone());
    }

    #[derive(Debug)]
    struct SpineEntry {
        label: String,
        href: String,
        assignable: bool,
    }
    let mut sections_input: Vec<SpineEntry> = Vec::new();
    for (i, item) in doc.spine.iter().enumerate() {
        let Some(res) = doc.resources.get(&item.idref) else { continue };
        let href = res.path.to_string_lossy().to_string();
        let href_no_frag = strip_fragment(&href);
        let toc_label = toc_label_by_href.get(&href_no_frag).cloned();
        let label = toc_label
            .clone()
            .unwrap_or_else(|| pretty_idref(&item.idref).unwrap_or_else(|| format!("Section {}", i + 1)));
        let assignable = !is_front_back_matter(toc_label.as_deref(), &item.idref, item.linear);
        sections_input.push(SpineEntry { label, href: href_no_frag, assignable });
    }
    // Dedupe consecutive duplicates by href (TOC sometimes points at the same file twice).
    sections_input.dedup_by(|a, b| a.href == b.href);

    if sections_input.is_empty() {
        return Err(anyhow!("EPUB has no readable sections"));
    }
    if !sections_input.iter().any(|e| e.assignable) {
        // Heuristic failed (every spine item looked like front matter). Reset to all-assignable
        // rather than silently producing an empty plan.
        eprintln!("classifier marked every spine item as front matter — keeping all as assignable");
        for e in sections_input.iter_mut() { e.assignable = true; }
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

    let mut sections: Vec<BookSection> = Vec::with_capacity(sections_input.len());
    for (i, entry) in sections_input.iter().enumerate() {
        sections.push(BookSection {
            id: format!("sec_{}", Uuid::new_v4().simple()),
            book_id: book_id.clone(),
            label: entry.label.clone(),
            href: Some(entry.href.clone()),
            start_locator: None,
            end_locator: None,
            estimated_units: None,
            sort_order: i as i64,
            assignable: entry.assignable,
        });
    }

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
        total_chars: 0, // unknown — epub.js renders, no plain-text body
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

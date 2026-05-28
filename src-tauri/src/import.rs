use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use uuid::Uuid;

use crate::models::{Book, BookSection};
use crate::paths;

/// Approximate words-per-minute for "serious reading" pace
pub const WPM: i64 = 200;
/// Target section length in characters (~10–15 min reading)
pub const TARGET_SECTION_CHARS: usize = 9_000;

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportManifest {
    pub book_id: String,
    pub title: String,
    pub author: Option<String>,
    pub source_type: String,
    pub source_filename: String,
    pub source_sha256: String,
    pub imported_at: String,
    pub total_chars: usize,
    pub section_count: usize,
}

pub fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).with_context(|| format!("open {:?}", path))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Try to extract title/author from a Project Gutenberg header.
/// Returns (title, author, body_offset) where body_offset is the char index
/// where the actual book begins (after "*** START OF ..." line, if present).
pub fn extract_gutenberg_meta(text: &str) -> (Option<String>, Option<String>, usize) {
    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut body_offset: usize = 0;

    for line in text.lines().take(200) {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Title:") {
            title = Some(rest.trim().to_string());
        } else if let Some(rest) = l.strip_prefix("Author:") {
            author = Some(rest.trim().to_string());
        }
    }

    // Find body start
    if let Some(idx) = text.find("*** START OF") {
        if let Some(nl) = text[idx..].find('\n') {
            body_offset = idx + nl + 1;
        }
    }

    // Find body end (trim Gutenberg footer)
    (title, author, body_offset)
}

pub fn body_end_offset(text: &str) -> usize {
    if let Some(idx) = text.find("*** END OF") {
        idx
    } else {
        text.len()
    }
}

/// Split body text into sections.
/// First try chapter detection (`^Chapter N`, `^CHAPTER N`, `Book N`, etc.).
/// Fall back to ~equal length chunks of TARGET_SECTION_CHARS.
pub fn sectionize(body: &str) -> Vec<(String, usize, usize)> {
    let chapters = detect_chapters(body);
    if chapters.len() >= 3 {
        return chapters;
    }
    chunk_evenly(body)
}

fn detect_chapters(body: &str) -> Vec<(String, usize, usize)> {
    let lines: Vec<(usize, &str)> = body
        .char_indices()
        .filter_map(|(i, c)| if c == '\n' { Some(i) } else { None })
        .scan(0usize, |start, end| {
            let s = *start;
            *start = end + 1;
            Some((s, &body[s..end]))
        })
        .collect();

    let mut chapter_indices: Vec<(usize, String)> = Vec::new();
    for (idx, line) in &lines {
        let l = line.trim();
        if is_chapter_heading(l) {
            chapter_indices.push((*idx, l.to_string()));
        }
    }

    if chapter_indices.is_empty() {
        return Vec::new();
    }

    let mut sections: Vec<(String, usize, usize)> = Vec::new();
    for i in 0..chapter_indices.len() {
        let (start, label) = &chapter_indices[i];
        let end = if i + 1 < chapter_indices.len() {
            chapter_indices[i + 1].0
        } else {
            body.len()
        };
        if end > *start {
            sections.push((label.clone(), *start, end));
        }
    }

    // If chapters are huge (>30k chars), split them further to keep daily reading reasonable
    let mut refined: Vec<(String, usize, usize)> = Vec::new();
    for (label, s, e) in sections {
        let len = e - s;
        if len > TARGET_SECTION_CHARS * 3 {
            let parts = (len + TARGET_SECTION_CHARS - 1) / TARGET_SECTION_CHARS;
            let part_len = len / parts;
            for p in 0..parts {
                let ps = s + p * part_len;
                let pe = if p == parts - 1 { e } else { s + (p + 1) * part_len };
                refined.push((format!("{} — pt {}", label, p + 1), ps, pe));
            }
        } else {
            refined.push((label, s, e));
        }
    }
    refined
}

fn is_chapter_heading(line: &str) -> bool {
    if line.is_empty() || line.len() > 80 {
        return false;
    }
    let upper = line.to_uppercase();
    if upper.starts_with("CHAPTER ") || upper.starts_with("CHAP. ") {
        return true;
    }
    if upper.starts_with("BOOK ") && line.split_whitespace().count() <= 6 {
        return true;
    }
    // Roman-numeral only lines (common in Augustine)
    if is_roman_numeral_line(line) {
        return true;
    }
    false
}

fn is_roman_numeral_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.len() > 12 {
        return false;
    }
    t.chars().all(|c| matches!(c, 'I' | 'V' | 'X' | 'L' | 'C' | 'D' | 'M' | '.'))
        && t.chars().any(|c| c.is_ascii_alphabetic())
}

fn chunk_evenly(body: &str) -> Vec<(String, usize, usize)> {
    let len = body.len();
    if len == 0 {
        return Vec::new();
    }
    let n = ((len + TARGET_SECTION_CHARS - 1) / TARGET_SECTION_CHARS).max(1);
    let chunk = len / n;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let s = i * chunk;
        let e = if i == n - 1 { len } else { (i + 1) * chunk };
        // Snap to paragraph boundary if possible
        let snapped_end = snap_to_paragraph(body, e);
        out.push((format!("Part {}", i + 1), s, snapped_end));
    }
    out
}

fn snap_to_paragraph(body: &str, idx: usize) -> usize {
    let bytes = body.as_bytes();
    let max_skip = 500.min(bytes.len() - idx);
    for j in 0..max_skip {
        let pos = idx + j;
        if pos + 1 < bytes.len() && bytes[pos] == b'\n' && bytes[pos + 1] == b'\n' {
            return pos + 2;
        }
    }
    idx
}

pub struct ImportResult {
    pub book: Book,
    pub sections: Vec<BookSection>,
}

pub fn import_any(src_path: &Path) -> Result<ImportResult> {
    let ext = src_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "txt" => import_txt(src_path),
        "epub" => crate::import_epub::import_epub(src_path),
        other => Err(anyhow!("unsupported file type: .{} (supported: .txt, .epub)", other)),
    }
}

pub fn import_txt(src_path: &Path) -> Result<ImportResult> {
    paths::ensure_dirs()?;
    if !src_path.exists() {
        return Err(anyhow!("source file does not exist: {:?}", src_path));
    }
    let raw = fs::read_to_string(src_path).context("read source as utf-8")?;
    let (meta_title, meta_author, body_start) = extract_gutenberg_meta(&raw);
    let body_end = body_end_offset(&raw);
    let body = &raw[body_start..body_end];

    let title = meta_title.unwrap_or_else(|| {
        src_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string()
    });

    let book_id = format!("book_{}", Uuid::new_v4().simple());
    let book_dir = paths::book_dir(&book_id)?;
    fs::create_dir_all(&book_dir)?;
    let dest = book_dir.join("source.txt");
    fs::copy(src_path, &dest).context("copy source into app data")?;
    // Make read-only (immutability hint; honour with `chmod 444`)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest)?.permissions();
        perms.set_mode(0o444);
        let _ = fs::set_permissions(&dest, perms);
    }

    let sha = hash_file(&dest)?;

    // Sectionize
    let raw_sections = sectionize(body);
    let now = Utc::now().to_rfc3339();
    let mut sections: Vec<BookSection> = Vec::with_capacity(raw_sections.len());
    for (i, (label, s, e)) in raw_sections.iter().enumerate() {
        // locators are stored as char offsets into the body
        let id = format!("sec_{}", Uuid::new_v4().simple());
        sections.push(BookSection {
            id,
            book_id: book_id.clone(),
            label: label.clone(),
            href: None,
            start_locator: Some(s.to_string()),
            end_locator: Some(e.to_string()),
            estimated_units: Some((e - s) as i64),
            sort_order: i as i64,
            assignable: true,
        });
    }

    let manifest = ImportManifest {
        book_id: book_id.clone(),
        title: title.clone(),
        author: meta_author.clone(),
        source_type: "txt".to_string(),
        source_filename: src_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("source.txt")
            .to_string(),
        source_sha256: sha.clone(),
        imported_at: now.clone(),
        total_chars: body.len(),
        section_count: sections.len(),
    };
    fs::write(
        book_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    // Also save a body-offset marker so reader knows where book body begins in source.txt
    fs::write(
        book_dir.join("body_offsets.json"),
        serde_json::to_string(&serde_json::json!({
            "body_start": body_start,
            "body_end": body_end,
        }))?,
    )?;

    let book = Book {
        id: book_id,
        title,
        author: meta_author,
        source_type: "txt".to_string(),
        source_path: dest.to_string_lossy().to_string(),
        source_sha256: sha,
        created_at: now,
        last_opened_at: None,
    };
    Ok(ImportResult { book, sections })
}

pub fn estimate_minutes_for_chars(n: usize) -> i64 {
    // ~5 chars/word, 200 wpm
    let words = (n as f64) / 5.0;
    ((words / WPM as f64).ceil() as i64).max(1)
}

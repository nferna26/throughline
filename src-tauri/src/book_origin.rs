//! Per-book provenance + embedded-cover sidecar (filesystem, no schema change).
//!
//! Throughline keeps its OWN immutable copy of every book; the `books` table
//! records nothing about WHERE a book came from. The library surface needs that
//! distinction: a catalogue book is cheap to re-add (public domain,
//! re-downloadable), while an imported book's reading state is the real loss,
//! and only an imported book has an original file that can move. Rather than
//! migrate the `books` schema (an "ask first" change — the first paying reader's
//! `reading.db` is forever), each book carries a tiny `origin.json` beside its
//! `source.*` / `manifest.json` in the book dir — the same filesystem-sidecar
//! pattern the importer already uses, and cleaned up automatically by
//! `cmd_delete_book`'s `remove_dir_all`.
//!
//! An ABSENT sidecar (every book imported before this feature) reads as the
//! CONSERVATIVE default — "imported", original_path None — so the remove copy
//! never falsely promises a free catalogue re-add and a missing original never
//! raises a moved-file alarm for a book we can't prove came from a file.
//!
//! Privacy: `original_path` is a content-adjacent file path (CLAUDE.md
//! invariant 1, "usage not content") and must never reach any diagnostic
//! surface — callers log book_id only, never the path or the cover bytes.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::paths;

pub const IMPORTED: &str = "imported";
pub const CATALOGUE: &str = "catalogue";

/// Hard ceiling on an embedded cover we will hand to the webview, so a hostile
/// or pathological EPUB cannot balloon an IPC payload.
pub const MAX_COVER_BYTES: usize = 8 * 1024 * 1024;

/// Image formats we accept for an embedded cover, paired with the MIME the
/// `data:` URI must declare. Anything else falls back to the cloth treatment.
const COVER_FORMATS: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookOrigin {
    /// "imported" (the reader's own file) | "catalogue" (public-domain,
    /// re-downloadable). Drives the two Remove confirmations and the detail-view
    /// provenance line.
    pub provenance: String,
    /// The reader's ORIGINAL file path captured at import time (imported books
    /// only). The app never needs it to READ — Throughline holds its own copy —
    /// but it anchors the calm "moved file / Locate the file" re-link offer.
    #[serde(default)]
    pub original_path: Option<String>,
}

impl Default for BookOrigin {
    fn default() -> Self {
        // Conservative: an unknown book is treated as the reader's own import,
        // which never over-promises ("add it back free") and, with no
        // original_path, never raises a moved-file alarm.
        BookOrigin {
            provenance: IMPORTED.to_string(),
            original_path: None,
        }
    }
}

impl BookOrigin {
    pub fn imported(original_path: Option<String>) -> Self {
        BookOrigin {
            provenance: IMPORTED.to_string(),
            original_path,
        }
    }
    pub fn catalogue() -> Self {
        BookOrigin {
            provenance: CATALOGUE.to_string(),
            original_path: None,
        }
    }
    pub fn is_imported(&self) -> bool {
        self.provenance == IMPORTED
    }
}

fn origin_path(book_id: &str) -> anyhow::Result<std::path::PathBuf> {
    Ok(paths::book_dir(book_id)?.join("origin.json"))
}

/// Read a book's provenance sidecar, falling back to the conservative default
/// when the file is absent or unreadable (legacy books, partial writes).
pub fn read(book_id: &str) -> BookOrigin {
    let Ok(p) = origin_path(book_id) else {
        return BookOrigin::default();
    };
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BookOrigin::default(),
    }
}

/// Write (or overwrite) a book's provenance sidecar. Best-effort at the call
/// site: a failure here must never fail an import (the book still reads), it
/// only degrades to the conservative default at read time.
pub fn write(book_id: &str, origin: &BookOrigin) -> anyhow::Result<()> {
    let p = origin_path(book_id)?;
    std::fs::write(&p, serde_json::to_string_pretty(origin)?)?;
    Ok(())
}

/// Re-associate the reader's original file (the moved-file "Locate the file"
/// action). Keeps provenance; only updates the path. Never touches the file
/// itself — re-link is purely a future-re-export convenience.
pub fn set_original_path(book_id: &str, path: &str) -> anyhow::Result<()> {
    let mut o = read(book_id);
    o.original_path = Some(path.to_string());
    write(book_id, &o)
}

/// The extracted embedded cover file in the book dir, if one exists, paired
/// with its MIME type.
pub fn cover_file(book_id: &str) -> Option<(std::path::PathBuf, &'static str)> {
    let dir = paths::book_dir(book_id).ok()?;
    for (ext, mime) in COVER_FORMATS {
        let f = dir.join(format!("cover.{ext}"));
        if f.exists() {
            return Some((f, mime));
        }
    }
    None
}

/// Whether an embedded cover image was extracted for this book.
pub fn has_cover(book_id: &str) -> bool {
    cover_file(book_id).is_some()
}

/// The embedded cover as a base64 `data:` URI (the CSP allows `data:` images),
/// or None when absent/empty/oversized. The cover image is content-adjacent —
/// never log its bytes or its internal EPUB path.
pub fn cover_data_uri(book_id: &str) -> Option<String> {
    use base64::Engine as _;
    let (path, mime) = cover_file(book_id)?;
    let bytes = std::fs::read(&path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Map an embedded image's MIME to the cover filename extension we store it
/// under, or None for formats we don't surface (→ cloth fallback).
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// True when `path` is no longer present on disk — the moved/deleted-original
/// condition behind the calm "Still here, still readable" note.
pub fn original_missing(origin: &BookOrigin) -> bool {
    origin.is_imported()
        && origin
            .original_path
            .as_deref()
            .is_some_and(|p| !Path::new(p).exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    // app_support_dir() under cfg(test) resolves to a per-process temp dir, so
    // book_dir() writes are isolated and never touch a real book.
    fn fresh_book_id(tag: &str) -> String {
        let id = format!("book_origin_test_{tag}");
        let dir = paths::book_dir(&id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        // Start clean so re-runs in the same process don't see a stale sidecar.
        let _ = std::fs::remove_file(dir.join("origin.json"));
        for (ext, _) in COVER_FORMATS {
            let _ = std::fs::remove_file(dir.join(format!("cover.{ext}")));
        }
        id
    }

    #[test]
    fn absent_sidecar_is_conservative_imported() {
        let id = fresh_book_id("absent");
        let o = read(&id);
        assert_eq!(o.provenance, IMPORTED);
        assert!(o.original_path.is_none());
        assert!(
            !original_missing(&o),
            "no original_path means no moved-file alarm"
        );
    }

    #[test]
    fn imported_round_trips_with_original_path() {
        let id = fresh_book_id("imported");
        write(
            &id,
            &BookOrigin::imported(Some("/Users/me/Walden.epub".into())),
        )
        .unwrap();
        let o = read(&id);
        assert_eq!(o.provenance, IMPORTED);
        assert_eq!(o.original_path.as_deref(), Some("/Users/me/Walden.epub"));
        // The path doesn't exist → moved-file note should offer.
        assert!(original_missing(&o));
    }

    #[test]
    fn catalogue_never_reports_moved_file() {
        let id = fresh_book_id("catalogue");
        write(&id, &BookOrigin::catalogue()).unwrap();
        let o = read(&id);
        assert_eq!(o.provenance, CATALOGUE);
        assert!(o.original_path.is_none());
        assert!(!original_missing(&o));
    }

    #[test]
    fn relink_updates_path_keeps_provenance() {
        let id = fresh_book_id("relink");
        write(&id, &BookOrigin::imported(Some("/old/path.epub".into()))).unwrap();
        set_original_path(&id, "/new/path.epub").unwrap();
        let o = read(&id);
        assert_eq!(o.provenance, IMPORTED);
        assert_eq!(o.original_path.as_deref(), Some("/new/path.epub"));
    }

    #[test]
    fn cover_present_only_when_file_written() {
        let id = fresh_book_id("cover");
        assert!(!has_cover(&id));
        let dir = paths::book_dir(&id).unwrap();
        std::fs::write(dir.join("cover.png"), b"\x89PNG fake bytes").unwrap();
        assert!(has_cover(&id));
        let uri = cover_data_uri(&id).expect("cover present");
        assert!(uri.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn ext_for_mime_maps_known_only() {
        assert_eq!(ext_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(ext_for_mime("image/png; charset=binary"), Some("png"));
        assert_eq!(ext_for_mime("image/svg+xml"), None);
    }
}

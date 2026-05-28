use anyhow::Result;
use std::fs;
use std::path::PathBuf;

use crate::models::{Book, Note, ReadingSession};
use crate::paths;

const QUOTE_WARN_LIMIT: usize = 300;

pub fn quote_too_long(q: &str) -> bool {
    q.chars().count() > QUOTE_WARN_LIMIT
}

fn yaml_escape(s: &str) -> String {
    // Wrap in double quotes and escape backslashes + quotes.
    let escaped: String = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

fn ensure_export_dirs() -> Result<()> {
    let root = paths::default_export_root()?;
    for sub in ["Books", "Sessions", "Notes", "Reviews", "_indexes"] {
        fs::create_dir_all(root.join(sub))?;
    }
    Ok(())
}

pub fn note_filename(note: &Note) -> String {
    // Stable: book_id + note id (uuid) → re-export updates
    format!("{}_{}.md", note.book_id, note.id)
}

pub fn session_filename(session: &ReadingSession) -> String {
    format!("{}_{}.md", session.book_id, session.id)
}

pub fn book_filename(book: &Book) -> String {
    format!("{}.md", book.id)
}

pub fn export_note(book: &Book, note: &Note) -> Result<PathBuf> {
    ensure_export_dirs()?;
    let dest = paths::default_export_root()?.join("Notes").join(note_filename(note));

    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("type: reading_note\n"));
    out.push_str(&format!("book_id: {}\n", note.book_id));
    out.push_str(&format!("title: {}\n", yaml_escape(&book.title)));
    if let Some(a) = &book.author {
        out.push_str(&format!("author: {}\n", yaml_escape(a)));
    }
    out.push_str(&format!("source_sha256: {}\n", book.source_sha256));
    out.push_str("source_private: true\n");
    out.push_str(&format!("note_type: {}\n", note.note_type));
    out.push_str(&format!("locator: {}\n", yaml_escape(&note.locator)));
    if let Some(c) = &note.chapter_label {
        out.push_str(&format!("chapter: {}\n", yaml_escape(c)));
    }
    out.push_str(&format!("created: {}\n", note.created_at));
    out.push_str(&format!("updated: {}\n", note.updated_at));
    out.push_str("---\n\n");
    out.push_str(&note.body);
    out.push('\n');
    if let Some(q) = &note.short_quote {
        if !q.trim().is_empty() {
            out.push_str("\n> ");
            out.push_str(&q.replace('\n', "\n> "));
            out.push('\n');
        }
    }

    paths::atomic_write_string(&dest, &out)?;
    Ok(dest)
}

pub fn export_session(book: &Book, session: &ReadingSession, summary_sentence: Option<&str>) -> Result<PathBuf> {
    ensure_export_dirs()?;
    let dest = paths::default_export_root()?.join("Sessions").join(session_filename(session));
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("type: reading_session\n");
    out.push_str(&format!("book_id: {}\n", session.book_id));
    out.push_str(&format!("title: {}\n", yaml_escape(&book.title)));
    if let Some(a) = &book.author {
        out.push_str(&format!("author: {}\n", yaml_escape(a)));
    }
    out.push_str(&format!("source_sha256: {}\n", book.source_sha256));
    out.push_str("source_private: true\n");
    out.push_str(&format!("started_at: {}\n", session.started_at));
    if let Some(e) = &session.ended_at {
        out.push_str(&format!("ended_at: {}\n", e));
    }
    if let Some(m) = session.minutes {
        out.push_str(&format!("minutes: {}\n", m));
    }
    if let Some(s) = &session.start_locator {
        out.push_str(&format!("start_locator: {}\n", yaml_escape(s)));
    }
    if let Some(s) = &session.end_locator {
        out.push_str(&format!("end_locator: {}\n", yaml_escape(s)));
    }
    out.push_str(&format!("completed_assignment: {}\n", session.completed_assignment));
    out.push_str("---\n\n");
    if let Some(s) = summary_sentence {
        if !s.trim().is_empty() {
            out.push_str("## One sentence to remember\n\n");
            out.push_str(s);
            out.push_str("\n");
        }
    }
    paths::atomic_write_string(&dest, &out)?;
    Ok(dest)
}

pub fn export_book(book: &Book) -> Result<PathBuf> {
    ensure_export_dirs()?;
    let dest = paths::default_export_root()?.join("Books").join(book_filename(book));
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("type: reading_book\n");
    out.push_str(&format!("book_id: {}\n", book.id));
    out.push_str(&format!("title: {}\n", yaml_escape(&book.title)));
    if let Some(a) = &book.author {
        out.push_str(&format!("author: {}\n", yaml_escape(a)));
    }
    out.push_str(&format!("source_type: {}\n", book.source_type));
    out.push_str(&format!("source_sha256: {}\n", book.source_sha256));
    out.push_str("source_private: true\n");
    out.push_str(&format!("created: {}\n", book.created_at));
    out.push_str("---\n\n");
    out.push_str(&format!("# {}\n", book.title));
    if let Some(a) = &book.author {
        out.push_str(&format!("\n_{}_\n", a));
    }
    paths::atomic_write_string(&dest, &out)?;
    Ok(dest)
}

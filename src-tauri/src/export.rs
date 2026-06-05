use anyhow::Result;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{Book, Note, ReadingSession};
use crate::paths;

/// The effective Markdown export root: the user's configured path (Settings →
/// Export folder) if set, otherwise the default. Every export resolves the root
/// through here so the setting is actually honored — previously exports always
/// wrote to the default and ignored the configured folder.
pub fn root_for(conn: &Connection) -> PathBuf {
    crate::settings::get_export_path(conn)
        .or_else(|_| paths::default_export_root())
        .unwrap_or_else(|_| PathBuf::from("."))
}

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

fn ensure_export_dirs(root: &Path) -> Result<()> {
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

pub fn export_note(root: &Path, book: &Book, note: &Note) -> Result<PathBuf> {
    ensure_export_dirs(root)?;
    let dest = root.join("Notes").join(note_filename(note));

    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("type: reading_note\n");
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

pub fn export_session(
    root: &Path,
    book: &Book,
    session: &ReadingSession,
    summary_sentence: Option<&str>,
) -> Result<PathBuf> {
    ensure_export_dirs(root)?;
    let dest = root.join("Sessions").join(session_filename(session));
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
    out.push_str(&format!(
        "completed_assignment: {}\n",
        session.completed_assignment
    ));
    out.push_str("---\n\n");
    if let Some(s) = summary_sentence {
        if !s.trim().is_empty() {
            out.push_str("## One sentence to remember\n\n");
            out.push_str(s);
            out.push('\n');
        }
    }
    paths::atomic_write_string(&dest, &out)?;
    Ok(dest)
}

pub fn export_book(root: &Path, book: &Book) -> Result<PathBuf> {
    ensure_export_dirs(root)?;
    let dest = root.join("Books").join(book_filename(book));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Book, Note};

    fn book() -> Book {
        Book {
            id: "b1".into(),
            title: "The Confessions of St. Augustine".into(),
            author: Some("Augustine".into()),
            source_type: "txt".into(),
            source_path: "/x".into(),
            source_sha256: "sha-abc".into(),
            created_at: "2026-05-01".into(),
            last_opened_at: None,
        }
    }

    fn takeaway_note() -> Note {
        Note {
            id: "note_t1".into(),
            book_id: "b1".into(),
            session_id: Some("sess_1".into()),
            note_type: "Takeaway".into(),
            locator: "char:120".into(),
            chapter_label: Some("Book I".into()),
            body: "grace precedes effort".into(),
            short_quote: None,
            created_at: "2026-05-30T10:00:00Z".into(),
            updated_at: "2026-05-30T10:00:00Z".into(),
            exported_markdown_path: None,
            // A raw passage anchored in the DB — must NEVER reach the export.
            anchor_start: Some("char:120".into()),
            anchor_end: Some("char:168".into()),
            anchored_text: Some("the unjust man is happy and the just man miserable".into()),
        }
    }

    /// A Takeaway exports with an accurate note_type and the reader's own words,
    /// and NEVER leaks the raw anchored passage held in the DB. Runs against an
    /// isolated temp export dir so it never touches the real GBrain.
    /// A Takeaway exports with an accurate note_type and the reader's own words,
    /// and NEVER leaks the raw anchored passage held in the DB.
    #[test]
    fn takeaway_exports_typed_and_privacy_safe() {
        let export_dir =
            std::env::temp_dir().join(format!("tl-export-takeaway-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();

        let path = export_note(&export_dir, &book(), &takeaway_note()).expect("export takeaway");
        assert!(
            path.starts_with(&export_dir),
            "export must land under the given root: {path:?}"
        );
        let md = std::fs::read_to_string(&path).expect("export file exists");

        assert!(
            md.contains("note_type: Takeaway"),
            "note_type must be exported:\n{md}"
        );
        assert!(md.contains("source_private: true"));
        assert!(md.contains("grace precedes effort"));
        assert!(
            !md.contains("the unjust man is happy"),
            "the raw anchored passage must NOT be exported:\n{md}"
        );

        std::fs::remove_dir_all(&export_dir).ok();
    }

    #[test]
    fn question_exports_with_question_type() {
        let export_dir =
            std::env::temp_dir().join(format!("tl-export-question-{}", std::process::id()));
        std::fs::remove_dir_all(&export_dir).ok();
        std::fs::create_dir_all(&export_dir).unwrap();

        let mut n = takeaway_note();
        n.id = "note_q1".into();
        n.note_type = "Question".into();
        n.body = "can you seek what you do not know?".into();
        let path = export_note(&export_dir, &book(), &n).expect("export question");
        let md = std::fs::read_to_string(&path).expect("export file exists");
        assert!(md.contains("note_type: Question"));
        assert!(md.contains("can you seek what you do not know?"));
        assert!(
            !md.contains("the unjust man is happy"),
            "no raw passage leak"
        );

        std::fs::remove_dir_all(&export_dir).ok();
    }

    /// Regression for the export-folder no-op: the configured Settings path must
    /// be the root exports actually use — not the default.
    #[test]
    fn export_root_honors_the_configured_folder() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
            [],
        )
        .unwrap();
        let custom = std::env::temp_dir().join(format!("tl-export-custom-{}", std::process::id()));
        std::fs::remove_dir_all(&custom).ok();
        crate::settings::set_string(
            &conn,
            crate::settings::KEY_EXPORT_PATH,
            &custom.to_string_lossy(),
        )
        .unwrap();

        // The effective root is the configured folder…
        assert_eq!(
            root_for(&conn),
            custom,
            "root_for must return the configured path"
        );
        // …and a note actually lands there, not under the default.
        let path = export_note(&root_for(&conn), &book(), &takeaway_note()).expect("export");
        assert!(
            path.starts_with(&custom),
            "note must land under the configured folder: {path:?}"
        );

        std::fs::remove_dir_all(&custom).ok();
    }
}

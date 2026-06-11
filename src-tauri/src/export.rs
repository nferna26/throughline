use anyhow::Result;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::db_helpers::note_from_row;
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

/// Fair-use soft cap. A quote over this warns (`cmd_quote_warns`); an EXPORTED
/// book-text run (a highlight passage or a reader's short quote) is hard-capped
/// at this length — copyright invariant #5: no exported run of the book's own
/// words exceeds ~300 chars, so the full text is never reproduced.
const QUOTE_WARN_LIMIT: usize = 300;

pub fn quote_too_long(q: &str) -> bool {
    q.chars().count() > QUOTE_WARN_LIMIT
}

/// Hard-truncate a run of the BOOK's own words to the fair-use cap, appending an
/// ellipsis when clipped. This is the single enforcement point for copyright
/// invariant #5 — every highlight passage and reader short-quote that reaches an
/// export file passes through here, so no exported book-text run can exceed the
/// cap. Snaps to a char boundary (never mid-codepoint).
fn truncate_book_text(s: &str) -> String {
    if s.chars().count() > QUOTE_WARN_LIMIT {
        let head: String = s.chars().take(QUOTE_WARN_LIMIT).collect();
        format!("{head}…")
    } else {
        s.to_string()
    }
}

fn yaml_escape(s: &str) -> String {
    // Wrap in double quotes and escape backslashes + quotes.
    let escaped: String = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{}\"", escaped)
}

/// Create only the export subdirs the literature-note model uses. `Notes/`,
/// `Reviews/`, and `_indexes/` are deliberately gone — the per-note files and the
/// empty index/review trees were obsolete after the per-book literature note.
fn ensure_export_dirs(root: &Path) -> Result<()> {
    for sub in ["Books", "Sessions"] {
        fs::create_dir_all(root.join(sub))?;
    }
    Ok(())
}

pub fn session_filename(session: &ReadingSession) -> String {
    format!("{}_{}.md", session.book_id, session.id)
}

// ── Slug ───────────────────────────────────────────────────────────────────

/// Max length of the slug's title+author stem before any collision suffix, so a
/// pathological title can't produce an unwieldy filename.
const SLUG_MAX_LEN: usize = 80;

/// Characters Obsidian rejects in a note name / wikilink target, plus path and
/// control chars. Stripped from the slug so `[[wikilinks]]` to the file resolve.
fn is_slug_reject(c: char) -> bool {
    matches!(c, '@' | '#' | '^' | '[' | ']' | ':' | '|' | '/' | '\\')
        || c.is_control()
        || c == '\u{0}'
}

/// Lowercase-ASCII, hyphenated slug derived from the title plus a short author
/// token. Obsidian-illegal characters (`@ # ^ [ ] : | / \`), control chars, and
/// path separators are stripped; everything non-alphanumeric collapses to a
/// single hyphen; length is capped. Two DIFFERENT books that slug to the same
/// stem are disambiguated by `slug_for` (which appends a book-id suffix) — this
/// helper is the deterministic stem.
fn slug_stem(book: &Book) -> String {
    let mut raw = book.title.clone();
    if let Some(author) = book.author.as_deref() {
        // A short author token (first word) keeps two same-titled-different-author
        // books apart without bloating the filename.
        if let Some(first) = author.split_whitespace().next() {
            raw.push(' ');
            raw.push_str(first);
        }
    }

    let mut out = String::new();
    let mut prev_hyphen = false;
    for ch in raw.chars() {
        // Fold to lowercase ASCII; keep ascii alphanumerics, turn anything else —
        // spaces, punctuation, non-ASCII, AND Obsidian-illegal chars (`/`, `:`,
        // etc.) — into a single hyphen boundary. Treating rejects as a separator
        // (not silently dropping them) keeps "Bar/Baz" → "bar-baz", not "barbaz".
        let lowered = ch.to_ascii_lowercase();
        if !is_slug_reject(ch) && lowered.is_ascii_alphanumeric() {
            out.push(lowered);
            prev_hyphen = false;
        } else if !prev_hyphen {
            out.push('-');
            prev_hyphen = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let mut capped: String = trimmed.chars().take(SLUG_MAX_LEN).collect();
    // Trim a hyphen the cap may have landed on.
    while capped.ends_with('-') {
        capped.pop();
    }
    if capped.is_empty() {
        capped.push_str("book");
    }
    capped
}

/// The collision-safe slug for a book's literature-note file (without the `.md`).
/// Built from the title + short author token, then — because two different books
/// can legitimately share a title — disambiguated with a short suffix derived
/// from the book id, so two books NEVER share a file. Same book ⇒ same slug
/// (stable filename across re-exports).
pub fn slug_for(book: &Book) -> String {
    let stem = slug_stem(book);
    let suffix = book_id_suffix(&book.id);
    format!("{stem}-{suffix}")
}

/// A short, filesystem-safe disambiguator from the (uuid-ish) book id: its last
/// few alphanumerics, lowercased. Stable for a given id.
fn book_id_suffix(book_id: &str) -> String {
    let alnum: String = book_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let n = alnum.chars().count();
    let start = n.saturating_sub(6);
    let suffix: String = alnum.chars().skip(start).collect();
    if suffix.is_empty() {
        "id".to_string()
    } else {
        suffix
    }
}

/// `Books/{slug}.md` under `root`.
pub fn book_note_path(root: &Path, book: &Book) -> PathBuf {
    root.join("Books").join(format!("{}.md", slug_for(book)))
}

// ── Note rendering ─────────────────────────────────────────────────────────

/// The export id for a note's fence — the reader's STABLE note id (`note.id`,
/// a uuid) is what re-export keys on. `^tl-n-{id}` is the Obsidian block-id form.
fn note_export_id(note: &Note) -> String {
    format!("tl-n-{}", note.id)
}

/// Default chapter heading for notes that carry no `chapter_label`.
const DEFAULT_CHAPTER: &str = "Notes";

/// The reader-facing callout type + label for a note's `note_type`. NEVER emits
/// the raw DB enum text (e.g. "TutorNote") anywhere a reader sees — copyright /
/// experience bar. Returns `(obsidian_callout_kind, reader_label)`.
fn callout_for(note_type: &str) -> (&'static str, &'static str) {
    match note_type {
        "Highlight" => ("quote", "Highlight"),
        "MarginNote" | "Note" => ("note", "Note"),
        "TutorNote" | "SavedAICard" | "AI" => ("abstract", "Tutor"),
        "Takeaway" => ("success", "Takeaway"),
        "Question" => ("question", "Question"),
        _ => ("note", "Note"),
    }
}

/// The body text that EXPORTS for a note. Copyright invariant #5:
/// - A Highlight's content IS the highlighted passage (`anchored_text`),
///   hard-truncated to the fair-use cap — an exported highlight is never more
///   than a short quote. (Fixes the empty-highlight bug: previously a highlight
///   had no `body`, so it exported blank.)
/// - For EVERY other note type, `anchored_text` is NEVER written — the reader's
///   own words / the AI explanation (`note.body`) export instead. This keeps the
///   privacy guarantee that a Takeaway/MarginNote/Tutor note never leaks the raw
///   anchored passage held in the DB.
fn export_body_for(note: &Note) -> String {
    if note.note_type == "Highlight" {
        note.anchored_text
            .as_deref()
            .map(truncate_book_text)
            .unwrap_or_default()
    } else {
        note.body.clone()
    }
}

/// Render ONE note as its fenced, callout-wrapped, block-id-anchored unit:
///
/// ```text
/// <!-- tl:note id=tl-n-<uuid> type=<kind> -->
/// > [!quote] Highlight
/// > <content> ^tl-n-<uuid>
/// <!-- /tl:note -->
/// ```
///
/// The `^tl-n-<uuid>` block id lands at the END of the callout's last content
/// line so it resolves as an Obsidian link target. A non-empty reader short
/// quote (for non-highlights) renders as an extra `>` quote line, also hard-
/// truncated to the fair-use cap.
fn render_note_fence(note: &Note) -> String {
    let export_id = note_export_id(note);
    let (kind, label) = callout_for(&note.note_type);

    // Build the callout's content lines. Each entry is the text that follows the
    // callout's leading "> " — so an interior newline becomes its OWN entry,
    // keeping every rendered line a valid quote line (an un-prefixed continuation
    // line would break the Obsidian callout).
    let mut content_lines: Vec<String> = Vec::new();
    let body = export_body_for(note);
    for line in body.split('\n') {
        content_lines.push(line.to_string());
    }
    // A reader-chosen short quote rides along as a nested quote block for
    // non-highlights (a highlight already IS its quote). Truncated to the cap;
    // each of its interior lines is rendered as its own nested ("> > …") line.
    if note.note_type != "Highlight" {
        if let Some(q) = note.short_quote.as_deref() {
            if !q.trim().is_empty() {
                content_lines.push(String::new()); // blank line inside the callout
                let quoted = truncate_book_text(q.trim());
                for qline in quoted.split('\n') {
                    content_lines.push(format!("> {qline}"));
                }
            }
        }
    }
    if content_lines.is_empty() {
        content_lines.push(String::new());
    }

    let mut out = String::new();
    out.push_str(&format!(
        "<!-- tl:note id={export_id} type={} -->\n",
        note.note_type
    ));
    out.push_str(&format!("> [!{kind}] {label}\n"));
    let last = content_lines.len() - 1;
    for (i, line) in content_lines.iter().enumerate() {
        if i == last {
            // The block id goes at the END of the last content line so it resolves
            // as a link target.
            if line.is_empty() {
                out.push_str(&format!("> ^{export_id}\n"));
            } else {
                out.push_str(&format!("> {line} ^{export_id}\n"));
            }
        } else if line.is_empty() {
            out.push_str(">\n");
        } else {
            out.push_str(&format!("> {line}\n"));
        }
    }
    out.push_str("<!-- /tl:note -->");
    out
}

// ── Frontmatter ────────────────────────────────────────────────────────────

/// The app-OWNED frontmatter keys. On re-export we update exactly these and
/// preserve any user-added keys we don't own (copyright/UX invariant #3).
const OWNED_FRONTMATTER_KEYS: &[&str] = &[
    "title",
    "author",
    "type",
    "source_format",
    "source_sha256",
    "source_private",
    "throughline_book_id",
    "note_count",
    "last_export",
];

/// Render the flat, app-owned frontmatter block (no nested YAML). `now` is the
/// ISO timestamp the caller supplies (deterministic in tests — never `now()`
/// inside here). `extra` carries user-added keys to preserve verbatim, in order.
fn render_frontmatter(book: &Book, note_count: usize, now: &str, extra: &[(String, String)]) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", yaml_escape(&book.title)));
    out.push_str(&format!(
        "author: {}\n",
        yaml_escape(book.author.as_deref().unwrap_or(""))
    ));
    out.push_str("type: reading-source\n");
    out.push_str(&format!("source_format: {}\n", book.source_type));
    out.push_str(&format!("source_sha256: {}\n", book.source_sha256));
    out.push_str("source_private: true\n");
    out.push_str(&format!("throughline_book_id: {}\n", book.id));
    out.push_str(&format!("note_count: {}\n", note_count));
    out.push_str(&format!("last_export: {}\n", now));
    // Preserve user-added keys verbatim (those the app doesn't own).
    for (k, v) in extra {
        out.push_str(&format!("{k}: {v}\n"));
    }
    out.push_str("---\n");
    out
}

/// Parse an existing file's leading YAML frontmatter (if any), returning the
/// user-added key/value lines (those NOT in `OWNED_FRONTMATTER_KEYS`) in order,
/// plus the byte index in `existing` just AFTER the closing `---\n`. Returns
/// `(extra_keys, body_start)`. When there's no frontmatter, `body_start` is 0.
fn parse_existing_frontmatter(existing: &str) -> (Vec<(String, String)>, usize) {
    if !existing.starts_with("---\n") {
        return (Vec::new(), 0);
    }
    // Find the closing fence.
    let after_open = 4; // len("---\n")
    let rest = &existing[after_open..];
    let Some(close_rel) = rest.find("\n---") else {
        return (Vec::new(), 0);
    };
    let block = &rest[..close_rel];
    // Body starts after the closing "---" line (and its trailing newline if any).
    let close_abs = after_open + close_rel + 1; // index of the '-' in closing "---"
    let mut body_start = close_abs + 3; // past "---"
    if existing[body_start..].starts_with('\n') {
        body_start += 1;
    }

    let mut extra = Vec::new();
    for line in block.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(colon) = trimmed.find(':') {
            let key = trimmed[..colon].trim().to_string();
            let val = trimmed[colon + 1..].trim().to_string();
            if !OWNED_FRONTMATTER_KEYS.contains(&key.as_str()) {
                extra.push((key, val));
            }
        }
    }
    (extra, body_start)
}

// ── Literature note (full render + idempotent merge) ────────────────────────

/// The fixed reading-source callout that frames the copyright posture in every
/// book file (counsel-reviewed framing).
const READING_SOURCE_CALLOUT: &str = "> [!info] Reading source\n\
     > Quotes are excerpted (≤300 chars) for private study; the full text is not reproduced. Source verified by SHA-256.";

/// Fetch a book's notes for export, ordered by document position: by chapter
/// (notes with no chapter sink to the default heading), then by locator.
fn fetch_notes_for_book(conn: &Connection, book_id: &str) -> rusqlite::Result<Vec<Note>> {
    let mut stmt = conn.prepare(
        "SELECT id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text
         FROM notes WHERE book_id = ?1",
    )?;
    let rows = stmt.query_map(params![book_id], note_from_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    // Stable document order: group by chapter (in first-seen order), then by the
    // note's numeric locator within the chapter.
    out.sort_by(|a, b| {
        locator_sort_key(&a.locator)
            .cmp(&locator_sort_key(&b.locator))
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    Ok(out)
}

/// Numeric sort key for a `char:<n>` (or bare-numeric) locator; non-numeric
/// locators sort last (large key) but stay stable via the created_at tiebreak.
fn locator_sort_key(locator: &str) -> u64 {
    locator
        .trim()
        .strip_prefix("char:")
        .unwrap_or(locator.trim())
        .parse::<u64>()
        .unwrap_or(u64::MAX)
}

/// The reader-facing chapter heading for a note (`chapter_label` or the default).
fn chapter_heading(note: &Note) -> String {
    note.chapter_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CHAPTER)
        .to_string()
}

/// Render the ENTIRE literature-note file FROM SCRATCH (used when no file exists
/// yet). The idempotent merge path (`merge_into_existing`) is used when a file is
/// already present so reader edits OUTSIDE the fences survive.
fn render_full(book: &Book, notes: &[Note], now: &str) -> String {
    let mut out = String::new();
    out.push_str(&render_frontmatter(book, notes.len(), now, &[]));
    out.push('\n');
    let author = book.author.as_deref().unwrap_or("Unknown");
    out.push_str(&format!("# {} — {}\n\n", book.title, author));
    out.push_str(READING_SOURCE_CALLOUT);
    out.push('\n');

    // Group notes by chapter heading in document order.
    let mut current_chapter: Option<String> = None;
    for note in notes {
        let heading = chapter_heading(note);
        if current_chapter.as_deref() != Some(heading.as_str()) {
            out.push_str(&format!("\n## {heading}\n\n"));
            current_chapter = Some(heading);
        }
        out.push_str(&render_note_fence(note));
        out.push_str("\n\n");
    }
    out
}

/// One parsed fence found in an existing file: its export id and the byte range
/// [open_start, close_end) of the WHOLE block (open comment line … close comment).
struct FenceSpan {
    id: String,
    start: usize,
    end: usize,
}

/// Find every `<!-- tl:note id=tl-n-X type=... -->` … `<!-- /tl:note -->` fence
/// in `text`, returning their export ids and byte spans, in file order.
fn find_fences(text: &str) -> Vec<FenceSpan> {
    let mut spans = Vec::new();
    let open_marker = "<!-- tl:note id=";
    let close_marker = "<!-- /tl:note -->";
    let mut search_from = 0;
    while let Some(rel) = text[search_from..].find(open_marker) {
        let open_start = search_from + rel;
        let after_id = open_start + open_marker.len();
        // The id runs to the next whitespace.
        let id_end = text[after_id..]
            .find(|c: char| c.is_whitespace())
            .map(|i| after_id + i)
            .unwrap_or(text.len());
        let id = text[after_id..id_end].to_string();
        // Find the matching close marker after this open.
        let Some(close_rel) = text[id_end..].find(close_marker) else {
            break;
        };
        let close_end = id_end + close_rel + close_marker.len();
        spans.push(FenceSpan {
            id,
            start: open_start,
            end: close_end,
        });
        search_from = close_end;
    }
    spans
}

/// IDEMPOTENT merge: rewrite `existing` so that
/// - each current DB note's fence is REPLACED in place (type/content refreshed),
/// - a current note with no fence yet is INSERTED at the right chapter/locator,
/// - a fence whose id is no longer in the DB is REMOVED,
/// - everything OUTSIDE the fences (the reader's own prose, links, reordering)
///   survives VERBATIM,
/// - the app-owned frontmatter keys are refreshed while user-added keys persist.
fn merge_into_existing(existing: &str, book: &Book, notes: &[Note], now: &str) -> String {
    let (extra_keys, body_start) = parse_existing_frontmatter(existing);
    let body = &existing[body_start..];

    // Map current notes by export id for quick lookup, and track which got placed.
    use std::collections::{HashMap, HashSet};
    let by_id: HashMap<String, &Note> =
        notes.iter().map(|n| (note_export_id(n), n)).collect();

    let fences = find_fences(body);
    let mut placed: HashSet<String> = HashSet::new();

    // Rebuild the body, fence by fence, preserving the inter-fence text verbatim.
    let mut rebuilt = String::new();
    let mut cursor = 0;
    for f in &fences {
        // Verbatim text before this fence.
        rebuilt.push_str(&body[cursor..f.start]);
        if let Some(note) = by_id.get(&f.id) {
            // REPLACE this fence's whole block with the freshly rendered one.
            rebuilt.push_str(&render_note_fence(note));
            placed.insert(f.id.clone());
        }
        // else: fence id no longer in the DB → REMOVE (skip emitting it). We also
        // drop a single trailing blank line that followed it, to avoid blank pileup.
        cursor = f.end;
        if !by_id.contains_key(&f.id) {
            // Swallow up to one immediately-following blank line.
            let tail = &body[cursor..];
            if let Some(stripped) = tail.strip_prefix("\n\n") {
                cursor += tail.len() - stripped.len() - 1; // keep one newline
            }
        }
    }
    // Verbatim tail after the last fence.
    rebuilt.push_str(&body[cursor..]);

    // INSERT any current notes that had no fence yet, grouped under the correct
    // chapter heading (appended in document order). New notes append at the end of
    // their chapter section if it exists, else a new chapter section is added.
    let new_notes: Vec<&Note> = notes
        .iter()
        .filter(|n| !placed.contains(&note_export_id(n)))
        .collect();
    if !new_notes.is_empty() {
        for note in new_notes {
            let heading = chapter_heading(note);
            let block = render_note_fence(note);
            insert_under_chapter(&mut rebuilt, &heading, &block);
        }
    }

    // Reassemble: refreshed frontmatter + the merged body.
    let mut out = String::new();
    out.push_str(&render_frontmatter(book, notes.len(), now, &extra_keys));
    if !rebuilt.starts_with('\n') {
        out.push('\n');
    }
    out.push_str(&rebuilt);
    out
}

/// Append a fence block under its chapter heading in `body`. If a `## {heading}`
/// already exists, the block is inserted just before the NEXT heading (or at the
/// end); otherwise a new `## {heading}` section is appended at the end.
fn insert_under_chapter(body: &mut String, heading: &str, block: &str) {
    let heading_line = format!("## {heading}");
    if let Some(h_pos) = find_heading(body, &heading_line) {
        // Insert before the next `## ` heading after this one, else at the end.
        let after = h_pos + heading_line.len();
        let next_heading_rel = find_next_h2(&body[after..]);
        let insert_at = match next_heading_rel {
            Some(rel) => after + rel,
            None => body.len(),
        };
        // Ensure separation with surrounding blank lines.
        let mut chunk = String::new();
        if !body[..insert_at].ends_with("\n\n") {
            chunk.push('\n');
            if !body[..insert_at].ends_with('\n') {
                chunk.push('\n');
            }
        }
        chunk.push_str(block);
        chunk.push_str("\n\n");
        body.insert_str(insert_at, &chunk);
    } else {
        if !body.ends_with('\n') {
            body.push('\n');
        }
        if !body.ends_with("\n\n") {
            body.push('\n');
        }
        body.push_str(&format!("## {heading}\n\n"));
        body.push_str(block);
        body.push_str("\n\n");
    }
}

/// Find a `## {heading}` line at the start of a line; returns the byte index of
/// the `#`.
fn find_heading(body: &str, heading_line: &str) -> Option<usize> {
    if body.starts_with(heading_line) {
        return Some(0);
    }
    let needle = format!("\n{heading_line}");
    body.find(&needle).map(|i| i + 1)
}

/// Byte offset of the next `## ` (h2) heading in `s`, if any.
fn find_next_h2(s: &str) -> Option<usize> {
    let mut from = 0;
    loop {
        let rel = s[from..].find("## ")?;
        let abs = from + rel;
        // Must be at the start of a line.
        if abs == 0 || s.as_bytes().get(abs - 1) == Some(&b'\n') {
            return Some(abs);
        }
        from = abs + 3;
    }
}

/// Generate (or idempotently re-generate) the per-book LITERATURE NOTE at
/// `Books/{slug}.md`. The make-or-break path:
/// - No file yet → render the whole file from scratch.
/// - File exists → MERGE: replace each note's fence in place, insert fences for
///   new notes, remove fences for deleted notes, and preserve EVERYTHING outside
///   the fences (the reader's own prose/links/reordering) verbatim. App-owned
///   frontmatter keys are refreshed; user-added keys survive.
///
/// `now` is the ISO timestamp written as `last_export` — passed in so tests are
/// deterministic (never `Utc::now()` inside here). Atomic write.
pub fn export_book_literature_note(
    conn: &Connection,
    root: &Path,
    book_id: &str,
    now: &str,
) -> Result<PathBuf> {
    ensure_export_dirs(root)?;
    let book = crate::commands::db_helpers::fetch_book(conn, book_id)?
        .ok_or_else(|| anyhow::anyhow!("export_book_literature_note: book not found: {book_id}"))?;
    let notes = fetch_notes_for_book(conn, book_id)?;
    let dest = book_note_path(root, &book);

    let content = match fs::read_to_string(&dest) {
        Ok(existing) => merge_into_existing(&existing, &book, &notes, now),
        Err(_) => render_full(&book, &notes, now),
    };

    paths::atomic_write_string(&dest, &content)?;
    Ok(dest)
}

// ── Session export (unchanged, out of scope) ─────────────────────────────────

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations;
    use rusqlite::Connection;

    const NOW: &str = "2026-06-10T12:00:00Z";

    fn migrated_with_book() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::apply_pending(&conn).unwrap();
        conn.execute(
            "INSERT INTO books (id, title, author, source_type, source_path, source_sha256, created_at, last_opened_at)
             VALUES ('b1','The Confessions of St. Augustine','Augustine','txt','/x','sha-abc','2026-05-01',NULL)",
            [],
        )
        .unwrap();
        conn
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_note(
        conn: &Connection,
        id: &str,
        note_type: &str,
        locator: &str,
        chapter: Option<&str>,
        body: &str,
        short_quote: Option<&str>,
        anchored_text: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO notes (id, book_id, session_id, note_type, locator, chapter_label, body, short_quote, created_at, updated_at, exported_markdown_path, anchor_start, anchor_end, anchored_text)
             VALUES (?1,'b1',NULL,?2,?3,?4,?5,?6,?7,?7,NULL,NULL,NULL,?8)",
            params![id, note_type, locator, chapter, body, short_quote, format!("2026-05-30T10:00:0{}Z", id.len() % 10), anchored_text],
        )
        .unwrap();
    }

    fn export_to_temp(conn: &Connection, label: &str) -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("tl-litnote-{label}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let path = export_book_literature_note(conn, &root, "b1", NOW).expect("export");
        let md = std::fs::read_to_string(&path).unwrap();
        (path, md)
    }

    #[test]
    fn slug_is_lowercase_hyphenated_and_strips_obsidian_rejects() {
        let book = Book {
            id: "book_AbCdEf123456".into(),
            title: "Foo: Bar/Baz | #1 [Special] ^Edition".into(),
            author: Some("Jane Q. Public".into()),
            source_type: "txt".into(),
            source_path: "/x".into(),
            source_sha256: "h".into(),
            created_at: "2026".into(),
            last_opened_at: None,
        };
        let slug = slug_for(&book);
        // No Obsidian-illegal chars survive.
        for bad in ['@', '#', '^', '[', ']', ':', '|', '/', '\\'] {
            assert!(!slug.contains(bad), "slug must strip {bad:?}: {slug}");
        }
        // Lowercase ascii + hyphens only (plus the id suffix).
        assert!(
            slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "slug not clean: {slug}"
        );
        assert!(slug.contains("foo-bar-baz"), "title words present: {slug}");
        assert!(!slug.contains("--"), "collapsed hyphens: {slug}");
    }

    #[test]
    fn two_books_with_same_title_get_distinct_files() {
        let mk = |id: &str| Book {
            id: id.into(),
            title: "Meditations".into(),
            author: Some("Marcus Aurelius".into()),
            source_type: "txt".into(),
            source_path: "/x".into(),
            source_sha256: "h".into(),
            created_at: "2026".into(),
            last_opened_at: None,
        };
        let a = mk("book_aaaaaa111111");
        let b = mk("book_bbbbbb222222");
        assert_ne!(
            slug_for(&a),
            slug_for(&b),
            "same title, different id → distinct files"
        );
        let root = Path::new("/tmp/x");
        assert_ne!(book_note_path(root, &a), book_note_path(root, &b));
    }

    #[test]
    fn literature_note_has_frontmatter_callout_and_chapter_grouping() {
        let conn = migrated_with_book();
        insert_note(&conn, "n1", "Takeaway", "char:120", Some("Book I"), "grace precedes effort", None, None);
        insert_note(&conn, "n2", "Question", "char:300", Some("Book II"), "can you seek what you don't know?", None, None);
        let (_p, md) = export_to_temp(&conn, "format");

        // Frontmatter keys (flat, app-owned).
        for key in [
            "title: \"The Confessions of St. Augustine\"",
            "author: \"Augustine\"",
            "type: reading-source",
            "source_format: txt",
            "source_sha256: sha-abc",
            "source_private: true",
            "throughline_book_id: b1",
            "note_count: 2",
            &format!("last_export: {NOW}"),
        ] {
            assert!(md.contains(key), "frontmatter missing `{key}`:\n{md}");
        }
        // Title header + reading-source callout with the copyright framing.
        assert!(md.contains("# The Confessions of St. Augustine — Augustine"));
        assert!(md.contains("> [!info] Reading source"));
        assert!(md.contains("the full text is not reproduced. Source verified by SHA-256."));
        // Chapter grouping in document order.
        assert!(md.contains("## Book I"));
        assert!(md.contains("## Book II"));
        let i = md.find("## Book I").unwrap();
        let j = md.find("## Book II").unwrap();
        assert!(i < j, "chapters in locator order");
        // Callout by type + fences + block ids.
        assert!(md.contains("> [!success] Takeaway"));
        assert!(md.contains("> [!question] Question"));
        assert!(md.contains("<!-- tl:note id=tl-n-n1 type=Takeaway -->"));
        assert!(md.contains("<!-- /tl:note -->"));
        assert!(md.contains("^tl-n-n1"), "block id present:\n{md}");
    }

    #[test]
    fn highlight_shows_its_passage_not_a_blank_body() {
        // THE EMPTY-HIGHLIGHT BUG FIX: a Highlight's content is its anchored passage.
        let conn = migrated_with_book();
        insert_note(
            &conn,
            "h1",
            "Highlight",
            "char:10",
            Some("Book I"),
            "", // empty body — the OLD export would have shown nothing
            None,
            Some("Our heart is restless until it rests in thee."),
        );
        let (_p, md) = export_to_temp(&conn, "highlight");
        assert!(md.contains("> [!quote] Highlight"));
        assert!(
            md.contains("Our heart is restless until it rests in thee."),
            "highlight passage must render:\n{md}"
        );
    }

    #[test]
    fn long_highlight_is_truncated_to_the_fair_use_cap() {
        let conn = migrated_with_book();
        let long: String = "x".repeat(400);
        insert_note(&conn, "h2", "Highlight", "char:10", None, "", None, Some(&long));
        let (_p, md) = export_to_temp(&conn, "longhl");
        assert!(md.contains('…'), "a >300 highlight must be truncated + ellipsis:\n{md}");
        // No run of the book's own words exceeds the cap.
        assert!(
            !md.contains(&"x".repeat(QUOTE_WARN_LIMIT + 1)),
            "no exported run may exceed {QUOTE_WARN_LIMIT} chars"
        );
    }

    #[test]
    fn non_highlight_never_leaks_anchored_text() {
        // COPYRIGHT INVARIANT: a Takeaway/MarginNote/TutorNote must NEVER export the
        // raw anchored passage held in the DB — only the reader's/AI body exports.
        let conn = migrated_with_book();
        for (id, kind) in [("t1", "Takeaway"), ("m1", "MarginNote"), ("u1", "TutorNote")] {
            insert_note(
                &conn,
                id,
                kind,
                "char:50",
                Some("Book I"),
                "the reader's own words",
                None,
                Some("the unjust man is happy and the just man miserable"),
            );
        }
        let (_p, md) = export_to_temp(&conn, "noleak");
        assert!(
            !md.contains("the unjust man is happy"),
            "anchored passage leaked for a non-highlight:\n{md}"
        );
        assert!(md.contains("the reader's own words"), "body exports instead");
        // TutorNote renders as the reader-facing "Tutor", never the raw enum text.
        assert!(md.contains("> [!abstract] Tutor"));
        assert!(!md.contains("] TutorNote"), "raw enum label must not be a reader label");
    }

    #[test]
    fn short_quote_is_truncated_and_renders_under_the_body() {
        let conn = migrated_with_book();
        let long_q: String = "q".repeat(400);
        insert_note(&conn, "t2", "Takeaway", "char:10", None, "a body", Some(&long_q), None);
        let (_p, md) = export_to_temp(&conn, "shortq");
        assert!(md.contains("a body"));
        assert!(md.contains('…'), "the >300 short quote must be truncated:\n{md}");
        assert!(
            !md.contains(&"q".repeat(QUOTE_WARN_LIMIT + 1)),
            "no exported run may exceed the cap"
        );
    }

    #[test]
    fn reexport_preserves_a_hand_edit_outside_the_fences() {
        let conn = migrated_with_book();
        insert_note(&conn, "n1", "Takeaway", "char:120", Some("Book I"), "first body", None, None);
        let root = std::env::temp_dir().join(format!("tl-litnote-idem-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let path = export_book_literature_note(&conn, &root, "b1", NOW).unwrap();

        // Reader hand-edits the file OUTSIDE any fence: adds prose + a user FM key.
        let original = std::fs::read_to_string(&path).unwrap();
        let edited = original
            .replace(
                "---\ntitle:",
                "---\nmy_custom_key: kept\ntitle:",
            )
            .replace(
                "> [!info] Reading source",
                "My own paragraph the reader wrote.\n\n> [!info] Reading source",
            );
        std::fs::write(&path, &edited).unwrap();

        // A note update + re-export.
        conn.execute("UPDATE notes SET body='UPDATED body' WHERE id='n1'", [])
            .unwrap();
        export_book_literature_note(&conn, &root, "b1", "2026-06-11T00:00:00Z").unwrap();
        let after = std::fs::read_to_string(&path).unwrap();

        // The hand edit (prose) and the user-added FM key both survive.
        assert!(
            after.contains("My own paragraph the reader wrote."),
            "reader prose outside fences must survive re-export:\n{after}"
        );
        assert!(
            after.contains("my_custom_key: kept"),
            "user-added frontmatter key must survive:\n{after}"
        );
        // The note's fence content updated in place.
        assert!(after.contains("UPDATED body"), "note fence updated in place");
        assert!(!after.contains("first body"), "old fence content replaced");
        // App-owned key refreshed.
        assert!(after.contains("last_export: 2026-06-11T00:00:00Z"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn deleted_note_fence_is_removed_on_reexport() {
        let conn = migrated_with_book();
        insert_note(&conn, "k1", "Takeaway", "char:10", Some("Book I"), "keep me", None, None);
        insert_note(&conn, "d1", "Question", "char:20", Some("Book I"), "delete me", None, None);
        let root = std::env::temp_dir().join(format!("tl-litnote-del-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let path = export_book_literature_note(&conn, &root, "b1", NOW).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("delete me"));

        conn.execute("DELETE FROM notes WHERE id='d1'", []).unwrap();
        export_book_literature_note(&conn, &root, "b1", NOW).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(!after.contains("delete me"), "deleted note fence removed:\n{after}");
        assert!(!after.contains("tl-n-d1"), "deleted note id gone");
        assert!(after.contains("keep me"), "surviving note intact");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn new_note_inserts_a_fence_without_clobbering_existing() {
        let conn = migrated_with_book();
        insert_note(&conn, "a1", "Takeaway", "char:10", Some("Book I"), "alpha", None, None);
        let root = std::env::temp_dir().join(format!("tl-litnote-ins-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let path = export_book_literature_note(&conn, &root, "b1", NOW).unwrap();

        // Reader edits prose, then a NEW note is added + re-export.
        let edited = std::fs::read_to_string(&path)
            .unwrap()
            .replace("<!-- /tl:note -->", "<!-- /tl:note -->\n\nReader prose between notes.");
        std::fs::write(&path, &edited).unwrap();
        insert_note(&conn, "b2", "Question", "char:20", Some("Book I"), "beta", None, None);
        export_book_literature_note(&conn, &root, "b1", NOW).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("alpha"), "existing note kept");
        assert!(after.contains("beta"), "new note inserted");
        assert!(after.contains("Reader prose between notes."), "reader prose survived");
        assert!(after.contains("note_count: 2"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn multiline_quote_and_highlight_stay_valid_callout_lines() {
        // An interior newline in a highlight passage or a reader short quote must
        // NOT produce an un-prefixed continuation line (that breaks the Obsidian
        // callout). Every line between the fence comments must start with '>'.
        let conn = migrated_with_book();
        insert_note(
            &conn,
            "h1",
            "Highlight",
            "char:10",
            None,
            "",
            None,
            Some("line one\nline two"),
        );
        insert_note(
            &conn,
            "t1",
            "Takeaway",
            "char:20",
            None,
            "body line",
            Some("quote a\nquote b"),
            None,
        );
        let (_p, md) = export_to_temp(&conn, "multiline");
        // Scan every line inside a fence and assert it is a valid quote/comment line.
        let mut inside = false;
        for line in md.lines() {
            if line.starts_with("<!-- tl:note ") {
                inside = true;
                continue;
            }
            if line.starts_with("<!-- /tl:note -->") {
                inside = false;
                continue;
            }
            if inside {
                assert!(
                    line.starts_with('>'),
                    "callout line not quote-prefixed (breaks Obsidian): {line:?}\n{md}"
                );
            }
        }
        assert!(md.contains("> line two"), "highlight 2nd line prefixed");
        assert!(md.contains("> > quote b"), "short-quote 2nd line nested");
    }

    #[test]
    fn no_exported_run_exceeds_the_cap_and_sha_present() {
        let conn = migrated_with_book();
        let long: String = "z".repeat(500);
        insert_note(&conn, "h1", "Highlight", "char:10", None, "", None, Some(&long));
        insert_note(&conn, "t1", "Takeaway", "char:20", None, "body", Some(&long), None);
        let (_p, md) = export_to_temp(&conn, "caps");
        assert!(md.contains("source_private: true"));
        assert!(md.contains("source_sha256: sha-abc"));
        // Every consecutive run of book-letters is within the cap.
        assert!(!md.contains(&"z".repeat(QUOTE_WARN_LIMIT + 1)));
    }
}

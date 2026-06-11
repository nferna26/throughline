use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub source_type: String,
    pub source_path: String,
    pub source_sha256: String,
    pub created_at: String,
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookSection {
    pub id: String,
    pub book_id: String,
    pub label: String,
    pub href: Option<String>,
    pub start_locator: Option<String>,
    pub end_locator: Option<String>,
    pub estimated_units: Option<i64>,
    pub sort_order: i64,
    /// True for plan-assignable sections (chapters / real content).
    /// False for structural front/back matter (cover, title, copyright, also-by, …).
    /// Unassignable sections are still navigable via Next/Prev in the reader,
    /// they just don't consume plan days.
    #[serde(default = "default_true")]
    pub assignable: bool,
}

fn default_true() -> bool {
    true
}

/// An inline/block style range within a section's plain text, in **UTF-16
/// code-unit** offsets relative to that section's text — matching the reader's JS
/// string units exactly. Produced by the EPUB→text extractor and consumed by the
/// reader to style headings, blockquotes, and bold/italic WITHOUT mutating the
/// text, so char-offset note anchoring stays exact. `kind` is one of
/// `h1`..`h6`, `blockquote` (block roles applied to the whole paragraph) or
/// `strong`/`em` (inline spans).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct StyleRange {
    pub kind: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReadingPlan {
    pub id: String,
    pub book_id: String,
    pub start_date: String,
    /// Plan lifecycle: "plan_ready" (imported, sitting length not chosen yet) |
    /// "active" | "completed" | "paused". The pace clock is gone; this only marks
    /// whether the reader has begun. Defaults to "active" for legacy rows.
    #[serde(default = "default_active")]
    pub status: String,
    /// Stamped when the first reading session starts. None = not yet begun.
    #[serde(default)]
    pub activated_at: Option<String>,
    /// The reader's one choice: how much feels right at a sitting, in minutes
    /// (about 10 / 25 / 60). Drives how the book is chunked. None until chosen.
    #[serde(default)]
    pub sitting_length_minutes: Option<i64>,
}

fn default_active() -> String {
    "active".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ReadingSession {
    pub id: String,
    pub book_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub start_locator: Option<String>,
    pub end_locator: Option<String>,
    pub minutes: Option<i64>,
    pub completed_assignment: bool,
    pub subjective_difficulty: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: String,
    pub book_id: String,
    pub session_id: Option<String>,
    pub note_type: String,
    pub locator: String,
    pub chapter_label: Option<String>,
    pub body: String,
    pub short_quote: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub exported_markdown_path: Option<String>,
    /// Marginalia anchor range (tagged locators) + the exact highlighted text.
    /// All None for legacy/point-anchored notes. `locator` remains the primary
    /// anchor point (== anchor_start when a range exists). Added in v006.
    #[serde(default)]
    pub anchor_start: Option<String>,
    #[serde(default)]
    pub anchor_end: Option<String>,
    #[serde(default)]
    pub anchored_text: Option<String>,
}

/// One row of the AI audit trail (`ai_requests`), shaped for the history viewer.
/// `provider` is NULL for prompt previews (never sent anywhere) and the request
/// host for real Ask calls. `book_title` is LEFT-JOINed for display and is None
/// if the book was removed. `wrote_to_memory` marks rows that became a Note —
/// these are kept past the retention window (they mirror durable notes).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiRequest {
    pub id: String,
    pub book_id: String,
    pub book_title: Option<String>,
    pub mode: String,
    pub locator: Option<String>,
    pub context_char_count: Option<i64>,
    pub provider: Option<String>,
    pub created_at: String,
    pub wrote_to_memory: bool,
}

/// Result of an import. `created` is false when the import deduped onto a book
/// that was already present (same SHA-256) — the frontend uses it to decide
/// whether to show the Book Setup Sheet (only for genuinely new books).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImportOutcome {
    pub book: Book,
    pub created: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TodayCard {
    pub book: Book,
    pub plan: ReadingPlan,
    /// What the screen should say: "day_one" (never read), "reading" (mid-book),
    /// "returning" (a lapse since last read), "finished" (read to the end), or
    /// "no_plan" (every plan let go). "behind" is deliberately unrepresentable.
    pub state: String,
    /// The current sitting's heuristic label — ALWAYS present, never blank or a
    /// loading placeholder ("Chapter II", "Chapter II, continued", …).
    pub chapter_label: String,
    /// The AI evocative phrase for the current sitting, when one is cached locally.
    /// None until the phrase pipeline lands; the label carries the screen meanwhile.
    #[serde(default)]
    pub phrase: Option<String>,
    /// Reading time of the CURRENT SITTING, in minutes (derived from its char span).
    pub estimated_minutes: i64,
    /// Qualitative position in the book, 0.0..=1.0, for the hairline. Rendered as a
    /// length, never labeled with a number.
    pub fraction_complete: f64,
    /// The next sitting's label, for the finished state's gentle forward pull.
    #[serde(default)]
    pub next_label: Option<String>,
    /// The section to open for "Continue reading", and where to resume within it.
    pub section: Option<BookSection>,
    #[serde(default)]
    pub resume_locator: Option<String>,
    #[serde(default)]
    pub resume_percent: Option<f64>,
    /// "Last time" memory for calm re-entry. Always present; empty until the reader
    /// has captured something.
    #[serde(default)]
    pub memory: TodayMemory,
    /// "Before you read" teaser for the current sitting's section. None when the
    /// section text can't be read.
    #[serde(default)]
    pub teaser: Option<TodayTeaser>,
}

/// "Before you read" block on Today. `excerpt` is the section's own first
/// meaningful sentence(s) (headings / TOC / boilerplate skipped, ~320 char cap);
/// `prompt` is a hand-written, deterministic reading lens (never AI-generated);
/// `locator` points at the excerpt's start; `is_resume_excerpt` is true when the
/// reader is mid-section and the excerpt is taken near their resume position
/// rather than the section's opening.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodayTeaser {
    pub excerpt: String,
    pub prompt: String,
    pub locator: String,
    pub is_resume_excerpt: bool,
}

/// The reader's own most recent durable capture, surfaced on Today so picking
/// the book back up feels like continuing a thought. Body is user-authored
/// (Takeaway/Question) — never a raw passage, AI output, or short quote.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastCapture {
    pub note_type: String,
    pub body: String,
    pub chapter_label: Option<String>,
    pub created_at: String,
}

/// "Today remembers" surface data, derived entirely from the local DB.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TodayMemory {
    /// Most recent user-authored Takeaway or Question, if any.
    pub last_capture: Option<LastCapture>,
    /// Count of saved highlights for this book.
    pub highlight_count: i64,
    /// Count of user-authored notes (anything with a real body that isn't a
    /// bare highlight) — questions, takeaways, reflections, margin notes, and
    /// saved tutor notes the reader chose to keep.
    pub note_count: i64,
}

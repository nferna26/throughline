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

fn default_true() -> bool { true }

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
    pub target_finish_date: String,
    pub daily_target_units: Option<i64>,
    pub days_per_week: i64,
    pub catchup_mode: String,
    /// Plan lifecycle: "plan_ready" (imported, not started yet) | "active" |
    /// "rebalanced" | "completed" | "paused". Defaults to "active" for plans
    /// created before this field existed (migration v005 column default).
    #[serde(default = "default_active")]
    pub status: String,
    /// Stamped when the first reading session starts. None = not yet activated;
    /// the pace clock and forecast only run once this is set.
    #[serde(default)]
    pub activated_at: Option<String>,
    /// The pre-rebalance target, captured the first time the finish date moves,
    /// so the forecast has a stable baseline. None until a rebalance occurs.
    #[serde(default)]
    pub original_finish_date: Option<String>,
}

fn default_active() -> String {
    "active".to_string()
}

/// Forward-looking pace signal driven by the OBSERVED reading rate vs the
/// target — not a punitive "should-have-done-by-now" curve. Only meaningful
/// once a plan is `active` and at least one reading window has passed.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FinishForecast {
    /// "on_track" | "slightly_off_pace" | "needs_rebalance" | "plan_unrealistic"
    pub state: String,
    /// Projected finish date at the current observed rate (YYYY-MM-DD), if estimable.
    pub projected_finish_date: Option<String>,
    /// Projected days past the target (negative = ahead). 0 when on track or not estimable.
    pub days_late: i64,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PaceState {
    OnPace,
    Behind { days_behind: i64 },
    Recovery,
    NotStarted,
    Done,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreakSummary {
    pub days_read_last_7: i64,
    pub minutes_last_7: i64,
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
    pub section: Option<BookSection>,
    pub section_completed: bool,
    /// Estimated reading time of *today's assigned section*, in minutes.
    pub estimated_minutes: i64,
    /// Planned length of a normal reading sitting, in minutes (the user's
    /// "Reading rhythm"; default 25). Drives the primary "Start N-minute
    /// session" action — distinct from `estimated_minutes` (today's section).
    pub session_minutes: i64,
    pub monthly_pct: i64,
    pub pace: PaceState,
    pub day_index: i64,
    pub total_days: i64,
    pub streak: StreakSummary,
    pub recovery: Option<crate::recovery::RecoveryBundle>,
    pub resume_locator: Option<String>,
    pub resume_percent: Option<f64>,
    /// Plan lifecycle status (mirror of ReadingPlan.status) so the UI can show
    /// "Plan ready. You are not behind." before activation instead of a pace.
    pub plan_status: String,
    /// Finish forecast — present only once the plan is active and a window has
    /// passed. None before then (a fresh import is never "behind").
    pub forecast: Option<FinishForecast>,
    /// "Last time" memory for calm re-entry on Today. Always present; its fields
    /// are empty/None when the reader hasn't captured anything yet.
    #[serde(default)]
    pub memory: TodayMemory,
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

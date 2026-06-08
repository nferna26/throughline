export interface Book {
  id: string;
  title: string;
  author: string | null;
  source_type: string; // "txt" | "epub"
  source_path: string;
  source_sha256: string;
  created_at: string;
  last_opened_at: string | null;
}

export interface BookSection {
  id: string;
  book_id: string;
  label: string;
  href: string | null;
  start_locator: string | null;
  end_locator: string | null;
  estimated_units: number | null;
  sort_order: number;
}

/** Plan lifecycle. A freshly imported book is `plan_ready` (the plan exists but
 *  the pace clock has NOT started) — this is what guarantees an imported book is
 *  never shown as "behind". The first reading session flips it to `active` and
 *  stamps `activated_at`; `rebalanced` after an extend; `completed` when every
 *  assignable section is done. Legacy plans default to `active`. */
export type PlanStatus =
  | "plan_ready"
  | "active"
  | "rebalanced"
  | "completed"
  | "paused";

export interface ReadingPlan {
  id: string;
  book_id: string;
  start_date: string;
  target_finish_date: string;
  daily_target_units: number | null;
  days_per_week: number;
  catchup_mode: string;
  /** Lifecycle state — see PlanStatus. Defaults to "active" for legacy rows. */
  status: string;
  /** When the plan was activated (first reading session). null while plan_ready. */
  activated_at: string | null;
  /** The original target_finish_date, captured the first time a rebalance moved
   *  the goalpost. null if never rebalanced. */
  original_finish_date: string | null;
}

/** Forward-looking finish projection. Replaces the punitive "N days behind"
 *  linear deficit with an honest forecast: where the *current* reading rate
 *  lands you relative to the target finish date. Only present once a plan is
 *  active (null while plan_ready / done). */
export type FinishForecastState =
  | "on_track"
  | "slightly_off_pace"
  | "needs_rebalance"
  | "plan_unrealistic";

export interface FinishForecast {
  state: string;
  projected_finish_date: string | null;
  days_late: number;
}

/** Result of cmd_import_book. `created` is false when the import deduped onto a
 *  book already present (same SHA) — the Setup Sheet shows only when true. */
export interface ImportOutcome {
  book: Book;
  created: boolean;
}

/** A row in the public-domain catalogue (Discover). `txt_url`/`epub_url` are
 *  opaque download URLs echoed straight back to `cmd_import_from_gutendex`; the
 *  UI never needs to understand them. The catalogue source brand name stays out
 *  of the UI entirely — see Discover.tsx. */
export interface DiscoverBook {
  id: number;
  title: string;
  author: string;
  language: string;
  download_count: number;
  has_txt: boolean;
  has_epub: boolean;
  txt_url: string | null;
  epub_url: string | null;
}

export interface DiscoverPage {
  /** Live catalogue size for the "free titles" / "Search all N" copy. */
  count: number;
  /** 1-based page to request next, or null at the end of results. */
  next_page: number | null;
  results: DiscoverBook[];
  /** True when results came from the bundled offline seed (the live catalogue
   *  was unreachable) rather than the full library — drives a calm "offline
   *  catalogue" hint so a smaller result set is honestly explained. */
  offline: boolean;
}

export interface ReadingSession {
  id: string;
  book_id: string;
  started_at: string;
  ended_at: string | null;
  start_locator: string | null;
  end_locator: string | null;
  minutes: number | null;
  completed_assignment: boolean;
  subjective_difficulty: number | null;
}

export interface Note {
  id: string;
  book_id: string;
  session_id: string | null;
  note_type: string;
  locator: string;
  chapter_label: string | null;
  body: string;
  short_quote: string | null;
  created_at: string;
  updated_at: string;
  exported_markdown_path: string | null;
  /** Marginalia anchor range (tagged locators) + exact highlighted text.
   *  All null for legacy/point-anchored notes. `locator` stays the primary
   *  anchor point. Added with the v006 migration / API v2. */
  anchor_start: string | null;
  anchor_end: string | null;
  anchored_text: string | null;
}

export interface AiRequest {
  id: string;
  book_id: string;
  book_title: string | null;
  mode: string;
  locator: string | null;
  context_char_count: number | null;
  /** null = prompt preview that never left this machine; otherwise the host a
   *  real Ask call was sent to. */
  provider: string | null;
  created_at: string;
  wrote_to_memory: boolean;
}

/** How the reader was entered. "full" = a normal planned session; "rescue" =
 *  the calm 10-minute "just stay connected to the book" mode. The mode only
 *  changes framing/copy and the recap — never the pacing or completion math. */
export type ReaderMode = "full" | "rescue";

export type PaceState =
  | { kind: "on_pace" }
  | { kind: "behind"; days_behind: number }
  | { kind: "recovery" }
  | { kind: "not_started" }
  | { kind: "done" };

export type RecoveryOption =
  | { kind: "ResumeToday" }
  | { kind: "GentleCatchup"; extra_minutes: number; for_sessions: number }
  | { kind: "WeekendCatchup"; weekend_starts_in_days: number }
  | { kind: "ExtendFinish"; add_days: number; new_finish: string };

export interface RecoveryBundle {
  headline: string;
  days_behind: number;
  options: RecoveryOption[];
}

export interface StreakSummary {
  days_read_last_7: number;
  minutes_last_7: number;
}

export interface RecomputedPlan {
  new_target_finish_date: string;
  new_daily_target_units: number | null;
  remaining_sections: number;
  remaining_days: number;
}

export interface TodayCard {
  book: Book;
  plan: ReadingPlan;
  section: BookSection | null;
  section_completed: boolean;
  /** Estimated reading time of today's assigned section, in minutes. */
  estimated_minutes: number;
  /** Planned length of a normal sitting (the "Reading rhythm"; default 25).
   *  Drives the primary "Start N-minute session" action. */
  session_minutes: number;
  monthly_pct: number;
  pace: PaceState;
  day_index: number;
  total_days: number;
  streak: StreakSummary;
  recovery: RecoveryBundle | null;
  resume_locator: string | null;
  resume_percent: number | null;
  /** Plan lifecycle state (mirrors plan.status) — drives the Today copy so a
   *  plan_ready book reads "Plan ready. You are not behind." */
  plan_status: string;
  /** Honest finish projection; null while plan_ready or done. */
  forecast: FinishForecast | null;
  /** "Last time" memory for calm re-entry; fields empty when nothing captured. */
  memory: TodayMemory;
  /** "Before you read" teaser (book's own first/resume sentences + a prompt);
   *  null when there's no readable section text. Optional in the type so existing
   *  TodayCard fixtures stay valid; the backend always sends it (possibly null). */
  teaser?: TodayTeaser | null;
}

/** The reader's own most recent durable capture (their words, never a passage). */
export interface LastCapture {
  note_type: string;
  body: string;
  chapter_label: string | null;
  created_at: string;
}

export interface TodayMemory {
  last_capture: LastCapture | null;
  highlight_count: number;
  note_count: number;
}

/** "Before you read" teaser on Today: the book's OWN first (or resume-adjacent)
 *  sentence(s) plus a hand-written reading prompt. Sourced from the already-
 *  imported local text — never AI, never network. `is_resume_excerpt` is true
 *  when the excerpt is taken near the reader's mid-section resume position. */
export interface TodayTeaser {
  excerpt: string;
  prompt: string;
  locator: string;
  is_resume_excerpt: boolean;
}

export const NOTE_TYPES = [
  "Observation",
  "Question",
  "Connection",
  "Reflection",
  "Takeaway",
  "Short Quote",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

export const AI_STUB_MODES = [
  { value: "explain",      label: "Explain this passage" },
  { value: "historical",   label: "Historical context" },
  { value: "vocabulary",   label: "Vocabulary / reference" },
  { value: "socratic",     label: "Ask questions" },
  { value: "durable_note", label: "Extract durable note" },
  { value: "prepare_next", label: "Prepare tomorrow's reading" },
] as const;

export type AiStubMode = (typeof AI_STUB_MODES)[number]["value"];

export interface AiPreview {
  ai_request_id: string;
  mode: string;
  mode_label: string;
  prompt: string;
  wrote_to_memory: boolean;
  provider: string | null;
}

export interface SettingsDto {
  export_path: string;
  export_path_is_default: boolean;
  app_data_path: string;
  ai_posture: string;
  ai_base_url: string;
  ai_model: string;
  ai_local_only: boolean;
  quote_policy: string;
  quote_warn_chars: number;
  ai_requests_retention_days: number;
  /** "quiet" | "guided" | "deep_study" — how present the Companion Margin is. */
  margin_help: string;
  // ── Cloud AI providers ──
  /** "local" | "openai" | "anthropic" | "codex" | "none" | "" (empty = not chosen). */
  ai_provider: string;
  /** True once onboarding has made an AI choice. */
  ai_provider_chosen: boolean;
  /** True when a cloud provider was explicitly chosen (selection leaves the Mac). */
  ai_remote_allowed: boolean;
  ai_model_openai: string;
  ai_model_anthropic: string;
  ai_model_codex: string;
  ai_key_present_openai: boolean;
  ai_key_present_anthropic: boolean;
  ai_codex_creds_present: boolean;
}

/** Human label + privacy disclosure for a provider, used by onboarding + cards. */
export const AI_PROVIDERS: Array<{
  id: "local" | "openai" | "anthropic" | "codex";
  label: string;
  /** Short where-your-text-goes disclosure shown before any call. */
  disclosure: string;
  remote: boolean;
}> = [
  { id: "local", label: "Local (LM Studio)", remote: false,
    disclosure: "Runs entirely on this Mac. Nothing you read or select leaves your device." },
  { id: "openai", label: "OpenAI", remote: true,
    disclosure: "Your selected passage (or section) is sent to OpenAI under your API key — never the whole book." },
  { id: "anthropic", label: "Anthropic", remote: true,
    disclosure: "Your selected passage (or section) is sent to Anthropic under your API key — never the whole book." },
  { id: "codex", label: "Codex (ChatGPT login)", remote: true,
    disclosure: "Your selected passage (or section) is sent to OpenAI via your Codex login — never the whole book." },
];

export function aiProviderLabel(id: string): string {
  return AI_PROVIDERS.find((p) => p.id === id)?.label ?? "AI";
}

export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface AskHandle {
  ai_request_id: string;
  prompt_sent: string;
  provider_host: string;
}

export interface ConnTestResult {
  reachable: boolean;
  first_model_id: string | null;
  message: string;
}

/** Typed error shape emitted by Tauri commands (see src-tauri/src/error.rs).
 *  All command rejections deserialize to one of these. Frontends can either
 *  branch on `kind` for special handling or pull `message` for display. */
export type AppError =
  | { kind: "Db";         message: string }
  | { kind: "Ai";         message: string }
  | { kind: "Io";         message: string }
  | { kind: "Validation"; message: string }
  | { kind: "Config";     message: string }
  | { kind: "NotFound";   resource: string; id: string | null }
  | { kind: "Internal";   message: string };

/** Best-effort one-line display for any caught error (AppError, native Error,
 *  or random thrown value). */
export function errorMessage(e: unknown): string {
  if (e == null) return "(no error)";
  if (typeof e === "string") return e;
  if (typeof e === "object") {
    const obj = e as any;
    if (obj.message) return String(obj.message);
    if (obj.kind === "NotFound") {
      return obj.id ? `${obj.resource} not found: ${obj.id}` : `${obj.resource} not found`;
    }
  }
  return String(e);
}

/** Tagged locator helpers. Locators are stored as strings:
 *   "char:<offset>"  → text book character offset
 *   "cfi:<epubcfi>"  → EPUB CFI
 *   "percent:<n>"    → fallback when neither resolves
 */
export function makeCharLocator(offset: number): string {
  return `char:${Math.max(0, Math.floor(offset))}`;
}
export function makeCfiLocator(cfi: string): string {
  return `cfi:${cfi}`;
}
export function parseLocator(loc: string | null | undefined): { kind: "char" | "cfi" | "percent" | "unknown"; value: string } {
  if (!loc) return { kind: "unknown", value: "" };
  if (loc.startsWith("char:")) return { kind: "char", value: loc.slice(5) };
  if (loc.startsWith("cfi:")) return { kind: "cfi", value: loc.slice(4) };
  if (loc.startsWith("percent:")) return { kind: "percent", value: loc.slice(8) };
  // Backwards-compat: bare numeric strings (Shot 1) are char offsets.
  if (/^\d+$/.test(loc)) return { kind: "char", value: loc };
  return { kind: "unknown", value: loc };
}

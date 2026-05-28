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

export interface ReadingPlan {
  id: string;
  book_id: string;
  start_date: string;
  target_finish_date: string;
  daily_target_units: number | null;
  days_per_week: number;
  catchup_mode: string;
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
}

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
  | { kind: "ExtendFinish"; add_days: number; new_finish: string }
  | { kind: "RestartCurrentChapter" };

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
  estimated_minutes: number;
  monthly_pct: number;
  pace: PaceState;
  day_index: number;
  total_days: number;
  streak: StreakSummary;
  recovery: RecoveryBundle | null;
  resume_locator: string | null;
  resume_percent: number | null;
}

export const NOTE_TYPES = [
  "Observation",
  "Question",
  "Connection",
  "Reflection",
  "Short Quote",
] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

export const AI_STUB_MODES = [
  { value: "explain",      label: "Explain this passage" },
  { value: "historical",   label: "Historical context" },
  { value: "vocabulary",   label: "Vocabulary / reference" },
  { value: "socratic",     label: "Socratic questions" },
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

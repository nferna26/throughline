# ReadingGym IPC Contract

The Rust backend exposes commands to the React frontend via Tauri's `invoke` bridge. This document is the binding contract: argument names, types, return shapes, error shapes, and the semver commitment for changes.

The current API version is **2**. Read it at runtime from the frontend via `invoke("cmd_api_version")`.

> **1 → 2:** `cmd_import_book` now returns `ImportOutcome { book, created }` instead of a bare `Book`. Return-shape change → major bump.

---

## Semver commitment

- **Patch** (1 → 1): bug fixes, internal refactors, no contract change. The integer constant does not move.
- **Minor** (1 → 1): strictly-additive changes — new commands or new *optional* arguments to existing commands. The constant does not move. New additions are documented here and called out in `README.md` / `CHANGELOG.md`.
- **Major** (1 → 2): renames, removed commands, changed argument types, changed return types, or anything else that could break an existing JS caller. The constant moves. Frontends compare against their expected version on startup; the version mismatch is the surfaced error.

If a change is unclear, treat it as major.

---

## Error shape

Every command returns a `Result<T, AppError>`. On rejection, JS receives the serialized `AppError`:

```ts
type AppError =
  | { kind: "Db";         message: string }
  | { kind: "Ai";         message: string }
  | { kind: "Io";         message: string }
  | { kind: "Validation"; message: string }
  | { kind: "Config";     message: string }
  | { kind: "NotFound";   resource: string; id: string | null }
  | { kind: "Internal";   message: string };
```

`message` is always present except on `NotFound`, which carries `resource` + `id`. The TypeScript type lives at `src/types.ts`. Use `errorMessage(e)` from there for a generic one-line display.

---

## Commands

### System

#### `cmd_api_version`
- args: none
- returns: `number` — the value of `COMMAND_API_VERSION` (currently `2`)
- errors: never

Use this from the frontend on startup to detect a backend that has moved to a major version your build doesn't understand.

#### `cmd_paths_info`
- args: none
- returns: `{ app_support: string; db_path: string; export_root: string }`
- errors: `Io` if any path resolution fails

Read-only display of local data locations. Useful for rollback instructions and diagnostics.

---

### Books

#### `cmd_import_book`
- args: `{ path: string }` — absolute path to `.txt` or `.epub` on the user's disk
- returns: `ImportOutcome { book: Book; created: boolean }` (see types.ts). `created` is `false` when the import deduped onto an existing book.
- errors:
  - `Io { message }` — file unreadable or import pipeline failed
  - `Validation { message }` — unsupported extension or DRM-detected EPUB
  - `Db { message }` — sqlite error

**Dedup (skip & switch):** if the file's SHA-256 already matches an imported book, no duplicate is created — the existing book is made active (`last_opened_at` bumped) and returned with `created: false`. Re-import is idempotent. The frontend opens the Book Setup Sheet only when `created: true`.

#### `cmd_configure_plan`
- args: `{ bookId: string; targetFinishDate: string; daysPerWeek: number; sessionMinutes: number; marginHelp?: "guided" | "quiet" }` — `targetFinishDate` is `YYYY-MM-DD`
- returns: `ReadingPlan` (the updated plan)
- errors:
  - `NotFound` — no plan for the book
  - `Validation` — finish date unparseable or in the past
  - `Db` — sqlite error

Configures a freshly imported book's plan from the Book Setup Sheet: sets the target finish date and days-per-week, recomputes the daily section target, and persists the reading rhythm (`reading_rhythm_minutes`) and `margin_help` settings. **Does NOT activate the plan** — status stays `plan_ready`, so the book remains "not behind" until the first reading session (Priority 0). Added in `COMMAND_API_VERSION` 2 (new command; additive on its own).

#### `cmd_read_book_bytes`
- args: `{ bookId: string }`
- returns: `number[]` — raw bytes of the source file (for `epub.js` to consume)
- errors: `NotFound` if book doesn't exist; `Io` on read failure; `Validation` if source type is neither `txt` nor `epub`

#### `cmd_today`
- args: none
- returns: `TodayCard | null` — the active book's today card (see types.ts), or null if no books
- errors: `Db`, `Internal`

The "active book" is the one with the latest `last_opened_at` (or `created_at` if never opened). Updated on import and on `cmd_start_session`.

#### `cmd_read_section_text`
- args: `{ bookId: string; sectionId: string }`
- returns: `string` — the section's plain text (only valid for txt books)
- errors: `NotFound` if section missing; `Io` on file read failure

#### `cmd_list_sections`
- args: `{ bookId: string }`
- returns: `BookSection[]` — all sections in spine order (including non-assignable front/back matter)
- errors: `Db`

#### `cmd_assignable_sections`
- args: `{ bookId: string }`
- returns: `BookSection[]` — **canonical reading sequence**, assignable-only, in spine order
- errors: `Db`

This is the list both readers index into. Frontends MUST use this, not `cmd_list_sections`, for Next/Prev navigation and "today's target" display. Lazy reclassification: pre-2.5 EPUB rows with `assignable=1` everywhere get reclassified on first call.

#### `cmd_list_books`
- args: none
- returns: `Book[]` — all books, oldest-first by `created_at`
- errors: `Db`

#### `cmd_set_active_book`
- args: `{ bookId: string }`
- returns: void
- errors: `NotFound` if the book doesn't exist; `Db`

Makes `bookId` the active book by bumping its `last_opened_at`, so the next `cmd_today` composes that book's card. This is what the Today-header book switcher calls; the frontend re-invokes `cmd_today` afterward. Added in 0.1.x — additive, `COMMAND_API_VERSION` stays `1`.

---

### Sessions, progress, plan adjustments

#### `cmd_start_session`
- args: `{ bookId: string; sectionId?: string; startLocator?: string }`
- returns: `ReadingSession`
- errors: `Db`

Side effects: inserts a row in `reading_sessions`, bumps the book's `last_opened_at`.

#### `cmd_end_session`
- args: `{ sessionId: string; endLocator?: string; minutes?: number; completedSectionIds?: string[]; summarySentence?: string }`
- returns: `ReadingSession` — the updated row
- errors: `Db`, `Io` (export failure non-fatal)

Side effects: marks every section in `completedSectionIds` as complete in `section_progress`; exports a Markdown session file.

#### `cmd_save_section_progress`
- args: `{ bookId: string; sectionId: string; locator: string; percent?: number }`
- returns: void
- errors: `Db`

Saves mid-session position for resume.

#### `cmd_extend_finish_date`
- args: `{ bookId: string; addDays: number }`
- returns: `RecomputedPlan { new_target_finish_date, new_daily_target_units, remaining_sections, remaining_days }`
- errors: `NotFound` if no plan for book; `Db`

Recovery action — pushes the plan's finish date and recomputes the daily target over the remaining sections.

#### `cmd_restart_current_section`
- args: `{ bookId: string; sectionId: string }`
- returns: void
- errors: `Db`

Recovery action — clears `section_progress` for one section.

---

### Notes

#### `cmd_save_note`
- args: `{ bookId: string; sessionId?: string; noteType: string; locator: string; chapterLabel?: string; body: string; shortQuote?: string }`
- returns: `Note`
- errors: `Db`, `Io` (export failure non-fatal)

Side effects: inserts a `notes` row, exports Markdown to `{export_root}/Notes/`.

#### `cmd_list_notes`
- args: `{ bookId: string }`
- returns: `Note[]` (newest first)
- errors: `Db`

#### `cmd_quote_warns`
- args: `{ quote: string }`
- returns: `boolean` — true if the quote exceeds the ~300 char fair-use threshold
- errors: never

---

### AI (local-only by default; see Settings)

#### `cmd_generate_prompt_preview`
- args: `{ bookId: string; mode: string; selection: string; chapter?: string; locator?: string; userNote?: string }`
- returns: `{ ai_request_id: string; mode: string; mode_label: string; prompt: string; wrote_to_memory: false; provider: null }`
- errors: `Validation` (selection too short or unknown mode); `NotFound` (book); `Db`

**No network call.** The returned `prompt` is the literal text that *would* be sent if you call `cmd_ai_ask`. The `ai_request_id` lets you save the preview as a Note via `cmd_save_ai_preview_as_note`.

`mode` must be one of: `explain`, `historical`, `vocabulary`, `socratic`, `durable_note`, `prepare_next`.

#### `cmd_save_ai_preview_as_note`
- args: `{ aiRequestId: string; noteType: string; body: string; locator: string; chapterLabel?: string }`
- returns: `Note`
- errors: `Validation` (empty body); `NotFound` (ai_request); `Db`, `Io`

Side effect: flips `ai_requests.wrote_to_memory` to 1.

#### `cmd_ai_ask`
- args: `{ bookId: string; mode: string; selection: string; chapter?: string; locator?: string; userNote?: string; onEvent: Channel<StreamEvent> }`
- returns: `AskHandle { ai_request_id: string; prompt_sent: string; provider_host: string }`
- errors: `Validation`, `Config` (no model id set), `NotFound` (book), `Ai` (URL refused, transport failure, circuit open)

**The bytes in `messages[0].content` of the actual HTTP request equal `prompt_sent` byte-for-byte.** That invariant is pinned by `preview_text_equals_sent_payload` in the test suite.

Streaming: deltas land on `onEvent` as `StreamEvent`s:
```ts
type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };
```

The call is fronted by a circuit breaker (3 failures / 60s window / 30s cool-down). When Open, the command errors immediately with `AppError::Ai { message: "AI service unavailable: circuit open …" }` instead of hanging.

#### `cmd_list_ai_models`
- args: none
- returns: `string[]` — model ids reported by `{baseUrl}/models`
- errors: `Ai` (URL refused or transport failure)

#### `cmd_test_ai_connection`
- args: none
- returns: `{ reachable: boolean; first_model_id: string | null; message: string }`
- errors: `Ai` (validation error before the call)

Deliberately bypasses the circuit breaker's `check()` — an operator clicking "Test connection" wants a real probe even when the breaker is Open. The outcome still feeds the breaker.

#### `cmd_save_ai_response_as_note`
- args: `{ aiRequestId: string; noteType: string; body: string; locator: string; chapterLabel?: string }`
- returns: `Note`
- errors: same as `cmd_save_ai_preview_as_note`

#### `cmd_list_ai_requests`
- args: none
- returns: `AiRequest[]` — the AI audit trail, newest first, with the book title LEFT-JOINed (`book_title` is null if the book was removed)
- errors: `Db`

```ts
type AiRequest = {
  id: string;
  book_id: string;
  book_title: string | null;
  mode: string;
  locator: string | null;
  context_char_count: number | null;
  provider: string | null;   // null = preview that never left the machine; else the host an Ask call was sent to
  created_at: string;
  wrote_to_memory: boolean;   // true = this request became a Note (kept past the retention window)
};
```

Backs the AI request history viewer (adr-001). Added in 0.1.x; additive, `COMMAND_API_VERSION` stays `1`.

#### `cmd_forget_ai_history`
- args: none
- returns: `number` — count of audit rows deleted
- errors: `Db`

Applies the retention window now ("Forget now"): deletes `ai_requests` rows older than `ai_requests_retention_days` that have `wrote_to_memory = 0`. Rows that became a note are kept. Added in 0.1.x; additive.

---

### Settings

#### `cmd_get_settings`
- args: none
- returns: `SettingsDto`
- errors: `Db`

```ts
type SettingsDto = {
  export_path: string;
  export_path_is_default: boolean;
  app_data_path: string;
  ai_posture: string;        // "Local-only mode: ON" / "OFF"
  ai_base_url: string;
  ai_model: string;
  ai_local_only: boolean;
  quote_policy: string;
  quote_warn_chars: number;
  ai_requests_retention_days: number;  // AI audit retention window (adr-001); 0 = keep forever
};
```

#### `cmd_set_export_path`
- args: `{ path: string }`
- returns: `SettingsDto` (updated)
- errors: `Config` (bad path), `Io` (mkdir fails)

#### `cmd_set_ai_settings`
- args: `{ baseUrl?: string; model?: string; localOnly?: boolean; retentionDays?: number }`
- returns: `SettingsDto` (updated)
- errors: `Ai` (non-loopback URL rejected while local-only ON), `Config` (turning local-only ON while URL is non-loopback), `Db`

`retentionDays` sets the AI audit retention window (adr-001), clamped to ≥ 0 (0 disables the sweep). It can be set independently of the AI URL/model fields. Added in 0.1.x; additive, `COMMAND_API_VERSION` stays `1`.

---

## Privacy invariants

- **Local-only mode (default ON):** `cmd_ai_ask` and `cmd_list_ai_models` refuse any non-loopback URL at the call site via `ai_client::validate_base_url`. Test: `local_only_rejects_remote_and_allows_loopback`.
- **Selection-only context:** every AI command takes a `selection` field; the book body is never sent in bulk.
- **Save-by-approval:** `ai_requests.wrote_to_memory` flips to 1 only via the explicit save commands. No autonomous writes from AI output.
- **Auditable + bounded (adr-001):** every preview and Ask call is logged to `ai_requests` and visible via `cmd_list_ai_requests`; `provider` distinguishes a preview (never sent) from a real call (the host). A launch sweep + `cmd_forget_ai_history` delete rows older than `ai_requests_retention_days` that never became a note, so discarded previews fade while the save-by-approval trace persists.
- **No telemetry:** structured logs go to `{app_support}/logs/app.log` and never leave the machine.

---

## Frontend version check

Recommended startup pattern:

```ts
import { invoke } from "@tauri-apps/api/core";

const FRONTEND_EXPECTED_API_VERSION = 1;

async function checkBackend() {
  try {
    const v = await invoke<number>("cmd_api_version");
    if (v !== FRONTEND_EXPECTED_API_VERSION) {
      throw new Error(
        `Backend API v${v} doesn't match frontend expected v${FRONTEND_EXPECTED_API_VERSION}. ` +
        `Rebuild the Tauri shell.`
      );
    }
  } catch (e) {
    // surface to user; refuse to make further calls
  }
}
```

(ReadingGym ships frontend + backend in the same binary, so this is mostly a refactoring safety net rather than a deployment-time check. But it's wired so a future split deploy works.)

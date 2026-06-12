# Throughline IPC Contract

The Rust backend exposes commands to the React frontend via Tauri's `invoke` bridge. This document is the binding contract: argument names, types, return shapes, error shapes, and the semver commitment for changes.

The current API version is **6**. Read it at runtime from the frontend via `invoke("cmd_api_version")`.

> **1 → 2:** `cmd_import_book` now returns `ImportOutcome { book, created }` instead of a bare `Book`. Return-shape change → major bump.
>
> **2 → 3:** cloud AI command surface (provider keys, model listing, Codex device login, request history) reshaped the AI args/returns.
>
> **3 → 4:** plan lifecycle — migration v008 added the lifecycle axis (`active` | `paused` | `completed` | `archived` | `superseded`) to the plan rows JS receives, and the plan-management command family landed against it (`cmd_list_plans_for_book`, `cmd_get_active_plan`, pause / resume / archive / delete).
>
> **4 → 5:** plans frontispiece — migration v009 added `name`, `deleted_at` (soft-delete window), and `reached_percent` to `reading_plans`; plan rows and the plans list reshaped around naming + let-go semantics.
>
> **5 → 6:** notes export reshaped from one Markdown file **per note** (`Notes/{book}_{note}.md`) to one per-book **literature note** (`Books/{slug}.md`) that re-exports idempotently in place. `cmd_save_note` / `cmd_update_note` / `cmd_save_ai_preview_as_note` / `cmd_save_ai_response_as_note` now write that shared book file (each note's `exported_markdown_path` points at it); delete-note re-merges the file (dropping the note's fence) rather than removing a per-note file; and the new `cmd_export_library` regenerates every book file. The on-disk export contract a JS caller observes changed.

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
- returns: `number` — the value of `COMMAND_API_VERSION` (currently `6`)
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
- args: `{ bookId: string; targetFinishDate: string; daysPerWeek: number; sessionMinutes: number; marginHelp?: "quiet" | "guided" | "deep_study" }` — `targetFinishDate` is `YYYY-MM-DD`
- returns: `ReadingPlan` (the updated plan)
- errors:
  - `NotFound` — no plan for the book
  - `Validation` — finish date unparseable or in the past
  - `Db` — sqlite error

Configures a freshly imported book's plan from the Book Setup Sheet: sets the target finish date and days-per-week, recomputes the daily section target, and persists the reading rhythm (`reading_rhythm_minutes`) and `margin_help` settings. `marginHelp` is one of `quiet` | `guided` | `deep_study` (validated against `settings::MARGIN_HELP_LEVELS`; an unrecognized value falls back to the `guided` default). **Does NOT activate the plan** — status stays `plan_ready`, so the book remains "not behind" until the first reading session (Priority 0). Added in `COMMAND_API_VERSION` 2 (new command; additive on its own).

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

### Discover (public-domain catalogue)

> **Network note.** These are the only two commands that reach a remote host that is not an AI provider. Both are **reader-initiated** — they run on a click, never on a timer, launch, or in the background — and only fetch *incoming* public-domain text; no source text or reader data is ever sent out. The upstream catalogue service is intentionally never named in the UI ("the public-domain library"). Added in `COMMAND_API_VERSION` 2 (additive).

#### `cmd_discover_search`
- args: `{ query?: string | null; page?: number | null; languages?: string | null }` — `query` empty/omitted ⇒ most-downloaded; `page` is 1-based; `languages` defaults to `en`
- returns: `DiscoverPage { count: number; next_page: number | null; results: DiscoverBook[]; offline: boolean }` (see types.ts). `count` is the catalogue size for the requested query; `next_page` is null at the end of results; `offline` is `true` when results came from the bundled seed (see below).
- errors:
  - `Io { message }` — only if even the offline seed is unavailable (the live path failing no longer errors — it degrades; see below)

Results are sorted by popularity. The live path restricts to titles that expose a `text/plain` format (importable) and `DiscoverBook.txt_url` / `epub_url` are opaque download URLs echoed straight back to `cmd_import_from_gutendex`.

**Offline fallback.** The live catalogue is a single third-party service. If it is unreachable (timeout / connect / non-2xx / unparseable body), the command does **not** error — it falls back to a bundled offline seed (`src-tauri/resources/discover_seed.json`, the top ~200 most-downloaded public-domain books, `include_str!`-embedded) and returns those results with `offline: true`. The seed is searched by case-insensitive substring over title/author, popularity-ordered, paged like the live path; an empty query is idle browse. Seed rows derive their `txt_url`/`epub_url` from the book id (`gutenberg.org/cache/epub/{id}/pg{id}.txt|.epub`), so importing a seeded book never touches the search API. A **successful** live response with zero results is returned as-is (`offline: false`) — only a transport/HTTP/parse failure triggers the fallback, so a genuine "no matches" is never masked by unrelated seed books. The seed is regenerated offline by `scripts/build-discover-seed.mjs`; it is build-time tooling, not shipped or run at runtime.

#### `cmd_import_from_gutendex`
- args: `{ book: { txt_url: string | null; epub_url: string | null } }` — pass the chosen row's URLs verbatim
- returns: `ImportOutcome { book: Book; created: boolean }` — identical shape to `cmd_import_book`, so the frontend routes to Plan setup the same way (Setup Sheet only when `created: true`).
- errors:
  - `Io { message }` — download failed / interrupted, or the import pipeline failed for both formats
  - `Validation { message }` — the row carried no importable format

Downloads the chosen book and imports it through the **same owned path** as the file picker (`books::import_or_dedup`), so SHA dedup, the immutable source copy, and the default plan all happen in one place. Prefers plain text and falls back to EPUB — both because some titles ship only one and because Gutenberg's legacy `.txt` is often latin-1, which the strict-UTF-8 text importer rejects (the EPUB then carries its own encoding). Re-importing a book already present dedups to it (`created: false`) just like the file picker.

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

Side effects: inserts a `notes` row, then regenerates the book's **literature note** at `{export_root}/Books/{slug}.md` (one Markdown file per book; the note becomes an atomic, fenced unit inside it). The returned note's `exported_markdown_path` points at that shared book file.

#### `cmd_update_note`
- args: `{ noteId: string; noteType?: string; body?: string; shortQuote?: string; anchoredText?: string; clearShortQuote?: boolean; clearAnchoredText?: boolean }`
- returns: `Note` — the updated row
- errors: `NotFound` (note), `Db`, `Io` (re-export failure)

COALESCE semantics: an absent field is left unchanged, so autosave can PATCH just the `body` without clobbering type/quote. Because absent means "unchanged", the `clearShortQuote` / `clearAnchoredText` booleans are the only way to NULL `short_quote` / `anchored_text` once set — the clears apply AFTER the COALESCE patch, even in the same call (CORE-1023). Both flags are **additive/optional** (a minor change — no version bump). Re-merges the book's `Books/{slug}.md` literature note idempotently — the note's fenced block is replaced in place and any reader edits OUTSIDE the fences survive.

#### `cmd_list_notes`
- args: `{ bookId: string }`
- returns: `Note[]` (newest first)
- errors: `Db`

#### `cmd_quote_warns`
- args: `{ quote: string }`
- returns: `boolean` — true if the quote exceeds the ~300 char fair-use threshold
- errors: never

#### `cmd_export_library`
- args: none
- returns: `{ exported: number; root: string }` — how many book literature notes were (re)generated and the export root they landed under
- errors: `Db`

Regenerates EVERY book's literature note (`{export_root}/Books/{slug}.md`) idempotently — the "Export library" action. Each book file is re-merged in place, so reader edits outside the note fences survive. New in `COMMAND_API_VERSION` 6.

---

### AI (local-only by default; see Settings)

#### `cmd_generate_prompt_preview`
- args: `{ bookId: string; mode: string; selection: string; chapter?: string; locator?: string; userNote?: string }`
- returns: `{ ai_request_id: string; mode: string; mode_label: string; prompt: string; wrote_to_memory: false; provider: null }`
- errors: `Validation` (selection too short or unknown mode); `NotFound` (book); `Db`

**No network call.** The returned `prompt` is the literal text that *would* be sent if you call `cmd_ai_ask`. The `ai_request_id` lets you save the preview as a Note via `cmd_save_ai_preview_as_note`.

`mode` must be one of: `explain`, `historical`, `vocabulary`, `socratic`, `durable_note`, `prepare_next`.

#### `cmd_save_ai_preview_as_note`
- args: `{ aiRequestId: string; noteType: string; body: string; locator: string; chapterLabel?: string; anchorStart?: string; anchorEnd?: string; anchoredText?: string; sessionId?: string }`
- returns: `Note`
- errors: `Validation` (empty body); `NotFound` (ai_request); `Db`, `Io`

Side effects: regenerates the book's literature note at `…/Books/{slug}.md` (the saved card becomes a fenced `> [!abstract] Tutor` unit inside it) and flips `ai_requests.wrote_to_memory` to 1.

The four optional fields are **additive** (a minor change — no integer API bump): legacy callers that send only the first five args still work (absent options deserialize to `null`). When present, `anchorStart`/`anchorEnd`/`anchoredText` pin the saved card in the Companion Margin — this is the path the text reader's margin **tutor card** uses, saving a `noteType: "TutorNote"` anchored to the selected passage.

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
- args: `{ provider?: string; key?: string; baseUrl?: string }` — all optional; with none, the saved settings are probed
- returns: `{ reachable: boolean; first_model_id: string | null; message: string }`
- errors: `Ai` (validation error before the call)

`provider` + `key` test a configuration BEFORE saving it (onboarding); the key is never logged or returned. `baseUrl` is a draft for the Local arm so the LM Studio detect flow can probe an address **without persisting it** (CORE-1034) — the draft is loopback-validated exactly like the saved path. All three are **additive/optional** (minor — no version bump). Deliberately bypasses the circuit breaker's `check()` — an operator clicking "Test connection" wants a real probe even when the breaker is Open. The outcome still feeds the breaker.

#### `cmd_save_ai_response_as_note`
- args: `{ aiRequestId: string; noteType: string; body: string; locator: string; chapterLabel?: string; anchorStart?: string; anchorEnd?: string; anchoredText?: string; sessionId?: string }`
- returns: `Note`
- errors: same as `cmd_save_ai_preview_as_note`

Like `cmd_save_ai_preview_as_note`, the four trailing fields are **additive/optional**; when present they anchor the saved card in the Companion Margin. Privacy note: the saved `body` is user-authored text — the literature-note export writes only that body for non-highlight notes (the AI prompt and the raw selected passage `anchored_text` are stored in the DB only, never exported; `anchored_text` reaches Markdown only as the content of a `Highlight` note, hard-capped at ~300 chars).

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
  quote_policy: string;
  quote_warn_chars: number;
  ai_requests_retention_days: number;  // AI audit retention window (adr-001); 0 = keep forever
};
```

`ai_local_only` was removed from the DTO (CORE-1021): nothing consulted it — `ai_provider` is the authoritative gate. Strictly the removal of an unused field, recorded as a minor change; no version bump. The legacy settings-table key is still written for back-compat (`cmd_set_ai_settings`), it just no longer crosses the IPC surface.

#### `cmd_set_export_path`
- args: `{ path: string }`
- returns: `SettingsDto` (updated)
- errors: `Config` (bad path), `Io` (mkdir fails)

#### `cmd_set_ai_settings`
- args: `{ provider?: string; baseUrl?: string; model?: string; retentionDays?: number; aiPhrases?: boolean }`
- returns: `SettingsDto` (updated)
- errors: `Validation` (unknown provider), `Config` (non-loopback local base URL), `Db`

`retentionDays` sets the AI audit retention window (adr-001), clamped to ≥ 0 (0 disables the sweep). `aiPhrases` turns AI session phrases on/off (Stage 3, docs/PHRASES_API.md); off means zero phrase network calls, and turning it on (like a provider change, a new key, or re-activation) resets the phrase backoff state. The returned `SettingsDto` carries the matching `ai_phrases: boolean` field. Each arg can be set independently. Additive; `COMMAND_API_VERSION` stays `1`. (The old `localOnly` arg no longer exists — the authoritative switch is `provider`.)

Backend-emitted event: `tl-phrases-updated` fires after a phrase batch is stored (fire-and-forget upsert); the frontend refreshes the Today card so the phrase slot swaps text in place. Additive, no command-surface change.

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

const FRONTEND_EXPECTED_API_VERSION = 6;

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

(Throughline ships frontend + backend in the same binary, so this is mostly a refactoring safety net rather than a deployment-time check. But it's wired so a future split deploy works.)

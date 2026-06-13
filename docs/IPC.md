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
  | { kind: "NeedsCloudConsent"; message: string }
  | { kind: "CapExhausted"; message: string }
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
- args: `{ bookId: string; sittingLengthMinutes: number; name?: string }`
- returns: `ReadingPlan` (the updated plan)
- errors:
  - `NotFound` — no plan for the book
  - `Db` — sqlite error

Configures a freshly imported book's plan from the Book Setup Sheet: clamps and stores the chosen sitting length, names the attempt (reader-provided or a friendly default), builds the derived `sittings` cache, and kicks off the optional phrase prefetch for the first sittings. **Does NOT activate the plan** — status stays `plan_ready` until `cmd_start_session`, so there is still no "behind" state before the reader begins.

#### `cmd_today`
- args: none
- returns: `TodayCard | null` — the active book's today card (see types.ts), or null if no books
- errors: `Db`, `Internal`

The "active book" is the one with the latest `last_opened_at` (or `created_at` if never opened). Updated on import and on `cmd_start_session`.

#### `cmd_read_section_text`
- args: `{ bookId: string; sectionId: string }`
- returns: `string` — the section's plain text (EPUBs are extracted to text on import and read through the same path)
- errors: `NotFound` if section missing; `Io` on file read failure

#### `cmd_read_section_structure`
- args: `{ bookId: string; sectionId: string }`
- returns: `StyleRange[]` — UTF-16 style ranges for headings, emphasis, blockquotes, etc., relative to the section text
- errors: `Io` (invalid book path)

Reads the per-book `structure.json` sidecar. Missing sidecar or missing section returns `[]`.

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

> **Network note.** Search is on-device over the bundled catalogue. Import/download reaches Project Gutenberg only after the reader chooses a title, and only fetches incoming public-domain text; no source text or reader data is ever sent out.

#### `cmd_discover_search`
- args: `{ query?: string | null; page?: number | null }` — `query` empty/omitted ⇒ most-downloaded; `page` is 1-based
- returns: `DiscoverPage { count: number; next_page: number | null; results: DiscoverBook[]; offline: boolean }` (see types.ts). `count` is the catalogue size for the requested query; `next_page` is null at the end of results; `offline` is always `false` for the full bundled catalogue search.
- errors: none

Results are sorted by popularity. `DiscoverBook.txt_url` / `epub_url` are opaque download URLs echoed straight back to `cmd_import_from_gutendex`.

The full search index is `src-tauri/resources/discover_catalogue.tsv`; the idle shelves come from `src-tauri/resources/discover_seed.json`. Both are embedded at build time and searched locally.

#### `cmd_discover_seed`
- args: `{ query?: string | null; page?: number | null }`
- returns: `DiscoverPage` from the smaller bundled shelf set, with `offline: true` retained for wire compatibility.
- errors: none

#### `cmd_import_from_gutendex`
- args: `{ book: { txt_url: string | null; epub_url: string | null } }` — pass the chosen row's URLs verbatim
- returns: `ImportOutcome { book: Book; created: boolean }` — identical shape to `cmd_import_book`, so the frontend routes to Plan setup the same way (Setup Sheet only when `created: true`).
- errors:
  - `Io { message }` — download failed / interrupted, or the import pipeline failed for both formats
  - `Validation { message }` — the row carried no importable format

Downloads the chosen book and imports it through the **same owned path** as the file picker (`books::import_or_dedup`), so SHA dedup, the immutable source copy, and the default plan all happen in one place. Prefers plain text and falls back to EPUB — both because some titles ship only one and because Gutenberg's legacy `.txt` is often latin-1, which the strict-UTF-8 text importer rejects (the EPUB then carries its own encoding). Re-importing a book already present dedups to it (`created: false`) just like the file picker.

---

### Plans

Plan rows carry both a pace `status` (`plan_ready` / `active` / `completed`) and a lifecycle (`active` / `paused` / `completed` / `archived` / `superseded`). The reader-facing plan list uses `PlanSummary { id, book_id, name, lifecycle, status, start_date, paused_days_total, session_count, note_count, reached_percent }`.

#### `cmd_list_plans_for_book`
- args: `{ bookId: string }`
- returns: `PlanSummary[]`
- errors: `Db`

Lists non-deleted plans for the book, live attempt first, with session/note counts from `reading_sessions.plan_id`.

#### `cmd_get_active_plan`
- args: `{ bookId: string }`
- returns: `PlanSummary | null`
- errors: `Db`

#### `cmd_start_new_plan`
- args: `{ bookId: string }`
- returns: void
- errors: `Db`

Creates a new plan-ready active attempt. The caller handles whether to keep, pause, or replace any existing live attempt.

#### `cmd_pause_plan`
- args: `{ planId: string }`
- returns: void
- errors: `Db`

Marks the active plan paused and snapshots progress for the plan list.

#### `cmd_resume_plan`
- args: `{ planId: string }`
- returns: void
- errors: `Db`

Reactivates a paused plan and accounts for paused days.

#### `cmd_archive_plan`
- args: `{ planId: string }`
- returns: void
- errors: `Db`

Moves an attempt out of the live plan list while preserving its sessions and notes.

#### `cmd_delete_plan`
- args: `{ planId: string }`
- returns: void
- errors: `Db`

Soft-deletes a plan for the undo window. A retention sweep later purges let-go plans past the window.

#### `cmd_restore_plan`
- args: `{ planId: string }`
- returns: void
- errors: `Db`

Undo path for `cmd_delete_plan`.

---

### Sessions, progress, plan adjustments

#### `cmd_start_session`
- args: `{ bookId: string; sectionId?: string; startLocator?: string }`
- returns: `ReadingSession`
- errors: `Db`

Side effects: inserts a row in `reading_sessions`, stamps the current live `reading_plans.id` into `reading_sessions.plan_id` when one exists, bumps the book's `last_opened_at`, and activates that plan if it was still `plan_ready`.

#### `cmd_end_session`
- args: `{ sessionId: string; endLocator?: string; minutes?: number; completedSectionIds?: string[]; summarySentence?: string }`
- returns: `ReadingSession` — the updated row
- errors: `Db`, `Io` (export failure non-fatal)

Side effects: marks every section in `completedSectionIds` as complete in `section_progress`; exports a Markdown session file.

#### `cmd_save_section_progress`
- args: `{ bookId: string; sectionId: string; locator: string; percent?: number }`
- returns: void
- errors: `Db`

Saves mid-session position for resume and advances `reading_position` with the global body offset.

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

#### `cmd_delete_note`
- args: `{ noteId: string }`
- returns: void
- errors: `Db`, `Io` (re-export failure non-fatal)

Deletes the row idempotently and regenerates the owning book's literature note, removing that note's fenced block while preserving reader edits outside Throughline fences.

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

### AI (reader-chosen provider; Local is loopback-only)

#### `cmd_generate_prompt_preview`
- args: `{ bookId: string; mode: string; selection: string; chapter?: string; locator?: string; userNote?: string }`
- returns: `{ ai_request_id: string; mode: string; mode_label: string; prompt: string; wrote_to_memory: false; provider: null }`
- errors: `Validation` (selection too short or unknown mode); `NotFound` (book); `Db`

**No network call.** The returned `prompt` is the literal text that *would* be sent if you call `cmd_ai_ask`. The `ai_request_id` lets you save the preview as a Note via `cmd_save_ai_preview_as_note`.

`mode` must be one of: `explain`, `historical`, `vocabulary`, `socratic`, `durable_note`, `prepare_next`, `section_briefing`.

#### `cmd_ai_preview`
- args: `{ mode: string; selectedText: string; bookTitle: string; author?: string | null; sectionLabel?: string | null; sectionText?: string | null }`
- returns: `{ title: string; disclosure: string; prompt: string; copy_label: string }`
- errors: `Validation` (unknown mode)

Reader-facing, network-free prompt fallback used by the setup sheet's "copy prompt" path. It deliberately omits internal prompt scaffolding.

#### `cmd_save_ai_preview_as_note`
- args: `{ aiRequestId: string; noteType: string; body: string; locator: string; chapterLabel?: string; anchorStart?: string; anchorEnd?: string; anchoredText?: string; sessionId?: string }`
- returns: `Note`
- errors: `Validation` (empty body); `NotFound` (ai_request); `Db`, `Io`

Side effects: regenerates the book's literature note at `…/Books/{slug}.md` (the saved card becomes a fenced `> [!abstract] Tutor` unit inside it) and flips `ai_requests.wrote_to_memory` to 1.

The four optional fields are **additive** (a minor change — no integer API bump): legacy callers that send only the first five args still work (absent options deserialize to `null`). When present, `anchorStart`/`anchorEnd`/`anchoredText` pin the saved card in the Companion Margin — this is the path the text reader's margin **tutor card** uses, saving a `noteType: "TutorNote"` anchored to the selected passage.

#### `cmd_ai_ask`
- args: `{ bookId: string; mode: string; selection: string; chapter?: string; locator?: string; userNote?: string; onEvent: Channel<StreamEvent> }`
- returns: `AskHandle { ai_request_id: string; prompt_sent: string; provider_host: string }`
- errors: `Validation`, `Config` (no provider/model/key), `NeedsCloudConsent` (first cloud send not confirmed), `CapExhausted` (included assistant allowance exhausted), `NotFound` (book), `Ai` (URL refused, transport failure, circuit open)

**The bytes in `messages[0].content` of the actual HTTP request equal `prompt_sent` byte-for-byte.** That invariant is pinned by `preview_text_equals_sent_payload` in the test suite.

Streaming: deltas land on `onEvent` as `StreamEvent`s:
```ts
type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };
```

The call is fronted by a circuit breaker (3 failures / 60s window / 30s cool-down). When Open, the command errors immediately with `AppError::Ai { message: "AI service unavailable: circuit open …" }` instead of hanging.

#### `cmd_confirm_cloud_send`
- args: none
- returns: void
- errors: `Db`

Records first-cloud-call consent. After this, `cmd_ai_ask` no longer returns `NeedsCloudConsent` for the chosen remote provider.

#### `cmd_model_catalog`
- args: `{ provider: string }`
- returns: `ModelInfo[]` — static ids, labels, tier, and published per-Mtok prices for the provider picker
- errors: never

#### `cmd_get_usage_summary`
- args: none
- returns: `UsageSummary { total_calls, total_cost_micros, month_cost_micros, spend_cap_cents, by_provider, by_lens, pricing_verified_at }`
- errors: `Db`

Aggregates locally recorded token usage. Pricing constants are code defaults and must be re-verified before making current pricing claims.

#### `cmd_finalize_ai_request`
- args: `{ requestId: string; provider: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number }`
- returns: `number` — computed cost in micro-dollars
- errors: `Db`

Idempotently records a usage row for an AI request. `cmd_ai_ask` also writes usage when provider stream events include it; this command is the explicit upsert path.

#### `cmd_set_monthly_spend_cap`
- args: `{ cents: number }`
- returns: void
- errors: `Db`

Sets the reader's local BYO cloud spend cap in whole cents (`0` = off). Company mode is capped server-side and is exempt from this dollar-denominated local cap.

#### `cmd_list_ai_models`
- args: `{ provider?: string; baseUrl?: string }`
- returns: `string[]` — Local returns ids reported by `{baseUrl}/models`; cloud providers return the app's curated ids
- errors: `Ai` (URL refused or transport failure)

`provider` / `baseUrl` let Settings detect models against an unsaved Local draft without persisting it first. Local remains loopback-validated.

#### `cmd_activate_company`
- args: `{ activationToken: string }`
- returns: `CompanyStatus { provider_active: boolean; has_license: boolean }`
- errors: `Validation` (bad token), `Ai` (relay unreachable), `Io`/`Config` (Keychain failure)

Exchanges a paid-build activation token for a Keychain-held license, switches `ai_provider` to `company`, resets phrase backoff, and stamps first-cloud consent.

#### `cmd_company_status`
- args: none
- returns: `CompanyStatus`
- errors: `Db`

Read-only company-provider state for Settings; uses persisted flags so it can render without prompting Keychain.

#### `cmd_company_checkout`
- args: none
- returns: `string` — checkout URL opened in the system browser
- errors: `Ai`

Reader-initiated paid checkout. The returned URL is also available to the UI as a fallback.

#### `cmd_company_credits`
- args: none
- returns: `{ status: string; remaining_fraction: number; approx_questions_left: number }`
- errors: `Config` (not activated), `Ai` (relay unreachable)

Read-only included-assistant allowance display. The server returns fractions/questions, never dollar amounts.

#### `cmd_open_support_email`
- args: none
- returns: void
- errors: never

Opens a fixed `mailto:` for requesting more included-assistant headroom. It carries no dynamic book, usage, or passage data.

#### `cmd_codex_device_start`
- args: none
- returns: `{ device_auth_id: string; user_code: string; verification_url: string; interval: number }`
- errors: `Ai`

Starts the app-owned ChatGPT/Codex device-code login. No Codex CLI shell-out.

#### `cmd_codex_device_poll`
- args: `{ deviceAuthId: string; userCode: string }`
- returns: `{ status: "pending" | "complete" | "denied"; message: string }`
- errors: `Ai`, `Db`

Polls once. On `complete`, stores app-owned Codex credentials in the Keychain and marks the non-secret credential-present flag.

#### `cmd_codex_logout`
- args: none
- returns: `SettingsDto`
- errors: `Config`, `Db`

Clears app-owned Codex credentials. It does not modify the Codex CLI's own login.

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
  ai_posture: string;        // human label for the real send target
  ai_base_url: string;
  ai_model: string;
  quote_policy: string;
  quote_warn_chars: number;
  ai_requests_retention_days: number;  // AI audit retention window (adr-001); 0 = keep forever
  margin_help: "quiet" | "guided" | "deep_study";
  ai_provider: "local" | "openai" | "anthropic" | "codex" | "company" | "none" | "";
  ai_provider_chosen: boolean;
  ai_remote_allowed: boolean;
  ai_model_openai: string;
  ai_model_anthropic: string;
  ai_model_codex: string;
  ai_key_present_openai: boolean;
  ai_key_present_anthropic: boolean;
  ai_codex_creds_present: boolean;
  ai_phrases: boolean;
};
```

`ai_local_only` was removed from the DTO (CORE-1021): nothing consulted it — `ai_provider` is the authoritative gate. Strictly the removal of an unused field, recorded as a minor change; no version bump. The legacy settings-table key is still written for back-compat (`cmd_set_ai_settings`), it just no longer crosses the IPC surface.

#### `cmd_set_export_path`
- args: `{ path: string }`
- returns: `SettingsDto` (updated)
- errors: `Config` (bad path), `Io` (mkdir fails)

#### `cmd_check_export_path`
- args: none
- returns: `{ path: string; writable: boolean; message: string | null }`
- errors: never

Launch-time preflight for the effective export root. It does not create the default `~/Documents/Throughline` folder; a missing folder is considered writable until the first reader-initiated export creates it.

#### `cmd_set_ai_settings`
- args: `{ provider?: string; baseUrl?: string; model?: string; retentionDays?: number; aiPhrases?: boolean }`
- returns: `SettingsDto` (updated)
- errors: `Validation` (unknown provider), `Config` (non-loopback local base URL), `Db`

`retentionDays` sets the AI audit retention window (adr-001), clamped to ≥ 0 (0 disables the sweep). `aiPhrases` turns AI session phrases on/off (Stage 3, docs/PHRASES_API.md); off means zero phrase network calls, and turning it on (like a provider change, a new key, or re-activation) resets the phrase backoff state. The returned `SettingsDto` carries the matching `ai_phrases: boolean` field. Each arg can be set independently. Additive; `COMMAND_API_VERSION` stays `1`. (The old `localOnly` arg no longer exists — the authoritative switch is `provider`.)

Backend-emitted event: `tl-phrases-updated` fires after a phrase batch is stored (fire-and-forget upsert); the frontend refreshes the Today card so the phrase slot swaps text in place. Additive, no command-surface change.

#### `cmd_set_ai_key`
- args: `{ provider: "openai" | "anthropic"; key: string }`
- returns: `SettingsDto`
- errors: `Validation` (empty key), `Config` (Keychain failure), `Db`

Stores a BYO provider key in the OS Keychain. The key is never returned; only the matching `ai_key_present_*` flag is exposed.

#### `cmd_clear_ai_key`
- args: `{ provider: "openai" | "anthropic" }`
- returns: `SettingsDto`
- errors: `Config` (Keychain failure), `Db`

Deletes a stored BYO provider key idempotently and refreshes the non-secret presence flag.

---

## Privacy invariants

- **Provider is authoritative:** `ai_provider` decides where AI calls go; the legacy `ai_local_only` key is back-compat only and is not exposed to JS.
- **Local provider is loopback-only:** when `ai_provider = "local"`, `cmd_ai_ask` and `cmd_list_ai_models` refuse non-loopback URLs at the call site via `ai_client::validate_base_url`. Test: `local_only_rejects_remote_and_allows_loopback`.
- **Selection/section-only context:** tutor lenses send the selected passage; Deep Study sends only the current section after the reader chose Deep Study, started a session, and consented. The book body is never sent in bulk.
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

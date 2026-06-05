# Changelog

All notable changes to Throughline are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver. The
Tauri command surface has its own version (`COMMAND_API_VERSION`, currently 1)
documented in [`docs/IPC.md`](./docs/IPC.md).

## [Unreleased]

### Added

- **Auto-update (reader-initiated).** Settings → Software → Updates checks for a
  new version *only when you click* — never on launch or a timer — then downloads
  the signed package and relaunches into it, like the Claude desktop app. Built
  on `tauri-plugin-updater` + `tauri-plugin-process` (not the banned http/shell
  plugins); the update is verified against a minisign public key in the config.
  See [`docs/UPDATES.md`](./docs/UPDATES.md) for the release/signing pipeline.
- **Discover — find a book to read.** A calm, search-first card catalogue for
  importing public-domain books, reached from the Welcome card and the
  book-switcher menu ("Find another book"). Live search by title/author, ranked
  by downloads, with Get → Saving → In library button states; choosing a book
  downloads it and routes straight into Plan setup. Local `.txt`/`.epub` import
  via the file picker remains as the secondary path. Two additive commands:
  `cmd_discover_search` and `cmd_import_from_gutendex` (`COMMAND_API_VERSION`
  stays 2). Downloaded books funnel through the same owned import path as the
  file picker (`import_or_dedup`), so SHA dedup, source immutability, and the
  default plan are identical.
  - **Reader-initiated network egress (new for this app).** Until now the app
    made no outbound requests except reader-triggered AI calls. Discover adds a
    second reader-initiated network surface: a search or a Get **only** fires on
    a click — never on a timer, on launch, or in the background. Only *incoming*
    public-domain text crosses the wire; no source text or reader data is ever
    sent out, consistent with the copyright/privacy posture. The catalogue's
    upstream service is never named in the UI — it is "the public-domain
    library". (This is a deliberate broadening of the app's network posture and
    is called out for review against `CLAUDE.md` / `docs/PRD.md`.)
  - **Offline resilience (no single point of failure).** The live search API is
    a single volunteer-run service; when it is unreachable, Discover now falls
    back to a **bundled offline catalogue** of the top ~200 most-downloaded
    public-domain books (`src-tauri/resources/discover_seed.json`, ~26 KB,
    `include_str!`-embedded) so idle browse and search of popular titles keep
    working, flagged with a calm "offline catalogue" hint. Downloads were already
    independent of the search API — getting a book hits Project Gutenberg's own
    file servers — and seeded books now derive those URLs straight from the book
    id, so a Get never needs the API at all. The seed is rebuilt offline by
    `scripts/build-discover-seed.mjs` from Project Gutenberg's own published feeds
    (the catalog CSV + the public Top-1000 list), never by crawling. A genuine
    "no live matches" is **not** masked by the seed — only a transport failure
    triggers the fallback. `DiscoverPage` gained an `offline` flag.
  - **Instant open (no spinner wait).** Discover now paints the bundled seed
    *immediately* on open (and for a query's seed matches) via the new
    network-free `cmd_discover_seed`, then upgrades to the full live catalogue in
    the background when the API answers — so it never blocks on the live API's
    timeout. Previously the first open sat on a "Searching the library…" spinner
    for the full live timeout before showing anything; now the popular list is up
    in milliseconds and "Show more" pages the seed instantly while offline.
- **Plan setup, re-skinned.** The Book Setup Sheet now uses the design system's
  calm rhythm — one unified segmented-pill control (`.tl-choice`) for every
  choice group, a single quiet muted reading-time estimate (never a colored
  alert box), and a pinned action bar. Behaviour and the real char-based
  estimate are unchanged; radio semantics (WCAG-AA) are preserved.
- **Instant theme flip** now suppresses transitions for one frame around a
  `data-theme` change (`.tl-no-transition`), so themed controls re-resolve their
  token colors on a runtime flip instead of stranding the previous theme's ink.
- **Book switcher** — a quiet chip in the Today header lists every imported
  book and switches the active one in place. Backed by the new additive
  `cmd_set_active_book` command (bumps `last_opened_at`; `COMMAND_API_VERSION`
  stays 1).
- **Notes browser** — a "Notes" tab on the book page lists the active book's
  notes (newest first), read-only. The app still opens to Today.
- **AI request history viewer (adr-001).** Settings → AI now shows every prompt
  preview and Ask call, newest first, each labelled as a preview that never left
  the machine or a call sent to a host — the audit trail that makes the
  local-only posture real rather than asserted. Commands: `cmd_list_ai_requests`,
  `cmd_forget_ai_history` (additive; `COMMAND_API_VERSION` stays 1).

### Changed

- **Renamed: ReadingGym → Throughline.** A complete rename across the codebase —
  display name and window title, the Cargo crate (`reading-gym` → `throughline`)
  and library (`reading_gym_lib` → `throughline_lib`), the bundle identifier
  (`com.throughline.app`), the Keychain service (`com.trainable.throughline`),
  the macOS data directory (`~/Library/Application Support/Throughline`),
  env-var prefixes (`THROUGHLINE_*`), and the entire `rg-`/`RG` design-system
  namespace (CSS classes → `tl-`, tokens → `--tl-`, `RGIcon` → `TLIcon`). The
  data directory and Keychain service are **not** migrated (clean break): the
  renamed app starts fresh, so an existing install re-imports its books and
  re-enters API keys once. The old `~/Library/Application Support/ReadingGym`
  directory and `com.trainable.readinggym` Keychain items are left in place for
  the user to remove.
- **Import is now idempotent (dedup).** Re-importing a file whose SHA-256
  already matches an imported book no longer creates a duplicate — the existing
  book is made active and returned. Additive; `COMMAND_API_VERSION` stays 1.

### Fixed

- **Commercial-readiness pass (adversarial review).** A multi-lens review before
  pricing surfaced and fixed: (1) **Export-folder setting was a no-op** — Settings
  confirmed a new folder but every export still wrote to `~/GBrain/Reading`; the
  configured path is now threaded through all exports (`export::root_for`) and
  reported by `cmd_paths_info`. (2) **A failed initial load stranded the app on a
  permanent "Loading…"** — now an honest error + retry. (3) **The app crash-looped
  on a corrupt database** — it now preserves the corrupt file and starts fresh
  (environmental errors still fail loudly, never wiping data). (4) **The Notes tab
  was unstyled** after the rename — five classes restyled. (5) **Roman-numeral
  detection matched ordinary words** ("MIX"/"DID"/bare "I") — now validates a
  canonical numeral.
- **Sectionizer hardened across book structures.** Verified against 18 real
  Project Gutenberg books of every shape. Fixes: **multi-volume works no longer
  lose volumes** (a contents list is detected as a leading *packed run*, length-
  gated so a "Book I → Chapter 1" cluster is preserved while a real contents list
  is dropped — earlier dedup-by-label deleted restarting chapters); **roman-numeral
  contents with titles** (Dracula, Tom Sawyer) no longer leak their last chapter
  in as section 0; heading-only stubs ("Book One") fold into the next section with
  no empty sections.
- **AI model detection broke when switching providers.** `cmd_list_ai_models`
  defaulted to the *saved* provider (listing the wrong models), and nothing
  re-detected on a switch; it now uses the *draft* provider + base URL and
  re-detects whenever either changes, so switching back to Local repopulates the
  LM Studio model list.
- **Tutor responses cut off mid-sentence.** Token ceilings sat exactly at the
  prompt's word target with no headroom, so a thorough model got guillotined; the
  caps are now a backstop with ~2–2.5× headroom (the prompt still governs length).
- **Plan-setup circle numbers were off-center** — the choice buttons are now
  flex-centered.
- **Constant macOS Keychain prompts.** Opening the app (and Settings) fired 2–3
  Keychain authorization prompts because `cmd_get_settings` read each provider's
  secret just to display a "key present" checkmark — and reading a Keychain item
  is exactly what prompts (dev rebuilds re-arm it by changing the signature). Now
  presence is tracked by a non-secret boolean flag in the settings table (seeded
  once from the Keychain, then persisted), so launch/Settings never decrypt a key
  and never prompt. The secret is also cached in process memory per session, so
  actual AI use reads the Keychain at most once per launch instead of per call.
  Keys still live only in the OS Keychain — never in a file or the DB.
- **Table-of-Contents books showed empty chapters.** The sectionizer matched the
  `Chapter 1 … Chapter N` lines in a book's *contents list* as chapter starts, so
  every "section" was a ~12-char list entry and the reader rendered a heading
  with no body (e.g. Frankenstein). `detect_chapters` now (a) **dedups headings
  by label, keeping the last occurrence** — a contents-list entry duplicates the
  real body heading, which robustly catches a list whose final entry sits a
  chapter's-worth of *front matter* before the body (Moby Dick lists every
  chapter + Etymology/Extracts before Chapter 1, so its last list entry —
  "Chapter 135" — was leaking in as section 0, ahead of Chapter 1); (b) keeps a
  heading only when prose follows it (gap backstop); (c) preserves pre-chapter
  front matter as its own section; and (d) recognises `Letter N` / `Epilogue` /
  `Prologue` headings. A one-shot operator tool, `cargo run --example
  repair_sections`, rebuilds the sections of already-imported txt books from
  their saved source (non-destructive; skips books with reading history) so they
  don't need re-importing.

### Engineering

- **Frontend test suite (Vitest).** Added Vitest + React Testing Library with
  jsdom; `npm test` runs the suite and CI gates on it. Initial coverage: locator
  /error helpers, the notes browser, the book switcher, and the Today screen.
- **Shipped ADR-002** (cto-kb `adr-002-throughline-sqlite-synchronous-normal`):
  set `PRAGMA synchronous = NORMAL` alongside WAL — one fsync per commit instead
  of two, with no corruption risk (the durable artifact is the Markdown export).
- **Recorded ADR-003** (cto-kb `adr-003-throughline-schema-migrations-table`):
  the `schema_migrations` provenance table shipped in Shot 6a; the ADR is now
  reconciled to the as-built implementation and marked accepted.
- **Shipped ADR-001** (cto-kb `adr-001-throughline-ai-requests-retention`): the
  `ai_requests_retention_days` setting (default 90) and a once-per-launch sweep
  delete audit rows older than the window that never became a note; rows saved
  as notes are kept. Pinned by `sweep_deletes_old_unsaved_keeps_saved_and_recent`.

## [0.1.0] — 2026-05-28

First release. The complete core loop plus a local AI tutor, built as a
local-first macOS desktop app (Tauri v2 + React + Rust + SQLite).

### The loop

- **Import** a plain-text or DRM-free EPUB. Source files are copied immutably
  into app storage (chmod 444), SHA-256-hashed, and recorded with a manifest.
- **Plan** — a 30-day reading plan is generated, assigning sections across days
  with pace tracking (on-pace / behind / recovery).
- **Today screen** is the default surface: current book, today's section,
  estimated minutes, monthly %, pace state, and a gentle streak. One dominant
  "Start Reading" button.
- **Reader** — calm typography with adjustable font size / line width and
  light/dark themes. Plain text uses paragraph-anchored char-offset resume;
  EPUB renders via epub.js with CFI locators. One session spans a sitting;
  Next/Prev move through the canonical (assignable-only) section sequence.
- **Notes** — five note types (Observation / Question / Connection / Reflection
  / Short Quote) with auto-filled locators and a ~300-char fair-use quote
  warning.
- **Export** — notes, sessions, and book records export as Markdown to
  `~/GBrain/Reading/` with stable filenames and `source_private: true`
  frontmatter. Writes are atomic (temp + fsync + rename).

### EPUB handling

- Front/back-matter classifier skips cover / title page / contents / copyright /
  acknowledgments / about-the-author so day 1 of the plan is the first real
  chapter, not boilerplate.
- A single canonical reading sequence (assignable sections only) is the source
  of truth for reader position, navigation, and progress.

### Recovery

- Shame-free recovery options surface when behind: "Next smallest step: 10
  minutes", resume today, gentle catch-up, weekend catch-up, extend finish date,
  restart current chapter. Streaks are gentle, never punitive.

### AI tutor (local-only by default, enforced)

- Six tutor modes (Explain / Historical context / Vocabulary / Socratic
  questions / Extract durable note / Prepare tomorrow's reading).
- **Local-only mode is enforced in code**: the client refuses any non-loopback
  URL while local-only is ON. Turning it off requires an explicit confirm.
- Selection-only context (bounded to ~2000 chars); the book body is never sent
  in bulk. Untrusted-passage fences guard against prompt injection from book
  text.
- Streams responses from a local OpenAI-compatible endpoint (LM Studio default,
  `http://localhost:1234/v1`). Model dropdown populated from `/v1/models`.
- Save-by-approval: AI output is ephemeral until you explicitly save it as a
  note. A circuit breaker fails fast when the local server is down instead of
  hanging.

### Engineering

- Typed `AppError` enum across the IPC boundary (`{ kind, message }` to JS).
- Versioned `schema_migrations` table with idempotent migrations.
- Structured logging via `tracing` to a local JSONL log (no telemetry).
- Modular command layer under `src-tauri/src/commands/`.
- Accessibility floor: keyboard focus management + Esc-to-close on all modals,
  `role="dialog"` + focus trap, color-independent pace indicators, skip-to-main
  link, landmark regions.
- 71 Rust unit tests + 2 mock-HTTP integration tests. A build-time guardrail
  prevents test/acceptance binaries from writing to the real database.

### Known limitations

- macOS only (data paths are macOS-specific).
- Signed + notarized releases require Apple Developer ID secrets (see
  [docs/SIGNING.md](./docs/SIGNING.md)); local `tauri build` is unsigned.
- One book is "active" at a time; no in-app library browser or book switcher yet.
- No in-app notes browser (notes live in the exported Markdown).
- No frontend (React) test suite yet.

[0.1.0]: https://github.com/nferna26/throughline/releases/tag/v0.1.0

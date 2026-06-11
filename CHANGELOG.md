# Changelog

All notable changes to Throughline are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver. The
Tauri command surface has its own version (`COMMAND_API_VERSION`, currently 5)
documented in [`docs/IPC.md`](./docs/IPC.md).

## [0.5.2] - 2026-06-10

### Fixed

- **Part-divider pages look intentional.** A page that holds only a part title
  (like "Part I. Thesis") is now centered on the page instead of stranded at the
  top of a mostly-blank sheet.
- **The margin stays reachable while you read.** Scrolling down through a book no
  longer carries the top of an open tutor card out of reach — the margin keeps its
  place beside the text.

## [0.5.1] - 2026-06-10

### Changed

- **A calmer tutor card.** In the new slim margin, the tutor's buttons were
  wrapping awkwardly. The card is tidied: the actions now read **Go deeper ·
  Save · ↻** on a single line, "Question me" is gone (it did exactly what the
  "Ask questions" lens already does), and the small print is plainer — "On this
  Mac" instead of "Local-only," and the assistant's name without the "via."

## [0.5.0] - 2026-06-10

The reading page, rebuilt around the book.

### Changed

- **A book on a desk.** The page and your margin now sit as one centered
  composition — open or closed, on a small window or a maximized one, the text
  stays balanced in the middle instead of drifting to one side. Opening the
  margin slides the page over to make room, like sliding a book across a desk;
  an empty margin is just a quiet line, not a blank panel.
- **Real book typography.** Books now open like books. A title page is a title
  page — centered title, byline, a hairline rule — a table of contents reads as
  one (in two columns when it's long), an epigraph sits apart in italics, and
  each chapter opens with its name and an unhurried first paragraph. This holds
  whether you bring an EPUB or a plain-text book.
- **Books are organized by chapter.** A plain-text book's front matter (its title
  page and contents) is now kept separate from the reading itself, so your first
  section is the first real chapter — not the title page — and the book is paced
  chapter by chapter.

> Note: the typography and chapter structure apply to books added from this
> version on. To see them on a title you already have, get it again from Discover.
> The new page-and-margin layout applies to every book right away.

## [0.4.6] - 2026-06-10

### Fixed

- **The page holds the whole section again.** A long section no longer spills off
  the bottom of the page onto the surrounding desk as you scroll — the page grows
  to contain all of its text.
- **The drop cap stays on real prose.** It no longer lands on an all-caps title or
  a table-of-contents line; it opens the first true paragraph, as intended.

## [0.4.5] - 2026-06-10

The reading page — the heart of the app — got the care it deserves.

### Changed

- **A page on a desk.** The reading column now sits as a quiet sheet centered in
  the window, and it no longer jumps sideways when you open the margin — the
  space for your notes is always held, whether the margin is open or not. On a
  big screen the surrounding room reads as a calm desk rather than a marooned
  column.
- **Real book typography.** Plain-text books now render the way they were meant
  to: words the author italicized are italic (no more stray underscores),
  chapter and section headings stand apart as centered small caps, and each
  section opens with a drop cap. Project Gutenberg's `[Illustration]` placeholders
  no longer clutter the page.

> Note: this applies to books added from this version on. To see it on a title
> you already have, get it again from Discover.

## [0.4.4] - 2026-06-10

The rest of the field-test polish — the reader-felt seams across Today, the
reader, and the smaller corners.

### Changed

- **A calmer Today.** The home screen no longer re-prints the opening of the
  section you're about to read (that "before you read" excerpt only appears now
  when you're resuming mid-section), no longer says "plan ready" three times,
  and no longer greets a brand-new book with "0% complete" or "you read 0 of the
  last 7 days." The first reading prompt reads true for any book, not just
  argument-driven nonfiction.
- **The margin reading-help gauge is visible again** (its fill had no color),
  and shows amber when it's running low.

### Added

- **Keyboard paging in the reader.** Space, Shift-Space, Page Up/Down, the arrow
  keys, Home and End all move through the text.

### Fixed

- **Leaving the reader keeps your progress.** Exiting with the back button (not
  just "Finish") now records the sections you read and the time you spent — Today
  won't hand you a chapter you've already finished.
- **Undo for a deleted highlight.** The × on a margin card now offers a few
  seconds to undo instead of deleting on the spot.
- **No more silent failures.** A book that can't be opened shows a clear message
  with a retry instead of a blank page; a takeaway you type is saved even if the
  session had trouble starting; a failed "Get" in Discover says what happened;
  the paid assistant's error card never shows raw technical text; and a failed
  update check explains itself in plain words.
- **Quieter assistant.** A reading briefing that fails no longer silently
  re-sends itself as you move between sections.
- Saved tutor answers are labeled "Tutor card" in your notebook (not a raw
  internal name); recovery-plan errors read as alerts, not calm green.

## [0.4.3] - 2026-06-10

### Added

- **A real app icon.** Throughline now has its own mark — the Throughline "T"
  — in the Dock, Finder, and beside the name in the window (replacing the
  placeholder framework logo).

### Changed

- **A calmer Settings.** Settings is reorganized into four plain sections —
  Reading assistant, Privacy, Files, About — grouped by what you actually touch.
  The reading-help meter now shows your true remaining allowance (not a fixed
  decoration); the record of what's been sent to the assistant is collapsed,
  plainly worded, and reassuring rather than a wall of alarm-colored rows; and
  the bring-your-own-AI options (your own key, or a model on this Mac) sit
  quietly behind "Use your own AI instead" with room to enter a key, pick a
  model, and test the connection. Opening that section no longer switches your
  working assistant — nothing changes until you choose "Use this." Plumbing
  words, raw addresses, and legalese are gone from the screen.

## [0.4.2] - 2026-06-10

### Changed

- **Search is the whole library, instantly, offline.** Discover now searches
  the entire public-domain catalogue — about 77,000 books — from a copy bundled
  inside the app. Results appear as you type with no network round-trip, and
  search keeps working even with no connection. This replaces the old live
  search, which depended on an outside service that could (and did) go down,
  leaving you with only a small built-in shelf. Downloading a book you've found
  still fetches it on demand, as before. The search field now shows the true
  size of the library you're searching.

## [0.4.1] - 2026-06-10

The field-test patch: the first hour with v0.4.0 on a real Mac found nine
walls; this release removes them.

### Fixed

- **The window moves.** Dragging by the titlebar works (the build never asked
  macOS for permission to start a drag).
- **The paid tutor recovers honestly.** Section briefings no longer fail with a
  cryptic rejection; one bad request can no longer pause all AI for 30 seconds;
  and when Throughline AI genuinely can't answer, the message tells the truth —
  no "nothing has been sent" after a send, no key-pasting detour for a
  one-time-purchase reader.
- **Finishing a section by reading it counts.** Reaching the end of the text
  marks the section done — previously only paging past it did, so Today could
  repeat chapters and call a daily reader "behind".
- **Errors show up.** Import, book-switch, and new-plan failures appear in the
  app (they were sent to a dialog macOS never shows).
- **Honest search when offline.** If the full library can't be reached, search
  says it only covered a built-in starter shelf — it no longer claims a book
  "isn't in the public-domain library".
- **The tutor toggle tells the truth.** It's named "AI tutor" and says where
  answers actually come from, instead of claiming everything is local.
- **Updates work from here on.** Releases publish the moment a version tag
  builds — no manual publish step to forget (the step that left every previous
  release invisible to the updater).

## [0.4.0] - 2026-06-10

The pre-launch hardening release: the P1 ship blockers, the P2 reader-felt
fixes, and the P3 "quality & polish" pass from the 2026-06-09 review. The
energy went into correctness, honesty, and deleting what earns nothing.

### Added

- **Drag a book in.** Dropping a DRM-free EPUB or `.txt` onto the window now
  imports it — the public promise the site already made.
- **A door for buyers.** The first-run AI sheet has an "Already bought
  Throughline AI" path, and activating (typed code or link) gives clear,
  visible success/failure feedback.

### Changed

- **The first screen tells the truth.** The welcome copy now matches what the
  tutor actually does, and Deep Study briefings are session-only — nothing is
  cached to disk.
- **Errors in your provider's terms.** Tutor failure copy is provider-aware
  (no more LM Studio instructions for a paid reader); the credits gauge says
  "Can't check right now" instead of "Almost out" when the service is merely
  unreachable; recovery options read as advice, not commitments; raw provider
  bytes never reach an error card; and a Codex sign-in refresh that can't be
  saved says so instead of silently stranding the session.

- **Your reading day is your day.** Day boundaries — the plan's day counter,
  streaks, pause/resume credit — now follow your Mac's local calendar day, never
  the UTC date, so a section finished at 9pm counts for tonight (guard-tested so
  it stays that way).
- **Plainer, more honest words.** The cloud-consent dialog names the arrangement
  you actually chose; the last plumbing words ("tokens", "endpoint", raw
  locators) are gone from reader-visible copy; Throughline AI builds no longer
  show the bring-your-own-key spend card.
- **Quieter on disk.** Throughline no longer creates the `~/GBrain` export
  folder until you first export a note, and its diagnostic log rolls daily,
  keeping only 14 days.

### Fixed

- **"Forget now" works forever.** The AI-history retention sweep no longer
  breaks permanently after the first aged cloud call (a foreign-key ordering
  bug aborted every later sweep).
- **Plans behave.** Pausing a plan stops the Today pace clock, and a book whose
  last plan is let go stays reachable instead of vanishing.
- **Failures speak.** Note-save and import failures, interrupted AI answers, and
  a failed book switch now say what happened and what to do next instead of
  failing silently; the company "Test connection" really probes the service
  instead of reporting a canned success.
- **Sturdier plumbing.** Each database migration commits in its own transaction;
  every AI provider gets its own circuit breaker, so one provider's outage can't
  lock out the others; export-path validation is hardened; `.txt` imports are
  capped at 100 MB; the LM Studio probe tests a draft address without
  overwriting a custom one; "Let go" removes a purged note's exported Markdown
  mirror along with the note.
- **Imports can't stall.** Splitting a book into sections now does bounded work
  per boundary — dropping a whitespace-free file (a minified blob, a wrongly
  renamed dataset) no longer freezes import for minutes.

### Removed

- Dead weight: two unreachable screens (the old forced AI chooser and the
  early AI panel), the unused `ai_local_only` settings field, and test-only plan
  helpers — deleted, with guard tests pinning them out. Pre-rename `rg.*`
  preference keys migrate to `tl.*` once, so an existing reader's tutor consent
  and reader preferences survive.
- The `rm -rf` rollback hint is gone from reader-facing Storage settings.

## [0.3.0] - 2026-06-09

### Added

- **Throughline AI — the tutor, set up for you ($20 once, no API key).** A new
  "Throughline AI" provider activates Claude Sonnet through Throughline's hosted
  proxy, so the margin tutor works out of the box — no key to paste, no
  subscription. A per-install allowance with a calm "credits" fuel gauge, and a
  graceful fall to your own API key or a local model when it's spent. Still
  reader-initiated and selection-scoped; your book file never leaves the Mac.
- **Purchase + activation.** Buy from Settings → Assistance, or activate a code
  from the website — a typed `XXXX-XXXX-XXXX` code or a `throughline://activate`
  deep link.
- **Finished-book moment.** Today shows a calm completion card — your notes and
  highlights, "Review your notes", and "Find another book" — instead of silence.

### Changed

- Settings' data-trust copy now names the exact endpoint a selection is sent to,
  and confirms your book file never leaves the Mac.

## [0.2.0] - 2026-06-05

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

[0.2.0]: https://github.com/nferna26/throughline/releases/tag/v0.2.0
[0.1.0]: https://github.com/nferna26/throughline/releases/tag/v0.1.0

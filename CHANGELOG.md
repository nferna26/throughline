# Changelog

All notable changes to ReadingGym are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver. The
Tauri command surface has its own version (`COMMAND_API_VERSION`, currently 1)
documented in [`docs/IPC.md`](./docs/IPC.md).

## [Unreleased]

### Added

- **Book switcher** — a quiet chip in the Today header lists every imported
  book and switches the active one in place. Backed by the new additive
  `cmd_set_active_book` command (bumps `last_opened_at`; `COMMAND_API_VERSION`
  stays 1).
- **Notes browser** — a "Notes" tab on the book page lists the active book's
  notes (newest first), read-only. The app still opens to Today.

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

[0.1.0]: https://github.com/nferna26/ReadingGym/releases/tag/v0.1.0

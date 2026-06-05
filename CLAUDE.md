# CLAUDE.md — Throughline

You are helping build **Throughline**, a local-first macOS reading app. The full spec is in `docs/PRD.md`. Read it, but treat *this* file as the binding contract when there is any tension between "what would be cool to build" and "what we agreed to build."

## The one job
Prove a single loop end-to-end: **import one book → see today's section → read it → capture one note → export safe Markdown.** Nothing in a given work session is "done" until that loop runs.

## Hard non-goals (do NOT build these, even if asked nicely, even if it seems trivial)
- No cloud sync, accounts, telemetry, or background agents.
- No OpenClaw integration. None. Not even a stub that imports it.
- No mobile app, no PDF/OCR, no DRM handling or circumvention.
- No quizzes, spaced repetition, XP, badges, streaks-as-punishment, mascots, confetti, leaderboards.
- No **background, remote, or unsolicited** AI. AI never runs on a timer, on launch, or in the background; it never calls a remote endpoint by default; it never acts without the reader's action.
- No local embeddings, no Bible mode, no nutrition/running features.
- No dashboard-first or library-first UX. The app opens to **Today**.

## AI contract (what AI MAY do)
AI is local-first and reader-initiated. Two surfaces are allowed:
1. **Tutor lenses** (Explain / Context / Define / Socratic) — fire only when the reader selects a passage and clicks a lens. Streamed from a local OpenAI-compatible endpoint; remote endpoints are refused while local-only is ON (the default).
2. **Deep Study section briefing** — a local, **session-triggered** study prep generated *only* when the reader chose **Deep Study** margin-help, **started a session**, and gave **tutor consent**. It must be **cached, dismissable, regenerable, local-only**, and **never exported unless the reader saves it**. It is study prep for the section about to be read — not an automatic summary, never generated in the background or on a schedule.

Both surfaces: selection/section context only (never the whole book), prompts + injection hardening stay server-side and are never rendered, raw source text never leaves the device, and AI output becomes a durable Note + Markdown **only when the reader explicitly saves it**.

If you think something outside this list is needed, STOP and ask in plain text before writing it.

## Copyright & privacy posture (non-negotiable)
- Raw EPUB/text source files stay local. Never exported, never sent to any API.
- Exports contain locators, paraphrases, reflections, and short quotes only.
- Every imported source gets a SHA-256 hash stored in the DB.
- Exported notes carry `source_private: true` in frontmatter.
- Warn (don't block) when a quote field exceeds ~300 characters.

## Tech constraints
- Shell: **Tauri v2**. Frontend: **React + TypeScript + Vite**. Rust commands for FS, hashing, SQLite, export.
- Operational state: SQLite at `~/Library/Application Support/Throughline/reading.db` using the exact tables in the PRD (`books`, `book_sections`, `reading_plans`, `reading_sessions`, `notes`, `ai_requests`).
- Imported books: `~/Library/Application Support/Throughline/books/{book_id}/`.
- Markdown export: `~/GBrain/Reading/{Books,Sessions,Notes,Reviews,_indexes}/`, path user-overridable.
- **Shot 1 is plain-text only. Do not add epub.js or any EPUB parsing in shot 1** — the PRD explicitly calls EPUB rendering a trap. Text first, EPUB later.

## Working style
- Smallest change that advances the loop. Prefer boring, inspectable code.
- After each phase, state the acceptance test and actually run it — don't just claim completion.
- Keep imported files immutable. Never modify a source file after import.
- Use stable IDs and predictable filenames on export so re-exporting updates rather than duplicates.
- **Acceptance/diagnostic programs MUST NOT write to the user's real database.** They live in `src-tauri/examples/` (Cargo example targets, so they are never bundled into the shipped app). Every program under `src-tauri/examples/` must either:
  (a) call `bin_guardrail::init_isolated_data_dir(...)` as the first line of `main()` (test programs), OR
  (b) appear in the `REAL_DB_ALLOWLIST` of the `bin_guardrail_acceptance_binaries_use_isolated_data_dir` test in `lib.rs` (operator-facing inspection tools).
  A test in the suite enforces this. Do not silence the test by adding to the allowlist without confirming the binary is intentionally operator-facing.

## Definition of done for Shot 1
Import the public-domain plain-text Augustine *Confessions* from Project Gutenberg, generate a 30-day plan, mark today's section complete, write one note, and confirm a valid Markdown file with correct frontmatter lands in `~/GBrain/Reading/Notes/`. If that round-trip works, Shot 1 is done. If it doesn't, nothing else matters yet.

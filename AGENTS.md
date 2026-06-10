# AGENTS.md — Throughline

> **Precedence: `CLAUDE.md` is the binding contract. CLAUDE.md wins wherever this file disagrees.** Read it first. `docs/PRD.md` is the origin spec and is historical wherever it disagrees with the shipped code.

You are helping build **Throughline**, a local-first macOS reading app. This file is a working brief for agent sessions: the loop we protect, the guardrails the suite enforces, and the working style. The AI and copyright posture below mirrors CLAUDE.md (post-pivot, counsel-reviewed 2026-06-08); if they ever drift, CLAUDE.md is current and this file is stale.

## The one job
Prove a single loop end-to-end: **import one book → see today's section → read it → capture one note → export safe Markdown.** Nothing in a given work session is "done" until that loop runs.

## Hard non-goals (do NOT build these, even if asked nicely, even if it seems trivial)
- No cloud sync, accounts, telemetry, or background agents.
- No OpenClaw integration. None. Not even a stub that imports it.
- No mobile app, no PDF/OCR, no DRM handling or circumvention.
- No quizzes, spaced repetition, XP, badges, streaks-as-punishment, mascots, confetti, leaderboards.
- No **background or unsolicited** AI. AI never runs on a timer, on launch, or in the background; it never acts without a deliberate reader action. (Cloud AI on the reader's explicit, consent-gated request is a shipped feature — not a violation.)
- No local embeddings, no Bible mode, no nutrition/running features.
- No dashboard-first or library-first UX. The app opens to **Today**.

## AI contract (what AI MAY do — mirrors CLAUDE.md; CLAUDE.md wins)
AI is reader-initiated and narrowly scoped. Cloud tutoring is a shipped, intended feature. The reader's explicit provider choice in Settings → Assistance is **authoritative** for where a call goes (Local / OpenAI / Anthropic / Codex / the company relay at `ai.readthroughline.com`) — never infer the destination from anything else. Two surfaces are allowed:
1. **Tutor lenses** (Explain / Context / Define / Socratic) — fire only when the reader selects a passage and clicks a lens. The **Local** provider is hardwired to loopback at the call site (`ai_client::validate_base_url`) — that enforcement point is load-bearing; treat any change to it as a security change. Cloud providers are **consent-gated**: the first cloud send requires the reader to confirm a sheet naming the destination host, and only the selected passage (or a narrow surrounding excerpt) is sent — never the book.
2. **Deep Study section briefing** — reader-initiated, **section-scoped**, consent-gated study prep that may be generated *only* when all of these hold: the reader chose **Deep Study** margin-help, **started a session**, and has given **tutor consent**. It is **session-cached only** (in-memory, **non-persistent unless the reader explicitly saves it** — never written to localStorage or disk), dismissable, and regenerable. It is study prep for the section the reader is about to read — not an automatic summary that replaces reading, and never generated in the background or on a schedule.

Both surfaces share the hard rules: selection/section context only (never the whole book), raw source files never leave the device, and AI output becomes durable memory (a Note + Markdown) **only when the reader explicitly saves it**.

If you think something outside this list is needed, STOP and ask in plain text before writing it.

## Copyright & privacy posture (non-negotiable — full counsel-reviewed version in CLAUDE.md §3)
- Raw EPUB/text source files stay local: never exported, never bulk-uploaded to any API. Cloud tutoring may send only the reader's selection, a narrow surrounding excerpt, or (Deep Study) the current section — never the whole book.
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

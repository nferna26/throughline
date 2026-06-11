# CLAUDE.md — Throughline

**Last updated 2026-06-09 · Phase: pre-launch hardening.** This is a review-and-refine
phase, not a feature phase. The energy goes into making what exists secure, correct, and
beautifully simple — when in doubt between adding and removing, remove.

## What this is

Throughline is a local-first macOS reading app for serious readers: import a book, open to
Today's section, read, ask the tutor about a hard passage, keep durable notes, export
clean Markdown. Tauri v2 shell; React + TypeScript + Vite frontend; Rust commands for FS,
hashing, SQLite, and export. Operational state lives in SQLite at
`~/Library/Application Support/Throughline/reading.db`; imported books under
`.../Throughline/books/{book_id}/`; Markdown exports to `~/Documents/Throughline/…`
(user-overridable).

It ships two ways, from one codebase:

1. **The $20 signed build** — tutor preconfigured through our relay (Claude Sonnet behind
   `ai.readthroughline.com`), metered by a token allowance that readers see as
   explanations, never tokens. Zero setup.
2. **The open-source build** — reader brings their own key (Anthropic/OpenAI) or runs local
   via LM Studio. No relay.

Every change must be correct in both configurations. The mechanism that selects between
them is in the code — read it before reasoning about it.

## Precedence and deeper context

This file wins over everything else in the repo. The shipped code is the present;
`docs/PRD.md` is the origin spec and is historical wherever it disagrees with the code.
After your independent sweep, read `docs/AUDIT.md` and reconcile — confirm each prior
finding is fixed or still open, and note anything it caught that you didn't.

## Non-negotiables

These are principles with reasons, so you can apply them to cases not listed. The canonical
examples are case law, not the full statute.

**1. Local-first, telemetry-never.** The reader's library, notes, plans, and history live on
their Mac. No accounts, no cloud sync, no analytics, no background agents. We count usage,
never content — and no book text or note content may ever reach logs, error messages, crash
output, or any diagnostic surface, ours or a dependency's.

**2. AI is reader-initiated and narrowly scoped.** AI fires only on a deliberate reader
action — never on a timer, on launch, or in the background. It receives only the selected
passage or the current section, never the book. Its output becomes durable (a note, an
export) only when the reader explicitly saves it. While local-only mode is ON, non-loopback
endpoints are refused at the call site — that enforcement point is load-bearing; treat any
change to it as a security change.

**3. Copyright posture (counsel-reviewed 2026-06-08 — binding, do not weaken).**

- Raw EPUB/text source files stay local: never exported, never bulk-uploaded to any API.
  Cloud tutoring may send only the reader's selection or a narrow surrounding excerpt.
- The lenses explain, contextualize, define, or ask Socratic questions. The app never
  uploads, stores, indexes, summarizes, or processes the full book in the cloud, and
  outputs must not reproduce long passages or substitute for the book.
- Never: send whole chapters/books to a provider; auto-summarize every section; build a
  searchable cloud copy of a book; preserve or share copyrighted passages server-side; or
  market "upload any copyrighted book → complete AI study guide."
- The relay is a stateless forwarder: forward → stream → drop. No logging, persisting,
  indexing, disk-caching, or summarizing of book text. Metering counts tokens, not content.
- Deep Study / section briefings (if present in the build) stay reader-initiated,
  section-scoped, consent-gated, non-persistent unless saved.
- Exports contain locators, paraphrases, reflections, and short quotes only; warn (don't
  block) when a quote exceeds ~300 characters; every imported source gets a SHA-256 hash in
  the DB; exported notes carry `source_private: true` frontmatter; imported source files
  are immutable after import.

**4. DRM.** DRM-free EPUBs only. Never parse around, strip, or otherwise circumvent
protection.

**5. Scope discipline.** Still out, even if a fix seems to invite them: cloud sync,
accounts, gamification (XP, badges, streaks-as-punishment, confetti, mascots), background or
scheduled AI, mobile, PDF/OCR, local embeddings, OpenClaw integration (none, not even a
stub), dashboard-first UX — the app opens to Today. If a genuine fix appears to require
crossing any line in this section, stop and ask in plain text first.

## The golden loop (regression spine)

Discover or drag in a book → Today shows the right section → read → select a passage and ask
the tutor (it quotes the selection before explaining) → save the answer as a note → export
valid Markdown with correct frontmatter to `~/Documents/Throughline/Books/`. Canonical fixture:
Project Gutenberg's Augustine, *Confessions*. Any change that breaks any link in this
chain is a P0, no matter how much it improves something else.

## This phase: review priorities, in order

**P1 — Security and privacy correctness.** The last adversarial audit graded security B−;
close that gap before anything cosmetic. Highest-value targets: the local-only call-site
enforcement, the relay client (invariant 1's no-content-in-diagnostics rule), path handling
on import and export, and anything that touches the reader's files. Severity beats style.

**P2 — Experience.** Two named problems own this workstream: **first-moment magic without
AI** (the first run must land somewhere beautiful and obvious before any AI is invoked) and
**the AI cold-start cliff** (in the paid build, the first tutor use must truly be zero-setup;
in the source build, key/local setup must be guided and dead-end-free).

**P3 — Code quality.** Boring, inspectable, smallest diff that fixes the issue. Delete code
that earns nothing.

**Promise audit.** The marketing site makes public claims; the build must keep every one:
no API key needed (paid build) · allowance, then BYO key or local — the reader is never cut
off · drag in DRM-free EPUBs · offline catalogue of public-domain titles · notes export to
clean Markdown · no accounts, no telemetry, usage-never-content · opens to today's section ·
the tutor quotes your selection before explaining. Treat each as an acceptance criterion.

## The experience bar (what "simple" means here, testably)

- **Cold-open test:** a Mac user with zero instructions reaches *read today's section* and
  *save a note* within two minutes of first launch.
- One obvious next action per screen; empty states teach the next step.
- Reader-facing language is plain: "explanations," never "tokens"; no "API," "endpoint,"
  "sync," or other plumbing words anywhere a reader can see.
- Every error says what happened and what to do next, in the app's voice — no dead ends,
  no blame, no jargon.
- Quiet by default: no sounds, badges, or interruptions. The book is the interface.
- If a feature needs documentation to be usable, the feature isn't done.

## Working agreements

- **Free to do:** read anything, run the full suite, fix bugs, refactor with tests green,
  tighten copy within the voice above.
- Branch per workstream; never commit directly to `main`; never commit secrets or keys.
- **Ask first:** schema changes (the first paying reader's `reading.db` is forever — from
  now on every schema change ships with a migration), new dependencies, relay protocol
  changes, or anything that would weaken a non-negotiable or a guardrail test.
- **Database guardrail (enforced by the suite — keep it that way):** acceptance and
  diagnostic programs must never touch the user's real database. They live in
  `src-tauri/examples/` as Cargo example targets and must either (a) call
  `bin_guardrail::init_isolated_data_dir(...)` as the first line of `main()`, or (b) appear
  in the `REAL_DB_ALLOWLIST` of the `bin_guardrail_acceptance_binaries_use_isolated_data_dir`
  test in `lib.rs` — and only for intentionally operator-facing inspection tools. Never
  silence that test by allowlisting.

## Verification

- `cargo test` from `src-tauri/` passes clean; frontend builds and type-checks via the
  scripts in `package.json` (`package.json` is authoritative — if the script names here
  drift from it, trust it and update this file).
- After touching import, export, notes, or the tutor path: run the golden loop end-to-end
  using the isolated-data-dir acceptance examples, and state the result — don't claim it.
- Deliver review findings as a ranked list — severity, evidence (file:line), and the
  smallest fix — not as a rewrite. One finding the reader would feel beats ten the linter
  would.

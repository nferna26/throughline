# Shot 1 — Release-Candidate notes & manual QA

Status of the `cockpit-redesign` branch as a **local** Shot 1 release candidate for
the 14-day Augustine reading experiment. This file is the honest ledger of what is
verified automatically, what still needs a human at the keyboard, and the known
risks. AGENTS.md remains the binding contract.

## What "Shot 1" must prove (AGENTS.md)
> import one book → see today's section → read it → capture one note → export safe Markdown.

The cockpit redesign layers a Today action card, a text-reader cockpit with a
Companion Margin (highlights / notes / tutor prompt cards), a session recap, and a
Book Setup Sheet on top of that loop — without breaking it and without violating the
copyright/privacy posture.

## Automated coverage (CI-equivalent, run locally)
| Gate | Command | Covers |
| --- | --- | --- |
| Frontend unit/integration | `npm test` (vitest, jsdom) | Today, TextReader margin + recap, MarginTutorCard, BookSetupSheet, NotesBrowser, BookSwitcher, types |
| Types | `npm run typecheck` | whole TS surface |
| Bundle | `npm run build` | `tsc && vite build` |
| Backend | `cargo test` | import/plan/recovery/settings/notes/ai/migrations + guardrails |
| **Shot 1 round-trip (synthetic)** | `cargo run --example shot1_acceptance` | import → 30-day plan → today's section → complete → note → export, asserting frontmatter `type / source_private:true / source_sha256 / locator / chapter` and that the export lands in an isolated temp dir, never `~/GBrain` |
| **Shot 1 round-trip (REAL text)** | `cargo run --example shot1_realtext -- <confessions.txt>` | the SAME loop against the genuine Project Gutenberg #3296 *Confessions* — real import + chapter-like sectioning, calm/plan-ready Today, day-1 prose with no PG-header bleed, normal + rescue sessions, and a privacy-safe TutorNote export. See "Real-text probe" below. |

### ⚠️ Synthetic vs real Augustine — read this
`src-tauri/examples/shot1_acceptance.rs` does **not** import the real Project
Gutenberg *Confessions* file. It **synthesizes** a Gutenberg-shaped fixture (real
`Title:`/`Author:` headers, `*** START/END OF ***` markers, `BOOK`/Roman-numeral
chapter headings, a short genuine epigraph, filler body) so the run is deterministic,
network-free, and doesn't reproduce a long literary work. It exercises the same
header-strip + chapter-detection + plan + export code paths the real file would.

The **real file is now also exercised automatically** by `shot1_realtext` (next
section) — so "does real-world sectioning look sane?" is no longer purely a manual
question. What still requires a human is the *rendered UI* (a real Tauri window),
which neither example touches.

## Real-text probe (verified)

`src-tauri/examples/shot1_realtext.rs` runs the **entire Shot 1 loop at the command
layer** — the same `throughline_lib` functions the Tauri UI invokes — against the
**genuine** public-domain Augustine *Confessions* (Project Gutenberg #3296). It is a
guardrailed Cargo example: `bin_guardrail::init_isolated_data_dir` is the first line,
so data + export live under an isolated OS-temp dir and can never touch the real DB or
`~/GBrain`. The `.txt` is fetched out-of-band to `/tmp` and passed as an argument — it
is **never committed or bundled**. (The example self-wipes a stale `reading.db` at
startup for run-to-run determinism, after a prior crashed run's half-migrated DB once
caused a SIGBUS.)

Run: `cargo run --example shot1_realtext -- /tmp/rg_realtext/confessions.txt`

Verified on the real text (deterministic across repeat runs):
- **Import + chapter-like sectioning** — title/author parsed from the PG header;
  **~73 sections, all chapter-like (`BOOK …` / `BOOK … — pt N`), zero "Part N"
  even-chunk fallback** (long BOOKs are split into chapter-labelled parts; the exact
  count is stable per build).
- **Calm Today** — fresh import is `plan_ready` / `NotStarted`: never "behind", no
  forecast, no recovery panel (Priority 0).
- **Day-1 section** (`BOOK I — pt 1`) — renders real prose; the Gutenberg
  header/license never bleed in.
- **Sessions** — a normal session completes one section; a **rescue** session
  completes zero sections but still ends ("that counts" — no forced completion).
- **TutorNote export privacy** — the exported Markdown carries `source_private: true`,
  `note_type: TutorNote`, locator, chapter, and the reader's **own words only**; the
  raw selected passage and any ``` ``` ``` prompt fence are **absent**; the file stays
  under the isolated export dir (`~/GBrain` untouched). This is the AGENTS.md
  copyright/privacy posture, proven end-to-end on the real text.

This upgrades **M1** (real import + sectioning) and **M9** (export privacy) from
"manual only" to **automated at the command layer**. It does **not** replace the
manual checks of the *rendered* UI (selection geometry M6, visuals M12, the live
window in general) — those remain human-only and are unverified by the agent.

## Manual QA checklist (do before declaring the experiment live)
Tauri desktop has no e2e automation wired here, so these are by-hand. Launch with
`npm run tauri dev` (or a signed build). Use a real Augustine *Confessions* plain-text
file from Project Gutenberg.

- **M1 — Import + sectioning (real file).** ✅ *Command-layer verified by
  `shot1_realtext` (73 chapter-like sections, no "Part N").* The remaining manual part
  is purely visual: import the real Gutenberg `Confessions` `.txt` and confirm the
  Book Setup Sheet appears (created=true) and Today shows that chapter-like first
  section in the rendered window.
- **M2 — Setup presets incl. Deep Study.** In the Setup Sheet pick Finish rhythm, a
  session length, days/week, and **Deep Study** margin help. Start the plan. Reopen
  Settings/Setup and confirm the rhythm + margin-help persisted.
- **M3 — Today: plan-ready calm.** Fresh import shows "Plan ready. You are not
  behind." — never a "Behind" chip, never a recovery panel, never "Restart current
  chapter."
- **M4 — Start a full session.** Tap "Start N-minute session" → text reader opens at
  today's section.
- **M5 — Rescue session.** Back on Today, tap "I only have 10 minutes" → reader opens
  in rescue mode with the calm banner.
- **M6 — Select → Highlight / Note / Tutor.** Select a passage. The selection toolbar
  offers Highlight, Note, Explain, Context, Define. Highlight paints a mark + margin
  card; Note opens an anchored editable card.
- **M7 — Tutor card (local, preview-only).** Explain/Context/Define spawns an anchored
  **draft** tutor card showing a prompt PREVIEW with "nothing is sent." Switch modes →
  preview regenerates. Confirm no network call (local-only banner / no model needed
  for preview).
- **M8 — Save TutorNote requires your words.** "Save to notes" is disabled until you
  type a takeaway. Save → a read-only TutorNote card remains in the margin.
- **M9 — Markdown privacy (critical).** ✅ *Automated two ways:* the Rust regression
  `save_preview_as_note_persists_anchors_and_exports_markdown` **and** the real-text
  probe (`shot1_realtext`) both assert the exported note has `source_private: true` +
  your words and **never** the AI prompt or raw selected passage. Manual spot-check is
  optional: open the exported note under `~/GBrain/Reading/Notes/` after a real
  session and eyeball it.
- **M10 — Session recap.** Finish the session. Expect a recap (minutes, sections done,
  highlight/note/tutor counts), a takeaway you can Accept/Edit/Skip, and a
  "Next time → <next chapter>" preview. In rescue mode the header reads "That counts"
  and never forces completion.
- **M11 — Notes view / re-export.** Open the notes browser; confirm saved notes list,
  and re-exporting updates the same file (stable filename) rather than duplicating.
- **M12 — Visual pass.** Eyeball the cockpit at narrow + wide widths and light/dark:
  margin cards don't overlap badly, recap tiles wrap, tutor card is legible. (No
  automated visual coverage — see risks.)

## Known risks / not verified
- **No live-window QA performed by the agent.** All UI evidence is jsdom unit/
  integration tests; layout, scrolling, selection geometry, and theming are
  **unverified in a real window**. M12 + M6 cover this manually.
- **Real-text loop is command-layer, not GUI.** `shot1_realtext` proves the real
  *Confessions* drives import → plan → Today → sessions → safe export through the real
  library functions, but it does not render the React UI. The synthetic
  `shot1_acceptance` remains the network-free CI fixture; the real probe needs the
  `.txt` fetched to `/tmp` first.
- **Backend `cmd_restart_current_section` still registered** in `lib.rs` but has **zero
  frontend callers** (the Today recovery option was removed; `RecoveryOption` has no
  `RestartCurrentChapter`). It is inert from the UI; left in place to avoid an
  unrelated backend change. Regression `never renders a 'Restart current chapter'`
  pins the UI side.
- **`act(...)` warnings** in two recap tests are benign (a post-click section-load
  effect); tests pass. Not a correctness issue.
- **EPUB** paths exist but Shot 1 is text-first; EPUB is out of scope for this RC
  beyond compiling.

## Verdict
See the session's final report. When every gate above is green AND M1–M11 pass by
hand, this branch is a credible **local** Shot 1 RC. It is not a shipped/signed
release and makes no network calls by default.

# Overnight rubric — Throughline (builder-only, dev tool, NOT shipped to users)

A development-only scoring rubric driving an overnight closed-loop improvement
run on `cockpit-redesign`. **This rubric is never surfaced in the product** — no
scores, badges, or gamification ship (AGENTS.md hard non-goal). It only steers
where to invest engineering effort.

Scale: 100 pts across six dimensions. Each cycle picks the highest expected gain
inside AGENTS.md constraints, implements, tests, and rescoring with evidence.

## Preflight invariants (must pass before any improvement)

| Invariant | Result | Evidence |
|---|---|---|
| 1. Deep Study stale-text guard (TextReader + EPUB never brief section B with section A text) | ✅ PASS | `TextReader.test.tsx > stale-section guard` (delayed-read) green; EPUB has `sectionText:{sectionId,text}` identity guard + `briefingVisible` requires `sectionText.sectionId === currentSection.id` (no isolated test — jsdom can't run epub.js; **cycle 1 extracts a pure guard helper + test**). |
| 2. AI disclosure / local-only guard (no `cmd_ai_ask` when `ai_local_only=false` or unreadable; no false "Local-only"/"nothing leaves your device" copy) | ✅ PASS | MarginTutorCard ×2 + SectionBriefingCard ×2 local-only-enforcement tests green (auto-start + consent-gate, remote URL + `ai_local_only:false`). |

Preflight verdict: **PASS** — proceed to scoring + improvements.

## Baseline gates (before improvements)
- `npm run typecheck`: 0 errors
- `npm test`: 75 passed / 11 files
- `npm run build`: ✓ built
- `cargo test`: 109 passed + 2 integration, 0 failed
- `shot1_acceptance` / `shot1_realtext`: OK last pass (73 sections); re-run in final gates.

## Baseline score: 78 / 100

| Dimension | Wt | Base | Evidence / gaps |
|---|---|---|---|
| Trust/privacy contract | 20 | 17 | Local-only enforced at call site + UI; `source_private: true`; raw text never exported (export tests pin it); `tauri-plugin-http/shell` banned by a lib.rs test; AI audit history viewer. Gap: no single "where your data lives / what's sent" at-a-glance trust summary; export folder shown but not the per-note on-disk path after save. |
| Core loop reliability | 20 | 17 | Import→Today→read→note→export proven by `shot1_acceptance`/`shot1_realtext`; stable note filenames; recovery paths. Gap: thin automated coverage of the *resume* path; section-completion edge cases lightly tested. |
| Reader + margin UX | 25 | 18 | Streaming tutor, concise+Go-deeper, anchored notes, Question/Takeaway tags, responsive panel, drag-resize. Gaps: selection toolbar has **no Escape-to-dismiss and no keyboard path**; no visible reading progress within a section; margin empty-state is functional but plain. |
| Deep Study usefulness/magic | 15 | 11 | Session+consent-gated briefing, 5-part parser, v2 "watch for" context markers, cache by book|section|sha|mode. Gaps: EPUB identity guard untested; briefing parser tolerant but no test for the markers-from-malformed case; no "regenerate is local" reassurance. |
| Today + Notebook continuity | 10 | 7 | "Last time" memory (last takeaway/question + counts), chapter notebook with type filters, stable re-export. Gap: Today doesn't surface **resume position** ("continue where you left off") even though `resume_percent` exists — vision doc flags this explicitly. |
| Visual/accessibility polish | 10 | 8 | Tokenized theme, light/dark, focus-visible rings on tutor controls, `prefers-reduced-motion` honored in tl-tutor.css. Gaps: selection toolbar + some new chips lack focus/keyboard treatment; reduced-motion not audited across tl-theme.css. |

## Chosen opportunities (ranked by expected gain, all inside AGENTS.md)
1. **Reader/margin: Escape-dismiss + keyboard/focus for the selection toolbar** (UX 25 + a11y 10). Highest weight, clear gap.
2. **Deep Study: extract a pure section-text identity-guard helper, unit-test it, use it in both readers** (Deep Study 15 + hardens preflight invariant 1 for EPUB).
3. **Today: surface resume position ("Continue — N% in")** from existing `resume_percent` (continuity 10; vision-aligned).
4. **Trust: Settings "where your data lives" at-a-glance summary + reaffirm what is/isn't sent** (privacy 20).
5. **Core loop: add resume-path + section-completion regression coverage** (reliability 20).
6. (stretch) Notebook/export polish or reduced-motion audit, as budget allows.

## After score: 89 / 100  (baseline 78 → +11)

| Dimension | Wt | Base | After | What changed |
|---|---|---|---|---|
| Trust/privacy contract | 20 | 17 | 19 | **Cycle 5:** Settings "Your data" at-a-glance summary states the contract plainly (book files stay local; exports are your words not raw text; AI is selection/section-scoped + local; output saved only on choice). Flips honestly to "remote / disabled" when local-only is off. +2 tests. |
| Core loop reliability | 20 | 17 | 19 | **Cycle 6:** recap "one sentence" → durable Takeaway note path now tested both ways (persists privacy-safe with the reader's words; skip saves nothing + null summary). Closes the highest-risk untested recent addition. |
| Reader + margin UX | 25 | 18 | 22 | **Cycle 3:** selection toolbar now dismisses on **Escape**, advertises it (`aria-keyshortcuts`), and has a high-contrast keyboard focus ring on the dark toolbar. +1 test (real selection → toolbar → Escape). |
| Deep Study usefulness/magic | 15 | 11 | 13 | **Cycle 2:** extracted pure `briefingTextReady` stale-text guard, unit-tested (5 cases incl. the A→B race), and routed BOTH readers through it — closes the EPUB invariant-1 test gap that jsdom couldn't cover inline. |
| Today + Notebook continuity | 10 | 7 | 9 | **Cycle 4:** Today surfaces "Continue — N% into this section" + a calm resume note from existing `resume_percent` (suppressed at 0% and ≥97%). +3 tests. Vision-doc aligned ("what do I do right now"). |
| Visual/accessibility polish | 10 | 8 | 9 | Dark-toolbar focus ring (cycle 3); new Today/Settings surfaces are static text using existing tokens (no motion, theme-safe). Reduced-motion audit across tl-theme.css deferred (low ROI). |
| **Total** | **100** | **78** | **89** | ≥88 target met. |

## Cycles completed (6)
1. (preflight) verified both invariants pass — no repair needed.
2. Pure `briefingTextReady` guard + 5 unit tests; both readers routed through it.
3. Selection-toolbar Escape dismiss + a11y focus ring + test.
4. Today resume continuity ("Continue — N% in") + 3 tests.
5. Settings "Your data" trust summary + 2 tests.
6. Recap-Takeaway durable-note reliability tests (persist + skip).

Test count: 75 → 88 frontend (+13). Backend unchanged (no Rust edits this run).

## Evidence (gates, after — all green)
- `npm run typecheck`: 0 errors
- `npm test`: **88 passed / 12 files** (+13 vs baseline)
- `npm run build`: ✓ built
- `cargo test`: 109 passed + 2 integration, 0 failed (backend unchanged this run)
- `shot1_acceptance`: SHOT 1 ACCEPTANCE OK
- `shot1_realtext`: SHOT 1 REAL-TEXT OK (73 sections)
- Live UI QA: **not feasible** — headless (`DISPLAY` unset); cannot capture real
  screenshots and will not fabricate them. Dev server is live on :1420 on the
  operator's Mac (hot-reloaded), so the changes are visible for manual QA.

## Constraints honored
No commits/staging; no unrelated dirty work reverted (the operator's
`local-only/research-packets/` snapshot left untouched). No cloud/accounts/
telemetry/OpenClaw/background-AI/gamification/remote-AI-default added. Raw
sources still never exported; `source_private: true` intact; AI output still
saved only on explicit action. EPUB parity preserved, scope not expanded. No new
dependencies.

# Weekend Shot 1 RC hardening — log

A short, honest record of the weekend-scale hardening passes on `cockpit-redesign`.
AGENTS.md is binding; Shot 1 stays plain-text first; no commits made.

## Pass 18 — Codex app-owned device-code login

Operator preferred an app-owned ChatGPT login over reading the Codex CLI's file
(more durable: decoupled from the CLI, survives Codex moving creds to the OS
keyring). Mapped OpenAI's device flow from the official `openai/codex` source
(`device_code_auth.rs` + `server.rs`) and implemented it natively (no shell-out,
no OpenClaw):

- `ai_providers.rs`: `codex_device_start` (usercode) → `codex_device_poll`
  (poll → authorization_code → form-exchange at `/oauth/token` → decode id_token
  JWT for `chatgpt_account_id`) → store `{access, refresh, account_id}` in the
  Keychain. `load_codex()` prefers app-owned creds over `~/.codex/auth.json`;
  refresh writes back to the right store. Commands `cmd_codex_device_start`/
  `_poll`/`_logout`. One new dep: `base64` (the single JWT decode).
- `keystore.rs`: Codex creds bundle stored under one Keychain entry.
- Frontend: `CodexLogin.tsx` (Sign in with ChatGPT → show code + URL → auto-poll →
  done), wired into onboarding + Settings → Assistance.

Caught real API shapes live: the device endpoint returns `interval` as a STRING
("5") — handled string-or-number. **Verified end-to-end with the operator**:
device approval → poll `complete` → exchange → an app-owned Codex call streamed a
reply (`gpt-5.5`). Gates: `cargo test` 126 lib (5 ignored live) + 2 integration,
0 warnings; `npm test` 101/13; typecheck 0; build ✓.

## Pass 17 — opt-in cloud AI providers (OpenAI · Anthropic · Codex login)

Added cloud AI as an explicit alternative to the local LM Studio path, driven by
an auto-research workflow (current-stack audit failed → verified the seams by
hand). Operator chose: onboarding forces an explicit provider choice (no implicit
remote default); live-test via env keys; Codex via the official Codex CLI creds
(NOT OpenClaw — a hard non-goal). Full design in `docs/AI_PROVIDERS.md`.

Backend: new `ai_providers.rs` dispatch normalizing OpenAI (reuses the
OpenAI-compatible client + `max_completion_tokens` + `reasoning_effort:"none"` for
gpt-5.x), Anthropic (`/v1/messages` named-event SSE), and Codex (reads
`~/.codex/auth.json`, reactive-401 refresh via the public OAuth client, posts the
ChatGPT Codex Responses API) — all into the existing StreamEvent channel.
`keystore.rs` puts API keys in the macOS Keychain (in-memory under test); only
`key_present` booleans reach the frontend. Settings gain `ai_provider`
(authoritative) + per-provider models + `cmd_set_ai_key`/`cmd_clear_ai_key`;
`cmd_test_ai_connection`/`cmd_list_ai_models` are provider-aware. Local keeps its
hard loopback backstop. `COMMAND_API_VERSION` 2 → 3. One new dep: `keyring`.

Frontend: forced first-run `Onboarding.tsx` chooser (per-provider disclosure +
Test button), App.tsx gate on `ai_provider_chosen`, a Settings → Assistance
provider selector + key management. Both reader cards rewired from
`!ai_local_only` to the provider/`remote_allowed` model with a **"via &lt;Provider&gt;"**
badge so the UI never falsely claims "local" during a cloud call. Migrated the 3
inverted-semantics tests (local-only-OFF→disabled) to provider-gate semantics +
added positive cloud-allowed cases.

**Live-verified all three** (each streamed a one-word reply end-to-end): OpenAI
`gpt-5.5`, Anthropic `claude-opus-4-8`, Codex via `codex login` `gpt-5.5`.
Discovered + fixed real API requirements against live 400s (Codex `instructions`
+ list `input`; OpenAI `reasoning_effort` value set).

Gates: `cargo test` 125 lib (+ 3 ignored live) + 2 integration; `npm test`
101/13; typecheck 0; build ✓. Constraints honored: no OpenClaw, no shell-out
(reqwest only), keys never logged/committed/exported, raw whole files never sent,
explicit disclosed choice with no remote default.

## Pass 16 — EPUB code blocks (technical books)

Verified the pivot against *Release It! 2nd ed* (706k chars, clean prose). One real
defect: code blocks were double-spaced + de-indented. Root cause from the actual
EPUB: it has NO `<pre>` — code is HTML tables (`table.processedcode` → `tr` →
`td.codeline`, a `td.codeinfo` line-number gutter, keywords in `<strong class="kw">`),
and code indentation is not in the source at all (CSS/structural).

Fix (operator chose "fix code-block rendering"): a general code-block handler in
`extract_section` — enters code mode on `<pre>` (verbatim: indentation + newlines
preserved) OR a block whose class is code-ish (`processedcode`/`programlisting`/…,
collapsing XHTML pretty-print whitespace, line breaks from row/line elements,
skipping `codeinfo`/`codeprefix`/lineno gutters, keeping keyword text but NOT
bolding it). Emits a `pre` style range. `splitParagraphs(text, preRanges)` is now
structure-aware: `pre` ranges become single NON-reflowed monospace paragraphs at
exact offsets; prose around them still reflows. `.tl-pre` CSS = monospace panel,
white-space: pre-wrap. Paragraphs now derive via `useMemo(text, structure)` so the
async structure recompute fixes the double-spacing. Real-EPUB probe confirmed clean
single-spaced output. Indentation is recovered only when the EPUB encodes it (not
this book). +4 tests (2 Rust code formats, 2 splitParagraphs).

Also: deleted the stale derived caches (`source.txt`/`structure.json`/`body_offsets.json`)
for the already-imported Release It! so the lazy backfill regenerates them with code
handling on next open (source.epub + DB untouched).

Gates: `cargo test` 118 + 2; `npm test` 100/13; typecheck 0; build ✓ (276 kB).

## Pass 15 — pivot: EPUB→text at import (delete epub.js rendering)

Pass 14's reads-only patch made the briefing work but the selection card still
failed: a live build's HUD showed `summon: no selection` with text visibly
selected — cross-realm `getSelection()` returns empty in WKWebView, unfixable
without `allow-scripts` (which we won't enable on untrusted EPUBs with `csp:
null`). The PRD called EPUB rendering "a trap." After an auto-research workflow
(text pipeline / epub pipeline / SourcePrep / Rust HTML→text → design → adversarial
review, `goAhead: true`) and operator sign-off, we pivoted.

Decision (operator-chosen): native EPUB→text at import · structured markdown now
(headings + emphasis) · re-import existing books. SourcePrep was NOT integrated
(it's a Swift GUI shelling out to `/usr/bin/unzip`, which `tauri-plugin-shell`
ban forbids; Throughline already depends on the `epub` crate).

Backend (`import_epub.rs`, `models.rs`, `commands/books.rs`, `lib.rs`):
- Hand-rolled `extract_section` (no XML parser — never errors on `&nbsp;`/`&mdash;`):
  XHTML → clean blank-line paragraphs, script/style skipped, images dropped,
  entities decoded, soft-hyphen/zero-width stripped. Captures heading/blockquote/
  emphasis ranges as **UTF-16** offsets (the reader's unit). 10 unit tests.
- Sections concatenated into `source.txt`; locators are **BYTE** offsets (slicer is
  byte-indexed — the review's critical catch; a multibyte round-trip test guards it).
  `structure.json` sidecar + `body_offsets.json` (body_start 0). `source.epub`
  stays the immutable SHA anchor.
- `cmd_read_section_structure` returns a section's ranges. `cmd_read_section_text`
  unchanged + a one-time lazy `ensure_epub_text` backfill (preserves section ids,
  so completion/notes survive) for EPUBs imported before the pivot.

Frontend (`Reader.tsx`, `TextReader.tsx`, `paragraphStructure.ts`, `tl-theme.css`):
- Every book routes to `TextReader`. New `segmentParagraph` composes highlights
  with inline emphasis; block roles style the `<p>` via a class (never a heading
  TAG, so `p[data-offset]` selection anchoring is preserved). 10 unit tests.
- DELETED `EpubReader.tsx`, `epubReaderLogic.ts`, `epubSelection.ts` (+ tests),
  the HUD, and the `epubjs`+`jszip` deps. Bundle JS 650 kB → 276 kB (gzip 200→85).

Gates: `cargo test` 115 + 2; `npm test` 98/13; typecheck 0; build ✓. Eval +
acceptance checklist in `docs/EPUB_AI_EVAL.md`. Known limits: images dropped,
tables linearize, legacy `cfi:` notes un-anchor (text preserved).

## Pass 14 — EPUB selection + Deep Study briefing: the REAL root cause (eval + auto-research)

Passes 12–13 were wrong guesses (handler ordering / capture logic). After three
failed attempts the operator called it: stop guessing, build an eval, and use an
auto-research approach. Ran a research fan-out (web + epub.js source + current
code → design → adversarial review). The diagnostic HUD's
`wired #1 (from=catchup) · epubSel=null` was the decisive clue: the document was
reachable but **no event ever fired**.

**Root cause (3 converging sources): WebKit bug #218086.** epub.js 0.3.93
sandboxes the content iframe `allow-same-origin` **without `allow-scripts`**
(renderTo omits `allowScriptedContent`). WebKit then **swallows every event
dispatched into the frame** — both parent-attached `mouseup`/`keyup` and
epub.js's own `selectionchange`→`selected` pipeline. So the action card (event-
gated) and the Deep Study briefing (its `sectionText` was set only in the same
event-wired path) **failed together**. Same-origin DOM **reads** are NOT blocked
— that asymmetry is the fix. Ref: <https://bugs.webkit.org/show_bug.cgi?id=218086>.

**Fix — reads-only, no security regression** (`src/screens/EpubReader.tsx`,
`src/epubReaderLogic.ts`):
- Bounded, navigation-scoped **catch-up poll** (`startCatchupPoll` →
  `harvestContents`) reads `body.innerText` from the parent realm after each
  display/Next/Prev to populate the briefing's `sectionText` (identity-guarded,
  generation-token cancel, self-terminating ≤~5 s). No standing timer, **zero AI**
  in the poll — the briefing still fires only through the existing consent gate
  (parity with the plain-text reader, which already auto-prepares once its text
  loads).
- Explicit, **non-destructive** "Actions for selected text" margin affordance
  reads the live selection at click time (`readLiveSelection` →
  `selectionFromCandidates`) and shows the card. An empty read never clears a
  valid card. epub.js events kept only as a best-effort fast path.
- **Did NOT enable `allowScriptedContent`** — with `tauri.conf.json` `csp: null`
  it would let untrusted EPUBs run scripts. The adversarial review flagged this;
  true auto-pop is deferred to a separate CSP-paired change with operator sign-off.

**Eval** (`docs/EPUB_AI_EVAL.md`): Layer 1 = pure deciders with tests
(`src/epubReaderLogic.test.ts`, +17); Layer 2 = HUD-driven manual checklist for
the iframe paths that can't run headless. Honest clause: a green `npm test` does
NOT verify the WKWebView fix — Layer 2 on a real build is required.

Gates: `npm test` 111/14, typecheck 0, build ✓. Backend untouched. HUD kept for
Layer-2 confirmation, with a documented removal follow-up.

## Pass 13 — EPUB action card: the REAL bug was handler-registration order

Pass 12 (below) was a wrong guess — it improved the capture logic but the card
still didn't appear. Read the installed epub.js (0.3.93) source instead of
theorizing:
- `Contents` listens to the iframe's `selectionchange` (250ms debounced) and
  emits `SELECTED`; `Rendition.passEvents` re-emits it as the `"selected"` event.
  So epub.js's own event path IS reliable here.
- `RENDITION.RENDERED` is emitted from `afterDisplayed` via the manager `ADDED`
  event, inside render/content hook chains that resolve **async relative to** the
  `display()` promise (rendition.js:419-435).

Root cause: EpubReader registered `rendition.on("selected")` / `on("rendered")`
**after** `await display()`. Since `rendered` (and the first selection wiring)
can fire during/just-before that await resolves, the freshly opened book's first
section never got its selection listeners — so selecting text produced no card
until a Next/Prev re-render. Exactly the reported symptom ("just uploaded a new
book… buttons don't pop up").

Fix (EpubReader.tsx):
- Register `selected` + `rendered` handlers **before** `display()`.
- Add a `getContents()` catch-up immediately after display to wire any
  already-rendered Contents (covers the race where `rendered` fired first).
  `manager.getContents()` returns live contents synchronously.
- `wireContents(contents, section?)` is idempotent (WeakSet<Document>) so
  re-renders never double-bind; it attaches mouseup/keyup/touchend selection
  capture AND the Deep Study briefing source-text tagging in one place.
- `selected` event now routes through the same `nextEpubSelection` decision.

Honest limitation: verified by reading the epub.js source + unit tests + green
gates, but the iframe selection→card render cannot run headless (no epub.js in
jsdom). Needs one real-window confirmation.

Gates: `npm test` 94/13, typecheck 0, build ✓. Backend untouched.

## Pass 12 — EPUB selection action card never appeared (live QA) [SUPERSEDED by Pass 13]

Live QA: in an EPUB, selecting text (blue run visible) showed NO Highlight /
Note / Question / Explain / Context / Define card. Root cause: that card is
gated on `epubSel` (`{cfi, text}`), which was set ONLY inside
`rendition.on("selected")` — epub.js's selection event, which is unreliable
across versions/layouts and frequently never fires. The robust fallback DOM
listeners (mouseup/keyup) only set the bare `selection` string, never `epubSel`,
so a real selection produced no actions. (`goAskTutor` already derived a CFI from
the live range via `contents.cfiFromRange` — proof the reliable path existed; it
just wasn't wired to the card.)

Fix (EpubReader.tsx):
- `captureFromContents` is now the single source of truth: on a discrete gesture
  it reads the live iframe selection, derives the CFI from the range
  (`cfiFromRange`), and sets `epubSel` — so the card appears on ANY real
  selection, independent of the flaky "selected" event (kept as redundant
  insurance). Falls back to the section-scroll CFI (mirrored into `cfiRef` so the
  once-created capture closure reads the current position) when the range CFI is
  unavailable — a usable card beats none.
- Dropped the `selectionchange` listener (fired continuously mid-drag and on
  collapse; risked race-dismissing the card). Now mouseup/keyup/touchend only —
  the discrete gesture-completion moments — matching the plain-text reader.
- Collapsed/trivial selection now clears `epubSel` (card dismisses on a click).
- Extracted the decision into a pure, unit-tested `nextEpubSelection`
  (src/epubSelection.ts, 6 tests incl. the exact bug: real selection + empty
  range CFI → card still shows, section-anchored). jsdom can't run epub.js, so
  the pure helper is how the fix is covered.

Gates: `npm test` 94/13 (+6), typecheck 0, build ✓. Backend untouched.

## Pass 11 — overnight rubric-driven improvement loop (78 → 89/100)

Closed-loop optimizer run (see `docs/OVERNIGHT_RUBRIC.md` + `OVERNIGHT_RESEARCH_NOTES.md`).
Preflight: both AI-privacy invariants re-verified PASS before any change (stale-text
guard + local-only enforcement tests green). 6 cycles, all in-scope, no commits:

1. **Deep Study stale-text guard → pure + tested.** Extracted `briefingTextReady`
   (sectionBriefing.ts), unit-tested 5 cases incl. the A→B race, and routed BOTH
   readers through it — closes the EPUB invariant-1 gap jsdom couldn't cover inline.
2. **Selection toolbar a11y.** Escape now dismisses it (clears state + native
   selection), `aria-keyshortcuts="Escape"` advertised, high-contrast focus ring on
   the dark toolbar. +1 real-selection→Escape test.
3. **Today resume continuity.** "Continue — N% into this section" + a calm resume
   note from existing `resume_percent` (suppressed at 0% / ≥97%). +3 tests.
4. **Settings "Your data" trust summary.** One plain, accurate statement of the
   privacy contract; flips honestly to "remote / disabled" when local-only is off.
   +2 tests (Settings had no test file before).
5. **Recap-Takeaway reliability.** The recap "one sentence"→durable Takeaway note
   path is now tested both ways (persists privacy-safe with the reader's words;
   skip saves nothing + null summary).

Gates: `npm test` 88/12 (+13), typecheck 0, build ✓; `cargo test` 109 + 2
integration (backend untouched); `shot1_acceptance` + `shot1_realtext` (73 sec) OK.
Live UI QA not feasible (headless; no fabricated screenshots).

## Pass 10 — two Deep Study / AI-privacy blockers (SEND BACK fixes)

Review SEND-BACK caught two real blockers in the pass-9 tranche; both fixed.

**1. Stale-section Deep Study generation (race).** Both readers could mount
`SectionBriefingCard` for section B while `text`/`sectionText` still held section
A's content; the card auto-generates on mount, so it could send A's text and
cache it under B's id. Fix — a section-text identity guard in both readers:
- TextReader: new `textSectionId` state. Cleared to `null` the instant
  `currentIdx` changes; set to `sec.id` only after that section's
  `cmd_read_section_text` resolves. `briefingVisible` now also requires
  `textSectionId === currentSection.id`.
- EpubReader: `sectionText` is now `{ sectionId, text } | null`. The "rendered"
  handler tags captured iframe text with the canonical section matched from the
  rendered href; `goNext`/`goPrev` clear it; `briefingVisible` requires
  `sectionText.sectionId === currentSection.id`.
- Regression: TextReader test with a hand-resolved (deferred) `cmd_read_section_text`
  — resolve A, assert one briefing with A's text; navigate to B with B's text
  still pending, assert NO new briefing fires (and none with A's text for B);
  resolve B, assert the briefing now uses B's text and A's is never reused.

**2. False local-only disclosure.** `MarginTutorCard` and `SectionBriefingCard`
say "Local-only / nothing leaves your device," but with Settings
`ai_local_only=false`, `cmd_ai_ask` could send the passage/section to a remote
URL. Fix — both surfaces now:
- Re-read `cmd_get_settings` authoritatively right before any `cmd_ai_ask`; if
  local-only is OFF (or settings can't be read — fail closed), they do NOT call
  and enter a `blocked` phase with a clear "Local-only is off; re-enable in
  Settings → Assistance" message.
- Load local-only on mount; the consent card's "nothing leaves your device"
  promise is replaced by the disabled message when local-only is off, and the
  "Local-only" success badge only renders when local-only is actually on.
- Regression: both components tested with `cmd_get_settings` → `ai_local_only:false`
  + a remote base URL — assert no `cmd_ai_ask` call and no false on-device copy,
  at both the auto-start and consent-gate entry points (4 new tests).

Backend unchanged this pass (the leak was a frontend disclosure/guard gap; the
Rust `ai_client` already refuses non-loopback when local-only is on — the fix
makes the UI stop calling at all so it never even reaches that check with a
remote URL while claiming to be local).

Gates: `npm test` 75/11, typecheck 0, build ✓; `cargo test` 109 + 2 integration,
0 failed; `shot1_acceptance` OK; `shot1_realtext` OK (73 sections).

## Pass 9 — product-vision tranche (gaps 1–5)

Closed five vision gaps as one tranche. (A mid-pass tool batch was cancelled and
rolled back the frontend edits; they were re-applied serially — noted here
because the verbose history shows duplicate attempts.)

1. **AI contract updated.** AGENTS.md / CLAUDE.md / PRD.md no longer say
   "prompt-preview only / no automatic summaries." New contract: no background,
   remote, or unsolicited AI; Deep Study MAY generate local, session-triggered
   study prep after the reader chose Deep Study + started a session + gave tutor
   consent — cached, dismissable, regenerable, local-only, exported only on save.
   The autonomous/background/remote ban is kept and sharpened.
2. **Today remembers.** New `TodayMemory` on `TodayCard` (backend `today_memory`,
   pure DB aggregate): last user-authored Takeaway/Question + highlight/note
   counts. New `LastTime` surface on Today — calm, no-shame, renders nothing for
   a fresh book, one quiet line when only counts exist. Privacy-safe: only the
   reader's own words ever surface, never a passage/AI output.
3. **Chapter notebook.** `NotesBrowser` reworked into a notebook: grouped by
   chapter, filter chips for Highlights / Notes / Questions / Takeaways / Tutor
   cards with counts. Review-only; creation stays in the reader; stable Markdown
   re-export unchanged.
4. **Question + Takeaway primitives.** New `Takeaway` note type. Selection
   toolbar gained a one-tap **Question**; margin cards gained Note/Question/
   Takeaway tag chips (re-type after writing — no upfront database-y choice, via
   `cmd_update_note` COALESCE). The recap "one sentence" now also persists as a
   durable **Takeaway** note (so it feeds the notebook + Today memory). Exports
   carry the accurate `note_type`; the raw anchored passage is never exported
   (new export.rs privacy tests pin this for Takeaway + Question).
5. **Deep Study v2 markers.** `Watch for` is now 3–5 items; with `onAskContext`
   wired, each becomes a subtle tappable "context available" marker that opens a
   Context tutor draft on that theme (safe v1: thematic lookup, no fake passage
   precision; never auto-opens long content). Wired in both readers under the
   same consent/local-only rules.

Tests added: backend +3 (today_memory empty / counts+latest / ignores
highlights; export typed+privacy ×2); frontend +9 (Today LastTime ×3, notebook
grouping/filter/anchored ×4 over the existing file, briefing markers ×2).

Gates: `npm test` 71/11, typecheck 0, build ✓; `cargo test` 109 + 2 integration,
0 failed; `shot1_acceptance` OK; `shot1_realtext` OK (73 sections). Headless: no
live Tauri QA this pass — strengthened jsdom + Rust coverage instead.

## Pass 8 — EPUB plans were starting on a "praise" page

Live QA finding (operator): *Obviously Awesome* opened to its endorsement-blurb
page ("Praise for…"), not the book. Root cause: the front/back-matter classifier
(`epub_classify::is_front_back_matter`) skips by label, but these wrapper pages
carry **no TOC label**, so the caller falls back to the href basename
("praise.xhtml"). The skip-list had the phrase `"praise for"` — which the bare
filename `"praise"` doesn't contain — so praise.xhtml, opening-blurb.xhtml, and
quote.xhtml (an epigraph) all slipped through as assignable reading.

Design decision (operator chose "skip boilerplate, keep authored intros"): skip
the marketing wrapper, but never silently skip a foreword/preface/introduction —
those are the author framing the work. This book now starts at the Introduction.

Fix:
- `epub_classify.rs`: added **filename-form** detection. When the label looks
  like a content filename (ends in `.xhtml`/`.html`/…), match its stem against a
  boilerplate list we'd never dare match on a human label — `praise`, `blurb`,
  `quote`, `epigraph`, etc. A real chapter always has a TOC label, so this can't
  catch real content; foreword/preface/introduction have human labels and stay
  assignable. +2 tests (skips filename-form boilerplate; keeps filename-form real
  content).
- `commands/books.rs` — **two fixes:**
  1. **Reclassify/import label parity.** Confirmed against the real OPF: the
     praise spine item's idref is the bare token `"praise"` (no extension), and
     it has no TOC label. Import derives the label from the href file name
     (`"praise.xhtml"`) so the new rule fires — but `reclassify_epub_in_place`
     passed `label=None`, so the two paths *disagreed* and the heal wouldn't have
     caught it. Reclassify now uses the same href-file-name fallback as import,
     so both classify identically.
  2. **Auto-heal for already-imported books.** The lazy reclassifier only re-ran
     when *every* section was assignable (pre-classification imports), so a
     partially-classified book never picked up a classifier improvement. Added
     `EPUB_CLASSIFY_VERSION` (now 2) stored per book in a `settings` KV row
     (`epub_classify_version:<book_id>` — no schema migration);
     `cmd_assignable_sections` re-runs the classifier when the stored version is
     behind, then records it. At most once per bump. Both readers call
     `cmd_assignable_sections` on open, so existing EPUBs self-heal on reopen;
     new imports get the fix directly (import shares the classifier).

Honest note: no automated test for the version-gated auto-heal end-to-end (it
needs a real `source.epub` + DB on disk, like the existing `reclassify_epub_in_place`,
which is also only manually verified). Verified by: the pure classifier unit
tests cover `is_front_back_matter(Some("praise.xhtml"), "praise", true) == true`;
the real OPF was inspected to confirm idref=`praise`/href=`…/praise.xhtml`; and
the reclassify label-derivation now provably matches import. The DB heal itself
flips on the operator's next reopen of the book.

Gates: `cargo test` 107 passed / 0 failed (+2) + 2 integration; frontend
unchanged (no FE edit this pass).

## Pass 7 — EPUB reader AI parity (the gap behind "nothing in the margins")

Live QA finding (operator): opened an **EPUB** in Deep Study, nothing populated
the margin. **Root cause: there are two reader components.** `Reader.tsx`
dispatches `source_type === "epub"` to `EpubReader.tsx`, a separate, older
component; every AI feature from passes 3–6 (streaming tutor, concise + Go
deeper, Deep Study briefing, margin-help wiring) had landed only in
`TextReader.tsx`. The EPUB margin still had the legacy `AiPanel` modal and a
single "Explain" chip — no briefing, no streaming card, no margin-help.

Operator chose **full parity**, so the whole AI stack was ported into EpubReader
(reusing the existing components — no logic forked):
- **Streaming tutor**: the selection card's "Explain" chip became Explain ·
  Context · Define, each spawning a CFI-anchored `TutorDraft` rendered by the
  same `MarginTutorCard` (immediate stream, concise default, Go deeper, Ask
  another way → Socratic, save → TutorNote). The toolbar ✻ tutor button now
  spawns an Explain draft from the live selection instead of opening the old
  modal. `AiPanel` is no longer used by the reader.
- **Deep Study briefing**: `SectionBriefingCard` renders in the EPUB margin once
  the session has started and the section's text is captured. Section text is
  read from the **already-rendered epub.js iframe** (`doc.body.innerText` in the
  "rendered" handler) — no new epub parsing path — reset on Next/Prev so the
  briefing always matches the visible section.
- **Margin-help**: loads `margin_help`; Quiet suppresses the hint, Guided/Deep
  show it, Deep Study prepares the briefing. (EPUB's margin is an always-visible
  in-flow aside, so there's no panel toggle to wire — simpler than TextReader.)
- CFI anchors flow through `cmd_ai_ask`/`cmd_save_ai_response_as_note` unchanged
  (they're opaque locator strings); saved tutor answers paint as epub.js
  highlights via the existing annotation effect.

Honest gap: EpubReader's glue (epub.js + iframe) can't run in jsdom, so the
**EPUB-specific wiring has no unit test** — it reuses components that are tested
(MarginTutorCard 5, SectionBriefingCard 3, sectionBriefing parser/cache 7).
Verified by typecheck + build + manual QA in the live window; flagged here so the
coverage gap isn't silent. The streaming cards' auto-scroll-to-tail looks for a
`.tl-sidepanel` ancestor (TextReader's container) and no-ops inside the EPUB
`.tl-margin` — streaming still works, just without follow-scroll; acceptable for
parity v1.

⚠️ AGENTS.md tension (unchanged from passes 4/6, now also on the EPUB side):
this further softens "AI is prompt-preview only" and "EPUB later / text-first."
Same mitigations (opt-in mode + tutor consent + session-start + local-only).
Flagged for the operator to update the contract.

Gates: `npm test` 62 / 11 files (no new FE tests — see gap above), typecheck 0,
build ✓; backend unchanged (`cargo test` 105 + 2 integration).

## Pass 6 — wire margin-help modes (Quiet / Guided / Deep Study)

Live QA finding (operator): selected Deep Study at book setup, opened the book —
"there was nothing in the margins." **Root cause: `margin_help` was a dead
setting.** BookSetupSheet wrote it (→ `cmd_configure_plan` →
`settings::set_string(KEY_MARGIN_HELP)`), but nothing ever read it back — no
reader code, no AI command, and it wasn't even on `SettingsDto`. All three chips
produced identical behavior.

Wired all three modes to real, distinct reader behavior:
- **Quiet** — panel stays closed; opens only when you explicitly capture
  (highlight / note / tutor); empty-state hint suppressed. Truly out of the way.
- **Guided** (default) — panel stays closed but **opens the moment you select
  text** (help one glance away) and shows the gentle empty-state hint.
- **Deep Study** — on session start, the margin opens with a prepared
  **Section Briefing** for today's section (everything Guided does, plus the
  briefing).

The Section Briefing (the operator's spec): a spoiler-safe, five-part
orientation — **Before you read · Watch for · Key terms · The move · Reading
question** — generated locally from the section and shown as one dismissable /
regenerable card with provenance ("Prepared on this Mac for today's section").

Implementation (no new command, no DB migration — reuses the streaming path):
- `ai_stub.rs`: new `StubMode::SectionBriefing` (five labeled parts, spoiler-safe,
  fenced + safety preamble preserved). Mode-aware input cap: the briefing sees
  up to 6000 chars of the section (`truncate_selection_to`) vs the 2000-char
  lens cap. `commands/ai.rs`: `SECTION_BRIEFING_MAX_TOKENS = 480`. The existing
  `cmd_ai_ask` already accepts any mode via `StubMode::from_str`, so the frontend
  just calls it with `mode:"section_briefing"`, `selection:<section text>`.
- `settings.rs` + `types.ts`: expose `margin_help` on `SettingsDto`.
- `src/sectionBriefing.ts`: localStorage cache keyed exactly as specced
  (`bookId | sectionId | source_sha256 | mode`) + a tolerant five-label parser.
  The briefing is **never exported** (a local, reversible cache, not DB state).
- `src/components/SectionBriefingCard.tsx`: cache-hit renders instantly (no
  call); otherwise streams + caches on done. `tl-tutor.css`: briefing styles.
- `TextReader.tsx`: loads `margin_help`; Guided selection-nudge; Deep Study
  opens the panel + renders the briefing once `session != null` (so it never
  runs before the reader starts the session) and the section text is loaded.
- `BookSetupSheet.tsx`: honest per-mode descriptions.

Privacy / opt-in (kept the line):
- The briefing **never auto-fires without tutor consent** — if Deep Study is on
  but the tutor isn't enabled, the card shows a "Prepare briefing" button
  (tapping it consents + runs) instead of calling. It only runs after the
  session starts (an explicit action), local-only enforced at the call site,
  spoiler-safe, cached, dismissable, regenerable — never in the background.

⚠️ AGENTS.md tension to confirm (sharper than before): line 13 says "No
automatic summaries or autonomous AI behavior," and line 15 "AI is
prompt-preview only until a later phase." The Section Briefing is the closest
thing yet to an automatic summary — it's generated on session start. The
mitigations above (opt-in mode + opt-in tutor consent + session-start trigger +
local-only + dismissable) keep it *reader-initiated* rather than autonomous, and
it's exactly the feature the operator designed and requested. But it does soften
those two lines — flagged for the operator to update the contract rather than
have me rewrite it unilaterally.

Live smoke test (LM Studio `gemma-4-31b-it-mlx`) on the Augustine opening: the
briefing returned all five labels, no markdown headers, 181 words, spoiler-safe,
bullets prefixed — parses cleanly.

Gates: `npm test` 62 passed / 11 files (+10: parser/cache + briefing card),
typecheck 0, build ✓; `cargo test` 105 passed / 0 failed (+2: briefing prompt
shape + larger input cap) + 2 integration.

---

## Pass 5 — reader polish: reflow, default panel, revocable tutor consent

Three live-QA nits, all fixed:

1. **Orphaned "a particle" line / free-verse look.** The real source is Project
   Gutenberg **hard-wrapped** plain text (a `\n` every ~70 chars). `.tl-readcol p`
   had `white-space: pre-wrap`, so every soft-wrap newline rendered as a hard
   break — each source line became its own display line in a narrow window, and
   a soft-wrapped tail word ("a particle") got stranded in a wide one. Fix:
   `splitParagraphs` now collapses intra-paragraph newlines to spaces (the swap
   is **length-preserving**, so highlight/selection char offsets stay aligned),
   and the `pre-wrap` was dropped so prose reflows to the column. Files:
   `src/screens/TextReader.tsx`, `src/tl-theme.css`.

2. **Unbalanced default window ratio.** At the 960px default window the notes
   panel opened at 320px (a third of the window) showing only placeholder text.
   The panel now **defaults CLOSED** — the reader opens to a clean, full-width
   centered column at any window size. It auto-opens the instant the reader
   captures something (highlight / note / tutor — those handlers already call
   `setPanelOpen(true)`), and the toolbar toggle shows a count badge when the
   section has notes, so nothing is hidden silently. The open/width choice still
   persists, so this only changes the first-run default.

3. **Tutor consent had no off-switch.** Clicking "Enable" on the in-margin
   consent card wrote `rg.tutorEnabled=true` (persisted) — a one-time gate by
   design, but there was no way to revoke it. Added a **"Local AI tutor" toggle
   in Settings → Assistance**: turning it off re-arms the consent card before the
   next call, completing the opt-in/opt-out privacy posture. Consent state is now
   a single shared source of truth, `src/tutorConsent.ts`
   (`isTutorEnabled`/`setTutorEnabled`), used by both the card and Settings.

Tests: +7 (frontend 45→52). New `splitParagraphs` reflow suite (offset
alignment + length-preserving), new `tutorConsent` suite (default-off,
persist, revoke), and the panel-toggle test rewritten for the default-closed
behavior + count badge.

Gates: `npm test` 52 passed / 9 files, typecheck 0, build ✓. (No backend
change this pass; `cargo test` unchanged at 103 + integration.)

## Pass 4 — concise-by-default tutor + a reader-pulled "Go deeper"

Live QA finding (operator): the streaming answer works and looks great, but the
DEFAULT is too long — a ~3-sentence selection produced a ~350-word answer with
`###` headers, a numbered list, an "underlying assumptions" section, and a
closing question. A wall of text in a 320px margin competes with the reading it
is meant to unblock. The operator asked for concise-by-default with an explicit
"go deeper" — and flagged it as central to the *learning* experience.

Two root causes (both fixed):
1. **The prompt invited an essay.** The Explain directive literally asked for
   "what the author is arguing **and what assumption it rests on**" — a two-part
   analytical task, so the model produced two sections.
2. **No `max_tokens` ceiling.** `build_request_body` sent no length cap, so the
   server's ~512 default was exactly the room the wall used. A prose-only "keep
   it short" had nothing backstopping it (the local model ignored it).

Design (from a 4-perspective pedagogy panel — cognitive-load, desirable-
difficulty, progressive-disclosure, tutor-at-the-elbow — they converged):
- **Brief by default**: the smallest answer that unblocks the passage and
  returns the reader to the text. Per-lens length: Explain ~2-3 sentences,
  Context ~1-2, Define ~1 line/term, Socratic = one question.
- **"Go deeper" is reader-pulled and APPENDS below the brief** (never replaces
  it), so the gist stays on screen as an anchor. Deep targets a *different
  altitude* — brief = WHAT it means, deep = WHY/HOW it works — because the
  backend is single-shot with no memory, so each deep prompt is told the reader
  already saw the brief and must not restate it.
- After deep (the deepest tier), "Go deeper" is replaced by **"Question me"**
  (Socratic), so the terminal move is the reader generating, not consuming.
- Brevity enforced **two ways together**: tightened per-lens directives AND a
  hard `max_tokens` ceiling — the real guardrail. **Brief 90 / Deep 256**
  tokens; utility modes DurableNote 160 / PrepareNext 320. A client-side
  `stripHeadings` sanitizer demotes any leaked `###` before render.

Implementation:
- `ai_stub.rs`: added `Depth { Brief, Deep }`; `build_prompt_with_depth(mode,
  depth, ctx)` with new brief/deep directives per reading lens; `build_prompt`
  now == the Brief tier (back-compat). Utility modes ignore depth. Fence +
  safety preamble preserved on every (mode, depth) — the Shot 5 M2 injection
  invariant still holds (new test pins it).
- `ai_client.rs`: `ChatRequest.max_tokens` (skipped on the wire when None);
  `build_request_body` + `ChatCallOpts` carry it.
- `commands/ai.rs`: `cmd_ai_ask` gained an optional `depth` arg; per-tier
  `max_tokens_for(mode, depth)` ceiling applied to the call.
- `MarginTutorCard.tsx`: brief→deep state, "Go deeper" appends a second tier
  under a quiet "Deeper" rule, post-deep "Question me", save now concatenates
  brief + deep + optional takeaway. `tl-tutor.css`: the deep divider.
- Tests: backend +7 (depth split, no-restate, fence-preserved, max_tokens wire,
  Depth::from_str); the mock integration test now asserts the cap reaches the
  server; frontend tutor suite rewritten to 5 (brief default + Go deeper append
  + save brief+deep + Ask-another-way reset).

Live smoke test against LM Studio (`gemma-4-31b-it-mlx`) on the actual Augustine
passage: **brief = 47 words, no headers** (was 350+ with `###`); **deep = 119
words, no headers**, at a genuinely different altitude (the epistemological
"know vs. call" paradox and how grace precedes effort). The wall is gone.

Forks the panel surfaced (operator can retune live): brief cap 90 (vs 110),
deep cap 256 (vs 200/320), deep ends on the idea not a question, minimal
post-deep affordances. I took the panel's recommendations on all four; they're
one-line constants (`BRIEF_MAX_TOKENS` / `DEEP_MAX_TOKENS` in `commands/ai.rs`)
and chip wiring, trivial to adjust after you feel them in the window.

Gates after this pass: `npm test` 45 passed / 8 files, typecheck 0, build ✓,
`cargo test` 102 passed / 0 failed + 3 integration tests; `ai_acceptance` and
`shot1_acceptance` examples OK.

---

## Pass 3 — streaming tutor (replace prompt-preview with a live answer)

Live QA finding (operator, in the real window): the tutor only ever showed a
*prompt* ("Prompt preview — nothing is sent"), never an answer — "the AI stuff
isn't working." Root cause: the Companion-Margin card called the no-network
`cmd_generate_prompt_preview` and stopped there. But the streaming backend
already existed and was unused by this surface — `cmd_ai_ask` streams
`StreamEvent {delta|done|error}` over a Tauri `Channel`
(`src-tauri/src/ai_client.rs`, registered in `lib.rs`), exactly as `AiPanel.tsx`
already uses it. LM Studio runs locally on `:1234` (the default endpoint).

Fix — rewrote `src/components/MarginTutorCard.tsx` (same prop contract, so
**no TextReader change**) per the operator's redesign spec:
- Clicking a lens (Explain / Context / Define) now fires `cmd_ai_ask`
  **immediately** and streams the answer into the card — no draft, no prompt
  preview, no takeaway gate. The lens flows straight through from the existing
  selection popup via `TutorDraft.mode`.
- State machine `consent → thinking → streaming → done` (+ `error`). A cycling
  per-lens verb-ing status ("Reading the passage… → Thinking… → Writing…"),
  a 2-line collapsed serif quote chip with the locator, a blinking caret on the
  streaming tail, markdown bold/italic, and panel auto-scroll that yields once
  the reader scrolls up.
- **No thinking trace.** This backend emits only content deltas (no separate
  reasoning stream), so per the spec the trace is skipped entirely rather than
  faked.
- Post-answer: "Ask another way" chips (Explain · Context · Define · Socratic —
  Socratic appears only here, never in the popup) re-fire the call for the same
  selection; "Save as note" + "Regenerate". Save reveals an **optional**
  takeaway and persists via the existing `cmd_save_ai_response_as_note`
  (TutorNote, anchored) — the same approval path `AiPanel` uses. A long answer
  can be collapsed (chevron) to a one-line peek to make room for the next one.
- In-flight streams are soft-cancelled (channel-ref guard) on lens switch,
  regenerate, close, or unmount — no orphaned streams.
- New stylesheet `src/tl-tutor.css` (tl- tokens only, no framework; one accent
  moment; light+dark; `:focus-visible` rings; honors `prefers-reduced-motion`).
- Tests: rewrote `MarginTutorCard.test.tsx` (5 tests: opt-in gate, immediate
  stream with no prompt surface, save with/without takeaway, Socratic re-ask).

Privacy / posture:
- Prompt construction + injection hardening stay **server-side**
  (`ai_stub::build_prompt`); the UI never renders the prompt. `local_only`
  stays enforced at the Rust call site. The saved body is the tutor's
  explanation (a paraphrase) + the reader's optional words — never the raw
  passage; `anchored_text` is DB-only (the export-privacy test in `ai.rs` still
  passes).
- **Opt-in:** the first lens click shows a one-time consent card ("Enable the
  local tutor? Runs <model> on this Mac — nothing leaves your device") before
  anything runs; the choice persists (`localStorage rg.tutorEnabled`). This
  honors AGENTS.md's "no AI calls by default" while enabling the live answer.

⚠️ AGENTS.md tension to confirm: line 15 still says "AI is prompt-preview only
until a later phase." The backend ask path (Shot 4) is already shipped and wired
to `AiPanel`; this pass brings the margin in line with it (local-only, opt-in).
The "prompt-preview only" line now reads as stale — flagged for the operator to
decide whether to update the contract, rather than rewriting it unilaterally.

Gates after this pass: `npm test` 45 passed / 8 files, typecheck 0 errors,
build ✓, `cargo test` 95 passed / 0 failed (+ integration suites green).
Still unverified (needs a human pass in the window): that a real answer streams
end-to-end against LM Studio, the verb-ing/caret feel, light/dark, and Save →
TutorNote round-trip after the rewrite.

---

## Pass 2 — live QA in the real window (reader relayout)

The operator launched the real Tauri app (`npm run tauri dev` with isolated
`THROUGHLINE_DATA_DIR`/`THROUGHLINE_EXPORT_DIR` under `/tmp`), imported the real
Project Gutenberg *Confessions*, and drove M1–M2 by hand. **This is the first
human-eyes pass** — it surfaced layout defects the headless tests could not.

Findings (from operator screenshots):
- **Reading text was pinned to the left with a large dead right gutter, and did
  not respond to window size.** Root cause: `.tl-reader-body` always reserved
  `padding-right: 312px` for an absolutely-positioned margin rail, so the reading
  column centered in the *leftover* space even when the section had **no notes**.
- **No way to toggle or resize the notes pane** (the design + the operator's
  Codex reference both want a collapsible, drag-resizable side panel).
- **Tutor/AI "wasn't working"** in the window — same root cause: a spawned tutor
  draft card landed in that empty/clipped absolute rail, so it was effectively
  invisible.

Fix (this pass) — rebuilt the reader as a real side-panel layout:
- `.tl-reader-body` is now a **horizontal flex row**: `.tl-reader-main` (the
  scroll region, with the reading column centered in its *actual* width and
  responsive to the window) + an in-flow `.tl-sidepanel`.
- The side panel **collapses** via a toolbar toggle (`columns` icon, with a
  count badge when collapsed while notes exist) and **drag-resizes** via a
  `.tl-panel-resizer` handle; open-state and width persist to localStorage
  (`rg.panelOpen` / `rg.panelWidth`, clamped 240–560px via `clampPanelWidth`).
- **Cards render in document order** inside the panel (notes by anchor, then live
  tutor drafts) — the absolute `cardTops` positioning that hid cards is gone, so
  a spawned tutor draft is always visible; spawning/saving auto-opens the panel.
- When no notes exist, the reading column now centers in the **full window**.
- Files: `src/screens/TextReader.tsx`, `src/tl-theme.css`,
  `src/screens/TextReader.test.tsx` (+ `clampPanelWidth` unit tests and a
  panel-toggle render test; suite 38 → 44 frontend tests).

Still unverified (needs another human-eyes pass in the window): that the new
panel *visually* matches the design and the Codex reference, drag feel, the
narrow/wide + light/dark sweep (M12), and that the tutor card now renders and
saves correctly end-to-end in the live app (M7/M8 were not re-driven after the
relayout).

---

## Pass 1 — headless hardening

## Environment reality (why no screenshots)
This pass ran in a **headless agent environment** — no display server
(`DISPLAY` unset), so `npm run tauri dev` cannot open a window and **no real
screenshots are possible**. Per the workflow, screenshots were **not faked**.
Instead the command/headless layers were strengthened (focused tests) and the one
genuine in-scope code defect found was fixed and unit-tested. Rendered-UI items
(M6 selection geometry in a live window, M12 visual/responsive/theme) remain
human-only and are flagged in `SHOT1_RC.md`.

## What changed this pass
- **Selection toolbar placement (priority-4 defect: "selection toolbar placement").**
  The floating toolbar positioned itself from raw `getBoundingClientRect` coords
  with `transform: translate(-50%, calc(-100% - 8px))` and **no clamping**.
  Real consequences: selecting the first word of a line pushed the toolbar's left
  half off the reader's left edge; selecting the top line clipped the toolbar above
  the reader. Fixed with a pure, exported `clampToolbarPosition(rawX, rawY,
  readerWidth, opts)` helper that:
  - clamps the toolbar center-x so its half-width stays within `[0, readerWidth]`
    (and centers it when the reader is narrower than the toolbar), and
  - flips the toolbar **below** the selection (new `.tl-seltoolbar.below` CSS,
    dropping the upward translate) when there isn't room above it.
  Files: `src/screens/TextReader.tsx`, `src/tl-theme.css`.

- **Tests for the changed behavior.** Added 5 `clampToolbarPosition` unit tests in
  `src/screens/TextReader.test.tsx` (centered passthrough, left-edge clamp,
  right-edge clamp, top-line flip-below, narrow-reader centering).

## Audit findings that needed NO change (verified already correct)
- **Real import + chapter sectioning** — `shot1_realtext` against the genuine
  PG#3296 text: ~73 chapter-like sections, zero "Part N" fallback.
- **No-behind-on-import / calm Today** — `plan_ready` ⇒ `NotStarted`, no forecast,
  no recovery panel; "Plan ready. You are not behind." (jsdom + probe).
- **10-minute rescue** — Today offers it always; reader shows the calm banner;
  recap header reads "That counts" and never forces completion (jsdom).
- **TutorNote save requires user words** — Save disabled until a non-empty
  takeaway; the prompt/passage are never the body (jsdom + Rust regression).
- **Markdown privacy** — exported note carries `source_private: true` + user words
  only; raw passage and prompt fence absent (Rust regression + real-text probe).
- **No "Restart current chapter"** — removed from the recovery options; a Today
  test pins that it never renders.
- **Notes browser** is intentionally read-only; re-export (stable filename, update
  not duplicate) is the backend's job on save/update, already covered.

## Copy / a11y review (no churn warranted)
Scanned Today/reader/setup copy for dashboardy or shamey language: none found
beyond the intended, calm streak line ("You read N of the last 7 days." — a gentle
count, not a punishment) and the honest forecast line. Toolbar/icon buttons already
carry `aria-label`s and `disabled` states; the selection toolbar has
`role="toolbar"` + `aria-label`. No accessibility regressions introduced; no
decorative changes made.

## Validation (this pass)
See `SHOT1_RC.md` for the standing M1–M12 table. Gates run at the end of this pass:
`npm test`, `npm run typecheck`, `npm run build`, `cargo test`,
`cargo run --example shot1_acceptance`, and
`cargo run --example shot1_realtext -- /tmp/rg_realtext/confessions.txt`.

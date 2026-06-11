# Stage 2 Handoff — Throughline "Today / Plan" screen redesign

You are picking up a frontend redesign with **zero conversational context**. This file is
everything you need. Read it fully before touching code. **Delete this file in your final
commit.**

Throughline is a local-first macOS reading app (Tauri v2 + React 19 + TS + Vite frontend,
Rust backend). A prior "Stage 1" rewrote the reading **engine**: a book is now chunked into
time-sized **sittings** sized to the reader's chosen sitting length, progress is a single
**position** (`reading_position`, section-relative), and "today" is the sitting that contains
that position. The concept of being "behind" was deliberately deleted. **Stage 1 is merged to
`main` and is green.** Stage 2 is the **screens** that sit on top of that engine.

You are on branch **`stage2-screens`** (off `main`). `main` is green and untouched; nothing
ships from it. Work only on this branch.

---

## 1. Branch state

Two commits are landed on `stage2-screens` beyond `main`:

- `ce3d822` **contract** — Rust `TodayCard` gained `sitting_start_locator` / `sitting_end_locator`
  (the current sitting's global byte span); the TS `TodayCard` was rewritten to the new shape.
  The Rust side is **green** (280 lib tests, clippy clean) — do not touch the backend unless the
  reader contract below genuinely requires it (and if it does, that's a schema/contract question —
  see the stop-list).
- `ef8a40a` **Today.tsx redesign (WIP)** — `src/screens/Today.tsx` is fully rebuilt to the design
  handoff (see §8) and is **contract-correct against the new `TodayCard`**. It is not the source of
  any red test.

### Red-test baseline (expected; this is the work)

Rust: **green** (280 passed, 7 pre-existing `#[ignore]` in `ai_providers.rs` — never touch those).

Frontend `npm run typecheck`: **60 errors across 5 files**, every one because the file still uses
the **old** `TodayCard` contract and awaits rewrite to the new one:

| File | Errors | Why it is red |
|---|---|---|
| `src/screens/Today.test.tsx` | 51 | The entire old-screen test suite: fixtures carry `section_completed`/`pace`/`recovery`/`streak`/`forecast`/`plan_status`/`monthly_pct`, props pass `onStartRescue`, assertions target old states. **Rewrite to the new five states.** |
| `src/components/PlansView.tsx` | 5 | Reads `today.pace` / `monthly_pct` / `day_index` / `total_days` for a progress line. |
| `src/App.tsx` | 2 | Passes `onStartRescue` to `<Today>` (prop removed) at the two `<Today>` call sites. |
| `src/screens/TextReader.test.tsx` | 1 | Fixture has `section_completed`. |
| `src/App.test.tsx` | 1 | Fixture has `section_completed`. |

**HARD RULE — non-negotiable:** red tests are **rewritten to the new contract**. Never delete a
test, never `it.skip`/`it.only`, never `// @ts-ignore`, never weaken an assertion to get green.
If a test asserted behavior that no longer exists (e.g. "shows Behind · N days"), the *replacement*
test asserts the new behavior ("behind" is unrepresentable; the calm state renders instead). A
deleted-to-go-green test is a regression you've hidden from yourself.

---

## 2. The new `TodayCard` contract (what `cmd_today` returns)

Defined in `src/types.ts` (and Rust `src-tauri/src/models.rs` — already done). Fields:

```ts
interface TodayCard {
  book: Book;
  plan: ReadingPlan;
  state: "day_one" | "reading" | "returning" | "finished" | "no_plan";
  chapter_label: string;        // ALWAYS present, never blank/loading
  phrase: string | null;        // AI evocative phrase; null until Stage 3 (relay). Label carries it now.
  estimated_minutes: number;    // the CURRENT SITTING's reading time
  fraction_complete: number;    // 0..1, for the hairline. Never shown as a number.
  next_label: string | null;    // finished-state forward pull
  section: BookSection | null;  // the section to open for "Continue reading"
  sitting_start_locator: number | null; // current sitting's global byte span [start, end)
  sitting_end_locator: number | null;
  resume_locator: string | null;        // a global byte-offset string; where the cursor opens
  resume_percent: number | null;
  memory: TodayMemory;          // "Last time" surface (unchanged from before)
  teaser?: TodayTeaser | null;
}
```

The dead fields you must purge from the frontend: `day_index`, `total_days`, `pace`, `recovery`,
`streak`, `forecast`, `plan_status`, `monthly_pct`, `section_completed`, `session_minutes`. (The
DoD includes a grep-clean check for exactly these.) The now-unused TS types `PaceState`,
`RecoveryOption`, `RecoveryBundle`, `StreakSummary`, `RecomputedPlan` in `types.ts` should be
removed once nothing references them (grep first; `FinishForecast` may still be referenced —
check).

---

## 3. Remaining work, IN THIS ORDER

Do them in this order on purpose: the highest-risk, load-bearing piece first while context is
freshest; verification last.

1. **TextReader session-bounding** (the load-bearing one — the reader is the soul; a break here
   is the P0 the golden loop exists to prevent). See §4 for the exact contract and §5 for the map.
2. **`Today.test.tsx` rewrite** — rebuild the suite for the five states. Doing it right after the
   reader locks the contract in tests before the rest drifts.
3. **`BookSetupSheet.tsx` → one question** — see §8 (the plan handoff is the spec). It must call
   `cmd_configure_plan({ bookId, sittingLengthMinutes, name })` (new signature: book_id, an i64
   sitting length, optional name — the old finish-date/days-per-week/margin-help/name args are
   gone). Margin-help moved to Settings; do not reintroduce it here.
4. **`PlansView.tsx` + `App.tsx` wiring** — PlansView's progress line uses `fraction_complete`
   (a percentage is fine for the *manage-plans* view; it is not the calm Today screen). In App.tsx:
   remove `onStartRescue` from both `<Today>` call sites and delete the `startRescue` function and
   the rescue-mode plumbing (the "I only have 10 minutes" fork is cut by the design).
5. **CSS + dark mode** — style the new `tl-desk*` / `tl-hairline` / `tl-check-ring` classes
   `Today.tsx` already uses, plus the new plan screen, to the design handoff (warm paper, forest
   green, Source Serif title; warm low-contrast dark via `:root[data-theme="dark"]`, which already
   exists in `src/App.css`). Reuse `--tl-*` tokens.
6. **Full verification + manual offline golden loop** (last). See §7 DoD.

---

## 4. The reader integration contract (precise)

Today, `TextReader` reads the **assigned section** and lets the reader navigate Next/Prev across
sections; a session brackets reading and ends with `cmd_end_session`. The Stage-2 change is to
**bound a session to one sitting**, not to rebuild progress tracking:

- The session's reading view bounds to **`[sitting_start_locator, sitting_end_locator)`** (global
  byte offsets, on the `TodayCard`). The reader opens at **`resume_locator`** within that span.
- Ending the session calls `cmd_end_session` with **`end_locator` = the sitting's end** (i.e.
  `sitting_end_locator`). **Stage 1 already wired `cmd_end_session` to advance `reading_position`
  from `end_locator`** (it calls `sittings::record_progress`, which MAX-clamps `furthest`). So the
  moment a session ends at the sitting's end, the next `cmd_today` returns the **next** sitting and
  **Today rolls forward on its own.** You are not writing progress tracking — it exists.
- A session must **never render or persist anything outside its `[start, end)` span** (no notes,
  no progress, no reading beyond the sitting end). Mid-session position saves
  (`cmd_save_section_progress`) already advance `reading_position` too (Stage 1) — keep them within
  the span.
- `sitting_*` and `section` can disagree in scope: a sitting may be a *sub-range* of a long chapter
  (split) or *span several short chapters* (merged). The section is for chapter labeling /
  note-grouping; the **sitting span is the session boundary**. Locators are global byte offsets
  into the book body; `start_locator`/`end_locator` on a `BookSection` are the same coordinate
  system (strings; `parseInt`).

Backend note: do not add backend fields casually — that's the stop-list ("new schema or
migrations"). The current contract (`sitting_start_locator`, `sitting_end_locator`, `resume_locator`,
`section`) is sufficient to bound the reader. If you believe it is not, stop and flag it.

---

## 5. `src/screens/TextReader.tsx` map (1,489 lines)

Key regions for the bounding work:

- **L27–28** — `TextReader({ today, mode, onExit })`; `const { book, section: assignedSection } = today`.
  `mode` is `"full" | "rescue"` — **rescue is being removed** (App.tsx no longer passes it); simplify
  to a single mode or drop the prop, and remove rescue-only branches (`const rescue = mode === "rescue"`).
- **L34–143** — component state: `assignableSections`, `currentIdx`, `text`, `session`, `reachedEnd`,
  notes, tutor drafts, selection, margin-help, etc.
- **L170–205** — section-list load + **session start**. Computes `baseOffset` from the section's
  `start_locator`; `startLoc = today.resume_locator ?? makeCharLocator(baseOffset)`; calls
  `cmd_start_session`. **This is where the view should bound to the sitting span** (open at
  `resume_locator`, clamp the readable range to `[sitting_start_locator, sitting_end_locator)`).
- **L208–260** — section **text load** (`cmd_read_section_text`) + structure (`cmd_read_section_structure`)
  + **resume scroll** (`parseLocator(today.resume_locator)` → within-section offset). Bounding likely
  means: load the section text but clamp the rendered/active region (and the "end" target) to the
  sitting's end.
- **L342–385** — locator math: `makeCharLocator(baseOffset + off)` from scroll offset; the current
  read position. The "reached end" / completion logic keys off here.
- **~L421 and ~L463** — **`cmd_end_session`** call sites (two paths: normal end + a guarded/forced
  end; there's a "double-end guard" at L96–100). Ensure `end_locator` lands at the sitting end when
  the reader completes the sitting.
- Helpers `makeCharLocator` / `parseLocator` are imported from `src/types.ts`.

The reader is large and does a lot (tutor, notes, margin-help, font/width). **Scope your change to
the session bounds + completion locator.** Do not refactor the tutor/notes machinery.

---

## 6. The five-state mapping (1:1 from `cmd_today.state`)

`src/screens/Today.tsx` already implements all five — read it as the reference, but the mapping is:

- **`day_one`** — "Beginning today" kicker; bare hairline (no fill); two calm lines ("We've set an
  unhurried pace." / "There's no clock but your own."); **Begin reading**.
- **`reading`** — time-of-day kicker ("This evening" etc.); hairline filled to `fraction_complete`;
  orientation = the **phrase line** (`chapter_label`, or `"{chapter_label}, {phrase}"` once Stage 3
  fills `phrase` — the slot is reserved for a zero-CLS swap) + "About N minutes."; **Continue reading**.
- **`returning`** — "Welcome back" kicker; filled hairline; "The story kept your place." /
  "{chapter_label} is waiting where you left it."; **Continue reading**. No tally of the gap, ever.
- **`finished`** — a check ring + "You finished {book}." + a quiet "Review your notes" / "Find
  another book". No primary reading button.
- **`no_plan`** — the book still owns Today; "Start a plan" (calls `onNewPlan`).

`chapter_label` is always present, so **no blank/loading label state exists** — keep it that way.

---

## 7. Stage 2 — Definition of Done & stop-list (VERBATIM; report against this once, at the end)

**Definition of done — report once, with evidence:**
- All five states (day_one / reading / returning / finished / no_plan) render per the design
  handoff, mapped 1:1 from `cmd_today.state`.
- `chapter_label` carries every screen; the phrase slot reserves its space *now* so Stage 3's
  arrival is a pure text swap with zero layout shift; no blank or loading label state exists anywhere.
- The hairline binds to `fraction_complete`; "Continue reading" opens at `resume_locator`, the
  session bounds to the sitting's span, and completing it advances `reading_position` so Today rolls
  forward on its own.
- `BookSetupSheet` asks exactly one question; extend-finish-date / recovery UI gone.
- Frontend grep-clean for the dead fields: `day_index`, `total_days`, `pace`, `recovery`, `streak`,
  `forecast`, `plan_status`, `monthly_pct`, `section_completed`, `session_minutes`.
- TS build green, lints green, frontend tests green; the golden loop (import → setup → today → read
  → complete → note → export) works in the running app fully offline — a manual pass is fine, just
  say so.
- One closing summary: what landed, test counts with evidence.

**Stop-list (otherwise proceed end-to-end, no check-ins, execution within the design needs no
permission, multiple commits fine, branch ends green):** new schema or migrations; deviation from
an agreed design; anything touching the relay contract; anything destructive outside this scope.

**Process:** report once at the end against the DoD, no progress updates. **Your final commit
deletes this `STAGE2_HANDOFF.md` file.**

---

## 8. Design spec of record (visuals)

- **Today screen:** `~/Downloads/design_handoff_throughline_today/` — `README.md` is the exact spec;
  Direction **A** ("The book on the desk") is the chosen direction. `reference/Today Screen.html` +
  `today-screen.css` are the visual source of truth.
- **Plan screen (BookSetupSheet):** `~/Downloads/design_handoff_throughline_plan/` — `README.md` is
  the spec; Option **2** ("One question") is chosen. Tokens (light + warm dark) are in both READMEs.
- House rules from both: no em dashes in any rendered copy; sentence case; Source Serif 4 for the
  title/author/evocative phrases, Inter/system sans elsewhere.

## 9. Mid-build gotchas this session knows

- `Today.tsx` is already done and contract-correct — don't rewrite it; style it and wire it.
- The phrase slot: render the `chapter_label` line always; reserve up to two lines of height so the
  Stage-3 phrase append never shifts layout (CLS = 0).
- Standing engine invariant (Stage 1): when staleness is uncertain, **preserve the cache, never
  delete on a failed/empty read** — already enforced in `sittings::rebuild_if_stale`; don't undo it.
- `cmd_configure_plan` signature changed to `(book_id, sitting_length_minutes, name?)`. The "I only
  have 10 minutes" rescue fork is gone by design — remove its plumbing, don't preserve it.
- The deferred items (do NOT build): StyleRange persistence for heading-tier splits; the soft-horizon
  "finish around {month}" tooltip. Both are post-launch.

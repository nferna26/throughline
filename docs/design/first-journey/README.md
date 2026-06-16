# Handoff: Throughline — the first journey (front door → Today)

## Overview

Throughline is a calm, local-first macOS reading app (Tauri v2 + React). This handoff covers the **entire first journey** a new reader takes, designed as one continuous, well-kept bookshop:

1. **Front door** (welcome / empty state) — *anchor, locked*
2. **Browse the library** — *the main redesign*
3. **Book chosen** — *transition*
4. **Your reading pace** — *the one new question*
5. **Today** — *anchor, locked*

The feeling to hold: opening Throughline for the first time should feel like walking into a calm bookshop and being handed something you've meant to read — never being onboarded into an app. Covers, type, warmth, and voice stay unbroken from screen to screen.

## Voice & brand (binding)

Warm, plainspoken, literary; sentence case; **no emoji, no hype, no exclamation points**. Tokens (light / warm-dark) — pull these from the app's existing token set, don't hardcode:

| | Light | Warm dark (not black) |
|---|---|---|
| paper / page | `#F4F1EA` | `#1C1914` |
| surface | `#FBFAF6` | `#242018` |
| card | `#FFFFFF` | `#2A251D` |
| ink | `#1A1A18` | `#ECE7DC` |
| muted | `#6B6B66` | `#9C968A` |
| faint | `#98937F` | `#7B7567` |
| border | `#E5E1D8` | `#383329` |
| primary / accent | forest `#2E4A37` / `#3E7A4E` | sage `#A7C5B1` |
| on-primary | `#F4F1EA` | `#16140F` |

Type: **Source Serif 4** for the voice (headlines, book titles, blurbs), **Inter** for UI, a mono face for the activation code. Covers use a cloth/letterpress treatment (see below).

## ⚠ Anti-patterns (binding — Matter is the inverse, do not drift toward it)
No multi-step funnel, no streaks / daily goals / "% smarter" / habit framing, no aspirational-pressure or guilt copy, no quizzes / occupation or topic pickers, no account / sign-in / magic link, no subscription / trial / paywall, no mascot illustrations, no dark-by-default (warm paper is home). Reading is always free; the covers do the inviting.

## About the design files

`reference/First Journey.html` is the **source of truth for layout, copy, and the screen-to-screen handoffs** — all five screens, light + dark. `reference/First-Run Screen.html` is the standalone front-door reference (richer detail + the full activation-state set: resting → entering → success → wrong / expired / already-used; see that file's own states). Re-implement as React components using the app's tokens and primitives. The window chrome in the mocks is context only.

---

## The covers — the connective thread (carried through every screen)

Covers are **generated from title + author** (a cloth-bound treatment), so they scale to any of the 77k books — there is **no per-book cover art in the data**. Each cover: a cloth-weave fill in one of a small set of warm cloth colors, a spine ridge + inner shadow on the left edge, a gilt (`rgba(216,186,128,.34)`) inner frame, and letterpress serif title + italic author. The *same cover object* appears at four sizes — full-size trio on the front door, small spines on the browse shelves, full-size on the chosen screen, and as the title on Today — so the reader's eye follows one book the whole way. This is the single most important continuity device; keep it identical everywhere.

---

## 1 · Front door (locked)
The established welcome screen: serif hero "Begin with a book you mean to finish.", a shelf of three cloth covers (the primary invitation — click a cover to start reading at once), "Browse the library" + "Import a .txt or .epub", one quiet trust line ("Everything stays on this Mac, no account, no cloud, nothing tracked"), and a calm "Bought Throughline? Enter your code" affordance. Do not redesign; everything downstream must match its craft. Full detail + activation states in `reference/First-Run Screen.html`.

---

## 2 · Browse the library (the main work)

A calm, **cover-forward, symmetrical** shelf — the *layout* logic of Apple Books' Book Store, in Throughline's warm-paper-and-cloth skin (never its commercial chrome: no prices, badges, charts, promo tiles, sidebar, or glossy covers).

### Structure
- **Header:** "Back", title "The library", and a quiet count ("77,000 free books").
- **Search:** "Search by title or author", present but **secondary** to the curated shelves (most first readers want to be handed something). Search reaches the full ~77,386-title index.
- **Curated doorways as labeled shelves** (not filter pills — see decision below): each shelf is a serif label + a quiet italic descriptor, then an even row of covers. Ship a few hand-picked doorways, e.g. **Short classics** ("great first books, none of them long"), **Familiar names** ("the ones you've meant to get to"), **A little philosophy**, **Finish in a weekend**.
- **Cells:** covers are the hero, in clean symmetrical rows (4 across at desktop width), consistent size, aligned baselines, with **title and author centered below the cover** — never in a skinny side column.

### ⚠ Data reality — two cell types (build around what the index actually has)
The on-device catalogue (`discover_catalogue.tsv`, 77,386 books) has exactly: **id, title, author, language, popularity**. There are **no descriptions / summaries / blurbs and no cover art** in the data. Therefore:

- **Curated shelf cell** = cover + title + author + **one hand-written editorial blurb**. The blurbs are *authored content*, written by hand for the small doorway sets only. Keep their exact voice — e.g. *"Begins as a traveller's diary and tightens, entry by entry, into dread."* (Dracula); *"A river journey upstream that keeps darkening, sentence by sentence."* (Heart of Darkness). Blurbs render as a centered caption under the title/author, clamped to 2 lines so the shelf stays even. Write blurbs as finished one-liners — never truncate mid-word.
- **Search / all-books cell** = cover + title + author **only**. Denser grid, **no blurb**. Never fabricate or imply a blurb for the 77k library or for search results — they don't exist. (The mock currently shows the curated-shelf cell; build the search/all cell as the same cover-forward cell minus the blurb caption.)

### The doorway-pills decision
The earlier filter-chip row was cut. **Let the labeled shelves themselves be the navigation** — the reader scrolls a few hand-picked doorways, each with its serif label + quiet descriptor (Apple Books' labeled rows, in Throughline's voice). No filled/outlined Material-style chips. If a jump-nav is ever wanted, it must be a restrained typographic treatment (quiet serif text tabs), reading like section labels in a bookshop, never chips.

### Language
Choosing a book is **"Start reading"** — never "Get" or a download glyph. It should feel like taking a book off a shelf, not downloading a file.

---

## 3 · Book chosen (transition)
Choosing a book must not feel like a download confirmation. The cover you picked **rises to center** and becomes the thing waiting on Today — the same cover object, carried forward. Copy: eyebrow "Added to Today"; headline "{Title} is yours to begin."; line "It's waiting on Today now. One last thing before you start: how do you like to read?" This flows straight into the pace step.

---

## 4 · Your reading pace (the only added question)

One calm choice, asked **once**, at the moment it's useful (starting the first book). It is **not** a funnel, goal, streak, or timer.

- Eyebrow "How you like to read"; question **"What feels like a good sitting?"**; sub **"This just sizes each day's reading. There's no timer, and you can change it anytime."**
- Three options, **framed in reading terms, never minutes** (this is the key reconciliation with Today's promise "no clock but your own"):
  - **A few pages** — "a small, easy daily portion"
  - **A chapter** — "a satisfying single sitting" *(default — pre-selected)*
  - **A long read** — "settle in for a good while"
- Actions: **Start reading** (primary) + a quiet skip **"I'll decide as I go."**
- The three map internally to the brief's 10 / 25 / 60-minute pacing but **that mapping is never shown** — the reader sees only pages/chapter/sitting. The pace quietly sizes the daily portion behind the scenes.

### No-clock reconciliation (do not violate)
Pace sizes the portion server-side/behind the scenes; the reader **never** sees a countdown or timer anywhere. Today continues to say "no clock but your own."

### Persistence
Pace **also lives in Settings** and is changeable anytime. A returning reader who already set it **skips this step** and lands straight on Today. Sensible default is "A chapter," and the step is always skippable.

---

## 5 · Today (locked)
The journey lands here: the chosen book waiting, sized to the pace, same warmth it began with. The daily portion reads qualitatively — "The first chapter, at the pace you set. No clock but your own." — never a count or a clock. Do not redesign.

---

## Connective tissue (the through-line)
- **The cover is the thread** — one book object followed front door → browse spine → chosen → Today.
- **Pace is reading terms, never minutes**, and never a timer.
- **One question, never a funnel** — asked once, default + skip, and it lives in Settings.
- **Clear of every Matter anti-pattern** — no streaks/goals/percentages/quizzes/account/paywall anywhere in the path.

## Exact copy
All final copy is in the mock's copy tables (Browse, and Chosen → Pace → Today) at the bottom of `reference/First Journey.html`. Use those words verbatim. Front-door + activation copy is in `reference/First-Run Screen.html`.

## Accessibility
- Light + warm-dark both first-class and AA (tokens pre-checked; the dark headline must use the ink token, not inherit — a real bug we fixed).
- Pace options are a `radiogroup` (arrow-key nav, visible focus, selection not by color alone — accent border + ring + check).
- Covers/books are real buttons with accessible names (title + author). Search is a labeled input. Honor `prefers-reduced-motion` (the only motion is a subtle cover lift on hover).
- No horizontal scroll at any width; the shelf grid children must be allowed to shrink (`min-width:0`) so rows reflow instead of overflowing.

## Acceptance criteria
- The five screens feel like one continuous bookshop; the same cover object is followed throughout.
- Browse is cover-forward and symmetrical (even rows, title/author below the cover); **curated shelves carry hand-written blurbs, search/all-books shows cover+title+author only, no fabricated blurbs anywhere.**
- No filter chips; labeled serif shelves are the navigation. "Start reading," never "Get."
- Search reaches the full ~77k index but sits secondary to the doorways.
- The pace step is one calm question in reading terms, default "A chapter," skippable, mirrored in Settings, and never renders a timer/countdown; Today still says "no clock but your own."
- Light + warm dark correct on every screen; no horizontal overflow; clear of all Matter anti-patterns.

## Files in this bundle (`reference/`)
- `First Journey.html` — all five screens, light + dark, with the screen-to-screen handoffs and the full copy tables. Source of truth for the journey.
- `First-Run Screen.html` — the locked front door in fuller detail, plus the complete activation-state set (resting → entering → success → wrong / expired / already-used with the recovery mailto).

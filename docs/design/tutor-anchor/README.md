# Handoff: Throughline — the tutor answer, anchored to the selection (CORE-1158)

## Overview

Throughline is a calm macOS reader (Tauri/React). Core promise: "a tutor in the margin… select a passage and it's explained right there. No losing your place." The reading view is a single vertically-scrolling text column with a right-hand margin/side area. Selecting text pops a small action toolbar at the selection (Highlight / Note / Question / Explain / Context / Define). The tutor answer streams in (a brief tier + an optional "go deeper" tier). The existing `MarginTutorCard` already carries the brand look (a quiet "Tutor · Explain" card). **This pass is its PLACEMENT and states, not a new look.**

**The bug being fixed:** the answer currently renders at the TOP of the margin column, disconnected from a mid-page selection, so the reader scrolls up to find it.

## The settled interaction pattern (build to this, do not relitigate)
- Anchor the answer card in the MARGIN, vertically aligned to the selected line (the Google Docs comment pattern), NOT at the column top.
- The reader's place is sacrosanct: the card comes to the reader; the reading column never moves; no scroll on reveal if the selection is visible; no jump while the answer streams.
- One active answer at a time; the selected passage stays highlighted while its card is active.

## Brand & constraints
Build on the existing tutor-card aesthetic + tokens: paper `#F4F1EA` / warm-dark `#1C1914`, surface `#FBFAF6`/`#242018`, card `#FFFFFF`/`#2A251D`, forest primary `#2E4A37`, accent `#3E7A4E` (sage `#A7C5B1` in dark), ink `#1A1A18`/`#ECE7DC`, muted `#6B6B66`, hairline borders `#E5E1D8`/`#383329`. Highlight tint `rgba(62,122,78,.20)`, active highlight `rgba(62,122,78,.32)` + a 1px ring. Source Serif 4 for the reading text and the italic quote; Inter for UI. Calm: a margin note, never a chatbot bubble or a modal that occludes the passage. **No em dashes** anywhere.

## About the file
`reference/Tutor Anchoring.html` is the annotated source of truth: all 8 states in light + dark, the resolved open decisions in a strip at the top, and a build-notes block at the end. Re-implement by repositioning the existing `MarginTutorCard`; the window chrome and reading text in the mock are context.

## Resolved open decisions (were the point of this pass)
- **Active vs kept:** active = full anchored card with a hairline **leader line** to its highlight. Kept = a compact margin **marker** (a small lens dot + lens label + snippet), tinted to its highlight, aligned to its own line.
- **Off-screen kept answers:** gather into a small stacked **"bucket"** pill at the margin's top/bottom edge with a count ("2 more below" / "1 above"); click to jump.
- **Define:** a **small inline popover at the selection**, not a margin card. Lighter, distinct, dismisses on next click. Explain/Context still open the full margin card.
- **The highlight↔card tie:** matched highlight tint **plus a thin leader line**, on the **active card only**. Calm, not a hard connector; never color-alone (active highlight also carries a ring).

## The 8 states (each light + dark in the reference)
1. **Mid-page Explain (hero):** card anchored beside the selected line, passage highlighted, column unmoved. Shown next to the current broken top-anchored behavior so the fix reads instantly.
2. **Short vs long:** short answer is only as tall as its content, no chrome; long answer caps at a max-height card with quiet internal scroll (a bottom fade), never taller than the viewport, never shoving the column.
3. **Go deeper:** brief tier by default with a quiet "Go deeper" disclosure; expanding adds the deeper tier **within the same card** under a "Deeper" divider; the card grows from its anchored top, switching to internal scroll rather than drifting off its line.
4. **Streaming:** the card reserves its anchored position before the first token, then grows downward in place with a blinking caret; nothing jumps.
5. **Collision (2+ on screen):** ONE active full card; others collapse to compact markers so cards never overlap; off-screen kept answers gather into the edge bucket.
6. **Active vs kept pile:** with nothing active, kept answers rest as quiet markers beside their highlights (tint still visible); the margin reads as a column of small bookmarks, never a wall of cards. Click a highlight/marker/bucket to re-surface the card in place.
7. **Define:** the light inline popover at the word (with the lens toolbar shown for context).
8. **Responsive (one component, two renders):** wide = the margin card; narrow (margin can't hold a readable card) = an **inline expansion directly below the selected paragraph** — content above stays unmoved, only content below flows down. Truly tiny → a bottom sheet only if needed.

## Behavior notes for the build (the load-bearing part)
- **Reveal:** if the selected line is in view, the card appears with **no scroll**. Align the card's top to the selection's top, then nudge up only as far as needed to fit fully in the margin viewport (never enough to feel like a jump). If the selection is partly off-screen, pin the card to the nearest margin edge rather than forcing a scroll.
- **Stream:** reserve the anchored position before the first token; grow downward in place; no column reflow, no upward drift; past max-height switch to internal scroll. Reduced-motion: render the answer pre-resolved, no caret.
- **Collision/layout:** one active card; others are markers. Never stack two full cards; a marker never overlaps the active card (push markers to their line, clamp within the margin, overflow into the bucket).
- **Focus & a11y:** focus **stays in the reading text** on reveal (the card is reachable by keyboard, not focus-grabbed). The answer region is `aria-live="polite"`. Honor reduced-motion. The highlight↔card tie is conveyed by tint + leader, never color alone.

## Acceptance criteria
- A mid-page answer appears beside its line, not at the column top; the reading column does not move on reveal or during streaming.
- One active card at a time; multiple on-screen answers never overlap (active card + markers + edge bucket).
- Define renders as an inline popover; Explain/Context as the anchored margin card; go-deeper expands inside the same card.
- Narrow windows render the inline-below-paragraph treatment with content above unmoved.
- No em dashes; light + warm dark both correct; reduced-motion and keyboard/focus behavior per the notes.

## Files (`reference/`)
- `Tutor Anchoring.html` — all 8 states (light + dark), resolved-decisions strip, and build-notes block. Self-contained; open in a browser.

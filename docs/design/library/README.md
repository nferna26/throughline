# Handoff: Throughline — the library

## Overview

Throughline is a calm, local-first macOS reading app (Tauri v2 + React). This handoff covers the **library** surface(s) — where a reader sees the books they've started, honors the ones they've finished, and removes what they no longer want. The library MODEL is already settled (below); this is the UX: layout, states, flow, copy, in the Throughline design system.

The ethos is **finishing the book you mean to read, never collecting or hoarding.** A book enters the library only when the reader **starts** it (gets a reading plan, notes, per-book tutor history). The library must never feel like a backlog, a chore, or a collection to maintain. Local-first and private: everything on the user's Mac, no account, cloud, sync, or tracking; $20 once; open source.

## Voice & brand (binding)

Warm, quiet, literary, never hypey; sentence case; **no emoji, no exclamation hype**. No minutes/timers shown as numbers — reading is paced in human terms. Tokens (pull from the app's existing set, don't hardcode):

| | Light | Warm dark |
|---|---|---|
| paper | `#F4F1EA` | `#1C1914` |
| surface | `#FBFAF6` | `#242018` |
| card | `#FFFFFF` | `#2A251D` |
| ink | `#1A1A18` | `#ECE7DC` |
| muted | `#6B6B66` | `#9C968A` |
| faint | `#98937F` | `#7B7567` |
| border | `#E5E1D8` | `#383329` |
| primary / accent | forest `#2E4A37` / `#3E7A4E` | sage `#A7C5B1` |
| clay (destructive/edge) | `#B4663C` | `#C99A6A` |

Type: **Source Serif 4** (headlines, book titles), **Inter** (UI), mono (codes only). **Cover** = the generated cloth-bound treatment (woven texture, gilt frame, letterpress title+author from title+author), the continuity thread used across the app.

## ⚠ Anti-patterns (binding)
No read-later/collection mechanics, no funnels, no streaks/goals, no unread piles framed as obligation, no completion trophies or accumulation rewards, no tags/folders/collections/smart rules/ratings/want-to-read lists, no account/cloud/sync. The library is never a backlog.

## The settled model (design to this, don't relitigate)
1. **One unified library** of started books with a **quiet provenance marker** — not two visual classes. Two sources: **catalogue** (public-domain, re-downloadable, cloth cover) and **imported** (the reader's DRM-free .txt/.epub — Throughline keeps its OWN copy; the original file is never touched).
2. **Covers, embedded-first hybrid:** imported books show their **embedded cover + metadata as-is**; fall back to a cloth cover only when the import has none. Catalogue books always use the cloth cover. **Never overwrite a real cover for brand consistency.**
3. **Organization = the whole kit:** active/Today book first; in-progress vs finished; recents in the switcher; search once the shelf outgrows a screen. Nothing the user must maintain.
4. **Remove = one verb, "Remove from library":** deletes Throughline's copy + reading state (plan/notes/tutor history); **never** touches the original file; there is no "delete file." Calm, stakes-honest confirmation; brief undo for the reading state.
5. **Finished books honored without a trophy case.**
6. **Local-first honesty:** one user-visible data folder; catalogue books need no backup; any backup nudge is one-time, never recurring guilt.

## About the design file
`reference/Library.html` is the annotated source of truth (layout, states, copy), all light + dark. Re-implement as React components using the app's tokens and the existing Cover component, the segmented Today/Library/Notes control, the switcher, PlansView, and dialog primitives. Window chrome in the mock is context.

---

## 1 · The library surface

A single scrollable shelf inside the **Library** tab. Top to bottom:

- **Header:** "Your library" + a quiet count ("{n} books"). A **search field appears only once the shelf outgrows ~one screen (~16 books)**: "Find a book in your library" (searches titles + authors already in the library). Nothing else — no sort, no filter, no view toggle.
- **Featured active book** (the one on Today): a horizontal card — cover + eyebrow "Reading now" + serif title + author + a human progress line ("Chapter 2, about a third of the way through.") + a **Continue reading** primary button.
- **"Reading" shelf:** a label ("Reading" + count) over a cover grid. Each cell: cover, serif title, author, and a thin progress hairline. **Progress is a hairline bar + a human phrase — never a percent or page number.**
- **"Finished" shelf:** below Reading, same shelf wall. Finished covers carry a **small letterpress completion check** in the top-right corner. No trophy, no count celebrated, no streak.

**Three sizes (all in the mock):**
- *A few books:* 4-up grid, full title+author+progress under each cover.
- *~20 books:* covers shrink to a denser **6-up** grid; the title/author drop away (the cover carries identity); finished checks stay.
- *Needs search (50+):* the header search field appears; grid stays the same.

**Empty / return state:** a few faint stacked covers + "Your library is empty for now. The books you start will gather here." + a **Browse the library** button.

**Provenance on the shelf:** carried entirely by **cover reality** — imported-with-cover books show their real cover (which reads as "mine"); everything else wears cloth. **No badges on the shelf, no two visual classes.** The only provenance *words* live in the book's detail view (§4).

---

## 2 · The book switcher

The quick jump from the title-bar book button:
- **Recent** list (covers + title + current location like "Chapter 2"), the active book marked **"Now."**
- A jump/search field appears **only past ~8 recents**; below that the short list is enough.
- **"All books in your library"** row at the bottom → opens surface 1.
- **Right-click any row** → calm per-book context menu: Continue reading · Show in library · (divider) · **Remove from library** (clay). This is the convenience entry to Remove; its primary home is the book detail view.

---

## 3 · Remove from library

One verb, two confirmations (the loss genuinely differs by source). Modal dialog over a scrim:

- **Catalogue (light loss):** title "Remove {Title}?" · "It leaves your library. You can add it back from the catalogue anytime, free." · "Your reading plan and notes for it will be cleared."
- **Imported (names the real loss):** title "Remove {Title}?" · "Your reading progress, notes, and tutor history for it will be deleted." · "Your original file isn't affected, it stays wherever you keep it, and you can import it again."
- **Buttons:** "Keep it" (cancel, safe default, left/affirmative position, gets default focus) · "Remove" (clay fill).
- **Undo:** after removing, a brief toast — "{Title} removed from your library. · Undo" — restores the reading state for a short window. For catalogue books, keep the downloaded text during the window so undo is instant.
- **Never** use "this is your only copy" / scary language anywhere — it's never the only copy.

---

## 4 · Covers, dangling files, backup

**Cover treatment (embedded-first hybrid), three cases:**
1. **Imported with embedded cover** → show the real cover + metadata as-is, never overwritten. *The cover is the provenance.*
2. **Imported, no cover** → cloth fallback built from title+author.
3. **Catalogue** → always cloth.

Should the cloth fallback for an import differ from a catalogue cloth cover? **Only barely** — they share the treatment so the shelf stays unified. The one quiet difference is **words in the detail view**: imported reads "Imported · your file"; catalogue reads "From the catalogue."

**Moved-file edge (dangling):** because Throughline holds its own copy, a moved/deleted original **never breaks reading**. So in the book's detail view, a calm dismissible note: "Still here, still readable. Looks like the original file for this book moved. Throughline keeps its own copy, so your reading isn't affected. You can point it at the file again if you'd like." · **Locate the file** / **Leave it**. Never an error, never a shelf-wide alarm. Re-link just re-associates the original for future re-export.

**One-time data-folder moment:** shown **once**, the first time a reader imports their own file (catalogue-only readers never see it): "Everything lives in one folder. Your books and notes are kept here on this Mac. Catalogue books re-download anytime, so there's nothing you must back up. If you'd like a copy, this is the folder to save." + the path (e.g. `~/Library/Throughline`) · **Show in Finder** / **Got it**. Never recurs, no badge, no nag.

---

## Open questions — resolved (build to these)
- **Provenance signal:** the cover reality carries it; words only in detail view; no shelf badges, no two visual classes.
- **Finished books:** stay on the same shelf in a quiet "Finished" section, marked with a small letterpress check; completion honored, never rewarded into collecting.
- **Where Remove lives:** primarily the book detail view; also right-click in the switcher/shelf. Never standing delete buttons on the shelf.
- **When search appears:** only past ~16 books; a single field, no other change, no maintenance.

## Final copy
All strings are in the copy table at the bottom of `reference/Library.html` — use verbatim. Highlights: section labels **Reading / Finished**; featured eyebrow **Reading now**; search **Find a book in your library**; detail provenance **Imported · your file** / **From the catalogue**; remove verb **Remove from library**; the two confirmations and **Keep it / Remove**; undo **{Title} removed from your library. · Undo**; empty **Your library is empty for now. The books you start will gather here.**

## Accessibility
- Segmented Today/Library/Notes control and shelves keyboard-navigable; each book is a button labelled title + author + state ("Walden, Thoreau, finished").
- Remove dialog traps focus, "Keep it" takes default focus, Esc cancels; the undo toast is announced politely and its action is keyboard-reachable before it fades.
- Reduced-motion removes the cover hover-lift and toast slide.
- Completion is **never color-only** — the check glyph pairs with the "Finished" section and the detail-view label.
- Light + warm dark both AA (tokens pre-checked).

## Acceptance criteria
- One unified shelf; active book featured; Reading then Finished; provenance carried by cover reality with **no shelf badges**.
- Progress shown in human terms, never a percent/page count or a timer.
- Search appears only past ~one screen; no tags/folders/sort/filter anywhere.
- Remove uses the two source-specific confirmations, never touches the original file, offers undo, and "Keep it" is the safe default.
- Embedded covers shown as-is and never overwritten; cloth fallback only when no embedded cover.
- Moved-file note is calm and dismissible (reading never breaks); the data-folder moment is one-time only.
- Light + warm dark correct throughout; clear of every collection/backlog anti-pattern.

## Files (`reference/`)
- `Library.html` — the full annotated surface: library at 3 sizes, switcher + context menu, remove flow + 2 confirmations + undo, cover trio, moved-file edge, one-time backup moment, resolutions, and the complete copy table. Light + dark throughout.

# ReadingGym — UI overhaul brief (for Claude Design)

Paste this into claude.ai/design as the starting prompt, then refine on the canvas.

## What it is
ReadingGym — a **local-first macOS desktop reading app** (Tauri v2 + React 19 + TypeScript).
One serious reader, one book at a time. Loop: import a book → see today's section →
read → capture one note → export Markdown. It is a focused **desktop app window**, not a
responsive marketing site or analytics dashboard.

## Design intent (non-negotiable)
"A serious desk, not a productivity cockpit." Calm typography, generous margins, minimal
chrome. The app opens to **Today** with one clear next action.

## Hard non-goals — do NOT add
- No gamification: no XP, badges, levels, streaks-as-punishment, mascots, confetti,
  leaderboards, AI praise.
- No dashboard-first or library-first layout. Today is home.
- No charts/graphs as the entry point. Quiet, serious progress only (monthly %, days read,
  minutes, notes created, gentle recovery).

## Platform & accessibility constraints
- Desktop window (~900–1100pt wide typical). **Light + dark themes both required.**
- WCAG-AA floor: visible focus ring (`:focus-visible`), full keyboard nav, **color
  independence** (never color-only state — pair with a glyph/word), readable contrast,
  scalable fonts. Tabs are a real tablist; dialogs trap focus.
- The app is hand-rolled **CSS variables** (below). Prefer evolving these tokens over adding
  a CSS framework. If you propose Tailwind/shadcn, call it out — it's a dependency decision.

## Current tokens (evolve; don't discard wholesale)
- **Light:** bg `#f7f5ef`, panel `#fffefb`, ink `#1c1b18`, muted `#6b6660`, line `#e8e3d8`,
  accent `#2f4e3a` (deep green), accent-ink `#fffefb`, warn `#a04a00`, alert `#8a1d1d`, ok `#2f4e3a`
- **Dark:** bg `#14161a`, panel `#1a1d22`, ink `#e8e6e1`, muted `#8d8a82`, line `#2a2e34`,
  accent `#a7c5b1` (sage), accent-ink `#14161a`, warn `#d99a55`, alert `#d97a7a`, ok `#a7c5b1`
- **Type:** UI = system sans (-apple-system / SF Pro). Reading body = serif (Iowan Old Style /
  Georgia / Charter). Radius ~8–14px, soft 1px borders, near-flat (very subtle shadow).

## Screens to redesign (full inventory)
1. **Topbar** — brand "ReadingGym", settings (⚙), theme toggle (☾/☼).
2. **Today (home)** — a slim "book header" band: a book-switcher **chip** (📖 title ▾) left, a
   **Today / Notes** segmented tab right. Below, the **Today card**: kicker ("Today — day X of
   N"), book title, author, today's section label, a meta row (≈ minutes · % complete · pace
   state shown with a glyph + word), a dominant **Start Reading** button, a gentle streak line
   ("You read 4 of the last 7 days"), and a quiet "+ Import another book". When behind: a
   **Recovery card** with shame-free options.
3. **Notes tab** — read-only list (type badge, chapter, date, body, optional short-quote
   blockquote).
4. **Reader** — toolbar (back, font size, line width, theme) + a calm centered **serif**
   reading column. Note panel and AI panel are summoned, not default.
5. **Settings** — Export folder, Local storage path (read-only), AI posture ("Local-only mode:
   ON"), AI base URL/model, and an **AI request history** audit list (each row a
   "Preview · never left this Mac" or "Sent → host", plus a retention control).
6. **Welcome (no books)** — one calm card: title, one-line pitch, "Import a book (.txt/.epub)".

## Deliverable
A cohesive visual system (tokens + the key screens in **light and dark**) within the intent and
non-goals above. Then export the handoff bundle.

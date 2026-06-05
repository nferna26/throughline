# Overnight research notes

Auto-research for the overnight improvement loop. Web tools are **not connected**
in this environment, so research is limited to: the live repo (screens/tests/docs)
and the operator's own `PRODUCT_VISION.txt` research packet
(`local-only/research-packets/commercial-viability-2026-05-31/attachments/`).
Only actionable, in-scope findings are recorded.

## From PRODUCT_VISION.txt (operator's own design brief)

- **Trust is part of "magic."** AI help must clearly state its scope so the
  reader knows what informed an answer. The doc names four scope levels:
  *based on the selected passage* · *based on the book so far* · *based on
  external context* · *possibly uncertain*.
  → Actionable & in-scope: Throughline's tutor lenses are **selection-only** and
  the briefing is **section-only** (never "the book so far", never external).
  So the honest, accurate scope line is *"Answers are based only on the passage
  (or section) you choose — your library never leaves this Mac."* Surface this
  where AI lives (Settings → Assistance + the consent cards already imply it).
  Did NOT adopt the "book so far / external context" levels — we don't send
  those, so advertising them would be inaccurate.

- **The default emotional contract must not be "behind."** "Your plan starts
  when you begin reading." → Already satisfied: `plan_ready` state + calm copy
  ("Plan ready. You are not behind."); recovery panel is opt-in and shame-free.
  No change needed; verified, not redone.

- **Reader is the workspace; AI lives in the margin; notes are marginalia, not
  paperwork.** → Largely built (streaming margin tutor, anchored notes,
  Question/Takeaway tags). Remaining small gaps this run targets: selection
  toolbar keyboard escape (done, cycle 3) and resume continuity on Today
  (done, cycle 4).

- Much of the vision doc proposes large redesigns (generated study editions,
  re-pacing engines) that are **out of scope** for an overnight reliability/polish
  loop and partly conflict with AGENTS.md "smallest change" + "no scope
  expansion." Not adopted.

## From the live repo

- EPUB stale-text guard had no isolated test (jsdom can't run epub.js). →
  Extracted a pure `briefingTextReady` guard and unit-tested it; both readers now
  share it (cycle 2).
- Settings shows the export folder + app-data path but never states the
  data/trust contract in one glance. → Add a plain "what stays here / what's
  sent" summary (cycle 5).
- Selection toolbar had no Escape / keyboard-focus affordance (cycle 3).
- `resume_percent` exists on TodayCard but was unused by the UI (cycle 4).

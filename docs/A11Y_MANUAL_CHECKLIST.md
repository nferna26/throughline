# Manual accessibility checklist — packaged app (A11Y-010 / PRIV-A11Y-009)

Run against the **signed, packaged app** (not the browser harness — WKWebView's
accessibility tree and native focus behavior differ from Chromium). Repeat
before every public release; record the date, build, and result per line.

Setup: System Settings → Keyboard → turn ON **Full Keyboard Access**. VoiceOver
on/off per section (⌘F5). Use the Augustine *Confessions* golden-loop fixture.

## Full Keyboard Access (no mouse, VoiceOver off)

- [ ] Open a book from Today with the keyboard only (Tab to "Continue reading", Return).
- [ ] Focus the reading area, scroll with Space / arrows, and select a passage
      with the keyboard (hold Shift + arrows). The selection toolbar appears
      after the selection settles.
- [ ] Press Tab: focus lands on the toolbar's first action (Highlight).
      Arrow/Tab reaches every action: Highlight · Note · Question · Explain ·
      Context · Define.
- [ ] Activate **Highlight** with Return: a highlight is saved; focus is not lost.
- [ ] Select again; activate **Note**; type in the margin card; the debounced
      autosave shows no error; Escape/Tab leaves the card without losing text.
- [ ] Select again; activate **Question**: a Question card appears.
- [ ] Select again; activate **Explain**: a tutor draft card appears in the margin
      and is reachable with Tab.
- [ ] Select again; activate **Context**: same, with the Context lens.
- [ ] Select again; activate **Define**: the popover appears; Escape dismisses it
      and focus returns to the reading sheet.
- [ ] Press Escape with the toolbar open: toolbar dismisses, focus returns to the
      reading sheet (not to the window or nothing).
- [ ] Finish the sitting from the keyboard: toolbar "Finish", recap, type a
      takeaway, "Save & finish" — no step needs a pointer.

## First-cloud consent sheet (keyboard + VoiceOver)

- [ ] With a cloud provider configured and consent not yet given, activate
      Explain. The consent sheet opens; initial focus is on **Not now**.
- [ ] Tab / Shift+Tab cycle inside the sheet only (Not now → Send → the
      full-request disclosure → wraps).
- [ ] VoiceOver announces: the dialog title naming the destination host, the
      provider disclosure sentence, the "Sent along with it" fields (book,
      author, chapter), and the passage text — once, without requiring
      interaction.
- [ ] The passage shown is the FULL selection (scroll a long one), not a
      truncated preview; "Show the full request, word for word" expands the
      exact outbound prompt.
- [ ] Escape cancels: nothing is sent (Privacy pane's "What's left this Mac"
      count unchanged), and focus returns to the invoking control.
- [ ] Confirming sends exactly once and the answer streams.

## VoiceOver reading semantics (VO on, ⌘F5)

- [ ] In the reader, VO's rotor (Headings) lists the book title as level 1 and
      each chapter opening as level 2, in document order.
- [ ] VO announces the reading area with the book title and current section
      label (the article's accessible name).
- [ ] VO reading order goes: toolbar → reading text → margin cards; the
      collapsed margin rail is skipped entirely (inert).
- [ ] Select a passage with VO (VO+Return anchor + arrows or keyboard
      selection): the selection toolbar appears and its actions are announced
      with their names.
- [ ] Save a note; VO announces "Saving…"/saved state changes; a forced failure
      (read-only export folder) announces the error alert.

## Failure honesty under keyboard/VO

- [ ] With the export folder made read-only: save a note — VO announces the
      "Saved in Throughline…" export-attention toast; Try again works once the
      folder is writable.
- [ ] End a sitting with the database locked (or otherwise force a failure):
      the "couldn't be saved" sheet is announced, Try again retries, and "Exit
      without saving" is present ONLY in that failure sheet.

Result log:

| Date | Build | Tester | Sections passed | Notes |
|------|-------|--------|-----------------|-------|
|      |       |        |                 |       |

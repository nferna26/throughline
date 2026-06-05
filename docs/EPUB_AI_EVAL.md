# EPUB AI eval — selection action card + Deep Study briefing

A repeatable definition of "working" for the AI surfaces when reading an EPUB,
created after three blind fix attempts and resolved by a deliberate architecture
pivot. Builder-only document; nothing here ships to users.

## Outcome: pivot to EPUB→text at import (epub.js rendering removed)

The original goal — *selecting text in an EPUB shows the action menu, and Deep
Study pre-populates a briefing* — is now met **by construction**: EPUBs are
converted to clean text at import and read through the **same plain-text
`TextReader`** that already has working selection, marginalia, and Deep Study.
The epub.js iframe renderer (and its WKWebView selection bug) is gone.

### Why the iframe approach was abandoned (root cause, researched not guessed)

- epub.js 0.3.93 renders each section in an iframe sandboxed `allow-same-origin`
  **without `allow-scripts`**. **WebKit bug #218086** then swallows every event
  dispatched into that frame in WKWebView (Tauri's engine) — both epub.js's own
  `selected` pipeline and any parent-attached listeners.
  Ref: <https://bugs.webkit.org/show_bug.cgi?id=218086>
- A reads-only patch made the **briefing** work (parent-realm `body.innerText`
  reads aren't blocked) but the **selection card still failed**: a live build's
  HUD read `summon: no selection` with text visibly selected, i.e. cross-realm
  `window.getSelection()` returns empty in WKWebView. That path is unfixable
  without `allow-scripts`, which we will not enable on untrusted EPUBs while
  `tauri.conf.json` has `csp: null` (it would let an EPUB run scripts in-app).
- The PRD already called EPUB rendering "a trap." So we stopped rendering EPUBs.

### The architecture now

- **Import** (`src-tauri/src/import_epub.rs`): a hand-rolled, entity-decoding,
  never-erroring `extract_section` converts each spine item's XHTML to clean text
  (script/style skipped, images dropped, entities decoded, whitespace collapsed).
  Sections are concatenated into a single `source.txt`; per-section **byte**
  offsets become the locators (the slicer is byte-indexed — matching `import_txt`);
  heading/blockquote/emphasis ranges are captured per section as **UTF-16** offsets
  (the reader's unit) in a `structure.json` sidecar. `source.epub` stays the
  immutable SHA/integrity anchor; `source.txt` is a derived local cache. Neither
  is ever exported; `source_private: true` is unchanged.
- **Read**: `cmd_read_section_text` is unchanged (EPUBs now have a `source.txt`);
  `cmd_read_section_structure` returns a section's style ranges. `Reader.tsx`
  routes every book to `TextReader`.
- **Style without mutating text**: headings/blockquotes are applied as a CSS
  class on the `<p>` (never a heading tag — every paragraph stays a
  `p[data-offset]` so selection anchoring keeps working); bold/italic are composed
  with highlights by `segmentParagraph`. Because styling never changes the text,
  char-offset note anchoring stays exact.
- **Migration**: a one-time lazy backfill (`ensure_epub_text`) regenerates
  `source.txt` + locators for EPUBs imported before the pivot, on first open
  (preserving section ids, so completion + notes survive).

### Deleted

`EpubReader.tsx`, `epubReaderLogic.ts`, `epubSelection.ts` (+ their tests), the
diagnostic HUD, and the `epubjs` + `jszip` npm deps. Bundle JS dropped 650 kB →
276 kB (gzip 200 → 85 kB).

## Layer 1 — automated (CI, headless): `npm test` + `cargo test`

| Unit | Where | What it pins |
|---|---|---|
| `extract_section` | `import_epub.rs` (Rust) | paragraphs, entity decode, script/style skip, image drop, heading/emphasis ranges in UTF-16, b→strong/i→em, no leading/trailing blanks |
| code blocks | `import_epub.rs` (Rust) | `<pre>` preserved verbatim (indentation + newlines, one `pre` range); class-based code tables (`table.processedcode`) become single-spaced lines with the line-number gutter stripped and keywords NOT bolded |
| `splitParagraphs` pre-ranges | `TextReader.tsx` | code ranges emit as non-reflowed `pre` paragraphs at exact offsets; prose around them reflows; no-pre-range path identical to before |
| byte-offset round-trip | `import_epub.rs` (Rust) | multibyte sections slice back out **exactly** by byte offset (guards the char-vs-byte bug) |
| `segmentParagraph` / `blockRoleFor` | `paragraphStructure.ts` | overlapping highlight+emphasis flatten into ordered runs; highlight-only output unchanged; block role per paragraph |
| `splitParagraphs`, `briefingTextReady`, selection helpers | existing | offset alignment + stale-text guard, unchanged |

Backend: `cargo test` (115 lib + 2 integration). Frontend: `npm test` (98).

**Honesty clause:** Layer 1 covers the conversion + styling logic. It does NOT
prove the live reading experience. Layer 2 is the real acceptance.

## Layer 2 — manual (live build) acceptance

1. **Import a fresh EPUB.** It opens in `TextReader` as clean, paginated text —
   chapters from the spine, headings styled, bold/italic visible, no images, no
   iframe. _PASS if it reads like the .txt reader._
2. **Selection works.** Select a sentence → the selection toolbar appears (it
   always has, in the text reader) → Highlight / Note / a tutor lens all work and
   the highlight anchors to the right text. _PASS._
3. **Deep Study pre-populates.** In Deep Study with consent, opening a section
   streams/show the briefing above notes. _PASS._
4. **Notes re-open correctly.** A highlight saved in §1 re-appears anchored on the
   same words after navigating away and back. _PASS (offset anchoring intact)._
5. **Existing pre-pivot EPUB.** Open the book imported before this change → it
   converts on first open and reads normally (no error). _PASS (lazy backfill)._
6. **Privacy.** `source.epub` + `source.txt` never appear in exports; tutor stays
   local-only. _PASS._

## Known limitations (accepted for prove-the-loop)

- Images are dropped (figcaption text is kept). Diagram-heavy books lose content.
- Code blocks render as a monospace block; **indentation is only recovered when the
  EPUB actually encodes it** (true for `<pre>` books). Some publishers (e.g.
  Pragmatic's `table.processedcode`, as in *Release It!*) don't put code indentation
  in the source at all — those render single-spaced but flat (still far better than
  the prior double-spaced de-indented lines).
- Non-code data tables still linearize (each cell becomes a short paragraph).
- Legacy `cfi:`-anchored notes from the old EPUB reader no longer highlight on the
  page (their body/takeaway text is preserved); the `cfi:` parser is kept so they
  never crash. Pre-release tolerance.

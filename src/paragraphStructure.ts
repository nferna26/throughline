// Paragraph structure styling for EPUB-derived text (and any future structured
// source). The backend extractor emits `StyleRange`s in UTF-16 offsets relative
// to a section's text — the SAME unit the reader measures selections/highlights
// in — so styling never mutates the text and char-offset note anchoring stays
// exact. This module is the pure logic (no React) so it can be unit-tested.

/** One style range within a section's text, in UTF-16 offsets relative to that
 *  section. `kind` is a block role (`h1`..`h6`, `blockquote`) applied to a whole
 *  paragraph, or an inline span (`strong`, `em`). Mirrors the Rust `StyleRange`. */
export interface StyleRange {
  kind: string;
  start: number;
  end: number;
}

/** Block roles are applied at the paragraph level (a styled <p>, never a heading
 *  tag — the reader's selection anchoring requires every paragraph stay a
 *  `p[data-offset]`). Everything else is an inline span.
 *
 *  Two families share this mechanism:
 *    • LEGACY structural roles (h1..h6, blockquote, pre) — emitted by the EPUB
 *      importer; absent → plain prose, identical to the pre-structure reader.
 *    • BOOK-TYPOGRAPHY roles — the front-matter vocabulary the importers infer
 *      from public-domain plain text (title page, contents, epigraph, chapter
 *      openings, first-paragraph). All additive + backward-compatible: a section
 *      with none renders exactly as before.
 *
 *  Every kind here maps to a CSS class via `blockRoleClass`; the reader puts that
 *  class on the paragraph's `<p data-offset>` and NEVER changes its character
 *  count or offsets (ornaments like the small-caps opener are render-only slices). */
export const BLOCK_ROLES = [
  // legacy / EPUB structural
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  // book-typography front matter (additive)
  "title", "subtitle", "byline",
  "contents-label", "contents-part", "contents-item",
  "epigraph",
  "chapter-label", "chapter-title",
  "body-first",
] as const;

export function isBlockRole(kind: string): boolean {
  return (BLOCK_ROLES as readonly string[]).includes(kind);
}

/** The CSS class the reader applies to a `<p data-offset>` for a given block role.
 *  Returns null for an unknown kind (defensive: an unrecognized future kind falls
 *  back to plain prose rather than an undefined class). Kept here — beside the
 *  vocabulary it serves — so the backend's emitted kinds and the frontend's
 *  rendering map stay in one place. */
const BLOCK_ROLE_CLASS: Record<string, string> = {
  h1: "tl-h1", h2: "tl-h2", h3: "tl-h3", h4: "tl-h4", h5: "tl-h5", h6: "tl-h6",
  blockquote: "tl-blockquote",
  title: "tl-tp-title",
  subtitle: "tl-tp-subtitle",
  byline: "tl-tp-byline",
  "contents-label": "tl-toc-label",
  "contents-part": "tl-toc-part",
  "contents-item": "tl-toc-item",
  epigraph: "tl-epigraph",
  "chapter-label": "tl-ch-label",
  "chapter-title": "tl-ch-title",
  "body-first": "tl-body-first",
};

export function blockRoleClass(kind: string): string | null {
  return BLOCK_ROLE_CLASS[kind] ?? null;
}

/** Whether a block role is a single "contents-item" entry — the reader groups a
 *  run of consecutive contents-item paragraphs into a 2-column container that
 *  lives INSIDE the reading column (each child keeps its exact `p[data-offset]`). */
export function isContentsItem(kind: string | null): boolean {
  return kind === "contents-item";
}

/** The block role for a paragraph, if a block range covers it. Heading/blockquote
 *  ranges are emitted to span exactly their paragraph's text, so "covers" means
 *  the range contains the paragraph's [start, end). Returns the first match (by
 *  document order) or null. */
export function blockRoleFor(
  pOffset: number,
  pLen: number,
  ranges: ReadonlyArray<StyleRange>,
): string | null {
  const pEnd = pOffset + pLen;
  const hit = ranges.find((r) => isBlockRole(r.kind) && r.start <= pOffset && r.end >= pEnd);
  return hit ? hit.kind : null;
}

/** A contiguous run of paragraph text with the styles that apply to it.
 *  `opener` marks the small-caps opening phrase of a chapter's first paragraph
 *  (book convention; replaces the old drop cap). Like every other flag it is a
 *  pure SLICE of the text — it never changes the paragraph's character count,
 *  so char-offset note anchoring stays exact. */
export interface Segment {
  text: string;
  hlId: string | null;
  strong: boolean;
  em: boolean;
  opener: boolean;
}

/** The character length of the small-caps opener for a chapter's first paragraph:
 *  the first ~`words` whitespace-delimited words (book convention is a short
 *  opening phrase, ~3-4 words). Returns a length in UTF-16 code units, clamped to
 *  the paragraph; 0 when the text is too short/odd to carry one. Pure + exported
 *  so the slice is unit-tested (offset safety is load-bearing for marginalia). */
export function openerLength(text: string, words = 4): number {
  // Skip any leading whitespace, then walk `words` runs of non-space → space.
  let i = 0;
  const n = text.length;
  while (i < n && /\s/.test(text[i])) i++;
  let seen = 0;
  while (i < n && seen < words) {
    while (i < n && !/\s/.test(text[i])) i++; // consume a word
    seen++;
    if (seen >= words) break;
    while (i < n && /\s/.test(text[i])) i++; // consume the gap (kept inside the run)
  }
  // Don't small-cap an entire short paragraph — an opener is a phrase, not the
  // whole sentence. If the phrase would swallow (nearly) the whole text, drop it.
  if (i >= n) return 0;
  return i;
}

/**
 * Flatten overlapping highlight + inline-emphasis ranges into ordered,
 * non-overlapping segments covering the whole paragraph text. Offsets in/out are
 * the reader's section-relative UTF-16 units; this only ever slices the string by
 * those offsets (never rewrites it), so it composes with the existing highlight
 * anchoring without shifting anything.
 *
 * When no range touches the paragraph it returns a single plain segment — the
 * caller renders that as the bare string, identical to the pre-structure reader.
 */
export function segmentParagraph(
  text: string,
  pOffset: number,
  highlights: ReadonlyArray<{ id: string; start: number; end: number }>,
  inlineSpans: ReadonlyArray<StyleRange>,
  /** Length (UTF-16 units, paragraph-relative) of a leading small-caps opener,
   *  or 0/undefined for none. A pure slice — never changes the char count. */
  openerLen = 0,
): Segment[] {
  const len = text.length;
  if (len === 0) return [];
  // Clip every interval to the paragraph, in paragraph-relative coords.
  interface Iv { kind: "hl" | "strong" | "em" | "opener"; id: string | null; s: number; e: number }
  const ivs: Iv[] = [];
  for (const h of highlights) {
    if (h.end > pOffset && h.start < pOffset + len) {
      ivs.push({ kind: "hl", id: h.id, s: Math.max(0, h.start - pOffset), e: Math.min(len, h.end - pOffset) });
    }
  }
  for (const r of inlineSpans) {
    if ((r.kind === "strong" || r.kind === "em") && r.end > pOffset && r.start < pOffset + len) {
      ivs.push({ kind: r.kind, id: null, s: Math.max(0, r.start - pOffset), e: Math.min(len, r.end - pOffset) });
    }
  }
  // The opener is a paragraph-relative leading slice [0, openerLen).
  if (openerLen > 0) ivs.push({ kind: "opener", id: null, s: 0, e: Math.min(len, openerLen) });
  const clipped = ivs.filter((v) => v.e > v.s);
  if (clipped.length === 0) return [{ text, hlId: null, strong: false, em: false, opener: false }];

  // Segment at every interval boundary.
  const bounds = new Set<number>([0, len]);
  for (const v of clipped) { bounds.add(v.s); bounds.add(v.e); }
  const points = [...bounds].sort((a, b) => a - b);

  const out: Segment[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k];
    const b = points[k + 1];
    if (b <= a) continue;
    const covers = (v: Iv) => v.s <= a && v.e >= b;
    const hl = clipped.find((v) => v.kind === "hl" && covers(v));
    out.push({
      text: text.slice(a, b),
      hlId: hl ? hl.id : null,
      strong: clipped.some((v) => v.kind === "strong" && covers(v)),
      em: clipped.some((v) => v.kind === "em" && covers(v)),
      opener: clipped.some((v) => v.kind === "opener" && covers(v)),
    });
  }
  return out;
}

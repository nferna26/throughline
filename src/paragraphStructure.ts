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
 *  `p[data-offset]`). Everything else is an inline span. */
export const BLOCK_ROLES = ["h1", "h2", "h3", "h4", "h5", "h6", "blockquote"] as const;

export function isBlockRole(kind: string): boolean {
  return (BLOCK_ROLES as readonly string[]).includes(kind);
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

/** A contiguous run of paragraph text with the styles that apply to it. */
export interface Segment {
  text: string;
  hlId: string | null;
  strong: boolean;
  em: boolean;
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
): Segment[] {
  const len = text.length;
  if (len === 0) return [];
  // Clip every interval to the paragraph, in paragraph-relative coords.
  interface Iv { kind: "hl" | "strong" | "em"; id: string | null; s: number; e: number }
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
  const clipped = ivs.filter((v) => v.e > v.s);
  if (clipped.length === 0) return [{ text, hlId: null, strong: false, em: false }];

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
    });
  }
  return out;
}

// Anchoring math for the margin tutor card (CORE-1158). Pure + testable, kept
// out of the DOM-heavy reader so the placement rules can be verified without a
// browser.
//
// The card lives in a positioned margin track that scrolls WITH the text column
// (they are siblings in the one scroll container), so a card placed at the
// selection's offset stays beside its line by construction and the text column
// never reflows. These helpers decide the card's `top` within that track and
// keep the reader's place.

export interface AnchorInput {
  /** Selection's top, in margin-track coordinates (px from the track's top). */
  selectionTop: number;
  /** Top of the visible margin viewport, in track coordinates. */
  viewportTop: number;
  /** Minimum gap to keep from the rail's top edge. */
  gap?: number;
}

/**
 * The card's `top` within the margin rail: aligned to the selection line, clamped
 * only so it never renders above the rail's top gap.
 *
 * CORE-1163: ONE growth model. The card grows DOWNWARD in normal flow and the
 * RAIL scrolls for a pathologically tall card, so there is no cap-to-viewport nudge:
 * the top stays pinned to the selection line and the anchor + first words never move
 * while the answer streams.
 */
export function anchorCardTop(i: AnchorInput): number {
  const gap = i.gap ?? 8;
  return Math.max(i.viewportTop + gap, i.selectionTop);
}

export interface ScrollGuard {
  /** Restore the recorded scrollTop (call after any layout-affecting mutation). */
  restore(): void;
}

/**
 * Record a scroll container's scrollTop and return a restorer. WKWebView (the
 * Tauri macOS webview) has no `overflow-anchor`, so we keep the reader's place by
 * snapshotting scrollTop before any DOM mutation that could affect layout and
 * restoring it after. (The card lives in the margin, out of the column's reflow
 * path, so in practice scrollTop should not move; this is the belt to that
 * suspenders.) Pure-ish: it touches only the passed element, so it is trivially
 * unit-testable with a `{ scrollTop }` stub.
 */
export function guardScroll(el: { scrollTop: number } | null | undefined): ScrollGuard {
  const recorded = el ? el.scrollTop : 0;
  return {
    restore() {
      if (el && el.scrollTop !== recorded) el.scrollTop = recorded;
    },
  };
}

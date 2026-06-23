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
  /** Is the selected line currently within the visible margin viewport? */
  selectionInView: boolean;
  /** Measured (or estimated) card height in px. */
  cardHeight: number;
  /** Top of the visible margin viewport, in track coordinates. */
  viewportTop: number;
  /** Height of the visible margin viewport in px. */
  viewportHeight: number;
  /** Minimum gap to keep from the viewport edges. */
  gap?: number;
}

/**
 * The card's `top` within the margin track.
 *
 * In view: align the card top to the selection top, then nudge UP only as far as
 * needed to fit fully in the margin viewport (never enough to feel like a jump),
 * and never above the viewport top.
 *
 * Off-screen: pin to the nearest viewport edge rather than forcing a scroll.
 */
export function anchorCardTop(i: AnchorInput): number {
  const gap = i.gap ?? 8;
  const vTop = i.viewportTop + gap;
  const vBottom = i.viewportTop + i.viewportHeight - gap;

  if (!i.selectionInView) {
    // Pin to the nearest edge: top edge if the selection is above the viewport,
    // bottom edge if below.
    if (i.selectionTop < i.viewportTop) return vTop;
    return Math.max(vTop, vBottom - i.cardHeight);
  }

  let top = i.selectionTop;
  // Nudge up only as far as needed to keep the whole card in view.
  const overflowBottom = top + i.cardHeight - vBottom;
  if (overflowBottom > 0) top -= overflowBottom;
  // But never push above the viewport top.
  if (top < vTop) top = vTop;
  return top;
}

/**
 * Does the card need an internal scroll? Only when its full height would exceed
 * the available margin viewport (minus gaps). Past this, the card caps at
 * max-height and scrolls inside rather than drifting off its line.
 */
export function cardNeedsInternalScroll(cardHeight: number, viewportHeight: number, gap = 8): boolean {
  return cardHeight > viewportHeight - gap * 2;
}

/** The card's capped max-height when it would otherwise pass the viewport. */
export function cardMaxHeight(viewportHeight: number, gap = 8): number {
  return Math.max(0, viewportHeight - gap * 2);
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

// Section completion by scroll — the pure predicate behind TextReader's
// reachedEnd set (FT-09).
//
// A section counts as read-to-the-end when the VISIBLE BOTTOM of the scroll
// viewport reaches the end of the section's text, within a small slack. The
// previous rule asked whether the paragraph at the TOP of the viewport had
// entered the last 5% of the section — at maximum scroll the top sits a whole
// viewport above the end, so only sections ~20 screens long could ever finish,
// and a section that fit one screen never fired a scroll event at all.

/** Geometry of a scroll container, as read off the DOM element. */
export interface ScrollGeometry {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** How close (px) the viewport bottom must get to the text's end to count.
 *  Absorbs sub-pixel scroll positions and bottom padding. */
export const END_SLACK_PX = 32;

/** True when the reader's viewport has reached the end of the scrollable text.
 *  A section short enough to fit without scrolling (scrollHeight ≤ clientHeight)
 *  qualifies immediately — callers measure it once after the text paints, since
 *  it will never produce a scroll event. */
export function endReached(g: ScrollGeometry): boolean {
  if (!Number.isFinite(g.scrollTop) || !Number.isFinite(g.clientHeight) || !Number.isFinite(g.scrollHeight)) {
    return false;
  }
  return g.scrollTop + g.clientHeight >= g.scrollHeight - END_SLACK_PX;
}

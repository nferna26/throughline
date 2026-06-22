/**
 * Split a free-form EPUB title into a display-time main/subtitle pair.
 *
 * DISPLAY ONLY — never a data migration, never re-import. EPUB `dc:title` is one
 * unbounded, free-form field, so titles arrive messy and long
 * (e.g. "Crossing the Chasm, 3rd Edition: Marketing and Selling Disruptive
 * Products to Mainstream Customers (Collins Business Essentials)"). For the
 * large-title surfaces (the Today hero, the first-journey "chosen" screen) we
 * show the `main` part big and the `subtitle` smaller — but the FULL stored
 * title is always preserved verbatim for tooltips and screen readers.
 *
 * Rule: split on the first colon that is FOLLOWED BY WHITESPACE — the typographic
 * shape of a real "Main: Subtitle". NEVER split on commas or parentheses: those
 * carry edition or series information that belongs with the main title ("Crossing
 * the Chasm, 3rd Edition") or trails into the subtitle/series slot. Requiring the
 * space deliberately leaves clock times ("11:00"), ratios ("16:9"), scores, and
 * chapter:verse references ("Psalm 23:1") whole — those have no space after the
 * colon. A title with no such boundary (or nothing meaningful on one side of it)
 * is returned whole as `main` with an empty `subtitle`.
 */
export interface DisplayTitle {
  /** The big-title part (before the subtitle boundary), or the whole title. */
  main: string;
  /** The smaller part after the boundary colon, or "" when there is no split. */
  subtitle: string;
}

export function splitDisplayTitle(fullTitle: string): DisplayTitle {
  const full = (fullTitle ?? "").trim();
  // The boundary is the FIRST colon followed by whitespace. This skips
  // "16:9" / "11:00" / "Psalm 23:1" (no space after the colon) yet still finds
  // the real subtitle colon in e.g. "3:10 to Yuma: A Western".
  const boundary = full.search(/:\s/);
  if (boundary < 0) return { main: full, subtitle: "" };
  const main = full.slice(0, boundary).trim();
  const subtitle = full.slice(boundary + 1).trim();
  // Nothing meaningful on one side → not a real boundary; keep the whole string.
  if (!main || !subtitle) return { main: full, subtitle: "" };
  return { main, subtitle };
}

import type { TodayCard } from "./types";

/**
 * Library progress, in human terms — never a percent, a page, or a timer.
 *
 * The backend hands the library a qualitative position (`fraction`, 0..1) and a
 * location label ("Chapter II"). The shelf draws the fraction as a hairline
 * LENGTH; this module turns it into the calm words the featured card and the
 * accessible labels speak. The brand rule (CLAUDE.md / handoff): reading is
 * paced in human terms, so nothing here ever emits a number.
 */

/** A coarse, calm phrase for how far along a book is. Buckets, not arithmetic —
 *  the reader feels "about a third of the way through", never "34%". */
export function fractionPhrase(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  if (f < 0.05) return "just getting started";
  if (f < 0.2) return "near the beginning";
  if (f < 0.45) return "about a third of the way through";
  if (f < 0.62) return "about halfway through";
  if (f < 0.8) return "about two-thirds of the way through";
  if (f < 0.97) return "nearly at the end";
  return "at the very end";
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The featured (active/Today) book's one-line human progress, e.g.
 * "Chapter 2, about a third of the way through." Built from the real TodayCard
 * so it matches the Today screen exactly. Handles the calm edge states (day one,
 * finished, plan-less) in voice, never as an error or a number.
 */
export function featuredProgressLine(card: TodayCard): string {
  const label = card.chapter_label?.trim();
  switch (card.state) {
    case "finished":
      return "You’ve read it to the end.";
    case "no_plan":
      return "Ready when you are.";
    case "day_one":
      return label ? `Ready to begin — ${label}.` : "Ready to begin.";
    default: {
      // reading / returning
      const where = fractionPhrase(card.fraction_complete);
      return label ? `${label}, ${where}.` : `${capitalize(where)}.`;
    }
  }
}

/** The state word an accessible book label ends with ("…, finished" / "…,
 *  reading") so completion (and progress) is conveyed to assistive tech in
 *  words, never by colour alone. */
export function bookStateWord(finished: boolean): string {
  return finished ? "finished" : "reading";
}

/** The full accessible name for a book button on the shelf or in the switcher:
 *  title, author (when present), and state — "Walden, Henry D. Thoreau,
 *  finished" (the handoff's a11y contract). */
export function bookAriaLabel(
  title: string,
  author: string | null | undefined,
  finished: boolean,
): string {
  const parts = [title];
  if (author && author.trim()) parts.push(author.trim());
  parts.push(bookStateWord(finished));
  return parts.join(", ");
}

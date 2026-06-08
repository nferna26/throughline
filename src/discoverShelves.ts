/* ════════════════════════════════════════════════════════════════════
   Throughline — Discover shelves (editorial curation)
   ────────────────────────────────────────────────────────────────────
   Discover opens to a small set of hand-authored SHELVES, not a ranked
   "most downloaded" table. Each shelf is a short reading invitation; each
   book carries a one-line editorial REASON (why a person might stay with
   it), never metadata.

   Option A: the curation lives here as a frontend map keyed by the
   public-domain library's stable book id. It is JOINED at render time
   against the catalogue rows (the bundled seed / live search), so this
   file holds judgement only — no titles, authors, downloads, or URLs to
   drift out of sync. discover_seed.json is left untouched.

   Every id below was checked to exist in resources/discover_seed.json.
   An id that ever falls out of the catalogue simply drops from its shelf
   (resolveShelves filters unresolved ids); the test guards against that.
   ════════════════════════════════════════════════════════════════════ */

import type { DiscoverBook } from "./types";

/** One curated pick: a catalogue id plus the single line that earns its place. */
export interface ShelfPick {
  /** Public-domain library book id — joined against catalogue rows at render. */
  id: number;
  /** One literary line: why a reader might stay with this, not what it is. */
  reason: string;
}

/** An editorial shelf — a titled invitation and its handful of picks. */
export interface Shelf {
  /** Stable key, used for React keys and tests. */
  key: string;
  /** Shelf heading. Calm, not a sales pitch. */
  title: string;
  /** One line on what kind of reading this shelf gathers. */
  description: string;
  picks: ShelfPick[];
}

/** A shelf whose picks have been joined against live catalogue rows. Picks that
 *  did not resolve to a catalogue book are dropped. */
export interface ResolvedShelf {
  key: string;
  title: string;
  description: string;
  items: Array<{ book: DiscoverBook; reason: string }>;
}

/* The shelves, in display order. Hand-authored; deliberately few. */
export const SHELVES: Shelf[] = [
  {
    key: "short-classic",
    title: "Start with a short classic",
    description: "Whole works you can finish in a sitting or two — proof the habit takes.",
    picks: [
      { id: 1952, reason: "A single unravelling told from inside it; impossible to put down once begun." },
      { id: 5200, reason: "Wakes you on the first page already changed — strangeness handled as plain fact." },
      { id: 43, reason: "The doubled self as a tight, propulsive case; short enough to read in one breath." },
      { id: 844, reason: "Wit so quick the pages turn themselves — a comedy that never drags." },
      { id: 209, reason: "A ghost story that withholds, so the unease is yours to finish." },
    ],
  },
  {
    key: "philosophical",
    title: "Something philosophical",
    description: "Books that ask how to live, and reward slow, returning reading.",
    picks: [
      { id: 2680, reason: "Notes a man wrote to steady himself; reads like counsel meant for you." },
      { id: 3296, reason: "A restless mind talking itself toward stillness — confession as inquiry." },
      { id: 1232, reason: "Cold, exact, and still argued about; power described without flattery." },
      { id: 205, reason: "An argument for paying attention, made by someone who left to try it." },
      { id: 4363, reason: "Provocations meant to dislodge you — best read a few aphorisms at a time." },
    ],
  },
  {
    key: "short-first-sitting",
    title: "Short first sitting",
    description: "Low-commitment openings — easy to begin tonight, easy to keep.",
    picks: [
      { id: 11, reason: "Falls straight into the rabbit hole; no throat-clearing before the wonder." },
      { id: 55, reason: "A clear, kind road from the very first page — momentum without effort." },
      { id: 174, reason: "A bargain struck early, and you'll want to see what it costs." },
      { id: 1342, reason: "One of the most disarming opening lines in English; you're in before you decide." },
      { id: 345, reason: "Begins as a traveller's diary and tightens, entry by entry, into dread." },
    ],
  },
  {
    key: "familiar-doorways",
    title: "Familiar doorways",
    description: "Books you half-know already — the easiest way back into reading.",
    picks: [
      { id: 1342, reason: "You know the shape; the sentences are the reward you've been missing." },
      { id: 84, reason: "Not the monster you were sold — a sadder, stranger book underneath." },
      { id: 1260, reason: "A first-person voice that still feels modern and close." },
      { id: 345, reason: "The letters-and-journals form makes the famous story newly immediate." },
      { id: 1727, reason: "The oldest road trip there is, in prose plain enough to follow easily." },
    ],
  },
];

/**
 * Join the curated shelves against a catalogue index (id → DiscoverBook).
 * Picks whose id is absent from the index are dropped — so a shelf only ever
 * shows books a reader can actually get. Shelves left empty are omitted.
 */
export function resolveShelves(
  index: Map<number, DiscoverBook>,
  shelves: Shelf[] = SHELVES,
): ResolvedShelf[] {
  return shelves
    .map((shelf) => ({
      key: shelf.key,
      title: shelf.title,
      description: shelf.description,
      items: shelf.picks
        .map((pick) => {
          const book = index.get(pick.id);
          return book ? { book, reason: pick.reason } : null;
        })
        .filter((x): x is { book: DiscoverBook; reason: string } => x != null),
    }))
    .filter((shelf) => shelf.items.length > 0);
}

/** Build an id → book index from any list of catalogue rows. Later rows win, so
 *  pass live results over the seed when both are available. */
export function indexBooks(books: DiscoverBook[]): Map<number, DiscoverBook> {
  const index = new Map<number, DiscoverBook>();
  for (const b of books) index.set(b.id, b);
  return index;
}

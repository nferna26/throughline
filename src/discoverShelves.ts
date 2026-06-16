/* ════════════════════════════════════════════════════════════════════
   Throughline — Discover doorways (editorial curation)
   ────────────────────────────────────────────────────────────────────
   The library opens to a few hand-picked SHELVES, not a ranked "most
   downloaded" table. Each shelf is a calm serif label + a quiet descriptor;
   each book carries a hand-written editorial BLURB (what it's like to read,
   never metadata). This is AUTHORED content for the doorway sets only — the
   77k-book catalogue itself has no blurbs, so search and all-books views show
   cover + title + author only (never an invented blurb).

   What this file holds is judgement: the doorway ids, their display title and
   author (a cleaned, reader-facing form of the catalogue's raw strings), and the
   one authored line that earns each book its place. The id is JOINED at render
   time against live catalogue rows (cmd_discover_books_by_ids) so the import
   URLs/formats are never duplicated here and can never drift out of sync.

   Every id below was verified to exist in resources/discover_catalogue.tsv with
   the title/author shown (the test guards that, and that no blurb is fabricated
   for a book the copy tables don't cover). An id that ever falls out of the
   catalogue simply drops from its shelf (resolveShelves filters unresolved ids).
   ════════════════════════════════════════════════════════════════════ */

import type { DiscoverBook } from "./types";

/** One curated pick: a catalogue id, the reader-facing title/author shown on the
 *  cover + cell, and the single authored line beneath it. */
export interface ShelfPick {
  /** Public-domain catalogue id — joined against catalogue rows for import URLs. */
  id: number;
  /** Reader-facing title on the cover + cell (a cleaned form of the catalogue's). */
  title: string;
  /** Reader-facing author on the cover + cell. */
  author: string;
  /** One authored editorial line — why a reader might stay with this, not what it
   *  is. Curated doorways only; never shown for search / all-books results. */
  blurb: string;
}

/** An editorial doorway — a serif label + quiet descriptor and its few picks. */
export interface Shelf {
  /** Stable key, used for React keys and tests. */
  key: string;
  /** Shelf label (serif heading). */
  title: string;
  /** Quiet italic descriptor — what kind of reading this doorway gathers. */
  description: string;
  picks: ShelfPick[];
}

/** A shelf whose picks have been joined against live catalogue rows. Picks that
 *  did not resolve to a catalogue book are dropped. The display title/author/blurb
 *  stay authored; `book` carries the catalogue row (id + import URLs). */
export interface ResolvedShelfItem {
  book: DiscoverBook;
  title: string;
  author: string;
  blurb: string;
}
export interface ResolvedShelf {
  key: string;
  title: string;
  description: string;
  items: ResolvedShelfItem[];
}

/** The three rotating front-door starter covers — the primary invitation on the
 *  first-run screen. Clicking a cover imports that book and begins the journey,
 *  so each must resolve against the catalogue exactly like a shelf pick. */
export const STARTERS: Array<{ id: number; title: string; author: string }> = [
  { id: 2680, title: "Meditations", author: "Marcus Aurelius" },
  { id: 205, title: "Walden", author: "Henry D. Thoreau" },
  { id: 1342, title: "Pride & Prejudice", author: "Jane Austen" },
];

/* The doorways, in display order. Hand-authored; deliberately few. Blurbs are
   verbatim from the design copy tables, except The Time Machine — a public-domain
   substitute for the brief's "The Old Man and the Sea" (which is not public
   domain and is absent from the catalogue), with a blurb drafted in the same
   voice and flagged for operator approval. */
export const SHELVES: Shelf[] = [
  {
    key: "short-classics",
    title: "Short classics",
    description: "great first books, none of them long",
    picks: [
      { id: 5200, title: "The Metamorphosis", author: "Franz Kafka",
        blurb: "A man wakes as an insect, and his family adjusts with alarming speed." },
      { id: 219, title: "Heart of Darkness", author: "Joseph Conrad",
        blurb: "A river journey upstream that keeps darkening, sentence by sentence." },
      { id: 4517, title: "Ethan Frome", author: "Edith Wharton",
        blurb: "A bleak New England winter, and a love with nowhere to go." },
    ],
  },
  {
    key: "familiar-names",
    title: "Familiar names",
    description: "the ones you've meant to get to",
    picks: [
      { id: 1342, title: "Pride & Prejudice", author: "Jane Austen",
        blurb: "Wit and pride misread each other across a country drawing room." },
      { id: 84, title: "Frankenstein", author: "Mary Shelley",
        blurb: "A young scientist makes a living man, then abandons what he made." },
      { id: 345, title: "Dracula", author: "Bram Stoker",
        blurb: "Begins as a traveller's diary and tightens, entry by entry, into dread." },
    ],
  },
  {
    key: "a-little-philosophy",
    title: "A little philosophy",
    description: "slow books, worth the patience",
    picks: [
      { id: 2680, title: "Meditations", author: "Marcus Aurelius",
        blurb: "A Roman emperor's private notes on how to live, written to himself." },
      { id: 205, title: "Walden", author: "Henry D. Thoreau",
        blurb: "Two years alone by a pond, and a case for living deliberately." },
      { id: 7849, title: "The Trial", author: "Franz Kafka",
        blurb: "A man is arrested for a crime no one will name, and the dread builds." },
    ],
  },
  {
    key: "finish-in-a-weekend",
    title: "Finish in a weekend",
    description: "short enough to start and end",
    picks: [
      { id: 46, title: "A Christmas Carol", author: "Charles Dickens",
        blurb: "Three ghosts, one cold man, and a single night to change him." },
      { id: 43, title: "Dr Jekyll and Mr Hyde", author: "R. L. Stevenson",
        blurb: "A respectable doctor, a darker self, and the door between them." },
      // SUBSTITUTE (operator approval pending): the brief's "The Old Man and the
      // Sea" is not public domain. The Time Machine fills the third weekend slot;
      // its blurb is drafted in the design voice, not from the copy tables.
      { id: 35, title: "The Time Machine", author: "H. G. Wells",
        blurb: "An afternoon's experiment carries one man to the world's last, dying light." },
    ],
  },
];

/** Every catalogue id the library needs resolved up front — the doorway picks
 *  plus the front-door starters — so the frontend can fetch them all in one
 *  cmd_discover_books_by_ids call. De-duplicated, order preserved. */
export const DOORWAY_IDS: number[] = (() => {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const s of STARTERS) if (!seen.has(s.id)) { seen.add(s.id); ids.push(s.id); }
  for (const shelf of SHELVES) {
    for (const p of shelf.picks) if (!seen.has(p.id)) { seen.add(p.id); ids.push(p.id); }
  }
  return ids;
})();

/**
 * Join the curated shelves against a catalogue index (id → DiscoverBook).
 * Picks whose id is absent from the index are dropped — so a shelf only ever
 * shows books a reader can actually get. Shelves left empty are omitted. The
 * displayed title/author/blurb stay authored; `book` carries the import URLs.
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
          return book
            ? { book, title: pick.title, author: pick.author, blurb: pick.blurb }
            : null;
        })
        .filter((x): x is ResolvedShelfItem => x != null),
    }))
    .filter((shelf) => shelf.items.length > 0);
}

/** The front-door starter trio, joined against the catalogue index. Picks that
 *  do not resolve are dropped (so a cover is only shown for an importable book). */
export function resolveStarters(
  index: Map<number, DiscoverBook>,
): Array<{ book: DiscoverBook; title: string; author: string }> {
  return STARTERS.map((s) => {
    const book = index.get(s.id);
    return book ? { book, title: s.title, author: s.author } : null;
  }).filter((x): x is { book: DiscoverBook; title: string; author: string } => x != null);
}

/** Build an id → book index from any list of catalogue rows. Later rows win, so
 *  pass live results over the seed when both are available. */
export function indexBooks(books: DiscoverBook[]): Map<number, DiscoverBook> {
  const index = new Map<number, DiscoverBook>();
  for (const b of books) index.set(b.id, b);
  return index;
}

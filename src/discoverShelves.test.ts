import { describe, it, expect } from "vitest";
import {
  SHELVES,
  STARTERS,
  DOORWAY_IDS,
  resolveShelves,
  resolveStarters,
  indexBooks,
  type Shelf,
} from "./discoverShelves";
import type { DiscoverBook } from "./types";
// The real shipped catalogue, imported as a raw string (Vite's `?raw`) so this
// stays a frontend test with no node:fs. It's the source of truth the doorways
// resolve against (cmd_discover_books_by_ids looks ids up in this same file), so
// this fails the moment a curated pick or starter drifts out of the catalogue.
// The doorways can curate ANY of the ~77k books, not only the 200-book seed.
import catalogueTsv from "../src-tauri/resources/discover_catalogue.tsv?raw";

const CATALOGUE_IDS: Set<number> = (() => {
  const ids = new Set<number>();
  for (const line of catalogueTsv.split("\n")) {
    const id = Number(line.split("\t")[0]);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return ids;
})();

describe("discover doorways", () => {
  it("ships four symmetrical shelves, none empty", () => {
    expect(SHELVES.length).toBe(4);
    for (const shelf of SHELVES) {
      // Three picks each keeps the shelves even (the design's curated cell).
      expect(shelf.picks.length, `shelf "${shelf.key}" is not three picks`).toBe(3);
    }
  });

  it("gives every shelf a unique key, a label, and a descriptor", () => {
    const keys = new Set<string>();
    for (const shelf of SHELVES) {
      expect(shelf.key.trim()).not.toBe("");
      expect(shelf.title.trim()).not.toBe("");
      expect(shelf.description.trim()).not.toBe("");
      expect(keys.has(shelf.key), `duplicate shelf key "${shelf.key}"`).toBe(false);
      keys.add(shelf.key);
    }
  });

  it("carries the design's four doorway labels", () => {
    expect(SHELVES.map((s) => s.title)).toEqual([
      "Short classics",
      "Familiar names",
      "A little philosophy",
      "Finish in a weekend",
    ]);
  });

  it("resolves every pick + starter id against the real catalogue (no dangling ids)", () => {
    for (const shelf of SHELVES) {
      for (const pick of shelf.picks) {
        expect(
          CATALOGUE_IDS.has(pick.id),
          `shelf "${shelf.key}" references id ${pick.id}, absent from discover_catalogue.tsv`,
        ).toBe(true);
      }
    }
    for (const s of STARTERS) {
      expect(CATALOGUE_IDS.has(s.id), `starter id ${s.id} absent from the catalogue`).toBe(true);
    }
  });

  it("gives every pick a title, author, and a finished one-line authored blurb", () => {
    for (const shelf of SHELVES) {
      for (const pick of shelf.picks) {
        expect(pick.title.trim(), `id ${pick.id} has no title`).not.toBe("");
        expect(pick.author.trim(), `id ${pick.id} has no author`).not.toBe("");
        const b = pick.blurb.trim();
        expect(b, `id ${pick.id} on "${shelf.key}" has no blurb`).not.toBe("");
        // A finished one-liner — never truncated mid-word, and short enough to
        // clamp to two lines on the shelf.
        expect(b.endsWith("."), `blurb for id ${pick.id} is not a finished sentence`).toBe(true);
        expect(b.length, `blurb for id ${pick.id} is too long for two lines`).toBeLessThanOrEqual(100);
      }
    }
  });

  it("never surfaces the catalogue's source brand in any copy", () => {
    const banned = /gutenberg|gutendex/i;
    for (const shelf of SHELVES) {
      expect(shelf.title).not.toMatch(banned);
      expect(shelf.description).not.toMatch(banned);
      for (const pick of shelf.picks) {
        expect(pick.title).not.toMatch(banned);
        expect(pick.author).not.toMatch(banned);
        expect(pick.blurb).not.toMatch(banned);
      }
    }
    for (const s of STARTERS) {
      expect(s.title).not.toMatch(banned);
      expect(s.author).not.toMatch(banned);
    }
  });

  it("DOORWAY_IDS is the de-duped union of starter + pick ids", () => {
    const expected = new Set<number>([
      ...STARTERS.map((s) => s.id),
      ...SHELVES.flatMap((s) => s.picks.map((p) => p.id)),
    ]);
    expect(new Set(DOORWAY_IDS)).toEqual(expected);
    // De-duped (Meditations / Walden / Pride & Prejudice appear in both a shelf
    // and the starter trio, but only once here).
    expect(DOORWAY_IDS.length).toBe(new Set(DOORWAY_IDS).size);
  });

  it("drops unresolved picks but keeps shelves that still have books", () => {
    const present: DiscoverBook = {
      id: 1342,
      title: "Pride and Prejudice",
      author: "Jane Austen",
      language: "en",
      download_count: 1,
      has_txt: true,
      has_epub: true,
      txt_url: "x",
      epub_url: "y",
    };
    const shelves: Shelf[] = [
      {
        key: "mixed",
        title: "Mixed",
        description: "one real, one missing",
        picks: [
          { id: 1342, title: "Pride & Prejudice", author: "Jane Austen", blurb: "present." },
          { id: -1, title: "Gone", author: "Nobody", blurb: "absent." },
        ],
      },
      {
        key: "all-gone",
        title: "All gone",
        description: "nothing resolves",
        picks: [{ id: -2, title: "Gone", author: "Nobody", blurb: "absent." }],
      },
    ];
    const resolved = resolveShelves(indexBooks([present]), shelves);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].key).toBe("mixed");
    expect(resolved[0].items).toHaveLength(1);
    expect(resolved[0].items[0].book.id).toBe(1342);
    // The displayed title/author/blurb stay AUTHORED (not the raw catalogue row).
    expect(resolved[0].items[0].title).toBe("Pride & Prejudice");
    expect(resolved[0].items[0].blurb).toBe("present.");
  });

  it("resolveStarters resolves the trio and drops unresolved", () => {
    const austen: DiscoverBook = {
      id: 1342, title: "Pride and Prejudice", author: "Jane Austen", language: "en",
      download_count: 1, has_txt: true, has_epub: true, txt_url: "x", epub_url: "y",
    };
    const resolved = resolveStarters(indexBooks([austen]));
    // Only the resolvable starter comes back, with its authored title.
    expect(resolved.every((r) => r.book.id === 1342)).toBe(true);
    expect(resolved.find((r) => r.book.id === 1342)?.title).toBe("Pride & Prejudice");
  });

  it("prefers later rows when ids collide (live overrides seed)", () => {
    const seedRow: DiscoverBook = {
      id: 1342, title: "seed", author: "a", language: "en",
      download_count: 1, has_txt: true, has_epub: true, txt_url: null, epub_url: null,
    };
    const liveRow: DiscoverBook = { ...seedRow, title: "live" };
    const index = indexBooks([seedRow, liveRow]);
    expect(index.get(1342)?.title).toBe("live");
  });
});

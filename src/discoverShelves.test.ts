import { describe, it, expect } from "vitest";
import {
  SHELVES,
  resolveShelves,
  indexBooks,
  type Shelf,
} from "./discoverShelves";
import type { DiscoverBook } from "./types";
// The real shipped seed — the source of truth Discover joins shelves against.
// Importing it as a JSON module (not via node:fs) keeps this a frontend test and
// makes it fail the moment a curated pick drifts out of the catalogue.
import seed from "../src-tauri/resources/discover_seed.json";

const SEED_IDS: Set<number> = new Set(
  (seed as Array<{ id: number }>).map((b) => b.id),
);

describe("discover shelves", () => {
  it("ships at least one shelf, none empty", () => {
    expect(SHELVES.length).toBeGreaterThan(0);
    for (const shelf of SHELVES) {
      expect(shelf.picks.length, `shelf "${shelf.key}" is empty`).toBeGreaterThan(0);
    }
  });

  it("gives every shelf a key, title, and one-line description", () => {
    const keys = new Set<string>();
    for (const shelf of SHELVES) {
      expect(shelf.key.trim()).not.toBe("");
      expect(shelf.title.trim()).not.toBe("");
      expect(shelf.description.trim()).not.toBe("");
      expect(keys.has(shelf.key), `duplicate shelf key "${shelf.key}"`).toBe(false);
      keys.add(shelf.key);
    }
  });

  it("resolves every pick id against the real seed (no dangling ids)", () => {
    for (const shelf of SHELVES) {
      for (const pick of shelf.picks) {
        expect(
          SEED_IDS.has(pick.id),
          `shelf "${shelf.key}" references id ${pick.id}, absent from discover_seed.json`,
        ).toBe(true);
      }
    }
  });

  it("gives every pick a non-empty editorial reason", () => {
    for (const shelf of SHELVES) {
      for (const pick of shelf.picks) {
        expect(
          pick.reason.trim(),
          `id ${pick.id} on shelf "${shelf.key}" has no reason`,
        ).not.toBe("");
      }
    }
  });

  it("never surfaces the catalogue's source brand in any copy", () => {
    const banned = /gutenberg|gutendex/i;
    for (const shelf of SHELVES) {
      expect(shelf.title).not.toMatch(banned);
      expect(shelf.description).not.toMatch(banned);
      for (const pick of shelf.picks) expect(pick.reason).not.toMatch(banned);
    }
  });

  it("drops unresolved picks but keeps shelves that still have books", () => {
    // A book the catalogue can actually serve, plus a pick that won't resolve.
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
          { id: 1342, reason: "present" },
          { id: -1, reason: "absent" },
        ],
      },
      {
        key: "all-gone",
        title: "All gone",
        description: "nothing resolves",
        picks: [{ id: -2, reason: "absent" }],
      },
    ];
    const resolved = resolveShelves(indexBooks([present]), shelves);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].key).toBe("mixed");
    expect(resolved[0].items).toHaveLength(1);
    expect(resolved[0].items[0].book.id).toBe(1342);
    expect(resolved[0].items[0].reason).toBe("present");
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

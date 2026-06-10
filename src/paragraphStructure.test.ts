import { describe, it, expect } from "vitest";
import { segmentParagraph, blockRoleFor, isBlockRole, blockRoleClass, isContentsItem, openerLength, type StyleRange } from "./paragraphStructure";

describe("blockRoleFor — paragraph-level heading/blockquote roles", () => {
  const ranges: StyleRange[] = [
    { kind: "h2", start: 0, end: 11 },
    { kind: "blockquote", start: 13, end: 30 },
    { kind: "em", start: 40, end: 43 },
  ];
  it("returns the block role covering the paragraph", () => {
    expect(blockRoleFor(0, 11, ranges)).toBe("h2");
    expect(blockRoleFor(13, 17, ranges)).toBe("blockquote");
  });
  it("ignores inline ranges (em never yields a block role)", () => {
    // A body paragraph sitting where only an inline em range falls → no role.
    expect(blockRoleFor(40, 3, ranges)).toBeNull();
    expect(isBlockRole("em")).toBe(false);
    expect(isBlockRole("h3")).toBe(true);
  });
  it("returns null when no block range covers the paragraph", () => {
    expect(blockRoleFor(40, 10, ranges)).toBeNull();
  });
});

describe("segmentParagraph — flatten highlights + emphasis into ordered runs", () => {
  it("returns a single plain segment when nothing applies (parity with the old reader)", () => {
    const segs = segmentParagraph("Hello world", 0, [], []);
    expect(segs).toEqual([{ text: "Hello world", hlId: null, strong: false, em: false, opener: false }]);
  });

  it("wraps an inline emphasis range", () => {
    // "The cat sat" — em over "cat" (chars 4..7)
    const segs = segmentParagraph("The cat sat", 0, [], [{ kind: "em", start: 4, end: 7 }]);
    expect(segs).toEqual([
      { text: "The ", hlId: null, strong: false, em: false, opener: false },
      { text: "cat", hlId: null, strong: false, em: true, opener: false },
      { text: " sat", hlId: null, strong: false, em: false, opener: false },
    ]);
  });

  it("preserves highlight-only behavior (a single <mark> run)", () => {
    const segs = segmentParagraph("abcdef", 0, [{ id: "n1", start: 2, end: 4 }], []);
    expect(segs).toEqual([
      { text: "ab", hlId: null, strong: false, em: false, opener: false },
      { text: "cd", hlId: "n1", strong: false, em: false, opener: false },
      { text: "ef", hlId: null, strong: false, em: false, opener: false },
    ]);
  });

  it("composes an overlapping highlight and strong span in the intersection", () => {
    // text "0123456789"; strong [2,6), highlight [4,8)
    const segs = segmentParagraph("0123456789", 0, [{ id: "h", start: 4, end: 8 }], [{ kind: "strong", start: 2, end: 6 }]);
    expect(segs).toEqual([
      { text: "01", hlId: null, strong: false, em: false, opener: false },
      { text: "23", hlId: null, strong: true, em: false, opener: false },
      { text: "45", hlId: "h", strong: true, em: false, opener: false },
      { text: "67", hlId: "h", strong: false, em: false, opener: false },
      { text: "89", hlId: null, strong: false, em: false, opener: false },
    ]);
  });

  it("wraps a leading small-caps opener as a render-only slice (offsets unchanged)", () => {
    // The opener flag covers [0, openerLen) — a pure slice, never a rewrite. Here
    // openerLen 9 → "When I am" (the leading phrase) is flagged opener.
    const text = "When I am the first paragraph it opens a chapter.";
    const segs = segmentParagraph(text, 0, [], [], 9);
    // The slices concatenate back to the exact original text (no char added/lost).
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs[0]).toEqual({ text: "When I am", hlId: null, strong: false, em: false, opener: true });
    expect(segs.slice(1).every((s) => !s.opener)).toBe(true);
  });

  it("clips ranges to the paragraph using section-relative offsets", () => {
    // paragraph starts at section offset 100; em at section [104,107) → local [4,7)
    const segs = segmentParagraph("The cat sat", 100, [], [{ kind: "em", start: 104, end: 107 }]);
    expect(segs.find((s) => s.em)?.text).toBe("cat");
  });

  it("returns [] for empty paragraph text", () => {
    expect(segmentParagraph("", 0, [{ id: "x", start: 0, end: 0 }], [])).toEqual([]);
  });

  it("ignores non-inline kinds passed in inlineSpans (defensive)", () => {
    const segs = segmentParagraph("heading", 0, [], [{ kind: "h2", start: 0, end: 7 }]);
    expect(segs).toEqual([{ text: "heading", hlId: null, strong: false, em: false, opener: false }]);
  });
});

describe("openerLength — the small-caps opening phrase (book convention)", () => {
  it("returns the length of the first ~4 words", () => {
    // "When I wrote the following pages" → first 4 words "When I wrote the".
    const text = "When I wrote the following pages, or rather the bulk of them.";
    const len = openerLength(text);
    expect(text.slice(0, len)).toBe("When I wrote the");
  });

  it("honors a custom word count", () => {
    expect("When I wrote".slice(0, openerLength("When I wrote a book", 3))).toBe("When I wrote");
  });

  it("returns 0 when the phrase would swallow the whole (short) paragraph", () => {
    // "Two words" has fewer than 4 words → an opener would be the whole text.
    expect(openerLength("Two words")).toBe(0);
  });

  it("is offset-safe: the slice never exceeds the text length", () => {
    const text = "One two three four five six.";
    expect(openerLength(text)).toBeLessThanOrEqual(text.length);
    expect(openerLength(text)).toBeGreaterThan(0);
  });
});

describe("blockRoleClass + the book-typography vocabulary", () => {
  it("maps every new block kind to its reader CSS class", () => {
    expect(blockRoleClass("title")).toBe("tl-tp-title");
    expect(blockRoleClass("subtitle")).toBe("tl-tp-subtitle");
    expect(blockRoleClass("byline")).toBe("tl-tp-byline");
    expect(blockRoleClass("contents-label")).toBe("tl-toc-label");
    expect(blockRoleClass("contents-part")).toBe("tl-toc-part");
    expect(blockRoleClass("contents-item")).toBe("tl-toc-item");
    expect(blockRoleClass("epigraph")).toBe("tl-epigraph");
    expect(blockRoleClass("chapter-label")).toBe("tl-ch-label");
    expect(blockRoleClass("chapter-title")).toBe("tl-ch-title");
    expect(blockRoleClass("body-first")).toBe("tl-body-first");
    // legacy roles still map
    expect(blockRoleClass("h1")).toBe("tl-h1");
    expect(blockRoleClass("blockquote")).toBe("tl-blockquote");
  });

  it("returns null for an unknown kind (falls back to plain prose)", () => {
    expect(blockRoleClass("nonsense")).toBeNull();
  });

  it("treats every new kind as a block role (so blockRoleFor covers it)", () => {
    for (const k of ["title", "subtitle", "byline", "contents-label", "contents-part", "contents-item", "epigraph", "chapter-label", "chapter-title", "body-first"]) {
      expect(isBlockRole(k)).toBe(true);
    }
  });

  it("isContentsItem only matches the contents-item kind", () => {
    expect(isContentsItem("contents-item")).toBe(true);
    expect(isContentsItem("contents-part")).toBe(false);
    expect(isContentsItem(null)).toBe(false);
  });
});

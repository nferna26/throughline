import { describe, it, expect } from "vitest";
import { segmentParagraph, blockRoleFor, isBlockRole, type StyleRange } from "./paragraphStructure";

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
    expect(segs).toEqual([{ text: "Hello world", hlId: null, strong: false, em: false }]);
  });

  it("wraps an inline emphasis range", () => {
    // "The cat sat" — em over "cat" (chars 4..7)
    const segs = segmentParagraph("The cat sat", 0, [], [{ kind: "em", start: 4, end: 7 }]);
    expect(segs).toEqual([
      { text: "The ", hlId: null, strong: false, em: false },
      { text: "cat", hlId: null, strong: false, em: true },
      { text: " sat", hlId: null, strong: false, em: false },
    ]);
  });

  it("preserves highlight-only behavior (a single <mark> run)", () => {
    const segs = segmentParagraph("abcdef", 0, [{ id: "n1", start: 2, end: 4 }], []);
    expect(segs).toEqual([
      { text: "ab", hlId: null, strong: false, em: false },
      { text: "cd", hlId: "n1", strong: false, em: false },
      { text: "ef", hlId: null, strong: false, em: false },
    ]);
  });

  it("composes an overlapping highlight and strong span in the intersection", () => {
    // text "0123456789"; strong [2,6), highlight [4,8)
    const segs = segmentParagraph("0123456789", 0, [{ id: "h", start: 4, end: 8 }], [{ kind: "strong", start: 2, end: 6 }]);
    expect(segs).toEqual([
      { text: "01", hlId: null, strong: false, em: false },
      { text: "23", hlId: null, strong: true, em: false },
      { text: "45", hlId: "h", strong: true, em: false },
      { text: "67", hlId: "h", strong: false, em: false },
      { text: "89", hlId: null, strong: false, em: false },
    ]);
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
    expect(segs).toEqual([{ text: "heading", hlId: null, strong: false, em: false }]);
  });
});

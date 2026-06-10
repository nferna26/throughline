import { describe, it, expect } from "vitest";
import { locatorHint } from "./locatorHint";

// Reader-facing position hints: never the raw "char:"/"cfi:" plumbing string.
describe("locatorHint", () => {
  it("humanizes percent locators", () => {
    expect(locatorHint("percent:32")).toBe("32% in");
  });

  it("names EPUB locators without exposing the CFI", () => {
    expect(locatorHint("cfi:/6/4!/2")).toBe("EPUB locator");
  });

  it("returns null for char locators without section context (chapter header is enough)", () => {
    expect(locatorHint("char:48211")).toBeNull();
  });

  it("turns a char locator into a percent when the section span is known", () => {
    expect(locatorHint("char:320", { start: 0, length: 1000 })).toBe("32% in");
    expect(locatorHint("char:1320", { start: 1000, length: 1000 })).toBe("32% in");
  });

  it("clamps out-of-range char offsets to 0–100%", () => {
    expect(locatorHint("char:2500", { start: 1000, length: 1000 })).toBe("100% in");
    expect(locatorHint("char:5", { start: 1000, length: 1000 })).toBe("0% in");
  });

  it("returns null for unknown or empty locators", () => {
    expect(locatorHint(null)).toBeNull();
    expect(locatorHint(undefined)).toBeNull();
    expect(locatorHint("")).toBeNull();
  });

  it("never returns a string containing the raw locator prefix", () => {
    for (const loc of ["char:99", "cfi:/6/2", "percent:50"]) {
      const hint = locatorHint(loc, { start: 0, length: 100 });
      expect(hint ?? "").not.toMatch(/char:|cfi:/);
    }
  });
});

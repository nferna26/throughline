import { describe, it, expect } from "vitest";
import { parseLocator, makeCharLocator, makeCfiLocator, errorMessage } from "./types";

describe("parseLocator", () => {
  it("parses tagged char / cfi / percent locators", () => {
    expect(parseLocator("char:42")).toEqual({ kind: "char", value: "42" });
    expect(parseLocator("cfi:epubcfi(/6/4!/4)")).toEqual({ kind: "cfi", value: "epubcfi(/6/4!/4)" });
    expect(parseLocator("percent:37")).toEqual({ kind: "percent", value: "37" });
  });

  it("treats a bare number as a Shot-1 char offset (backwards compat)", () => {
    expect(parseLocator("128")).toEqual({ kind: "char", value: "128" });
  });

  it("returns unknown for null, undefined, empty, or unrecognized locators", () => {
    expect(parseLocator(null)).toEqual({ kind: "unknown", value: "" });
    expect(parseLocator(undefined)).toEqual({ kind: "unknown", value: "" });
    expect(parseLocator("weird:thing")).toEqual({ kind: "unknown", value: "weird:thing" });
  });
});

describe("makeCharLocator / makeCfiLocator", () => {
  it("floors fractional offsets and clamps negatives to zero", () => {
    expect(makeCharLocator(10.9)).toBe("char:10");
    expect(makeCharLocator(-5)).toBe("char:0");
  });

  it("prefixes cfi locators", () => {
    expect(makeCfiLocator("epubcfi(/6/4!/4)")).toBe("cfi:epubcfi(/6/4!/4)");
  });
});

describe("errorMessage", () => {
  it("pulls the message off an AppError-shaped object", () => {
    expect(errorMessage({ kind: "Db", message: "database is locked" })).toBe("database is locked");
  });

  it("formats a NotFound (which carries resource/id, not message)", () => {
    expect(errorMessage({ kind: "NotFound", resource: "book", id: "b1" })).toBe("book not found: b1");
    expect(errorMessage({ kind: "NotFound", resource: "book", id: null })).toBe("book not found");
  });

  it("handles raw strings and nullish values", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(null)).toBe("(no error)");
  });
});

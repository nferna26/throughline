import { describe, it, expect } from "vitest";
import { splitDisplayTitle } from "./displayTitle";

const CHASM =
  "Crossing the Chasm, 3rd Edition: Marketing and Selling Disruptive Products to Mainstream Customers (Collins Business Essentials)";

describe("splitDisplayTitle", () => {
  it("splits on the FIRST colon into main + subtitle", () => {
    expect(splitDisplayTitle("Notes from Underground: A Novel")).toEqual({
      main: "Notes from Underground",
      subtitle: "A Novel",
    });
  });

  it("keeps the WHOLE title as main when there is no colon", () => {
    expect(splitDisplayTitle("Educated")).toEqual({ main: "Educated", subtitle: "" });
    expect(splitDisplayTitle("The Brothers Karamazov")).toEqual({
      main: "The Brothers Karamazov",
      subtitle: "",
    });
  });

  it("NEVER splits on a comma (edition info stays with the main title)", () => {
    expect(splitDisplayTitle("Crossing the Chasm, 3rd Edition")).toEqual({
      main: "Crossing the Chasm, 3rd Edition",
      subtitle: "",
    });
  });

  it("NEVER splits on parentheses (series/imprint tails stay intact)", () => {
    expect(splitDisplayTitle("Dune (Dune Chronicles, Book 1)")).toEqual({
      main: "Dune (Dune Chronicles, Book 1)",
      subtitle: "",
    });
  });

  it("NEVER splits on a semicolon", () => {
    expect(splitDisplayTitle("Moby Dick; Or, The Whale")).toEqual({
      main: "Moby Dick; Or, The Whale",
      subtitle: "",
    });
  });

  it("handles the Crossing-the-Chasm torture title: comma stays in main, colon splits", () => {
    expect(splitDisplayTitle(CHASM)).toEqual({
      main: "Crossing the Chasm, 3rd Edition",
      subtitle:
        "Marketing and Selling Disruptive Products to Mainstream Customers (Collins Business Essentials)",
    });
  });

  it("splits only on the FIRST colon; later colons stay in the subtitle", () => {
    expect(splitDisplayTitle("A: B: C")).toEqual({ main: "A", subtitle: "B: C" });
  });

  it("NEVER splits a colon WITHOUT a following space (times, ratios, scores, chapter:verse)", () => {
    expect(splitDisplayTitle("11:00")).toEqual({ main: "11:00", subtitle: "" });
    expect(splitDisplayTitle("16:9")).toEqual({ main: "16:9", subtitle: "" });
    expect(splitDisplayTitle("The 3:10 to Yuma")).toEqual({ main: "The 3:10 to Yuma", subtitle: "" });
    expect(splitDisplayTitle("Psalm 23:1")).toEqual({ main: "Psalm 23:1", subtitle: "" });
  });

  it("finds the REAL subtitle colon past a time/ratio (the spaced colon wins)", () => {
    expect(splitDisplayTitle("3:10 to Yuma: A Western")).toEqual({
      main: "3:10 to Yuma",
      subtitle: "A Western",
    });
  });

  it("does not split a trailing colon (nothing meaningful after) — keeps it whole", () => {
    expect(splitDisplayTitle("Title:")).toEqual({ main: "Title:", subtitle: "" });
  });

  it("does not split a leading colon (nothing meaningful before) — keeps it whole", () => {
    expect(splitDisplayTitle(": Subtitle only")).toEqual({ main: ": Subtitle only", subtitle: "" });
  });

  it("trims surrounding whitespace on both parts", () => {
    expect(splitDisplayTitle("  Main  :  Sub  ")).toEqual({ main: "Main", subtitle: "Sub" });
  });

  it("is safe on empty / whitespace-only input", () => {
    expect(splitDisplayTitle("")).toEqual({ main: "", subtitle: "" });
    expect(splitDisplayTitle("   ")).toEqual({ main: "", subtitle: "" });
  });
});

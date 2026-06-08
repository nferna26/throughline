import { describe, it, expect } from "vitest";
import { reduceMargin, initialMarginState, type MarginState } from "./marginPanel";

const closed: MarginState = { open: false, pinned: false };
const openUnpinned: MarginState = { open: true, pinned: false };
const openPinned: MarginState = { open: true, pinned: true };

describe("companion-margin reducer", () => {
  it("opens to a single column by default — no margin", () => {
    expect(initialMarginState(false)).toEqual({ open: false, pinned: false });
  });

  it("a pinned reader keeps the margin open across loads", () => {
    expect(initialMarginState(true)).toEqual({ open: true, pinned: true });
  });

  it("a bare text selection never opens the margin (the action toolbar handles it)", () => {
    expect(reduceMargin(closed, "select")).toEqual(closed);
  });

  it("a capture (note / highlight / tutor / briefing) opens the margin", () => {
    expect(reduceMargin(closed, "capture").open).toBe(true);
  });

  it("emptying the last item collapses the margin when not pinned", () => {
    expect(reduceMargin(openUnpinned, "emptied").open).toBe(false);
  });

  it("emptying does NOT collapse a pinned margin", () => {
    expect(reduceMargin(openPinned, "emptied")).toEqual(openPinned);
  });

  it("the toggle pins the margin open from the collapsed default", () => {
    expect(reduceMargin(closed, "togglePin")).toEqual({ open: true, pinned: true });
  });

  it("the toggle un-pins and closes a pinned margin", () => {
    expect(reduceMargin(openPinned, "togglePin")).toEqual({ open: false, pinned: false });
  });

  it("the toggle hides a margin opened by a capture in one click (the common state)", () => {
    // After a capture the margin is open-but-unpinned; the toolbar reads "Hide
    // notes panel", so one click must actually hide it — not re-pin it open.
    expect(reduceMargin(openUnpinned, "togglePin")).toEqual({ open: false, pinned: false });
  });

  it("close hides the margin and clears any pin", () => {
    expect(reduceMargin(openPinned, "close")).toEqual({ open: false, pinned: false });
  });
});

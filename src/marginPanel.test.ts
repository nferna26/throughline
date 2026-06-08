import { describe, it, expect } from "vitest";
import {
  reduceMargin,
  initialMarginState,
  marginVisible,
  type MarginState,
} from "./marginPanel";

const closed: MarginState = { open: false, pinned: false };
const openUnpinned: MarginState = { open: true, pinned: false };
const stalePin: MarginState = { open: false, pinned: true };

describe("companion-margin reducer", () => {
  it("never opens on load — not even from a persisted pin", () => {
    expect(initialMarginState(false)).toEqual({ open: false, pinned: false });
    expect(initialMarginState(true)).toEqual({ open: false, pinned: true });
  });

  it("a bare text selection never opens the margin (the action toolbar handles it)", () => {
    expect(reduceMargin(closed, "select")).toEqual(closed);
  });

  it("a capture (note / highlight / tutor / briefing) opens the margin", () => {
    expect(reduceMargin(closed, "capture").open).toBe(true);
  });

  it("emptying the last item collapses the session-open margin when not pinned", () => {
    expect(reduceMargin(openUnpinned, "emptied").open).toBe(false);
  });

  it("emptying does NOT collapse a pinned margin", () => {
    const openPinned: MarginState = { open: true, pinned: true };
    expect(reduceMargin(openPinned, "emptied")).toEqual(openPinned);
  });

  it("show opens and pins; hide closes and unpins", () => {
    expect(reduceMargin(closed, "show")).toEqual({ open: true, pinned: true });
    expect(reduceMargin({ open: true, pinned: true }, "hide")).toEqual({ open: false, pinned: false });
  });
});

describe("marginVisible", () => {
  it("is hidden by default (clean single column)", () => {
    expect(marginVisible(closed, false)).toBe(false);
  });

  it("a STALE PIN with no content stays hidden on load — never an empty half-panel", () => {
    // The reported bug: opening a fresh book showed an empty MARGIN panel because
    // a persisted pin force-opened it. A pin must not show an empty margin.
    expect(marginVisible(stalePin, false)).toBe(false);
  });

  it("a pinned reader sees the margin once the section has content", () => {
    expect(marginVisible(stalePin, true)).toBe(true);
  });

  it("shows when the reader opened it this session, even if empty (their explicit choice)", () => {
    expect(marginVisible(openUnpinned, false)).toBe(true);
  });

  it("does NOT auto-show existing notes on load when unpinned (badge + toggle instead)", () => {
    expect(marginVisible(closed, true)).toBe(false);
  });
});

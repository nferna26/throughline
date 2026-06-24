import { describe, it, expect } from "vitest";
import { anchorCardTop, guardScroll } from "./tutorAnchor";

describe("anchorCardTop (CORE-1163 grow-in-flow placement)", () => {
  it("aligns the card top to the selection line", () => {
    expect(anchorCardTop({ selectionTop: 120, viewportTop: 0 })).toBe(120);
    expect(anchorCardTop({ selectionTop: 900, viewportTop: 0 })).toBe(900); // tall card: the RAIL scrolls, no cap
  });

  it("never renders above the rail's top gap", () => {
    expect(anchorCardTop({ selectionTop: 4, viewportTop: 0, gap: 8 })).toBe(8);
    // When the line has scrolled above the viewport, clamp to the viewport top gap.
    expect(anchorCardTop({ selectionTop: 50, viewportTop: 200, gap: 8 })).toBe(208);
  });

  it("does NOT nudge up to fit a tall card (anchor stays on the line; the rail scrolls)", () => {
    // selectionTop 360 in a 400px viewport: the OLD model nudged up to 292; the new
    // model leaves the top on the line and lets the rail scroll.
    expect(anchorCardTop({ selectionTop: 360, viewportTop: 0 })).toBe(360);
  });
});

describe("guardScroll (place-keeping primitive)", () => {
  it("restores scrollTop if a mutation moved it", () => {
    const el = { scrollTop: 540 };
    const guard = guardScroll(el);
    el.scrollTop = 0; // simulate a layout-affecting mutation moving the column
    guard.restore();
    expect(el.scrollTop).toBe(540);
  });

  it("does nothing when scrollTop is unchanged (no needless write)", () => {
    const el = { scrollTop: 120 };
    const guard = guardScroll(el);
    guard.restore();
    expect(el.scrollTop).toBe(120);
  });

  it("is safe on a null container", () => {
    expect(() => guardScroll(null).restore()).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import {
  anchorCardTop,
  cardNeedsInternalScroll,
  cardMaxHeight,
  guardScroll,
} from "./tutorAnchor";

const base = { viewportTop: 0, viewportHeight: 400, gap: 8 };

describe("anchorCardTop (CORE-1158 placement)", () => {
  it("aligns the card top to the selection when it fits in view", () => {
    expect(
      anchorCardTop({ ...base, selectionTop: 120, selectionInView: true, cardHeight: 100 }),
    ).toBe(120);
  });

  it("nudges UP only as far as needed when the card would overflow the bottom", () => {
    // selectionTop 360 + cardHeight 100 = 460; viewport bottom (minus gap) = 392.
    // Nudge up by exactly the overflow (68) so the card bottom lands on 392.
    const top = anchorCardTop({ ...base, selectionTop: 360, selectionInView: true, cardHeight: 100 });
    expect(top).toBe(292);
    expect(top + 100).toBe(base.viewportHeight - base.gap); // bottom exactly at the edge
  });

  it("never nudges above the viewport top (clamps to the top gap)", () => {
    const top = anchorCardTop({ ...base, selectionTop: 4, selectionInView: true, cardHeight: 600 });
    expect(top).toBe(base.gap); // 8
  });

  it("pins to the TOP edge when the selection is above the viewport", () => {
    const top = anchorCardTop({
      viewportTop: 200,
      viewportHeight: 400,
      gap: 8,
      selectionTop: 50, // above viewportTop (200)
      selectionInView: false,
      cardHeight: 120,
    });
    expect(top).toBe(208); // viewportTop + gap
  });

  it("pins to the BOTTOM edge when the selection is below the viewport", () => {
    const top = anchorCardTop({
      viewportTop: 0,
      viewportHeight: 400,
      gap: 8,
      selectionTop: 900, // below the viewport bottom
      selectionInView: false,
      cardHeight: 120,
    });
    // bottom edge (392) minus card height (120) = 272
    expect(top).toBe(272);
  });
});

describe("internal-scroll thresholds", () => {
  it("needs internal scroll only when the card is taller than the viewport (minus gaps)", () => {
    expect(cardNeedsInternalScroll(300, 400)).toBe(false);
    expect(cardNeedsInternalScroll(390, 400)).toBe(true); // 390 > 384
    expect(cardMaxHeight(400)).toBe(384);
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

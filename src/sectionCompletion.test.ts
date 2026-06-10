import { describe, it, expect } from "vitest";
import { endReached, END_SLACK_PX } from "./sectionCompletion";

// FT-09: completion-by-scroll must be reachable. The predicate asks one
// question of the scroll container's geometry: has the VISIBLE BOTTOM of the
// viewport reached the end of the section's text (within a small slack)?
// The old top-of-viewport ratio needed ~20 screens of text to ever fire and
// could never fire for a section that fits one screen.
describe("endReached (section completion by scroll geometry)", () => {
  it("is true when the viewport bottom reaches the end of the text", () => {
    // 3200 + 800 = 4000 — exactly the bottom.
    expect(endReached({ scrollTop: 3200, clientHeight: 800, scrollHeight: 4000 })).toBe(true);
  });

  it("allows a small slack so 'almost exactly the bottom' still counts", () => {
    expect(endReached({ scrollTop: 3200 - END_SLACK_PX, clientHeight: 800, scrollHeight: 4000 })).toBe(true);
  });

  it("is true for a section that fits without scrolling at all", () => {
    // scrollHeight < clientHeight → no scroll event will ever fire; the one
    // post-paint measurement must count the section as reachable-to-the-end.
    expect(endReached({ scrollTop: 0, clientHeight: 800, scrollHeight: 700 })).toBe(true);
  });

  it("is false at the top of a long section", () => {
    expect(endReached({ scrollTop: 0, clientHeight: 800, scrollHeight: 4000 })).toBe(false);
  });

  it("is false just beyond the slack", () => {
    expect(endReached({ scrollTop: 3200 - END_SLACK_PX - 1, clientHeight: 800, scrollHeight: 4000 })).toBe(false);
  });

  it("is false on non-finite geometry (never completes by accident)", () => {
    expect(endReached({ scrollTop: NaN, clientHeight: 800, scrollHeight: 4000 })).toBe(false);
    expect(endReached({ scrollTop: 0, clientHeight: Infinity, scrollHeight: 4000 })).toBe(false);
  });
});

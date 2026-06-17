import { describe, it, expect } from "vitest";
import {
  fractionPhrase,
  featuredProgressLine,
  bookStateWord,
  bookAriaLabel,
} from "./libraryProgress";
import type { TodayCard } from "./types";

// A progress PHRASE must contain no number at all.
const NUMERIC = /\d|percent|%|page|minute/i;
// A featured LINE may name a chapter ("Chapter 2") — a location, not progress —
// but must never carry a percent, page count, or timer.
const PROGRESS_NUMERIC = /%|\bpercent\b|\bpages?\b|\bminutes?\b|\bhours?\b/i;

function card(partial: Partial<TodayCard>): TodayCard {
  return {
    book: { id: "b", title: "T", author: null, source_type: "txt", source_path: "", source_sha256: "", created_at: "", last_opened_at: null },
    plan: { id: "p", book_id: "b", start_date: "", status: "active", activated_at: null, sitting_length_minutes: null },
    state: "reading",
    chapter_label: "Chapter 2",
    phrase: null,
    estimated_minutes: 0,
    fraction_complete: 0.33,
    next_label: null,
    section: null,
    sitting_start_locator: null,
    sitting_end_locator: null,
    resume_locator: null,
    resume_percent: null,
    memory: { last_capture: null, highlight_count: 0, note_count: 0 },
    teaser: null,
    ...partial,
  } as TodayCard;
}

describe("fractionPhrase — human, never numeric", () => {
  it("speaks in calm phrases across the whole range, never a number", () => {
    for (const f of [0, 0.03, 0.1, 0.33, 0.5, 0.7, 0.9, 1]) {
      const p = fractionPhrase(f);
      expect(p.length).toBeGreaterThan(0);
      expect(p, `"${p}" for ${f} must not contain a number/percent/page/timer`).not.toMatch(NUMERIC);
    }
  });

  it("maps roughly-a-third to the handoff's exact phrase", () => {
    expect(fractionPhrase(0.33)).toBe("about a third of the way through");
  });

  it("clamps and tolerates out-of-range / non-finite input", () => {
    expect(fractionPhrase(-1)).toBe("just getting started");
    expect(fractionPhrase(2)).toBe("at the very end");
    expect(fractionPhrase(NaN)).toBe("just getting started");
  });
});

describe("featuredProgressLine — the card's one human line", () => {
  it("reads 'Chapter 2, about a third of the way through.' mid-book", () => {
    expect(featuredProgressLine(card({ state: "reading", chapter_label: "Chapter 2", fraction_complete: 0.33 })))
      .toBe("Chapter 2, about a third of the way through.");
  });

  it("never surfaces a percent / page / timer in any state (a chapter number is fine)", () => {
    for (const state of ["reading", "returning", "day_one", "finished", "no_plan"] as const) {
      const line = featuredProgressLine(card({ state, fraction_complete: 0.42 }));
      expect(line, `state ${state}: "${line}"`).not.toMatch(PROGRESS_NUMERIC);
    }
  });

  it("honors a finished book without a trophy", () => {
    expect(featuredProgressLine(card({ state: "finished" }))).toBe("You’ve read it to the end.");
  });

  it("welcomes a never-started book in voice", () => {
    expect(featuredProgressLine(card({ state: "day_one", chapter_label: "Chapter 1" })))
      .toBe("Ready to begin — Chapter 1.");
  });
});

describe("book accessible labels", () => {
  it("ends with the state word so completion isn't colour-only", () => {
    expect(bookStateWord(true)).toBe("finished");
    expect(bookStateWord(false)).toBe("reading");
  });

  it("builds 'title, author, state' and drops a missing author", () => {
    expect(bookAriaLabel("Walden", "Henry D. Thoreau", true)).toBe("Walden, Henry D. Thoreau, finished");
    expect(bookAriaLabel("Untitled", null, false)).toBe("Untitled, reading");
    expect(bookAriaLabel("Untitled", "  ", false)).toBe("Untitled, reading");
  });
});

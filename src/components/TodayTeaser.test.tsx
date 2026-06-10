import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TodayTeaser from "./TodayTeaser";
import type { TodayTeaser as Teaser } from "../types";

function teaser(over: Partial<Teaser> = {}): Teaser {
  return {
    excerpt: "Now the middle paragraph the reader is returning to begins here.",
    prompt: "Read for the thread — what is this paragraph carrying forward?",
    locator: "char:240",
    is_resume_excerpt: true,
    ...over,
  };
}

describe("TodayTeaser", () => {
  // CORE-1049: this surface is resume-only — a fresh section's opening is never
  // pre-printed, so the one remaining variant frames re-entry as a thread.
  it("frames the resume excerpt as picking up a thread, with the prompt beneath", () => {
    render(<TodayTeaser teaser={teaser()} />);
    expect(screen.getByText(/Where you left off/i)).toBeInTheDocument();
    expect(screen.getByText(/Now the middle paragraph/)).toBeInTheDocument();
    expect(screen.getByText(/Read for the thread/)).toBeInTheDocument();
    // The whole block is a calm, labelled note (not a heading-level surface).
    expect(screen.getByRole("note", { name: /Where you left off/i })).toBeInTheDocument();
  });

  it("carries no gamification or AI language anywhere in the block", () => {
    render(<TodayTeaser teaser={teaser()} />);
    // Word-boundaried so ordinary book text ("praised", "again") doesn't false-match.
    expect(
      screen.queryByText(/\b(streak|badge|XP|points|leaderboard|confetti)\b|AI-generated/i),
    ).toBeNull();
  });

  // CORE-1049: "Before you read" now has a single owner (the AI SectionBriefingCard).
  // The resume teaser must not re-claim that label.
  it("does not use the 'Before you read' label", () => {
    render(<TodayTeaser teaser={teaser()} />);
    expect(screen.queryByText(/Before you read/i)).toBeNull();
  });
});

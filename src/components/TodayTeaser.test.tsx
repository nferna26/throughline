import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TodayTeaser from "./TodayTeaser";
import type { TodayTeaser as Teaser } from "../types";

function teaser(over: Partial<Teaser> = {}): Teaser {
  return {
    excerpt: "Great art Thou, O Lord, and greatly to be praised.",
    prompt: "Read for the argument — what claim is being built?",
    locator: "char:0",
    is_resume_excerpt: false,
    ...over,
  };
}

describe("TodayTeaser", () => {
  it("renders the book's own excerpt as a quiet pull-quote with the reading prompt beneath", () => {
    render(<TodayTeaser teaser={teaser()} completed={false} />);
    expect(screen.getByText(/Great art Thou, O Lord/)).toBeInTheDocument();
    expect(screen.getByText(/Read for the argument/)).toBeInTheDocument();
    // The whole block is a calm, labelled note (not a heading-level surface).
    expect(screen.getByRole("note", { name: /Before you read/i })).toBeInTheDocument();
    // No gamification or AI language anywhere in the block. Word-boundaried so
    // ordinary book text ("praised", "again") doesn't false-match.
    expect(
      screen.queryByText(/\b(streak|badge|XP|points|leaderboard|confetti)\b|AI-generated/i),
    ).toBeNull();
  });

  it("frames the resume variant as picking up a thread, not opening a section", () => {
    render(
      <TodayTeaser
        teaser={teaser({
          excerpt: "Now the middle paragraph the reader is returning to begins here.",
          prompt: "Read for the thread — what is this paragraph carrying forward?",
          is_resume_excerpt: true,
        })}
        completed={false}
      />,
    );
    expect(screen.getByText(/Where you left off/i)).toBeInTheDocument();
    expect(screen.getByText(/Now the middle paragraph/)).toBeInTheDocument();
    expect(screen.getByText(/Read for the thread/)).toBeInTheDocument();
  });

  it("shows the calm 'section is ready' fallback when no teaser text is available", () => {
    render(<TodayTeaser teaser={null} completed={false} />);
    expect(screen.getByText(/Today's section is ready\. Read for one sentence worth keeping\./i)).toBeInTheDocument();
    // No excerpt/prompt pull-quote when unavailable.
    expect(screen.queryByText(/Read for the argument/)).toBeNull();
  });

  it("acknowledges a completed section without pressure to do more", () => {
    render(<TodayTeaser teaser={teaser()} completed={true} />);
    expect(screen.getByText(/You've finished today's section\. Let the note be enough\./i)).toBeInTheDocument();
    // The completed state retires the excerpt — the reading is done.
    expect(screen.queryByText(/Great art Thou, O Lord/)).toBeNull();
  });
});

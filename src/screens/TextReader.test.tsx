import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import TextReader from "./TextReader";
import type { TodayCard, BookSection, Note } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const section: BookSection = {
  id: "s1",
  book_id: "b1",
  label: "Chapter 1",
  href: null,
  start_locator: "0",
  end_locator: "1000",
  estimated_units: 1000,
  sort_order: 0,
};

function card(): TodayCard {
  return {
    book: { id: "b1", title: "Test Book", author: null, source_type: "txt", source_path: "", source_sha256: "x", created_at: "2026-05-29", last_opened_at: null },
    plan: { id: "p1", book_id: "b1", start_date: "2026-05-01", target_finish_date: "2026-06-01", daily_target_units: 1, days_per_week: 5, catchup_mode: "gentle", status: "active", activated_at: "2026-05-01T08:00:00Z", original_finish_date: null },
    section,
    section_completed: false,
    estimated_minutes: 10,
    session_minutes: 25,
    monthly_pct: 5,
    pace: { kind: "on_pace" },
    day_index: 1,
    total_days: 30,
    streak: { days_read_last_7: 1, minutes_last_7: 10 },
    recovery: null,
    resume_locator: null,
    resume_percent: null,
    plan_status: "active",
    forecast: { state: "on_track", projected_finish_date: "2026-05-30", days_late: 0 },
  };
}

function note(over: Partial<Note>): Note {
  return {
    id: "n1", book_id: "b1", session_id: null, note_type: "MarginNote",
    locator: "char:10", chapter_label: "Chapter 1", body: "", short_quote: null,
    created_at: "2026-05-29T10:00:00Z", updated_at: "2026-05-29T10:00:00Z", exported_markdown_path: null,
    anchor_start: "char:10", anchor_end: "char:15", anchored_text: "quick",
    ...over,
  };
}

// "quick" starts at index 10 of this section text.
const TEXT = "0123456789quick brown fox jumps over the lazy dog.";

function mockBackend(notes: Note[]) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_assignable_sections": return Promise.resolve([section]);
      case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
      case "cmd_read_section_text": return Promise.resolve(TEXT);
      case "cmd_list_notes": return Promise.resolve(notes);
      default: return Promise.resolve(undefined);
    }
  });
}

describe("TextReader Companion Margin", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("paints an anchored note as an inline highlight and a margin card", async () => {
    mockBackend([note({ body: "my thought" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    // The anchored run is wrapped in a highlight mark.
    await waitFor(() => {
      const mark = container.querySelector("mark.rg-hl");
      expect(mark).not.toBeNull();
      expect(mark!.textContent).toBe("quick");
    });
    // The margin card shows the editable body and the anchored excerpt.
    expect(screen.getByDisplayValue("my thought")).toBeInTheDocument();
    expect(screen.getByText("quick", { selector: "blockquote" })).toBeInTheDocument();
  });

  it("renders a saved AI card distinctly (read-only, AI label)", async () => {
    mockBackend([note({ id: "n2", note_type: "SavedAICard", body: "The author means X.", anchored_text: null })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(screen.getByText(/AI card/i)).toBeInTheDocument());
    expect(screen.getByText("The author means X.")).toBeInTheDocument();
    // AI cards are not editable text inputs.
    expect(container.querySelector(".rg-card.ai")).not.toBeNull();
    expect(screen.queryByDisplayValue("The author means X.")).toBeNull();
  });

  it("does not paint notes from other sections", async () => {
    mockBackend([note({ chapter_label: "Chapter 9", locator: "char:5000", anchor_start: "char:5000", anchor_end: "char:5005" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".rg-readcol")).not.toBeNull());
    // anchored at char 5000, outside this section's [0,1000) range → no highlight/card.
    expect(container.querySelector("mark.rg-hl")).toBeNull();
  });
});

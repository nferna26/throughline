import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Today from "./Today";
import type { TodayCard } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function card(): TodayCard {
  return {
    book: {
      id: "b1",
      title: "The Cold Start Problem",
      author: "Andrew Chen",
      source_type: "epub",
      source_path: "",
      source_sha256: "x",
      created_at: "2026-01-01",
      last_opened_at: null,
    },
    plan: {
      id: "p1",
      book_id: "b1",
      start_date: "2026-05-01",
      target_finish_date: "2026-05-31",
      daily_target_units: 1,
      days_per_week: 6,
      catchup_mode: "gentle",
    },
    section: {
      id: "s1",
      book_id: "b1",
      label: "Chapter 1",
      href: null,
      start_locator: "char:0",
      end_locator: "char:9000",
      estimated_units: 9000,
      sort_order: 0,
    },
    section_completed: false,
    estimated_minutes: 18,
    monthly_pct: 12,
    pace: { kind: "on_pace" },
    day_index: 3,
    total_days: 30,
    streak: { days_read_last_7: 4, minutes_last_7: 80 },
    recovery: null,
    resume_locator: null,
    resume_percent: null,
  };
}

const noop = () => {};

describe("Today", () => {
  it("renders the welcome card with an import action when there is no book", () => {
    render(<Today today={null} onImport={noop} onStart={noop} onRefresh={noop} />);
    expect(screen.getByText(/Welcome to ReadingGym/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import a book/i })).toBeInTheDocument();
  });

  it("renders today's section, pace, and Start Reading for an active book", () => {
    render(<Today today={card()} onImport={noop} onStart={noop} onRefresh={noop} />);
    expect(screen.getByRole("heading", { name: /The Cold Start Problem/ })).toBeInTheDocument();
    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
    expect(screen.getByText(/On pace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Reading/ })).toBeInTheDocument();
  });
});

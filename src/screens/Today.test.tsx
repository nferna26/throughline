import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
      status: "active",
      activated_at: "2026-05-01T08:00:00Z",
      original_finish_date: null,
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
    session_minutes: 25,
    monthly_pct: 12,
    pace: { kind: "on_pace" },
    day_index: 3,
    total_days: 30,
    streak: { days_read_last_7: 4, minutes_last_7: 80 },
    recovery: null,
    resume_locator: null,
    resume_percent: null,
    plan_status: "active",
    forecast: { state: "on_track", projected_finish_date: "2026-05-28", days_late: 0 },
    memory: { last_capture: null, highlight_count: 0, note_count: 0 },
  };
}

const noop = () => {};

describe("Today", () => {
  it("renders the welcome card with find + import actions when there is no book", () => {
    render(<Today today={null} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByText(/Welcome to Throughline/i)).toBeInTheDocument();
    // Primary path is the public-domain catalogue; importing a local file is secondary.
    expect(screen.getByRole("button", { name: /Find a book to read/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import a file instead/i })).toBeInTheDocument();
  });

  it("welcome primary opens Discover, secondary opens the file picker", () => {
    const onDiscover = vi.fn();
    const onImport = vi.fn();
    render(<Today today={null} onDiscover={onDiscover} onImport={onImport} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /Find a book to read/i }));
    expect(onDiscover).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Import a file instead/i }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("renders today's section, pace, and Start Reading for an active book", () => {
    render(<Today today={card()} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByRole("heading", { name: /The Cold Start Problem/ })).toBeInTheDocument();
    expect(screen.getByText("Chapter 1")).toBeInTheDocument();
    expect(screen.getByText(/On pace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start 25-minute session/i })).toBeInTheDocument();
  });

  it("stays quiet about 'Last time' when nothing has been captured", () => {
    render(<Today today={card()} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.queryByLabelText("Last time")).toBeNull();
  });

  it("brings forward the reader's last takeaway with calm, no-shame copy", () => {
    const t = card();
    t.memory = {
      last_capture: { note_type: "Takeaway", body: "grace precedes effort", chapter_label: "Book I", created_at: "2026-05-30T10:00:00Z" },
      highlight_count: 2,
      note_count: 3,
    };
    render(<Today today={t} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByLabelText("Last time")).toBeInTheDocument();
    expect(screen.getByText(/grace precedes effort/)).toBeInTheDocument();
    expect(screen.getByText(/You noted/)).toBeInTheDocument();
    expect(screen.getByText(/2 highlights · 3 notes/)).toBeInTheDocument();
    // No shame language anywhere in the surface.
    expect(screen.queryByText(/behind|streak|lost|missed/i)).toBeNull();
  });

  it("frames a last Question with 'You asked'", () => {
    const t = card();
    t.memory = {
      last_capture: { note_type: "Question", body: "can you seek what you don't know?", chapter_label: null, created_at: "2026-05-30T10:00:00Z" },
      highlight_count: 0,
      note_count: 1,
    };
    render(<Today today={t} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByText(/You asked/)).toBeInTheDocument();
    expect(screen.getByText(/can you seek what you don't know\?/)).toBeInTheDocument();
  });

  it("offers a timed session and an always-present 10-minute rescue", () => {
    const onStart = vi.fn();
    const onStartRescue = vi.fn();
    render(<Today today={card()} onDiscover={noop} onImport={noop} onStart={onStart} onStartRescue={onStartRescue} onRefresh={noop} />);
    // Primary action names the reading-rhythm length, not the section estimate.
    const primary = screen.getByRole("button", { name: /Start 25-minute session/i });
    fireEvent.click(primary);
    expect(onStart).toHaveBeenCalledTimes(1);
    // The rescue is always offered and routes to the calm 10-minute mode.
    const rescue = screen.getByRole("button", { name: /I only have 10 minutes/i });
    fireEvent.click(rescue);
    expect(onStartRescue).toHaveBeenCalledTimes(1);
  });

  it("surfaces a calm forecast line when slightly off pace", () => {
    const c = card();
    c.forecast = { state: "slightly_off_pace", projected_finish_date: "2026-06-03", days_late: 2 };
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByText(/Slightly off your original pace/i)).toBeInTheDocument();
    // Still calm — no recovery panel, no accusatory chip.
    expect(screen.queryByText(/A little behind/)).toBeNull();
  });

  // PRIORITY 0: a freshly imported book (plan_ready) must NEVER read as behind.
  it("reassures and never shows 'behind' for a freshly imported plan_ready book", () => {
    const c = card();
    c.plan_status = "plan_ready";
    c.plan.status = "plan_ready";
    c.plan.activated_at = null;
    c.pace = { kind: "not_started" };
    c.forecast = null;
    c.recovery = null;
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByText(/Plan ready\. You are not behind/i)).toBeInTheDocument();
    // The accusatory pace chip ("Behind · N days") and the recovery panel must
    // not appear for a not-yet-started plan.
    expect(screen.queryByText(/Behind ·/)).toBeNull();
    expect(screen.queryByText(/A little behind/)).toBeNull();
    expect(screen.queryByText(/Recovery/)).toBeNull();
  });

  // REGRESSION: "Restart current chapter" was removed as a recovery option —
  // throwing away read progress is a punishment, not a recovery. It must never
  // render, even when the recovery panel IS shown for a genuinely-behind book.
  it("never renders a 'Restart current chapter' recovery option", () => {
    const c = card();
    // Force the recovery panel to render with the full real option set.
    c.recovery = {
      headline: "Next smallest step: 10 minutes.",
      days_behind: 3,
      options: [
        { kind: "ResumeToday" },
        { kind: "GentleCatchup", extra_minutes: 10, for_sessions: 3 },
        { kind: "ExtendFinish", add_days: 3, new_finish: "2026-06-04" },
      ],
    };
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    // The recovery panel is present…
    expect(screen.getByText(/A little behind/)).toBeInTheDocument();
    // …but offers no restart/start-over affordance in any casing.
    expect(screen.queryByText(/restart/i)).toBeNull();
    expect(screen.queryByText(/start over/i)).toBeNull();
    expect(screen.queryByText(/current chapter/i)).toBeNull();
  });
});

describe("Today — continue where you left off", () => {
  it("surfaces resume position when the reader stopped mid-section", () => {
    const c = card();
    c.resume_percent = 42;
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    // Primary action names the resume, and a calm note explains it.
    expect(screen.getByRole("button", { name: /Continue — 42% into this section/i })).toBeInTheDocument();
    expect(screen.getByText(/left off about 42% into Chapter 1/i)).toBeInTheDocument();
    expect(screen.getByText(/opens right where you stopped/i)).toBeInTheDocument();
  });

  it("does NOT show resume for a fresh start (0%) — just the normal session button", () => {
    const c = card();
    c.resume_percent = 0;
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.queryByText(/Continue —/)).toBeNull();
    expect(screen.getByRole("button", { name: /Start 25-minute session/i })).toBeInTheDocument();
  });

  it("does NOT show resume on a near-finished section (≥97%) — that reads as done, not mid-thought", () => {
    const c = card();
    c.resume_percent = 98;
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.queryByText(/Continue —/)).toBeNull();
  });
});

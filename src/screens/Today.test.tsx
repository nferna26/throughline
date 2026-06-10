import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
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

  // REVIEW P1-4 / CORE-1002: the first screen must not overpromise. Since the
  // AI pivot, an opted-in tutor sends the reader's SELECTED PASSAGE to a cloud
  // provider — so the welcome promise names exactly what stays and what can go,
  // mirroring the Settings trust card and the consent sheet.
  it("welcome promise is truthful about the tutor (no absolute 'never leaves' claim)", () => {
    render(<Today today={null} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(
      screen.getByText(/Your books stay on this Mac\. If you ask the tutor, only the passage you select is sent — never the book\./),
    ).toBeInTheDocument();
    // The pre-pivot absolute claim is gone…
    expect(screen.queryByText(/never leave this Mac/i)).toBeNull();
    // …and the two promises that are still literally true stay.
    expect(screen.getByText(/Markdown that outlives the app/i)).toBeInTheDocument();
    expect(screen.getByText(/No account, no cloud, no tracking/i)).toBeInTheDocument();
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

  // CORE-1004: a book whose last plan was let go gets a plan-less Today card
  // (plan_status "no_plan") — the book header stays reachable and the one
  // obvious action is starting a plan, wired to the existing onNewPlan flow.
  it("offers 'Start a plan' for a plan-less (no_plan) book", () => {
    const onNewPlan = vi.fn();
    const c = card();
    c.plan_status = "no_plan";
    c.plan.status = "no_plan";
    c.section = null;
    c.pace = { kind: "not_started" };
    c.forecast = null;
    c.recovery = null;
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} onNewPlan={onNewPlan} />);
    // The book is still the headline — not the first-run welcome card.
    expect(screen.getByRole("heading", { name: /The Cold Start Problem/ })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome to Throughline/i)).toBeNull();
    // Calm empty-state copy teaches the next step…
    expect(screen.getByText(/Set a gentle pace whenever you're ready/i)).toBeInTheDocument();
    // …and the one obvious action starts a plan via the existing flow.
    fireEvent.click(screen.getByRole("button", { name: /Start a plan/i }));
    expect(onNewPlan).toHaveBeenCalledTimes(1);
    expect(onNewPlan.mock.calls[0][0]).toMatchObject({ id: "b1" });
    // No day counter, no pace pressure for a plan-less book.
    expect(screen.queryByText(/day 3 of 30/i)).toBeNull();
    expect(screen.queryByText(/Behind ·/)).toBeNull();
  });

  // CORE-1003: a PAUSED plan must read calmly — never the day-counter kicker
  // (whose clock keeps running) and never a "Behind" chip.
  it("reads calmly when the plan is paused — no day counter, no behind chip", () => {
    const c = card();
    c.plan_status = "paused";
    c.plan.status = "paused";
    c.pace = { kind: "not_started" };
    c.forecast = null;
    c.recovery = null;
    render(<Today today={c} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    expect(screen.getByText(/Paused — resume whenever you're ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/day 3 of 30/i)).toBeNull();
    expect(screen.queryByText(/Behind ·/)).toBeNull();
    expect(screen.queryByText(/A little behind/)).toBeNull();
    // The pace chip must agree with the kicker: "Paused", not "Not started".
    expect(screen.getByLabelText("Pace: Paused")).toBeInTheDocument();
    expect(screen.queryByText(/Not started/)).toBeNull();
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

// CORE-1007: GentleCatchup / WeekendCatchup were placebo buttons — they read
// as commitments ("Plan: add 10 min…") but changed no state and persisted
// nothing. They are now honest advice; ExtendFinish stays the one option that
// actually mutates the plan.
describe("Today — recovery options are honest", () => {
  function behindCard(): TodayCard {
    const c = card();
    c.recovery = {
      headline: "Next smallest step: 10 minutes.",
      days_behind: 3,
      options: [
        { kind: "GentleCatchup", extra_minutes: 10, for_sessions: 3 },
        { kind: "WeekendCatchup", weekend_starts_in_days: 0 },
        { kind: "ExtendFinish", add_days: 3, new_finish: "2026-06-04" },
      ],
    };
    return c;
  }

  it("GentleCatchup and WeekendCatchup read as advice — no 'Plan:' claim, no backend call", () => {
    render(<Today today={behindCard()} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={noop} />);
    // Ignore the mount-time cmd_list_plans_for_book lookup; from here on,
    // clicking an advice option must never reach the backend.
    vi.mocked(invoke).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /add(ing)? 10 min/i }));
    // No fabricated commitment — nothing was persisted, so nothing may claim "Plan:".
    expect(screen.queryByText(/^Plan:/)).toBeNull();
    expect(
      screen.getByText(/Try adding 10 minutes to your next few sittings — no setting to change, just sit a little longer\./),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Catch up this weekend/i }));
    expect(screen.queryByText(/^Plan:/)).toBeNull();
    expect(screen.getByText(/no weekday pressure, nothing to change/i)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ExtendFinish stays the one real option: it calls cmd_extend_finish_date", async () => {
    const onRefresh = vi.fn();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "cmd_extend_finish_date"
        ? { new_target_finish_date: "2026-06-04", new_daily_target_units: 1, remaining_sections: 4, remaining_days: 4 }
        : [],
    );
    render(<Today today={behindCard()} onDiscover={noop} onImport={noop} onStart={noop} onStartRescue={noop} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole("button", { name: /Re-pace to finish by 2026-06-04/i }));
    expect(await screen.findByText(/Finish date is now 2026-06-04/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("cmd_extend_finish_date", { bookId: "b1", addDays: 3 });
    expect(onRefresh).toHaveBeenCalled();
    vi.mocked(invoke).mockReset();
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

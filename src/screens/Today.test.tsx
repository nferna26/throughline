import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import Today from "./Today";
import type { TodayCard } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The old Today asserted pace chips, forecasts, streak dots, recovery panels,
// day counters, percent-complete stats, a rescue button, the "Last time"
// memory surface, and resume-percent copy. The Stage-2 screen deletes ALL of
// that by design: a TodayCard is one of five states (day_one / reading /
// returning / finished / no_plan) and "behind" is unrepresentable in the
// contract itself. The replacements below assert the new behaviors those
// tests were protecting readers from (or with): every state reads calm
// (no shame vocabulary can render), position is a silent hairline length
// (never a number), and the one obvious action per state still works.

function card(state: TodayCard["state"] = "reading"): TodayCard {
  return {
    book: { id: "b1", title: "The Confessions", author: "Augustine", source_type: "txt", source_path: "", source_sha256: "x", created_at: "2026-05-29", last_opened_at: null },
    plan: { id: "p1", book_id: "b1", start_date: "2026-05-01", status: "active", activated_at: "2026-05-01T08:00:00Z", sitting_length_minutes: 25 },
    state,
    chapter_label: "Chapter II",
    phrase: null,
    estimated_minutes: 8,
    fraction_complete: 0.3,
    next_label: null,
    section: { id: "s1", book_id: "b1", label: "Chapter II", href: null, start_locator: "0", end_locator: "1000", estimated_units: 1000, sort_order: 0 },
    sitting_start_locator: 0,
    sitting_end_locator: 1000,
    resume_locator: "120",
    resume_percent: null,
    memory: { last_capture: null, highlight_count: 0, note_count: 0 },
    teaser: null,
  };
}

const noop = () => {};

function renderToday(today: TodayCard | null, over: Partial<Parameters<typeof Today>[0]> = {}) {
  return render(
    <Today
      today={today}
      onDiscover={noop}
      onImport={noop}
      onStart={noop}
      onRefresh={noop}
      onNewPlan={noop}
      onReviewNotes={noop}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue([]);
});

describe("Today — welcome (no book yet)", () => {
  it("renders the welcome card with find + import actions when there is no book", () => {
    renderToday(null);
    expect(screen.getByText("Welcome to Throughline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Find a book to read/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import a file instead/i })).toBeInTheDocument();
  });

  it("welcome promise is truthful about the tutor: the selection is sent, never the book", () => {
    renderToday(null);
    expect(screen.getByText(/only the passage you select is sent, never the book/i)).toBeInTheDocument();
    expect(screen.getByText(/No account, no cloud, no tracking/i)).toBeInTheDocument();
    // The old absolute claim is gone — asking the tutor does leave the Mac.
    expect(screen.queryByText(/never leaves? this Mac/i)).toBeNull();
  });

  it("welcome primary opens Discover, secondary opens the file picker", () => {
    const onDiscover = vi.fn();
    const onImport = vi.fn();
    renderToday(null, { onDiscover, onImport });
    fireEvent.click(screen.getByRole("button", { name: /Find a book to read/i }));
    expect(onDiscover).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Import a file instead/i }));
    expect(onImport).toHaveBeenCalled();
  });
});

describe("Today — the book on the desk (five states)", () => {
  it("day_one: 'Beginning today', two calm lines, a bare hairline, Begin reading", () => {
    const onStart = vi.fn();
    const c = card("day_one");
    const { container } = renderToday(c, { onStart });

    expect(screen.getByText("Beginning today")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The Confessions" })).toBeInTheDocument();
    expect(screen.getByText("Augustine")).toBeInTheDocument();
    expect(screen.getByText("We've set an unhurried pace.")).toBeInTheDocument();
    expect(screen.getByText("There's no clock but your own.")).toBeInTheDocument();
    // Day one's hairline is bare: no fill yet, whatever fraction_complete says.
    const fill = container.querySelector(".tl-hairline .fill") as HTMLElement;
    expect(fill.style.width).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "Begin reading" }));
    expect(onStart).toHaveBeenCalledWith(c);
  });

  it("reading: time-of-day kicker, the chapter line, minutes as reassurance, Continue reading", () => {
    const onStart = vi.fn();
    const c = card("reading");
    renderToday(c, { onStart });

    expect(screen.getByText(/^This (morning|afternoon|evening)$/)).toBeInTheDocument();
    expect(screen.getByText("Chapter II")).toBeInTheDocument();
    expect(screen.getByText("About eight minutes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue reading" }));
    expect(onStart).toHaveBeenCalledWith(c);
  });

  it("the hairline binds fraction_complete as a length — never a number on screen", () => {
    const c = card("reading");
    c.fraction_complete = 0.3;
    const { container } = renderToday(c);
    const fill = container.querySelector(".tl-hairline .fill") as HTMLElement;
    expect(fill.style.width).toBe("30%");
    // Position is qualitative: no percentage (or any progress arithmetic) renders.
    expect(container.textContent).not.toMatch(/\d+\s*%/);
    expect(container.textContent).not.toMatch(/Day \d+/i);
  });

  it("the hairline clamps out-of-range fractions instead of overflowing", () => {
    const over = card("reading");
    over.fraction_complete = 1.4;
    const { container: c1, unmount } = renderToday(over);
    expect((c1.querySelector(".tl-hairline .fill") as HTMLElement).style.width).toBe("100%");
    unmount();

    const under = card("reading");
    under.fraction_complete = -0.4;
    const { container: c2 } = renderToday(under);
    expect((c2.querySelector(".tl-hairline .fill") as HTMLElement).style.width).toBe("0%");
  });

  it("the phrase slot is carried by the chapter label until Stage 3 fills it (pure text swap)", () => {
    const bare = card("reading");
    const { container: c1, unmount } = renderToday(bare);
    const slot1 = c1.querySelector(".tl-desk-orient .line.phrase") as HTMLElement;
    expect(slot1.textContent).toBe("Chapter II");
    unmount();

    const withPhrase = card("reading");
    withPhrase.phrase = "the pear tree and the gang";
    const { container: c2 } = renderToday(withPhrase);
    const slot2 = c2.querySelector(".tl-desk-orient .line.phrase") as HTMLElement;
    // Same slot, same node — the phrase appends into the label's own line.
    expect(slot2.textContent).toBe("Chapter II, the pear tree and the gang");
  });

  it("spells out small minute counts and keeps digits for large ones", () => {
    const one = card("reading");
    one.estimated_minutes = 1;
    const { unmount } = renderToday(one);
    expect(screen.getByText("About one minute.")).toBeInTheDocument();
    unmount();

    const many = card("reading");
    many.estimated_minutes = 25;
    renderToday(many);
    expect(screen.getByText("About 25 minutes.")).toBeInTheDocument();
  });

  it("returning: 'Welcome back', the story kept your place — and no tally of the gap, ever", () => {
    const onStart = vi.fn();
    const c = card("returning");
    const { container } = renderToday(c, { onStart });

    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(screen.getByText("The story kept your place.")).toBeInTheDocument();
    expect(screen.getByText("Chapter II is waiting where you left it.")).toBeInTheDocument();
    // However long the reader was away, the screen never counts the absence.
    expect(container.textContent).not.toMatch(/\d+\s*(day|week|month)s?\b/i);
    fireEvent.click(screen.getByRole("button", { name: "Continue reading" }));
    expect(onStart).toHaveBeenCalledWith(c);
  });

  it("finished: a check ring, notes review, a gentle forward pull — and no reading button", () => {
    const onReviewNotes = vi.fn();
    const onDiscover = vi.fn();
    const c = card("finished");
    c.next_label = "Book XIII";
    const { container } = renderToday(c, { onReviewNotes, onDiscover });

    expect(container.querySelector(".tl-check-ring")).not.toBeNull();
    expect(screen.getByText(/You finished The Confessions\./)).toBeInTheDocument();
    expect(screen.getByText(/Book XIII was the last of it/)).toBeInTheDocument();
    // No primary reading action remains in the finished state.
    expect(screen.queryByRole("button", { name: /Continue reading|Begin reading/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review your notes" }));
    expect(onReviewNotes).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Find another book" }));
    expect(onDiscover).toHaveBeenCalled();
  });

  it("no_plan: the book still owns Today, with one calm action — Start a plan", () => {
    const onNewPlan = vi.fn();
    const c = card("no_plan");
    const { container } = renderToday(c, { onNewPlan });

    expect(screen.getByText("On your desk")).toBeInTheDocument();
    expect(screen.getByText(/There's no plan right now/)).toBeInTheDocument();
    // The hairline rests empty rather than disappearing.
    expect((container.querySelector(".tl-hairline .fill") as HTMLElement).style.width).toBe("0px");

    fireEvent.click(screen.getByRole("button", { name: "Start a plan" }));
    expect(onNewPlan).toHaveBeenCalledWith(c.book);
  });

  it("'behind' is unrepresentable: every state reads calm — no shame vocabulary can render", () => {
    // The old contract carried pace/recovery/streak/forecast fields the screen
    // had to be tested NOT to weaponize. The new contract cannot express them;
    // this pins that none of the five states smuggles the vocabulary back in.
    const states: Array<TodayCard["state"]> = ["day_one", "reading", "returning", "finished", "no_plan"];
    for (const s of states) {
      const { container, unmount } = renderToday(card(s));
      expect(container.textContent).not.toMatch(/behind|streak|missed|catch.?up|recovery|lost/i);
      expect(container.textContent).not.toMatch(/Day \d+ of \d+/i);
      unmount();
    }
  });

  it("disables the reading button when there is no section to open", () => {
    const c = card("reading");
    c.section = null;
    renderToday(c);
    expect(screen.getByRole("button", { name: "Continue reading" })).toBeDisabled();
  });

  it("mentions earlier attempts only when the book has more than one plan", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "cmd_list_plans_for_book" ? [{}, {}, {}] : []),
    );
    renderToday(card("reading"));
    await waitFor(() => expect(screen.getByText(/2 earlier attempts/)).toBeInTheDocument());
  });

  it("stays quiet about plans when this is the book's only one", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "cmd_list_plans_for_book" ? [{}] : []),
    );
    renderToday(card("reading"));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("cmd_list_plans_for_book", { bookId: "b1" }));
    expect(screen.queryByText(/earlier attempt/)).toBeNull();
  });
});

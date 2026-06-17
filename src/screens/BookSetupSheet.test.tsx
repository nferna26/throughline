import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BookSetupSheet from "./BookSetupSheet";
import type { Book } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The first-journey screen is the book-chosen → reading-pace beat: the cover you
// picked rises to centre, then ONE calm question sizes each day's reading in
// reading terms (a few pages / a chapter / a long read), never minutes, never a
// timer. The pace persists globally + on the book's plan, is skippable, and a
// returning reader who already set it skips the question and lands on Today.

const book: Book = {
  id: "b1",
  title: "Thinking in Systems",
  author: "Donella Meadows",
  source_type: "epub",
  source_path: "",
  source_sha256: "x",
  created_at: "2026-05-29",
  last_opened_at: null,
};

/** Wire the pace + plan commands; `chosen` toggles the returning-reader skip. */
function wire(opts: { chosen?: boolean; minutes?: number; configureRejects?: unknown } = {}) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === "cmd_get_reading_pace")
      return Promise.resolve({ minutes: opts.minutes ?? 25, chosen: opts.chosen ?? false });
    if (cmd === "cmd_set_reading_pace") return Promise.resolve({ minutes: opts.minutes ?? 25, chosen: true });
    if (cmd === "cmd_configure_plan")
      return opts.configureRejects ? Promise.reject(opts.configureRejects) : Promise.resolve({});
    return Promise.resolve(undefined);
  });
}

/** Screen A (book chosen) → Continue → Screen B (reading pace). The two are now
 *  separate sequential screens, so a test that drives the pace must advance first. */
async function advanceToPace() {
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByText("What feels like a good sitting?");
}

describe("BookSetupSheet — book chosen → reading pace", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    wire();
  });

  it("shows the book-chosen screen first, then the pace question on a separate screen", async () => {
    render(<BookSetupSheet book={book} onBack={() => {}} onDone={() => {}} />);

    // Screen A — the chosen hero, verbatim. The pace question is NOT here yet.
    expect(await screen.findByText("Added to Today")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Thinking in Systems is yours to begin\./ })).toBeInTheDocument();
    expect(screen.getByText(/One last thing before you start: how do you like to read\?/)).toBeInTheDocument();
    expect(screen.queryByText("What feels like a good sitting?")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);

    // Continue → Screen B — the pace question, a chapter preselected, and the
    // chosen hero is gone (separate screens, no combined scroll).
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("What feels like a good sitting?")).toBeInTheDocument();
    expect(screen.queryByText("Added to Today")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /A chapter/ })).toHaveAttribute("aria-checked", "true");
  });

  it("never shows a minute count, a finish date, or a book length — pace is reading terms only", async () => {
    const { container } = render(<BookSetupSheet book={book} onBack={() => {}} onDone={() => {}} />);
    await advanceToPace();
    const t = container.textContent ?? "";
    // No number at all on the pace screen → no minute count, no finish date.
    expect(t).not.toMatch(/\d/);
    expect(t).not.toMatch(/of reading/i);
    expect(t).not.toMatch(/you'd finish|finish by|finish around/i);
    // The option cards describe in reading terms — never a duration READOUT. (The
    // sub line legitimately reassures "There's no timer"; the guarantee is that no
    // time/clock value is ever shown.)
    const group = screen.getByRole("radiogroup");
    expect(group.textContent ?? "").not.toMatch(/minute|hour|\bmin\b|o'?clock/i);
  });

  it("Start reading persists the pace globally AND on the book's plan, then begins", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onBack={() => {}} onDone={onDone} />);
    await advanceToPace();

    fireEvent.click(screen.getByRole("radio", { name: /A long read/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start reading" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    // Global preference (so future books default to it + the step is skipped).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("cmd_set_reading_pace", { minutes: 60 });
    // The book's own plan (the per-book pacing the engine reads).
    const cfg = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_configure_plan");
    expect(cfg![1]).toEqual({ bookId: "b1", sittingLengthMinutes: 60, name: null });
  });

  it("'I'll decide as I go' never blocks: default sitting, and it does NOT lock in a pace", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onBack={() => {}} onDone={onDone} />);
    await advanceToPace();

    fireEvent.click(screen.getByRole("button", { name: /I'll decide as I go/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));

    const cfg = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_configure_plan");
    expect((cfg![1] as { sittingLengthMinutes: number }).sittingLengthMinutes).toBe(25);
    // Skipping is "decide as I go" — it must NOT persist a chosen pace.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_set_reading_pace")).toBe(false);
  });

  it("arrow keys move the radio selection (WAI-ARIA radio pattern)", async () => {
    render(<BookSetupSheet book={book} onBack={() => {}} onDone={() => {}} />);
    await advanceToPace();
    const chapter = screen.getByRole("radio", { name: /A chapter/ });
    fireEvent.keyDown(chapter, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /A long read/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("radio", { name: /A long read/ }), { key: "ArrowLeft" });
    expect(chapter).toHaveAttribute("aria-checked", "true");
  });

  it("says what happened when saving fails, and stays open to retry", async () => {
    wire({ configureRejects: { kind: "Db", message: "The library is busy right now." } });
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onBack={() => {}} onDone={onDone} />);
    await advanceToPace();

    fireEvent.click(screen.getByRole("button", { name: "Start reading" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The library is busy right now.");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start reading" })).toBeEnabled();
  });
});

// Back-nav undo (CORE-1142): a labelled, keyboard-reachable Back affordance. On
// the pace screen it returns to the chosen screen (no undo); on the chosen
// screen it hands off to onBack so the caller can undo the pick.
describe("BookSetupSheet — Back affordance (first-run undo)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    wire();
  });

  it("Back on the chosen screen hands off to onBack (the undo), not onDone", async () => {
    const onBack = vi.fn();
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onBack={onBack} onDone={onDone} />);
    // It's labelled and reachable as a button on the first screen.
    const back = await screen.findByRole("button", { name: /^Back/ });
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("Back on the pace screen returns to chosen (no undo, no onBack)", async () => {
    const onBack = vi.fn();
    render(<BookSetupSheet book={book} onBack={onBack} onDone={() => {}} />);
    await advanceToPace();
    // On the pace screen now; Back steps back to the chosen hero…
    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    expect(await screen.findByText("Added to Today")).toBeInTheDocument();
    expect(screen.queryByText("What feels like a good sitting?")).toBeNull();
    // …and never undoes the pick (that's only the chosen-screen Back).
    expect(onBack).not.toHaveBeenCalled();
  });

  it("chosen ↔ pace transitions both directions without leaving the sheet", async () => {
    const onBack = vi.fn();
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onBack={onBack} onDone={onDone} />);
    // chosen → pace
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByText("What feels like a good sitting?");
    // pace → chosen
    fireEvent.click(screen.getByRole("button", { name: /^Back/ }));
    await screen.findByText("Added to Today");
    // chosen → pace again (the step state is clean, radios re-render)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("What feels like a good sitting?")).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

// The returning-reader skip needs its own wiring (chosen: true) — a focused block.
describe("BookSetupSheet — returning reader (pace already chosen)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    wire({ chosen: true, minutes: 10 });
  });

  it("configures this book with the saved pace and never asks again", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onBack={() => {}} onDone={onDone} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    expect(screen.queryByText("What feels like a good sitting?")).toBeNull();
    const cfg = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_configure_plan");
    expect((cfg![1] as { sittingLengthMinutes: number }).sittingLengthMinutes).toBe(10);
    // It must not re-persist (the reader already chose); only configure this book.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_set_reading_pace")).toBe(false);
  });
});

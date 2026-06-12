import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BookSetupSheet, { horizonSentence, lengthPhrase } from "./BookSetupSheet";
import type { Book, BookSection } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The old sheet asked five questions (finish date, session minutes, days a
// week, margin help, plan name) and footed itself with defensive copy ("No
// streak to break", "you are not behind"). The Stage-2 screen asks exactly
// ONE question — how much feels right at a sitting — and the old tests'
// behaviors are replaced accordingly: the rhythm choice still round-trips to
// cmd_configure_plan (new signature), deferring still never blocks, and the
// banned surfaces are pinned absent rather than configured.

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

function sections(): BookSection[] {
  // 40 sections × 9000 chars ≈ 72k words ≈ 6 hours of reading.
  return Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`,
    book_id: "b1",
    label: `Chapter ${i + 1}`,
    href: `c${i}.html`,
    start_locator: null,
    end_locator: null,
    estimated_units: 9000,
    sort_order: i,
  }));
}

describe("BookSetupSheet — one question", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_assignable_sections") return Promise.resolve(sections());
      if (cmd === "cmd_configure_plan") return Promise.resolve({});
      return Promise.resolve(undefined);
    });
  });

  it("asks exactly one question, with a steady sitting preselected", async () => {
    render(<BookSetupSheet book={book} onDone={() => {}} />);
    expect(screen.getByRole("heading", { name: /Thinking in Systems/ })).toBeInTheDocument();
    expect(screen.getByText("How much feels right at a sitting?")).toBeInTheDocument();

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /A steady sitting/ })).toHaveAttribute("aria-checked", "true");
    // The author + length line reads in plain words, never decimals.
    await waitFor(() => expect(screen.getByText(/Donella Meadows · about six hours of reading/)).toBeInTheDocument());
  });

  it("removed every surface where debt can form: no dates, cadence, margin help, name, or defensive copy", async () => {
    const { container } = render(<BookSetupSheet book={book} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByText(/of reading/)).toBeInTheDocument());

    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector("input")).toBeNull(); // no plan-name field either
    expect(screen.queryByText(/Finish by/i)).toBeNull();
    expect(screen.queryByText(/days a week/i)).toBeNull();
    expect(screen.queryByText(/margin help|guided|deep study/i)).toBeNull();
    expect(screen.queryByText(/decide later/i)).toBeNull();
    // Defensive copy raises the very ideas the product never mentions.
    expect(container.textContent).not.toMatch(/behind|streak/i);
    // No exact dates or decimal hours anywhere.
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(container.textContent).not.toMatch(/\d+\.\d+/);
  });

  it("configures the chosen sitting and begins reading", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onDone={onDone} />);

    fireEvent.click(screen.getByRole("radio", { name: /A long read/ }));
    fireEvent.click(screen.getByRole("button", { name: "Begin reading" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_configure_plan");
    expect(call).toBeTruthy();
    expect(call![1]).toEqual({ bookId: "b1", sittingLengthMinutes: 60, name: null });
  });

  it("the horizon reuses the card's words and lands around a month, in conditional mood", async () => {
    render(<BookSetupSheet book={book} onDone={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/At a steady sitting most evenings, you'd finish around (early|mid|late) [A-Z]/)).toBeInTheDocument(),
    );
    // Selection updates only the horizon sentence.
    fireEvent.click(screen.getByRole("radio", { name: /A few pages/ }));
    expect(screen.getByText(/At a few pages most evenings, you'd finish around (early|mid|late) [A-Z]/)).toBeInTheDocument();
  });

  it("'I'll decide as I go' never blocks: it proceeds on the default sitting", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: /I'll decide as I go/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_configure_plan");
    expect((call![1] as { sittingLengthMinutes: number }).sittingLengthMinutes).toBe(25);
  });

  it("arrow keys move the radio selection (WAI-ARIA radio pattern)", async () => {
    render(<BookSetupSheet book={book} onDone={() => {}} />);
    const steady = screen.getByRole("radio", { name: /A steady sitting/ });
    fireEvent.keyDown(steady, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /A long read/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("radio", { name: /A long read/ }), { key: "ArrowLeft" });
    expect(steady).toHaveAttribute("aria-checked", "true");
  });

  it("says what happened when saving fails, and stays open to retry", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_assignable_sections") return Promise.resolve(sections());
      if (cmd === "cmd_configure_plan") return Promise.reject({ kind: "Db", message: "The library is busy right now." });
      return Promise.resolve(undefined);
    });
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "Begin reading" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The library is busy right now.");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Begin reading" })).toBeEnabled();
  });

  it("discloses the phrases payload in the operator's exact words", async () => {
    render(<BookSetupSheet book={book} onDone={() => {}} />);
    expect(
      screen.getByText(
        "To name your sessions, Throughline sends each chapter's opening lines — never the full text.",
      ),
    ).toBeInTheDocument();
  });

  it("stays silent about length and horizon when the book's length is unknown", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_assignable_sections") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { container } = render(<BookSetupSheet book={book} onDone={() => {}} />);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("cmd_assignable_sections", { bookId: "b1" }));
    expect(container.textContent).not.toContain("of reading");
    expect(container.textContent).not.toContain("you'd finish");
    // The question itself still stands — silence about length never blocks.
    expect(screen.getByText("How much feels right at a sitting?")).toBeInTheDocument();
  });
});

describe("plan-screen phrasing helpers", () => {
  it("lengthPhrase speaks plain words at every magnitude", () => {
    expect(lengthPhrase(5)).toBe("a few minutes of reading");
    expect(lengthPhrase(40)).toBe("about forty minutes of reading");
    expect(lengthPhrase(70)).toBe("about an hour of reading");
    expect(lengthPhrase(120)).toBe("about two hours of reading");
    expect(lengthPhrase(540)).toBe("about nine hours of reading");
  });

  it("horizonSentence is silent without a length, and never emits a date", () => {
    expect(horizonSentence("A steady sitting", null, 25)).toBeNull();
    expect(horizonSentence("A steady sitting", 0, 25)).toBeNull();
    const s = horizonSentence("A steady sitting", 360, 25)!;
    expect(s).toMatch(/^At a steady sitting most evenings, you'd finish around (early|mid|late) [A-Z][a-z]+( next year)?\.$/);
    expect(s).not.toMatch(/\d/);
  });
});

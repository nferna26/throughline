import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BookSetupSheet from "./BookSetupSheet";
import type { Book, BookSection } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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

describe("BookSetupSheet", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_assignable_sections") return Promise.resolve(sections());
      if (cmd === "cmd_configure_plan") return Promise.resolve({});
      return Promise.resolve(undefined);
    });
  });

  it("defaults to This month / 25 min / 5 days and reassures the reader", async () => {
    render(<BookSetupSheet book={book} onDone={() => {}} />);
    expect(screen.getByRole("heading", { name: /Thinking in Systems/ })).toBeInTheDocument();
    expect(screen.getByText(/You are not behind/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "This month" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "25 min" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "5" })).toHaveAttribute("aria-checked", "true");
  });

  it("configures the plan with the chosen rhythm and proceeds", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onDone={onDone} />);
    // Wait for sections to load (estimate appears).
    await waitFor(() => expect(screen.getByText(/of reading/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "45 min" }));
    fireEvent.click(screen.getByRole("button", { name: /Start this plan/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_configure_plan");
    expect(call).toBeTruthy();
    expect(call![1]).toMatchObject({ bookId: "b1", daysPerWeek: 5, sessionMinutes: 45, marginHelp: "guided" });
    // target finish date is a YYYY-MM-DD string
    expect((call![1] as any).targetFinishDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("warns calmly when the finish window is too tight", async () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onDone={onDone} />);
    await waitFor(() => expect(screen.getByText(/of reading/i)).toBeInTheDocument());
    // "This week" against a ~6-hour book at 25 min × 5 days cannot fit.
    fireEvent.click(screen.getByRole("radio", { name: "This week" }));
    expect(screen.getByText(/give it more time, longer sittings, or more days/i)).toBeInTheDocument();
  });

  it("lets the reader defer without configuring", () => {
    const onDone = vi.fn();
    render(<BookSetupSheet book={book} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: /Decide later/i }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_configure_plan")).toBe(false);
  });
});

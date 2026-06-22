import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Library from "./Library";
import type { LibraryEntry, TodayCard } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function entry(p: Partial<LibraryEntry> & { id: string; title: string }): LibraryEntry {
  return {
    author: null, provenance: "imported", has_cover: false, finished: false,
    fraction: 0.4, location: "Chapter 1", last_opened_at: "2026-06-01", is_active: false, ...p,
  };
}

function todayFor(id: string, title: string): TodayCard {
  return {
    book: { id, title, author: "An Author", source_type: "epub", source_path: "", source_sha256: id, created_at: "", last_opened_at: null },
    plan: { id: "p", book_id: id, start_date: "", status: "active", activated_at: null, sitting_length_minutes: null },
    state: "reading", chapter_label: "Chapter 2", phrase: null, estimated_minutes: 0,
    fraction_complete: 0.33, next_label: null, section: null, sitting_start_locator: null,
    sitting_end_locator: null, resume_locator: null, resume_percent: null,
    memory: { last_capture: null, highlight_count: 0, note_count: 0 }, teaser: null,
  };
}

function mockLibrary(entries: LibraryEntry[]) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "cmd_library") return Promise.resolve(entries);
    if (cmd === "cmd_read_book_cover") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

const noop = () => {};
const baseProps = {
  refreshKey: 0,
  pendingRemovalId: null,
  onContinueReading: noop,
  onOpenBook: noop,
  onRequestRemove: noop,
  onBrowse: noop,
  onImport: noop,
};

beforeEach(() => mockInvoke.mockReset());

describe("Library surface", () => {
  it("empty: invites the reader to browse, never a backlog", async () => {
    mockLibrary([]);
    render(<Library {...baseProps} today={null} />);
    expect(await screen.findByText("Your library is empty for now")).toBeInTheDocument();
    expect(screen.getByText("The books you start will gather here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Browse the library/ })).toBeInTheDocument();
  });

  it("a few books: header + count, featured 'Reading now', Reading then Finished", async () => {
    mockLibrary([
      entry({ id: "a", title: "Old Man", is_active: true }),
      entry({ id: "b", title: "Meditations", fraction: 0.5 }),
      entry({ id: "c", title: "Walden", finished: true }),
    ]);
    render(<Library {...baseProps} today={todayFor("a", "Old Man")} />);
    expect(await screen.findByRole("heading", { name: "Your library" })).toBeInTheDocument();
    expect(screen.getByText("3 books")).toBeInTheDocument();
    // Featured active book, with the human progress line (never a percent).
    expect(screen.getByText("Reading now")).toBeInTheDocument();
    expect(screen.getByText("Chapter 2, about a third of the way through.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue reading/ })).toBeInTheDocument();
    // Both shelves present; the active book is featured (not repeated on a shelf).
    expect(screen.getByRole("heading", { name: "Reading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finished" })).toBeInTheDocument();
    // The finished book is labelled "finished" for assistive tech (not colour-only).
    expect(screen.getByRole("button", { name: "Walden, finished" })).toBeInTheDocument();
  });

  it("the populated header offers add-a-book: 'Add a book' → onBrowse, 'Import a file' → onImport", async () => {
    mockLibrary([entry({ id: "a", title: "Active", is_active: true })]);
    const onBrowse = vi.fn();
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<Library {...baseProps} today={todayFor("a", "Active")} onBrowse={onBrowse} onImport={onImport} />);
    await user.click(await screen.findByRole("button", { name: "Add a book" }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Import a file" }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("no search field for a small library; a search field appears for a large one", async () => {
    mockLibrary([entry({ id: "a", title: "Only", is_active: true })]);
    const { unmount } = render(<Library {...baseProps} today={todayFor("a", "Only")} />);
    await screen.findByRole("heading", { name: "Your library" });
    expect(screen.queryByPlaceholderText("Find a book in your library")).toBeNull();
    unmount();

    const many = Array.from({ length: 50 }, (_, i) =>
      entry({ id: `b${i}`, title: `Book ${i}`, is_active: i === 0 }),
    );
    mockLibrary(many);
    render(<Library {...baseProps} today={todayFor("b0", "Book 0")} />);
    expect(await screen.findByPlaceholderText("Find a book in your library")).toBeInTheDocument();
  });

  it("right-clicking a shelf book offers Remove (asks the parent)", async () => {
    mockLibrary([
      entry({ id: "a", title: "Active", is_active: true }),
      entry({ id: "b", title: "Second", author: "Two", provenance: "catalogue" }),
    ]);
    const onRequestRemove = vi.fn();
    const user = userEvent.setup();
    render(<Library {...baseProps} today={todayFor("a", "Active")} onRequestRemove={onRequestRemove} />);
    const row = await screen.findByRole("button", { name: "Second, Two, reading" });
    fireEvent.contextMenu(row, { clientX: 30, clientY: 30 });
    await user.click(await screen.findByRole("menuitem", { name: "Remove from library" }));
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
    expect(onRequestRemove.mock.calls[0][0]).toMatchObject({ id: "b", provenance: "catalogue" });
  });

  it("the featured Continue reading opens the reader", async () => {
    mockLibrary([entry({ id: "a", title: "Active", is_active: true })]);
    const onContinueReading = vi.fn();
    const user = userEvent.setup();
    render(<Library {...baseProps} today={todayFor("a", "Active")} onContinueReading={onContinueReading} />);
    await user.click(await screen.findByRole("button", { name: /Continue reading/ }));
    expect(onContinueReading).toHaveBeenCalledTimes(1);
  });
});

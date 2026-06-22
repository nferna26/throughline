import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookSwitcher from "./BookSwitcher";
import type { Book, LibraryEntry } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function mkBook(id: string, title: string): Book {
  return { id, title, author: null, source_type: "epub", source_path: "", source_sha256: id, created_at: "2026-01-01", last_opened_at: null };
}
function entry(p: Partial<LibraryEntry> & { id: string; title: string }): LibraryEntry {
  return {
    author: null,
    provenance: "imported",
    has_cover: false,
    finished: false,
    fraction: 0.3,
    location: "Chapter 1",
    last_opened_at: "2026-06-01",
    is_active: false,
    ...p,
  };
}

const active = mkBook("b1", "Active Book");
const entries: LibraryEntry[] = [
  entry({ id: "b1", title: "Active Book", location: "Chapter 5", last_opened_at: "2026-06-03", is_active: true }),
  entry({ id: "b2", title: "Second Book", author: "Author Two", provenance: "catalogue", location: "Chapter 2", last_opened_at: "2026-06-02" }),
  entry({ id: "b3", title: "Third Book", finished: true, location: null, last_opened_at: "2026-06-01" }),
];

function mockLibrary() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "cmd_library") return Promise.resolve(entries);
    if (cmd === "cmd_read_book_cover") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

beforeEach(() => mockInvoke.mockReset());

const props = {
  activeBook: active,
  refreshKey: 0,
  pendingRemovalId: null,
  onSwitch: () => {},
  onOpenLibrary: () => {},
  onShowInLibrary: () => {},
  onContinueReading: () => {},
  onDiscover: () => {},
  onImport: () => {},
  onRemoveBook: () => {},
};

describe("BookSwitcher — recents, Now, all-books, context menu", () => {
  it("shows the active book's title on the collapsed chip", () => {
    render(<BookSwitcher {...props} />);
    expect(screen.getByRole("button", { name: /Active Book/ })).toBeInTheDocument();
  });

  it("opens a recents list from cmd_library, marking the active book Now", async () => {
    mockLibrary();
    const user = userEvent.setup();
    render(<BookSwitcher {...props} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    // Each row's accessible name is title + author + state (the cloth cover that
    // also paints the title is aria-hidden, so it never double-announces).
    expect(await screen.findByRole("button", { name: "Second Book, Author Two, reading" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Third Book, finished" })).toBeInTheDocument();
    expect(screen.getByText("Now")).toBeInTheDocument();
    expect(screen.getByText("Chapter 2")).toBeInTheDocument(); // a row's location line
    expect(mockInvoke).toHaveBeenCalledWith("cmd_library");
  });

  it("switches to a chosen book", async () => {
    mockLibrary();
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(<BookSwitcher {...props} onSwitch={onSwitch} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    await user.click(await screen.findByRole("button", { name: "Second Book, Author Two, reading" }));
    expect(onSwitch).toHaveBeenCalledWith("b2");
  });

  it("'All books in your library' opens the Library surface", async () => {
    mockLibrary();
    const onOpenLibrary = vi.fn();
    const user = userEvent.setup();
    render(<BookSwitcher {...props} onOpenLibrary={onOpenLibrary} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    await user.click(await screen.findByRole("button", { name: "All books in your library" }));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("offers add-a-book rows: catalogue → onDiscover, import → onImport", async () => {
    mockLibrary();
    const onDiscover = vi.fn();
    const onImport = vi.fn();
    const user = userEvent.setup();
    render(<BookSwitcher {...props} onDiscover={onDiscover} onImport={onImport} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    // The acquisition affordance regressed when it was dropped from the switcher;
    // it lives below "All books in your library" as two quiet rows.
    await user.click(await screen.findByRole("button", { name: "Find a book in the catalogue" }));
    expect(onDiscover).toHaveBeenCalledTimes(1);
    expect(onImport).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Active Book/ })); // reopen (the first click closed it)
    await user.click(await screen.findByRole("button", { name: "Import a file" }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("right-click → Remove asks the parent with provenance (never deletes inline)", async () => {
    mockLibrary();
    const onRemoveBook = vi.fn();
    const user = userEvent.setup();
    render(<BookSwitcher {...props} onRemoveBook={onRemoveBook} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    const row = await screen.findByRole("button", { name: "Second Book, Author Two, reading" });
    fireEvent.contextMenu(row, { clientX: 60, clientY: 60 });
    await user.click(await screen.findByRole("menuitem", { name: "Remove from library" }));
    expect(onRemoveBook).toHaveBeenCalledWith({ id: "b2", title: "Second Book", provenance: "catalogue" });
    expect(mockInvoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
  });
});

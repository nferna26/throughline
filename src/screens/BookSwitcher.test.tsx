import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BookSwitcher from "./BookSwitcher";
import type { Book } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function mkBook(id: string, title: string): Book {
  return {
    id,
    title,
    author: null,
    source_type: "epub",
    source_path: "",
    source_sha256: id,
    created_at: "2026-01-01",
    last_opened_at: null,
  };
}

const active = mkBook("b1", "Active Book");
const allBooks = [active, mkBook("b2", "Second Book"), mkBook("b3", "Third Book")];

beforeEach(() => mockInvoke.mockReset());

describe("BookSwitcher", () => {
  it("shows the active book's title on the collapsed chip", () => {
    render(<BookSwitcher activeBook={active} onSwitch={() => {}} onImport={() => {}} />);
    expect(screen.getByRole("button", { name: /Active Book/ })).toBeInTheDocument();
  });

  it("lists every imported book when opened", async () => {
    mockInvoke.mockResolvedValueOnce(allBooks);
    const user = userEvent.setup();
    render(<BookSwitcher activeBook={active} onSwitch={() => {}} onImport={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    expect(await screen.findByText("Second Book")).toBeInTheDocument();
    expect(screen.getByText("Third Book")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("cmd_list_books");
  });

  it("calls onSwitch with the chosen book's id", async () => {
    mockInvoke.mockResolvedValueOnce(allBooks);
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(<BookSwitcher activeBook={active} onSwitch={onSwitch} onImport={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Active Book/ }));
    await user.click(await screen.findByText("Second Book"));
    expect(onSwitch).toHaveBeenCalledWith("b2");
  });
});

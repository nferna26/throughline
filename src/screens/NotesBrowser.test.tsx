import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import NotesBrowser from "./NotesBrowser";
import type { Book, Note } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const book: Book = {
  id: "book_1",
  title: "Design Systems",
  author: "Alla Kholmatova",
  source_type: "epub",
  source_path: "",
  source_sha256: "x",
  created_at: "2026-01-01",
  last_opened_at: null,
};

function note(over: Partial<Note>): Note {
  return {
    id: "n1",
    book_id: "book_1",
    session_id: null,
    note_type: "Observation",
    locator: "percent:10",
    chapter_label: "Chapter 1",
    body: "body text",
    short_quote: null,
    created_at: "2026-05-26T00:00:00Z",
    updated_at: "2026-05-26T00:00:00Z",
    exported_markdown_path: null,
    ...over,
  };
}

beforeEach(() => mockInvoke.mockReset());

describe("NotesBrowser", () => {
  it("shows an empty state when the book has no notes", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    render(<NotesBrowser book={book} />);
    expect(await screen.findByText(/No notes yet for this book/i)).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("cmd_list_notes", { bookId: "book_1" });
  });

  it("renders notes with type, body, and a short quote when present", async () => {
    mockInvoke.mockResolvedValueOnce([
      note({ id: "n1", note_type: "Short Quote", body: "keep this", short_quote: "a quote worth keeping" }),
      note({ id: "n2", note_type: "Question", body: "why does this rot?" }),
    ]);
    render(<NotesBrowser book={book} />);
    expect(await screen.findByText("keep this")).toBeInTheDocument();
    expect(screen.getByText(/a quote worth keeping/)).toBeInTheDocument();
    expect(screen.getByText("Short Quote")).toBeInTheDocument();
    expect(screen.getByText("why does this rot?")).toBeInTheDocument();
    expect(screen.getByText(/2 from this book/i)).toBeInTheDocument();
  });
});

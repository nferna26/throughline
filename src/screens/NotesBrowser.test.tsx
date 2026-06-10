import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    anchor_start: null,
    anchor_end: null,
    anchored_text: null,
    ...over,
  };
}

beforeEach(() => mockInvoke.mockReset());

describe("NotesBrowser", () => {
  it("shows an empty state when the book has no notes", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    render(<NotesBrowser book={book} />);
    expect(await screen.findByText(/Nothing captured yet for this book/i)).toBeInTheDocument();
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

describe("NotesBrowser chapter notebook", () => {
  it("groups notes under their chapter headings", async () => {
    mockInvoke.mockResolvedValueOnce([
      note({ id: "a", chapter_label: "Book I", body: "from one" }),
      note({ id: "b", chapter_label: "Book II", body: "from two" }),
    ]);
    const { container } = render(<NotesBrowser book={book} />);
    expect(await screen.findByText("from one")).toBeInTheDocument();
    const chapters = Array.from(container.querySelectorAll(".tl-notebook-chapter-h")).map((e) => e.textContent);
    expect(chapters).toContain("Book I");
    expect(chapters).toContain("Book II");
  });

  it("offers category filter chips with counts and filters the list", async () => {
    mockInvoke.mockResolvedValueOnce([
      note({ id: "h", note_type: "Highlight", body: "", anchored_text: "a highlighted run" }),
      note({ id: "q", note_type: "Question", body: "why does he say this?" }),
      note({ id: "t", note_type: "Takeaway", body: "grace precedes effort" }),
    ]);
    render(<NotesBrowser book={book} />);
    expect(await screen.findByText("grace precedes effort")).toBeInTheDocument();

    // A chip per populated category, each with a count.
    expect(screen.getByRole("button", { name: /Questions · 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Takeaways · 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Highlights · 1/ })).toBeInTheDocument();

    // Filtering to Takeaways hides the question.
    fireEvent.click(screen.getByRole("button", { name: /Takeaways · 1/ }));
    expect(screen.getByText("grace precedes effort")).toBeInTheDocument();
    expect(screen.queryByText("why does he say this?")).toBeNull();
  });

  it("reads a saved tutor answer's badge as 'Tutor card', never the raw enum (FT-38)", async () => {
    mockInvoke.mockResolvedValueOnce([
      note({ id: "t1", note_type: "TutorNote", body: "the tutor's explanation" }),
      // Legacy rows persisted the older enum name.
      note({ id: "t2", note_type: "SavedAICard", body: "an older saved answer" }),
    ]);
    render(<NotesBrowser book={book} />);
    expect(await screen.findByText("the tutor's explanation")).toBeInTheDocument();

    // Both badges read the plain reader word…
    expect(screen.getAllByText("Tutor card").length).toBeGreaterThanOrEqual(2);
    // …and the raw enum names never reach the page.
    expect(screen.queryByText("TutorNote")).toBeNull();
    expect(screen.queryByText("SavedAICard")).toBeNull();
  });

  it("shows a highlight's anchored text when it has no body", async () => {
    mockInvoke.mockResolvedValueOnce([
      note({ id: "h", note_type: "Highlight", body: "", anchored_text: "the unjust man is happy" }),
    ]);
    render(<NotesBrowser book={book} />);
    expect(await screen.findByText(/the unjust man is happy/)).toBeInTheDocument();
  });
});

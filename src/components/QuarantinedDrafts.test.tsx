// R5: quarantined drafts are READER-VISIBLE and operable — hidden
// localStorage bytes are not "recoverable".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import QuarantinedDrafts from "./QuarantinedDrafts";
import { quarantineDraft, setDraftGeneration } from "../noteDrafts";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const NOTE = {
  id: "n1",
  book_id: "b1",
  session_id: null,
  note_type: "MarginNote",
  locator: "char:0",
  chapter_label: null,
  body: "saved body",
  short_quote: null,
  created_at: "2026-05-29T10:00:00Z",
  updated_at: "2026-06-01T10:00:00Z",
  exported_markdown_path: null,
  anchor_start: null,
  anchor_end: null,
  anchored_text: null,
};

beforeEach(() => {
  localStorage.clear();
  setDraftGeneration("gen_now");
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_list_books":
        return Promise.resolve([{ id: "b1", title: "Confessions" }]);
      case "cmd_list_notes":
        return Promise.resolve([NOTE]);
      default:
        return Promise.resolve(undefined);
    }
  });
});

describe("QuarantinedDrafts (R5)", () => {
  it("renders nothing when the quarantine is empty", () => {
    const { container } = render(<QuarantinedDrafts />);
    expect(container.firstChild).toBeNull();
  });

  it("lists held words with their book title", async () => {
    quarantineDraft("n1", JSON.stringify({ body: "held words", base: "T", bookId: "b1" }));
    render(<QuarantinedDrafts />);
    expect(screen.getByText(/Recovered note drafts/)).toBeInTheDocument();
    expect(screen.getByText("held words")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Confessions/)).toBeInTheDocument());
  });

  it("Put back rebases the words onto the live note and consumes the entry", async () => {
    quarantineDraft("n1", JSON.stringify({ body: "held words", base: "OLD", bookId: "b1" }));
    render(<QuarantinedDrafts />);
    fireEvent.click(screen.getByRole("button", { name: "Put back" }));
    await act(async () => {});

    expect(await screen.findByText(/Put back\./)).toBeInTheDocument();
    const active = JSON.parse(localStorage.getItem("tl.noteDraft.n1")!);
    expect(active).toEqual({
      body: "held words",
      base: "2026-06-01T10:00:00Z",
      bookId: "b1",
      generation: "gen_now",
    });
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBeNull();
  });

  it("Put back refuses (Copy stays available) when the note no longer exists", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_list_books") return Promise.resolve([{ id: "b1", title: "Confessions" }]);
      if (cmd === "cmd_list_notes") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    quarantineDraft("n1", JSON.stringify({ body: "held words", base: "OLD", bookId: "b1" }));
    render(<QuarantinedDrafts />);
    fireEvent.click(screen.getByRole("button", { name: "Put back" }));
    await act(async () => {});

    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).not.toBeNull();
    expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull();
  });

  it("Copy puts the words on the clipboard without consuming the entry", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    quarantineDraft("n1", JSON.stringify({ body: "held words", base: "OLD", bookId: "b1" }));
    render(<QuarantinedDrafts />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {});

    expect(writeText).toHaveBeenCalledWith("held words");
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).not.toBeNull();
  });

  it("Discard is the only erasure — and it is explicit", async () => {
    quarantineDraft("n1", JSON.stringify({ body: "held words", base: "OLD", bookId: "b1" }));
    render(<QuarantinedDrafts />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => {});

    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBeNull();
    expect(screen.queryByText("held words")).toBeNull();
  });

  it("Put back over an OCCUPIED active draft keeps both sets of words and says so (R6-5)", async () => {
    quarantineDraft("n1", JSON.stringify({ body: "held words", base: "OLD", bookId: "b1" }));
    // The reader has since typed different active words on the same note.
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "newer active words", base: "2026-06-01T10:00:00Z", bookId: "b1", generation: "gen_now" }),
    );
    render(<QuarantinedDrafts />);
    fireEvent.click(screen.getByRole("button", { name: "Put back" }));
    await act(async () => {});

    expect(
      await screen.findByText(/other draft was kept safe in this list instead of being overwritten/),
    ).toBeInTheDocument();
    // The restored words are active; the displaced words are IN the list.
    expect(JSON.parse(localStorage.getItem("tl.noteDraft.n1")!).body).toBe("held words");
    expect(screen.getByText("newer active words")).toBeInTheDocument();
  });

  it("a failed clipboard copy exposes the COMPLETE selectable draft, not the 120-char preview (R6-5)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const long = "these are the reader's own words, every one of them mattering. ".repeat(5).trim(); // > 120 chars
    quarantineDraft("n1", JSON.stringify({ body: long, base: "OLD", bookId: "b1" }));
    render(<QuarantinedDrafts />);
    // Before the failure, only the truncated preview shows.
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {});

    expect(await screen.findByText(/full draft is shown below/)).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: /Full draft text/ }) as HTMLTextAreaElement;
    expect(box.value).toBe(long);
    expect(long.length).toBeGreaterThan(120);
    expect(box.readOnly).toBe(true);
    // The entry itself was NOT consumed by the failed copy.
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).not.toBeNull();
  });
});

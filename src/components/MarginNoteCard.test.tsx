// DATA-005: the margin note card's debounced autosave must never lose typed
// words — a failed save is announced with a real Try again (draft kept), and a
// pending debounce is flushed when the card unmounts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MarginNoteCard from "./MarginNoteCard";
import { setDraftGeneration } from "../noteDrafts";
import type { Note } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function note(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    book_id: "b1",
    session_id: null,
    note_type: "MarginNote",
    locator: "char:10",
    chapter_label: "Chapter 1",
    body: "first words",
    short_quote: null,
    created_at: "2026-05-29T10:00:00Z",
    updated_at: "2026-05-29T10:00:00Z",
    exported_markdown_path: null,
    anchor_start: "char:10",
    anchor_end: "char:15",
    anchored_text: "quick",
    ...over,
  };
}

const SAVED_OK = { note: note(), export: { ok: true, message: null } };

function parseStoredDraft(): { body: string; base: string } {
  return JSON.parse(localStorage.getItem("tl.noteDraft.n1")!) as { body: string; base: string };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.useFakeTimers();
  localStorage.clear();
  // R6-4: an UNKNOWN generation applies nothing — these tests exercise the
  // lineage decisions, which require the generation to be KNOWN.
  setDraftGeneration("gen_test");
});

function renderCard(extra: Partial<Parameters<typeof MarginNoteCard>[0]> = {}) {
  return render(
    <MarginNoteCard
      note={note()}
      active
      onActivate={() => {}}
      onSaved={() => {}}
      onDelete={() => {}}
      {...extra}
    />,
  );
}

describe("MarginNoteCard autosave (DATA-005)", () => {
  it("a rejected autosave keeps the typed words, announces the failure, and Try again saves durably", async () => {
    let calls = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_update_note") {
        calls += 1;
        return calls === 1 ? Promise.reject({ message: "database is locked" }) : Promise.resolve(SAVED_OK);
      }
      return Promise.resolve(undefined);
    });
    renderCard();

    fireEvent.change(screen.getByDisplayValue("first words"), { target: { value: "edited words" } });
    await vi.advanceTimersByTimeAsync(800); // past the 700ms debounce

    const err = await vi.waitFor(() => {
      const el = screen.getByRole("alert");
      expect(el.textContent).toMatch(/Couldn't save this note/i);
      return el;
    });
    // The reader's words are intact and the retry saves them durably.
    expect(screen.getByDisplayValue("edited words")).toBeInTheDocument();
    fireEvent.click(err.querySelector("button")!);
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("flushes a pending debounced edit on unmount instead of dropping it with the timer", async () => {
    vi.mocked(invoke).mockResolvedValue(SAVED_OK as never);
    const { unmount } = renderCard();

    fireEvent.change(screen.getByDisplayValue("first words"), { target: { value: "typed then closed" } });
    // Unmount BEFORE the 700ms debounce fires — the flush must still save.
    unmount();

    await vi.waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_update_note");
      expect(call).toBeTruthy();
      expect((call![1] as { body: string }).body).toBe("typed then closed");
    });
  });

  it("a REJECTED autosave during unmount leaves the retained draft; remount restores the exact words (DATA-005)", async () => {
    localStorage.clear();
    vi.mocked(invoke).mockRejectedValue({ message: "database is locked" } as never);
    const { unmount } = renderCard();

    fireEvent.change(screen.getByDisplayValue("first words"), { target: { value: "typed, then it all failed" } });
    // Unmount BEFORE the debounce; the flush attempt REJECTS.
    unmount();
    await vi.runAllTimersAsync();

    // The draft is durably retained, recording the lineage it extends —
    // including the library generation it was typed under (R5/R6-4).
    expect(JSON.parse(localStorage.getItem("tl.noteDraft.n1")!)).toEqual({
      body: "typed, then it all failed",
      base: "2026-05-29T10:00:00Z",
      bookId: "b1",
      generation: "gen_test",
    });
    // …and a remount of the SAME row lineage restores the exact words.
    renderCard();
    expect(screen.getByDisplayValue("typed, then it all failed")).toBeInTheDocument();
  });

  it("a CONFIRMED durable save clears the retained draft (no stale resurrection)", async () => {
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(SAVED_OK as never);
    renderCard();
    fireEvent.change(screen.getByDisplayValue("first words"), { target: { value: "kept words" } });
    expect(parseStoredDraft().body).toBe("kept words");
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull());
  });

  // ── Draft lineage guard (DATA-005 R3/R4): a draft auto-applies ONLY to the
  // row state it was typed against; a mismatch is QUARANTINED — the reader's
  // words are never silently erased ──

  it("a draft from a DIFFERENT lineage (restore-from-backup) is QUARANTINED, not applied and not erased", () => {
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(SAVED_OK as never);
    // Typed against updated_at T1 — then the library was restored to a backup
    // whose row has updated_at T0. Applying (and then auto-saving) this draft
    // would push post-backup words INTO the restored library.
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "post-backup words", base: "2026-06-01T09:00:00Z", bookId: "b1" }),
    );
    renderCard(); // note()'s updated_at is 2026-05-29T10:00:00Z — older lineage

    expect(screen.getByDisplayValue("first words")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("post-backup words")).toBeNull();
    // Never auto-applies again…
    expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull();
    // …but the words are RECOVERABLE, not erased (R4 quarantine).
    const q = localStorage.getItem("tl.noteDraftQuarantine.n1");
    expect(q).not.toBeNull();
    expect(JSON.parse(q!).body).toBe("post-backup words");
  });

  it("a legacy/unparseable draft value is quarantined instead of trusted OR erased", () => {
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(SAVED_OK as never);
    localStorage.setItem("tl.noteDraft.n1", "bare legacy words with no lineage");
    renderCard();

    expect(screen.getByDisplayValue("first words")).toBeInTheDocument();
    expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull();
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBe(
      "bare legacy words with no lineage",
    );
  });

  it("CRASH case: save A commits, newer B never rebased — B is quarantined and recoverable (R4)", () => {
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue(SAVED_OK as never);
    // Save A committed (row moved to T1); B was typed against T0 while A was
    // in flight; the process stopped BEFORE the response rebased B.
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "newer words B", base: "2026-05-29T09:00:00Z", bookId: "b1" }),
    );
    renderCard(); // the row is at T0=2026-05-29T10:00:00Z (A's committed state)

    // B must not auto-apply to a lineage it wasn't typed against…
    expect(screen.getByDisplayValue("first words")).toBeInTheDocument();
    // …but B is STILL RECOVERABLE — losing it was the review finding.
    const q = localStorage.getItem("tl.noteDraftQuarantine.n1");
    expect(JSON.parse(q!).body).toBe("newer words B");
  });

  it("typing while the generation is UNKNOWN preserves the hidden retained words before the first write (R7-4)", () => {
    localStorage.clear();
    setDraftGeneration(null);
    vi.mocked(invoke).mockResolvedValue(SAVED_OK as never);
    const hidden = JSON.stringify({
      body: "hidden unknown-lineage words",
      base: "2026-05-29T10:00:00Z",
      bookId: "b1",
      generation: "gen_old",
    });
    localStorage.setItem("tl.noteDraft.n1", hidden);
    renderCard();

    // Unknown lineage: not applied, not destroyed — the editor shows the
    // saved row and the value sits untouched under its key.
    expect(screen.getByDisplayValue("first words")).toBeInTheDocument();
    expect(localStorage.getItem("tl.noteDraft.n1")).toBe(hidden);

    // The FIRST keystroke would have overwritten the key — the hidden words
    // move to the recoverable quarantine first, then the new words retain.
    fireEvent.change(screen.getByDisplayValue("first words"), {
      target: { value: "newly typed words" },
    });
    expect(JSON.parse(localStorage.getItem("tl.noteDraft.n1")!).body).toBe("newly typed words");
    expect(JSON.parse(localStorage.getItem("tl.noteDraftQuarantine.n1")!).body).toBe(
      "hidden unknown-lineage words",
    );
  });

  it("with settings PERMANENTLY failing (generation never known), both the hidden and the new words stay recoverable across the save cycle (R7-4)", async () => {
    localStorage.clear();
    setDraftGeneration(null); // cmd_get_settings never succeeded — and never will
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      cmd === "cmd_get_settings"
        ? Promise.reject({ message: "settings store unavailable" })
        : Promise.resolve(SAVED_OK as never),
    );
    const hidden = JSON.stringify({ body: "hidden words", base: "T0", bookId: "b1" });
    localStorage.setItem("tl.noteDraft.n1", hidden);
    renderCard();

    fireEvent.change(screen.getByDisplayValue("first words"), {
      target: { value: "typed under unknown lineage" },
    });
    // The hidden words are already safe…
    expect(JSON.parse(localStorage.getItem("tl.noteDraftQuarantine.n1")!).body).toBe(
      "hidden words",
    );
    // …and the new words go through the normal durable save.
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() => {
      const call = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "cmd_update_note")
        .pop();
      expect((call?.[1] as { body: string } | undefined)?.body).toBe(
        "typed under unknown lineage",
      );
    });
    expect(JSON.parse(localStorage.getItem("tl.noteDraftQuarantine.n1")!).body).toBe(
      "hidden words",
    );
  });

  it("words typed WHILE a save is in flight are re-based onto the new row, not discarded as stale", async () => {
    localStorage.clear();
    // The save returns the row at its NEW updated_at.
    const savedNote = note({ body: "kept words", updated_at: "2026-05-29T10:05:00Z" });
    let resolveSave: ((v: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "cmd_update_note") {
        return new Promise((res) => { resolveSave = res; });
      }
      return Promise.resolve(undefined);
    });
    renderCard();

    fireEvent.change(screen.getByDisplayValue("first words"), { target: { value: "kept words" } });
    await vi.advanceTimersByTimeAsync(800); // debounce fires; save hangs
    // MORE typing while the save is in flight.
    fireEvent.change(screen.getByDisplayValue("kept words"), { target: { value: "kept words plus more" } });
    resolveSave!({ note: savedNote, export: { ok: true, message: null } });
    await vi.runAllTimersAsync();

    // The newer words survived, re-based onto the saved row's updated_at — a
    // quit right now must NOT discard them as another lineage on next launch.
    await vi.waitFor(() => {
      expect(parseStoredDraft()).toEqual({
        body: "kept words plus more",
        base: "2026-05-29T10:05:00Z",
        bookId: "b1",
        generation: "gen_test",
      });
    });
  });

  it("a durable save whose Markdown export failed reports through onExportIssue (DATA-004)", async () => {
    vi.mocked(invoke).mockResolvedValue({
      note: note(),
      export: { ok: false, message: "Saved in Throughline, but the Markdown file couldn't be updated." },
    } as never);
    const onExportIssue = vi.fn();
    renderCard({ onExportIssue });

    fireEvent.change(screen.getByDisplayValue("first words"), { target: { value: "edited" } });
    await vi.advanceTimersByTimeAsync(800);

    await vi.waitFor(() =>
      expect(onExportIssue).toHaveBeenCalledWith("n1", expect.stringMatching(/Markdown file couldn't be updated/)),
    );
    // No false failure banner — the save itself worked.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

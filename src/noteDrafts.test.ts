// DATA-005 R4: retained-draft reconciliation with sweep-committed deletions
// and restore-from-backup — deleted words must never resurrect, and the
// reader's words must never be silently erased.
import { describe, it, expect, beforeEach } from "vitest";
import {
  reconcileNoteDrafts,
  readRetainedDraft,
  quarantineDraft,
  setDraftGeneration,
  listQuarantinedDrafts,
  discardQuarantinedDraft,
  restoreQuarantinedDraft,
} from "./noteDrafts";
import type { Note } from "./types";

function note(over: Partial<Note> = {}): Note {
  return {
    id: "n1",
    book_id: "b1",
    session_id: null,
    note_type: "MarginNote",
    locator: "char:10",
    chapter_label: "Chapter 1",
    body: "saved body",
    short_quote: null,
    created_at: "2026-05-29T10:00:00Z",
    updated_at: "2026-05-29T10:00:00Z",
    exported_markdown_path: null,
    anchor_start: null,
    anchor_end: null,
    anchored_text: null,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  setDraftGeneration(null);
});

describe("reconcileNoteDrafts (startup, R4)", () => {
  it("delete → quit/sweep → restore with MATCHING old updated_at: deleted text does not resurrect", async () => {
    // The reader typed a draft against note n1 (base T), confirmed deletion,
    // and QUIT. The launch sweep committed the deletion in Rust — the
    // frontend never got to clean the draft.
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "text the reader deleted", base: "2026-05-29T10:00:00Z", bookId: "b1" }),
    );

    // Startup reconciliation: the note no longer exists in its book.
    await reconcileNoteDrafts(async (bookId) => (bookId === "b1" ? [] : []));

    // A LATER restore brings n1 back with the MATCHING old updated_at — the
    // exact resurrection window. The draft must not auto-apply…
    expect(readRetainedDraft(note())).toBeNull();
    // …because it was quarantined at startup (recoverable, never erased).
    const q = localStorage.getItem("tl.noteDraftQuarantine.n1");
    expect(JSON.parse(q!).body).toBe("text the reader deleted");
    expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull();
  });

  it("drafts whose notes still exist are left untouched", async () => {
    const raw = JSON.stringify({ body: "live draft", base: "T", bookId: "b1" });
    localStorage.setItem("tl.noteDraft.n1", raw);
    await reconcileNoteDrafts(async () => [{ id: "n1" }]);
    expect(localStorage.getItem("tl.noteDraft.n1")).toBe(raw);
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBeNull();
  });

  it("a failed notes lookup keeps that book's drafts (uncertainty never destroys)", async () => {
    const raw = JSON.stringify({ body: "words", base: "T", bookId: "b1" });
    localStorage.setItem("tl.noteDraft.n1", raw);
    await reconcileNoteDrafts(async () => {
      throw new Error("backend unavailable");
    });
    expect(localStorage.getItem("tl.noteDraft.n1")).toBe(raw);
  });

  it("a legacy draft with no bookId is quarantined (unverifiable), never erased", async () => {
    localStorage.setItem(
      "tl.noteDraft.n_old",
      JSON.stringify({ body: "legacy words", base: "T" }),
    );
    await reconcileNoteDrafts(async () => []);
    expect(localStorage.getItem("tl.noteDraft.n_old")).toBeNull();
    const q = localStorage.getItem("tl.noteDraftQuarantine.n_old");
    expect(JSON.parse(q!).body).toBe("legacy words");
  });

  it("repeated quarantines never overwrite earlier quarantined words", () => {
    quarantineDraft("n1", "first words");
    quarantineDraft("n1", "second words");
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBe("first words");
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1.1")).toBe("second words");
  });
});

// ── R5: the LIBRARY GENERATION token replaces updated_at-only lineage ──

describe("library generation gate (R5)", () => {
  it("a draft from a PREVIOUS generation never auto-applies — even when updated_at matches exactly", () => {
    // The precise review scenario: a restore brings back a row whose
    // updated_at COINCIDENTALLY equals the draft's base. The generation
    // token (rotated by the restore) is what still tells them apart.
    setDraftGeneration("gen_after_restore");
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({
        body: "post-backup words",
        base: "2026-05-29T10:00:00Z", // matches the restored row exactly
        bookId: "b1",
        generation: "gen_before_restore",
      }),
    );
    expect(readRetainedDraft(note())).toBeNull();
    const q = localStorage.getItem("tl.noteDraftQuarantine.n1");
    expect(JSON.parse(q!).body).toBe("post-backup words");
  });

  it("a same-generation draft with a matching base still applies", () => {
    setDraftGeneration("gen_now");
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "live words", base: "2026-05-29T10:00:00Z", bookId: "b1", generation: "gen_now" }),
    );
    expect(readRetainedDraft(note())).toBe("live words");
  });

  it("startup reconciliation quarantines generation-mismatched drafts even when the note still exists", async () => {
    setDraftGeneration("gen_2");
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "old-generation words", base: "T", bookId: "b1", generation: "gen_1" }),
    );
    await reconcileNoteDrafts(async () => [{ id: "n1" }]);
    expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull();
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).not.toBeNull();
  });

  it("an UNKNOWN generation never auto-applies — even an old-generation draft with a coincidentally equal updated_at cannot mount (R6-4)", () => {
    // The failure the base-only fallback allowed: settings load fails, a
    // restore rotated the generation, and the restored row's updated_at
    // equals the stale draft's base. With lineage unknown, the words must
    // neither mount nor be destroyed.
    setDraftGeneration(null);
    const stale = JSON.stringify({
      body: "stale pre-restore words",
      base: "2026-05-29T10:00:00Z", // equals the restored row's updated_at exactly
      bookId: "b1",
      generation: "gen_before_restore",
    });
    localStorage.setItem("tl.noteDraft.n1", stale);
    expect(readRetainedDraft(note())).toBeNull();
    // Preserved in place — not applied, not quarantined, not removed: the
    // decision is DEFERRED to a pass that knows the generation.
    expect(localStorage.getItem("tl.noteDraft.n1")).toBe(stale);
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBeNull();

    // Once the generation IS known, the same draft is decided: mismatched →
    // quarantined, never mounted.
    setDraftGeneration("gen_after_restore");
    expect(readRetainedDraft(note())).toBeNull();
    expect(localStorage.getItem("tl.noteDraft.n1")).toBeNull();
    expect(JSON.parse(localStorage.getItem("tl.noteDraftQuarantine.n1")!).body).toBe(
      "stale pre-restore words",
    );
  });

  it("startup reconciliation with an UNKNOWN generation defers the generation decision (no quarantine, no apply) (R6-4)", async () => {
    setDraftGeneration(null);
    const stale = JSON.stringify({ body: "w", base: "T", bookId: "b1", generation: "gen_old" });
    localStorage.setItem("tl.noteDraft.n1", stale);
    await reconcileNoteDrafts(async () => [{ id: "n1" }]);
    expect(localStorage.getItem("tl.noteDraft.n1")).toBe(stale);
    expect(localStorage.getItem("tl.noteDraftQuarantine.n1")).toBeNull();
  });
});

// ── R5: the quarantine is a real, reader-operable surface ──

describe("quarantined-draft surface helpers (R5)", () => {
  it("lists, discards, and restores quarantined words", () => {
    setDraftGeneration("gen_now");
    quarantineDraft("n1", JSON.stringify({ body: "kept words", base: "OLD", bookId: "b1" }));
    quarantineDraft("n2", "bare legacy words");

    const listed = listQuarantinedDrafts();
    expect(listed.map((e) => e.noteId).sort()).toEqual(["n1", "n2"]);
    expect(listed.find((e) => e.noteId === "n1")!.body).toBe("kept words");
    expect(listed.find((e) => e.noteId === "n1")!.bookId).toBe("b1");
    expect(listed.find((e) => e.noteId === "n2")!.body).toBe("bare legacy words");

    // Restore: rebased onto the note's CURRENT lineage + generation, and the
    // quarantine entry is consumed.
    const n1 = listed.find((e) => e.noteId === "n1")!;
    restoreQuarantinedDraft(n1.key, note());
    const active = JSON.parse(localStorage.getItem("tl.noteDraft.n1")!);
    expect(active).toEqual({
      body: "kept words",
      base: "2026-05-29T10:00:00Z",
      bookId: "b1",
      generation: "gen_now",
    });
    expect(localStorage.getItem(n1.key)).toBeNull();
    // The restored draft now auto-applies on the card.
    expect(readRetainedDraft(note())).toBe("kept words");

    // Discard is the only way quarantined words are erased.
    const n2 = listQuarantinedDrafts().find((e) => e.noteId === "n2")!;
    discardQuarantinedDraft(n2.key);
    expect(listQuarantinedDrafts()).toHaveLength(0);
  });

  it("Put back NEVER overwrites an occupied active draft — the occupied words are quarantined beside it (R6-5)", () => {
    setDraftGeneration("gen_now");
    quarantineDraft("n1", JSON.stringify({ body: "older quarantined words", base: "OLD", bookId: "b1" }));
    // The reader has since typed NEW active words on the same note.
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "active words", base: "2026-05-29T10:00:00Z", bookId: "b1", generation: "gen_now" }),
    );

    const entry = listQuarantinedDrafts().find((e) => e.noteId === "n1")!;
    restoreQuarantinedDraft(entry.key, note());

    // The restored words are active…
    expect(JSON.parse(localStorage.getItem("tl.noteDraft.n1")!).body).toBe(
      "older quarantined words",
    );
    // …and the displaced active words are IN quarantine — both sets survive.
    const bodies = listQuarantinedDrafts().map((e) => e.body);
    expect(bodies).toContain("active words");
    expect(bodies).not.toContain("older quarantined words"); // consumed by the put back
  });

  it("Put back with MULTIPLE quarantines on one note keeps every other entry AND the displaced active words (R6-5)", () => {
    setDraftGeneration("gen_now");
    quarantineDraft("n1", JSON.stringify({ body: "first", base: "O1", bookId: "b1" }));
    quarantineDraft("n1", JSON.stringify({ body: "second", base: "O2", bookId: "b1" }));
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "active words", base: "2026-05-29T10:00:00Z", bookId: "b1", generation: "gen_now" }),
    );
    const first = listQuarantinedDrafts().find((e) => e.body === "first")!;
    restoreQuarantinedDraft(first.key, note());
    expect(JSON.parse(localStorage.getItem("tl.noteDraft.n1")!).body).toBe("first");
    expect(listQuarantinedDrafts().map((e) => e.body).sort()).toEqual(["active words", "second"]);
  });

  it("Put back over an active draft holding the SAME words adds no duplicate quarantine (R6-5)", () => {
    setDraftGeneration("gen_now");
    quarantineDraft("n1", JSON.stringify({ body: "same words", base: "OLD", bookId: "b1" }));
    localStorage.setItem(
      "tl.noteDraft.n1",
      JSON.stringify({ body: "same words", base: "X", bookId: "b1", generation: "gen_now" }),
    );
    const entry = listQuarantinedDrafts().find((e) => e.noteId === "n1")!;
    restoreQuarantinedDraft(entry.key, note());
    expect(JSON.parse(localStorage.getItem("tl.noteDraft.n1")!).body).toBe("same words");
    expect(listQuarantinedDrafts()).toHaveLength(0);
  });
});

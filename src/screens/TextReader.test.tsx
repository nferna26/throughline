import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import TextReader, { clampToolbarPosition, clampPanelWidth, panelDragOutcome, DEFAULT_PANEL_WIDTH, splitParagraphs, firstProseDropCapOffset } from "./TextReader";
import type { TodayCard, BookSection, Note } from "../types";
import { invoke } from "@tauri-apps/api/core";

// Channel is a no-op class here — the Deep Study guard test only needs
// `new Channel()` not to throw; it asserts on cmd_ai_ask calls, not stream data.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { onmessage: ((e: unknown) => void) | null = null; },
}));

// The reader persists panel open/width to localStorage; clear it before each
// test so the companion panel starts at its CLOSED default (tests that need it
// open set tl.panelOpen="true" explicitly).
beforeEach(() => localStorage.clear());

const section: BookSection = {
  id: "s1",
  book_id: "b1",
  label: "Chapter 1",
  href: null,
  start_locator: "0",
  end_locator: "1000",
  estimated_units: 1000,
  sort_order: 0,
};

// The default sitting spans exactly the first section, [0, 1000) — tests that
// read across both sections widen it (a merged sitting over short chapters).
function card(): TodayCard {
  return {
    book: { id: "b1", title: "Test Book", author: null, source_type: "txt", source_path: "", source_sha256: "x", created_at: "2026-05-29", last_opened_at: null },
    plan: { id: "p1", book_id: "b1", start_date: "2026-05-01", status: "active", activated_at: "2026-05-01T08:00:00Z", sitting_length_minutes: 25 },
    state: "reading",
    chapter_label: "Chapter 1",
    phrase: null,
    estimated_minutes: 10,
    fraction_complete: 0.05,
    next_label: null,
    section,
    sitting_start_locator: 0,
    sitting_end_locator: 1000,
    resume_locator: null,
    resume_percent: null,
    memory: { last_capture: null, highlight_count: 0, note_count: 0 },
    teaser: null,
  };
}

function note(over: Partial<Note>): Note {
  return {
    id: "n1", book_id: "b1", session_id: null, note_type: "MarginNote",
    locator: "char:10", chapter_label: "Chapter 1", body: "", short_quote: null,
    created_at: "2026-05-29T10:00:00Z", updated_at: "2026-05-29T10:00:00Z", exported_markdown_path: null,
    anchor_start: "char:10", anchor_end: "char:15", anchored_text: "quick",
    ...over,
  };
}

// "quick" starts at index 10 of this section text.
const TEXT = "0123456789quick brown fox jumps over the lazy dog.";

function mockBackend(notes: Note[]) {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_assignable_sections": return Promise.resolve([section]);
      case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
      case "cmd_read_section_text": return Promise.resolve(TEXT);
      case "cmd_list_notes": return Promise.resolve(notes);
      default: return Promise.resolve(undefined);
    }
  });
}

describe("TextReader Companion Margin", () => {
  // These cases assert the margin CARD is visible, so open the panel (the new
  // default is closed). Runs after the module-level localStorage.clear().
  beforeEach(() => { vi.mocked(invoke).mockReset(); localStorage.setItem("tl.panelOpen", "true"); });

  it("paints an anchored note as an inline highlight and a margin card", async () => {
    mockBackend([note({ body: "my thought" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    // The anchored run is wrapped in a highlight mark.
    await waitFor(() => {
      const mark = container.querySelector("mark.tl-hl");
      expect(mark).not.toBeNull();
      expect(mark!.textContent).toBe("quick");
    });
    // The margin card shows the editable body and the anchored excerpt.
    expect(screen.getByDisplayValue("my thought")).toBeInTheDocument();
    expect(screen.getByText("quick", { selector: "blockquote" })).toBeInTheDocument();
  });

  it("renders a saved AI card distinctly (read-only, AI label)", async () => {
    mockBackend([note({ id: "n2", note_type: "SavedAICard", body: "The author means X.", anchored_text: null })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(screen.getByText(/AI card/i)).toBeInTheDocument());
    expect(screen.getByText("The author means X.")).toBeInTheDocument();
    // AI cards are not editable text inputs.
    expect(container.querySelector(".tl-card.ai")).not.toBeNull();
    expect(screen.queryByDisplayValue("The author means X.")).toBeNull();
  });

  it("does not paint notes from other sections", async () => {
    mockBackend([note({ chapter_label: "Chapter 9", locator: "char:5000", anchor_start: "char:5000", anchor_end: "char:5005" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")).not.toBeNull());
    // anchored at char 5000, outside this section's [0,1000) range → no highlight/card.
    expect(container.querySelector("mark.tl-hl")).toBeNull();
  });
});

// A part / half-title divider section (just a title, no body) is centered on its
// page so it reads as a deliberate divider — not a heading stranded at the top.
describe("TextReader — part-divider page", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());
  function mockText(t: string) {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section]);
        case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
        case "cmd_read_section_text": return Promise.resolve(t);
        case "cmd_list_notes": return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
  }
  it("centers a near-empty divider section (just a part title)", async () => {
    mockText("Part I. Thesis");
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    // Wait for is-divider directly — it only applies once the section text loads.
    await waitFor(() => expect(container.querySelector(".tl-sheet.is-divider")).not.toBeNull());
  });
  it("does not center a full content section", async () => {
    mockText("This is a real chapter with plenty of flowing prose to read. ".repeat(8));
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")).not.toBeNull());
    expect(container.querySelector(".tl-sheet.is-divider")).toBeNull();
  });
});

// FT-32: the margin card's X is a soft delete — it shows an Undo toast and only
// calls cmd_delete_note after the 6-second timer lapses. Undo cancels it entirely.
describe("TextReader margin note delete — Undo (FT-32)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    localStorage.setItem("tl.panelOpen", "true");
    vi.useFakeTimers();
  });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

  it("deletes via an Undo toast and never calls cmd_delete_note when undone", async () => {
    mockBackend([note({ note_type: "Highlight", body: "" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await vi.waitFor(() => expect(container.querySelector("mark.tl-hl")).not.toBeNull());

    // Click the card's X (aria-label "Delete note") — kept the same label.
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));

    // No backend delete yet, and a removal notice with an Undo button is shown.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_delete_note")).toBe(false);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    const undo = screen.getByRole("button", { name: /Undo/i });

    // Undo cancels the pending delete; let the would-be timer elapse anyway.
    fireEvent.click(undo);
    act(() => { vi.advanceTimersByTime(7000); });
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_delete_note")).toBe(false);
    // The card returns.
    expect(container.querySelector("mark.tl-hl")).not.toBeNull();
  });

  it("commits exactly one cmd_delete_note after the 6s timer lapses", async () => {
    mockBackend([note({ note_type: "Highlight", body: "" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await vi.waitFor(() => expect(container.querySelector("mark.tl-hl")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_delete_note")).toBe(false);

    await act(async () => { vi.advanceTimersByTime(6000); });
    const deletes = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_delete_note");
    expect(deletes.length).toBe(1);
    expect((deletes[0][1] as { noteId: string }).noteId).toBe("n1");
  });
});

// A two-section book so the recap's "next section" preview has something to show.
const section2: BookSection = {
  id: "s2", book_id: "b1", label: "Chapter 2", href: null,
  start_locator: "1000", end_locator: "2000", estimated_units: 1000, sort_order: 1,
};
function mockTwoSections() {
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_assignable_sections": return Promise.resolve([section, section2]);
      case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
      case "cmd_read_section_text": return Promise.resolve(TEXT);
      case "cmd_list_notes": return Promise.resolve([]);
      default: return Promise.resolve(undefined);
    }
  });
}

describe("TextReader session recap", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows a recap with stat counts and an honest next-time preview", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    // Wait until the section text has loaded (effects settled) before interacting.
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // Read the sitting to its end (the default sitting spans exactly Chapter 1).
    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    Object.defineProperty(main, "scrollTop", { value: 3200, writable: true, configurable: true });
    Object.defineProperty(main, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(main, "scrollHeight", { value: 4000, configurable: true });
    fireEvent.scroll(main);

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    // It's a recap, not a thin dialog: titled "Session recap" with stat tiles…
    expect(screen.getByText("Session recap")).toBeInTheDocument();
    expect(screen.getByText("min read")).toBeInTheDocument();
    // Recap stat tile label is exactly "highlight"/"highlights" (the panel's
    // empty-state hint also contains the word "highlight", so match the tile).
    expect(screen.getByText(/^highlights?$/)).toBeInTheDocument();
    expect(screen.getByText(/tutor card/)).toBeInTheDocument();
    // …and a concrete next-time preview: the sitting was completed, so the next
    // sitting opens in Chapter 2 (the section holding the sitting's end).
    expect(screen.getByText(/Next time/)).toBeInTheDocument();
    expect(screen.getByText("Chapter 2")).toBeInTheDocument();
  });

  it("previews the SAME chapter when the sitting wasn't read to its end", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // No reading happened — next time resumes right here, in Chapter 1.
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const recap = screen.getByRole("dialog");
    expect(within(recap).getByText(/Next time/)).toBeInTheDocument();
    expect(within(recap).getByText("Chapter 1")).toBeInTheDocument();
  });

  it("persists the recap takeaway as a durable Takeaway note (feeds notebook + Today memory)", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    // Add a takeaway, type the reader's own sentence, save.
    fireEvent.click(screen.getByRole("button", { name: /Add a takeaway/i }));
    fireEvent.change(screen.getByPlaceholderText(/Your one line/i), { target: { value: "grace precedes effort" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & finish/i }));

    // A durable Takeaway note is saved with the reader's words — privacy-safe
    // (no anchored passage), so it surfaces in the notebook + Today "Last time".
    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find(
        (c) => c[0] === "cmd_save_note" && (c[1] as { noteType?: string }).noteType === "Takeaway",
      );
      expect(call).toBeTruthy();
      const args = call![1] as { body: string; anchoredText: string | null };
      expect(args.body).toBe("grace precedes effort");
      expect(args.anchoredText).toBeNull();
    });
    // The session is also ended with that sentence as its summary.
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("cmd_end_session", expect.objectContaining({ summarySentence: "grace precedes effort" })),
    );
  });

  it("skipping the recap takeaway saves NO note and ends with a null summary", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // The toolbar "Finish" opens the recap; the recap's own primary action is
    // also labeled "Finish" when no takeaway is typed — pick the LAST one (the
    // recap dialog renders after the toolbar in the DOM).
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const finishButtons = screen.getAllByRole("button", { name: /^Finish$/ });
    fireEvent.click(finishButtons[finishButtons.length - 1]);

    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("cmd_end_session", expect.objectContaining({ summarySentence: null })),
    );
    const takeawaySaves = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "cmd_save_note" && (c[1] as { noteType?: string }).noteType === "Takeaway",
    );
    expect(takeawaySaves.length).toBe(0);
  });

  it("the rescue fork is gone: every session closes through the same calm recap", async () => {
    // The "I only have 10 minutes" mode was cut by the Stage-2 design: a short
    // sitting is just a sitting. There is ONE close button ("Finish", never
    // "Done"), ONE recap framing, and completion is never demanded — skipping
    // the takeaway ends the session with nothing forced.
    mockTwoSections();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByText("Session recap")).toBeInTheDocument();
    expect(screen.queryByText("That counts")).toBeNull();
    expect(screen.queryByText(/Ten minutes/)).toBeNull();
  });
});

// FT-29: leaving the reader by the toolbar "‹ Today" back button must flush the
// sitting (cmd_end_session with the completed sections + minutes), not silently
// discard it — and finishing normally must still end the session exactly once.
describe("TextReader toolbar back-exit flush (FT-29)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("flushes the session on the toolbar 'Today' back button before exiting", async () => {
    mockTwoSections();
    const onExit = vi.fn();
    // A merged sitting spanning both short chapters — Next stays in-span.
    const today = card();
    today.sitting_end_locator = 2000;
    const { container } = render(<TextReader today={today} onExit={onExit} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // Read s1, then advance — s1 is now visited-and-passed.
    fireEvent.click(screen.getByRole("button", { name: /Next section/i }));
    await waitFor(() => expect(screen.getByText(/Chapter 2/)).toBeInTheDocument());

    // Leave via the toolbar back button (named "Today"), NOT Finish.
    fireEvent.click(screen.getByRole("button", { name: /Today/ }));

    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_end_session");
      expect(call).toBeTruthy();
      expect((call![1] as { completedSectionIds: string[] }).completedSectionIds).toContain("s1");
      expect((call![1] as { minutes: number }).minutes).toBeGreaterThanOrEqual(1);
    });
    expect(onExit).toHaveBeenCalled();
  });

  it("ends the session exactly once when finishing normally (no double-end)", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const finishButtons = screen.getAllByRole("button", { name: /^Finish$/ });
    fireEvent.click(finishButtons[finishButtons.length - 1]);

    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_end_session").length).toBe(1),
    );
  });
});

// FT-09: finishing a section by READING it must be reachable. These tests pin
// the contents of completedSectionIds sent to cmd_end_session: scrolled to the
// bottom → the current section counts; barely started → it doesn't; a section
// short enough to fit one screen counts from the single post-paint measurement.
describe("TextReader section completion (endReached)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  // jsdom has no layout, so geometry is supplied directly on the scroll
  // container. scrollTop stays writable: the reader assigns it on navigation.
  function setGeometry(el: HTMLElement, g: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
    Object.defineProperty(el, "scrollTop", { value: g.scrollTop, writable: true, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: g.clientHeight, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: g.scrollHeight, configurable: true });
  }

  function finishSession() {
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const finishButtons = screen.getAllByRole("button", { name: /^Finish$/ });
    fireEvent.click(finishButtons[finishButtons.length - 1]);
  }

  async function endSessionArgs() {
    let args: { completedSectionIds: string[] } | undefined;
    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_end_session");
      expect(call).toBeTruthy();
      args = call![1] as { completedSectionIds: string[] };
    });
    return args!;
  }

  it("counts the current section once the reader scrolls to its end", async () => {
    mockBackend([]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    setGeometry(main, { scrollTop: 3200, clientHeight: 800, scrollHeight: 4000 });
    fireEvent.scroll(main);

    finishSession();
    expect((await endSessionArgs()).completedSectionIds).toContain("s1");
  });

  it("does NOT count a long section the reader only started", async () => {
    mockBackend([]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    setGeometry(main, { scrollTop: 0, clientHeight: 800, scrollHeight: 4000 });
    fireEvent.scroll(main);

    finishSession();
    expect((await endSessionArgs()).completedSectionIds).toEqual([]);
  });

  it("counts a section that fits one screen, measured once after its text paints", async () => {
    mockTwoSections();
    // A merged sitting spanning both short chapters — Next stays in-span.
    const today = card();
    today.sitting_end_locator = 2000;
    const { container } = render(<TextReader today={today} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // Chapter 2 fits the viewport outright — it will never fire a scroll event.
    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    setGeometry(main, { scrollTop: 0, clientHeight: 800, scrollHeight: 700 });
    fireEvent.click(screen.getByRole("button", { name: /Next section/i }));
    await waitFor(() => expect(screen.getByText(/Chapter 2/)).toBeInTheDocument());

    finishSession();
    const ids = (await endSessionArgs()).completedSectionIds;
    expect(ids).toContain("s2"); // short section: end reached without scrolling
    expect(ids).toContain("s1"); // visited-and-passed rule unchanged
  });
});

// Stage 2: a session is bounded to ONE SITTING — the [sitting_start_locator,
// sitting_end_locator) span on the TodayCard. Nothing outside the span may
// render or persist; completing the sitting ends the session AT the sitting's
// end (bare-digit global offset — the dialect that advances reading_position).
describe("TextReader sitting-bounded session", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  function setGeometry(el: HTMLElement, g: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
    Object.defineProperty(el, "scrollTop", { value: g.scrollTop, writable: true, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: g.clientHeight, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: g.scrollHeight, configurable: true });
  }

  it("renders only the sitting's slice of a split chapter, and Next/Prev stay disabled", async () => {
    mockBackend([]);
    // A split sitting: the first 25 chars of a 1000-char chapter.
    const today = card();
    today.sitting_end_locator = 25;
    const { container } = render(<TextReader today={today} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("brown fox"));

    // Text past the sitting end never renders.
    expect(container.querySelector(".tl-readcol")?.textContent).not.toContain("jumps");
    // The sitting touches one section only — navigation can't leave it.
    expect(screen.getByRole("button", { name: /Next section/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Previous section/i })).toBeDisabled();
  });

  it("completing a split sitting ends AT the sitting end and completes no chapter", async () => {
    mockBackend([]);
    const today = card();
    today.sitting_end_locator = 25;
    const { container } = render(<TextReader today={today} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("brown fox"));

    // Read the window to its end — the window ends exactly at the sitting end.
    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    setGeometry(main, { scrollTop: 3200, clientHeight: 800, scrollHeight: 4000 });
    fireEvent.scroll(main);

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const finishButtons = screen.getAllByRole("button", { name: /^Finish$/ });
    fireEvent.click(finishButtons[finishButtons.length - 1]);

    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_end_session");
      expect(call).toBeTruthy();
      const args = call![1] as { endLocator: string; completedSectionIds: string[] };
      // The sitting's end, bare digits — this is what rolls Today forward.
      expect(args.endLocator).toBe("25");
      // The chapter's true end (1000) is beyond the sitting: it is NOT complete.
      expect(args.completedSectionIds).toEqual([]);
    });
  });

  it("leaving mid-sitting ends at the current position, in bare digits", async () => {
    mockBackend([]);
    const onExit = vi.fn();
    const { container } = render(<TextReader today={card()} onExit={onExit} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // The session also STARTS in the bare-digit dialect.
    const start = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_start_session");
    expect((start![1] as { startLocator: string }).startLocator).toMatch(/^\d+$/);

    fireEvent.click(screen.getByRole("button", { name: /Today/ }));
    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_end_session");
      expect(call).toBeTruthy();
      // Nothing was read: the session ends where it opened — never "char:"-prefixed.
      expect((call![1] as { endLocator: string }).endLocator).toBe("0");
    });
    expect(onExit).toHaveBeenCalled();
  });

  it("a sitting opening mid-chapter rebases the window: anchors still align", async () => {
    localStorage.setItem("tl.panelOpen", "true");
    mockBackend([note({ body: "my thought" })]);
    // The sitting starts at char 10 — exactly where "quick" (and its note) sits.
    const today = card();
    today.sitting_start_locator = 10;
    const { container } = render(<TextReader today={today} onExit={() => {}} />);

    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));
    // Text before the sitting start never renders…
    expect(container.querySelector(".tl-readcol")?.textContent).not.toContain("0123456789");
    // …and the char-anchored highlight still lands on its exact word.
    await waitFor(() => {
      const mark = container.querySelector("mark.tl-hl");
      expect(mark).not.toBeNull();
      expect(mark!.textContent).toBe("quick");
    });
  });

  it("mid-session progress saves speak bare digits (the dialect that advances reading_position)", async () => {
    mockBackend([]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    fireEvent.scroll(main);

    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_save_section_progress");
      expect(call).toBeTruthy();
      expect((call![1] as { locator: string }).locator).toMatch(/^\d+$/);
    }, { timeout: 3000 });
  });
});

// FT-31: the reader's scroll container must be keyboard-pageable — Space pages
// down, Shift+Space pages back, the most ingrained reading gesture on a Mac.
describe("TextReader keyboard paging (FT-31)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("makes the scroll container focusable and pages with Space / Shift+Space", async () => {
    mockBackend([]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    // Focusable for keyboard users (WCAG 2.1.1).
    expect(main.tabIndex).toBe(0);

    // jsdom has no layout: supply the geometry the scroll math reads.
    Object.defineProperty(main, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(main, "scrollHeight", { value: 4000, configurable: true });
    Object.defineProperty(main, "scrollTop", { value: 0, writable: true, configurable: true });

    // Space pages down by ~0.9 × clientHeight (720).
    fireEvent.keyDown(main, { key: " " });
    expect(main.scrollTop).toBeCloseTo(720, 0);

    // Shift+Space pages back the same distance.
    fireEvent.keyDown(main, { key: " ", shiftKey: true });
    expect(main.scrollTop).toBeCloseTo(0, 0);
  });
});

describe("clampToolbarPosition (selection toolbar placement)", () => {
  const W = 640; // reader width; toolbar default width 300 (half = 150)

  it("keeps a centered selection unchanged", () => {
    const p = clampToolbarPosition(320, 200, W);
    expect(p.x).toBe(320);
    expect(p.y).toBe(200);
    expect(p.below).toBe(false);
  });

  it("clamps a left-edge selection so the toolbar's left half stays on screen", () => {
    // First word of a line → rawX ~10; with translateX(-50%) the toolbar would
    // spill off the left edge. x must be pushed to at least half the width.
    const p = clampToolbarPosition(10, 200, W);
    expect(p.x).toBe(150);
  });

  it("clamps a right-edge selection so the toolbar's right half stays on screen", () => {
    const p = clampToolbarPosition(635, 200, W);
    expect(p.x).toBe(W - 150); // 490
  });

  it("flips below the line when there is no room above (top of the reader)", () => {
    // rawY smaller than toolbar height (40) + gap (8) → flip below.
    const p = clampToolbarPosition(320, 5, W, { selectionHeight: 22 });
    expect(p.below).toBe(true);
    expect(p.y).toBe(5 + 22); // dropped below the selected line
  });

  it("centers the toolbar when the reader is narrower than the toolbar", () => {
    const p = clampToolbarPosition(10, 200, 200, { toolbarWidth: 300 });
    expect(p.x).toBe(100); // readerWidth / 2
  });
});

describe("clampPanelWidth (companion side panel)", () => {
  it("keeps a normal width unchanged", () => {
    expect(clampPanelWidth(320)).toBe(320);
  });
  it("floors at 200 and caps at 560", () => {
    expect(clampPanelWidth(100)).toBe(200);
    expect(clampPanelWidth(9000)).toBe(560);
  });
  it("falls back to the default on a non-finite value", () => {
    expect(clampPanelWidth(NaN)).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe("panelDragOutcome (slide-to-collapse)", () => {
  it("resizes within bounds while the drag stays at/above the minimum", () => {
    expect(panelDragOutcome(360)).toEqual({ kind: "resize", width: 360 });
    expect(panelDragOutcome(200)).toEqual({ kind: "resize", width: 200 });
    expect(panelDragOutcome(9000)).toEqual({ kind: "resize", width: 560 });
  });
  it("collapses once the divider is dragged past the minimum (slide closed)", () => {
    expect(panelDragOutcome(199)).toEqual({ kind: "collapse" });
    expect(panelDragOutcome(40)).toEqual({ kind: "collapse" });
    expect(panelDragOutcome(0)).toEqual({ kind: "collapse" });
  });
  it("collapses on a non-finite width rather than resizing", () => {
    expect(panelDragOutcome(NaN)).toEqual({ kind: "collapse" });
  });
});

describe("TextReader companion panel toggle", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("defaults to a clean column and the toolbar toggle shows/hides the margin (kept mounted)", async () => {
    mockBackend([note({ body: "my thought" })]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    // Wait for the section text + highlight to paint (effects settled). The
    // fixture text is the "quick brown fox" string, not Augustine.
    await waitFor(() => expect(container.querySelector("mark.tl-hl")).not.toBeNull());

    const spread = () => container.querySelector(".tl-spread") as HTMLElement;
    const rail = () => container.querySelector(".tl-margin-rail") as HTMLElement;
    // Default CLOSED: the rail is ALWAYS MOUNTED (its width/opacity animate to 0 in
    // CSS, never display:none — so a tutor stream survives), marked aria-hidden, the
    // inline highlight is still painted, and the toggle shows a count badge. The
    // card's editable body is mounted even while the rail is closed.
    expect(spread().getAttribute("data-margin")).toBe("closed");
    expect(rail().getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".tl-panelcount")?.textContent).toBe("1");
    expect(screen.getByDisplayValue("my thought")).toBeInTheDocument();

    // Toggle SHOWS it → the spread re-centers (data-margin="open") and the note's
    // editable body is visible.
    fireEvent.click(container.querySelector(".tl-paneltoggle")!);
    await waitFor(() => expect(spread().getAttribute("data-margin")).toBe("open"));
    expect(rail().getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByDisplayValue("my thought")).toBeInTheDocument();

    // Toggle HIDES it again — the card stays MOUNTED inside the closed rail, so a
    // tutor card's in-flight stream/answer is never lost or re-run on reopen.
    fireEvent.click(container.querySelector(".tl-paneltoggle")!);
    expect(spread().getAttribute("data-margin")).toBe("closed");
    expect(screen.getByDisplayValue("my thought")).toBeInTheDocument();
  });
});

describe("splitParagraphs (Gutenberg soft-wrap reflow)", () => {
  it("collapses intra-paragraph newlines to spaces and splits on blank lines", () => {
    expect(splitParagraphs("a\nb\n\nc\nd")).toEqual([
      { offset: 0, text: "a b" },
      { offset: 5, text: "c d" },
    ]);
  });

  it("is length-preserving so highlight/selection char offsets stay aligned", () => {
    const raw = "Great art Thou,\nO Lord."; // one soft-wrap newline
    const [p] = splitParagraphs(raw);
    expect(p.offset).toBe(0);
    expect(p.text).toBe("Great art Thou, O Lord."); // newline → single space
    expect(p.text.length).toBe(raw.length); // 1 char → 1 char
  });

  it("keeps the second paragraph's offset pointing into the original text", () => {
    const raw = "first\npara\n\nsecond para";
    const paras = splitParagraphs(raw);
    expect(paras[1].offset).toBe(raw.indexOf("second"));
    expect(paras[1].text).toBe("second para");
  });

  it("emits code (pre) ranges as NON-reflowed monospace paragraphs, prose around them reflows", () => {
    //            0123456789012345 6789012 3 456789012345
    const raw = "Before.\n\nline1\nline2\n\nAfter wrap\nhere";
    const code = { start: 9, end: 20 }; // "line1\nline2"
    expect(raw.slice(code.start, code.end)).toBe("line1\nline2");
    const paras = splitParagraphs(raw, [code]);
    // prose before reflows; code keeps its newline + is marked pre; prose after reflows.
    expect(paras).toEqual([
      { offset: 0, text: "Before." },
      { offset: 9, text: "line1\nline2", pre: true },
      { offset: 22, text: "After wrap here" },
    ]);
  });

  it("with no pre ranges behaves exactly like the prose splitter (back-compat)", () => {
    expect(splitParagraphs("a\nb\n\nc")).toEqual(splitParagraphs("a\nb\n\nc", []));
  });
});

describe("TextReader selection toolbar — Escape dismiss + a11y", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); localStorage.setItem("tl.panelOpen", "true"); });

  // Drive a real DOM selection over the rendered paragraph so the floating
  // toolbar appears, then assert Escape dismisses it. jsdom's getBoundingClientRect
  // returns zeros (fine — we only assert presence/absence, not geometry).
  async function selectInColumn(container: HTMLElement) {
    const p = container.querySelector("p[data-offset]") as HTMLElement;
    const main = container.querySelector(".tl-reader-main") as HTMLElement;
    // The first prose paragraph now opens with a small-caps OPENER span (book
    // convention), so the paragraph may be split into several text nodes. Walk to
    // the text node + local offset for paragraph-relative char 10 ("quick"), so
    // the selection is robust to the render-only opener slice.
    const at = (root: HTMLElement, target: number): { node: Text; offset: number } => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let seen = 0;
      let node = walker.nextNode() as Text | null;
      while (node) {
        const len = node.data.length;
        if (seen + len >= target) return { node, offset: target - seen };
        seen += len;
        node = walker.nextNode() as Text | null;
      }
      throw new Error("offset past end");
    };
    const startPt = at(p, 10); // "quick"
    const endPt = at(p, 15);
    const range = document.createRange();
    range.setStart(startPt.node, startPt.offset);
    range.setEnd(endPt.node, endPt.offset);
    // jsdom Ranges lack getBoundingClientRect; the toolbar geometry only needs a
    // rect-shaped object (we don't assert on coordinates).
    (range as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => ({ left: 100, top: 80, width: 40, height: 18, right: 140, bottom: 98, x: 100, y: 80, toJSON: () => {} } as DOMRect);
    const fakeSel = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "quick",
      removeAllRanges: () => {},
    };
    vi.spyOn(window, "getSelection").mockReturnValue(fakeSel as unknown as Selection);
    fireEvent.mouseUp(main);
  }

  it("shows the selection toolbar on selection and dismisses it on Escape", async () => {
    mockBackend([]);
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector("p[data-offset]")).not.toBeNull());

    await selectInColumn(container);
    const toolbar = await screen.findByRole("toolbar", { name: /Selection actions/i });
    expect(toolbar).toBeInTheDocument();
    // The Escape affordance is advertised to assistive tech.
    expect(toolbar).toHaveAttribute("aria-keyshortcuts", "Escape");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: /Selection actions/i })).toBeNull());
  });
});

describe("TextReader New-note modal — humanized position", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the chapter and a plain position, never a raw char: locator", async () => {
    mockBackend([]);
    // Resume mid-section so the modal's position is meaningfully non-zero:
    // char 320 of a 1000-char section → "32% in".
    const today = card();
    today.resume_locator = "char:320";
    today.resume_percent = 32;
    const { container } = render(<TextReader today={today} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    const modal = screen.getByRole("dialog");
    // Where the note lives, in reader words: the chapter + how far in.
    expect(modal.textContent).toContain("Chapter: Chapter 1");
    expect(modal.textContent).toContain("32% in");
    // The raw locator string is plumbing — it never reaches the reader.
    expect(modal.textContent).not.toMatch(/char:/);
    expect(modal.textContent).not.toMatch(/Locator/i);
  });
});

describe("TextReader New-note modal — save failure", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("says what happened inside the modal and stays open for retry", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section]);
        case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
        case "cmd_read_section_text": return Promise.resolve(TEXT);
        case "cmd_list_notes": return Promise.resolve([]);
        case "cmd_save_note": return Promise.reject({ kind: "Io", message: "Throughline can't save notes to this folder." });
        default: return Promise.resolve(undefined);
      }
    });
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.change(screen.getByPlaceholderText(/Paraphrase, reflection/i), { target: { value: "a thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    // The failure is said out loud, inside the modal…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Throughline can't save notes to this folder.");
    // …and the modal stays open with the reader's words intact, ready to retry.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByDisplayValue("a thought")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled();
  });
});

// FT-33: a failed section load must surface an honest, retryable error (never a
// blank column); a failed session start must NOT swallow a typed takeaway on
// "Save & finish".
describe("TextReader failed section load (FT-33)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows an honest in-column error with a Try again that re-reads the text", async () => {
    let attempts = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section]);
        case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
        case "cmd_read_section_text":
          attempts += 1;
          return attempts === 1
            ? Promise.reject({ message: "Throughline couldn't open this book's file." })
            : Promise.resolve(TEXT);
        case "cmd_list_notes": return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Throughline couldn't open this book's file.");

    // Try again re-invokes the read and, on success, paints the text.
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("TextReader failed session start keeps the takeaway (FT-33)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("saves the typed takeaway note even when the session failed to start", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section, section2]);
        case "cmd_start_session": return Promise.reject({ message: "Throughline couldn't start this session." });
        case "cmd_read_section_text": return Promise.resolve(TEXT);
        case "cmd_list_notes": return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    fireEvent.click(screen.getByRole("button", { name: /Add a takeaway/i }));
    fireEvent.change(screen.getByPlaceholderText(/Your one line/i), { target: { value: "the takeaway survives" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & finish/i }));

    await waitFor(() => {
      const call = vi.mocked(invoke).mock.calls.find(
        (c) => c[0] === "cmd_save_note" && (c[1] as { noteType?: string }).noteType === "Takeaway",
      );
      expect(call).toBeTruthy();
      const args = call![1] as { body: string; sessionId: string | null };
      expect(args.body).toBe("the takeaway survives");
      expect(args.sessionId).toBeNull();
    });
  });
});

describe("TextReader Deep Study — stale-section guard", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    localStorage.clear();
    localStorage.setItem("tl.panelOpen", "true");
    localStorage.setItem("tl.tutorEnabled", "true"); // consent given → briefing can auto-generate
  });

  const A_TEXT = "0123456789AAAA section one body text for the briefing.";
  const B_TEXT = "0123456789BBBB section two body text for the briefing.";

  function briefingCallsWith(snippet: string) {
    return vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "cmd_ai_ask"
        && (c[1] as { mode?: string }).mode === "section_briefing"
        && String((c[1] as { selection?: string }).selection ?? "").includes(snippet),
    );
  }

  it("never generates a briefing from section A's text after navigating to B", async () => {
    // Deferred section-text loads we resolve by hand to drive the race.
    let resolveA: (t: string) => void = () => {};
    let resolveB: (t: string) => void = () => {};
    const textPromises: Record<string, Promise<string>> = {
      s1: new Promise<string>((r) => { resolveA = r; }),
      s2: new Promise<string>((r) => { resolveB = r; }),
    };

    vi.mocked(invoke).mockImplementation((cmd: string, args?: any) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section, section2]);
        case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
        case "cmd_read_section_text": return textPromises[args.sectionId as string] ?? Promise.resolve("");
        case "cmd_list_notes": return Promise.resolve([]);
        case "cmd_get_settings": return Promise.resolve({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m", margin_help: "deep_study" });
        case "cmd_test_ai_connection": return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
        case "cmd_ai_ask": return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "localhost" });
        default: return Promise.resolve(undefined);
      }
    });

    // A merged sitting spanning both sections, so Next can reach section B.
    const today = card();
    today.sitting_end_locator = 2000;
    const { container } = render(<TextReader today={today} onExit={() => {}} />);

    // Section A's text resolves → it's now in state (textSectionId === s1).
    await act(async () => { resolveA(A_TEXT); });
    await waitFor(() => expect(briefingCallsWith("AAAA").length).toBe(1));

    // Navigate to B. B's text is still pending, so A's text is what's in `text`
    // state. The guard must prevent a briefing for B from using A's text.
    fireEvent.click(screen.getByRole("button", { name: /Next section/i }));
    // Give effects a tick; B's text has NOT resolved yet.
    await act(async () => { await Promise.resolve(); });
    // No briefing call carrying A's text was made for section B.
    const allBriefings = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "cmd_ai_ask" && (c[1] as { mode?: string }).mode === "section_briefing");
    expect(allBriefings.length).toBe(1); // still only the original A briefing
    expect(briefingCallsWith("AAAA").length).toBe(1);

    // Now B's text resolves → the briefing for B uses B's text, never A's.
    await act(async () => { resolveB(B_TEXT); });
    await waitFor(() => expect(briefingCallsWith("BBBB").length).toBe(1));
    // And A's text was never reused for a second (B) briefing.
    expect(briefingCallsWith("AAAA").length).toBe(1);
    expect(container).toBeTruthy();
  });
});

// ── Reading-page redesign: typographic hierarchy + stable centered layout ──
// The .txt path now emits the SAME shape as EPUB (clean text + StyleRanges); the
// reader must render those beautifully WITHOUT mutating offsets. These pin the
// behaviours the redesign promised: a heading renders with its h-class (still a
// p[data-offset], not a heading tag), em ranges become real <em>, the first prose
// paragraph carries the drop-cap hook, selection anchoring is intact, and the
// reading column's container is structurally identical with the margin open vs
// closed (no text-shift on toggle).
describe("TextReader reading-page redesign (structure rendering)", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); localStorage.clear(); });

  // "PREFACE." heading, a blank line, then a prose paragraph with an italic phrase.
  const STRUCT_TEXT = "PREFACE.\n\nNow this is the body, and a phrase in italics closes it.";
  const EM_PHRASE = "in italics";
  const emStart = STRUCT_TEXT.indexOf(EM_PHRASE);
  const ranges = [
    { kind: "h1", start: 0, end: "PREFACE.".length },               // covers the heading paragraph
    { kind: "em", start: emStart, end: emStart + EM_PHRASE.length }, // italic phrase in the prose
  ];

  function mockStructured() {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section]);
        case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
        case "cmd_read_section_text": return Promise.resolve(STRUCT_TEXT);
        case "cmd_read_section_structure": return Promise.resolve(ranges);
        case "cmd_list_notes": return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
  }

  it("renders an h1 range as a styled paragraph (h-class) that stays a p[data-offset]", async () => {
    mockStructured();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => {
      const head = container.querySelector("p.tl-h1");
      expect(head).not.toBeNull();
      expect(head!.textContent).toBe("PREFACE.");
    });
    // CRITICAL: it is still a <p data-offset> (never an <h1> tag), so the reader's
    // char-offset selection anchoring keeps working over the heading.
    const head = container.querySelector("p.tl-h1") as HTMLElement;
    expect(head.tagName).toBe("P");
    expect(head.getAttribute("data-offset")).toBe("0");
    // No literal heading tags are introduced anywhere in the column.
    expect(container.querySelector(".tl-readcol h1, .tl-readcol h2")).toBeNull();
  });

  it("renders an em range as a true <em> inside the prose paragraph", async () => {
    mockStructured();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    const em = await waitFor(() => {
      const node = container.querySelector(".tl-readcol em");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(em.textContent).toBe(EM_PHRASE);
  });

  it("gives the first PROSE paragraph the body-first class + a small-caps OPENER (never the heading)", async () => {
    mockStructured();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector("p.tl-body-first")).not.toBeNull());
    const first = container.querySelector("p.tl-body-first") as HTMLElement;
    // The opener lands on the body paragraph (offset of "Now"), not "PREFACE." (offset 0).
    expect(first.getAttribute("data-offset")).toBe(String(STRUCT_TEXT.indexOf("Now")));
    expect(first.textContent?.startsWith("Now")).toBe(true);
    // The opener is a RENDER-ONLY span (small caps) — it never changes the
    // paragraph's character count: the full text is intact and the offset unchanged.
    const opener = first.querySelector(".tl-opener") as HTMLElement;
    expect(opener).not.toBeNull();
    expect(first.textContent).toBe(STRUCT_TEXT.slice(STRUCT_TEXT.indexOf("Now"))); // offsets unchanged
    expect(opener.textContent?.length).toBeGreaterThan(0);
    expect(STRUCT_TEXT.slice(STRUCT_TEXT.indexOf("Now")).startsWith(opener.textContent!)).toBe(true);
    // The heading is NOT given the opener / body-first treatment.
    expect(container.querySelector("p.tl-h1.tl-body-first")).toBeNull();
    expect(container.querySelector("p.tl-h1 .tl-opener")).toBeNull();
    // Exactly one paragraph opens with the small-caps opener.
    expect(container.querySelectorAll("p.tl-body-first").length).toBe(1);
    expect(container.querySelectorAll(".tl-opener").length).toBe(1);
  });

  it("keeps p[data-offset] selection anchoring intact (offsets unchanged by styling)", async () => {
    mockStructured();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector("p.tl-h1")).not.toBeNull());
    // Every rendered paragraph still exposes its exact section-relative offset.
    const offsets = [...container.querySelectorAll("p[data-offset]")].map((p) => p.getAttribute("data-offset"));
    expect(offsets).toContain("0");                                   // the heading
    expect(offsets).toContain(String(STRUCT_TEXT.indexOf("Now")));    // the prose
    // The prose paragraph's full text is intact (em styling sliced, never rewrote it).
    const prose = container.querySelector(`p[data-offset="${STRUCT_TEXT.indexOf("Now")}"]`) as HTMLElement;
    expect(prose.textContent).toBe(STRUCT_TEXT.slice(STRUCT_TEXT.indexOf("Now")));
  });

  it("centers the sheet + margin as one spread, the same way open vs closed (no reserved gutter)", async () => {
    mockStructured();
    const { container, rerender } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")).not.toBeNull());

    // THE SPREAD is the centering container (justify-content:center in CSS); the
    // sheet + margin rail center as a unit. Closed (default): data-margin="closed".
    const spreadClosed = container.querySelector(".tl-spread") as HTMLElement;
    expect(spreadClosed).not.toBeNull();
    expect(spreadClosed.getAttribute("data-margin")).toBe("closed");
    // NO reserved-gutter var anywhere — the centering is automatic, not measured.
    expect(container.querySelector("[style*='--tl-margin-reserve']")).toBeNull();
    // The sheet holds the reading column; the rail is mounted as a sibling inside
    // the spread (always present so a tutor stream survives a close).
    expect(container.querySelector(".tl-spread .tl-sheet .tl-readcol")).not.toBeNull();
    expect(container.querySelector(".tl-spread .tl-margin-rail")).not.toBeNull();
    // The reading column lives inside .tl-reader-main (the scroll/desk host) — the
    // same DOM seat in both states (so no overflow onto the desk, no reparenting).
    expect(container.querySelector(".tl-reader-main .tl-readcol")).not.toBeNull();

    // Open the margin via the toolbar toggle → the SAME spread re-centers (the rail
    // animates its flex-basis; no reserved gutter is introduced).
    fireEvent.click(container.querySelector(".tl-paneltoggle")!);
    await waitFor(() => expect((container.querySelector(".tl-spread") as HTMLElement).getAttribute("data-margin")).toBe("open"));
    const spreadOpen = container.querySelector(".tl-spread") as HTMLElement;
    expect(spreadOpen).toBe(spreadClosed); // same node — not reparented, just re-attributed
    expect(container.querySelector("[style*='--tl-margin-reserve']")).toBeNull();
    // The column still sits in the same .tl-reader-main seat (not reparented).
    expect(container.querySelector(".tl-reader-main .tl-sheet .tl-readcol")).not.toBeNull();
    rerender(<TextReader today={card()} onExit={() => {}} />);
  });
});

// ── Book typography: the full front-matter vocabulary renders as CSS classes on
// p[data-offset] (never a heading tag), and a run of contents-item paragraphs is
// wrapped in a 2-column container that keeps each child reachable + offset-exact.
describe("TextReader book typography (front-matter vocabulary)", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); localStorage.clear(); });

  // A Walden-shaped section: title page, contents (label/part/2 items), epigraph,
  // chapter opening (label + title), then the first body paragraph. Each block is
  // exactly one paragraph; its StyleRange covers its [start,end).
  const BLOCKS = [
    { kind: "title", text: "WALDEN" },
    { kind: "subtitle", text: "and" },                               // lone connective
    { kind: "subtitle", text: "ON THE DUTY OF CIVIL DISOBEDIENCE" },
    { kind: "byline", text: "by Henry David Thoreau" },
    { kind: "contents-label", text: "Contents" },
    { kind: "contents-part", text: "WALDEN" },
    { kind: "contents-item", text: "Economy" },
    { kind: "contents-item", text: "Where I Lived, and What I Lived For" },
    { kind: "epigraph", text: "I do not propose to write an ode to dejection." },
    { kind: "chapter-label", text: "BOOK I" },
    { kind: "chapter-title", text: "Economy" },
    { kind: "body-first", text: "When I wrote the following pages I lived alone in the woods." },
  ];
  // Build the section text (blocks separated by a blank line) and the ranges.
  const TY_TEXT = BLOCKS.map((b) => b.text).join("\n\n");
  const TY_RANGES = (() => {
    const ranges: { kind: string; start: number; end: number }[] = [];
    let cursor = 0;
    for (const b of BLOCKS) {
      const start = TY_TEXT.indexOf(b.text, cursor);
      ranges.push({ kind: b.kind, start, end: start + b.text.length });
      cursor = start + b.text.length;
    }
    return ranges;
  })();
  function offsetOf(text: string) { return String(TY_TEXT.indexOf(text)); }

  function mockTypography() {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_assignable_sections": return Promise.resolve([section]);
        case "cmd_start_session": return Promise.resolve({ id: "sess1", book_id: "b1", started_at: "", ended_at: null, start_locator: "char:0", end_locator: null, minutes: null, completed_assignment: false, subjective_difficulty: null });
        case "cmd_read_section_text": return Promise.resolve(TY_TEXT);
        case "cmd_read_section_structure": return Promise.resolve(TY_RANGES);
        case "cmd_list_notes": return Promise.resolve([]);
        default: return Promise.resolve(undefined);
      }
    });
  }

  it("renders each front-matter role with its class on a p[data-offset] (never a heading tag)", async () => {
    mockTypography();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector("p.tl-tp-title")).not.toBeNull());

    // The exact role→class map the backend's emission must match (kind → selector).
    const expectations: Array<[string, string]> = [
      ["title", ".tl-tp-title"],
      ["byline", ".tl-tp-byline"],
      ["contents-label", ".tl-toc-label"],
      ["contents-part", ".tl-toc-part"],
      ["epigraph", ".tl-epigraph"],
      ["chapter-label", ".tl-ch-label"],
      ["chapter-title", ".tl-ch-title"],
    ];
    for (const [kind, sel] of expectations) {
      const el = container.querySelector(`p${sel}`) as HTMLElement;
      expect(el, `${kind} → ${sel} should render`).not.toBeNull();
      expect(el.tagName).toBe("P"); // never an <h1>/<h2> tag — anchoring stays exact
      expect(el.getAttribute("data-offset")).not.toBeNull();
    }
    // No literal heading tags introduced anywhere in the column.
    expect(container.querySelector(".tl-readcol h1, .tl-readcol h2, .tl-readcol h3")).toBeNull();
  });

  it("styles the lone lowercase connective ('and') as the italic connector, not a subtitle", async () => {
    mockTypography();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector("p.tl-tp-title")).not.toBeNull());
    // Both subtitle paragraphs carry tl-tp-subtitle; only the lone "and" also gets
    // tl-tp-and (the connector). The real subtitle does NOT.
    const and = container.querySelector(`p[data-offset="${offsetOf("and")}"]`) as HTMLElement;
    const realSub = container.querySelector(`p[data-offset="${offsetOf("ON THE DUTY OF CIVIL DISOBEDIENCE")}"]`) as HTMLElement;
    expect(and.classList.contains("tl-tp-subtitle")).toBe(true);
    expect(and.classList.contains("tl-tp-and")).toBe(true);
    expect(realSub.classList.contains("tl-tp-subtitle")).toBe(true);
    expect(realSub.classList.contains("tl-tp-and")).toBe(false);
  });

  it("wraps consecutive contents-item paragraphs in a 2-column container that keeps each child a p[data-offset]", async () => {
    mockTypography();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-toc-cols")).not.toBeNull());
    const cols = container.querySelector(".tl-toc-cols") as HTMLElement;
    // The grouping wrapper lives INSIDE the reading column (book-typography invariant).
    expect(cols.closest(".tl-readcol")).not.toBeNull();
    // Both items are p[data-offset] children of the wrapper, offsets exact + reachable.
    const items = cols.querySelectorAll("p.tl-toc-item[data-offset]");
    expect(items.length).toBe(2);
    expect(items[0].getAttribute("data-offset")).toBe(offsetOf("Economy"));
    // closest('p[data-offset]') from inside an item resolves to the item itself —
    // the selection-anchoring path the golden loop depends on still works.
    const inner = items[1].firstChild as Node;
    expect((inner.parentElement as HTMLElement).closest("p[data-offset]")).toBe(items[1]);
  });

  it("gives the body-first paragraph the small-caps OPENER as a render-only slice (offset unchanged)", async () => {
    mockTypography();
    const { container } = render(<TextReader today={card()} onExit={() => {}} />);
    const bodyText = "When I wrote the following pages I lived alone in the woods.";
    await waitFor(() => expect(container.querySelector("p.tl-body-first")).not.toBeNull());
    const body = container.querySelector("p.tl-body-first") as HTMLElement;
    expect(body.getAttribute("data-offset")).toBe(offsetOf(bodyText));
    // The opener span exists and is render-only: the paragraph's full text is
    // intact (no char added/lost) and the offset is unchanged.
    const opener = body.querySelector(".tl-opener") as HTMLElement;
    expect(opener).not.toBeNull();
    expect(body.textContent).toBe(bodyText);
    expect(bodyText.startsWith(opener.textContent!)).toBe(true);
  });
});

describe("firstProseDropCapOffset (drop cap lands on the first prose paragraph)", () => {
  it("returns the first non-heading, non-blank, non-code paragraph's offset", () => {
    const paras = [
      { offset: 0, text: "PREFACE." },
      { offset: 10, text: "Now the body opens here." },
      { offset: 40, text: "A second paragraph." },
    ];
    const ranges = [{ kind: "h1", start: 0, end: 8 }];
    expect(firstProseDropCapOffset(paras, ranges)).toBe(10);
  });

  it("skips a leading blockquote and code (pre) blocks", () => {
    const paras = [
      { offset: 0, text: "An epigraph quote.", },
      { offset: 30, text: "code\nlisting", pre: true },
      { offset: 60, text: "The real first prose." },
    ];
    const ranges = [{ kind: "blockquote", start: 0, end: 18 }];
    expect(firstProseDropCapOffset(paras, ranges)).toBe(60);
  });

  it("skips a marker/blank line with no word character", () => {
    const paras = [
      { offset: 0, text: "* * *" },
      { offset: 10, text: "First true prose." },
    ];
    expect(firstProseDropCapOffset(paras, [])).toBe(10);
  });

  it("returns null when there is no prose yet", () => {
    expect(firstProseDropCapOffset([], [])).toBeNull();
    expect(firstProseDropCapOffset([{ offset: 0, text: "TITLE" }], [{ kind: "h1", start: 0, end: 5 }])).toBeNull();
  });

  // Regression (v0.4.5): a Gutenberg front-matter page whose title/byline/TOC the
  // heading detector did NOT catch must still not get a drop cap on "WALDEN" — the
  // cap belongs on the first real sentence, several blocks down.
  it("skips an undetected all-caps title, byline, and table-of-contents row", () => {
    const paras = [
      { offset: 0, text: "WALDEN" }, // all caps, no heading range → must be skipped
      { offset: 10, text: "and" },
      { offset: 20, text: "by Henry David Thoreau" }, // byline: no sentence ending
      { offset: 50, text: "Contents" }, // one-word label
      { offset: 70, text: "Economy Where I Lived The Ponds Baker Farm Spring Conclusion" }, // TOC row: no ending punct
      { offset: 140, text: "When I wrote the following pages, I lived alone in the woods." },
    ];
    expect(firstProseDropCapOffset(paras, [])).toBe(140);
  });
});

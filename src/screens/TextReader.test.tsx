import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import TextReader, { clampToolbarPosition, clampPanelWidth, panelDragOutcome, DEFAULT_PANEL_WIDTH, splitParagraphs } from "./TextReader";
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

function card(): TodayCard {
  return {
    book: { id: "b1", title: "Test Book", author: null, source_type: "txt", source_path: "", source_sha256: "x", created_at: "2026-05-29", last_opened_at: null },
    plan: { id: "p1", book_id: "b1", start_date: "2026-05-01", target_finish_date: "2026-06-01", daily_target_units: 1, days_per_week: 5, catchup_mode: "gentle", status: "active", activated_at: "2026-05-01T08:00:00Z", original_finish_date: null },
    section,
    section_completed: false,
    estimated_minutes: 10,
    session_minutes: 25,
    monthly_pct: 5,
    pace: { kind: "on_pace" },
    day_index: 1,
    total_days: 30,
    streak: { days_read_last_7: 1, minutes_last_7: 10 },
    recovery: null,
    resume_locator: null,
    resume_percent: null,
    plan_status: "active",
    forecast: { state: "on_track", projected_finish_date: "2026-05-30", days_late: 0 },
    memory: { last_capture: null, highlight_count: 0, note_count: 0 },
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

  it("full session: shows a recap with stat counts and a next-section preview", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} mode="full" onExit={() => {}} />);
    // Wait until the section text has loaded (effects settled) before interacting.
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // Full mode's close button reads "Finish".
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    // It's a recap, not a thin dialog: titled "Session recap" with stat tiles…
    expect(screen.getByText("Session recap")).toBeInTheDocument();
    expect(screen.getByText("min read")).toBeInTheDocument();
    // Recap stat tile label is exactly "highlight"/"highlights" (the panel's
    // empty-state hint also contains the word "highlight", so match the tile).
    expect(screen.getByText(/^highlights?$/)).toBeInTheDocument();
    expect(screen.getByText(/tutor card/)).toBeInTheDocument();
    // …and a concrete next-section preview (Chapter 2 is the section after day-1).
    expect(screen.getByText(/Next time/)).toBeInTheDocument();
    expect(screen.getByText("Chapter 2")).toBeInTheDocument();
    // Full mode is NOT framed as a rescue.
    expect(screen.queryByText("That counts")).toBeNull();
  });

  it("persists the recap takeaway as a durable Takeaway note (feeds notebook + Today memory)", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} mode="full" onExit={() => {}} />);
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
    const { container } = render(<TextReader today={card()} mode="full" onExit={() => {}} />);
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

  it("rescue session: keeps the 'That counts' framing and never forces completion", async () => {
    mockTwoSections();
    const { container } = render(<TextReader today={card()} mode="rescue" onExit={() => {}} />);
    await waitFor(() => expect(container.querySelector(".tl-readcol")?.textContent).toContain("quick"));

    // Rescue mode's close button reads "Done"; the recap header says "That counts".
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("That counts")).toBeInTheDocument();
    expect(screen.getByText(/You stayed connected to the book/)).toBeInTheDocument();
    // The primary action affirms the short sitting; it never demands completion.
    expect(screen.getByRole("button", { name: /That counts — done/ })).toBeInTheDocument();
    expect(screen.queryByText("Session recap")).toBeNull();
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

    const aside = () => container.querySelector(".tl-sidepanel") as HTMLElement | null;
    // Default CLOSED: the margin is MOUNTED but hidden (no layout space, display:none),
    // the inline highlight is still painted, and the toggle shows a count badge.
    expect(aside()!.style.display).toBe("none");
    expect(container.querySelector(".tl-panelcount")?.textContent).toBe("1");

    // Toggle SHOWS it → the note's editable body is visible.
    fireEvent.click(container.querySelector(".tl-paneltoggle")!);
    await waitFor(() => expect(aside()!.style.display).not.toBe("none"));
    expect(screen.getByDisplayValue("my thought")).toBeInTheDocument();

    // Toggle HIDES it again — but the card stays MOUNTED inside the hidden margin,
    // so a tutor card's in-flight stream/answer is never lost or re-run on reopen.
    fireEvent.click(container.querySelector(".tl-paneltoggle")!);
    expect(aside()!.style.display).toBe("none");
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
    const textNode = p.firstChild as Text; // "0123456789quick brown…"
    const range = document.createRange();
    range.setStart(textNode, 10); // "quick"
    range.setEnd(textNode, 15);
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
        case "cmd_get_settings": return Promise.resolve({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m", ai_local_only: true, margin_help: "deep_study" });
        case "cmd_test_ai_connection": return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
        case "cmd_ai_ask": return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "localhost" });
        default: return Promise.resolve(undefined);
      }
    });

    const { container } = render(<TextReader today={card()} mode="full" onExit={() => {}} />);

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

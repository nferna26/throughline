import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, act, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Tauri surface mocks ──────────────────────────────────────────────────────
// App talks to: core (invoke), plugin-dialog (file picker), event (tl-activate
// deep link), and webview (drag-and-drop). The webview mock captures the
// registered drag-drop handler so tests can drive an OS file drop directly.
const mocks = vi.hoisted(() => {
  const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null));
  type DragEvent = { payload: { type: string; paths?: string[] } };
  const dragHandlers: Array<(e: DragEvent) => void | Promise<void>> = [];
  const appShow = vi.fn(() => Promise.resolve());
  const windowShow = vi.fn(() => Promise.resolve());
  const unminimize = vi.fn(() => Promise.resolve());
  const setFocus = vi.fn(() => Promise.resolve());
  return { invoke, dragHandlers, appShow, windowShow, unminimize, setFocus };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: ((e: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (e: { payload: { type: string; paths?: string[] } }) => void) => {
      mocks.dragHandlers.push(h);
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("0.4.3"),
  show: mocks.appShow,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: mocks.windowShow,
    unminimize: mocks.unminimize,
    setFocus: mocks.setFocus,
  }),
}));

import App, { handleDroppedPaths, importErrorText } from "./App";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "./types";
import type { TodayCard, LibraryEntry } from "./types";

const BOOK = {
  id: "b1",
  title: "Confessions",
  author: "Augustine",
  source_type: "epub",
  source_path: "/x/source.epub",
  source_sha256: "sha",
  created_at: "2026-06-09",
  last_opened_at: null,
};

// A library shelf entry for the switcher (which now reads cmd_library).
function libEntry(book: typeof BOOK, over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: book.id, title: book.title, author: book.author, provenance: "imported", has_cover: false,
    finished: false, fraction: 0.2, location: "Chapter 1", last_opened_at: book.last_opened_at, is_active: false, ...over,
  };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  mocks.dragHandlers.length = 0;
  mocks.appShow.mockClear();
  mocks.windowShow.mockClear();
  mocks.unminimize.mockClear();
  mocks.setFocus.mockClear();
});

// ── The drop helper: same import + dedup path as the file picker ────────────
describe("handleDroppedPaths", () => {
  it("imports the first .txt/.epub via cmd_import_book (the picker's path)", async () => {
    const outcome = { book: BOOK, created: true };
    mocks.invoke.mockResolvedValueOnce(outcome);
    const r = await handleDroppedPaths(["/tmp/confessions.EPUB"]);
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_import_book", { path: "/tmp/confessions.EPUB" });
    expect(r).toEqual({ kind: "imported", outcome });
  });

  it("refuses other file types with a calm message and never invokes", async () => {
    const r = await handleDroppedPaths(["/tmp/notes.pdf", "/tmp/cover.jpg"]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") {
      expect(r.message).toMatch(/\.txt and DRM-free \.epub/i);
    }
  });

  it("an empty drop is a silent no-op", async () => {
    expect(await handleDroppedPaths([])).toEqual({ kind: "none" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("surfaces a human message when the import is refused (e.g. DRM)", async () => {
    mocks.invoke.mockRejectedValueOnce({
      kind: "Io",
      message: "import failed: this EPUB looks DRM-protected (encryption.xml or rights.xml is present).",
    });
    const r = await handleDroppedPaths(["/tmp/locked.epub"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/DRM-protected/);
    }
  });
});

// ── The import alert: always a human sentence, never raw JSON ───────────────
describe("importErrorText", () => {
  it("routes a message-less AppError through errorMessage — no {\"kind\"…} JSON", () => {
    const e = { kind: "NotFound", resource: "book", id: null };
    expect(importErrorText(e)).toBe(`Import failed: ${errorMessage(e)}`);
    expect(importErrorText(e)).toBe("Import failed: book not found");
    // The old JSON.stringify fallback would have leaked this shape:
    expect(JSON.stringify(e)).toContain('{"kind"');
    expect(importErrorText(e)).not.toContain('{"kind"');
  });

  it("keeps the backend's human message when one exists", () => {
    const e = { kind: "Io", message: "this EPUB looks DRM-protected." };
    expect(importErrorText(e)).toBe("Import failed: this EPUB looks DRM-protected.");
  });
});

// ── App wiring: a real drop routes like a picker import ─────────────────────
// An override may be a value (resolved) or a thunk (called — lets a test make
// a command reject).
function setAppImpl(overrides: Record<string, unknown> = {}) {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd in overrides) {
      const v = overrides[cmd];
      return typeof v === "function" ? (v as () => Promise<unknown>)() : Promise.resolve(v);
    }
    switch (cmd) {
      case "cmd_today":
        return Promise.resolve(null);
      case "cmd_check_export_path":
        return Promise.resolve({ path: "/tmp/x", writable: true, message: null });
      case "cmd_assignable_sections":
        return Promise.resolve([]);
      case "cmd_get_reading_pace":
        // Default: the reader has not chosen a pace yet, so the chosen → pace
        // step asks (the first-journey flow). Overridable per test.
        return Promise.resolve({ minutes: 25, chosen: false });
      default:
        return Promise.resolve(null);
    }
  });
}

describe("App drag-and-drop import", () => {
  it("registers a drag-drop listener and routes a new book to the Book Setup Sheet", async () => {
    setAppImpl({ cmd_import_book: { book: BOOK, created: true } });
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    await waitFor(() => expect(mocks.dragHandlers.length).toBeGreaterThan(0));

    await act(async () => {
      await mocks.dragHandlers[0]({ payload: { type: "drop", paths: ["/tmp/confessions.epub"] } });
    });

    // The book-chosen → pace step (same as the picker's created:true path).
    expect(await screen.findByText("Added to Today")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Confessions is yours to begin/ })).toBeInTheDocument();
  });

  it("shows the calm notice (not silence) for an unsupported drop", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    await waitFor(() => expect(mocks.dragHandlers.length).toBeGreaterThan(0));

    await act(async () => {
      await mocks.dragHandlers[0]({ payload: { type: "drop", paths: ["/tmp/notes.pdf"] } });
    });

    expect(await screen.findByText(/\.txt and DRM-free \.epub/i)).toBeInTheDocument();
  });

  it("ignores non-drop drag events (enter/over/leave)", async () => {
    setAppImpl();
    render(<App />);
    await waitFor(() => expect(mocks.dragHandlers.length).toBeGreaterThan(0));
    await act(async () => {
      await mocks.dragHandlers[0]({ payload: { type: "enter", paths: ["/tmp/a.epub"] } });
      await mocks.dragHandlers[0]({ payload: { type: "leave" } });
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_import_book", expect.anything());
  });
});

// ── First-run back-nav UNDO (CORE-1142) — the created-by-this-pick guard ─────
// Back on the chosen screen is an undo, not a confirmed delete: it removes the
// book ONLY when this pick is what created it. The guard lives at App's call
// site (exitSetup), never in cmd_delete_book.
describe("App first-run back-nav undo", () => {
  const NO_PLAN_FOR = (book: typeof BOOK): TodayCard => ({
    book,
    plan: { id: "p", book_id: book.id, start_date: "2026-06-01", status: "no_plan", activated_at: null, sitting_length_minutes: null },
    state: "no_plan", chapter_label: "Reading", phrase: null, estimated_minutes: 0,
    fraction_complete: 0, next_label: null, section: null, sitting_start_locator: null,
    sitting_end_locator: null, resume_locator: null, resume_percent: null,
    memory: { last_capture: null, highlight_count: 0, note_count: 0 }, teaser: null,
  });

  it("Back on a freshly-picked book deletes it (undo) and returns to the front door", async () => {
    setAppImpl({
      cmd_import_book: { book: BOOK, created: true },
      cmd_today: () => Promise.resolve(null), // empty library before and after the undo
      cmd_delete_book: () => Promise.resolve(null),
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    await waitFor(() => expect(mocks.dragHandlers.length).toBeGreaterThan(0));
    await act(async () => {
      await mocks.dragHandlers[0]({ payload: { type: "drop", paths: ["/tmp/confessions.epub"] } });
    });
    // On the chosen screen now; Back is the undo.
    await screen.findByText("Added to Today");
    await user.click(screen.getByRole("button", { name: /^Back/ }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_delete_book", { bookId: "b1" }));
    expect(await screen.findByText(/Begin with a book you mean to finish/i)).toBeInTheDocument();
  });

  it("Back out of a NEW plan for an existing book never deletes it", async () => {
    setAppImpl({
      cmd_today: NO_PLAN_FOR(BOOK),
      cmd_start_new_plan: () => Promise.resolve(null),
    });
    const user = userEvent.setup();
    render(<App />);
    // The plan-less book offers "Start a plan" → a setup with createdByThisPick=false.
    await user.click(await screen.findByRole("button", { name: "Start a plan" }));
    await screen.findByText("Added to Today");
    await user.click(screen.getByRole("button", { name: /^Back/ }));

    // Returned to Today, and the pre-existing book was NOT removed.
    expect(await screen.findByRole("button", { name: "Start a plan" })).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
  });
});

// ── Remove from library, two confirmations + a brief undo (CORE-1093 / §3) ────
describe("App remove-from-library", () => {
  const NO_PLAN_FOR = (book: typeof BOOK): TodayCard => ({
    book,
    plan: { id: "p", book_id: book.id, start_date: "2026-06-01", status: "no_plan", activated_at: null, sitting_length_minutes: null },
    state: "no_plan", chapter_label: "Reading", phrase: null, estimated_minutes: 0,
    fraction_complete: 0, next_label: null, section: null, sitting_start_locator: null,
    sitting_end_locator: null, resume_locator: null, resume_percent: null,
    memory: { last_capture: null, highlight_count: 0, note_count: 0 }, teaser: null,
  });
  // Open the switcher, right-click the named book's row, and choose "Remove from
  // library" from the calm context menu — the §2 path to Remove.
  async function rightClickRemove(user: ReturnType<typeof userEvent.setup>, rowName: string) {
    const chip = await screen.findByRole("button", { name: /Confessions/, expanded: false });
    await user.click(chip);
    const row = await screen.findByRole("button", { name: rowName });
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    await user.click(await screen.findByRole("menuitem", { name: "Remove from library" }));
  }

  it("requires a source-specific confirm and offers a brief undo (delete deferred)", async () => {
    setAppImpl({
      cmd_today: () => Promise.resolve(NO_PLAN_FOR(BOOK)),
      cmd_list_books: () => Promise.resolve([BOOK]),
      cmd_library: () => Promise.resolve([libEntry(BOOK, { is_active: true })]),
    });
    const user = userEvent.setup();
    render(<App />);
    await rightClickRemove(user, "Confessions, Augustine, reading");
    // Imported confirmation names the real loss; nothing deleted before confirm.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/tutor history for it will be deleted/)).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    // The book is hidden behind a brief undo; the hard delete is NOT immediate.
    expect(await screen.findByText("Confessions removed from your library.")).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
  });

  it("Undo within the window keeps the book and never deletes", async () => {
    setAppImpl({
      cmd_today: () => Promise.resolve(NO_PLAN_FOR(BOOK)),
      cmd_list_books: () => Promise.resolve([BOOK]),
      cmd_library: () => Promise.resolve([libEntry(BOOK, { is_active: true })]),
    });
    const user = userEvent.setup();
    render(<App />);
    await rightClickRemove(user, "Confessions, Augustine, reading");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.queryByText("Confessions removed from your library.")).toBeNull());
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
  });

  it("removing the active book drops Today onto the next book (never stranded)", async () => {
    let activeId = "b1";
    setAppImpl({
      cmd_today: () => Promise.resolve(activeId === "b1" ? NO_PLAN_FOR(BOOK) : NO_PLAN_FOR(BOOK2)),
      cmd_list_books: () => Promise.resolve([BOOK, BOOK2]),
      cmd_library: () => Promise.resolve([libEntry(BOOK, { is_active: true }), libEntry(BOOK2, {})]),
      cmd_set_active_book: () => { activeId = "b2"; return Promise.resolve(null); },
    });
    const user = userEvent.setup();
    render(<App />);
    await rightClickRemove(user, "Confessions, Augustine, reading");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Confessions removed from your library.")).toBeInTheDocument();
    // Today now points at the remaining book, not the one mid-removal.
    expect(await screen.findByRole("button", { name: /Middlemarch/, expanded: false })).toBeInTheDocument();
  });

  it("Keep it dismisses the confirm without removing", async () => {
    setAppImpl({
      cmd_today: () => Promise.resolve(NO_PLAN_FOR(BOOK)),
      cmd_list_books: () => Promise.resolve([BOOK]),
      cmd_library: () => Promise.resolve([libEntry(BOOK, { is_active: true })]),
    });
    const user = userEvent.setup();
    render(<App />);
    await rightClickRemove(user, "Confessions, Augustine, reading");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Confessions removed from your library.")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_delete_book", expect.anything());
  });

  it("commits the hard delete after the undo window elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let deleted = false;
      setAppImpl({
        cmd_today: () => Promise.resolve(deleted ? null : NO_PLAN_FOR(BOOK)),
        cmd_list_books: () => Promise.resolve(deleted ? [] : [BOOK]),
        cmd_library: () => Promise.resolve(deleted ? [] : [libEntry(BOOK, { is_active: true })]),
        cmd_delete_book: () => { deleted = true; return Promise.resolve(null); },
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<App />);
      await rightClickRemove(user, "Confessions, Augustine, reading");
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
      await screen.findByText("Confessions removed from your library.");
      await act(async () => { await vi.advanceTimersByTimeAsync(8200); });
      await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_delete_book", { bookId: "b1" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App update-relaunch focus handoff", () => {
  it("does not focus the window on a normal cold launch", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);

    expect(mocks.invoke).toHaveBeenCalledWith("cmd_consume_update_relaunch_focus");
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_focus_main_window_after_update_relaunch");
    expect(mocks.appShow).not.toHaveBeenCalled();
    expect(mocks.windowShow).not.toHaveBeenCalled();
    expect(mocks.unminimize).not.toHaveBeenCalled();
    expect(mocks.setFocus).not.toHaveBeenCalled();
  });

  it("brings the fresh process forward after an updater-driven relaunch", async () => {
    setAppImpl({ cmd_consume_update_relaunch_focus: true });
    render(<App />);

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_focus_main_window_after_update_relaunch"),
    );
    expect(mocks.appShow).not.toHaveBeenCalled();
    expect(mocks.windowShow).not.toHaveBeenCalled();
    expect(mocks.unminimize).not.toHaveBeenCalled();
    expect(mocks.setFocus).not.toHaveBeenCalled();
  });
});

// ── Failed commands speak through the in-app banner (CORE-1041) ─────────────
// window.alert() is a dead channel in the shipped build — the pinned wry's
// WKWebView delegate implements no alert panel, so alert() is silently dropped.
// These errors must land in the same dismissable role="alert" banner the
// drag-drop path already uses, or the reader sees nothing at all.
const BOOK2 = { ...BOOK, id: "b2", title: "Middlemarch", author: "George Eliot" };

const NO_PLAN_TODAY: TodayCard = {
  book: BOOK,
  plan: {
    id: "p1",
    book_id: BOOK.id,
    start_date: "2026-06-01",
    status: "completed",
    activated_at: null,
    sitting_length_minutes: null,
  },
  state: "no_plan",
  chapter_label: "Reading",
  phrase: null,
  estimated_minutes: 0,
  fraction_complete: 0,
  next_label: null,
  section: null,
  sitting_start_locator: null,
  sitting_end_locator: null,
  resume_locator: null,
  resume_percent: null,
  memory: { last_capture: null, highlight_count: 0, note_count: 0 },
  teaser: null,
};

describe("App command failures use the in-app banner (CORE-1041)", () => {
  it("a failed picker import shows the import error, dismissable with OK", async () => {
    setAppImpl({
      cmd_import_book: () =>
        Promise.reject({ kind: "Drm", message: "this EPUB looks DRM-protected." }),
    });
    vi.mocked(openDialog).mockResolvedValueOnce("/tmp/locked.epub");
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /Import a \.txt or \.epub/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Import failed: this EPUB looks DRM-protected.");
    // The reader can put it away.
    await userEvent.click(within(banner).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failed book switch says so in the banner", async () => {
    setAppImpl({
      cmd_today: NO_PLAN_TODAY,
      cmd_list_books: [BOOK, BOOK2],
      cmd_library: [libEntry(BOOK, { is_active: true }), libEntry(BOOK2, {})],
      cmd_set_active_book: () =>
        Promise.reject({ kind: "NotFound", resource: "book", id: null }),
    });
    render(<App />);

    // Open the book switcher and pick the other book.
    await userEvent.click(await screen.findByTitle("Switch book"));
    await userEvent.click(await screen.findByRole("button", { name: /Middlemarch/ }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Could not switch book: book not found");
  });

  it("a failed new plan says so in the banner", async () => {
    setAppImpl({
      cmd_today: NO_PLAN_TODAY,
      cmd_start_new_plan: () =>
        Promise.reject({ kind: "Io", message: "could not write to the reading database." }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /Start a plan/i }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(
      "Could not start a new plan: could not write to the reading database."
    );
  });
});

// ── Brand mark in the titlebar ──────────────────────────────────────────────
// FT-14: the Throughline "T" sits beside the wordmark. It's decorative
// (aria-hidden) since the brand button already carries the accessible name, so
// we assert on the button + the inline SVG mark rather than a second label.
describe("titlebar brand mark", () => {
  it("renders the Throughline T beside the wordmark in the home button", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);

    const brand = screen.getByRole("button", { name: /Throughline — home/i });
    expect(brand).toHaveTextContent(/Throughline/i);

    const mark = brand.querySelector("svg.tl-brand-mark");
    expect(mark).not.toBeNull();
    // Decorative: hidden from AT so the name isn't announced twice.
    expect(mark).toHaveAttribute("aria-hidden", "true");
    // Drawn in currentColor so it picks up the accent (forest/sage) we set.
    expect(mark).toHaveAttribute("fill", "currentColor");
  });
});

// ── Global keyboard shortcuts (Settings › Shortcuts is their reference) ─────
describe("global keyboard shortcuts", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("⌘, opens Settings", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    // The Settings rail is on screen.
    expect(
      await screen.findByRole("navigation", { name: /settings sections/i }),
    ).toBeInTheDocument();
  });

  it("⌘⇧L flips the resolved theme and persists the explicit choice", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("tl.themePref")).toBe("dark");
    fireEvent.keyDown(window, { key: "L", metaKey: true, shiftKey: true });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  });

  it("⌘+ / ⌘− nudge the shared reading text size within its clamp", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    fireEvent.keyDown(window, { key: "=", metaKey: true });
    expect(localStorage.getItem("tl.fontSize")).toBe("19");
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(localStorage.getItem("tl.fontSize")).toBe("18");
  });

  it("the legacy tl.theme value survives the redesign (no forced theme reset)", async () => {
    localStorage.setItem("tl.theme", "dark"); // a pre-redesign install
    setAppImpl();
    render(<App />);
    await screen.findByText(/Begin with a book you mean to finish/i);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });
});

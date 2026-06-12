import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Tauri surface mocks ──────────────────────────────────────────────────────
// App talks to: core (invoke), plugin-dialog (file picker), event (tl-activate
// deep link), and webview (drag-and-drop). The webview mock captures the
// registered drag-drop handler so tests can drive an OS file drop directly.
const mocks = vi.hoisted(() => {
  const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null));
  type DragEvent = { payload: { type: string; paths?: string[] } };
  const dragHandlers: Array<(e: DragEvent) => void | Promise<void>> = [];
  return { invoke, dragHandlers };
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

import App, { handleDroppedPaths, importErrorText } from "./App";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { errorMessage } from "./types";
import type { TodayCard } from "./types";

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

beforeEach(() => {
  cleanup();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  mocks.dragHandlers.length = 0;
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
      default:
        return Promise.resolve(null);
    }
  });
}

describe("App drag-and-drop import", () => {
  it("registers a drag-drop listener and routes a new book to the Book Setup Sheet", async () => {
    setAppImpl({ cmd_import_book: { book: BOOK, created: true } });
    render(<App />);
    await screen.findByText(/Welcome to Throughline/i);
    await waitFor(() => expect(mocks.dragHandlers.length).toBeGreaterThan(0));

    await act(async () => {
      await mocks.dragHandlers[0]({ payload: { type: "drop", paths: ["/tmp/confessions.epub"] } });
    });

    // The Book Setup Sheet (same as the picker's created:true path).
    expect(await screen.findByText("New on your desk")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Confessions" })).toBeInTheDocument();
  });

  it("shows the calm notice (not silence) for an unsupported drop", async () => {
    setAppImpl();
    render(<App />);
    await screen.findByText(/Welcome to Throughline/i);
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

    await userEvent.click(await screen.findByRole("button", { name: /Import a file instead/i }));

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
      cmd_set_active_book: () =>
        Promise.reject({ kind: "NotFound", resource: "book", id: null }),
    });
    render(<App />);

    // Open the book switcher and pick the other book.
    await userEvent.click(await screen.findByTitle("Switch book"));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Middlemarch/ }));

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
    await screen.findByText(/Welcome to Throughline/i);

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

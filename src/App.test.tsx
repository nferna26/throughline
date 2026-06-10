import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";

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
import { errorMessage } from "./types";

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
function setAppImpl(overrides: Record<string, unknown> = {}) {
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd in overrides) return Promise.resolve(overrides[cmd]);
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
    expect(await screen.findByText("New book")).toBeInTheDocument();
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

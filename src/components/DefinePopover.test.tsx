import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import DefinePopover from "./DefinePopover";
import { invoke } from "@tauri-apps/api/core";

// Channel is a no-op holder here; the test drives the stream by calling the
// captured channel's onmessage directly (the real Channel is a Tauri IPC bridge).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((e: unknown) => void) | null = null;
  },
}));

// Capture the streaming channel the component hands to cmd_ai_ask so the test can
// push delta / done events into it.
let lastChannel: { onmessage: ((e: unknown) => void) | null } | null = null;
function mockStreaming() {
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "cmd_ai_ask") {
      lastChannel = (args as { onEvent: typeof lastChannel }).onEvent;
      return Promise.resolve({ ai_request_id: "r1" });
    }
    return Promise.resolve(undefined);
  });
}

const baseProps = {
  term: "ineffable",
  bookId: "b1",
  chapter: "Chapter 1",
  locator: "char:10",
  x: 200,
  y: 120,
  below: false,
  onClose: () => {},
  onOpenInMargin: () => {},
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  localStorage.clear();
  localStorage.setItem("tl.tutorEnabled", "true");
  lastChannel = null;
});

describe("DefinePopover (CORE-1158)", () => {
  it("renders a light popover at the selection, NOT the margin tutor card", () => {
    mockStreaming();
    const { container } = render(<DefinePopover {...baseProps} />);
    // A dialog popover with the term, positioned at the selection coords.
    const pop = container.querySelector(".tl-define") as HTMLElement;
    expect(pop).not.toBeNull();
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.style.left).toBe("200px");
    expect(pop.style.top).toBe("120px");
    expect(screen.getByText("ineffable")).toBeInTheDocument();
    // It is distinct from the margin card (Explain/Context open `.tl-tutor`).
    expect(container.querySelector(".tl-tutor")).toBeNull();
  });

  it("sends the SAME vocabulary/brief request as the margin card (payload unchanged)", () => {
    mockStreaming();
    render(<DefinePopover {...baseProps} />);
    const ask = vi.mocked(invoke).mock.calls.find((c) => c[0] === "cmd_ai_ask");
    expect(ask).toBeTruthy();
    const args = ask![1] as Record<string, unknown>;
    expect(args.mode).toBe("vocabulary");
    expect(args.depth).toBe("brief");
    expect(args.selection).toBe("ineffable");
    expect(args.bookId).toBe("b1");
    expect(args.locator).toBe("char:10");
  });

  it("has an aria-live polite region that toggles aria-busy across the stream", async () => {
    mockStreaming();
    const { container } = render(<DefinePopover {...baseProps} />);
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).not.toBeNull();
    // Thinking → busy (so a screen reader announces the gloss as one chunk).
    expect(live.getAttribute("aria-busy")).toBe("true");

    await waitFor(() => expect(lastChannel).not.toBeNull());
    act(() => lastChannel!.onmessage!({ kind: "delta", text: "Too great to be expressed." }));
    expect(screen.getByText("Too great to be expressed.")).toBeInTheDocument();
    expect(live.getAttribute("aria-busy")).toBe("true"); // still streaming

    act(() => lastChannel!.onmessage!({ kind: "done" }));
    expect(live.getAttribute("aria-busy")).toBe("false"); // settled → announce once
  });

  it("escalates to the full margin card when the tutor isn't enabled yet", async () => {
    localStorage.setItem("tl.tutorEnabled", "false");
    mockStreaming();
    const onOpenInMargin = vi.fn();
    const onClose = vi.fn();
    render(<DefinePopover {...baseProps} onOpenInMargin={onOpenInMargin} onClose={onClose} />);
    await waitFor(() => expect(onOpenInMargin).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Never sent a request — the card's guided setup handles enabling.
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "cmd_ai_ask")).toBe(false);
  });

  it("offers Go deeper in the margin once the brief resolves", async () => {
    mockStreaming();
    const onOpenInMargin = vi.fn();
    const onClose = vi.fn();
    render(<DefinePopover {...baseProps} onOpenInMargin={onOpenInMargin} onClose={onClose} />);
    await waitFor(() => expect(lastChannel).not.toBeNull());
    act(() => {
      lastChannel!.onmessage!({ kind: "delta", text: "A short gloss." });
      lastChannel!.onmessage!({ kind: "done" });
    });
    const deeper = screen.getByRole("button", { name: /Go deeper in the margin/i });
    fireEvent.click(deeper);
    expect(onOpenInMargin).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

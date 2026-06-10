import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import SectionBriefingCard from "./SectionBriefingCard";
import { setCachedBriefing, resetBriefingCache } from "../sectionBriefing";

const mocks = vi.hoisted(() => {
  class MockChannel {
    onmessage: ((e: unknown) => void) | null = null;
  }
  const invoke = vi.fn((_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null));
  return { invoke, Channel: MockChannel };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: mocks.Channel }));
type MockChannelT = InstanceType<typeof mocks.Channel>;

function setImpl() {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_get_settings":
        return Promise.resolve({ ai_provider: "local", ai_base_url: "http://localhost:1234/v1", ai_model: "m", margin_help: "deep_study" });
      case "cmd_ai_ask":
        return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "localhost" });
      case "cmd_test_ai_connection":
        return Promise.resolve({ reachable: true, first_model_id: "m", message: "ok" });
      default:
        return Promise.resolve(null);
    }
  });
}

// The briefing cache is session-only (in-memory) — localStorage.clear() no
// longer resets it, so drop it explicitly between cases.
beforeEach(() => { cleanup(); localStorage.clear(); resetBriefingCache(); setImpl(); });

const props = {
  bookId: "bk", sectionId: "s1", sourceSha: "sha1", mode: "deep_study",
  chapter: "BOOK I", locator: "char:0", sectionText: "Great art Thou, O Lord…",
  onDismiss: () => {},
};

function lastChannel(): MockChannelT {
  const call = [...mocks.invoke.mock.calls].reverse().find((c) => c[0] === "cmd_ai_ask");
  if (!call) throw new Error("cmd_ai_ask was never called");
  return (call[1] as { onEvent: MockChannelT }).onEvent;
}

const SAMPLE = "BEFORE YOU READ\nThe central tension.\n\nWATCH FOR\n- the paradox\n\nKEY TERMS\nNone needed.\n\nTHE MOVE\nSets up the work.\n\nREADING QUESTION\nWhy seek?";

describe("SectionBriefingCard", () => {
  it("renders a CACHED briefing instantly without calling the model", async () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE);
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/The central tension\./)).toBeInTheDocument();
    expect(screen.getByText("the paradox")).toBeInTheDocument();
    expect(screen.getByText(/Why seek\?/)).toBeInTheDocument();
    expect(screen.getByText(/Prepared on this Mac/i)).toBeInTheDocument();
    // Cache hit → no model call.
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
  });

  it("auto-prepares (streams) when tutor is enabled and nothing is cached", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    render(<SectionBriefingCard {...props} />);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ mode: "section_briefing", selection: "Great art Thou, O Lord…" })),
    );
    const ch = lastChannel();
    await act(async () => { ch.onmessage?.({ kind: "delta", text: SAMPLE }); });
    await act(async () => { ch.onmessage?.({ kind: "done" }); });
    expect(screen.getByText(/The central tension\./)).toBeInTheDocument();
  });

  it("does NOT call the model until the reader consents (opt-in gate)", async () => {
    // tutor NOT enabled, nothing cached → consent card, no call.
    render(<SectionBriefingCard {...props} />);
    expect(await screen.findByText(/Deep Study can prepare/i)).toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());

    fireEvent.click(screen.getByText("Prepare briefing"));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.objectContaining({ mode: "section_briefing" })),
    );
    expect(localStorage.getItem("tl.tutorEnabled")).toBe("true");
  });

  it("renders Watch-for items as plain text when no marker handler is given", async () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE);
    const { container } = render(<SectionBriefingCard {...props} />);
    await screen.findByText("the paradox");
    // No onAskContext → no marker buttons, just a static list.
    expect(container.querySelector(".tl-briefing-marker")).toBeNull();
  });

  it("v2: renders Watch-for items as tappable context markers that fire onAskContext", async () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", SAMPLE);
    const onAskContext = vi.fn();
    const { container } = render(<SectionBriefingCard {...props} onAskContext={onAskContext} />);
    await screen.findByText("the paradox");
    const marker = container.querySelector(".tl-briefing-marker") as HTMLButtonElement;
    expect(marker).not.toBeNull();
    fireEvent.click(marker);
    expect(onAskContext).toHaveBeenCalledWith("the paradox");
  });
});

describe("SectionBriefingCard — provider gate", () => {
  // No AI provider chosen → preparing a briefing would have nowhere safe to go.
  function setNoProvider() {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "none", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "" });
        default:
          return Promise.resolve(null);
      }
    });
  }

  it("does NOT generate when no provider is chosen, and shows the cold-start setup sheet", async () => {
    localStorage.setItem("tl.tutorEnabled", "true"); // would normally auto-prepare
    setNoProvider();
    render(<SectionBriefingCard {...props} />);
    // The dead-end "Choose one in Settings" message is replaced by setup-at-intent.
    expect(await screen.findByText(/Tutor not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/Paste API key & ask/i)).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_get_settings"));
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
    expect(screen.queryByText(/Nothing leaves your device/i)).toBeNull();
    expect(screen.queryByText(/^Local-only$/)).toBeNull();
  });

  it("a company outage opens the paused sheet in Throughline AI's voice — truthful, no key-pasting CTA (CORE-1037)", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "company", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "ai.readthroughline.com" });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    const ch = lastChannel();
    // The relay went quiet AFTER the send — the audit row for this minute says Sent →.
    await act(async () => { ch.onmessage?.({ kind: "error", message: "Throughline AI request failed: connection refused" }); });
    expect(await screen.findByText(/Throughline AI hit a snag/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been sent/i)).toBeNull();
    expect(screen.queryByText(/Switch provider/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Check again/i })).toBeInTheDocument();
  });

  it("when a CLOUD provider is chosen, the briefing IS allowed (calls cmd_ai_ask) and never claims local", async () => {
    localStorage.setItem("tl.tutorEnabled", "true");
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "cmd_get_settings":
          return Promise.resolve({ ai_provider: "anthropic", ai_model_anthropic: "claude-opus-4-8", margin_help: "deep_study" });
        case "cmd_ai_ask":
          return Promise.resolve({ ai_request_id: "ai_1", prompt_sent: "(hidden)", provider_host: "api.anthropic.com" });
        default:
          return Promise.resolve(null);
      }
    });
    render(<SectionBriefingCard {...props} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_ai_ask", expect.anything()));
    expect(screen.queryByText(/^Local-only$/)).toBeNull();
  });
});

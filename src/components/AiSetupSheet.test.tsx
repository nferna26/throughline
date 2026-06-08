import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import AiSetupSheet, { type AiSetupContext, type SetupState } from "./AiSetupSheet";

// ── Tauri core mock: invoke (by command name). CodexLogin also imports it. ───
const mocks = vi.hoisted(() => {
  const invoke = vi.fn(
    (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(null),
  );
  return { invoke };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  // CodexLogin uses Channel-free commands only; a stub class keeps imports happy.
  Channel: class {},
}));

// A drivable clipboard so the copied-state assertions are deterministic.
const clipboardWrite = vi.fn(() => Promise.resolve());

beforeEach(() => {
  cleanup();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_get_settings":
        return Promise.resolve({ ai_codex_creds_present: false });
      case "cmd_ai_preview":
        return Promise.resolve({
          title: "Explain this passage",
          disclosure: "Throughline hasn't sent anything. Paste this into the AI tool you already use.",
          prompt: "Explain this passage from Confessions by Augustine. …",
          copy_label: "Copy prompt",
        });
      case "cmd_test_ai_connection":
        return Promise.resolve({ reachable: true, first_model_id: "gemma-4-31b-it-mlx", message: "ok" });
      default:
        return Promise.resolve({});
    }
  });
  clipboardWrite.mockReset();
  Object.assign(navigator, { clipboard: { writeText: clipboardWrite } });
});

const baseCtx: AiSetupContext = {
  mode: "explain",
  selectedText: "the unjust man is happy",
  bookTitle: "Confessions",
  author: "Augustine",
  sectionLabel: "Book I",
};

function sheet(initialState: SetupState = "not_connected", onConnected = vi.fn()) {
  return <AiSetupSheet ctx={baseCtx} initialState={initialState} onConnected={onConnected} />;
}

describe("AiSetupSheet — NOT CONNECTED", () => {
  it("renders the not-connected copy, the passage, and the three setup paths", async () => {
    render(sheet("not_connected"));
    expect(await screen.findByText(/Tutor not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/It just needs somewhere to run\. Nothing has been sent\./i)).toBeInTheDocument();
    // The selected passage is shown so the reader sees what the lens is for.
    expect(screen.getByText(/the unjust man is happy/)).toBeInTheDocument();
    expect(screen.getByText(/Paste API key & ask/i)).toBeInTheDocument();
    expect(screen.getByText(/Use LM Studio on this Mac/i)).toBeInTheDocument();
    expect(screen.getByText(/^Copy prompt$/i)).toBeInTheDocument();
    // Never auto-calls a model on mount.
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
  });
});

describe("AiSetupSheet — PASTE-KEY wizard", () => {
  it("offers OpenAI / Anthropic / Codex and marks Codex experimental — unofficial endpoint", async () => {
    render(sheet("not_connected"));
    fireEvent.click(await screen.findByText(/Paste API key & ask/i));
    expect(await screen.findByText(/Paste an API key/i)).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    // Codex is KEPT as an option, with the experimental marker.
    expect(screen.getByText(/Codex/)).toBeInTheDocument();
    expect(screen.getByText(/Experimental — unofficial endpoint/i)).toBeInTheDocument();
    // The Keychain disclosure is present.
    expect(screen.getByText(/Stored in macOS Keychain/i)).toBeInTheDocument();
  });

  it("[Verify & answer] verifies via the connection-test command THEN hands back to run the lens (no Settings detour)", async () => {
    const onConnected = vi.fn();
    render(sheet("not_connected", onConnected));
    fireEvent.click(await screen.findByText(/Paste API key & ask/i));
    fireEvent.change(await screen.findByLabelText(/OpenAI API key/i), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText(/Verify & answer/i));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "cmd_test_ai_connection",
        expect.objectContaining({ provider: "openai", key: "sk-test" }),
      ),
    );
    // Key is persisted, provider is saved, and control hands back immediately.
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cmd_set_ai_key", expect.objectContaining({ provider: "openai" })));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("openai"));
  });

  it("on verify FAILURE, the error states nothing from the book was sent", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_get_settings") return Promise.resolve({ ai_codex_creds_present: false });
      if (cmd === "cmd_test_ai_connection")
        return Promise.resolve({ reachable: false, first_model_id: null, message: "Invalid API key." });
      return Promise.resolve({});
    });
    const onConnected = vi.fn();
    render(sheet("not_connected", onConnected));
    fireEvent.click(await screen.findByText(/Paste API key & ask/i));
    fireEvent.change(await screen.findByLabelText(/OpenAI API key/i), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByText(/Verify & answer/i));
    expect(await screen.findByText(/nothing from your book was sent/i)).toBeInTheDocument();
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("AiSetupSheet — LM STUDIO detect", () => {
  it("FOUND: names the local model, promises nothing leaves this Mac, and offers to answer", async () => {
    const onConnected = vi.fn();
    render(sheet("not_connected", onConnected));
    fireEvent.click(await screen.findByText(/Use LM Studio on this Mac/i));
    expect(await screen.findByText(/Local model found/i)).toBeInTheDocument();
    expect(screen.getByText("gemma-4-31b-it-mlx")).toBeInTheDocument();
    expect(screen.getByText(/Nothing leaves this Mac/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Use this model & answer/i));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("local"));
  });

  it("NO-SERVER: offers Check again, Paste API key instead, and Copy prompt", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_get_settings") return Promise.resolve({ ai_codex_creds_present: false });
      if (cmd === "cmd_test_ai_connection")
        return Promise.resolve({ reachable: false, first_model_id: null, message: "refused" });
      return Promise.resolve({});
    });
    render(sheet("not_connected"));
    fireEvent.click(await screen.findByText(/Use LM Studio on this Mac/i));
    expect(await screen.findByText(/No local model server is running/i)).toBeInTheDocument();
    expect(screen.getByText(/Check again/i)).toBeInTheDocument();
    expect(screen.getByText(/Paste API key instead/i)).toBeInTheDocument();
    expect(screen.getByText(/^Copy prompt$/i)).toBeInTheDocument();
  });

  it("RUNNING-BUT-NO-MODEL: explains the server is up but no model is loaded", async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "cmd_get_settings") return Promise.resolve({ ai_codex_creds_present: false });
      if (cmd === "cmd_test_ai_connection")
        return Promise.resolve({ reachable: true, first_model_id: null, message: "no model" });
      return Promise.resolve({});
    });
    render(sheet("not_connected"));
    fireEvent.click(await screen.findByText(/Use LM Studio on this Mac/i));
    expect(await screen.findByText(/no model is loaded/i)).toBeInTheDocument();
    // Scope to the button — the explanatory copy also contains "check again".
    expect(screen.getByRole("button", { name: /Check again/i })).toBeInTheDocument();
  });
});

describe("AiSetupSheet — CONFIGURED-BUT-UNAVAILABLE (Tutor paused)", () => {
  it("renders the paused recovery with Check again / Switch provider / Copy prepared prompt — never Settings-only", async () => {
    const onConnected = vi.fn();
    render(sheet("unavailable", onConnected));
    expect(await screen.findByText(/Tutor paused/i)).toBeInTheDocument();
    expect(screen.getByText(/Check again/i)).toBeInTheDocument();
    expect(screen.getByText(/Switch provider/i)).toBeInTheDocument();
    expect(screen.getByText(/Copy prepared prompt/i)).toBeInTheDocument();
    // "Check again" just retries the live provider (empty string → caller retry).
    fireEvent.click(screen.getByText(/Check again/i));
    expect(onConnected).toHaveBeenCalledWith("");
  });
});

describe("AiSetupSheet — dignified fallback (copyable prompt)", () => {
  it("builds a reader-facing prompt via the network-free preview command, copies it, and shows the paste hint", async () => {
    render(sheet("not_connected"));
    fireEvent.click(await screen.findByText(/^Copy prompt$/i));
    // The prompt comes from cmd_ai_preview (no model call).
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "cmd_ai_preview",
        expect.objectContaining({ mode: "explain", selectedText: "the unjust man is happy" }),
      ),
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith("cmd_ai_ask", expect.anything());
    expect(await screen.findByText(/Explain this passage from Confessions/i)).toBeInTheDocument();
    expect(screen.getByText(/Throughline hasn't sent anything/i)).toBeInTheDocument();

    // The fallback prompt button copies and shows the calm paste hint.
    const copyBtns = screen.getAllByText(/Copy prompt/i);
    await act(async () => { fireEvent.click(copyBtns[copyBtns.length - 1]); });
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled());
    expect(await screen.findByText(/Copied — paste it into the AI tool you already use\./i)).toBeInTheDocument();
    // And [Set up tutor] returns to the connect path (never a dead end).
    expect(screen.getByText(/Set up tutor/i)).toBeInTheDocument();
  });
});

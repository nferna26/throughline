import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Settings from "./Settings";
import type { SettingsDto } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

// AiHistory (rendered by Settings) also calls invoke; default it to safe values.
function wire(dto: Partial<SettingsDto>) {
  const full: SettingsDto = {
    export_path: "/Users/x/GBrain/Reading",
    export_path_is_default: true,
    app_data_path: "/Users/x/Library/Application Support/Throughline",
    ai_posture: "Local-only mode: ON",
    ai_base_url: "http://localhost:1234/v1",
    ai_model: "m",
    ai_local_only: true,
    quote_policy: "Short quotes only.",
    quote_warn_chars: 300,
    ai_requests_retention_days: 90,
    margin_help: "guided",
    ai_provider: "local",
    ai_provider_chosen: true,
    ai_remote_allowed: false,
    ai_model_openai: "gpt-5.5",
    ai_model_anthropic: "claude-opus-4-8",
    ai_model_codex: "gpt-5.5",
    ai_key_present_openai: false,
    ai_key_present_anthropic: false,
    ai_codex_creds_present: false,
    ...dto,
  };
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_get_settings": return Promise.resolve(full);
      case "cmd_list_ai_models": return Promise.resolve(["m"]);
      case "cmd_list_ai_requests": return Promise.resolve([]);
      default: return Promise.resolve(undefined);
    }
  });
}

beforeEach(() => mockInvoke.mockReset());

describe("Settings — Your data trust summary", () => {
  it("states the privacy contract plainly with the local provider", async () => {
    wire({ ai_provider: "local", ai_remote_allowed: false });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Your book files stay on this Mac/i)).toBeInTheDocument());
    expect(screen.getByText(/raw book text is never written out/i)).toBeInTheDocument();
    expect(screen.getByText(/based only on the passage or section you choose/i)).toBeInTheDocument();
    expect(screen.getByText(/becomes a saved note only when you choose to keep it/i)).toBeInTheDocument();
    // Local provider → "local model" and no off-device warning.
    expect(screen.getByText(/run on a local model/i)).toBeInTheDocument();
    expect(screen.queryByText(/is sent to/i)).toBeNull();
  });

  it("discloses honestly (never claims local) when a cloud provider is chosen — and does NOT call it disabled", async () => {
    wire({ ai_provider: "openai", ai_remote_allowed: true });
    render(<Settings />);
    // The scope line flips to "remote" — never a false on-device claim.
    await waitFor(() => expect(screen.getByText(/run on a remote model/i)).toBeInTheDocument());
    // A cloud provider is ENABLED (not disabled); the warning names the provider + what's sent.
    expect(screen.getByText(/your selected passage or section is sent to OpenAI/i)).toBeInTheDocument();
    expect(screen.queryByText(/disabled until you re-enable/i)).toBeNull();
  });
});

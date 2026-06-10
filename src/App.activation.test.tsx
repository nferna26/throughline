// CORE-1009 [P2-11]: the company-activation deep link must give visible
// success/failure feedback. The "did my $20 purchase take?" moment can't end
// in silence (success) or a swallowed catch (failure).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// The merged App mounts a drag-and-drop listener (P1-1); mock the webview
// surface so this suite stays focused on the activation banner.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

// Capture the tl-activate handler so tests can drive the deep link directly.
type ActivateHandler = (event: { payload: string }) => void | Promise<void>;
let activateHandler: ActivateHandler | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: ActivateHandler) => {
    if (name === "tl-activate") activateHandler = handler;
    return () => {};
  }),
}));

// Today is owned by another workstream; stub it so this test exercises only
// the App-level activation banner.
vi.mock("./screens/Today", () => ({
  default: () => <div data-testid="today-stub" />,
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

function wire(activate: () => Promise<unknown>) {
  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "cmd_today":
        return Promise.resolve(null);
      case "cmd_check_export_path":
        return Promise.resolve({ path: "/tmp/x", writable: true, message: null });
      case "cmd_activate_company":
        return activate();
      default:
        return Promise.resolve(undefined);
    }
  });
}

async function fireActivate() {
  await waitFor(() => expect(activateHandler).toBeDefined());
  await act(async () => {
    await activateHandler!({ payload: "tl_act_test-token" });
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
  activateHandler = undefined;
});

describe("App — company activation deep link feedback (CORE-1009)", () => {
  it("shows a visible, dismissable confirmation when activation succeeds", async () => {
    wire(() => Promise.resolve(undefined));
    render(<App />);
    await fireActivate();

    // A calm, visible confirmation — not a silent Today refresh.
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Throughline AI is active — ask the tutor anything.");

    // The reader can put it away.
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Throughline AI is active/)).toBeNull();
  });

  it("shows the failure message with a pointer to Settings → Assistance when activation fails", async () => {
    wire(() =>
      Promise.reject({
        kind: "Validation",
        message: "That activation code is invalid, expired, or already used.",
      })
    );
    render(<App />);
    await fireActivate();

    // The exact backend message is surfaced, not swallowed…
    expect(
      await screen.findByText(/That activation code is invalid, expired, or already used\./)
    ).toBeInTheDocument();
    // …with a retry-by-code pointer to Settings → Assistance.
    expect(screen.getByText(/Settings → Assistance/)).toBeInTheDocument();
  });
});

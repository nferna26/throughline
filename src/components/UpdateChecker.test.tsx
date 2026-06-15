import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import UpdateChecker from "./UpdateChecker";

// FT-15 (CORE-1048): the updater must never paint tauri-plugin-updater's raw
// plumbing ("Could not fetch a valid release JSON from the remote") on the
// reader's screen. Drive the check() rejection through the real component and
// assert the rendered copy is humanized — no "JSON"/"remote" — with a recovery.

const mocks = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn(), relaunch: vi.fn() }));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.4.3") }));

beforeEach(() => {
  cleanup();
  mocks.check.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  mocks.relaunch.mockReset();
  mocks.relaunch.mockResolvedValue(undefined);
});

describe("UpdateChecker — failure copy", () => {
  it("a raw 'release JSON from the remote' failure renders as calm humanized copy", async () => {
    mocks.check.mockRejectedValue(new Error("Could not fetch a valid release JSON from the remote"));

    render(<UpdateChecker />);
    fireEvent.click(screen.getByText(/Check for updates/i));

    const alert = await screen.findByText(/Couldn't check for updates/i);
    const shown = alert.textContent ?? "";
    expect(shown).not.toContain("JSON");
    expect(shown.toLowerCase()).not.toContain("remote");
    expect(shown).toMatch(/internet/i);
    expect(shown).toMatch(/try again/i);

    // Recovery stays: the reader can try again.
    expect(await screen.findByRole("button", { name: /Check again/i })).toBeInTheDocument();
  });

  it("an up-to-date check still reports calmly (the good state is untouched)", async () => {
    mocks.check.mockResolvedValue(null);

    render(<UpdateChecker />);
    fireEvent.click(screen.getByText(/Check for updates/i));

    await waitFor(() => expect(screen.getByText(/up to date/i)).toBeInTheDocument());
  });

  it("marks the next startup for foreground focus before updater relaunch", async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    mocks.check.mockResolvedValue({ version: "0.4.4", downloadAndInstall });

    render(<UpdateChecker />);
    fireEvent.click(screen.getByText(/Check for updates/i));
    fireEvent.click(await screen.findByRole("button", { name: /Update & restart/i }));

    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_prepare_update_relaunch_focus");
    const markerCall = mocks.invoke.mock.invocationCallOrder.find((_, i) =>
      mocks.invoke.mock.calls[i]?.[0] === "cmd_prepare_update_relaunch_focus"
    );
    expect(markerCall).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it("clears the relaunch focus marker if relaunch fails in the old process", async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    mocks.check.mockResolvedValue({ version: "0.4.4", downloadAndInstall });
    mocks.relaunch.mockRejectedValue(new Error("restart failed"));

    render(<UpdateChecker />);
    fireEvent.click(screen.getByText(/Check for updates/i));
    fireEvent.click(await screen.findByRole("button", { name: /Update & restart/i }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cmd_consume_update_relaunch_focus"),
    );
    expect(await screen.findByText(/couldn't finish downloading/i)).toBeInTheDocument();
  });
});

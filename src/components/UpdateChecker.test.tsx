import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import UpdateChecker, {
  FALLBACK_DOWNLOAD_URL,
  UPDATE_CHECK_INTERVAL_MS,
  resetUpdateCheckGate,
  shouldStartBackgroundUpdateCheck,
  updatePillView,
} from "./UpdateChecker";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

beforeEach(() => {
  cleanup();
  resetUpdateCheckGate();
  mocks.check.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  mocks.relaunch.mockReset();
  mocks.relaunch.mockResolvedValue(undefined);
  vi.spyOn(window, "open").mockImplementation(() => null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeDueForBackgroundCheck() {
  expect(shouldStartBackgroundUpdateCheck(0)).toBe(false);
}

describe("UpdateChecker pill model", () => {
  it("maps every visible state to the shipped pill label", () => {
    expect(updatePillView("ready")).toMatchObject({ label: "Update ready", icon: "download", busy: false, fallback: false });
    expect(updatePillView("updating")).toMatchObject({ label: "Updating", icon: "download", busy: true, fallback: false });
    expect(updatePillView("restart")).toMatchObject({ label: "Restart to update", icon: "restart", busy: false, fallback: false });
    expect(updatePillView("fallback")).toMatchObject({ label: "Download update", icon: "download", busy: false, fallback: true });
  });

  it("skips the brand-new first launch and gates later quiet checks to about 24 hours", () => {
    expect(shouldStartBackgroundUpdateCheck(1_000)).toBe(false);
    expect(shouldStartBackgroundUpdateCheck(1_000 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldStartBackgroundUpdateCheck(1_000 + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    expect(shouldStartBackgroundUpdateCheck(1_000 + UPDATE_CHECK_INTERVAL_MS + 1)).toBe(false);
  });
});

describe("UpdateChecker Today pill", () => {
  it("does not check or render on the first visible Today mount", async () => {
    render(<UpdateChecker now={() => 0} />);

    await Promise.resolve();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("turns a check failure into the fallback download pill with no error copy", async () => {
    makeDueForBackgroundCheck();
    mocks.check.mockRejectedValue(new Error("Could not fetch a valid release JSON from the remote"));

    render(<UpdateChecker now={() => UPDATE_CHECK_INTERVAL_MS} />);

    const fallback = await screen.findByRole("button", { name: "Download update" });
    expect(fallback.className).toContain("fallback");
    expect(screen.queryByText(/JSON|remote|error|failed|couldn/i)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("check failed"),
      expect.any(Error),
    );

    fireEvent.click(fallback);
    expect(window.open).toHaveBeenCalledWith(FALLBACK_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
  });

  it("downloads in place, exposes Updating as busy/live, then offers restart without forcing it", async () => {
    makeDueForBackgroundCheck();
    let finishDownload: () => void = () => {
      throw new Error("download promise was not started");
    };
    const downloadAndInstall = vi.fn((onEvent: (event: unknown) => void) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      return new Promise<void>((resolve) => {
        finishDownload = resolve;
      });
    });
    mocks.check.mockResolvedValue({ version: "0.8.0", downloadAndInstall });

    render(<UpdateChecker now={() => UPDATE_CHECK_INTERVAL_MS} />);

    fireEvent.click(await screen.findByRole("button", { name: "Update ready" }));
    const updating = await screen.findByRole("status");
    expect(updating).toHaveAttribute("aria-busy", "true");
    expect(updating).toHaveTextContent("Updating");
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();

    finishDownload();
    const restart = await screen.findByRole("button", { name: "Restart to update" });
    expect(mocks.relaunch).not.toHaveBeenCalled();

    fireEvent.click(restart);
    await waitFor(() => expect(mocks.relaunch).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_prepare_update_relaunch_focus");
    const markerCall = mocks.invoke.mock.invocationCallOrder.find((_, i) =>
      mocks.invoke.mock.calls[i]?.[0] === "cmd_prepare_update_relaunch_focus"
    );
    expect(markerCall).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it("falls back to the public download when download/install fails", async () => {
    makeDueForBackgroundCheck();
    const downloadAndInstall = vi.fn(() => Promise.reject(new Error("signature mismatch")));
    mocks.check.mockResolvedValue({ version: "0.8.0", downloadAndInstall });

    render(<UpdateChecker now={() => UPDATE_CHECK_INTERVAL_MS} />);

    fireEvent.click(await screen.findByRole("button", { name: "Update ready" }));
    expect(await screen.findByRole("button", { name: "Download update" })).toBeInTheDocument();
    expect(screen.queryByText(/signature|mismatch|error|failed/i)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("download failed"),
      expect.any(Error),
    );
  });
});

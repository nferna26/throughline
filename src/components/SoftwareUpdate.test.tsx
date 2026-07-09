import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SoftwareUpdatePane, { relativeTimeFrom, softwareUpdateView } from "./SoftwareUpdate";
import {
  createUpdateMachine,
  initialUpdateState,
  updateReducer,
  UPDATE_CHECK_COOLDOWN_MS,
  type UpdateMachineState,
} from "../updateMachine";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  relaunch: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

beforeEach(() => {
  cleanup();
  mocks.check.mockReset();
  mocks.check.mockResolvedValue(null);
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  mocks.relaunch.mockReset();
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.openUrl.mockReset();
  mocks.openUrl.mockResolvedValue(undefined);
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stateAt(actions: Parameters<typeof updateReducer>[1][]): UpdateMachineState {
  return actions.reduce(updateReducer, initialUpdateState());
}

const FOUND = {
  type: "CHECK_FOUND",
  version: "1.2.0",
  currentVersion: "0.9.1",
  critical: false,
  at: 1_000,
} as const;

describe("relativeTimeFrom (plain words, no em dashes)", () => {
  it("covers the scale from just now to days", () => {
    const now = 10 * 24 * 60 * 60_000;
    expect(relativeTimeFrom(now - 5_000, now)).toBe("just now");
    expect(relativeTimeFrom(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTimeFrom(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(relativeTimeFrom(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(relativeTimeFrom(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
    expect(relativeTimeFrom(now - 30 * 60 * 60_000, now)).toBe("yesterday");
    expect(relativeTimeFrom(now - 4 * 24 * 60 * 60_000, now)).toBe("4 days ago");
  });
});

describe("softwareUpdateView — the frozen CORE-1193 copy, state by state", () => {
  const NOW = 120_000; // 2 minutes past the epoch the FOUND action stamps

  it("up to date", () => {
    const v = softwareUpdateView(stateAt([{ type: "CHECK_UP_TO_DATE", at: 1_000 }]), "0.9.1", NOW);
    expect(v.line).toBe("You are on the latest version, v0.9.1.");
    expect(v.sub).toBe("Last checked 1 minute ago.");
    expect(v.primary).toMatchObject({ label: "Check for updates", action: "check" });
  });

  it("checking", () => {
    const v = softwareUpdateView(stateAt([{ type: "CHECK_STARTED" }]), "0.9.1", NOW);
    expect(v.line).toBe("Checking for updates...");
    expect(v.primary).toMatchObject({ label: "Check for updates", disabled: true });
  });

  it("available while auto-downloading", () => {
    const s = { ...stateAt([FOUND]), autoDownload: true };
    const v = softwareUpdateView(s, "0.9.1", NOW);
    expect(v.line).toBe("Version 1.2.0 is available. Downloading now...");
    expect(v.primary).toBeNull();
  });

  it("available for download-on-click readers", () => {
    const s = { ...stateAt([FOUND]), autoDownload: false };
    const v = softwareUpdateView(s, "0.9.1", NOW);
    expect(v.line).toBe("Version 1.2.0 is available.");
    expect(v.primary).toMatchObject({ label: "Download update", action: "download" });
  });

  it("downloading, with and without a known size", () => {
    const base = [FOUND, { type: "DOWNLOAD_STARTED" }] as const;
    const known = stateAt([...base, { type: "DOWNLOAD_PROGRESS", pct: 42 }]);
    expect(softwareUpdateView(known, "0.9.1", NOW).line).toBe("Downloading update... 42%");
    const unknown = stateAt([...base, { type: "DOWNLOAD_PROGRESS", pct: null }]);
    expect(softwareUpdateView(unknown, "0.9.1", NOW).line).toBe("Downloading update...");
  });

  it("ready to restart", () => {
    const v = softwareUpdateView(
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FINISHED" }]),
      "0.9.1",
      NOW,
    );
    expect(v.line).toBe("Update ready. Restart Throughline to finish.");
    expect(v.primary).toMatchObject({ label: "Restart now", action: "restart" });
    expect(v.secondary).toMatchObject({ label: "Restart later", action: "restartLater" });
  });

  it("security update carries the recommendation line", () => {
    const v = softwareUpdateView(stateAt([{ ...FOUND, critical: true }]), "0.9.1", NOW);
    expect(v.securityLine).toBe("A security update is available. We recommend installing it now.");
  });

  it("error offers Try again and the last-resort website download", () => {
    const v = softwareUpdateView(
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FAILED", offline: false }]),
      "0.9.1",
      NOW,
    );
    expect(v.line).toBe("We could not complete the update.");
    expect(v.primary).toMatchObject({ label: "Try again", action: "retry" });
    expect(v.secondary).toMatchObject({ label: "Download from the website", action: "website" });
  });

  it("offline promises the automatic re-check and offers Try again", () => {
    const v = softwareUpdateView(
      stateAt([{ type: "CHECK_FAILED", offline: true, at: 1_000 }]),
      "0.9.1",
      NOW,
    );
    expect(v.line).toBe(
      "You appear to be offline. We will check again automatically when you are back online.",
    );
    expect(v.primary).toMatchObject({ label: "Try again", action: "retry" });
    expect(v.secondary).toBeNull(); // no dead-end website push while offline
  });

  it("always names the current version and last check when known", () => {
    for (const s of [
      stateAt([FOUND]),
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }]),
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FINISHED" }]),
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FAILED", offline: false }]),
    ]) {
      const v = softwareUpdateView(s, "0.9.1", NOW);
      expect(v.sub).toContain("Version 0.9.1.");
      expect(v.sub).toContain("Last checked");
    }
  });

  it("uses no em dashes anywhere in the reader-facing copy", () => {
    const states: UpdateMachineState[] = [
      initialUpdateState(),
      stateAt([{ type: "CHECK_STARTED" }]),
      stateAt([{ type: "CHECK_UP_TO_DATE", at: 1 }]),
      stateAt([FOUND]),
      { ...stateAt([FOUND]), autoDownload: false },
      stateAt([{ ...FOUND, critical: true }]),
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }]),
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FINISHED" }]),
      stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FAILED", offline: false }]),
      stateAt([{ type: "CHECK_FAILED", offline: true, at: 1 }]),
      stateAt([{ type: "CHECK_FAILED", offline: false, at: 1 }]),
    ];
    for (const s of states) {
      const v = softwareUpdateView(s, "0.9.1", 60_000);
      const text = [v.line, v.sub, v.securityLine, v.primary?.label, v.secondary?.label]
        .filter(Boolean)
        .join(" ");
      expect(text).not.toMatch(/—|–/);
    }
  });
});

describe("SoftwareUpdatePane (rendered against a real machine)", () => {
  it("Check for updates is a MANUAL check: it bypasses the automatic cooldown", async () => {
    const clock = { value: 0 };
    const machine = createUpdateMachine({ now: () => clock.value });
    // An automatic check just ran — the cooldown window is fully closed.
    await machine.autoCheck();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    clock.value = UPDATE_CHECK_COOLDOWN_MS - 1;
    await machine.autoCheck();
    expect(mocks.check).toHaveBeenCalledTimes(1); // auto stays gated

    render(<SoftwareUpdatePane appVersion="0.9.1" machine={machine} now={() => clock.value} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    });
    expect(mocks.check).toHaveBeenCalledTimes(2); // manual went straight through
  });

  it("renders the live machine state and updates in place", async () => {
    localStorage.setItem("tl.updateAutoDownload", "0");
    mocks.check.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "0.9.1",
      rawJson: {},
      downloadAndInstall: vi.fn(() => Promise.resolve()),
    });
    const machine = createUpdateMachine({ now: () => 0 });
    render(<SoftwareUpdatePane appVersion="0.9.1" machine={machine} now={() => 0} />);

    await act(() => machine.manualCheck());
    expect(screen.getByText("Version 1.2.0 is available.")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    });
    expect(screen.getByText("Update ready. Restart Throughline to finish.")).toBeInTheDocument();

    // Restart later hides the PILL only — this section keeps the true state.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restart later" }));
    });
    expect(machine.getState().pillDismissed).toBe(true);
    expect(screen.getByText("Update ready. Restart Throughline to finish.")).toBeInTheDocument();

    // Restart now runs the machine's restart (marker, then relaunch).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("the error state's website button hands the EXACT URL to openUrl", async () => {
    mocks.check.mockResolvedValue({
      version: "1.2.0",
      currentVersion: "0.9.1",
      rawJson: {},
      downloadAndInstall: vi.fn(() => Promise.reject(new Error("boom"))),
    });
    const machine = createUpdateMachine({ now: () => 0 });
    render(<SoftwareUpdatePane appVersion="0.9.1" machine={machine} now={() => 0} />);
    await act(() => machine.manualCheck()); // auto-download ON → fails → error
    expect(screen.getByText("We could not complete the update.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download from the website" }));
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
    expect(mocks.openUrl).toHaveBeenCalledWith("https://readthroughline.com/download");
  });

  it("the auto-download toggle defaults ON and persists OFF", () => {
    const machine = createUpdateMachine({ now: () => 0 });
    render(<SoftwareUpdatePane appVersion="0.9.1" machine={machine} now={() => 0} />);
    const toggle = screen.getByRole("switch", { name: "Download updates automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("tl.updateAutoDownload")).toBe("0");
  });
});

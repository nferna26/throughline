import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import UpdateChecker, { updatePillView } from "./UpdateChecker";
import {
  createUpdateMachine,
  initialUpdateState,
  updateReducer,
  UPDATE_BACKSTOP_INTERVAL_MS,
  type UpdateMachineState,
} from "../updateMachine";

// CORE-1192 case law: the old suite mocked window.open and asserted the mock —
// which passed forever while the real button did nothing (window.open is a
// no-op in the wry webview). The fallback now goes through
// @tauri-apps/plugin-opener (mocked HERE, asserted as openUrl in
// updateMachine.test.ts and Settings.test.tsx), plus a real-click Playwright
// e2e (e2e/update.spec.ts) that fires the opener IPC, plus real-app
// verification. Nothing in this suite may assert window.open again.

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
  mocks.check.mockResolvedValue(null); // default: no update, no pill
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
  vi.useRealTimers();
});

function foundUpdate(over: Record<string, unknown> = {}) {
  return {
    version: "0.9.5",
    currentVersion: "0.9.1",
    rawJson: {},
    downloadAndInstall: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

/** Drive a fresh machine into a wanted phase via its real reducer actions. */
function stateAt(actions: Parameters<typeof updateReducer>[1][]): UpdateMachineState {
  return actions.reduce(updateReducer, initialUpdateState());
}

const FOUND = {
  type: "CHECK_FOUND",
  version: "1.0.0",
  currentVersion: "0.9.1",
  critical: false,
  at: 1,
} as const;

describe("updatePillView (pure pill model)", () => {
  it("maps every pill-visible state to its label and action", () => {
    expect(updatePillView(stateAt([FOUND]))).toMatchObject({
      label: "Update ready",
      action: "download",
      dismissable: true,
    });
    expect(updatePillView(stateAt([{ ...FOUND, critical: true }]))).toMatchObject({
      label: "Security update",
      action: "download",
    });
    expect(updatePillView(stateAt([FOUND, { type: "DOWNLOAD_STARTED" }]))).toMatchObject({
      label: "Updating",
      busy: true,
      action: null,
    });
    expect(
      updatePillView(stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FINISHED" }])),
    ).toMatchObject({ label: "Restart to update", action: "restart" });
    expect(
      updatePillView(
        stateAt([FOUND, { type: "DOWNLOAD_STARTED" }, { type: "DOWNLOAD_FAILED", offline: false }]),
      ),
    ).toMatchObject({ label: "Try again", action: "retry", fallback: true });
  });

  it("renders NO pill for hidden/idle states, check failures, or after a dismissal", () => {
    expect(updatePillView(initialUpdateState())).toBeNull();
    expect(updatePillView(stateAt([{ type: "CHECK_STARTED" }]))).toBeNull();
    expect(updatePillView(stateAt([{ type: "CHECK_UP_TO_DATE", at: 1 }]))).toBeNull();
    // CORE-1191: a failed CHECK is never a pill (no update is known to exist).
    expect(updatePillView(stateAt([{ type: "CHECK_FAILED", offline: false, at: 1 }]))).toBeNull();
    expect(updatePillView(stateAt([{ type: "CHECK_FAILED", offline: true, at: 1 }]))).toBeNull();
    expect(updatePillView(stateAt([FOUND, { type: "PILL_DISMISSED" }]))).toBeNull();
  });
});

describe("UpdateChecker pill (rendered against a real machine)", () => {
  it("surfaces Update ready when a check finds an update (auto-download off)", async () => {
    localStorage.setItem("tl.updateAutoDownload", "0");
    mocks.check.mockResolvedValue(foundUpdate());
    const machine = createUpdateMachine({ now: () => 0 });
    render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck());
    expect(screen.getByRole("button", { name: "Update ready" })).toBeInTheDocument();
  });

  it("acts on the FIRST click: one click starts exactly one download", async () => {
    localStorage.setItem("tl.updateAutoDownload", "0");
    const u = foundUpdate();
    mocks.check.mockResolvedValue(u);
    const machine = createUpdateMachine({ now: () => 0 });
    render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck());

    // The handler reads the MACHINE's phase, not captured React state, so the
    // first click acts — and a second (double) click cannot start a second run.
    const pill = screen.getByRole("button", { name: "Update ready" });
    await act(async () => {
      fireEvent.click(pill);
      fireEvent.click(pill);
    });
    expect(u.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("downloads quietly (busy status, no % text), then offers restart without forcing it", async () => {
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
    mocks.check.mockResolvedValue(foundUpdate({ downloadAndInstall }));
    const machine = createUpdateMachine({ now: () => 0 });
    render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck()); // auto-download ON by default

    const updating = screen.getByRole("status");
    expect(updating).toHaveAttribute("aria-busy", "true");
    expect(updating).toHaveTextContent("Updating");
    expect(updating).not.toHaveTextContent("%"); // the pill never shouts numbers
    expect(mocks.relaunch).not.toHaveBeenCalled();

    await act(async () => {
      finishDownload();
    });
    const restart = screen.getByRole("button", { name: "Restart to update" });
    expect(mocks.relaunch).not.toHaveBeenCalled();

    fireEvent.click(restart);
    await act(async () => {});
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_prepare_update_relaunch_focus");
  });

  it("a failed download shows Try again (in-app retry), never an external link", async () => {
    const downloadAndInstall = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("signature mismatch")))
      .mockImplementationOnce(() => Promise.resolve());
    mocks.check.mockResolvedValue(foundUpdate({ downloadAndInstall }));
    const machine = createUpdateMachine({ now: () => 0 });
    render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck());

    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry.closest(".tl-update-pill")?.className).toContain("fallback");
    // Calm copy: no raw error text bleeds into the pill.
    expect(screen.queryByText(/signature|mismatch|error|failed/i)).toBeNull();

    await act(async () => {
      fireEvent.click(retry);
    });
    expect(downloadAndInstall).toHaveBeenCalledTimes(2);
    expect(mocks.openUrl).not.toHaveBeenCalled(); // the pill NEVER opens the website
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeInTheDocument();
  });

  it("a failed launch check (e.g. offline) surfaces NO pill (CORE-1191)", async () => {
    mocks.check.mockRejectedValue(new Error("error sending request for url"));
    const machine = createUpdateMachine({ now: () => 0 });
    const { container } = render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck());
    expect(container).toBeEmptyDOMElement();
  });

  it("dismiss hides the pill for the session while the machine keeps its state", async () => {
    localStorage.setItem("tl.updateAutoDownload", "0");
    mocks.check.mockResolvedValue(foundUpdate());
    const machine = createUpdateMachine({ now: () => 0 });
    render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update" }));
    expect(screen.queryByRole("button", { name: "Update ready" })).toBeNull();
    // The machine still knows the update — Settings keeps rendering it.
    expect(machine.getState().phase).toBe("available");
    expect(machine.getState().version).toBe("0.9.5");
  });

  it("renders a Security update pill for a critical update (dismissable, resurfaces once)", async () => {
    localStorage.setItem("tl.updateAutoDownload", "0");
    mocks.check.mockResolvedValue(foundUpdate({ rawJson: { severity: "critical" } }));
    const machine = createUpdateMachine({ now: () => 0 });
    render(<UpdateChecker machine={machine} />);
    await act(() => machine.autoCheck());

    const pill = screen.getByRole("button", { name: "Security update" });
    expect(pill.closest(".tl-update-pill")?.className).toContain("critical");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update" }));
    expect(screen.queryByRole("button", { name: "Security update" })).toBeNull();

    // The next check re-finds it: the once-per-launch resurface brings it back.
    await act(() => machine.manualCheck());
    expect(screen.getByRole("button", { name: "Security update" })).toBeInTheDocument();
  });

  it("respects visible={false} without stopping the machine", async () => {
    localStorage.setItem("tl.updateAutoDownload", "0");
    mocks.check.mockResolvedValue(foundUpdate());
    const machine = createUpdateMachine({ now: () => 0 });
    const { container } = render(<UpdateChecker visible={false} machine={machine} />);
    await act(() => machine.autoCheck());
    expect(container).toBeEmptyDOMElement();
    expect(machine.getState().phase).toBe("available");
  });

  it("never disturbs the reader's scroll when the pill appears", async () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollTo = scrollTo as typeof window.scrollTo;
    try {
      localStorage.setItem("tl.updateAutoDownload", "0");
      mocks.check.mockResolvedValue(foundUpdate());
      const machine = createUpdateMachine({ now: () => 0 });
      render(<UpdateChecker machine={machine} />);
      await act(() => machine.autoCheck());
      expect(screen.getByRole("button", { name: "Update ready" })).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("starts the automatic cadence on mount and tears it down on unmount", async () => {
    vi.useFakeTimers();
    const machine = createUpdateMachine({ now: () => 0 });
    const { unmount } = render(<UpdateChecker machine={machine} />);
    unmount();
    // No trigger fires anything after teardown.
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_BACKSTOP_INTERVAL_MS);
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });
});

describe("window.open stays banned (CORE-1192)", () => {
  // The masked-bug pattern: window.open silently no-ops in wry, so a mocked
  // assertion on it proves nothing. Pin that no update-path source ever
  // reaches for it again — the opener plugin is the one way out.
  const sources = import.meta.glob(["../updateMachine.ts", "./UpdateChecker.tsx", "./SoftwareUpdate.tsx"], {
    eager: true,
    query: "?raw",
    import: "default",
  }) as Record<string, string>;

  it("no update-path source calls window.open", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const [file, code] of Object.entries(sources)) {
      expect(code, `${file} must use the opener plugin, not window.open`).not.toMatch(
        /window\.open\(/,
      );
    }
  });
});

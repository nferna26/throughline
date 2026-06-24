import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import UpdateChecker, {
  FALLBACK_DOWNLOAD_URL,
  UPDATE_INITIAL_CHECK_DELAY_MS,
  UPDATE_CHECK_COOLDOWN_MS,
  UPDATE_BACKSTOP_INTERVAL_MS,
  UPDATE_HEARTBEAT_MS,
  UPDATE_WAKE_GAP_MS,
  backstopDue,
  updateCheckAllowed,
  updatePillView,
  wakeDetected,
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
  mocks.check.mockReset();
  mocks.check.mockResolvedValue(null); // default: no update, no pill
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
  vi.useRealTimers();
});

// A test-controlled logical clock, injected via the `now` prop and decoupled from
// the fake-timer scheduling clock, so a callback can be made to observe an
// arbitrary "now" (e.g. a sleep jump) when it fires.
function makeClock(start = 0) {
  const clock = { value: start };
  return { clock, now: () => clock.value };
}

describe("cadence helpers (pure, time-injected)", () => {
  it("allows the first check, then gates the rest to the cooldown", () => {
    expect(updateCheckAllowed(null, 12345)).toBe(true); // first check always allowed
    expect(updateCheckAllowed(1000, 1000 + UPDATE_CHECK_COOLDOWN_MS - 1)).toBe(false);
    expect(updateCheckAllowed(1000, 1000 + UPDATE_CHECK_COOLDOWN_MS)).toBe(true);
  });

  it("flags a wake only when the heartbeat gap exceeds the wake threshold", () => {
    expect(wakeDetected(null, 9_999_999)).toBe(false); // no prior tick
    expect(wakeDetected(0, UPDATE_WAKE_GAP_MS)).toBe(false); // exactly at threshold, not past
    expect(wakeDetected(0, UPDATE_WAKE_GAP_MS + 1)).toBe(true);
  });

  it("makes the backstop due only 6h after a real check", () => {
    expect(backstopDue(null, UPDATE_BACKSTOP_INTERVAL_MS)).toBe(false); // no check yet
    expect(backstopDue(0, UPDATE_BACKSTOP_INTERVAL_MS - 1)).toBe(false);
    expect(backstopDue(0, UPDATE_BACKSTOP_INTERVAL_MS)).toBe(true);
  });
});

describe("UpdateChecker pill model", () => {
  it("maps every visible state to the shipped pill label", () => {
    expect(updatePillView("ready")).toMatchObject({ label: "Update ready", icon: "download", busy: false, fallback: false });
    expect(updatePillView("updating")).toMatchObject({ label: "Updating", icon: "download", busy: true, fallback: false });
    expect(updatePillView("restart")).toMatchObject({ label: "Restart to update", icon: "restart", busy: false, fallback: false });
    expect(updatePillView("fallback")).toMatchObject({ label: "Download update", icon: "download", busy: false, fallback: true });
  });
});

describe("UpdateChecker cadence (the four triggers, one funnel)", () => {
  it("does not check on first paint, then checks once after the launch delay", async () => {
    vi.useFakeTimers();
    const { now } = makeClock(0);
    render(<UpdateChecker now={now} />);

    expect(mocks.check).not.toHaveBeenCalled(); // first paint: nothing
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_INITIAL_CHECK_DELAY_MS);
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("checks on focus/visibility outside the cooldown, and not within it", async () => {
    vi.useFakeTimers();
    const { clock, now } = makeClock(0);
    render(<UpdateChecker now={now} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.check).toHaveBeenCalledTimes(1); // first check allowed

    await act(async () => {
      window.dispatchEvent(new Event("focus")); // still within cooldown
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.check).toHaveBeenCalledTimes(1); // cooldown held

    clock.value = UPDATE_CHECK_COOLDOWN_MS; // cooldown elapsed
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("checks after a wake (a heartbeat gap past the wake threshold), cooldown permitting", async () => {
    vi.useFakeTimers();
    const { clock, now } = makeClock(0);
    render(<UpdateChecker now={now} />);

    // The launch check stamps lastCheckAt; ignore it.
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_INITIAL_CHECK_DELAY_MS);
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    mocks.check.mockClear();

    // The laptop slept well past the cooldown; one heartbeat tick observes the gap.
    clock.value = UPDATE_CHECK_COOLDOWN_MS + UPDATE_WAKE_GAP_MS;
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_HEARTBEAT_MS);
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("does not wake-check on a normal heartbeat tick (small gap)", async () => {
    vi.useFakeTimers();
    render(<UpdateChecker now={() => Date.now()} />);
    // Let the launch check run, then forget it.
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_INITIAL_CHECK_DELAY_MS);
    });
    mocks.check.mockClear();
    // A handful of ordinary 60s ticks (each gap = 60s < wake gap) → no checks.
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_HEARTBEAT_MS * 5);
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("fires the backstop about 6h after the last check, with no wake in between", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    render(<UpdateChecker now={() => Date.now()} />);

    await act(async () => {
      vi.advanceTimersByTime(UPDATE_INITIAL_CHECK_DELAY_MS);
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    mocks.check.mockClear();

    // Steady 60s ticks (never a wake) until the 6h backstop elapses since the check.
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_BACKSTOP_INTERVAL_MS + UPDATE_HEARTBEAT_MS);
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });

  it("holds a single in-flight check across overlapping triggers", async () => {
    vi.useFakeTimers();
    let resolveCheck: (v: unknown) => void = () => {};
    mocks.check.mockReturnValue(new Promise((r) => { resolveCheck = r; }));
    const { now } = makeClock(0);
    render(<UpdateChecker now={now} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(UPDATE_INITIAL_CHECK_DELAY_MS); // the launch trigger too
    });
    expect(mocks.check).toHaveBeenCalledTimes(1); // single-flight held

    await act(async () => {
      resolveCheck(null);
    });
  });

  it("removes its listeners and timers on unmount", async () => {
    vi.useFakeTimers();
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const removeWin = vi.spyOn(window, "removeEventListener");
    const clearInt = vi.spyOn(globalThis, "clearInterval");
    const clearTo = vi.spyOn(globalThis, "clearTimeout");
    const { now } = makeClock(0);
    const { unmount } = render(<UpdateChecker now={now} />);

    unmount();
    expect(removeDoc).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(removeWin).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(clearInt).toHaveBeenCalled();
    expect(clearTo).toHaveBeenCalled();

    // No trigger fires anything after teardown.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(UPDATE_BACKSTOP_INTERVAL_MS);
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });
});

describe("UpdateChecker pill (debounce / no re-nag)", () => {
  it("surfaces Update ready when a check finds an update", async () => {
    mocks.check.mockResolvedValue({ version: "0.9.0", downloadAndInstall: vi.fn() });
    render(<UpdateChecker now={() => 0} />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("button", { name: "Update ready" })).toBeInTheDocument();
  });

  it("does not re-animate the pill on a same-version re-check, and never re-shows a dismissed version", async () => {
    mocks.check.mockResolvedValue({ version: "0.9.0", downloadAndInstall: vi.fn() });
    const { clock } = makeClock(0);
    render(<UpdateChecker now={() => clock.value} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    const pill = await screen.findByRole("button", { name: "Update ready" });

    // A later, cooldown-clearing trigger leaves the SAME node in place and does not
    // even re-run the check (a pill is already showing).
    clock.value = UPDATE_CHECK_COOLDOWN_MS;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("button", { name: "Update ready" })).toBe(pill);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    // Dismiss → hidden; a later same-version check does not bring it back.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss update" }));
    expect(screen.queryByRole("button", { name: "Update ready" })).toBeNull();

    clock.value = 3 * UPDATE_CHECK_COOLDOWN_MS;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.check).toHaveBeenCalledTimes(2); // the re-check ran...
    expect(screen.queryByRole("button", { name: "Update ready" })).toBeNull(); // ...but the version was dismissed
  });

  it("never disturbs the reader's scroll when the pill appears", async () => {
    // jsdom defines neither; install no-op spies and assert the pill never reaches
    // for them (the pill is position:fixed and touches no scroll position).
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.scrollTo = scrollTo as typeof window.scrollTo;
    try {
      mocks.check.mockResolvedValue({ version: "0.9.0", downloadAndInstall: vi.fn() });
      render(<UpdateChecker now={() => 0} />);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(await screen.findByRole("button", { name: "Update ready" })).toBeInTheDocument();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe("UpdateChecker action flow (unchanged download/install/restart)", () => {
  it("turns a check failure into the fallback download pill with no error copy", async () => {
    mocks.check.mockRejectedValue(new Error("Could not fetch a valid release JSON from the remote"));
    render(<UpdateChecker now={() => 0} />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    const fallback = await screen.findByRole("button", { name: "Download update" });
    expect(fallback.closest(".tl-update-pill")?.className).toContain("fallback");
    expect(screen.queryByText(/JSON|remote|error|failed|couldn/i)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("check failed"),
      expect.any(Error),
    );

    fireEvent.click(fallback);
    expect(window.open).toHaveBeenCalledWith(FALLBACK_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
  });

  it("downloads in place, exposes Updating as busy/live, then offers restart without forcing it", async () => {
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
    render(<UpdateChecker now={() => 0} />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

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
    const downloadAndInstall = vi.fn(() => Promise.reject(new Error("signature mismatch")));
    mocks.check.mockResolvedValue({ version: "0.8.0", downloadAndInstall });
    render(<UpdateChecker now={() => 0} />);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    fireEvent.click(await screen.findByRole("button", { name: "Update ready" }));
    expect(await screen.findByRole("button", { name: "Download update" })).toBeInTheDocument();
    expect(screen.queryByText(/signature|mismatch|error|failed/i)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("download failed"),
      expect.any(Error),
    );
  });
});

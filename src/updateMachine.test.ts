import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_DOWNLOAD_KEY,
  FALLBACK_DOWNLOAD_URL,
  UPDATE_BACKSTOP_INTERVAL_MS,
  UPDATE_CHECK_COOLDOWN_MS,
  UPDATE_HEARTBEAT_MS,
  UPDATE_INITIAL_CHECK_DELAY_MS,
  UPDATE_WAKE_GAP_MS,
  backstopDue,
  createUpdateMachine,
  initialUpdateState,
  isCriticalUpdate,
  semverLt,
  updateCheckAllowed,
  updatePillVisible,
  updateReducer,
  wakeDetected,
  type UpdateMachineState,
} from "./updateMachine";

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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// A test-controlled logical clock, injected into the machine and decoupled from
// the fake-timer scheduling clock.
function makeClock(start = 0) {
  const clock = { value: start };
  return { clock, now: () => clock.value };
}

function foundUpdate(over: Record<string, unknown> = {}) {
  return {
    version: "0.9.5",
    currentVersion: "0.9.1",
    rawJson: {},
    downloadAndInstall: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

/** A download whose completion the test controls, emitting Started/Progress.
 *  Pass no argument for an unknown content length. */
function controllableDownload(contentLength?: number) {
  let finish: () => void = () => {
    throw new Error("download not started");
  };
  let fail: (e: unknown) => void = () => {
    throw new Error("download not started");
  };
  const downloadAndInstall = vi.fn((onEvent: (ev: unknown) => void) => {
    onEvent({ event: "Started", data: { contentLength } });
    if (contentLength) onEvent({ event: "Progress", data: { chunkLength: contentLength * 0.42 } });
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  });
  return { downloadAndInstall, finish: () => finish(), fail: (e: unknown) => fail(e) };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("cadence helpers (pure, time-injected)", () => {
  it("allows the first check, then gates the rest to the cooldown", () => {
    expect(updateCheckAllowed(null, 12345)).toBe(true);
    expect(updateCheckAllowed(1000, 1000 + UPDATE_CHECK_COOLDOWN_MS - 1)).toBe(false);
    expect(updateCheckAllowed(1000, 1000 + UPDATE_CHECK_COOLDOWN_MS)).toBe(true);
  });

  it("flags a wake only when the heartbeat gap exceeds the wake threshold", () => {
    expect(wakeDetected(null, 9_999_999)).toBe(false);
    expect(wakeDetected(0, UPDATE_WAKE_GAP_MS)).toBe(false);
    expect(wakeDetected(0, UPDATE_WAKE_GAP_MS + 1)).toBe(true);
  });

  it("makes the backstop due only 6h after a real check", () => {
    expect(backstopDue(null, UPDATE_BACKSTOP_INTERVAL_MS)).toBe(false);
    expect(backstopDue(0, UPDATE_BACKSTOP_INTERVAL_MS - 1)).toBe(false);
    expect(backstopDue(0, UPDATE_BACKSTOP_INTERVAL_MS)).toBe(true);
  });
});

describe("semverLt (tiny numeric x.y.z compare)", () => {
  it("compares numerically, ignoring pre-release, missing segments as 0", () => {
    expect(semverLt("0.8.3", "0.8.4")).toBe(true);
    expect(semverLt("0.8.4", "0.8.4")).toBe(false);
    expect(semverLt("0.10.0", "0.9.0")).toBe(false);
    expect(semverLt("0.9.0", "0.10.0")).toBe(true);
    expect(semverLt("0.8.3-beta.1", "0.8.3")).toBe(false);
    expect(semverLt("1.0", "1.0.1")).toBe(true);
  });
});

describe("isCriticalUpdate (defensive manifest read)", () => {
  it("is critical when severity=critical and no criticalBelow", () => {
    expect(isCriticalUpdate({ severity: "critical" }, "0.8.3")).toBe(true);
  });
  it("respects criticalBelow as a version floor", () => {
    expect(isCriticalUpdate({ severity: "critical", criticalBelow: "0.9.0" }, "0.8.3")).toBe(true);
    expect(isCriticalUpdate({ severity: "critical", criticalBelow: "0.9.0" }, "0.9.0")).toBe(false);
    expect(isCriticalUpdate({ severity: "critical", criticalBelow: "0.8.3" }, "0.8.3")).toBe(false);
  });
  it("fails safe to routine on any malformed/missing field", () => {
    expect(isCriticalUpdate(undefined, "0.8.3")).toBe(false);
    expect(isCriticalUpdate(null, "0.8.3")).toBe(false);
    expect(isCriticalUpdate({}, "0.8.3")).toBe(false);
    expect(isCriticalUpdate({ severity: "high" }, "0.8.3")).toBe(false);
    expect(isCriticalUpdate({ severity: 1 }, "0.8.3")).toBe(false);
    expect(isCriticalUpdate({ severity: "critical", criticalBelow: "not-a-version" }, "0.8.3")).toBe(false);
    expect(isCriticalUpdate({ severity: "critical", criticalBelow: {} }, "0.8.3")).toBe(false);
    expect(isCriticalUpdate({ severity: "critical", criticalBelow: "0.9.0" }, "garbage")).toBe(false);
  });
});

describe("updateReducer (pure transitions)", () => {
  const base = (): UpdateMachineState => ({ ...initialUpdateState(), autoDownload: true });

  it("walks the happy path: idle -> checking -> available -> downloading -> readyToRestart -> relaunching", () => {
    let s = base();
    s = updateReducer(s, { type: "CHECK_STARTED" });
    expect(s.phase).toBe("checking");
    s = updateReducer(s, { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: false, at: 5 });
    expect(s.phase).toBe("available");
    expect(s.version).toBe("1.0.0");
    expect(s.lastCheckedAt).toBe(5);
    s = updateReducer(s, { type: "DOWNLOAD_STARTED" });
    expect(s.phase).toBe("downloading");
    s = updateReducer(s, { type: "DOWNLOAD_PROGRESS", pct: 42 });
    expect(s.progressPct).toBe(42);
    s = updateReducer(s, { type: "DOWNLOAD_FINISHED" });
    expect(s.phase).toBe("readyToRestart");
    s = updateReducer(s, { type: "RESTART_STARTED" });
    expect(s.phase).toBe("relaunching");
  });

  it("resolves an empty check to upToDate with the check time stamped", () => {
    let s = updateReducer(base(), { type: "CHECK_STARTED" });
    s = updateReducer(s, { type: "CHECK_UP_TO_DATE", at: 99 });
    expect(s.phase).toBe("upToDate");
    expect(s.lastCheckedAt).toBe(99);
  });

  it("keeps check failures off the pill but visible to Settings (CORE-1191)", () => {
    let s = updateReducer(base(), { type: "CHECK_STARTED" });
    s = updateReducer(s, { type: "CHECK_FAILED", offline: false, at: 7 });
    expect(s.phase).toBe("error");
    expect(s.errorKind).toBe("check");
    expect(updatePillVisible(s)).toBe(false); // no phantom pill
    s = updateReducer(s, { type: "CHECK_STARTED" }); // funnel never freezes
    expect(s.phase).toBe("checking");
    expect(s.errorKind).toBeNull();
  });

  it("marks offline failures distinctly", () => {
    const s = updateReducer(base(), { type: "CHECK_FAILED", offline: true, at: 7 });
    expect(s.errorKind).toBe("offline");
    expect(updatePillVisible(s)).toBe(false);
  });

  it("download/restart failures DO surface the pill, as Try again", () => {
    let s = updateReducer(base(), { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: false, at: 1 });
    s = updateReducer(s, { type: "DOWNLOAD_STARTED" });
    s = updateReducer(s, { type: "DOWNLOAD_FAILED", offline: false });
    expect(s.phase).toBe("error");
    expect(s.errorKind).toBe("download");
    expect(updatePillVisible(s)).toBe(true);
    s = updateReducer(s, { type: "RETRY_DOWNLOAD" });
    expect(s.phase).toBe("available");
    expect(s.errorKind).toBeNull();
  });

  it("a failed relaunch steps back through RETRY_RESTART", () => {
    let s = updateReducer(base(), { type: "RESTART_FAILED" });
    expect(s.errorKind).toBe("restart");
    expect(updatePillVisible(s)).toBe(true);
    s = updateReducer(s, { type: "RETRY_RESTART" });
    expect(s.phase).toBe("readyToRestart");
  });

  it("dismissing hides the PILL only, bound to the dismissed version", () => {
    let s = updateReducer(base(), { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: false, at: 1 });
    s = updateReducer(s, { type: "PILL_DISMISSED" });
    expect(s.pillDismissed).toBe(true);
    expect(s.phase).toBe("available"); // the machine keeps its true state
    expect(updatePillVisible(s)).toBe(false);
    // The SAME routine version stays waved off…
    s = updateReducer(s, { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: false, at: 2 });
    expect(s.pillDismissed).toBe(true);
    // …but a NEWER version surfaces the pill again.
    s = updateReducer(s, { type: "CHECK_FOUND", version: "1.0.1", currentVersion: "0.9.1", critical: false, at: 3 });
    expect(s.pillDismissed).toBe(false);
  });

  it("a critical update re-surfaces a dismissed pill exactly once per launch", () => {
    let s = updateReducer(base(), { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: true, at: 1 });
    s = updateReducer(s, { type: "PILL_DISMISSED" });
    expect(updatePillVisible(s)).toBe(false);
    // Re-found critical: the one resurface.
    s = updateReducer(s, { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: true, at: 2 });
    expect(s.pillDismissed).toBe(false);
    expect(s.criticalResurfaceUsed).toBe(true);
    // Dismissed again: it stays down this launch.
    s = updateReducer(s, { type: "PILL_DISMISSED" });
    s = updateReducer(s, { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: true, at: 3 });
    expect(s.pillDismissed).toBe(true);
  });

  it("the once-per-launch resurface also fires when a dismissed critical download finishes", () => {
    let s = updateReducer(base(), { type: "CHECK_FOUND", version: "1.0.0", currentVersion: "0.9.1", critical: true, at: 1 });
    s = updateReducer(s, { type: "DOWNLOAD_STARTED" });
    s = updateReducer(s, { type: "PILL_DISMISSED" });
    s = updateReducer(s, { type: "DOWNLOAD_FINISHED" });
    expect(s.phase).toBe("readyToRestart");
    expect(s.pillDismissed).toBe(false);
    expect(s.criticalResurfaceUsed).toBe(true);
  });
});

describe("update machine controller (mocked plugins)", () => {
  it("auto-download ON by default: a found update advances straight to readyToRestart", async () => {
    const dl = controllableDownload(100);
    mocks.check.mockResolvedValue(foundUpdate({ downloadAndInstall: dl.downloadAndInstall }));
    const { now } = makeClock(0);
    const m = createUpdateMachine({ now });

    await m.autoCheck();
    expect(m.getState().phase).toBe("downloading");
    expect(m.getState().progressPct).toBe(42);
    dl.finish();
    await flush();
    expect(m.getState().phase).toBe("readyToRestart");
    expect(m.getState().progressPct).toBe(100);
  });

  it("size unknown: progress stays null (no fabricated percent)", async () => {
    const dl = controllableDownload();
    mocks.check.mockResolvedValue(foundUpdate({ downloadAndInstall: dl.downloadAndInstall }));
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    expect(m.getState().phase).toBe("downloading");
    expect(m.getState().progressPct).toBeNull();
    dl.finish();
    await flush();
    expect(m.getState().phase).toBe("readyToRestart");
  });

  it("auto-download OFF: the update waits at available until download() is asked", async () => {
    localStorage.setItem(AUTO_DOWNLOAD_KEY, "0");
    const u = foundUpdate();
    mocks.check.mockResolvedValue(u);
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    expect(m.getState().phase).toBe("available");
    expect(u.downloadAndInstall).not.toHaveBeenCalled();
    await m.download();
    expect(u.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(m.getState().phase).toBe("readyToRestart");
  });

  it("turning the auto-download toggle ON while an update sits available starts the download", async () => {
    localStorage.setItem(AUTO_DOWNLOAD_KEY, "0");
    const u = foundUpdate();
    mocks.check.mockResolvedValue(u);
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    expect(m.getState().phase).toBe("available");
    m.setAutoDownload(true);
    expect(localStorage.getItem(AUTO_DOWNLOAD_KEY)).toBe("1");
    await flush();
    expect(u.downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("automatic checks respect the cooldown; a manual check bypasses it", async () => {
    const { clock, now } = makeClock(0);
    const m = createUpdateMachine({ now });

    await m.autoCheck();
    expect(mocks.check).toHaveBeenCalledTimes(1);

    clock.value = UPDATE_CHECK_COOLDOWN_MS - 1;
    await m.autoCheck(); // inside the cooldown → gated
    expect(mocks.check).toHaveBeenCalledTimes(1);

    await m.manualCheck(); // the reader asked → never gated
    expect(mocks.check).toHaveBeenCalledTimes(2);

    clock.value = 2 * UPDATE_CHECK_COOLDOWN_MS;
    await m.autoCheck(); // cooldown elapsed → allowed again
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("holds a single in-flight check across overlapping triggers", async () => {
    let resolveCheck: (v: unknown) => void = () => {};
    mocks.check.mockReturnValue(new Promise((r) => (resolveCheck = r)));
    const m = createUpdateMachine({ now: () => 0 });
    const first = m.autoCheck();
    void m.manualCheck();
    void m.autoCheck();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    resolveCheck(null);
    await first;
    expect(m.getState().phase).toBe("upToDate");
  });

  it("no check can start while downloading or waiting on a restart (forward-only)", async () => {
    const dl = controllableDownload(100);
    mocks.check.mockResolvedValue(foundUpdate({ downloadAndInstall: dl.downloadAndInstall }));
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    expect(m.getState().phase).toBe("downloading");
    await m.manualCheck();
    expect(mocks.check).toHaveBeenCalledTimes(1); // no re-entry mid-download
    dl.finish();
    await flush();
    expect(m.getState().phase).toBe("readyToRestart");
    await m.manualCheck();
    expect(mocks.check).toHaveBeenCalledTimes(1); // still parked on restart
  });

  it("a failed check surfaces NO pill and does not freeze later checks (CORE-1191)", async () => {
    mocks.check
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce(foundUpdate());
    const { clock, now } = makeClock(0);
    const m = createUpdateMachine({ now });

    await m.autoCheck();
    expect(m.getState().phase).toBe("error");
    expect(m.getState().errorKind).toBe("check");
    expect(updatePillVisible(m.getState())).toBe(false);

    clock.value = UPDATE_CHECK_COOLDOWN_MS;
    await m.autoCheck(); // the next trigger really checks
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(m.getState().phase).not.toBe("error");
  });

  it("a failed check while offline lands in the offline state; coming back online re-checks", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get");
    onLine.mockReturnValue(false);
    mocks.check.mockRejectedValueOnce(new Error("error sending request"));
    const { now } = makeClock(0);
    const m = createUpdateMachine({ now });

    await m.autoCheck();
    expect(m.getState().errorKind).toBe("offline");

    // Back online: the promised automatic re-check runs even inside the cooldown.
    onLine.mockReturnValue(true);
    mocks.check.mockResolvedValueOnce(null);
    m.onBackOnline();
    await flush();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(m.getState().phase).toBe("upToDate");
  });

  it("onBackOnline is scoped to the offline state (never a stray check)", async () => {
    const m = createUpdateMachine({ now: () => 0 });
    m.onBackOnline();
    await flush();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("error -> retry re-runs the failed download in-app; success reaches readyToRestart", async () => {
    const failing = vi.fn((): Promise<void> => Promise.reject(new Error("signature mismatch")));
    const u = foundUpdate({ downloadAndInstall: failing });
    mocks.check.mockResolvedValue(u);
    const m = createUpdateMachine({ now: () => 0 });

    await m.autoCheck();
    await flush();
    expect(m.getState().phase).toBe("error");
    expect(m.getState().errorKind).toBe("download");
    expect(updatePillVisible(m.getState())).toBe(true); // "Try again" pill

    failing.mockImplementationOnce(() => Promise.resolve());
    await m.retry();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(m.getState().phase).toBe("readyToRestart");
    // In-app retry, never the external page:
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("retry after a failed CHECK runs a fresh check (cooldown-free)", async () => {
    mocks.check.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(null);
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    expect(m.getState().errorKind).toBe("check");
    await m.retry(); // still inside the cooldown — retry is reader-initiated
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(m.getState().phase).toBe("upToDate");
  });

  it("restart prepares the relaunch-focus marker BEFORE relaunching", async () => {
    mocks.check.mockResolvedValue(foundUpdate());
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    await flush();
    expect(m.getState().phase).toBe("readyToRestart");

    await m.restart();
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_prepare_update_relaunch_focus");
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
    const markerOrder = mocks.invoke.mock.invocationCallOrder.find(
      (_, i) => mocks.invoke.mock.calls[i]?.[0] === "cmd_prepare_update_relaunch_focus",
    );
    expect(markerOrder).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
    expect(m.getState().phase).toBe("relaunching");
  });

  it("a failed relaunch consumes the marker and lands in the restart error; retry re-offers it", async () => {
    mocks.check.mockResolvedValue(foundUpdate());
    mocks.relaunch.mockRejectedValueOnce(new Error("spawn failed"));
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    await flush();

    await m.restart();
    expect(m.getState().phase).toBe("error");
    expect(m.getState().errorKind).toBe("restart");
    await flush();
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_consume_update_relaunch_focus");

    mocks.relaunch.mockResolvedValueOnce(undefined);
    await m.retry();
    expect(mocks.relaunch).toHaveBeenCalledTimes(2);
    expect(m.getState().phase).toBe("relaunching");
  });

  it("restart is idempotent: a second click while relaunching is a no-op", async () => {
    mocks.check.mockResolvedValue(foundUpdate());
    let resolveRelaunch: () => void = () => {};
    mocks.relaunch.mockImplementation(() => new Promise<void>((r) => (resolveRelaunch = r)));
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    await flush();

    const first = m.restart();
    void m.restart(); // double-click
    await flush(); // let the marker invoke settle and relaunch begin
    void m.restart(); // triple-click, mid-relaunch
    resolveRelaunch();
    await first;
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });

  it("dismissing the pill never pauses the machine (download still completes)", async () => {
    const dl = controllableDownload(100);
    mocks.check.mockResolvedValue(foundUpdate({ downloadAndInstall: dl.downloadAndInstall }));
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    m.dismissPill();
    expect(updatePillVisible(m.getState())).toBe(false);
    dl.finish();
    await flush();
    expect(m.getState().phase).toBe("readyToRestart"); // Settings still shows the truth
  });

  it("openWebsiteDownload hands the EXACT public URL to the opener plugin", () => {
    const m = createUpdateMachine({ now: () => 0 });
    m.openWebsiteDownload();
    expect(mocks.openUrl).toHaveBeenCalledWith(FALLBACK_DOWNLOAD_URL);
    expect(mocks.openUrl).toHaveBeenCalledWith("https://readthroughline.com/download");
  });

  it("reads a critical manifest into the critical flag", async () => {
    mocks.check.mockResolvedValue(
      foundUpdate({ rawJson: { severity: "critical" }, currentVersion: "0.9.1" }),
    );
    localStorage.setItem(AUTO_DOWNLOAD_KEY, "0");
    const m = createUpdateMachine({ now: () => 0 });
    await m.autoCheck();
    expect(m.getState().phase).toBe("available");
    expect(m.getState().critical).toBe(true);
  });
});

describe("update machine automatic triggers (startTriggers)", () => {
  it("does not check on start, then checks once after the launch delay", async () => {
    vi.useFakeTimers();
    const m = createUpdateMachine({ now: () => 0 });
    const stop = m.startTriggers();
    expect(mocks.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_CHECK_DELAY_MS);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    stop();
  });

  it("checks on focus/visibility outside the cooldown, and not within it", async () => {
    vi.useFakeTimers();
    const { clock, now } = makeClock(0);
    const m = createUpdateMachine({ now });
    const stop = m.startTriggers();

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.check).toHaveBeenCalledTimes(1); // cooldown held

    clock.value = UPDATE_CHECK_COOLDOWN_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("checks after a wake (a heartbeat gap past the threshold), cooldown permitting", async () => {
    vi.useFakeTimers();
    const { clock, now } = makeClock(0);
    const m = createUpdateMachine({ now });
    const stop = m.startTriggers();

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_CHECK_DELAY_MS);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    // The laptop slept well past the cooldown; one heartbeat tick observes the gap.
    clock.value = UPDATE_CHECK_COOLDOWN_MS + UPDATE_WAKE_GAP_MS;
    await vi.advanceTimersByTimeAsync(UPDATE_HEARTBEAT_MS);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not wake-check on normal heartbeat ticks (small gaps)", async () => {
    vi.useFakeTimers();
    const { clock, now } = makeClock(0);
    const m = createUpdateMachine({ now });
    const stop = m.startTriggers();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_CHECK_DELAY_MS);
    mocks.check.mockClear();
    for (let i = 0; i < 5; i++) {
      clock.value += UPDATE_HEARTBEAT_MS;
      await vi.advanceTimersByTimeAsync(UPDATE_HEARTBEAT_MS);
    }
    expect(mocks.check).not.toHaveBeenCalled();
    stop();
  });

  it("fires the backstop about 6h after the last check, with no wake in between", async () => {
    vi.useFakeTimers();
    const { clock, now } = makeClock(0);
    const m = createUpdateMachine({ now });
    const stop = m.startTriggers();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_CHECK_DELAY_MS);
    expect(mocks.check).toHaveBeenCalledTimes(1);

    // Steady 60s ticks (never a wake) until the 6h backstop elapses.
    const ticks = Math.ceil(UPDATE_BACKSTOP_INTERVAL_MS / UPDATE_HEARTBEAT_MS) + 1;
    for (let i = 0; i < ticks; i++) {
      clock.value += UPDATE_HEARTBEAT_MS;
      await vi.advanceTimersByTimeAsync(UPDATE_HEARTBEAT_MS);
    }
    expect(mocks.check).toHaveBeenCalledTimes(2);
    stop();
  });

  it("tears everything down: no trigger fires after stop()", async () => {
    vi.useFakeTimers();
    const m = createUpdateMachine({ now: () => 0 });
    const stop = m.startTriggers();
    stop();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(UPDATE_BACKSTOP_INTERVAL_MS);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("the online event funnels through the offline-recovery path", async () => {
    vi.useFakeTimers();
    const onLine = vi.spyOn(navigator, "onLine", "get");
    onLine.mockReturnValue(false);
    mocks.check.mockRejectedValueOnce(new Error("offline"));
    const m = createUpdateMachine({ now: () => 0 });
    const stop = m.startTriggers();
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_CHECK_DELAY_MS);
    expect(m.getState().errorKind).toBe("offline");

    onLine.mockReturnValue(true);
    mocks.check.mockResolvedValueOnce(null);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(m.getState().phase).toBe("upToDate");
    stop();
  });
});

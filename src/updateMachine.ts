import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";

// CORE-1192/1193 — ONE update state machine. The pill (UpdateChecker) and the
// Settings "Software Update" section both subscribe to this module-level store,
// so there is exactly one source of truth: dismissing the pill never hides the
// state from Settings, and every button acts on the machine's CURRENT phase
// (module state, not stale React state) — which is what makes the primary
// action first-click reliable.
//
// Phases: idle -> checking -> (upToDate | available) -> downloading(progress)
// -> readyToRestart -> relaunching; plus error. `critical` rides alongside.
// macOS downloadAndInstall does NOT relaunch — the reader's explicit Restart
// click calls relaunch(); nothing here forces a modal or a restart.

export const FALLBACK_DOWNLOAD_URL = "https://readthroughline.com/download";

// CORE-1159 — event-driven cadence, unchanged: four AUTOMATIC triggers (launch,
// focus/visibility, wake heartbeat, 6h backstop) funnel through one
// cooldown-gated autoCheck(). A MANUAL check (Settings button, app menu) always
// bypasses the cooldown — the reader asked, so we check (CORE-1193).
export const UPDATE_INITIAL_CHECK_DELAY_MS = 8_000; // launch: check 8s after mount
export const UPDATE_CHECK_COOLDOWN_MS = 30 * 60_000; // min spacing between AUTOMATIC checks
export const UPDATE_BACKSTOP_INTERVAL_MS = 6 * 60 * 60_000; // force a check if 6h pass untouched
export const UPDATE_HEARTBEAT_MS = 60_000; // the metronome that detects wake + backstop
export const UPDATE_WAKE_GAP_MS = 2 * 60_000; // a heartbeat gap past this means the machine slept

/** Setting: download a found update in the background automatically (default ON).
 *  Stored in localStorage like the other frontend-only preferences. */
export const AUTO_DOWNLOAD_KEY = "tl.updateAutoDownload";

// ── Pure, time-injected cadence helpers (testable without a DOM/clock) ────────

/**
 * The cooldown gate for the autoCheck() funnel: an automatic check is allowed
 * only when none has run yet (lastCheckAt === null) or the cooldown has fully
 * elapsed. Manual checks never consult this.
 */
export function updateCheckAllowed(
  lastCheckAt: number | null,
  now: number,
  cooldownMs = UPDATE_CHECK_COOLDOWN_MS,
): boolean {
  return lastCheckAt === null || now - lastCheckAt >= cooldownMs;
}

/**
 * The machine slept (or the timer was throttled) if the observed wall-clock gap
 * since the last heartbeat tick exceeds the wake threshold — far longer than the
 * heartbeat interval, so a normal tick never trips it.
 */
export function wakeDetected(
  lastTickAt: number | null,
  now: number,
  gapMs = UPDATE_WAKE_GAP_MS,
): boolean {
  return lastTickAt !== null && now - lastTickAt > gapMs;
}

/**
 * The backstop is due when a check has run and the backstop interval has elapsed
 * since — the safety net for a continuously-awake window that never refocuses.
 */
export function backstopDue(
  lastCheckAt: number | null,
  now: number,
  intervalMs = UPDATE_BACKSTOP_INTERVAL_MS,
): boolean {
  return lastCheckAt !== null && now - lastCheckAt >= intervalMs;
}

// CORE-1160 — read severity straight from the manifest (Update.rawJson is the
// full parsed latest.json). Critical (security) updates get "Security update"
// copy and a once-per-launch pill re-surface; everything parses defensively —
// any malformed or missing field falls safe to routine.

/**
 * A tiny semver "x.y.z" less-than: numeric segment compare, pre-release / build
 * metadata ignored, missing segments treated as 0. No new deps.
 */
export function semverLt(a: string, b: string): boolean {
  const parse = (s: string) =>
    String(s)
      .split("+")[0] // drop +build metadata
      .split("-")[0] // drop -prerelease
      .split(".")
      .map((n) => parseInt(n, 10));
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y;
  }
  return false;
}

const SEMVER_SHAPE = /^\d+\.\d+(\.\d+)?$/;

/**
 * Is this found update critical? True only when the manifest marks
 * `severity: "critical"` AND (no `criticalBelow`, or the installed version is below
 * it). Defensive by construction: a missing/malformed severity or criticalBelow,
 * or an unreadable current version, all resolve to NOT critical (fail safe to calm).
 */
export function isCriticalUpdate(rawJson: unknown, currentVersion: string): boolean {
  if (!rawJson || typeof rawJson !== "object") return false;
  const manifest = rawJson as Record<string, unknown>;
  if (manifest.severity !== "critical") return false;

  const below = manifest.criticalBelow;
  if (below === undefined || below === null) return true; // critical with no version floor
  if (typeof below !== "string" && typeof below !== "number") return false; // malformed => routine
  const belowStr = String(below);
  if (!SEMVER_SHAPE.test(belowStr)) return false; // malformed => routine
  if (typeof currentVersion !== "string" || !SEMVER_SHAPE.test(currentVersion)) return false;
  return semverLt(currentVersion, belowStr);
}

// ── The state machine ─────────────────────────────────────────────────────────

export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "readyToRestart"
  | "relaunching"
  | "error";

export type UpdateErrorKind = "offline" | "check" | "download" | "restart";

export type UpdateMachineState = {
  phase: UpdatePhase;
  /** The found update is a critical (security) one. */
  critical: boolean;
  /** The found update's version (null until a check finds one). */
  version: string | null;
  /** The installed version as the updater reported it (null until a find). */
  currentVersion: string | null;
  /** Download progress 0..100, or null while the size is unknown. */
  progressPct: number | null;
  /** Wall-clock ms of the last COMPLETED check (success or failure). */
  lastCheckedAt: number | null;
  /** What failed, when phase === "error". */
  errorKind: UpdateErrorKind | null;
  /** Session-only: the reader waved the pill off. The machine keeps running and
   *  Settings still reflects the true state — this hides the PILL only. */
  pillDismissed: boolean;
  /** The version the dismissal applies to (a NEWER version re-surfaces). */
  dismissedVersion: string | null;
  /** A critical update may re-surface a dismissed pill ONCE per launch. */
  criticalResurfaceUsed: boolean;
  /** Mirror of the auto-download preference, so subscribers re-render on toggle. */
  autoDownload: boolean;
};

export type UpdateAction =
  | { type: "CHECK_STARTED" }
  | { type: "CHECK_UP_TO_DATE"; at: number }
  | {
      type: "CHECK_FOUND";
      version: string;
      currentVersion: string | null;
      critical: boolean;
      at: number;
    }
  | { type: "CHECK_FAILED"; offline: boolean; at: number }
  | { type: "DOWNLOAD_STARTED" }
  | { type: "DOWNLOAD_PROGRESS"; pct: number | null }
  | { type: "DOWNLOAD_FINISHED" }
  | { type: "DOWNLOAD_FAILED"; offline: boolean }
  | { type: "RESTART_STARTED" }
  | { type: "RESTART_FAILED" }
  | { type: "RETRY_RESTART" }
  | { type: "RETRY_DOWNLOAD" }
  | { type: "PILL_DISMISSED" }
  | { type: "SET_AUTO_DOWNLOAD"; on: boolean };

export function readAutoDownload(): boolean {
  try {
    return localStorage.getItem(AUTO_DOWNLOAD_KEY) !== "0";
  } catch {
    return true;
  }
}

export function initialUpdateState(): UpdateMachineState {
  return {
    phase: "idle",
    critical: false,
    version: null,
    currentVersion: null,
    progressPct: null,
    lastCheckedAt: null,
    errorKind: null,
    pillDismissed: false,
    dismissedVersion: null,
    criticalResurfaceUsed: false,
    autoDownload: readAutoDownload(),
  };
}

/** A critical update may pull a dismissed pill back ONCE per launch — calm but
 *  persistent, still never a forced modal or restart. */
function resurfaceCriticalOnce(s: UpdateMachineState): UpdateMachineState {
  if (s.critical && s.pillDismissed && !s.criticalResurfaceUsed) {
    return { ...s, pillDismissed: false, criticalResurfaceUsed: true };
  }
  return s;
}

export function updateReducer(
  s: UpdateMachineState,
  a: UpdateAction,
): UpdateMachineState {
  switch (a.type) {
    case "CHECK_STARTED":
      return { ...s, phase: "checking", errorKind: null };
    case "CHECK_UP_TO_DATE":
      return {
        ...s,
        phase: "upToDate",
        critical: false,
        version: null,
        progressPct: null,
        errorKind: null,
        lastCheckedAt: a.at,
      };
    case "CHECK_FOUND": {
      const next: UpdateMachineState = {
        ...s,
        phase: "available",
        critical: a.critical,
        version: a.version,
        currentVersion: a.currentVersion ?? s.currentVersion,
        progressPct: null,
        errorKind: null,
        lastCheckedAt: a.at,
        // A dismissal binds to a version: a different (newer) version surfaces
        // the pill again; the same routine version stays waved off this session.
        pillDismissed: s.dismissedVersion === a.version ? s.pillDismissed : false,
      };
      return resurfaceCriticalOnce(next);
    }
    case "CHECK_FAILED":
      // CORE-1191: a failed CHECK never surfaces the pill (no update is known
      // to exist) — the pill-visibility rule below keeps "check"/"offline"
      // errors off the pill. Settings still shows the honest state, and the
      // error phase stays check-eligible so the funnel never freezes.
      return {
        ...s,
        phase: "error",
        errorKind: a.offline ? "offline" : "check",
        lastCheckedAt: a.at,
      };
    case "DOWNLOAD_STARTED":
      return { ...s, phase: "downloading", progressPct: null, errorKind: null };
    case "DOWNLOAD_PROGRESS":
      return s.phase === "downloading" ? { ...s, progressPct: a.pct } : s;
    case "DOWNLOAD_FINISHED":
      return resurfaceCriticalOnce({ ...s, phase: "readyToRestart", progressPct: 100 });
    case "DOWNLOAD_FAILED":
      return {
        ...s,
        phase: "error",
        errorKind: a.offline ? "offline" : "download",
        progressPct: null,
      };
    case "RESTART_STARTED":
      return { ...s, phase: "relaunching" };
    case "RESTART_FAILED":
      return { ...s, phase: "error", errorKind: "restart" };
    case "RETRY_RESTART":
      return s.phase === "error" && s.errorKind === "restart"
        ? { ...s, phase: "readyToRestart", errorKind: null }
        : s;
    case "RETRY_DOWNLOAD":
      return s.phase === "error" && s.errorKind === "download"
        ? { ...s, phase: "available", errorKind: null, progressPct: null }
        : s;
    case "PILL_DISMISSED":
      return {
        ...s,
        pillDismissed: true,
        dismissedVersion: s.version ?? s.dismissedVersion,
      };
    case "SET_AUTO_DOWNLOAD":
      return { ...s, autoDownload: a.on };
  }
}

/** Should the PILL render right now? (Settings always renders the state.)
 *  Check failures never show a pill (CORE-1191 — a phantom "update" with no
 *  known update behind it); download/restart failures do, as "Try again". */
export function updatePillVisible(s: UpdateMachineState): boolean {
  if (s.pillDismissed) return false;
  switch (s.phase) {
    case "available":
    case "downloading":
    case "readyToRestart":
    case "relaunching":
      return true;
    case "error":
      return s.errorKind === "download" || s.errorKind === "restart";
    default:
      return false;
  }
}

function logUpdateFailure(what: "check" | "download" | "restart" | "open", err: unknown) {
  // Never book content, never a path — a short usage-level line only.
  console.warn(`[throughline:update] ${what} failed.`, err);
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

type MachineOptions = {
  now?: () => number;
};

export type UpdateMachine = ReturnType<typeof createUpdateMachine>;

export function createUpdateMachine(opts: MachineOptions = {}) {
  const now = opts.now ?? (() => Date.now());

  let state = initialUpdateState();
  const listeners = new Set<() => void>();
  // The Update handle from the plugin (non-serializable; kept out of state).
  let updateObj: Update | null = null;
  // Single-flight + the one cadence timestamp the AUTOMATIC cooldown gates on.
  let checking = false;
  let lastCheckAt: number | null = null;

  function dispatch(a: UpdateAction) {
    const next = updateReducer(state, a);
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  }

  function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  }

  function getState(): UpdateMachineState {
    return state;
  }

  /** A check may start only from a settled phase — never mid-download or with a
   *  restart pending (forward-only past that point). "available" stays eligible:
   *  re-finding the same update is harmless, keeps the manifest fresh (a newer
   *  or newly-critical version replaces it), and is the moment a dismissed
   *  CRITICAL pill gets its once-per-launch resurface when auto-download is off. */
  function checkEligible(): boolean {
    return (
      state.phase === "idle" ||
      state.phase === "upToDate" ||
      state.phase === "error" ||
      state.phase === "available"
    );
  }

  async function runCheck(bypassCooldown: boolean): Promise<void> {
    if (checking) return;
    if (!checkEligible()) return;
    const t = now();
    if (!bypassCooldown && !updateCheckAllowed(lastCheckAt, t)) return;
    checking = true;
    lastCheckAt = t;
    dispatch({ type: "CHECK_STARTED" });
    try {
      const u = await check();
      if (u) {
        updateObj = u;
        dispatch({
          type: "CHECK_FOUND",
          version: u.version,
          currentVersion: u.currentVersion ?? null,
          critical: isCriticalUpdate(u.rawJson, u.currentVersion),
          at: now(),
        });
        // Auto-download by default: available advances straight to downloading
        // in the background, so the pill's one ask is a calm "Restart to update".
        if (state.autoDownload) void download();
      } else {
        dispatch({ type: "CHECK_UP_TO_DATE", at: now() });
      }
    } catch (err) {
      logUpdateFailure("check", err);
      dispatch({ type: "CHECK_FAILED", offline: isOffline(), at: now() });
    } finally {
      checking = false;
    }
  }

  /** The four AUTOMATIC triggers funnel here — cooldown-gated (CORE-1159). */
  function autoCheck(): Promise<void> {
    return runCheck(false);
  }

  /** A reader-initiated check (Settings button, app menu) — NEVER cooldown-gated. */
  function manualCheck(): Promise<void> {
    return runCheck(true);
  }

  async function download(): Promise<void> {
    const u = updateObj;
    if (!u) return;
    if (state.phase !== "available") return;
    dispatch({ type: "DOWNLOAD_STARTED" });
    try {
      let total = 0;
      let got = 0;
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          dispatch({ type: "DOWNLOAD_PROGRESS", pct: total ? 0 : null });
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) {
            dispatch({
              type: "DOWNLOAD_PROGRESS",
              pct: Math.min(100, Math.round((got / total) * 100)),
            });
          }
        }
      });
      dispatch({ type: "DOWNLOAD_FINISHED" });
    } catch (err) {
      logUpdateFailure("download", err);
      dispatch({ type: "DOWNLOAD_FAILED", offline: isOffline() });
    }
  }

  async function restart(): Promise<void> {
    if (state.phase !== "readyToRestart") return;
    dispatch({ type: "RESTART_STARTED" });
    let relaunchMarkerPrepared = false;
    try {
      await invoke("cmd_prepare_update_relaunch_focus");
      relaunchMarkerPrepared = true;
      await relaunch();
    } catch (err) {
      if (relaunchMarkerPrepared) {
        invoke("cmd_consume_update_relaunch_focus").catch(() => {});
      }
      logUpdateFailure("restart", err);
      dispatch({ type: "RESTART_FAILED" });
    }
  }

  /** "Try again" — re-runs the failed step IN-APP (never an external link). */
  async function retry(): Promise<void> {
    if (state.phase !== "error") return;
    switch (state.errorKind) {
      case "download":
        if (updateObj) {
          // The update is still known; step back to available and re-download.
          dispatch({ type: "RETRY_DOWNLOAD" });
          return download();
        }
        return runCheck(true);
      case "restart":
        // The payload already installed; only the relaunch failed. Offer it again.
        dispatch({ type: "RETRY_RESTART" });
        return restart();
      default:
        // check / offline: run a fresh check — reader-initiated, so no cooldown.
        return runCheck(true);
    }
  }

  /** The reader came back online while the machine sat in the offline state —
   *  the Settings copy promises "We will check again automatically when you are
   *  back online", so this ONE recovery re-check skips the cooldown. It is
   *  scoped to the offline-error phase and cannot loop (a failing re-check just
   *  waits for the next online transition). */
  function onBackOnline(): void {
    if (state.phase === "error" && state.errorKind === "offline") void runCheck(true);
  }

  /** Hide the PILL for this session. The machine keeps running; Settings still
   *  reflects the true state. A critical update re-surfaces once per launch. */
  function dismissPill(): void {
    dispatch({ type: "PILL_DISMISSED" });
  }

  function setAutoDownload(on: boolean): void {
    try {
      localStorage.setItem(AUTO_DOWNLOAD_KEY, on ? "1" : "0");
    } catch {
      /* the in-memory value still applies this session */
    }
    dispatch({ type: "SET_AUTO_DOWNLOAD", on });
    // Turning it ON while an update sits available starts the download now.
    if (on && state.phase === "available") void download();
  }

  /** Last-resort recovery only (Settings error state): open the public download
   *  page in the reader's browser. window.open is a no-op in the wry webview
   *  (CORE-1192) — the opener plugin is the working path, scoped by capability
   *  to https://readthroughline.com/* only. */
  function openWebsiteDownload(): void {
    openUrl(FALLBACK_DOWNLOAD_URL).catch((err) => logUpdateFailure("open", err));
  }

  /** Wire the four AUTOMATIC triggers (launch / focus+visibility / wake
   *  heartbeat / 6h backstop — CORE-1159) plus the offline-recovery listener.
   *  Returns a teardown. The cadence runs for the whole app session regardless
   *  of where the pill is visible, so Settings is always live. */
  function startTriggers(): () => void {
    // 1. Launch: one check a beat after mount (not on first paint).
    const launchTimer = setTimeout(() => void autoCheck(), UPDATE_INITIAL_CHECK_DELAY_MS);

    // 2. Focus / visibility. Prefer visibilitychange; window focus is the noisier
    //    backstop (covers the Tauri webview regaining native focus too). Both are
    //    cooldown-gated, so rapid focus/blur cycling never fires repeated checks.
    const onVisible = () => {
      if (document.visibilityState === "visible") void autoCheck();
    };
    const onFocus = () => void autoCheck();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    // 3 & 4. Wake heartbeat + 6h backstop on one self-correcting interval. Each
    //    tick records now(); an oversized gap means the machine slept (wake), and
    //    the same tick forces a check once the backstop interval has elapsed.
    let lastTick: number | null = now();
    const heartbeat = setInterval(() => {
      const t = now();
      const slept = wakeDetected(lastTick, t);
      lastTick = t;
      if (slept || backstopDue(lastCheckAt, t)) void autoCheck();
    }, UPDATE_HEARTBEAT_MS);

    // Offline recovery: the one promised re-check when connectivity returns.
    const onOnline = () => onBackOnline();
    window.addEventListener("online", onOnline);

    return () => {
      clearTimeout(launchTimer);
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }

  return {
    subscribe,
    getState,
    autoCheck,
    manualCheck,
    download,
    restart,
    retry,
    dismissPill,
    setAutoDownload,
    openWebsiteDownload,
    onBackOnline,
    startTriggers,
  };
}

/** The app-wide singleton both surfaces subscribe to. */
export const updateMachine = createUpdateMachine();

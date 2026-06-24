import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import TLIcon, { type IconName } from "./TLIcon";

export const FALLBACK_DOWNLOAD_URL = "https://readthroughline.com/download";

// CORE-1159 — event-driven cadence. The old model checked ~24h after launch via a
// bare setTimeout that paused across sleep, so keep-the-app-open users never got
// updates. The new model is four triggers funnelling through one cooldown-gated
// maybeCheck(): a launch check, focus/visibility, a self-correcting wake heartbeat,
// and a 6h backstop. One timestamp (lastCheckAt) throttles them all.
export const UPDATE_INITIAL_CHECK_DELAY_MS = 8_000; // launch: check 8s after the today surface mounts
export const UPDATE_CHECK_COOLDOWN_MS = 30 * 60_000; // min spacing between any two real checks
export const UPDATE_BACKSTOP_INTERVAL_MS = 6 * 60 * 60_000; // force a check if 6h pass untouched
export const UPDATE_HEARTBEAT_MS = 60_000; // the metronome that detects wake + backstop
export const UPDATE_WAKE_GAP_MS = 2 * 60_000; // a heartbeat gap past this means the machine slept/throttled

export type UpdatePillPhase = "hidden" | "ready" | "updating" | "restart" | "fallback";
type FallbackReason = "check" | "download" | "restart";

type PillView = {
  label: "Update ready" | "Updating" | "Restart to update" | "Download update";
  icon: IconName;
  busy: boolean;
  fallback: boolean;
};

// ── Pure, time-injected cadence helpers (testable without a DOM/clock) ────────

/**
 * The cooldown gate for the maybeCheck() funnel: a real check is allowed only when
 * none has run yet (lastCheckAt === null) or the cooldown has fully elapsed.
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

export function updatePillView(phase: Exclude<UpdatePillPhase, "hidden">): PillView {
  switch (phase) {
    case "ready":
      return { label: "Update ready", icon: "download", busy: false, fallback: false };
    case "updating":
      return { label: "Updating", icon: "download", busy: true, fallback: false };
    case "restart":
      return { label: "Restart to update", icon: "restart", busy: false, fallback: false };
    case "fallback":
      return { label: "Download update", icon: "download", busy: false, fallback: true };
  }
}

function logUpdateFallback(reason: FallbackReason, err: unknown) {
  console.warn(`[throughline:update] ${reason} failed; falling back to the public download.`, err);
}

type Props = {
  visible?: boolean;
  now?: () => number;
};

const defaultNow = () => Date.now();

export default function UpdateChecker({ visible = true, now = defaultNow }: Props) {
  const [phase, setPhase] = useState<UpdatePillPhase>("hidden");
  const [update, setUpdate] = useState<Update | null>(null);
  const [pct, setPct] = useState(0);

  // Single-flight + the one cadence timestamp + the heartbeat's last tick. The
  // pendingVersion / dismissedVersion refs keep the pill from re-nagging: it
  // animates in once per version, moves forward only, and a dismissed version is
  // not re-shown this session. phaseRef mirrors phase so the async funnel can read
  // it synchronously.
  const checkingRef = useRef(false);
  const lastCheckAtRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const pendingVersionRef = useRef<string | null>(null);
  const dismissedVersionRef = useRef<string | null>(null);
  const phaseRef = useRef<UpdatePillPhase>("hidden");

  const goPhase = useCallback((p: UpdatePillPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const enterFallback = useCallback(
    (reason: FallbackReason, err: unknown) => {
      logUpdateFallback(reason, err);
      // Only surface the fallback from a clean slate; never knock a forward pill
      // (ready/updating/restart) backwards on a later silent check.
      if (reason === "check" && phaseRef.current !== "hidden") return;
      setUpdate(null);
      setPct(0);
      goPhase("fallback");
    },
    [goPhase],
  );

  // A found update surfaces the "ready" pill exactly once per version: not if a
  // pill is already up (forward-only, no re-mount / progress reset), and not if the
  // reader already dismissed this version this session.
  const onUpdateFound = useCallback(
    (u: Update) => {
      if (phaseRef.current !== "hidden") return;
      if (dismissedVersionRef.current === u.version) return;
      pendingVersionRef.current = u.version;
      setUpdate(u);
      setPct(0);
      goPhase("ready");
    },
    [goPhase],
  );

  // The single funnel. Every trigger routes here. No-ops if a check is in flight,
  // if a pill is already showing, or if the cooldown since the last check hasn't
  // elapsed. A real run stamps lastCheckAt and checks silently.
  const maybeCheck = useCallback(async () => {
    if (checkingRef.current) return;
    if (phaseRef.current !== "hidden") return;
    const t = now();
    if (!updateCheckAllowed(lastCheckAtRef.current, t)) return;
    checkingRef.current = true;
    lastCheckAtRef.current = t;
    try {
      const u = await check();
      if (u) onUpdateFound(u);
    } catch (err) {
      enterFallback("check", err);
    } finally {
      checkingRef.current = false;
    }
  }, [now, onUpdateFound, enterFallback]);

  // All four triggers live on one effect so they share one teardown. Gated by
  // `visible` (App.tsx shows the pill only on the today surface).
  useEffect(() => {
    if (!visible) return;
    let disposed = false;

    // 1. Launch: one check a beat after the surface mounts (not on first paint).
    const launchTimer = setTimeout(() => {
      if (!disposed) void maybeCheck();
    }, UPDATE_INITIAL_CHECK_DELAY_MS);

    // 2. Focus / visibility. Prefer visibilitychange; window focus is the noisier
    //    backstop (covers the Tauri webview regaining native focus too). Both are
    //    cooldown-gated, so rapid focus/blur cycling never fires repeated checks.
    const onVisible = () => {
      if (document.visibilityState === "visible") void maybeCheck();
    };
    const onFocus = () => void maybeCheck();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    // 3 & 4. Wake heartbeat + 6h backstop on one self-correcting interval. Each
    //    tick records now(); an oversized gap means the machine slept (wake), and
    //    the same tick forces a check once the backstop interval has elapsed.
    lastTickRef.current = now();
    const heartbeat = setInterval(() => {
      const t = now();
      const slept = wakeDetected(lastTickRef.current, t);
      lastTickRef.current = t;
      if (slept || backstopDue(lastCheckAtRef.current, t)) void maybeCheck();
    }, UPDATE_HEARTBEAT_MS);

    return () => {
      disposed = true;
      clearTimeout(launchTimer);
      clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [visible, maybeCheck, now]);

  const dismissUpdate = useCallback(() => {
    if (pendingVersionRef.current) dismissedVersionRef.current = pendingVersionRef.current;
    setUpdate(null);
    setPct(0);
    goPhase("hidden");
  }, [goPhase]);

  async function startUpdate() {
    if (!update || phaseRef.current !== "ready") return;
    goPhase("updating");
    setPct(0);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) setPct(Math.min(100, Math.round((got / total) * 100)));
        }
      });
      setPct(100);
      goPhase("restart");
    } catch (err) {
      enterFallback("download", err);
    }
  }

  async function restartToUpdate() {
    if (phaseRef.current !== "restart") return;
    let relaunchMarkerPrepared = false;
    try {
      await invoke("cmd_prepare_update_relaunch_focus");
      relaunchMarkerPrepared = true;
      await relaunch();
    } catch (err) {
      if (relaunchMarkerPrepared) {
        invoke("cmd_consume_update_relaunch_focus").catch(() => {});
      }
      enterFallback("restart", err);
    }
  }

  function openFallbackDownload() {
    window.open(FALLBACK_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
  }

  if (!visible || phase === "hidden") return null;

  const view = updatePillView(phase);
  const className = `tl-update-pill${view.fallback ? " fallback" : ""}${view.busy ? " updating" : ""}`;
  const progress = Math.max(4, Math.min(100, pct));

  // A reset for the inner action button so the wrapping pill keeps its chrome.
  const bareButton = {
    border: 0,
    background: "transparent",
    padding: 0,
    margin: 0,
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
  } as const;

  if (phase === "updating") {
    return (
      <div className={className} role="status" aria-live="polite" aria-busy="true">
        <span className="tl-update-pill-main">
          <TLIcon name={view.icon} size={15} />
          <span>{view.label}</span>
        </span>
        <span className="tl-update-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </span>
      </div>
    );
  }

  // The restart pill is a committed, single-action state — no dismiss.
  if (phase === "restart") {
    return (
      <button className={className} type="button" onClick={restartToUpdate}>
        <span className="tl-update-pill-main">
          <TLIcon name={view.icon} size={15} />
          <span>{view.label}</span>
        </span>
      </button>
    );
  }

  // "ready" + "fallback": the primary action plus a quiet dismiss so a version the
  // reader waves off is not re-shown this session.
  return (
    <div className={className} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        className="tl-update-pill-main"
        style={bareButton}
        onClick={phase === "ready" ? startUpdate : openFallbackDownload}
      >
        <TLIcon name={view.icon} size={15} />
        <span>{view.label}</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss update"
        style={{ ...bareButton, padding: 2, lineHeight: 0, opacity: 0.55 }}
        onClick={dismissUpdate}
      >
        <TLIcon name="x" size={12} />
      </button>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import TLIcon, { type IconName } from "./TLIcon";

export const FALLBACK_DOWNLOAD_URL = "https://readthroughline.com/download";
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UpdatePillPhase = "hidden" | "ready" | "updating" | "restart" | "fallback";
type FallbackReason = "check" | "download" | "restart";

type PillView = {
  label: "Update ready" | "Updating" | "Restart to update" | "Download update";
  icon: IconName;
  busy: boolean;
  fallback: boolean;
};

let seenTodayUpdateSurface = false;
let lastBackgroundCheckAt: number | null = null;

export function resetUpdateCheckGate() {
  seenTodayUpdateSurface = false;
  lastBackgroundCheckAt = null;
}

export function shouldStartBackgroundUpdateCheck(now = Date.now()): boolean {
  if (!seenTodayUpdateSurface) {
    seenTodayUpdateSurface = true;
    lastBackgroundCheckAt = now;
    return false;
  }

  if (lastBackgroundCheckAt === null || now - lastBackgroundCheckAt >= UPDATE_CHECK_INTERVAL_MS) {
    lastBackgroundCheckAt = now;
    return true;
  }

  return false;
}

export function msUntilNextBackgroundUpdateCheck(now = Date.now()): number {
  if (!seenTodayUpdateSurface || lastBackgroundCheckAt === null) return 0;
  return Math.max(0, UPDATE_CHECK_INTERVAL_MS - (now - lastBackgroundCheckAt));
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
  const checkingRef = useRef(false);

  const enterFallback = useCallback((reason: FallbackReason, err: unknown) => {
    logUpdateFallback(reason, err);
    setUpdate(null);
    setPct(0);
    setPhase("fallback");
  }, []);

  const checkQuietly = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const u = await check();
      if (u) {
        setUpdate(u);
        setPct(0);
        setPhase("ready");
      }
    } catch (err) {
      enterFallback("check", err);
    } finally {
      checkingRef.current = false;
    }
  }, [enterFallback]);

  useEffect(() => {
    if (!visible || phase !== "hidden") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      if (cancelled) return;
      if (shouldStartBackgroundUpdateCheck(now())) {
        void checkQuietly();
      }
      const delay = msUntilNextBackgroundUpdateCheck(now());
      timer = setTimeout(tick, delay);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkQuietly, now, phase, visible]);

  async function startUpdate() {
    if (!update || phase !== "ready") return;
    setPhase("updating");
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
      setPhase("restart");
    } catch (err) {
      enterFallback("download", err);
    }
  }

  async function restartToUpdate() {
    if (phase !== "restart") return;
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

  return (
    <button
      className={className}
      type="button"
      onClick={phase === "ready" ? startUpdate : phase === "restart" ? restartToUpdate : openFallbackDownload}
    >
      <span className="tl-update-pill-main">
        <TLIcon name={view.icon} size={15} />
        <span>{view.label}</span>
      </span>
    </button>
  );
}

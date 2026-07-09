import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import {
  updateMachine,
  type UpdateMachine,
  type UpdateMachineState,
} from "../updateMachine";

// CORE-1193 — the Settings "Software Update" section. It renders the SAME
// machine the pill does, so it is never a dead end and never lies: dismissing
// the pill only hides the pill, and this section still shows the true state.
// The "Check for updates" button is a MANUAL check — it always bypasses the
// 30-minute automatic cooldown. The external website download lives only in
// the error state, as last-resort recovery.

/** "just now" / "5 minutes ago" / "3 hours ago" / "yesterday" / "4 days ago" —
 *  plain words, no em dashes. Exported for tests. */
export function relativeTimeFrom(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) {
    const m = Math.floor(diff / minute);
    return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  }
  if (diff < day) {
    const h = Math.floor(diff / hour);
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }
  if (diff < 2 * day) return "yesterday";
  return `${Math.floor(diff / day)} days ago`;
}

export type SoftwareUpdateView = {
  /** The one status line. */
  line: string;
  /** Quiet meta line under the status (version / last checked), when known. */
  sub: string | null;
  /** The critical (security) recommendation line, when it applies. */
  securityLine: string | null;
  primary: { label: string; action: "check" | "download" | "restart" | "retry"; disabled?: boolean } | null;
  secondary: { label: string; action: "restartLater" | "website" } | null;
};

/** The section's face for a machine state — pure, exported for tests. The
 *  status copy is the frozen CORE-1193 wording; change it only with the memo. */
export function softwareUpdateView(
  s: UpdateMachineState,
  appVersion: string | null,
  nowMs: number,
): SoftwareUpdateView {
  // The installed version: the updater's own report wins; the app diagnostics
  // version is the fallback before any check has run.
  const version = s.currentVersion ?? appVersion;
  const lastChecked =
    s.lastCheckedAt != null ? `Last checked ${relativeTimeFrom(s.lastCheckedAt, nowMs)}.` : null;
  const versionLine = version ? `Version ${version}.` : null;
  const meta = [versionLine, lastChecked].filter(Boolean).join(" ") || null;
  const securityLine =
    s.critical && (s.phase === "available" || s.phase === "downloading" || s.phase === "readyToRestart" || s.phase === "relaunching")
      ? "A security update is available. We recommend installing it now."
      : null;

  switch (s.phase) {
    case "idle":
      return {
        line: version ? `You are on version ${version}.` : "Updates are checked automatically.",
        sub: lastChecked,
        securityLine,
        primary: { label: "Check for updates", action: "check" },
        secondary: null,
      };
    case "checking":
      return {
        line: "Checking for updates...",
        sub: versionLine,
        securityLine,
        primary: { label: "Check for updates", action: "check", disabled: true },
        secondary: null,
      };
    case "upToDate":
      return {
        line: version ? `You are on the latest version, v${version}.` : "You are on the latest version.",
        sub: lastChecked,
        securityLine,
        primary: { label: "Check for updates", action: "check" },
        secondary: null,
      };
    case "available":
      return s.autoDownload
        ? {
            line: `Version ${s.version} is available. Downloading now...`,
            sub: meta,
            securityLine,
            primary: null,
            secondary: null,
          }
        : {
            line: `Version ${s.version} is available.`,
            sub: meta,
            securityLine,
            primary: { label: "Download update", action: "download" },
            secondary: null,
          };
    case "downloading":
      return {
        line:
          s.progressPct != null
            ? `Downloading update... ${Math.min(100, Math.max(0, Math.round(s.progressPct)))}%`
            : "Downloading update...",
        sub: meta,
        securityLine,
        primary: null,
        secondary: null,
      };
    case "readyToRestart":
      return {
        line: "Update ready. Restart Throughline to finish.",
        sub: meta,
        securityLine,
        primary: { label: "Restart now", action: "restart" },
        secondary: { label: "Restart later", action: "restartLater" },
      };
    case "relaunching":
      return {
        line: "Update ready. Restart Throughline to finish.",
        sub: meta,
        securityLine,
        primary: { label: "Restart now", action: "restart", disabled: true },
        secondary: null,
      };
    case "error":
      if (s.errorKind === "offline") {
        return {
          line: "You appear to be offline. We will check again automatically when you are back online.",
          sub: meta,
          securityLine,
          primary: { label: "Try again", action: "retry" },
          secondary: null,
        };
      }
      return {
        line: "We could not complete the update.",
        sub: meta,
        securityLine,
        primary: { label: "Try again", action: "retry" },
        secondary: { label: "Download from the website", action: "website" },
      };
  }
}

type Props = {
  appVersion: string | null;
  machine?: UpdateMachine;
  now?: () => number;
};

export default function SoftwareUpdatePane({
  appVersion,
  machine = updateMachine,
  now = () => Date.now(),
}: Props) {
  const state = useSyncExternalStore(machine.subscribe, machine.getState);

  // Keep "Last checked …" honest while the pane sits open with no state change.
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(h);
  }, []);

  const view = softwareUpdateView(state, appVersion, now());

  const onAction = (action: "check" | "download" | "restart" | "retry" | "restartLater" | "website") => {
    switch (action) {
      case "check":
        void machine.manualCheck(); // manual: never gated by the auto cooldown
        break;
      case "download":
        void machine.download();
        break;
      case "restart":
        void machine.restart();
        break;
      case "retry":
        void machine.retry();
        break;
      case "restartLater":
        machine.dismissPill(); // hides the pill only; this section keeps the state
        break;
      case "website":
        machine.openWebsiteDownload(); // last-resort recovery, reader's browser
        break;
    }
  };

  return (
    <>
      <h3 className="set-pane-title">Software Update</h3>
      <div className="set-rows">
        <div className="set-row set-row-stack">
          <div className="set-row-top">
            <div className="set-row-label" role="status" aria-live="polite">
              {view.line}
            </div>
          </div>
          {view.securityLine && <p className="set-row-explain set-update-security">{view.securityLine}</p>}
          {view.sub && <p className="set-row-explain">{view.sub}</p>}
          {(view.primary || view.secondary) && (
            <div className="field-row">
              {view.primary && (
                <button
                  type="button"
                  className="btn btn-accent btn-small"
                  disabled={view.primary.disabled}
                  onClick={() => onAction(view.primary!.action)}
                >
                  {view.primary.label}
                </button>
              )}
              {view.secondary && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onAction(view.secondary!.action)}
                >
                  {view.secondary.label}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="set-row">
          <div className="set-row-label">
            Download updates automatically{" "}
            <span className="set-row-detail">· updates install only when you restart</span>
          </div>
          <button
            className="toggle"
            role="switch"
            aria-checked={state.autoDownload}
            aria-label="Download updates automatically"
            onClick={() => machine.setAutoDownload(!state.autoDownload)}
          />
        </div>
      </div>
    </>
  );
}

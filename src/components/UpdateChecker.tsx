import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import TLIcon, { type IconName } from "./TLIcon";
import {
  updateMachine,
  updatePillVisible,
  type UpdateMachine,
  type UpdateMachineState,
} from "../updateMachine";

// CORE-1192/1193 — the pill is now a THIN view over the one update state
// machine (src/updateMachine.ts); the Settings "Software Update" section renders
// the same store. This component (a) starts the automatic trigger cadence once,
// for the whole app session, and (b) renders the pill when `visible` (App shows
// it only on the today surface) AND the machine says a pill belongs on screen.
// Every click calls straight into the machine, which acts on its CURRENT phase
// — never stale React state — so the primary action works on the first click.

type PillView = {
  label: "Update ready" | "Security update" | "Updating" | "Restart to update" | "Restarting" | "Try again";
  icon: IconName;
  busy: boolean;
  fallback: boolean;
  action: "download" | "restart" | "retry" | null;
  dismissable: boolean;
};

/** The pill's face for a machine state — pure, exported for tests. Returns null
 *  when no pill should render (updatePillVisible is the single gate). */
export function updatePillView(s: UpdateMachineState): PillView | null {
  if (!updatePillVisible(s)) return null;
  switch (s.phase) {
    case "available":
      return {
        label: s.critical ? "Security update" : "Update ready",
        icon: "download",
        busy: false,
        fallback: false,
        action: "download",
        dismissable: true,
      };
    case "downloading":
      return { label: "Updating", icon: "download", busy: true, fallback: false, action: null, dismissable: false };
    case "readyToRestart":
      return { label: "Restart to update", icon: "restart", busy: false, fallback: false, action: "restart", dismissable: true };
    case "relaunching":
      return { label: "Restarting", icon: "restart", busy: true, fallback: false, action: null, dismissable: false };
    case "error":
      // Only download/restart failures reach the pill (updatePillVisible). The
      // failure state re-runs the step IN-APP — never a dead-end external link.
      return { label: "Try again", icon: "refresh", busy: false, fallback: true, action: "retry", dismissable: true };
    default:
      return null;
  }
}

type Props = {
  visible?: boolean;
  machine?: UpdateMachine;
};

export default function UpdateChecker({ visible = true, machine = updateMachine }: Props) {
  const state = useSyncExternalStore(machine.subscribe, machine.getState);

  // The automatic cadence (launch / focus / wake / backstop — CORE-1159) runs
  // for the whole session, independent of where the pill happens to render, so
  // the Settings section is live from any screen.
  useEffect(() => machine.startTriggers(), [machine]);

  if (!visible) return null;
  const view = updatePillView(state);
  if (!view) return null;

  const className = `tl-update-pill${view.fallback ? " fallback" : ""}${view.busy ? " updating" : ""}${
    state.critical ? " critical" : ""
  }`;

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

  // Busy states (downloading / relaunching) are a quiet, live status — a thin
  // indicator, no shouting percentage in the pill (Settings carries the %).
  if (view.busy) {
    const progress = Math.max(4, Math.min(100, state.progressPct ?? 4));
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

  const onPrimary = () => {
    if (view.action === "download") void machine.download();
    else if (view.action === "restart") void machine.restart();
    else if (view.action === "retry") void machine.retry();
  };

  return (
    <div className={className} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <button type="button" className="tl-update-pill-main" style={bareButton} onClick={onPrimary}>
        <TLIcon name={view.icon} size={15} />
        <span>{view.label}</span>
      </button>
      {view.dismissable && (
        <button
          type="button"
          aria-label="Dismiss update"
          style={{ ...bareButton, padding: 2, lineHeight: 0, opacity: 0.55 }}
          onClick={() => machine.dismissPill()}
        >
          <TLIcon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

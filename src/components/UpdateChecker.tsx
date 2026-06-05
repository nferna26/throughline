import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import TLIcon from "./TLIcon";

/**
 * Reader-initiated auto-update. The app NEVER checks on launch or a timer (that
 * would break the no-background-network posture) — only when you click. On an
 * available update it downloads the signed package, installs it, and relaunches
 * into the new version, like the Claude desktop app.
 */
type Phase = "idle" | "checking" | "uptodate" | "available" | "downloading" | "error";

export default function UpdateChecker() {
  const [version, setVersion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [msg, setMsg] = useState("");
  const [pct, setPct] = useState(0);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  async function checkNow() {
    setPhase("checking");
    setMsg("");
    try {
      const u = await check();
      if (u) {
        setUpdate(u);
        setPhase("available");
      } else {
        setPhase("uptodate");
      }
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
      setPhase("error");
    }
  }

  async function installAndRestart() {
    if (!update) return;
    setPhase("downloading");
    setMsg("");
    setPct(0);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total) setPct(Math.round((got / total) * 100));
        }
      });
      await relaunch();
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
      setPhase("error");
    }
  }

  return (
    <div className="tl-update">
      <div className="tl-update-row">
        <span className="tl-update-ver">Throughline{version && ` v${version}`}</span>
        {phase === "idle" && (
          <button className="tl-btn tl-btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={checkNow}>
            Check for updates
          </button>
        )}
        {phase === "checking" && <span className="tl-note-meta">Checking…</span>}
        {phase === "uptodate" && (
          <span className="tl-note-meta"><TLIcon name="check" size={14} /> You’re up to date</span>
        )}
        {(phase === "error" || phase === "available") && (
          <button className="tl-btn tl-btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={checkNow}>
            Check again
          </button>
        )}
      </div>

      {phase === "available" && update && (
        <div className="tl-update-avail">
          <p className="tl-note-meta">Version {update.version} is available. The app will restart to finish.</p>
          <button className="tl-btn tl-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={installAndRestart}>
            <TLIcon name="download" size={16} /> Update &amp; restart
          </button>
        </div>
      )}
      {phase === "downloading" && (
        <p className="tl-note-meta">
          Downloading{pct > 0 ? ` ${pct}%` : "…"} — the app will close and reopen in the new version.
        </p>
      )}
      {phase === "error" && msg && (
        <p className="tl-onboard-bad" style={{ marginTop: "var(--tl-2)" }}>{msg}</p>
      )}
    </div>
  );
}

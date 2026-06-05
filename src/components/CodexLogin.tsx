import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface DeviceStart {
  device_auth_id: string;
  user_code: string;
  verification_url: string;
  interval: number;
}
interface DevicePoll {
  status: "pending" | "complete" | "denied";
  message: string;
}

/**
 * App-owned Codex (ChatGPT) device-code login. Starts the flow, shows the code +
 * verification URL, and auto-polls until you approve in the browser — storing the
 * app's own tokens in the Keychain (independent of the Codex CLI's file).
 */
export default function CodexLogin({
  present,
  onComplete,
  onSignedOut,
}: {
  present: boolean;
  onComplete: () => void;
  onSignedOut?: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "waiting" | "done" | "error">(
    present ? "done" : "idle",
  );
  const [start, setStart] = useState<DeviceStart | null>(null);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => { if (pollRef.current) window.clearTimeout(pollRef.current); }, []);

  async function begin() {
    setPhase("starting");
    setMsg("");
    setCopied(false);
    try {
      const s = await invoke<DeviceStart>("cmd_codex_device_start");
      setStart(s);
      setPhase("waiting");
      schedulePoll(s, Date.now() + 15 * 60 * 1000);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
      setPhase("error");
    }
  }

  function schedulePoll(s: DeviceStart, deadline: number) {
    const tick = async () => {
      if (Date.now() > deadline) {
        setMsg("Login timed out. Try again.");
        setPhase("error");
        return;
      }
      try {
        const r = await invoke<DevicePoll>("cmd_codex_device_poll", {
          deviceAuthId: s.device_auth_id,
          userCode: s.user_code,
        });
        if (r.status === "complete") { setPhase("done"); onComplete(); return; }
        if (r.status === "denied") { setMsg(r.message); setPhase("error"); return; }
        pollRef.current = window.setTimeout(tick, Math.max(2, s.interval) * 1000);
      } catch (e: any) {
        setMsg(e?.message ?? String(e));
        setPhase("error");
      }
    };
    pollRef.current = window.setTimeout(tick, Math.max(2, s.interval) * 1000);
  }

  async function signOut() {
    try {
      await invoke("cmd_codex_logout");
      setPhase("idle");
      setStart(null);
      onSignedOut?.();
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <div className="tl-codexlogin">
        <p className="tl-onboard-ok">✓ Signed in with ChatGPT.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button className="tl-btn tl-btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={begin}>Re-sign in</button>
          <button className="tl-btn tl-btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="tl-codexlogin">
      {phase === "idle" && (
        <button className="tl-btn tl-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={begin}>
          Sign in with ChatGPT
        </button>
      )}
      {phase === "starting" && <p className="tl-onboard-hint">Starting…</p>}
      {phase === "waiting" && start && (
        <div className="tl-codex-wait">
          <p className="tl-onboard-hint" style={{ margin: 0 }}>
            1. Open <span className="tl-codex-url">{start.verification_url}</span> in your browser
          </p>
          <p className="tl-onboard-hint" style={{ margin: "6px 0 4px" }}>2. Enter this code:</p>
          <div className="tl-codex-code-row">
            <code className="tl-codex-code">{start.user_code}</code>
            <button
              className="tl-btn tl-btn-ghost"
              style={{ padding: "6px 10px", fontSize: 12 }}
              onClick={() => { navigator.clipboard?.writeText(start.user_code); setCopied(true); }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="tl-onboard-hint">Waiting for you to approve… this finishes automatically.</p>
        </div>
      )}
      {phase === "error" && (
        <p className="tl-onboard-bad">
          {msg}{" "}
          <button className="tl-btn tl-btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={begin}>Try again</button>
        </p>
      )}
    </div>
  );
}

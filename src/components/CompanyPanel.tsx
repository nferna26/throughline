import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import type { CompanyStatus, CompanyCredits } from "../types";

/** Three-state fuel gauge — robust to price changes (no exact "N questions"). */
function fuel(credits: CompanyCredits | null): { label: string; level: "ok" | "low" | "empty" } {
  if (!credits || credits.status !== "active") return { label: "Almost out", level: "empty" };
  const frac = credits.remaining_fraction;
  if (frac > 0.33) return { label: "Plenty of AI left", level: "ok" };
  if (frac > 0.1) return { label: "Running low", level: "low" };
  return { label: "Almost out", level: "empty" };
}

/**
 * The Throughline-AI (company-paid) provider surface. Two states:
 *  - not activated → buy ($20) + paste an activation code (CM4),
 *  - activated → a calm fuel gauge of remaining credits (CM7).
 * Loads its own status/credits so Settings only renders <CompanyPanel/>.
 */
export default function CompanyPanel({ onActivated }: { onActivated: () => void }) {
  const [status, setStatus] = useState<CompanyStatus | null>(null);
  const [credits, setCredits] = useState<CompanyCredits | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [buying, setBuying] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const buy = useCallback(async () => {
    setBuying(true);
    setErr("");
    try {
      const url = await invoke<string>("cmd_company_checkout");
      setCheckoutUrl(url); // Rust opened the browser; this is the visible fallback.
    } catch {
      setErr("Couldn't start checkout. Try again in a moment.");
    } finally {
      setBuying(false);
    }
  }, []);

  const load = useCallback(async () => {
    const s = await invoke<CompanyStatus>("cmd_company_status").catch(() => null);
    setStatus(s);
    if (s?.provider_active && s.has_license) {
      setCredits(await invoke<CompanyCredits>("cmd_company_credits").catch(() => null));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activate = useCallback(async () => {
    const token = code.trim();
    if (!token) {
      setErr("Enter your activation code.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await invoke("cmd_activate_company", { activationToken: token });
      setCode("");
      await load();
      onActivated();
    } catch (e) {
      const m = e as { message?: string };
      setErr(m?.message ?? "That code didn't work. Check it and try again.");
    } finally {
      setBusy(false);
    }
  }, [code, load, onActivated]);

  const active = status?.provider_active && status?.has_license;

  if (active) {
    const f = fuel(credits);
    return (
      <div className="tl-set-row col">
        <div className="lhs">
          <div className="name"><TLIcon name="shield" size={15} /> Throughline AI is active</div>
          <div className="desc">Claude Sonnet, no API key — billed to your one-time purchase.</div>
        </div>
        <div className={`tl-fuel ${f.level}`} role="status" aria-label={`AI credits: ${f.label}`}>
          <span className="tl-fuel-bar" aria-hidden="true"><span className="fill" /></span>
          <span className="tl-fuel-label">{f.label}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tl-set-row col">
      <div className="lhs">
        <div className="name">Throughline AI — $20 once</div>
        <div className="desc">
          The tutor, set up for you: Claude Sonnet, no API key, no subscription. A generous
          one-time allowance, then you can switch to your own key or a local model.
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--tl-3)" }}>
        <button className="tl-btn tl-btn-primary" style={{ alignSelf: "flex-start", padding: "8px 16px" }} disabled={buying} onClick={buy}>
          <TLIcon name="search" size={16} /> {buying ? "Starting checkout…" : "Get Throughline AI — $20"}
        </button>
        {checkoutUrl && (
          <p className="tl-set-msg" style={{ color: "var(--tl-muted)" }}>
            Opening checkout in your browser… If it doesn't open,{" "}
            <a href={checkoutUrl} target="_blank" rel="noopener noreferrer">continue here</a>.
          </p>
        )}
        <div className="tl-activate">
          <label className="tl-activate-lbl" htmlFor="tl-activate-code">Already bought? Paste your activation code</label>
          <div style={{ display: "flex", gap: "var(--tl-2)" }}>
            <input
              id="tl-activate-code"
              className="tl-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="tl-btn tl-btn-ghost" style={{ padding: "8px 14px" }} disabled={busy} onClick={activate}>
              {busy ? "Activating…" : "Activate"}
            </button>
          </div>
          {err && <p className="tl-set-msg err" style={{ marginTop: "var(--tl-2)" }}>{err}</p>}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import RGIcon from "../components/RGIcon";
import { AI_STUB_MODES, type AiRequest, type SettingsDto } from "../types";

interface Props {
  retentionDays: number;
  onSettingsChanged: () => void | Promise<void>;
}

const MODE_LABEL: Record<string, string> = Object.fromEntries(AI_STUB_MODES.map((m) => [m.value, m.label]));
const modeLabel = (mode: string) => MODE_LABEL[mode] ?? mode;

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * AI request history viewer + retention control (adr-001), styled as the
 * Settings "Request history" audit card. Each row says plainly whether the
 * prompt was a local-only preview that never left the machine or a call sent to
 * a host — the audit trail that makes the local-only posture real. Retention
 * bounds how long discarded previews are kept; saved-as-note rows are kept.
 */
export default function AiHistory({ retentionDays, onSettingsChanged }: Props) {
  const [requests, setRequests] = useState<AiRequest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [daysDraft, setDaysDraft] = useState(String(retentionDays));
  const [savingDays, setSavingDays] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setDaysDraft(String(retentionDays)), [retentionDays]);

  async function refresh() {
    setErr(null);
    try { setRequests(await invoke<AiRequest[]>("cmd_list_ai_requests")); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function saveDays() {
    const n = parseInt(daysDraft, 10);
    if (isNaN(n) || n < 0) { setMessage("Retention must be a whole number of days (0 keeps everything)."); return; }
    setSavingDays(true);
    setMessage(null);
    try {
      await invoke<SettingsDto>("cmd_set_ai_settings", { retentionDays: n });
      await onSettingsChanged();
      setMessage(n === 0 ? "Retention disabled — history kept indefinitely." : `Keeping AI history for ${n} days.`);
    } catch (e: any) { setMessage(`Failed: ${e?.message ?? e}`); }
    finally { setSavingDays(false); }
  }

  async function forgetNow() {
    setConfirmForget(false);
    setWorking(true);
    setMessage(null);
    try {
      const removed = await invoke<number>("cmd_forget_ai_history");
      await refresh();
      await onSettingsChanged();
      setMessage(removed === 0
        ? "Nothing to forget — no entries are past the retention window."
        : `Forgot ${removed} request${removed === 1 ? "" : "s"} older than the window (kept anything saved as a note).`);
    } catch (e: any) { setMessage(`Failed: ${e?.message ?? e}`); }
    finally { setWorking(false); }
  }

  return (
    <div className="rg-set-group">
      <span className="glabel">Request history</span>
      <div className="rg-set-card">
        {err && <div className="rg-audit-empty" style={{ color: "var(--rg-alert)" }}>{err}</div>}
        {requests === null && !err && <div className="rg-audit-empty">Loading…</div>}
        {requests && requests.length === 0 && (
          <div className="rg-audit-empty">No AI requests yet. The tutor logs each preview and call here.</div>
        )}

        {requests?.map((r) => (
          <div className="rg-audit-row" key={r.id}>
            <span className="when">{fmtWhen(r.created_at)}</span>
            <span className="what">
              <span>{modeLabel(r.mode)}</span>
              <span className="sub"> · {r.book_title ?? "book removed"}{r.wrote_to_memory ? " · saved as note" : ""}</span>
            </span>
            {r.provider == null ? (
              <span className="rg-audit-tag local"><RGIcon name="shield" size={13} /> Local</span>
            ) : (
              <span className="rg-audit-tag sent"><RGIcon name="arrowRight" size={13} /> Sent → {r.provider}</span>
            )}
          </div>
        ))}

        <div className="rg-set-row col">
          <div className="lhs">
            <div className="name">Keep history for</div>
            <div className="desc">
              On each launch, entries older than this that never became a note are removed; saved-as-note entries are kept.
              Previews never leave this Mac.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--rg-2)" }}>
            <input
              className="rg-input" type="number" min={0} value={daysDraft}
              onChange={(e) => setDaysDraft(e.target.value)} aria-label="Retention days"
              style={{ maxWidth: 92 }}
            />
            <span className="val">days</span>
            <div style={{ flex: 1 }} />
            <button className="rg-btn rg-btn-ghost" style={{ padding: "8px 14px", fontSize: 13 }} disabled={savingDays || daysDraft === String(retentionDays)} onClick={saveDays}>
              {savingDays ? "Saving…" : "Save"}
            </button>
            <button className="rg-btn rg-btn-ghost" style={{ padding: "8px 14px", fontSize: 13 }} disabled={working} onClick={() => setConfirmForget(true)}>
              {working ? "…" : "Forget now"}
            </button>
          </div>
        </div>

        {confirmForget && (
          <div className="rg-set-row col">
            <p className="rg-set-msg" style={{ color: "var(--rg-warn)" }}>
              Forget AI requests older than {retentionDays} day{retentionDays === 1 ? "" : "s"} now? Entries you saved as notes are kept; the rest are permanently deleted from the audit log.
            </p>
            <div style={{ display: "flex", gap: "var(--rg-2)", justifyContent: "flex-end" }}>
              <button className="rg-btn rg-btn-ghost" onClick={() => setConfirmForget(false)}>Cancel</button>
              <button className="rg-btn rg-btn-primary" onClick={forgetNow}>Yes, forget them</button>
            </div>
          </div>
        )}
        {message && <div className="rg-set-row"><p className="rg-set-msg ok">{message}</p></div>}
      </div>
    </div>
  );
}

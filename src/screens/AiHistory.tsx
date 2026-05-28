import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AI_STUB_MODES, type AiRequest, type SettingsDto } from "../types";

interface Props {
  retentionDays: number;
  onSettingsChanged: () => void | Promise<void>;
}

const MODE_LABEL: Record<string, string> = Object.fromEntries(
  AI_STUB_MODES.map((m) => [m.value, m.label])
);

function modeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? mode;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * AI request history viewer + retention control (adr-001). The audit trail is
 * the moral basis for the local-only posture — every preview and Ask call is
 * shown here, and each row says plainly whether the prompt left the machine.
 * The retention window bounds how long discarded previews are kept; rows that
 * became a note are kept regardless and labelled as such.
 */
export default function AiHistory({ retentionDays, onSettingsChanged }: Props) {
  const [requests, setRequests] = useState<AiRequest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [daysDraft, setDaysDraft] = useState<string>(String(retentionDays));
  const [savingDays, setSavingDays] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setDaysDraft(String(retentionDays)), [retentionDays]);

  async function refresh() {
    setErr(null);
    try {
      setRequests(await invoke<AiRequest[]>("cmd_list_ai_requests"));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => { refresh(); }, []);

  async function saveDays() {
    const n = parseInt(daysDraft, 10);
    if (isNaN(n) || n < 0) {
      setMessage("Retention must be a whole number of days (0 keeps everything).");
      return;
    }
    setSavingDays(true);
    setMessage(null);
    try {
      await invoke<SettingsDto>("cmd_set_ai_settings", { retentionDays: n });
      await onSettingsChanged();
      setMessage(n === 0 ? "Retention disabled — history is kept indefinitely." : `Keeping AI history for ${n} days.`);
    } catch (e: any) {
      setMessage(`Failed: ${e?.message ?? e}`);
    } finally {
      setSavingDays(false);
    }
  }

  async function forgetNow() {
    setConfirmForget(false);
    setWorking(true);
    setMessage(null);
    try {
      const removed = await invoke<number>("cmd_forget_ai_history");
      await refresh();
      await onSettingsChanged();
      setMessage(
        removed === 0
          ? "Nothing to forget — no entries are past the retention window."
          : `Forgot ${removed} request${removed === 1 ? "" : "s"} older than the window (kept anything saved as a note).`
      );
    } catch (e: any) {
      setMessage(`Failed: ${e?.message ?? e}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="ai-history">
      <h2 className="settings-h2">AI request history</h2>
      <p className="muted small">
        Every prompt preview and Ask call is logged here so you can audit what the
        model was asked. Previews never leave this machine; Ask calls show the host
        they were sent to.
      </p>

      <label className="settings-label">Keep history for (days; 0 = forever)
        <div className="settings-row" style={{ marginTop: 0 }}>
          <input
            className="settings-input"
            type="number"
            min={0}
            value={daysDraft}
            onChange={(e) => setDaysDraft(e.target.value)}
            style={{ maxWidth: 120 }}
          />
          <button className="primary" disabled={savingDays || daysDraft === String(retentionDays)} onClick={saveDays}>
            {savingDays ? "Saving…" : "Save"}
          </button>
          <button className="ghost" disabled={working} onClick={() => setConfirmForget(true)}>
            {working ? "…" : "Forget now"}
          </button>
        </div>
      </label>
      <p className="hint">
        On each launch, entries older than the window that never became a note are removed. Saved-as-note entries are kept.
      </p>

      {confirmForget && (
        <div className="recovery-confirm" role="alert">
          <p className="warn">
            Forget AI requests older than {retentionDays} day{retentionDays === 1 ? "" : "s"} now? Entries you saved as
            notes are kept; the rest are permanently deleted from the audit log.
          </p>
          <div className="panel-actions">
            <button className="ghost" onClick={() => setConfirmForget(false)}>Cancel</button>
            <button className="primary" onClick={forgetNow}>Yes, forget them</button>
          </div>
        </div>
      )}
      {message && <p className="settings-ok">{message}</p>}
      {err && <p className="settings-err">{err}</p>}

      {requests === null && !err && <p className="muted small">Loading…</p>}
      {requests && requests.length === 0 && (
        <p className="muted small ai-history-empty">No AI requests yet. The tutor logs each preview and call here.</p>
      )}
      {requests && requests.length > 0 && (
        <>
          <p className="muted small">{requests.length} request{requests.length === 1 ? "" : "s"}, newest first.</p>
          <ul className="ai-history-list">
            {requests.map((r) => (
              <li key={r.id} className="ai-req-row">
                <div className="ai-req-head">
                  <span className="ai-req-mode">{modeLabel(r.mode)}</span>
                  <span className="muted small">{r.book_title ?? "(book removed)"}</span>
                  <span className="ai-req-when muted small">{fmtWhen(r.created_at)}</span>
                </div>
                <div className="ai-req-meta small">
                  {r.provider == null ? (
                    <span className="ai-req-preview">Preview · never left this Mac</span>
                  ) : (
                    <span className="ai-req-sent">Sent → {r.provider}</span>
                  )}
                  {r.context_char_count != null && (
                    <span className="muted">· {r.context_char_count} chars selected</span>
                  )}
                  {r.wrote_to_memory && <span className="ai-req-note">· saved as note</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useDialog } from "../hooks/useDialog";
import AiHistory from "./AiHistory";
import type { ConnTestResult, SettingsDto } from "../types";

interface Props {
  onClose: () => void;
}

export default function Settings({ onClose }: Props) {
  const [dto, setDto] = useState<SettingsDto | null>(null);
  const [exportDraft, setExportDraft] = useState<string>("");
  const [savingExport, setSavingExport] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // AI section state
  const [baseUrlDraft, setBaseUrlDraft] = useState<string>("");
  const [modelDraft, setModelDraft] = useState<string>("");
  const [savingAi, setSavingAi] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [conn, setConn] = useState<ConnTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  async function refreshModels() {
    setLoadingModels(true);
    setModelsErr(null);
    try {
      const list = await invoke<string[]>("cmd_list_ai_models");
      setModels(list);
    } catch (e: any) {
      setModels(null);
      setModelsErr(String(e?.message ?? e));
    } finally {
      setLoadingModels(false);
    }
  }

  async function refresh() {
    const s = await invoke<SettingsDto>("cmd_get_settings");
    setDto(s);
    setExportDraft(s.export_path);
    setBaseUrlDraft(s.ai_base_url);
    setModelDraft(s.ai_model);
  }
  useEffect(() => {
    refresh();
    // Try to populate the dropdown on open. Failure is OK — server may be down.
    refreshModels();
  }, []);

  async function pickFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setExportDraft(picked);
  }

  async function saveExport() {
    setSavingExport(true);
    setExportMsg(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_export_path", { path: exportDraft });
      setDto(s);
      setExportMsg({ kind: "ok", text: `Export path saved: ${s.export_path}` });
    } catch (e: any) {
      setExportMsg({ kind: "err", text: String(e?.message ?? e) });
    } finally {
      setSavingExport(false);
    }
  }

  async function saveAi(opts: { localOnly?: boolean } = {}) {
    setSavingAi(true);
    setAiMsg(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", {
        baseUrl: baseUrlDraft,
        model: modelDraft,
        localOnly: opts.localOnly,
      });
      setDto(s);
      setAiMsg({ kind: "ok", text: "AI settings saved." });
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
    } finally {
      setSavingAi(false);
    }
  }

  async function toggleLocalOnly() {
    if (!dto) return;
    if (dto.ai_local_only) {
      // Going from ON → OFF requires explicit confirm
      setConfirmOff(true);
      return;
    }
    // OFF → ON: just save
    await saveAi({ localOnly: true });
  }
  async function confirmTurnOff() {
    setConfirmOff(false);
    await saveAi({ localOnly: false });
  }

  async function testConnection() {
    setTesting(true);
    setConn(null);
    try {
      const r = await invoke<ConnTestResult>("cmd_test_ai_connection");
      setConn(r);
      // Refresh the dropdown opportunistically — same call.
      if (r.reachable) {
        refreshModels();
      }
    } catch (e: any) {
      setConn({ reachable: false, first_model_id: null, message: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="screen">
      <div className="card settings-card">
        <div className="settings-header">
          <h1 className="title">Settings</h1>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>

        <h2 className="settings-h2">Export folder</h2>
        <p className="muted small">Where ReadingGym writes Markdown for books, sessions, and notes.</p>
        <div className="settings-row">
          <input
            className="settings-input"
            type="text"
            value={exportDraft}
            onChange={(e) => setExportDraft(e.target.value)}
            spellCheck={false}
          />
          <button className="ghost" onClick={pickFolder}>Choose…</button>
          <button className="primary" disabled={savingExport || !exportDraft || exportDraft === dto?.export_path} onClick={saveExport}>
            {savingExport ? "Saving…" : "Save"}
          </button>
        </div>
        {dto?.export_path_is_default && (
          <p className="hint">Currently using the default location.</p>
        )}
        {exportMsg && (
          <p className={exportMsg.kind === "ok" ? "settings-ok" : "settings-err"}>{exportMsg.text}</p>
        )}

        <h2 className="settings-h2">Local storage</h2>
        <p className="muted small">All app data lives here. Read-only display.</p>
        <pre className="settings-readonly">{dto?.app_data_path}</pre>
        <p className="hint">
          Rollback: <code>rm -rf {dto?.app_data_path}</code>
        </p>

        <h2 className="settings-h2">AI</h2>
        <p className="muted small">
          ReadingGym calls an OpenAI-compatible chat completions endpoint (LM Studio, llama.cpp, or any local MLX server).
          Run the model yourself; we just call it.
        </p>

        <div className={dto?.ai_local_only ? "ai-posture ai-posture-on" : "ai-posture ai-posture-off"}>
          <strong>{dto?.ai_posture}</strong>
          <button
            className="ghost"
            style={{ float: "right" }}
            disabled={savingAi}
            onClick={toggleLocalOnly}
          >
            {dto?.ai_local_only ? "Turn OFF…" : "Turn ON"}
          </button>
        </div>
        {dto?.ai_local_only ? (
          <p className="muted small">
            The client refuses any non-loopback URL. Remote providers are blocked at the call site, not just at the policy level.
          </p>
        ) : (
          <p className="warn">
            Local-only is OFF. Any remote URL you set will receive the prompt and your selected passage. The reader
            will show a banner whenever AI is used.
          </p>
        )}

        <label className="settings-label">AI base URL
          <input
            className="settings-input"
            type="text"
            value={baseUrlDraft}
            onChange={(e) => setBaseUrlDraft(e.target.value)}
            spellCheck={false}
            placeholder="http://localhost:1234/v1"
          />
        </label>

        <label className="settings-label">Model id
          <div className="settings-row" style={{ marginTop: 0 }}>
            <select
              className="settings-input"
              value={models?.includes(modelDraft) ? modelDraft : ""}
              onChange={(e) => { if (e.target.value) setModelDraft(e.target.value); }}
              disabled={!models || models.length === 0}
            >
              <option value="">
                {loadingModels
                  ? "Loading models from server…"
                  : !models
                    ? (modelsErr ? "Server not reachable — type manually below" : "Pick a detected model…")
                    : models.length === 0
                      ? "(no models loaded in server — type manually below)"
                      : "Pick a detected model…"}
              </option>
              {(models ?? []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <button className="ghost" disabled={loadingModels} onClick={refreshModels} title="Re-query the server for available models">
              {loadingModels ? "…" : "Refresh"}
            </button>
          </div>
          {models && models.length > 0 && (
            <div className="muted small">{models.length} detected via <code>{baseUrlDraft}/models</code>. Pick one above, or type a different id below.</div>
          )}
          {modelsErr && (
            <div className="muted small">Couldn't fetch model list: {modelsErr}</div>
          )}
        </label>
        <label className="settings-label">Or type manually (free-form)
          <input
            className="settings-input"
            type="text"
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            spellCheck={false}
            placeholder="e.g. qwen2.5-7b-instruct or mlx-community/Llama-3.2-3B-Instruct-4bit"
          />
        </label>

        <div className="settings-row">
          <button className="ghost" disabled={testing} onClick={testConnection}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            className="primary"
            disabled={savingAi || (baseUrlDraft === dto?.ai_base_url && modelDraft === dto?.ai_model)}
            onClick={() => saveAi()}
          >
            {savingAi ? "Saving…" : "Save AI settings"}
          </button>
        </div>
        {aiMsg && (
          <p className={aiMsg.kind === "ok" ? "settings-ok" : "settings-err"}>{aiMsg.text}</p>
        )}
        {conn && (
          <p className={conn.reachable ? "settings-ok" : "settings-err"}>
            {conn.message}
          </p>
        )}

        {dto && <AiHistory retentionDays={dto.ai_requests_retention_days} onSettingsChanged={refresh} />}

        <h2 className="settings-h2">Quote safety</h2>
        <p className="muted small">{dto?.quote_policy}</p>
        <p className="hint">Threshold: {dto?.quote_warn_chars} characters.</p>
      </div>

      {confirmOff && (
        <ConfirmLocalOnlyOff
          onCancel={() => setConfirmOff(false)}
          onConfirm={confirmTurnOff}
        />
      )}
    </section>
  );
}

function ConfirmLocalOnlyOff(props: { onCancel: () => void; onConfirm: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, props.onCancel);
  return (
    <div className="panel-backdrop">
      <div
        ref={panelRef}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-local-only-off-title"
      >
        <div className="panel-header">
          <h2 id="confirm-local-only-off-title">Turn off Local-only mode?</h2>
          <button className="ghost" onClick={props.onCancel} aria-label="Close dialog">✕</button>
        </div>
        <p>
          Turning local-only OFF allows the AI client to call <em>any</em> URL you configure,
          including remote providers. The reader will show a banner whenever AI is used.
          Your selected passage and the assembled prompt will be sent to that URL.
        </p>
        <p className="muted small">
          You can turn it back ON any time — but only if the configured URL is loopback.
        </p>
        <div className="panel-actions">
          <button className="ghost" onClick={props.onCancel}>Cancel</button>
          <button className="primary" onClick={props.onConfirm}>
            Yes, turn off local-only
          </button>
        </div>
      </div>
    </div>
  );
}

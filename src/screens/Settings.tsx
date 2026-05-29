import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import RGIcon from "../components/RGIcon";
import AiHistory from "./AiHistory";
import type { ConnTestResult, SettingsDto } from "../types";

export default function Settings() {
  const [dto, setDto] = useState<SettingsDto | null>(null);
  const [savingExport, setSavingExport] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
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
      setModels(await invoke<string[]>("cmd_list_ai_models"));
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
    setBaseUrlDraft(s.ai_base_url);
    setModelDraft(s.ai_model);
  }

  useEffect(() => {
    refresh();
    refreshModels();
  }, []);

  async function pickAndSaveFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setSavingExport(true);
    setExportMsg(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_export_path", { path: picked });
      setDto(s);
      setExportMsg({ kind: "ok", text: `Export folder set to ${s.export_path}` });
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
    if (dto.ai_local_only) { setConfirmOff(true); return; }
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
      if (r.reachable) refreshModels();
    } catch (e: any) {
      setConn({ reachable: false, first_model_id: null, message: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  }

  const aiDirty = !!dto && (baseUrlDraft !== dto.ai_base_url || modelDraft !== dto.ai_model);

  return (
    <div className="rg-body">
      <div className="rg-col rg-settings">
        <h2>Settings</h2>

        {/* ── Storage ── */}
        <div className="rg-set-group">
          <span className="glabel">Storage</span>
          <div className="rg-set-card">
            <div className="rg-set-row">
              <div className="lhs">
                <div className="name">Export folder</div>
                <div className="desc">Where Markdown notes, sessions, and books are written.{dto?.export_path_is_default ? " Currently the default." : ""}</div>
              </div>
              <button className="rg-btn rg-btn-ghost" style={{ padding: "8px 14px", fontSize: 13, maxWidth: 280 }} disabled={savingExport} onClick={pickAndSaveFolder}>
                <RGIcon name="folder" size={16} />
                <span className="ttl" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dto?.export_path ?? "…"}</span>
              </button>
            </div>
            {exportMsg && (
              <div className="rg-set-row"><p className={`rg-set-msg ${exportMsg.kind}`}>{exportMsg.text}</p></div>
            )}
            <div className="rg-set-row">
              <div className="lhs">
                <div className="name">Local storage path</div>
                <div className="desc">Read-only. Your library never leaves this folder.</div>
              </div>
              <span className="rg-path" title={dto?.app_data_path}>{dto?.app_data_path}</span>
            </div>
          </div>
          <p className="hint" style={{ marginTop: "var(--rg-2)" }}>Rollback: <code>rm -rf {dto?.app_data_path}</code></p>
        </div>

        {/* ── Assistance (AI) ── */}
        <div className="rg-set-group">
          <span className="glabel">Assistance</span>
          <div className="rg-set-card">
            <div className="rg-set-row">
              <div className="lhs">
                <div className="name">Local-only mode</div>
                <div className="desc">
                  {dto?.ai_local_only
                    ? "On. The client refuses any non-loopback URL — remote providers are blocked at the call site."
                    : "Off. Any remote URL you set will receive the prompt and your selected passage."}
                </div>
              </div>
              <button
                className="rg-switch"
                role="switch"
                aria-checked={!!dto?.ai_local_only}
                aria-label="Local-only mode"
                disabled={savingAi}
                onClick={toggleLocalOnly}
              />
            </div>

            {confirmOff && (
              <div className="rg-set-row col">
                <p className="rg-set-msg" style={{ color: "var(--rg-warn)" }}>
                  Turn off local-only? The AI client will be allowed to call any URL you configure, including remote providers. Your selected passage and the assembled prompt would be sent there.
                </p>
                <div style={{ display: "flex", gap: "var(--rg-2)", justifyContent: "flex-end" }}>
                  <button className="rg-btn rg-btn-ghost" onClick={() => setConfirmOff(false)}>Cancel</button>
                  <button className="rg-btn rg-btn-primary" onClick={confirmTurnOff}>Yes, turn off</button>
                </div>
              </div>
            )}
            {!dto?.ai_local_only && (
              <div className="rg-set-row">
                <p className="rg-posture-off" style={{ marginTop: 0 }}>Local-only is OFF — the reader shows a banner whenever AI is used.</p>
              </div>
            )}

            <div className="rg-set-row col">
              <div className="lhs">
                <div className="name">Base URL</div>
                <div className="desc">An OpenAI-compatible endpoint (LM Studio, llama.cpp, any local MLX server). Rejected at call time if non-loopback while local-only is on.</div>
              </div>
              <input
                className="rg-input"
                type="text"
                value={baseUrlDraft}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                spellCheck={false}
                placeholder="http://localhost:1234/v1"
              />
            </div>

            <div className="rg-set-row col">
              <div className="lhs">
                <div className="name">Model</div>
                <div className="desc">The model id loaded in your server. Pick a detected one or type it.</div>
              </div>
              <div style={{ display: "flex", gap: "var(--rg-2)" }}>
                <select
                  className="rg-select"
                  value={models?.includes(modelDraft) ? modelDraft : ""}
                  onChange={(e) => { if (e.target.value) setModelDraft(e.target.value); }}
                  disabled={!models || models.length === 0}
                >
                  <option value="">{loadingModels ? "Loading…" : models && models.length > 0 ? "Pick a detected model…" : "No models detected"}</option>
                  {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button className="rg-btn rg-btn-ghost" style={{ padding: "8px 12px", fontSize: 13 }} disabled={loadingModels} onClick={refreshModels}>
                  {loadingModels ? "…" : "Refresh"}
                </button>
              </div>
              <input
                className="rg-input"
                type="text"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                spellCheck={false}
                placeholder="e.g. qwen2.5-7b-instruct"
              />
            </div>

            <div className="rg-set-row">
              <button className="rg-btn rg-btn-ghost" style={{ padding: "8px 14px", fontSize: 13 }} disabled={testing} onClick={testConnection}>
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button className="rg-btn rg-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} disabled={savingAi || !aiDirty} onClick={() => saveAi()}>
                {savingAi ? "Saving…" : "Save AI settings"}
              </button>
            </div>
            {(aiMsg || conn || modelsErr) && (
              <div className="rg-set-row col">
                {aiMsg && <p className={`rg-set-msg ${aiMsg.kind}`}>{aiMsg.text}</p>}
                {conn && <p className={`rg-set-msg ${conn.reachable ? "ok" : "err"}`}>{conn.message}</p>}
                {modelsErr && !conn && <p className="rg-set-msg" style={{ color: "var(--rg-muted)" }}>Couldn't list models: {modelsErr}</p>}
              </div>
            )}
          </div>
        </div>

        {/* ── Request history (audit) ── */}
        {dto && <AiHistory retentionDays={dto.ai_requests_retention_days} onSettingsChanged={refresh} />}

        {/* ── Quote safety ── */}
        <div className="rg-set-group">
          <span className="glabel">Quote safety</span>
          <div className="rg-set-card">
            <div className="rg-set-row col">
              <div className="lhs">
                <div className="name">Short quotes only</div>
                <div className="desc">{dto?.quote_policy}</div>
              </div>
              <span className="val">Warns above {dto?.quote_warn_chars} characters.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

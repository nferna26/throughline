import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import TLIcon from "../components/TLIcon";
import ModelSelect from "../components/ModelSelect";
import AiUsageCard from "../components/AiUsageCard";
import CompanyPanel from "../components/CompanyPanel";
import CodexLogin from "../components/CodexLogin";
import AiHistory from "./AiHistory";
import UpdateChecker from "../components/UpdateChecker";
import { isTutorEnabled, setTutorEnabled } from "../tutorConsent";
import { AI_PROVIDERS, aiProviderLabel, type ConnTestResult, type SettingsDto } from "../types";

/** The stored model id for a provider, from a settings DTO. */
function modelForProvider(s: SettingsDto, prov: string): string {
  switch (prov) {
    case "openai": return s.ai_model_openai;
    case "anthropic": return s.ai_model_anthropic;
    case "codex": return s.ai_model_codex;
    default: return s.ai_model;
  }
}

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
  const [providerDraft, setProviderDraft] = useState<string>("local");
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  // Local AI tutor consent (opt-in, revocable). A UI preference in localStorage,
  // shared with the in-margin consent card via tutorConsent.
  const [tutorOn, setTutorOn] = useState(isTutorEnabled);

  // Detect models for the CURRENTLY SELECTED (draft) provider + local base URL,
  // not the saved one — otherwise switching back to Local lists the previously
  // saved provider's models (or nothing) and never re-detects.
  async function refreshModels(prov: string, baseUrl: string) {
    setLoadingModels(true);
    setModelsErr(null);
    try {
      setModels(await invoke<string[]>("cmd_list_ai_models", { provider: prov, baseUrl }));
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
    const prov = s.ai_provider && s.ai_provider !== "none" ? s.ai_provider : "local";
    setProviderDraft(prov);
    setModelDraft(modelForProvider(s, prov));
  }

  useEffect(() => {
    refresh();
  }, []);

  // Re-detect models whenever the chosen provider or the local base URL changes,
  // so switching back to Local (or editing the endpoint) repopulates the dropdown
  // instead of going stale. Debounced so typing a URL doesn't spam the endpoint.
  useEffect(() => {
    const h = setTimeout(() => refreshModels(providerDraft, baseUrlDraft), 250);
    return () => clearTimeout(h);
  }, [providerDraft, baseUrlDraft]);

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

  const needsKey = providerDraft === "openai" || providerDraft === "anthropic";

  async function saveAi() {
    setSavingAi(true);
    setAiMsg(null);
    try {
      if (needsKey && keyDraft.trim()) {
        await invoke<SettingsDto>("cmd_set_ai_key", { provider: providerDraft, key: keyDraft.trim() });
        setKeyDraft("");
      }
      const args: Record<string, unknown> = { provider: providerDraft, model: modelDraft };
      if (providerDraft === "local") args.baseUrl = baseUrlDraft;
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", args);
      setDto(s);
      setAiMsg({ kind: "ok", text: "AI settings saved." });
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
    } finally {
      setSavingAi(false);
    }
  }

  async function clearKey() {
    try {
      const s = await invoke<SettingsDto>("cmd_clear_ai_key", { provider: providerDraft });
      setDto(s);
      setAiMsg({ kind: "ok", text: "API key removed." });
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
    }
  }

  function onProviderChange(prov: string) {
    setProviderDraft(prov);
    setConn(null);
    setKeyDraft("");
    if (dto) setModelDraft(modelForProvider(dto, prov));
  }

  async function testConnection() {
    setTesting(true);
    setConn(null);
    try {
      const r = await invoke<ConnTestResult>("cmd_test_ai_connection", {
        provider: providerDraft,
        key: needsKey && keyDraft.trim() ? keyDraft.trim() : undefined,
      });
      setConn(r);
      if (r.reachable && providerDraft === "local") refreshModels(providerDraft, baseUrlDraft);
    } catch (e: any) {
      setConn({ reachable: false, first_model_id: null, message: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="tl-body">
      <div className="tl-col tl-settings">
        <h2>Settings</h2>

        {/* ── Your data (at-a-glance trust summary) ── A plain, accurate
            statement of the privacy contract so the reader never has to infer
            it from scattered toggles. Every line is literally true of the
            current build (see AGENTS.md "Copyright & privacy posture"). */}
        <div className="tl-set-group">
          <span className="glabel">Your data</span>
          <div className="tl-set-card tl-trust-card">
            <ul className="tl-trust-list">
              <li><TLIcon name="shield" size={15} /> Your book files stay on this Mac. They are never uploaded or exported.</li>
              <li><TLIcon name="shield" size={15} /> Exports contain your own words — paraphrases, reflections, short quotes, and locators. The raw book text is never written out.</li>
              <li><TLIcon name="shield" size={15} /> AI answers are based only on the passage or section you choose{dto?.ai_remote_allowed ? " — which is the only thing sent to the cloud provider, never the whole book" : ", and run on a local model on this Mac. Nothing is sent until you act"}.</li>
              <li><TLIcon name="shield" size={15} /> AI output becomes a saved note only when you choose to keep it.</li>
            </ul>
            {dto?.ai_remote_allowed && (
              <p className="tl-trust-warn"><TLIcon name="behind" size={14} /> AI is set to <strong>{aiProviderLabel(dto.ai_provider)}</strong> — {dto.ai_posture}. Only that selection leaves this Mac; your book file never does. Switch to Local below to keep everything on-device.</p>
            )}
            {dto?.ai_provider === "none" && (
              <p className="tl-trust-warn"><TLIcon name="behind" size={14} /> AI is turned off. Choose a provider below to enable the tutor and Deep Study.</p>
            )}
          </div>
        </div>

        {/* ── Storage ── */}
        <div className="tl-set-group">
          <span className="glabel">Storage</span>
          <div className="tl-set-card">
            <div className="tl-set-row">
              <div className="lhs">
                <div className="name">Export folder</div>
                <div className="desc">Where Markdown notes, sessions, and books are written.{dto?.export_path_is_default ? " Currently the default." : ""}</div>
              </div>
              <button className="tl-btn tl-btn-ghost" style={{ padding: "8px 14px", fontSize: 13, maxWidth: 280 }} disabled={savingExport} onClick={pickAndSaveFolder}>
                <TLIcon name="folder" size={16} />
                <span className="ttl" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dto?.export_path ?? "…"}</span>
              </button>
            </div>
            {exportMsg && (
              <div className="tl-set-row"><p className={`tl-set-msg ${exportMsg.kind}`}>{exportMsg.text}</p></div>
            )}
            <div className="tl-set-row">
              <div className="lhs">
                <div className="name">Local storage path</div>
                <div className="desc">Read-only. Your library never leaves this folder.</div>
              </div>
              <span className="tl-path" title={dto?.app_data_path}>{dto?.app_data_path}</span>
            </div>
          </div>
        </div>

        {/* ── Assistance (AI) ── */}
        <div className="tl-set-group">
          <span className="glabel">Assistance</span>
          <div className="tl-set-card">
            <div className="tl-set-row">
              <div className="lhs">
                <div className="name">Local AI tutor</div>
                <div className="desc">
                  {tutorOn
                    ? "On. Select a passage and choose a lens (Explain · Context · Define) to stream a local answer in the margin. Turn off to require consent again before the next call."
                    : "Off (opt-in). The first time you open a tutor lens, Throughline asks for consent before any local model call."}
                </div>
              </div>
              <button
                className="tl-switch"
                role="switch"
                aria-checked={tutorOn}
                aria-label="Local AI tutor"
                onClick={() => { const next = !tutorOn; setTutorEnabled(next); setTutorOn(next); }}
              />
            </div>

            <div className="tl-set-row col">
              <div className="lhs">
                <div className="name">AI provider</div>
                <div className="desc">Where the tutor and Deep Study run. Local stays on this Mac; cloud providers use your own key or login.</div>
              </div>
              <select
                className="tl-select"
                value={providerDraft}
                aria-label="AI provider"
                onChange={(e) => onProviderChange(e.target.value)}
              >
                {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value="none">Off (no AI)</option>
              </select>
              <p className="tl-posture-off" style={{ marginTop: 0 }}>
                {providerDraft === "none"
                  ? "AI is turned off."
                  : AI_PROVIDERS.find((p) => p.id === providerDraft)?.disclosure}
              </p>
              {providerDraft === "codex" && (
                <p className="tl-trust-warn" style={{ marginTop: "var(--tl-3)", paddingTop: 0, borderTop: "none" }}>
                  <TLIcon name="behind" size={14} /> <span><strong>Experimental.</strong> Codex talks to an unofficial ChatGPT endpoint that can change or break without warning. For a reliable tutor, choose OpenAI or Anthropic with your own API key.</span>
                </p>
              )}
            </div>

            {providerDraft === "company" && <CompanyPanel onActivated={refresh} />}

            {providerDraft === "local" && (
              <>
                <div className="tl-set-row col">
                  <div className="lhs">
                    <div className="name">Base URL</div>
                    <div className="desc">An OpenAI-compatible local endpoint (LM Studio, llama.cpp). Must be a loopback address.</div>
                  </div>
                  <input className="tl-input" type="text" value={baseUrlDraft} onChange={(e) => setBaseUrlDraft(e.target.value)} spellCheck={false} placeholder="http://localhost:1234/v1" />
                </div>
                <div className="tl-set-row col">
                  <div className="lhs">
                    <div className="name">Model</div>
                    <div className="desc">The model id loaded in your server. Pick a detected one or type it.</div>
                  </div>
                  <div style={{ display: "flex", gap: "var(--tl-2)" }}>
                    <select className="tl-select" aria-label="AI model" value={models?.includes(modelDraft) ? modelDraft : ""} onChange={(e) => { if (e.target.value) setModelDraft(e.target.value); }} disabled={!models || models.length === 0}>
                      <option value="">{loadingModels ? "Loading…" : models && models.length > 0 ? "Pick a detected model…" : "No models detected"}</option>
                      {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button className="tl-btn tl-btn-ghost" style={{ padding: "8px 12px", fontSize: 13 }} disabled={loadingModels} onClick={() => refreshModels(providerDraft, baseUrlDraft)}>{loadingModels ? "…" : "Refresh"}</button>
                  </div>
                  <input className="tl-input" type="text" value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} spellCheck={false} placeholder="e.g. qwen2.5-7b-instruct" />
                </div>
              </>
            )}

            {needsKey && (
              <>
                <div className="tl-set-row col">
                  <div className="lhs">
                    <div className="name">{aiProviderLabel(providerDraft)} API key</div>
                    <div className="desc">
                      {(providerDraft === "openai" ? dto?.ai_key_present_openai : dto?.ai_key_present_anthropic)
                        ? "A key is saved in your Keychain. Enter a new one to replace it, or remove it."
                        : "Stored in your macOS Keychain — never written to disk, the database, or exports."}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "var(--tl-2)", alignItems: "center" }}>
                    <input className="tl-input" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} autoComplete="off" spellCheck={false} placeholder={providerDraft === "openai" ? "sk-…" : "sk-ant-…"} />
                    {(providerDraft === "openai" ? dto?.ai_key_present_openai : dto?.ai_key_present_anthropic) && (
                      <button className="tl-btn tl-btn-ghost" style={{ padding: "8px 12px", fontSize: 13 }} onClick={clearKey}>Remove</button>
                    )}
                  </div>
                </div>
                <div className="tl-set-row col">
                  <div className="lhs">
                    <div className="name">Model</div>
                    <div className="desc">Defaults to the best-value model; the chip shows its price per million tokens.</div>
                  </div>
                  <ModelSelect provider={providerDraft} value={modelDraft} onChange={setModelDraft} />
                </div>
              </>
            )}

            {providerDraft === "codex" && (
              <div className="tl-set-row col">
                <div className="lhs">
                  <div className="name">ChatGPT sign-in</div>
                  <div className="desc">Sign in once with your ChatGPT account — no API key needed. Stored in your Keychain, independent of the Codex CLI.</div>
                </div>
                <CodexLogin present={!!dto?.ai_codex_creds_present} onComplete={refresh} onSignedOut={refresh} />
              </div>
            )}

            {/* Company mode activates via CompanyPanel, not the key/model Save flow. */}
            {providerDraft !== "company" && (
              <div className="tl-set-row">
                <button className="tl-btn tl-btn-ghost" style={{ padding: "8px 14px", fontSize: 13 }} disabled={testing} onClick={testConnection}>
                  {testing ? "Testing…" : "Test connection"}
                </button>
                <button className="tl-btn tl-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} disabled={savingAi} onClick={() => saveAi()}>
                  {savingAi ? "Saving…" : "Save AI settings"}
                </button>
              </div>
            )}
            {(aiMsg || conn || modelsErr) && (
              <div className="tl-set-row col">
                {aiMsg && <p className={`tl-set-msg ${aiMsg.kind}`}>{aiMsg.text}</p>}
                {conn && <p className={`tl-set-msg ${conn.reachable ? "ok" : "err"}`}>{conn.message}</p>}
                {modelsErr && !conn && <p className="tl-set-msg" style={{ color: "var(--tl-muted)" }}>Couldn't list models: {modelsErr}</p>}
              </div>
            )}
          </div>
        </div>

        {/* ── AI usage + spend cap (B4) ── */}
        <AiUsageCard />

        {/* ── Request history (audit) ── */}
        {dto && <AiHistory retentionDays={dto.ai_requests_retention_days} onSettingsChanged={refresh} />}

        {/* ── Quote safety ── */}
        <div className="tl-set-group">
          <span className="glabel">Quote safety</span>
          <div className="tl-set-card">
            <div className="tl-set-row col">
              <div className="lhs">
                <div className="name">Short quotes only</div>
                <div className="desc">{dto?.quote_policy}</div>
              </div>
              <span className="val">Warns above {dto?.quote_warn_chars} characters.</span>
            </div>
          </div>
        </div>

        {/* ── Software updates (reader-initiated; never checks in the background) ── */}
        <div className="tl-set-group">
          <span className="glabel">Software</span>
          <div className="tl-set-card">
            <div className="tl-set-row col">
              <div className="lhs">
                <div className="name">Updates</div>
                <div className="desc">Throughline only checks when you ask — never on its own. Updates are signed; an install downloads the new version and restarts the app.</div>
              </div>
              <UpdateChecker />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

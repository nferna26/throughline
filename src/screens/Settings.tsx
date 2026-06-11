import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import ModelSelect from "../components/ModelSelect";
import CodexLogin from "../components/CodexLogin";
import UpdateChecker from "../components/UpdateChecker";
import { isTutorEnabled, setTutorEnabled } from "../tutorConsent";
import {
  AI_PROVIDERS,
  aiProviderLabel,
  type AiRequest,
  type CompanyCredits,
  type ConnTestResult,
  type LibraryExportResult,
  type SettingsDto,
} from "../types";
import "../tl-settings.css";

/* ── Icons (Lucide-style, 20-grid, currentColor) — authored inline so the
   redesign carries the handoff's exact glyphs without a new dependency. */
function Icon({ d, size = 16, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}
const ICON = {
  sparkle: "M10 2.5l1.7 4.6 4.6 1.7-4.6 1.7L10 15.1 8.3 10.5 3.7 8.8l4.6-1.7z",
  key: "M8.5 8.5a3 3 0 1 0-3 3 3 3 0 0 0 3-3zM8.5 8.5l4 4 1.5-1.5 1.5 1.5 1.5-1.5-3-3z",
  monitor: "M3 4.5h14v9.5H3zM7 17h6M10 14v3",
  info: "M10 2.4a7.6 7.6 0 1 0 0 15.2A7.6 7.6 0 0 0 10 2.4zM10 9.2v4M10 6.6v.1",
  shield: "M10 2.2l6 2.3v4.2c0 3.7-2.5 6.6-6 8-3.5-1.4-6-4.3-6-8V4.5zM7.3 9.8l1.9 1.9 3.5-3.7",
  check: "M3.5 10.5 8 15l8.5-9.5",
  clock: "M10 2.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8zM10 6.4v4.2l2.6 1.6",
  gauge: "M3 12a7 7 0 0 1 14 0M10 12l3.4-3",
  disk: "M3 6.5C3 5 6.1 4 10 4s7 1 7 2.5M3 6.5v7C3 15 6.1 16 10 16s7-1 7-2.5v-7M3 10c0 1.5 3.1 2.5 7 2.5s7-1 7-2.5",
  chevron: "M7 5l5 5-5 5",
  up: "M10 15V5M6 9l4-4 4 4",
  trash: "M4 6h12M8 6V4.5h4V6M6 6l.6 9.5h6.8L15 6",
  folder:
    "M3 6.5C3 5.7 3.7 5 4.5 5H8l1.5 1.5h6c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-11C3.7 15.5 3 14.8 3 14z",
  warn: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM10 6.5v4.5M10 13.4v.1",
  caretUp: "M5 12l5-5 5 5",
  caretDown: "M5 8l5 5 5-5",
} as const;

/* ── Plain lens labels (FT-12): never show an internal id like
   "section_briefing". Maps every backend lens/mode value to a short,
   sentence-case reader word. Falls back to the raw value only if a new mode
   is added before this map is updated (still no hostname/ids leak). */
const LENS_LABEL: Record<string, string> = {
  explain: "Explain",
  historical: "Historical context",
  vocabulary: "Define",
  socratic: "Ask questions",
  durable_note: "Saved note",
  prepare_next: "Prepare next reading",
  section_briefing: "Section briefing",
  define: "Define",
  context: "Context",
};
function lensLabel(mode: string): string {
  return LENS_LABEL[mode] ?? mode.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The trailing folder name of a path, for reader-facing copy — never the
 *  full path. Returns "" when there's nothing meaningful to show. */
function folderDisplayName(path: string | null | undefined): string {
  const trimmed = (path ?? "").replace(/[/\\]+$/, "");
  const name = trimmed.split(/[/\\]/).pop();
  return name && name.length ? name : "";
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

/** The stored model id for a provider, from a settings DTO. */
function modelForProvider(s: SettingsDto, prov: string): string {
  switch (prov) {
    case "openai": return s.ai_model_openai;
    case "anthropic": return s.ai_model_anthropic;
    case "codex": return s.ai_model_codex;
    default: return s.ai_model;
  }
}

/** The three conceptual modes the reader sees, mapped to the real provider enum. */
type Mode = "included" | "own_key" | "local";
function modeForProvider(prov: string): Mode {
  if (prov === "company") return "included";
  if (prov === "local") return "local";
  return "own_key"; // anthropic | openai | codex
}

const KEY_PROVIDERS = AI_PROVIDERS.filter((p) => p.id === "anthropic" || p.id === "openai" || p.id === "codex");

export default function Settings() {
  const [dto, setDto] = useState<SettingsDto | null>(null);

  // Files
  const [savingExport, setSavingExport] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Export your library (one Markdown file per book under the chosen folder).
  const [exportingLib, setExportingLib] = useState(false);
  const [libExportMsg, setLibExportMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Allowance meter (real, from cmd_company_credits)
  const [credits, setCredits] = useState<CompanyCredits | null>(null);

  // BYO / on-this-Mac controls (draft, mirrors current Settings flow)
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [savingAi, setSavingAi] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [conn, setConn] = useState<ConnTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  // providerDraft is the FALLBACK provider chosen inside the expander
  // (anthropic | openai | codex | local). Defaults to anthropic for "own key".
  const [providerDraft, setProviderDraft] = useState<string>("anthropic");
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  // Tutor consent (localStorage, shared with the in-margin card)
  const [tutorOn, setTutorOn] = useState(isTutorEnabled);

  // The fallback expander is open when the saved provider isn't the included one.
  const [byoOpen, setByoOpen] = useState(false);

  // Audit (reframed history) — loaded inline
  const [requests, setRequests] = useState<AiRequest[] | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<number>(90);
  const [forgetMsg, setForgetMsg] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const provider = dto?.ai_provider ?? "";
  const mode: Mode = modeForProvider(provider);
  const needsKey = providerDraft === "openai" || providerDraft === "anthropic";
  // A saved key already in the Keychain for the drafted key-provider.
  const keyPresent =
    providerDraft === "openai"
      ? !!dto?.ai_key_present_openai
      : providerDraft === "anthropic"
        ? !!dto?.ai_key_present_anthropic
        : false;
  // "Use this" may only commit a fallback that will actually answer: local and
  // Codex (own sign-in) are always committable; a key-provider needs a key
  // typed or already saved. This is what keeps a curious click off the working
  // included assistant — selecting a segment only reveals its controls; nothing
  // switches until the reader commits here.
  const canCommitFallback =
    providerDraft === "local" ||
    providerDraft === "codex" ||
    keyDraft.trim().length > 0 ||
    keyPresent;

  async function refresh() {
    const s = await invoke<SettingsDto>("cmd_get_settings");
    setDto(s);
    setBaseUrlDraft(s.ai_base_url);
    setRetentionDraft(s.ai_requests_retention_days);
    // Seed the fallback draft from the saved provider when it's a fallback one;
    // otherwise leave the reader's last in-expander choice intact.
    if (s.ai_provider && s.ai_provider !== "company" && s.ai_provider !== "none") {
      setProviderDraft(s.ai_provider);
      setModelDraft(modelForProvider(s, s.ai_provider));
      setByoOpen(true);
    } else {
      setModelDraft(modelForProvider(s, providerDraft));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Real allowance, only meaningful in the included (company) mode.
  useEffect(() => {
    if (provider !== "company") {
      setCredits(null);
      return;
    }
    let alive = true;
    invoke<CompanyCredits>("cmd_company_credits")
      .then((c) => alive && setCredits(c))
      .catch(() => alive && setCredits(null));
    return () => {
      alive = false;
    };
  }, [provider]);

  // Audit list.
  useEffect(() => {
    let alive = true;
    invoke<AiRequest[]>("cmd_list_ai_requests")
      .then((r) => alive && setRequests(r))
      .catch(() => alive && setRequests([]));
    return () => {
      alive = false;
    };
  }, []);

  // A company activation elsewhere (e.g. a throughline://activate deep link)
  // should refresh the settings and the allowance meter even while Settings is
  // already open — App dispatches `tl-company-activated` for exactly this.
  useEffect(() => {
    const onActivated = () => {
      refresh();
      invoke<CompanyCredits>("cmd_company_credits")
        .then(setCredits)
        .catch(() => setCredits(null));
    };
    window.addEventListener("tl-company-activated", onActivated);
    return () => window.removeEventListener("tl-company-activated", onActivated);
  }, []);

  // Detect local models when the local mode + its base URL change (debounced).
  useEffect(() => {
    if (providerDraft !== "local") return;
    const h = setTimeout(() => refreshModels(baseUrlDraft), 250);
    return () => clearTimeout(h);
  }, [providerDraft, baseUrlDraft]);

  async function refreshModels(baseUrl: string) {
    setLoadingModels(true);
    try {
      setModels(await invoke<string[]>("cmd_list_ai_models", { provider: "local", baseUrl }));
    } catch {
      setModels(null);
    } finally {
      setLoadingModels(false);
    }
  }

  async function pickAndSaveFolder() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setSavingExport(true);
    setExportMsg(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_export_path", { path: picked });
      setDto(s);
      setExportMsg({ kind: "ok", text: "Export folder updated." });
    } catch (e: any) {
      setExportMsg({ kind: "err", text: String(e?.message ?? e) });
    } finally {
      setSavingExport(false);
    }
  }

  // Export the whole library to clean Markdown — one literature note per book.
  // Names the folder, never a raw path; every error says what happened + what to do.
  async function exportLibrary() {
    setExportingLib(true);
    setLibExportMsg(null);
    try {
      const r = await invoke<LibraryExportResult>("cmd_export_library");
      const folder = folderDisplayName(r.root) || exportFolderName;
      setLibExportMsg({
        kind: "ok",
        text:
          r.exported === 0
            ? `No books to export yet — add a book first, then export to your ${folder} folder.`
            : `Exported ${r.exported} book${r.exported === 1 ? "" : "s"} to your ${folder} folder.`,
      });
    } catch (e: any) {
      setLibExportMsg({
        kind: "err",
        text: `Couldn't export your library: ${String(e?.message ?? e)}. Your books are unchanged — try again, or pick a different export folder above.`,
      });
    } finally {
      setExportingLib(false);
    }
  }

  function toggleTutor() {
    const next = !tutorOn;
    setTutorEnabled(next);
    setTutorOn(next);
  }

  // ── "Where answers come from" mode switching ──────────────────────
  async function selectIncluded() {
    setAiMsg(null);
    setConn(null);
    try {
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", {
        provider: "company",
        model: modelForProvider(dto!, "company"),
      });
      setDto(s);
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
    }
  }

  function onFallbackProvider(prov: string) {
    setProviderDraft(prov);
    setConn(null);
    setKeyDraft("");
    if (dto) setModelDraft(modelForProvider(dto, prov));
  }

  async function saveFallback(targetProvider: string) {
    setSavingAi(true);
    setAiMsg(null);
    try {
      const needs = targetProvider === "openai" || targetProvider === "anthropic";
      if (needs && keyDraft.trim()) {
        await invoke<SettingsDto>("cmd_set_ai_key", { provider: targetProvider, key: keyDraft.trim() });
        setKeyDraft("");
      }
      const args: Record<string, unknown> = { provider: targetProvider, model: modelDraft };
      if (targetProvider === "local") args.baseUrl = baseUrlDraft;
      const s = await invoke<SettingsDto>("cmd_set_ai_settings", args);
      setDto(s);
      setAiMsg({ kind: "ok", text: "Saved." });
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
      setAiMsg({ kind: "ok", text: "Key removed." });
    } catch (e: any) {
      setAiMsg({ kind: "err", text: String(e?.message ?? e) });
    }
  }

  async function testConnection() {
    setTesting(true);
    setConn(null);
    try {
      const r = await invoke<ConnTestResult>("cmd_test_ai_connection", {
        provider: providerDraft,
        key: needsKey && keyDraft.trim() ? keyDraft.trim() : undefined,
        baseUrl: baseUrlDraft,
      });
      setConn(r);
      if (r.reachable && providerDraft === "local") refreshModels(baseUrlDraft);
    } catch (e: any) {
      setConn({ reachable: false, first_model_id: null, message: String(e?.message ?? e) });
    } finally {
      setTesting(false);
    }
  }

  // ── Audit (retention + forget) ────────────────────────────────────
  async function saveRetention(next: number) {
    const n = Math.max(0, next);
    setRetentionDraft(n);
    try {
      await invoke<SettingsDto>("cmd_set_ai_settings", { retentionDays: n });
      await refresh();
    } catch {
      /* keep the optimistic value; refresh restores truth */
    }
  }

  async function forgetNow() {
    setForgetting(true);
    setForgetMsg(null);
    try {
      const removed = await invoke<number>("cmd_forget_ai_history");
      setRequests(await invoke<AiRequest[]>("cmd_list_ai_requests"));
      setForgetMsg(
        removed === 0
          ? "Nothing to forget — nothing is past the window."
          : `Forgot ${removed} entr${removed === 1 ? "y" : "ies"} past the window. Anything saved as a note was kept.`,
      );
    } catch (e: any) {
      setForgetMsg(String(e?.message ?? e));
    } finally {
      setForgetting(false);
    }
  }

  // ── Allowance derivation (FT-11): real fraction → bar + state word ──
  const allowance = useMemo(() => {
    if (!credits || credits.status !== "active") return null;
    const frac = Math.max(0, Math.min(1, credits.remaining_fraction));
    // "Running low" once genuinely low; otherwise calm "Plenty left". The
    // boundary (>0.33 = plenty) mirrors the in-margin fuel gauge so the two
    // surfaces never disagree about how much is left.
    const low = frac <= 0.33;
    return { pct: Math.round(frac * 100), low, state: low ? "Running low" : "Plenty left" };
  }, [credits]);

  // ── Audit grouping (by book) for the expanded list ─────────────────
  const grouped = useMemo(() => {
    const sent = (requests ?? []).filter((r) => r.provider != null);
    const groups = new Map<string, AiRequest[]>();
    for (const r of sent) {
      const title = r.book_title ?? "A removed book";
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title)!.push(r);
    }
    const sentCount = sent.length;
    const localOnly = (requests ?? []).length - sentCount;
    return { groups: Array.from(groups.entries()), sentCount, localOnly };
  }, [requests]);

  // Display name for the export folder (FT: a chip shows the folder's name,
  // not a full path).
  const exportFolderName = useMemo(
    () => folderDisplayName(dto?.export_path) || "Reading",
    [dto?.export_path],
  );

  return (
    <div className="tl-body tl-settings2">
      <div className="col2">
        <h2 className="page-title">Settings</h2>
        <p className="page-sub">Throughline · a calm place to read</p>

        {/* ═══════════════ 1 · READING ASSISTANT ═══════════════ */}
        <section className="section">
          <h3 className="section-h">Reading assistant</h3>
          <div className="card">
            {/* Tutor on/off */}
            <div className="row row-flex">
              <div className="row-main">
                <p className="row-title">Tutor in the margin</p>
                <p className="row-desc">
                  Select a passage and choose Explain, Context, or Define to get a short answer
                  beside what you're reading.
                </p>
              </div>
              <div className="row-control">
                <button
                  className="toggle"
                  role="switch"
                  aria-checked={tutorOn}
                  aria-label="Tutor in the margin"
                  onClick={toggleTutor}
                />
              </div>
            </div>

            {/* Where answers come from — paid-primary + quiet fallback expander */}
            <div className="row">
              <p className="row-title">Where answers come from</p>
              <p className="row-desc">Choose who answers your questions. You can change this anytime.</p>

              {/* The included assistant is the calm default. */}
              <p className="primary-note">
                <Icon d={ICON.sparkle} size={15} />
                <span>
                  Answers come from Throughline's included assistant. No setup — it just works.
                  Only the passage you select is sent to get an answer.
                </span>
              </p>

              {/* Allowance meter — shown only in the included mode, real data. */}
              {mode === "included" && allowance && (
                <div className={`allowance${allowance.low ? " low" : ""}`}>
                  <div className="allowance-top">
                    <span className="allowance-label">
                      <Icon d={ICON.gauge} size={16} />
                      Reading help remaining
                    </span>
                    <span className="allowance-state">{allowance.state}</span>
                  </div>
                  <div
                    className="meter"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={allowance.pct}
                    aria-label={`Reading help remaining: ${allowance.state}`}
                  >
                    <div className="meter-fill" style={{ width: `${allowance.pct}%` }} />
                  </div>
                  <p className="allowance-foot">
                    {allowance.low
                      ? "Included with your one-time purchase, and running low. When it's gone you can keep going with your own AI below — your own key or a model on this Mac."
                      : "Included with your one-time purchase — enough for weeks of normal reading. The margin lets you know if it ever runs low."}
                  </p>
                </div>
              )}

              {/* Quiet fallback expander */}
              <details className="byo" open={byoOpen} onToggle={(e) => setByoOpen((e.target as HTMLDetailsElement).open)}>
                <summary>
                  <Icon d={ICON.chevron} size={15} className="chev" />
                  Use your own AI instead
                </summary>

                {/* Body is rendered only when the disclosure is open, so the
                    key/local controls are genuinely absent (not just hidden)
                    until the reader asks for them. */}
                {byoOpen && (
                <div className="byo-body">
                  {/* Two fallback modes: own key · on this Mac only */}
                  <div className="segmented" role="group" aria-label="Use your own AI">
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={providerDraft !== "local"}
                      onClick={() =>
                        onFallbackProvider(providerDraft === "local" ? "anthropic" : providerDraft)
                      }
                    >
                      <Icon d={ICON.key} size={18} />
                      Your own key
                    </button>
                    <button
                      type="button"
                      className="seg"
                      aria-pressed={providerDraft === "local"}
                      onClick={() => onFallbackProvider("local")}
                    >
                      <Icon d={ICON.monitor} size={18} />
                      On this Mac only
                    </button>
                  </div>

                  {providerDraft !== "local" && (
                    <>
                      <div className="field">
                        <span className="field-label">Which service</span>
                        <select
                          className="select"
                          aria-label="Which service"
                          value={providerDraft}
                          onChange={(e) => onFallbackProvider(e.target.value)}
                        >
                          {KEY_PROVIDERS.map((p) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                      </div>

                      {needsKey && (
                        <>
                          <div className="field">
                            <span className="field-label">{aiProviderLabel(providerDraft)} key</span>
                            <p className="field-desc">
                              {(providerDraft === "openai" ? dto?.ai_key_present_openai : dto?.ai_key_present_anthropic)
                                ? "A key is saved in your Keychain. Enter a new one to replace it, or remove it."
                                : "Stored in your macOS Keychain — never written to disk or exports."}
                            </p>
                            <div className="field-row">
                              <input
                                className="input"
                                type="password"
                                value={keyDraft}
                                onChange={(e) => setKeyDraft(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={providerDraft === "openai" ? "sk-…" : "sk-ant-…"}
                                aria-label={`${aiProviderLabel(providerDraft)} key`}
                              />
                              {(providerDraft === "openai" ? dto?.ai_key_present_openai : dto?.ai_key_present_anthropic) ? (
                                <button type="button" className="btn" onClick={clearKey}>Remove</button>
                              ) : null}
                            </div>
                            {!(providerDraft === "openai" ? dto?.ai_key_present_openai : dto?.ai_key_present_anthropic) && (
                              <p className="byo-warn">
                                <Icon d={ICON.warn} size={15} />
                                <span>Add a key to start answering. Until then, the included assistant keeps working.</span>
                              </p>
                            )}
                          </div>

                          <div className="field">
                            <span className="field-label">Model</span>
                            <p className="field-desc">The chip shows the going rate for heavier vs. lighter models.</p>
                            <ModelSelect provider={providerDraft} value={modelDraft} onChange={setModelDraft} />
                          </div>
                        </>
                      )}

                      {providerDraft === "codex" && (
                        <div className="field">
                          <span className="field-label">ChatGPT sign-in</span>
                          <p className="field-desc">
                            Sign in once with your ChatGPT account — no key needed. Stored in your Keychain.
                          </p>
                          <CodexLogin
                            present={!!dto?.ai_codex_creds_present}
                            onComplete={refresh}
                            onSignedOut={refresh}
                          />
                        </div>
                      )}
                    </>
                  )}

                  {providerDraft === "local" && (
                    <>
                      <div className="field">
                        <span className="field-label">Server address</span>
                        <p className="field-desc">
                          Where your local model listens on this Mac (LM Studio's default works as-is).
                        </p>
                        <input
                          className="input"
                          type="text"
                          value={baseUrlDraft}
                          onChange={(e) => setBaseUrlDraft(e.target.value)}
                          spellCheck={false}
                          placeholder="http://localhost:1234/v1"
                          aria-label="Server address"
                        />
                      </div>
                      <div className="field">
                        <span className="field-label">Model</span>
                        <p className="field-desc">Pick a detected one or type it.</p>
                        <div className="field-row">
                          <select
                            className="select"
                            aria-label="Local model"
                            value={models?.includes(modelDraft) ? modelDraft : ""}
                            onChange={(e) => { if (e.target.value) setModelDraft(e.target.value); }}
                            disabled={!models || models.length === 0}
                          >
                            <option value="">
                              {loadingModels ? "Loading…" : models && models.length > 0 ? "Pick a detected model…" : "No models detected"}
                            </option>
                            {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                          </select>
                          <input
                            className="input"
                            type="text"
                            value={modelDraft}
                            onChange={(e) => setModelDraft(e.target.value)}
                            spellCheck={false}
                            placeholder="e.g. qwen2.5-7b-instruct"
                            aria-label="Local model name"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {/* Test + save for the chosen fallback */}
                  <div className="field-row">
                    <button type="button" className="btn" disabled={testing} onClick={testConnection}>
                      {testing ? "Testing…" : "Test"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-accent"
                      disabled={savingAi || !canCommitFallback}
                      onClick={() => saveFallback(providerDraft)}
                    >
                      {savingAi ? "Saving…" : "Use this"}
                    </button>
                    {/* Return to the included assistant */}
                    {mode !== "included" && (
                      <button type="button" className="btn" onClick={selectIncluded}>
                        Back to included assistant
                      </button>
                    )}
                  </div>
                  {(aiMsg || conn) && (
                    <p className={`set-msg ${conn ? (conn.reachable ? "ok" : "err") : aiMsg?.kind}`}>
                      {conn ? conn.message : aiMsg?.text}
                    </p>
                  )}
                </div>
                )}
              </details>
            </div>
          </div>
        </section>

        {/* ═══════════════ 2 · PRIVACY ═══════════════ */}
        <section className="section">
          <h3 className="section-h">Privacy</h3>

          {/* Trust card — one calm statement (FT-21) */}
          <div className="card">
            <div className="trust">
              <div className="trust-head">
                <span className="shield">
                  <Icon d={ICON.shield} size={17} />
                </span>
                <h3>Everything stays on this Mac</h3>
              </div>
              <p className="trust-body">
                Your books never leave this computer. When you ask about a passage, only that one
                passage is sent to get an answer — never the whole book. Nothing is saved unless you
                choose to keep it as a note.
              </p>
              <ul className="trust-points">
                <li><Icon d={ICON.check} size={16} /> Book files stay here — never uploaded.</li>
                <li><Icon d={ICON.check} size={16} /> Exports hold your own words — notes, reflections, and short quotes.</li>
                <li><Icon d={ICON.check} size={16} /> An answer becomes a note only when you save it.</li>
              </ul>
              <p className="trust-mode">
                <Icon d={ICON.clock} size={15} />
                {mode === "local" ? (
                  <span>
                    You're using <b>On this Mac only</b>, so nothing is sent — every answer is worked
                    out here and stays on this Mac.
                  </span>
                ) : mode === "own_key" ? (
                  <span>
                    You're using <b>your own {aiProviderLabel(provider)}</b>, so the passages you ask
                    about are sent there to be answered. To keep everything on this Mac, switch to{" "}
                    <b>On this Mac only</b> above.
                  </span>
                ) : (
                  <span>
                    You're using the <b>included assistant</b>, so the passages you ask about are sent
                    to be answered. To keep everything on this Mac, switch to <b>On this Mac only</b>{" "}
                    above.
                  </span>
                )}
              </p>
            </div>
          </div>

          {/* What's left this Mac — reframed audit (FT-12) */}
          <div className="card">
            <div className="audit-summary">
              <div className="audit-lead">
                <span className="ico"><Icon d={ICON.disk} size={16} /></span>
                <div>
                  <h3>What's left this Mac</h3>
                  <p>
                    {grouped.sentCount === 0
                      ? "Nothing has been sent. When you ask about a passage, the single passage you selected is recorded here."
                      : `${grouped.sentCount} passage${grouped.sentCount === 1 ? " was" : "s were"} sent to answer your questions. Each was a single passage you selected — never a whole book.`}
                  </p>
                </div>
              </div>

              <details className="audit">
                <summary>
                  <Icon d={ICON.chevron} size={15} className="chev" />
                  Show what was sent
                </summary>

                {grouped.sentCount === 0 ? (
                  <p className="audit-empty">Nothing has been sent.</p>
                ) : (
                  <div className="log">
                    <div className="log-head">
                      <span>What you asked</span>
                      <span>Left this Mac</span>
                    </div>
                    {grouped.groups.map(([title, rows]) => (
                      <div key={title}>
                        <div className="log-group">
                          {title} <span className="ct">· {rows.length}</span>
                        </div>
                        {rows.map((r) => (
                          <div className="log-row" key={r.id}>
                            <span className="log-what">
                              {lensLabel(r.mode)} <span className="when">· {fmtWhen(r.created_at)}</span>
                              {r.wrote_to_memory ? <span className="saved"> · saved as note</span> : null}
                            </span>
                            <span className="log-sent">
                              <Icon d={ICON.up} size={14} /> Sent to assistant
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                    {grouped.localOnly > 0 && (
                      <p className="log-more">
                        {grouped.localOnly} more never left this Mac — previews you didn't send.
                      </p>
                    )}
                  </div>
                )}

                <div className="audit-controls">
                  <span className="retain">
                    Keep this list for
                    <span className="stepper">
                      <span className="num">{retentionDraft}</span>
                      <span className="arrows">
                        <button type="button" aria-label="Keep longer" onClick={() => saveRetention(retentionDraft + 30)}>
                          <Icon d={ICON.caretUp} size={11} />
                        </button>
                        <button type="button" aria-label="Keep shorter" onClick={() => saveRetention(Math.max(0, retentionDraft - 30))}>
                          <Icon d={ICON.caretDown} size={11} />
                        </button>
                      </span>
                    </span>
                    days
                  </span>
                  <button type="button" className="btn" disabled={forgetting} onClick={forgetNow}>
                    <Icon d={ICON.trash} size={15} /> {forgetting ? "Forgetting…" : "Forget now"}
                  </button>
                </div>
                {forgetMsg && <p className="set-msg ok" style={{ padding: "0 20px 16px" }}>{forgetMsg}</p>}
              </details>
            </div>
          </div>
        </section>

        {/* ═══════════════ 3 · FILES ═══════════════ */}
        <section className="section">
          <h3 className="section-h">Files</h3>
          <div className="card">
            <div className="row row-flex">
              <div className="row-main">
                <p className="row-title">Export folder</p>
                <p className="row-desc">Where your notes and exported books are saved.</p>
                {exportMsg && <p className={`set-msg ${exportMsg.kind}`}>{exportMsg.text}</p>}
              </div>
              <div className="row-control">
                <button
                  type="button"
                  className="path-chip"
                  disabled={savingExport}
                  onClick={pickAndSaveFolder}
                  aria-label="Change export folder"
                >
                  <Icon d={ICON.folder} size={15} />
                  <span className="name">{exportFolderName}</span>
                </button>
              </div>
            </div>
            <div className="row row-flex">
              <div className="row-main">
                <p className="row-title">Export your library</p>
                <p className="row-desc">
                  Save a clean Markdown copy of every book's notes — your reflections and short
                  quotes — to your export folder. Run it again anytime; your own edits are kept.
                </p>
                {libExportMsg && <p className={`set-msg ${libExportMsg.kind}`}>{libExportMsg.text}</p>}
              </div>
              <div className="row-control">
                <button
                  type="button"
                  className="btn btn-accent"
                  disabled={exportingLib}
                  onClick={exportLibrary}
                >
                  <Icon d={ICON.up} size={15} />
                  {exportingLib ? "Exporting…" : "Export your library"}
                </button>
              </div>
            </div>
            <div className="row row-flex">
              <div className="row-main">
                <p className="row-title">Your library</p>
                <p className="row-desc">
                  Your books live on this Mac and stay here, backed up automatically so you never
                  lose your place.
                </p>
              </div>
              <div className="row-control">
                <span className="quiet-line">
                  <Icon d={ICON.shield} size={15} /> Kept on this Mac
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ═══════════════ 4 · ABOUT ═══════════════ */}
        <section className="section">
          <h3 className="section-h">About</h3>
          <div className="card">
            <div className="row row-flex">
              <div className="row-main">
                <p className="row-title">Quoting</p>
                <p className="row-desc">
                  Throughline keeps quotes short, for private study. You'll see a gentle note above
                  about {dto?.quote_warn_chars ?? 300} characters — never a block.
                </p>
              </div>
              <div className="row-control">
                {/* The short-quote note is a fixed protection in this build
                    (counsel-reviewed copyright posture) — always on, nothing to
                    toggle — so it reads as a plain informational line, never a
                    dead no-op switch. */}
                <span className="quiet-line">
                  <Icon d={ICON.check} size={15} /> Always on
                </span>
              </div>
            </div>
            <div className="row">
              <div className="about-row">
                <div className="row-main">
                  <p className="row-title">Updates</p>
                  <p className="row-desc">Throughline checks only when you ask — never on its own.</p>
                </div>
                <div className="about-control">
                  <UpdateChecker />
                </div>
              </div>
            </div>
          </div>
        </section>

        <p className="meta footer-meta">No accounts. No tracking. Your reading is yours.</p>
      </div>
    </div>
  );
}

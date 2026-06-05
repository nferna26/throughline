import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "../components/TLIcon";
import CodexLogin from "../components/CodexLogin";
import { AI_PROVIDERS, type SettingsDto } from "../types";
import "../tl-tutor.css";

type Choice = "local" | "openai" | "anthropic" | "codex" | "none";

interface TestResult {
  reachable: boolean;
  first_model_id: string | null;
  message: string;
}

/**
 * Forced first-run AI chooser. The reader explicitly picks where AI runs (or
 * declines) before the app is usable — no implicit default, and each cloud
 * provider shows a "your selected text goes to X" disclosure before any call.
 * Keys are stored in the Keychain via cmd_set_ai_key (never echoed back).
 */
export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:1234/v1");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [codexPresent, setCodexPresent] = useState(false);
  const [codexReady, setCodexReady] = useState(false);

  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => setCodexPresent(!!s.ai_codex_creds_present))
      .catch(() => {});
  }, []);

  const needsKey = choice === "openai" || choice === "anthropic";
  const meta = AI_PROVIDERS.find((p) => p.id === choice);
  const canContinue =
    !!choice &&
    (choice === "none" ||
      choice === "local" ||
      (choice === "codex" ? codexReady || codexPresent : false) ||
      (needsKey ? key.trim().length > 0 : true));

  function pick(c: Choice) {
    setChoice(c);
    setTest(null);
    setError("");
  }

  async function runTest() {
    if (!choice || choice === "none") return;
    setTesting(true);
    setTest(null);
    setError("");
    try {
      if (choice === "local") {
        // Persist the base URL so the probe uses it (loopback-validated backend-side).
        await invoke("cmd_set_ai_settings", { baseUrl }).catch(() => {});
      }
      const r = await invoke<TestResult>("cmd_test_ai_connection", {
        provider: choice,
        key: needsKey ? key.trim() : undefined,
      });
      setTest(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setTesting(false);
    }
  }

  async function cont() {
    if (!choice) return;
    setSaving(true);
    setError("");
    try {
      if (needsKey && key.trim()) {
        await invoke<SettingsDto>("cmd_set_ai_key", { provider: choice, key: key.trim() });
      }
      const args: Record<string, unknown> = { provider: choice };
      if (choice === "local") args.baseUrl = baseUrl;
      await invoke<SettingsDto>("cmd_set_ai_settings", args);
      onDone();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setSaving(false);
    }
  }

  return (
    <div className="tl-onboard">
      <div className="tl-card tl-onboard-card">
        <h1 className="tl-onboard-title">How should AI help you read?</h1>
        <p className="tl-onboard-sub">
          Throughline's tutor and Deep Study briefings can run on your Mac or through a cloud
          provider you control. Pick one — you can change it anytime in Settings.
        </p>

        <div className="tl-onboard-opts" role="radiogroup" aria-label="AI provider">
          {AI_PROVIDERS.map((p) => (
            <label key={p.id} className={`tl-onboard-opt${choice === p.id ? " is-active" : ""}`}>
              <input
                type="radio"
                name="ai-provider"
                checked={choice === p.id}
                onChange={() => pick(p.id)}
              />
              <span className="tl-onboard-opt-body">
                <span className="tl-onboard-opt-label">
                  {p.label}
                  {p.remote ? <span className="tl-onboard-tag">cloud</span> : <span className="tl-onboard-tag on-device">on device</span>}
                </span>
                <span className="tl-onboard-opt-desc">{p.disclosure}</span>
              </span>
            </label>
          ))}
          <label className={`tl-onboard-opt${choice === "none" ? " is-active" : ""}`}>
            <input type="radio" name="ai-provider" checked={choice === "none"} onChange={() => pick("none")} />
            <span className="tl-onboard-opt-body">
              <span className="tl-onboard-opt-label">Not now</span>
              <span className="tl-onboard-opt-desc">Use Throughline without AI. You can turn it on later in Settings.</span>
            </span>
          </label>
        </div>

        {/* Per-provider configuration */}
        {choice === "local" && (
          <div className="tl-onboard-config">
            <label className="tl-field">
              <span>Local server URL</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:1234/v1" />
            </label>
            <p className="tl-onboard-hint">Start LM Studio (or Ollama) and load a model, then test.</p>
          </div>
        )}
        {needsKey && (
          <div className="tl-onboard-config">
            <label className="tl-field">
              <span>{meta?.label} API key</span>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={choice === "openai" ? "sk-…" : "sk-ant-…"}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <p className="tl-onboard-hint">Stored in your macOS Keychain — never written to disk or exported.</p>
          </div>
        )}
        {choice === "codex" && (
          <div className="tl-onboard-config">
            <p className="tl-onboard-hint" style={{ marginTop: 0 }}>
              Sign in once with your ChatGPT account — no API key needed. Throughline keeps its own
              login in your Keychain (independent of the Codex CLI).
            </p>
            <CodexLogin
              present={codexPresent}
              onComplete={() => { setCodexReady(true); setCodexPresent(true); }}
              onSignedOut={() => { setCodexReady(false); setCodexPresent(false); }}
            />
          </div>
        )}

        {choice && choice !== "none" && (
          <div className="tl-onboard-test">
            <button className="tl-btn tl-btn-ghost" onClick={runTest} disabled={testing}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            {test && (
              <span className={test.reachable ? "tl-onboard-ok" : "tl-onboard-bad"}>
                <TLIcon name={test.reachable ? "shield" : "x"} size={13} /> {test.message}
              </span>
            )}
          </div>
        )}

        {error && <p className="tl-onboard-bad" role="alert">{error}</p>}

        <div className="tl-onboard-actions">
          <button className="tl-btn tl-btn-primary" onClick={cont} disabled={!canContinue || saving}>
            {saving ? "Saving…" : choice === "none" ? "Continue without AI" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

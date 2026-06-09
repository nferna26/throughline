import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import ModelSelect from "./ModelSelect";
import CodexLogin from "./CodexLogin";
import {
  aiProviderLabel,
  type ConnTestResult,
  type SettingsDto,
} from "../types";
import "../tl-tutor.css";

/**
 * AiSetupSheet — setup at the moment of intent.
 *
 * Shown the first time a reader opens a tutor lens (or a Deep Study briefing)
 * with no provider wired up, and again whenever a configured provider goes
 * quiet. It is NOT a Settings detour: the reader pastes a key (or points at a
 * local model), the sheet VERIFIES with the existing connection-test command and
 * then immediately runs the original lens request — the reader never bounces to
 * Settings and back. Settings stays the place to REVIEW/CHANGE a provider; this
 * is the recovery + first-run path that owns getting the lens to actually fire.
 *
 * The dignified fallback (the most important state) is always one click away: a
 * reader-facing prompt — built by the network-free `cmd_ai_preview` — that the
 * reader copies into whatever AI tool they already use. Nothing from the book is
 * ever sent by Throughline on this path.
 *
 * Privacy: the copied prompt is plain language (the internal fence + safety
 * scaffolding stays server-side). The Keychain storage + provider plumbing are
 * the same commands Settings uses — this sheet does not add a new egress path.
 *
 * It lives inside an existing tutor card (`.tl-tutor`), so it reuses the tutor
 * design-system classes (`tl-tutor-consent`, `tl-tutor-ghost`, `tl-btn`,
 * `tl-input`) and the `--tl-` tokens for the few sheet-specific bits of layout.
 */

/** Which provider the paste-key wizard is configuring. Codex is kept but marked
 *  experimental (unofficial endpoint); Local has its own detect flow below. */
type KeyProvider = "openai" | "anthropic" | "codex";

/** The sheet's top-level state machine. `not_connected` is the first-run entry;
 *  `unavailable` is "a provider was configured but isn't answering"; `paste_key`
 *  and `lm_studio` are the two setup wizards; `fallback` is the copyable prompt. */
export type SetupState =
  | "not_connected"
  | "unavailable"
  | "paste_key"
  | "lm_studio"
  | "fallback";

/** Result of the localhost detect probe (reusing cmd_test_ai_connection). */
type LocalDetect = "checking" | "found" | "no_server" | "no_model";

const LOCAL_BASE_URL = "http://localhost:1234/v1";

const KEY_PROVIDERS: KeyProvider[] = ["openai", "anthropic", "codex"];

/** Lens/section context the sheet needs to (a) show the passage and (b) build
 *  the reader-facing fallback prompt + run the original request after connect. */
export interface AiSetupContext {
  /** Lens mode: "explain" | "historical" | "vocabulary" | "socratic" | "section_briefing". */
  mode: string;
  /** The selected passage (lenses) — also shown so the reader sees what's at stake. */
  selectedText: string;
  bookTitle: string;
  author: string | null;
  sectionLabel: string | null;
  /** The whole section text — used by the Deep Study briefing fallback prompt. */
  sectionText?: string | null;
}

interface ReaderPromptCard {
  title: string;
  disclosure: string;
  prompt: string;
  copy_label: string;
}

// ── sheet-specific inline styles (tokens only; no new stylesheet needed) ─────
const sx: Record<string, CSSProperties> = {
  title: { margin: "0 0 var(--tl-1)", fontFamily: "var(--tl-sans)", fontSize: 14, fontWeight: 650, color: "var(--tl-ink)" },
  sub: { margin: "0 0 var(--tl-3)", fontFamily: "var(--tl-sans)", fontSize: 12.5, lineHeight: 1.5, color: "var(--tl-muted)" },
  passage: { margin: "0 0 var(--tl-3)", padding: "8px 10px", borderRadius: "var(--tl-r-md, 8px)", background: "var(--tl-ink-04, transparent)", fontFamily: "var(--tl-serif)", fontSize: 12.5, lineHeight: 1.5, color: "var(--tl-ink)" },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--tl-2)" },
  radios: { display: "flex", flexDirection: "column", gap: 6, margin: "0 0 var(--tl-2)" },
  radio: { display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--tl-sans)", fontSize: 12.5, color: "var(--tl-ink)", cursor: "pointer" },
  tag: { marginLeft: 6, fontSize: 10, fontWeight: 600, color: "var(--tl-muted)", fontStyle: "italic" },
  disclosure: { margin: "var(--tl-2) 0", fontFamily: "var(--tl-sans)", fontSize: 11.5, lineHeight: 1.5, color: "var(--tl-muted)" },
  err: { margin: "var(--tl-2) 0", fontFamily: "var(--tl-sans)", fontSize: 12, lineHeight: 1.5, color: "var(--tl-warn, var(--tl-ink))" },
  link: { background: "none", border: "none", padding: 0, fontFamily: "var(--tl-sans)", fontSize: 12.5, color: "var(--tl-muted)", textDecoration: "underline", cursor: "pointer" },
  prompt: { margin: "0 0 var(--tl-3)", padding: "10px 12px", borderRadius: "var(--tl-r-md, 8px)", border: "1px solid var(--tl-line)", background: "var(--tl-paper)", fontFamily: "var(--tl-sans)", fontSize: 12.5, lineHeight: 1.55, color: "var(--tl-ink)", whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" },
  copied: { margin: "var(--tl-2) 0 0", fontFamily: "var(--tl-sans)", fontSize: 11.5, color: "var(--tl-accent)" },
};

export default function AiSetupSheet(props: {
  ctx: AiSetupContext;
  /** Which state to open into. `unavailable` is the "Tutor paused" recovery. */
  initialState?: SetupState;
  /** Called after a successful verify + save so the caller re-runs the original
   *  lens request immediately (no Settings detour). For `unavailable` "Check
   *  again" it is called with "" — the caller just retries the live provider. */
  onConnected: (provider: string) => void;
  /** Override the `not_connected` headline + sub. The cap-hit screen uses this
   *  ("Keep going free") — the default copy claims nothing was sent, which is
   *  wrong there (a send was attempted and refused before any stream). */
  title?: string;
  subtitle?: string;
}) {
  const { ctx } = props;
  const [state, setState] = useState<SetupState>(props.initialState ?? "not_connected");

  // Paste-key wizard
  const [keyProvider, setKeyProvider] = useState<KeyProvider>("openai");
  const [key, setKey] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyErr, setVerifyErr] = useState("");
  // Model chosen at key setup (empty = the provider's default, set by ModelSelect).
  const [modelDraft, setModelDraft] = useState("");

  // LM Studio detect
  const [detect, setDetect] = useState<LocalDetect>("checking");
  const [localModel, setLocalModel] = useState<string | null>(null);

  // Fallback (reader-facing copyable prompt)
  const [fallbackCard, setFallbackCard] = useState<ReaderPromptCard | null>(null);
  const [fallbackErr, setFallbackErr] = useState("");
  const [copied, setCopied] = useState(false);

  // Codex login presence (mirrors Settings)
  const [codexPresent, setCodexPresent] = useState(false);
  const [codexReady, setCodexReady] = useState(false);
  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => setCodexPresent(!!s.ai_codex_creds_present))
      .catch(() => {});
  }, []);

  const passagePreview =
    ctx.selectedText.length > 280 ? ctx.selectedText.slice(0, 280) + "…" : ctx.selectedText;

  // ── Verify a key with the existing connection-test command, persist it, then
  //    hand control back so the caller fires the original lens request
  //    immediately. On failure we stay put and offer the copy fallback.
  const verifyAndAnswer = useCallback(async () => {
    setVerifyErr("");
    if (!key.trim()) return;
    setVerifying(true);
    try {
      const conn = await invoke<ConnTestResult>("cmd_test_ai_connection", {
        provider: keyProvider,
        key: key.trim(),
      });
      if (!conn.reachable) {
        setVerifyErr(
          (conn.message || "Couldn't reach the provider.") +
            " Nothing from your book was sent.",
        );
        return;
      }
      await invoke<SettingsDto>("cmd_set_ai_key", { provider: keyProvider, key: key.trim() });
      await invoke<SettingsDto>("cmd_set_ai_settings", {
        provider: keyProvider,
        model: modelDraft || undefined,
      });
      setKey("");
      props.onConnected(keyProvider);
    } catch (e: unknown) {
      setVerifyErr(
        ((e as { message?: string })?.message ?? String(e)) +
          " — nothing from your book was sent.",
      );
    } finally {
      setVerifying(false);
    }
  }, [keyProvider, key, modelDraft, props]);

  // ── Probe localhost:1234 (reusing the connection-test command, same as the
  //    Settings local-detect/refresh path). reachable + a model id ⇒ found;
  //    reachable + no model ⇒ running-but-no-model; unreachable ⇒ no server.
  const checkLocal = useCallback(async () => {
    setDetect("checking");
    setLocalModel(null);
    try {
      // Point the probe at the local endpoint (loopback-validated backend-side).
      await invoke("cmd_set_ai_settings", { baseUrl: LOCAL_BASE_URL }).catch(() => {});
      const conn = await invoke<ConnTestResult>("cmd_test_ai_connection", { provider: "local" });
      if (!conn.reachable) {
        setDetect("no_server");
        return;
      }
      if (conn.first_model_id) {
        setLocalModel(conn.first_model_id);
        setDetect("found");
      } else {
        setDetect("no_model");
      }
    } catch {
      setDetect("no_server");
    }
  }, []);

  // Kick off detection whenever the LM Studio state opens.
  useEffect(() => {
    if (state === "lm_studio") checkLocal();
  }, [state, checkLocal]);

  const useLocalModel = useCallback(async () => {
    try {
      const args: Record<string, unknown> = { provider: "local", baseUrl: LOCAL_BASE_URL };
      if (localModel) args.model = localModel;
      await invoke<SettingsDto>("cmd_set_ai_settings", args);
      props.onConnected("local");
    } catch (e: unknown) {
      setDetect("no_server");
      setVerifyErr((e as { message?: string })?.message ?? String(e));
    }
  }, [localModel, props]);

  // ── Build the reader-facing fallback prompt (network-free; no model call).
  const openFallback = useCallback(async () => {
    setState("fallback");
    setCopied(false);
    setFallbackErr("");
    setFallbackCard(null);
    try {
      const card = await invoke<ReaderPromptCard>("cmd_ai_preview", {
        mode: ctx.mode,
        selectedText: ctx.selectedText,
        bookTitle: ctx.bookTitle,
        author: ctx.author,
        sectionLabel: ctx.sectionLabel,
        sectionText: ctx.sectionText ?? null,
      });
      setFallbackCard(card);
    } catch (e: unknown) {
      setFallbackErr((e as { message?: string })?.message ?? String(e));
    }
  }, [ctx]);

  const copyPrompt = useCallback(async () => {
    if (!fallbackCard) return;
    try {
      await navigator.clipboard.writeText(fallbackCard.prompt);
      setCopied(true);
    } catch {
      /* clipboard unavailable — the prompt is still on screen to select */
    }
  }, [fallbackCard]);

  const needsKeyField = keyProvider === "openai" || keyProvider === "anthropic";
  const codexUsable = codexReady || codexPresent;

  return (
    <div className="tl-aiset" role="group" aria-label="Connect a tutor">
      {/* The passage is always shown so the reader sees what the lens is for. */}
      {ctx.selectedText.trim() && state !== "fallback" && (
        <p style={sx.passage}>“{passagePreview}”</p>
      )}

      {state === "not_connected" && (
        <div className="tl-aiset-body">
          <h3 style={sx.title}>{props.title ?? "Tutor not connected"}</h3>
          <p style={sx.sub}>
            {props.subtitle ??
              "This lens is ready. It just needs somewhere to run. Nothing has been sent."}
          </p>
          <div style={sx.actions}>
            <button className="tl-btn tl-btn-primary" onClick={() => setState("paste_key")}>
              Paste API key &amp; ask
            </button>
            <button className="tl-tutor-ghost" onClick={() => setState("lm_studio")}>
              Use LM Studio on this Mac
            </button>
            <button style={sx.link} onClick={openFallback}>
              Copy prompt
            </button>
          </div>
        </div>
      )}

      {state === "unavailable" && (
        <div className="tl-aiset-body">
          <h3 style={sx.title}>Tutor paused</h3>
          <p style={sx.sub}>
            Your provider isn’t answering right now. Nothing has been sent.
          </p>
          <div style={sx.actions}>
            <button className="tl-btn tl-btn-primary" onClick={() => props.onConnected("")}>
              <TLIcon name="refresh" size={14} /> Check again
            </button>
            <button className="tl-tutor-ghost" onClick={() => setState("paste_key")}>
              Switch provider
            </button>
            <button style={sx.link} onClick={openFallback}>
              Copy prepared prompt
            </button>
          </div>
        </div>
      )}

      {state === "paste_key" && (
        <div className="tl-aiset-body">
          <h3 style={sx.title}>Paste an API key</h3>
          <div style={sx.radios} role="radiogroup" aria-label="Provider">
            {KEY_PROVIDERS.map((p) => (
              <label key={p} style={sx.radio}>
                <input
                  type="radio"
                  name="aiset-provider"
                  checked={keyProvider === p}
                  onChange={() => { setKeyProvider(p); setVerifyErr(""); }}
                />
                <span>
                  {aiProviderLabel(p)}
                  {p === "codex" && (
                    <span style={sx.tag}>Experimental — unofficial endpoint</span>
                  )}
                </span>
              </label>
            ))}
          </div>

          {needsKeyField ? (
            <>
              <input
                className="tl-input"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={keyProvider === "openai" ? "sk-…" : "sk-ant-…"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${aiProviderLabel(keyProvider)} API key`}
              />
              <label style={{ display: "block", fontSize: 13, color: "var(--tl-muted)", marginTop: "var(--tl-2)" }}>
                Model
                <div style={{ marginTop: 4 }}>
                  <ModelSelect provider={keyProvider} value={modelDraft} onChange={setModelDraft} />
                </div>
              </label>
              <p style={sx.disclosure}>
                Stored in macOS Keychain. Throughline sends only the passage or section you ask
                about. You pay your provider directly.
              </p>
            </>
          ) : (
            <div>
              <p style={sx.disclosure}>
                Sign in once with your ChatGPT account — no API key needed. Stored in your Keychain.
                Throughline sends only the passage or section you ask about.
              </p>
              <CodexLogin
                present={codexPresent}
                onComplete={() => { setCodexReady(true); setCodexPresent(true); }}
                onSignedOut={() => { setCodexReady(false); setCodexPresent(false); }}
              />
            </div>
          )}

          {verifyErr && <p style={sx.err} role="alert">{verifyErr}</p>}

          <div style={sx.actions}>
            {keyProvider === "codex" ? (
              <button
                className="tl-btn tl-btn-primary"
                disabled={!codexUsable}
                onClick={() => props.onConnected("codex")}
              >
                Use Codex &amp; answer
              </button>
            ) : (
              <button
                className="tl-btn tl-btn-primary"
                disabled={verifying || !key.trim()}
                onClick={verifyAndAnswer}
              >
                {verifying ? "Verifying…" : "Verify & answer"}
              </button>
            )}
            <button style={sx.link} onClick={openFallback}>
              Copy prompt instead
            </button>
          </div>
        </div>
      )}

      {state === "lm_studio" && (
        <div className="tl-aiset-body">
          <h3 style={sx.title}>Use a model on this Mac</h3>

          {detect === "checking" && <p style={sx.sub}>Looking for a local model server…</p>}

          {detect === "found" && (
            <>
              <p style={sx.sub}>
                Local model found · <strong>{localModel}</strong> · Nothing leaves this Mac.
              </p>
              <div style={sx.actions}>
                <button className="tl-btn tl-btn-primary" onClick={useLocalModel}>
                  Use this model &amp; answer
                </button>
                <button style={sx.link} onClick={openFallback}>
                  Copy prompt
                </button>
              </div>
            </>
          )}

          {detect === "no_server" && (
            <>
              <p style={sx.sub}>
                No local model server is running. Start LM Studio (or another OpenAI-compatible
                server) on this Mac and load a model.
              </p>
              <div style={sx.actions}>
                <button className="tl-btn tl-btn-primary" onClick={checkLocal}>
                  <TLIcon name="refresh" size={14} /> Check again
                </button>
                <button className="tl-tutor-ghost" onClick={() => setState("paste_key")}>
                  Paste API key instead
                </button>
                <button style={sx.link} onClick={openFallback}>
                  Copy prompt
                </button>
              </div>
            </>
          )}

          {detect === "no_model" && (
            <>
              <p style={sx.sub}>
                A local server is running, but no model is loaded. Load a model in LM Studio, then
                check again.
              </p>
              <div style={sx.actions}>
                <button className="tl-btn tl-btn-primary" onClick={checkLocal}>
                  <TLIcon name="refresh" size={14} /> Check again
                </button>
                <button className="tl-tutor-ghost" onClick={() => setState("paste_key")}>
                  Paste API key instead
                </button>
                <button style={sx.link} onClick={openFallback}>
                  Copy prompt
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {state === "fallback" && (
        <div className="tl-aiset-body">
          {fallbackErr ? (
            <p style={sx.err} role="alert">{fallbackErr}</p>
          ) : !fallbackCard ? (
            <p style={sx.sub}>Preparing a prompt you can copy…</p>
          ) : (
            <>
              <h3 style={sx.title}>{fallbackCard.title}</h3>
              <p style={sx.disclosure}>{fallbackCard.disclosure}</p>
              <pre style={sx.prompt}>{fallbackCard.prompt}</pre>
              <div style={sx.actions}>
                <button className="tl-btn tl-btn-primary" onClick={copyPrompt}>
                  {copied ? "Copied" : fallbackCard.copy_label}
                </button>
                <button className="tl-tutor-ghost" onClick={() => setState("not_connected")}>
                  Set up tutor
                </button>
              </div>
              {copied && (
                <p style={sx.copied} role="status">
                  Copied — paste it into the AI tool you already use.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

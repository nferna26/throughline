import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import { aiProviderLabel, type Note, type AskHandle, type SettingsDto, type StreamEvent } from "../types";
import { isTutorEnabled, setTutorEnabled } from "../tutorConsent";
import "../tl-tutor.css";

/**
 * The Companion-Margin tutor card. Selecting a passage and clicking a lens in
 * the reader (Explain / Context / Define) spawns this card, fires the model
 * call IMMEDIATELY, and streams the answer in — no draft, no prompt preview.
 *
 * Depth model (see docs/WEEKEND_RC_LOG.md, pass 4): the first answer is BRIEF by
 * default — the smallest answer that unblocks the passage and returns the reader
 * to the text. A reader who is still curious pulls "Go deeper", which fires a
 * fresh call at a DIFFERENT altitude (brief = WHAT it means; deep = WHY/HOW it
 * works) and APPENDS below the brief, keeping the gist on screen as an anchor.
 * The backend is single-shot (no chat memory), so the deep prompt is written to
 * assume the reader already saw the brief. Brevity is enforced server-side by
 * both a tighter prompt directive AND a hard max_tokens ceiling per tier.
 *
 * Privacy (AGENTS.md, non-negotiable): the prompt + injection hardening live in
 * the Rust layer and are never rendered here; local-only is enforced at the
 * call site; the saved body is the explanation + the reader's optional words,
 * never the raw passage (anchored_text is DB-only).
 */
export type TutorMode = "explain" | "historical" | "vocabulary" | "socratic";
type Depth = "brief" | "deep";
type Phase = "consent" | "thinking" | "streaming" | "done" | "error" | "blocked";

export interface TutorDraft {
  draftId: string;
  mode: TutorMode;
  /** Absolute char locator of the selection start (== the highlight anchor). */
  locator: string;
  anchorStart: string;
  anchorEnd: string;
  anchoredText: string;
  chapter: string;
}

/** Lens metadata: visible label + verb-ing words shown while the model works. */
const LENS: Record<TutorMode, { label: string; verbs: string[] }> = {
  explain: { label: "Explain", verbs: ["Reading the passage", "Thinking", "Connecting ideas", "Writing"] },
  historical: { label: "Context", verbs: ["Placing it in time", "Recalling the work", "Thinking", "Writing"] },
  vocabulary: { label: "Define", verbs: ["Finding the word", "Checking usage", "Writing"] },
  socratic: { label: "Socratic", verbs: ["Reading closely", "Forming a question", "Writing"] },
};
/** Order of the "Ask another way" chips (Socratic only ever appears here). */
const LENS_ORDER: TutorMode[] = ["explain", "historical", "vocabulary", "socratic"];

// ── defensive sanitizer: the brief budget is tiny, but if the local model
//    still emits a leading markdown header, strip it so a 320px panel never
//    renders a "###" wall. Numbered lists (deep Socratic) are left intact.
function stripHeadings(s: string): string {
  return s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
}

// ── tiny, SAFE **bold** / *italic* inline renderer ─────────────────────────
function InlineMd({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
    return <span key={i}>{p}</span>;
  });
}

function Prose({ text }: { text: string }) {
  const paras = stripHeadings(text).split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}><InlineMd text={p} /></p>
      ))}
    </>
  );
}

// ── cycling "verb-ing…" status while the model works ───────────────────────
function Verbing({ verbs, fixed }: { verbs: string[]; fixed?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (fixed) return;
    const id = setInterval(() => setI((v) => (v + 1) % verbs.length), 820);
    return () => clearInterval(id);
  }, [fixed, verbs]);
  return (
    <span className="tl-tutor-live">
      <span className="tl-tutor-livedot" />
      <span className="tl-tutor-liveword">{fixed ?? verbs[i % verbs.length]}</span>
      <span className="tl-tutor-liveell">…</span>
    </span>
  );
}

function humanizeError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("no ai model") || s.includes("model name set"))
    return "No model is loaded. Open your local model server (LM Studio or Ollama) and load a model, then try again.";
  if (s.includes("request failed") || s.includes("could not reach") || s.includes("connection") || s.includes("unavailable") || s.includes("refused"))
    return "Can't reach the local model server. Is LM Studio (or Ollama) running on this Mac?";
  if (s.includes("local-only"))
    return "Local-only mode blocked a non-local endpoint. Check Settings → AI.";
  return raw.replace(/^error:\s*/i, "");
}

export default function MarginTutorCard(props: {
  bookId: string;
  draft: TutorDraft;
  style?: CSSProperties;
  active: boolean;
  onActivate: () => void;
  /** Persisted as a durable TutorNote — caller refreshes the margin from it. */
  onSaved: (note: Note) => void;
  onDiscard: () => void;
}) {
  const { draft } = props;

  const [lens, setLens] = useState<TutorMode>(draft.mode);
  const [phase, setPhase] = useState<Phase>(isTutorEnabled() ? "thinking" : "consent");
  const [briefAnswer, setBriefAnswer] = useState("");
  const [deepAnswer, setDeepAnswer] = useState("");
  const [deepRequested, setDeepRequested] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [modelName, setModelName] = useState("the local model");
  // Provider posture, loaded from settings. Drives the badge + consent copy
  // (WHERE the passage goes). Disabled only when no provider is chosen. null =
  // not yet known.
  const [provider, setProvider] = useState<string | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [takeaway, setTakeaway] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const channelRef = useRef<Channel<StreamEvent> | null>(null);
  const aiReqRef = useRef<string>("");
  const briefRef = useRef<string>("");
  const deepRef = useRef<string>("");
  const streamTierRef = useRef<Depth>("brief");
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);

  const lensMeta = LENS[lens];
  const streaming = phase === "thinking" || phase === "streaming";

  // Load the configured model name + local-only posture for the consent copy /
  // header. If local-only is OFF, the consent card defers to a disabled message
  // instead of promising "nothing leaves your device".
  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => {
        setProvider(s.ai_provider || "none");
        const m = s.ai_provider === "openai" ? s.ai_model_openai
          : s.ai_provider === "anthropic" ? s.ai_model_anthropic
          : s.ai_provider === "codex" ? s.ai_model_codex
          : s.ai_model;
        if (m?.trim()) setModelName(m.trim());
      })
      .catch(() => setProvider("none")); // fail closed
  }, []);

  // Ensure a model id is configured before the first call; auto-detect from the
  // running local server if Settings hasn't been filled in yet. Cloud providers
  // ship with a default model, so this only acts for the local server.
  const ensureModel = useCallback(async () => {
    try {
      const s = await invoke<SettingsDto>("cmd_get_settings");
      if (s.ai_provider !== "local") return;
      if (s.ai_model?.trim()) { setModelName(s.ai_model.trim()); return; }
      const conn = await invoke<{ reachable: boolean; first_model_id: string | null }>("cmd_test_ai_connection", {});
      if (conn.reachable && conn.first_model_id) {
        await invoke<SettingsDto>("cmd_set_ai_settings", { provider: "local", model: conn.first_model_id });
        setModelName(conn.first_model_id);
      }
    } catch {
      /* the ask below surfaces a clear, human error if this didn't help */
    }
  }, []);

  // Fire a streaming call for a given lens + depth tier.
  //  - "brief": fresh answer; resets the deep tier and the lens.
  //  - "deep":  keeps the brief on screen and appends below it.
  const startStream = useCallback(async (which: TutorMode, tier: Depth) => {
    setLens(which);
    setPhase("thinking");
    setErrorMsg("");
    setShowSave(false); setSaved(false); setCollapsed(false);
    streamTierRef.current = tier;
    stickToBottomRef.current = true;

    if (tier === "brief") {
      setBriefAnswer(""); briefRef.current = "";
      setDeepAnswer(""); deepRef.current = "";
      setDeepRequested(false);
    } else {
      setDeepRequested(true);
      setDeepAnswer(""); deepRef.current = "";
    }

    // PROVIDER GATE (authoritative, just before sending). A provider must be
    // explicitly chosen; Local stays on-device, a chosen cloud provider was opted
    // into with disclosure. The backend re-checks per call. Re-read live so a
    // change in another view takes effect immediately.
    try {
      const s = await invoke<SettingsDto>("cmd_get_settings");
      if (!s.ai_provider || s.ai_provider === "none") { setPhase("blocked"); return; }
    } catch {
      setPhase("blocked"); return; // can't read settings → fail closed
    }

    await ensureModel();

    const channel = new Channel<StreamEvent>();
    channelRef.current = channel;
    let firstDelta = true;
    channel.onmessage = (ev) => {
      if (channelRef.current !== channel) return; // superseded run → drop (soft-cancel)
      if (ev.kind === "delta") {
        if (firstDelta) { firstDelta = false; setPhase("streaming"); }
        if (tier === "brief") {
          briefRef.current += ev.text ?? "";
          setBriefAnswer(briefRef.current);
        } else {
          deepRef.current += ev.text ?? "";
          setDeepAnswer(deepRef.current);
        }
      } else if (ev.kind === "done") {
        setPhase((p) => (p === "error" ? p : "done"));
      } else if (ev.kind === "error") {
        setErrorMsg(humanizeError(ev.message ?? "The local tutor call failed."));
        setPhase("error");
      }
    };

    try {
      const handle = await invoke<AskHandle>("cmd_ai_ask", {
        bookId: props.bookId,
        mode: which,
        depth: tier,
        selection: draft.anchoredText,
        chapter: draft.chapter || null,
        locator: draft.locator,
        userNote: null,
        onEvent: channel,
      });
      if (channelRef.current === channel) aiReqRef.current = handle.ai_request_id;
    } catch (e) {
      if (channelRef.current === channel) {
        setErrorMsg(humanizeError(String((e as { message?: string })?.message ?? e)));
        setPhase("error");
      }
    }
  }, [ensureModel, props.bookId, draft.anchoredText, draft.chapter, draft.locator]);

  // Auto-start once (when already enabled). New cards default to brief.
  useEffect(() => {
    if (isTutorEnabled()) startStream(draft.mode, "brief");
    // Dropping the channel ref on unmount soft-cancels any in-flight stream.
    return () => { channelRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest streamed text in view (unless the reader scrolled up).
  useEffect(() => {
    if (!streaming || !stickToBottomRef.current) return;
    const panel = cardRef.current?.closest(".tl-sidepanel") as HTMLElement | null;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [briefAnswer, deepAnswer, streaming]);

  // Detect a manual scroll-up so we stop yanking the view back down.
  useEffect(() => {
    const panel = cardRef.current?.closest(".tl-sidepanel") as HTMLElement | null;
    if (!panel) return;
    const onScroll = () => {
      const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
      stickToBottomRef.current = nearBottom;
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => panel.removeEventListener("scroll", onScroll);
  }, []);

  const enableAndStart = useCallback(async () => {
    setTutorEnabled(true);
    await startStream(lens, "brief");
  }, [lens, startStream]);

  const pickLens = useCallback((k: TutorMode) => { startStream(k, "brief"); }, [startStream]);
  const goDeeper = useCallback(() => { startStream(lens, "deep"); }, [lens, startStream]);
  const regenerate = useCallback(() => {
    startStream(lens, deepRequested ? "deep" : "brief");
  }, [lens, deepRequested, startStream]);

  const doSave = useCallback(async () => {
    if (!aiReqRef.current || !briefRef.current.trim()) return;
    setSaving(true);
    try {
      const body = [takeaway.trim(), briefRef.current.trim(), deepRef.current.trim()]
        .filter(Boolean)
        .join("\n\n");
      const note = await invoke<Note>("cmd_save_ai_response_as_note", {
        aiRequestId: aiReqRef.current,
        noteType: "TutorNote",
        body,
        locator: draft.locator,
        chapterLabel: draft.chapter || null,
        anchorStart: draft.anchorStart,
        anchorEnd: draft.anchorEnd,
        anchoredText: draft.anchoredText,
        sessionId: null,
      });
      setSaved(true);
      setShowSave(false);
      // Let the reader see "Saved ✓" briefly before the draft becomes a note.
      setTimeout(() => props.onSaved(note), 1100);
    } catch (e) {
      setErrorMsg(humanizeError(String((e as { message?: string })?.message ?? e)));
    } finally {
      setSaving(false);
    }
  }, [takeaway, draft, props]);

  const briefStreaming = streaming && streamTierRef.current === "brief";
  const deepStreaming = streaming && streamTierRef.current === "deep";

  return (
    <div
      ref={cardRef}
      className={`tl-card tl-tutor${props.active ? " active" : ""}${collapsed ? " is-collapsed" : ""}`}
      style={props.style}
      onClick={props.onActivate}
      role="complementary"
      aria-label={`Tutor — ${lensMeta.label}`}
    >
      {/* header: badge + lens · live status / local-only · collapse · close */}
      <div className="tl-tutor-head">
        <span className="tl-tutor-badge"><TLIcon name="sparkle" size={13} /> Tutor</span>
        <span className="tl-tutor-lens">{lensMeta.label}</span>
        <span className="tl-tutor-status">
          {streaming ? (
            <Verbing verbs={lensMeta.verbs} fixed={phase === "streaming" ? "Writing" : undefined} />
          ) : phase === "done" ? (
            provider === "local" ? (
              <span className="tl-tutor-local"><TLIcon name="shield" size={12} /> Local-only</span>
            ) : (
              <span className="tl-tutor-remote">via {aiProviderLabel(provider ?? "")}</span>
            )
          ) : null}
        </span>
        {phase === "done" && (
          <button
            className="tl-iconbtn tl-tutor-collapse"
            aria-label={collapsed ? "Expand tutor card" : "Collapse tutor card"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand" : "Collapse to make room"}
            onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
          >
            <TLIcon name={collapsed ? "chevronRight" : "chevronDown"} size={15} />
          </button>
        )}
        <button
          className="tl-iconbtn"
          aria-label="Close tutor"
          onClick={(e) => { e.stopPropagation(); channelRef.current = null; props.onDiscard(); }}
        >
          <TLIcon name="x" size={14} />
        </button>
      </div>

      {/* collapsed quote chip: the passage + locator, click to expand */}
      <button
        className={`tl-quotechip${quoteOpen ? " is-open" : ""}`}
        onClick={(e) => { e.stopPropagation(); setQuoteOpen((o) => !o); }}
        title={quoteOpen ? "Hide full passage" : "Show full passage"}
      >
        <span className="tl-quotechip-text">“{draft.anchoredText}”</span>
        {draft.locator && <span className="tl-quotechip-loc">{draft.locator}</span>}
      </button>

      {phase === "blocked" || (phase === "consent" && (provider === "none" || provider === "")) ? (
        <div className="tl-tutor-errbox" role="alert">
          <p>
            No AI provider is set up yet. Choose one in Settings → Assistance to use the tutor.
          </p>
        </div>
      ) : phase === "consent" ? (
        <div className="tl-tutor-consent">
          <p>
            {provider === "local" ? (
              <>Enable the tutor? It runs <strong>{modelName}</strong> on this Mac — the selected
              passage is sent only to the local model; nothing leaves your device.</>
            ) : (
              <>Enable the tutor? The selected passage is sent to{" "}
              <strong>{aiProviderLabel(provider ?? "")}</strong> (never the whole book).</>
            )}
          </p>
          <div className="tl-tutor-consent-btns">
            <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); props.onDiscard(); }}>Not now</button>
            <button className="tl-btn tl-btn-primary" onClick={(e) => { e.stopPropagation(); enableAndStart(); }}>Enable</button>
          </div>
        </div>
      ) : phase === "error" ? (
        <div className="tl-tutor-errbox" role="alert">
          <p>{errorMsg}</p>
          <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); regenerate(); }}>
            <TLIcon name="refresh" size={14} /> Try again
          </button>
        </div>
      ) : (
        <>
          {!collapsed && (briefAnswer || briefStreaming) && (
            <div className="tl-tutor-answer tl-md" aria-live="polite">
              <Prose text={briefAnswer} />
              {briefStreaming && <span className="tl-caret" />}
              {phase === "thinking" && streamTierRef.current === "brief" && !briefAnswer && (
                <span className="tl-caret" />
              )}
            </div>
          )}

          {/* the deep tier appends below the brief, behind a quiet divider */}
          {!collapsed && deepRequested && (
            <div className="tl-tutor-deep">
              <div className="tl-tutor-deep-rule"><span>Deeper</span></div>
              <div className="tl-tutor-answer tl-md" aria-live="polite">
                <Prose text={deepAnswer} />
                {deepStreaming && <span className="tl-caret" />}
                {phase === "thinking" && streamTierRef.current === "deep" && !deepAnswer && (
                  <span className="tl-caret" />
                )}
              </div>
            </div>
          )}

          {collapsed && (
            <p className="tl-tutor-collapsed-peek">
              {briefAnswer.slice(0, 120).trim()}{briefAnswer.length > 120 ? "…" : ""}
            </p>
          )}

          {/* done-state actions */}
          {phase === "done" && !collapsed && (
            <div className="tl-tutor-actions">
              {saved ? (
                <div className="tl-tutor-saved"><TLIcon name="check" size={15} /> Saved to notes</div>
              ) : showSave ? (
                <div className="tl-tutor-savebox">
                  <textarea
                    className="tl-tutor-takeaway"
                    rows={3}
                    autoFocus
                    placeholder="Your takeaway, in your own words — optional"
                    value={takeaway}
                    onChange={(e) => setTakeaway(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="tl-tutor-saverow">
                    <span className="tl-tutor-local"><TLIcon name="shield" size={12} /> Saved on this Mac only</span>
                    <div className="tl-tutor-savebtns">
                      <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); setShowSave(false); }}>Cancel</button>
                      <button className="tl-btn tl-btn-primary" disabled={saving} onClick={(e) => { e.stopPropagation(); doSave(); }}>
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="tl-tutor-dorow">
                    {!deepRequested ? (
                      <button className="tl-btn tl-btn-primary" onClick={(e) => { e.stopPropagation(); goDeeper(); }}>
                        Go deeper <TLIcon name="chevronDown" size={14} />
                      </button>
                    ) : lens !== "socratic" ? (
                      <button className="tl-btn tl-btn-primary" title="Let the tutor ask you a question instead" onClick={(e) => { e.stopPropagation(); pickLens("socratic"); }}>
                        <TLIcon name="help" size={14} /> Question me
                      </button>
                    ) : null}
                    <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); setShowSave(true); }}>
                      <TLIcon name="pencil" size={14} /> Save as note
                    </button>
                    <button className="tl-tutor-ghost" title="Regenerate this answer" onClick={(e) => { e.stopPropagation(); regenerate(); }}>
                      <TLIcon name="refresh" size={14} /> Regenerate
                    </button>
                  </div>
                  <div className="tl-tutor-asks">
                    <span className="tl-tutor-askslabel">Ask another way</span>
                    <div className="tl-tutor-lensrow">
                      {LENS_ORDER.map((k) => (
                        <button
                          key={k}
                          className={`tl-lenschip${k === lens ? " is-active" : ""}`}
                          aria-pressed={k === lens}
                          onClick={(e) => { e.stopPropagation(); pickLens(k); }}
                        >
                          {LENS[k].label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

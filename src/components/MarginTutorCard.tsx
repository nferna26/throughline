import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import AiSetupSheet from "./AiSetupSheet";
import TutorFuel from "./TutorFuel";
import { AI_PROVIDERS, aiProviderLabel, type Note, type AskHandle, type SettingsDto, type StreamEvent } from "../types";
import { humanizeError, looksUnavailable } from "../aiErrors";
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

/** Lens metadata: the visible chip + header label for each mode. */
const LENS: Record<TutorMode, { label: string }> = {
  explain: { label: "Explain" },
  historical: { label: "Context" },
  vocabulary: { label: "Define" },
  // Shortened to "Ask" so all four lens chips fit one row at 340px. The mode key
  // stays 'socratic' (the Socratic lens) — only the visible label changed.
  socratic: { label: "Ask" },
};
/** Order of the "Ask another way" chips (Socratic only ever appears here). */
const LENS_ORDER: TutorMode[] = ["explain", "historical", "vocabulary", "socratic"];

/** A lens mode maps to the backend StubMode string for the cold-start fallback
 *  prompt (cmd_ai_preview). Same identifiers the backend StubMode::from_str takes. */
const SETUP_MODE: Record<TutorMode, string> = {
  explain: "explain",
  historical: "historical",
  vocabulary: "vocabulary",
  socratic: "socratic",
};

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

// ── header "thinking" indicator: three pulsing dots + "thinking" (handoff).
//    Replaces the Regenerate icon while the model works. Pure CSS animation; the
//    dots hold still under prefers-reduced-motion.
function Thinking() {
  return (
    <span className="tl-tutor-thinking" aria-label="thinking" role="status">
      <i /><i /><i />
      <span className="tl-tutor-thinking-word">thinking</span>
    </span>
  );
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
  /** Book title + author, threaded into the cold-start setup sheet's fallback
   *  prompt so a reader who copies it gets a fully-attributed prompt. Optional:
   *  the sheet degrades calmly to "Explain this passage." without them. */
  bookTitle?: string;
  author?: string | null;
}) {
  const { draft } = props;

  const [lens, setLens] = useState<TutorMode>(draft.mode);
  const [phase, setPhase] = useState<Phase>(isTutorEnabled() ? "thinking" : "consent");
  const [briefAnswer, setBriefAnswer] = useState("");
  const [deepAnswer, setDeepAnswer] = useState("");
  const [deepRequested, setDeepRequested] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  // First-cloud-call consent (C2): set when cmd_ai_ask returns NeedsCloudConsent.
  const [cloudConsent, setCloudConsent] = useState<{ host: string; which: TutorMode; tier: Depth } | null>(null);
  // Company-mode cap spent (CM6): set when cmd_ai_ask returns CapExhausted.
  const [capExhausted, setCapExhausted] = useState(false);
  // The cap screen's $20 door (reuses the existing buy→activate flow).
  const [topUpUrl, setTopUpUrl] = useState<string | null>(null);
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
    // change in another view takes effect immediately. The live provider also
    // feeds error copy below, so failures name the provider actually asked.
    let liveProvider = "none";
    try {
      const s = await invoke<SettingsDto>("cmd_get_settings");
      if (!s.ai_provider || s.ai_provider === "none") { setPhase("blocked"); return; }
      liveProvider = s.ai_provider;
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
        setErrorMsg(humanizeError(liveProvider, ev.message ?? "The tutor couldn't answer this time."));
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
        const err = e as { kind?: string; host?: string; message?: string };
        if (err?.kind === "NeedsCloudConsent") {
          // First cloud send — pause and ask once before anything leaves the Mac.
          setCloudConsent({ host: err.host ?? "the cloud provider", which, tier });
          return;
        }
        if (err?.kind === "CapExhausted") {
          // Company-paid credits spent — fall to the BYO-key / local floor.
          setCapExhausted(true);
          return;
        }
        setErrorMsg(humanizeError(liveProvider, String(err?.message ?? e)));
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

  // Keep the newest streamed text in view (unless the reader scrolled up) — but
  // ONLY when an ancestor is its own bounded scroll region (the narrow overlay
  // drawer / side panel / flow fallback). In the wide spread the card grows in
  // normal flow with no internal scroll, so the desk must NOT be yanked while a
  // passage streams — the card simply grows in place.
  useEffect(() => {
    if (!streaming || !stickToBottomRef.current) return;
    const panel = cardRef.current?.closest(".tl-margin-inner, .tl-sidepanel, .tl-margin.flow") as HTMLElement | null;
    if (panel && panel.scrollHeight > panel.clientHeight + 1) panel.scrollTop = panel.scrollHeight;
  }, [briefAnswer, deepAnswer, streaming]);

  // Reset the margin to the top when the reader moves to a new passage/section,
  // so a fresh card opens at its start rather than mid-scroll (E3).
  useEffect(() => {
    const panel = cardRef.current?.closest(".tl-margin-inner, .tl-sidepanel, .tl-margin.flow") as HTMLElement | null;
    if (panel) panel.scrollTop = 0;
  }, [draft.anchoredText, draft.locator]);

  // Detect a manual scroll-up so we stop yanking the view back down.
  useEffect(() => {
    const panel = cardRef.current?.closest(".tl-margin-inner, .tl-sidepanel, .tl-margin.flow") as HTMLElement | null;
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

  // Cold-start recovery: the setup sheet just connected (or asked us to retry).
  // Re-read the live provider and immediately fire the original lens request at
  // the tier the reader was on — no Settings detour. Enabling consent here is
  // safe: connecting through the sheet is an explicit reader action.
  const onSetupConnected = useCallback((connected: string) => {
    setTutorEnabled(true);
    if (connected) setProvider(connected);
    startStream(lens, deepRequested ? "deep" : "brief");
  }, [lens, deepRequested, startStream]);

  // Cap-hit $20 door: same buy→activate flow as Settings — a fresh purchase is a
  // fresh full allowance. Rust opens the browser; the URL is the visible fallback.
  const topUp = useCallback(async () => {
    try {
      setTopUpUrl(await invoke<string>("cmd_company_checkout"));
    } catch {
      setTopUpUrl(""); // signal "couldn't start checkout" without a red wall
    }
  }, []);

  // After the deep link activates the new license, the reader retries by hand.
  const retryAfterTopUp = useCallback(() => {
    setCapExhausted(false);
    setTopUpUrl(null);
    startStream(lens, "brief");
  }, [lens, startStream]);

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
      setErrorMsg(humanizeError(provider, String((e as { message?: string })?.message ?? e)));
    } finally {
      setSaving(false);
    }
  }, [takeaway, draft, props, provider]);

  const briefStreaming = streaming && streamTierRef.current === "brief";
  const deepStreaming = streaming && streamTierRef.current === "deep";

  // Permanent privacy microline at the card's bottom — honest about WHERE the
  // answer came from. A local model never left the Mac; a cloud answer went to
  // the Throughline assistant (the reader never sees the upstream provider's
  // name). Never imply on-device when the selection went to the cloud.
  const privacyLine =
    provider === "local"
      ? "Answered on this Mac."
      : "Your selection was sent to the Throughline assistant — nothing kept.";

  return (
    <div
      ref={cardRef}
      className={`tl-card tl-tutor${props.active ? " active" : ""}${collapsed ? " is-collapsed" : ""}`}
      style={props.style}
      onClick={props.onActivate}
      role="complementary"
      aria-label={`Tutor — ${lensMeta.label}`}
    >
      {/* header: ✦ Tutor · {lens} — spacer — [streaming: thinking | done: ↻] · collapse · ×
          Regenerate is a repair, so it lives in the header chrome next to Close,
          not in the answer flow. While streaming it's replaced by the "thinking"
          indicator. Provider attribution moved to the footer privacy microline. */}
      <div className="tl-tutor-head">
        <span className="tl-tutor-badge"><TLIcon name="sparkle" size={13} /> Tutor</span>
        <span className="tl-tutor-lens">· {lensMeta.label}</span>
        <span className="tl-tutor-headsp" />
        {streaming ? (
          <Thinking />
        ) : phase === "done" ? (
          <button
            className="tl-iconbtn tl-tutor-regen"
            aria-label="Regenerate answer"
            title="Regenerate"
            onClick={(e) => { e.stopPropagation(); regenerate(); }}
          >
            <TLIcon name="refresh" size={14} />
          </button>
        ) : null}
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

      {/* collapsed quote chip: the passage itself is the anchor the reader
          cares about — no raw locator plumbing. Click to expand. */}
      <button
        className={`tl-quotechip${quoteOpen ? " is-open" : ""}`}
        onClick={(e) => { e.stopPropagation(); setQuoteOpen((o) => !o); }}
        title={quoteOpen ? "Hide full passage" : "Show full passage"}
      >
        <span className="tl-quotechip-text">“{draft.anchoredText}”</span>
      </button>

      {capExhausted ? (
        // Cap-hit (CM6): three calm doors, free first. The proxy refused BEFORE
        // any stream started, so nothing was truncated; reading and notes are
        // untouched. Hierarchy: free path primary, $20 re-up secondary (ghost),
        // "ask for more" a quiet tertiary link — never a paywall.
        <div className="tl-tutor-consent tl-caphit">
          <p>
            <strong>Your included Throughline AI is used up.</strong> Reading and notes are
            untouched. Pick how the tutor keeps answering:
          </p>
          <AiSetupSheet
            ctx={{
              mode: SETUP_MODE[lens],
              selectedText: draft.anchoredText,
              bookTitle: props.bookTitle ?? "",
              author: props.author ?? null,
              sectionLabel: draft.chapter || null,
            }}
            initialState="not_connected"
            title="Keep going free"
            subtitle="Use your own API key, or run a local model on this Mac — free either way."
            onConnected={onSetupConnected}
          />
          <div className="tl-caphit-doors">
            <button
              className="tl-tutor-ghost"
              onClick={(e) => { e.stopPropagation(); topUp(); }}
            >
              Get another full allowance — $20
            </button>
            {topUpUrl !== null && (
              <p className="tl-tutorfuel-note" role="status">
                {topUpUrl === "" ? (
                  <>Couldn't start checkout. Try again in a moment.</>
                ) : (
                  <>
                    Opening checkout in your browser… If it doesn't open,{" "}
                    <a href={topUpUrl} target="_blank" rel="noopener noreferrer">continue here</a>.
                    After you buy, activation happens automatically — then{" "}
                    <button className="tl-caphit-link" onClick={(e) => { e.stopPropagation(); retryAfterTopUp(); }}>
                      try again
                    </button>.
                  </>
                )}
              </p>
            )}
            <button
              className="tl-caphit-link"
              onClick={(e) => { e.stopPropagation(); void invoke("cmd_open_support_email").catch(() => {}); }}
            >
              Think you should get more included? Let me know →
            </button>
          </div>
        </div>
      ) : phase === "blocked" || (phase === "consent" && (provider === "none" || provider === "")) ? (
        // Cold-start: no provider wired up. Setup at the moment of intent —
        // paste a key / use a local model / copy a prompt — never a dead end.
        <AiSetupSheet
          ctx={{
            mode: SETUP_MODE[lens],
            selectedText: draft.anchoredText,
            bookTitle: props.bookTitle ?? "",
            author: props.author ?? null,
            sectionLabel: draft.chapter || null,
          }}
          initialState="not_connected"
          onConnected={onSetupConnected}
        />
      ) : phase === "error" && looksUnavailable(errorMsg) ? (
        // Configured-but-unavailable: the provider isn't answering. "Tutor
        // paused" recovery — check again / switch provider / copy the prompt.
        // Never "go to Settings" as the only move.
        <AiSetupSheet
          ctx={{
            mode: SETUP_MODE[lens],
            selectedText: draft.anchoredText,
            bookTitle: props.bookTitle ?? "",
            author: props.author ?? null,
            sectionLabel: draft.chapter || null,
          }}
          initialState="unavailable"
          provider={provider ?? undefined}
          onConnected={onSetupConnected}
        />
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
              {/* Go deeper is an inline accent text link that ENDS the brief, like
                  "continued…" — pulling it appends the Deeper tier below and the
                  loop bottoms out (we only have two tiers, so the link is then
                  gone). Only offered once the brief is done and no deep yet. */}
              {phase === "done" && !deepRequested && (
                <button
                  className="tl-tutor-deeper-link"
                  onClick={(e) => { e.stopPropagation(); goDeeper(); }}
                >
                  Go deeper <TLIcon name="chevronDown" size={12} />
                </button>
              )}
            </div>
          )}

          {/* the deep tier appends below the brief, behind a quiet divider — it's
              the last (2nd) tier, so no Go deeper link follows it (hidden after 2). */}
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

          {/* done-state strata: lens row + footer (Save accent · "On this Mac
              only" · privacy microline). The save form REPLACES the lens row +
              footer so the card never grows two action areas at once. */}
          {phase === "done" && !collapsed && (
            saved ? (
              <div className="tl-tutor-foot">
                <div className="tl-tutor-saved"><TLIcon name="check" size={15} /> Saved to notes</div>
              </div>
            ) : showSave ? (
              // Save form in place of the lens row + footer row.
              <div className="tl-tutor-foot tl-tutor-saveform">
                <textarea
                  className="tl-tutor-takeaway"
                  rows={3}
                  autoFocus
                  aria-label="Your takeaway, in your own words — optional"
                  placeholder="Your takeaway, in your own words — optional"
                  value={takeaway}
                  onChange={(e) => setTakeaway(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="tl-tutor-saverow">
                  <span className="tl-tutor-foot-note">Saved on this Mac only</span>
                  <span className="tl-tutor-foot-sp" />
                  <button className="tl-tutor-ghost-link" onClick={(e) => { e.stopPropagation(); setShowSave(false); }}>Cancel</button>
                  <button className="tl-tutor-save" disabled={saving} onClick={(e) => { e.stopPropagation(); doSave(); }}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Lens row — outline chips in one row; the active chip is outline +
                    dot, NEVER filled (Save is the card's only fill). */}
                <div className="tl-tutor-asks" role="radiogroup" aria-label="Ask another way">
                  <span className="tl-tutor-askslabel">Ask another way</span>
                  <div className="tl-tutor-lensrow">
                    {LENS_ORDER.map((k) => (
                      <button
                        key={k}
                        className={`tl-lenschip${k === lens ? " is-active" : ""}`}
                        role="radio"
                        aria-checked={k === lens}
                        onClick={(e) => { e.stopPropagation(); pickLens(k); }}
                      >
                        {LENS[k].label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Footer: the card's one accent control (Save as note) + where the
                    NOTE is kept, then the permanent privacy microline (honest about
                    where the ANSWER came from). */}
                <div className="tl-tutor-foot">
                  <div className="tl-tutor-foot-row">
                    <button className="tl-tutor-save" onClick={(e) => { e.stopPropagation(); setShowSave(true); }}>
                      <TLIcon name="pencil" size={13} /> Save as note
                    </button>
                    <span className="tl-tutor-foot-sp" />
                    <span className="tl-tutor-foot-note">On this Mac only</span>
                  </div>
                  {/* Low-allowance strip (company mode, only when low) — the card's
                      one legitimate warning, sitting just above the privacy line. */}
                  {!capExhausted && <TutorFuel provider={provider} />}
                  <p className="tl-tutor-privacy">{privacyLine}</p>
                </div>
              </>
            )
          )}
        </>
      )}

      {cloudConsent && (
        <div
          className="tl-scrim"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm cloud AI"
          onClick={() => { setCloudConsent(null); setPhase("error"); setErrorMsg("Cloud AI wasn't confirmed — enable it anytime in Settings."); }}
        >
          <div className="tl-replan-sheet" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>Send this passage to {cloudConsent.host}?</h3>
            {/* The first sentence is the provider's own disclosure (AI_PROVIDERS),
                so this dialog and the provider picker can never drift: key for
                BYO, login for Codex, the one-time purchase for company mode. */}
            <p className="ctx">
              {AI_PROVIDERS.find((p) => p.id === provider)?.disclosure
                ?? `Your selected passage (below) is sent to ${cloudConsent.host} so the tutor can answer — never the whole book.`}{" "}
              Your book file never leaves this Mac. Asked once, then remembered.
            </p>
            <blockquote style={{ margin: "0 0 var(--tl-4)", padding: "8px 12px", borderLeft: "2px solid var(--tl-line)", color: "var(--tl-muted)", fontSize: 13, fontStyle: "italic" }}>
              "{draft.anchoredText.length > 220 ? draft.anchoredText.slice(0, 220) + "…" : draft.anchoredText}"
            </blockquote>
            <div className="tl-replan-foot">
              <span className="keep">→ {cloudConsent.host}</span>
              <span className="right">
                <button className="tl-btn tl-btn-ghost" onClick={() => { setCloudConsent(null); setPhase("error"); setErrorMsg("Cloud AI wasn't confirmed — enable it anytime in Settings."); }}>
                  Not now
                </button>
                <button
                  className="tl-btn tl-btn-primary"
                  onClick={async () => {
                    const c = cloudConsent;
                    setCloudConsent(null);
                    await invoke("cmd_confirm_cloud_send");
                    startStream(c.which, c.tier);
                  }}
                >
                  Send to {cloudConsent.host}
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

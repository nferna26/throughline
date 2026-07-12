import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import AiSetupSheet from "./AiSetupSheet";
import TutorFuel from "./TutorFuel";
import { AI_PROVIDERS, aiProviderLabel, providerIdForHost, type Note, type AskHandle, type SavedNote, type SettingsDto, type StreamEvent } from "../types";
import CloudConsentSheet, { type ConsentBinding, type EnvelopePreview } from "./CloudConsentSheet";
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

// R10-4: attempt identity is PROCESS-GLOBAL, keyed by draft — the authority a
// LATE terminal outcome reconciles against. A remounted card (a new component
// instance for the same draft) registers its own newer attempt here, so a
// delayed outcome from an older attempt can prove it is stale and never
// mutate the newer attempt's state.
let tutorAttemptCounter = 0;
const tutorLatestAttempt = new Map<string, number>();

/**
 * CORE-1163: a draft's completed answer, persisted at the parent so reopening a
 * collapsed card REPLAYS instantly without re-calling the model (no re-spend, no
 * lost deep tier). Captures everything needed to render the "done" state.
 */
export interface TutorCache {
  lens: TutorMode;
  brief: string;
  deep: string;
  deepRequested: boolean;
  /** Legacy single id (mirrors the brief tier's). New caches carry the
   *  per-tier ids below (R11-6). */
  aiRequestId: string | null;
  /** R11-6: request identity PER RETAINED TIER — a saved brief+deep body has
   *  TWO contributing audit rows, and each tier's identity resets at its own
   *  dispatch (a failed deep must never clobber the brief's contributor). */
  briefRequestId?: string | null;
  deepRequestId?: string | null;
  collapsed: boolean;
  /** R8-4 (legacy, read-only): the single-provider attribution older caches
   *  carried. New caches persist the PER-TIER fields below. */
  answeredProvider?: string | null;
  /** R9-6: PER-TIER attribution — the provider each RETAINED tier's answer
   *  actually came from (derived from that ask's reported provider_host;
   *  null = unknown → neutral). The brief and the deep tier can come from
   *  DIFFERENT providers (a Settings change between them), so one field
   *  cannot honestly attribute both. Persisted through completed AND
   *  interrupted caches so a replay attributes from the cache, never from
   *  current Settings. */
  briefProvider?: string | null;
  deepProvider?: string | null;
  /** R11-5: the attempt ended in the company relay's CAP refusal — a
   *  POST-egress terminal state (the passage already reached the relay). A
   *  reopen shows the cap doors instead of silently re-sending. */
  capExhausted?: boolean;
  /**
   * P1-3: set when a paid call was in flight but the card was unmounted (card
   * switch / section nav) before the answer settled. Its mere presence makes
   * `cached` truthy, so REOPEN replays the (possibly partial) answer instead of
   * auto-firing a SECOND paid `cmd_ai_ask` — the relay already billed the first.
   * The reader can Regenerate explicitly (a deliberate single re-ask), and the UI
   * shows an "interrupted" hint so a partial answer is not mistaken for complete.
   */
  interrupted?: boolean;
}

export interface TutorDraft {
  draftId: string;
  mode: TutorMode;
  /** Absolute char locator of the selection start (== the highlight anchor). */
  locator: string;
  anchorStart: string;
  anchorEnd: string;
  anchoredText: string;
  chapter: string;
  /** Set once the answer has streamed; presence => replay, never re-call. */
  cache?: TutorCache;
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

/**
 * The permanent privacy microline at the card's bottom, honest per MODE
 * (CORE-1190). Local never left the Mac. Company mode went through
 * Throughline's stateless relay (forward, stream, drop), so "the relay keeps
 * nothing" is a promise we can make about OUR relay. BYO went to the READER'S
 * OWN provider account; Throughline cannot promise a third party's retention,
 * so those lines name the provider and claim nothing about what it keeps.
 *
 * R9-6: takes the SET of providers the card's RETAINED tiers came from — the
 * brief and the deep tier can come from different providers. A mixed card
 * gets ENUMERATED copy with no retention claims: never "Answered on this
 * Mac." when any retained tier used the cloud, and never the relay promise
 * stretched across a BYO tier. Exported for tests.
 */
export function tutorPrivacyLine(providers: ReadonlyArray<string | null>): string {
  const unique = [...new Set(providers)];
  if (unique.length === 0) return "Your selection was sent to your AI provider.";
  if (unique.length === 1) {
    switch (unique[0]) {
      case "local":
        return "Answered on this Mac.";
      case "company":
        return "Your selection went through Throughline's relay, which does not log or store it.";
      case "openai":
        return "Your selection was sent to OpenAI using your key.";
      case "anthropic":
        return "Your selection was sent to Anthropic using your key.";
      case "codex":
        return "Your selection was sent to OpenAI through your ChatGPT sign-in.";
      default:
        // Unknown / not-yet-loaded provider: say only what is certain.
        return "Your selection was sent to your AI provider.";
    }
  }
  // Mixed tiers with any UNKNOWN destination: only the neutral line is honest.
  if (unique.some((p) => p == null)) {
    return "Your selection was sent to your AI provider.";
  }
  const name = (p: string): string => {
    switch (p) {
      case "local":
        return "the local model on this Mac";
      case "company":
        return "Throughline's relay";
      case "openai":
        return "OpenAI (your key)";
      case "anthropic":
        return "Anthropic (your key)";
      case "codex":
        return "OpenAI (your ChatGPT sign-in)";
      default:
        return "your AI provider";
    }
  };
  const names = (unique as string[]).map(name);
  return `Parts of this answer came from different places — your selection was sent to ${names.join(" and ")}.`;
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
  /** DATA-004: the note saved durably but its Markdown export failed. */
  onExportIssue?: (noteId: string, message: string) => void;
  onDiscard: () => void;
  /** CORE-1163: persist the completed answer at the parent for instant replay.
   *  R10-4: `null` CLEARS a persisted snapshot (used when a delayed
   *  pre-egress refusal proves an interrupted snapshot never billed). */
  onCached?: (draftId: string, cache: TutorCache | null) => void;
  /** Book title + author, threaded into the cold-start setup sheet's fallback
   *  prompt so a reader who copies it gets a fully-attributed prompt. Optional:
   *  the sheet degrades calmly to "Explain this passage." without them. */
  bookTitle?: string;
  author?: string | null;
}) {
  const { draft } = props;
  // CORE-1163: a cached answer means REPLAY (render at "done", restore sub-state)
  // and never call the model on mount.
  const cached = draft.cache;

  const [lens, setLens] = useState<TutorMode>(cached?.lens ?? draft.mode);
  const [phase, setPhase] = useState<Phase>(cached ? "done" : isTutorEnabled() ? "thinking" : "consent");
  const [briefAnswer, setBriefAnswer] = useState(cached?.brief ?? "");
  const [deepAnswer, setDeepAnswer] = useState(cached?.deep ?? "");
  const [deepRequested, setDeepRequested] = useState(cached?.deepRequested ?? false);
  const [errorMsg, setErrorMsg] = useState("");
  // A failed SAVE (not a failed stream): rendered inside the save form so it is
  // visible in the done phase where saving happens (DATA-005).
  const [saveErr, setSaveErr] = useState<string | null>(null);
  // First-cloud-call consent (C2): set when cmd_ai_ask returns NeedsCloudConsent.
  const [cloudConsent, setCloudConsent] = useState<{
    host: string;
    which: TutorMode;
    tier: Depth;
    /** PRIV-A11Y-009: the exact outbound envelope (cmd_outbound_envelope) —
     *  undefined while loading, null when the fetch failed (the sheet then
     *  shows the full selection directly, never a truncated substitute). */
    envelope?: EnvelopePreview | null;
  } | null>(null);
  const fetchConsentEnvelope = useCallback(
    (which: TutorMode, tier: Depth) => {
      setCloudConsent((cur) => (cur && cur.which === which ? { ...cur, envelope: undefined } : cur));
      invoke<EnvelopePreview>("cmd_outbound_envelope", {
        bookId: props.bookId,
        mode: which,
        selection: draft.anchoredText,
        chapter: draft.chapter || null,
        userNote: null,
        depth: tier,
      })
        .then((env) =>
          // R5: the envelope's host is AUTHORITATIVE at preview time — if the
          // provider changed since NeedsCloudConsent, the sheet re-binds to
          // the new destination together with its matching preview (host and
          // preview can never disagree on screen). A null/hostless response
          // is a failed preview (Send stays disabled).
          setCloudConsent((cur) =>
            cur && cur.which === which
              ? { ...cur, host: env?.host ?? cur.host, envelope: env ?? null }
              : cur,
          ),
        )
        .catch(() =>
          setCloudConsent((cur) => (cur && cur.which === which ? { ...cur, envelope: null } : cur)),
        );
    },
    [props.bookId, draft.anchoredText, draft.chapter],
  );
  // Company-mode cap spent (CM6): set when cmd_ai_ask returns CapExhausted.
  // R11-5: a cached terminal cap state reopens INTO the cap doors — never a
  // silent re-send.
  const [capExhausted, setCapExhausted] = useState(cached?.capExhausted ?? false);
  // The cap screen's $20 door (reuses the existing buy→activate flow).
  const [topUpUrl, setTopUpUrl] = useState<string | null>(null);
  const [modelName, setModelName] = useState("the local model");
  // Provider posture, loaded from settings. Drives the badge + consent copy
  // (WHERE the passage goes). Disabled only when no provider is chosen. null =
  // not yet known.
  const [provider, setProvider] = useState<string | null>(null);
  // R7-9/R8-4/R9-6: the providers the SETTLED answer tiers actually came
  // from — PER TIER, derived from each successful ask's returned
  // provider_host (or, on replay, from the CACHE), never from mount-time
  // Settings state. Legacy caches carried one `answeredProvider`; it reads
  // as the brief tier's.
  const cachedBriefProvider = cached ? (cached.briefProvider ?? cached.answeredProvider ?? null) : null;
  const cachedDeepProvider = cached ? (cached.deepProvider ?? cached.answeredProvider ?? null) : null;
  const [briefProvider, setBriefProvider] = useState<string | null>(cachedBriefProvider);
  const [deepProvider, setDeepProvider] = useState<string | null>(cachedDeepProvider);
  const briefProviderRef = useRef<string | null>(cachedBriefProvider);
  const deepProviderRef = useRef<string | null>(cachedDeepProvider);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(cached?.collapsed ?? false);
  const [showSave, setShowSave] = useState(false);
  const [takeaway, setTakeaway] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const channelRef = useRef<Channel<StreamEvent> | null>(null);
  const aiReqRef = useRef<string>(cached?.aiRequestId ?? "");
  // R10-4/R11-6: request identity as STATE, PER TIER — the Save affordance
  // is honestly disabled while any retained nonempty tier's id is unknown,
  // and the save marks every contributing audit row.
  const cachedBriefReq = cached ? (cached.briefRequestId ?? cached.aiRequestId ?? null) : null;
  const cachedDeepReq = cached?.deepRequestId ?? null;
  const [briefRequestId, setBriefRequestId] = useState<string | null>(cachedBriefReq);
  const [deepRequestId, setDeepRequestId] = useState<string | null>(cachedDeepReq);
  const briefReqRef = useRef<string | null>(cachedBriefReq);
  const deepReqRef = useRef<string | null>(cachedDeepReq);
  // R10-4: mounted/run identity. Every awaited preflight inside startStream
  // re-checks BOTH before proceeding — an unmount (or a newer attempt)
  // during a delayed settings/model preflight must produce ZERO asks.
  const mountedRef = useRef<boolean>(true);
  const attemptSeqRef = useRef<number>(0);
  // The attempt whose dispatch armed the pending state — late terminal
  // outcomes reconcile against this so they never mutate a newer attempt.
  const pendingAttemptRef = useRef<number>(0);
  const briefRef = useRef<string>(cached?.brief ?? "");
  const deepRef = useRef<string>(cached?.deep ?? "");
  const streamTierRef = useRef<Depth>("brief");
  // P1-3 double-charge guard: startedRef => a paid cmd_ai_ask was fired for THIS
  // card instance; doneRef => the answer settled and was persisted to the parent.
  // On unmount, started-but-not-done means the relay billed a call the reader never
  // saw complete, so we persist an interrupted snapshot (below) rather than let a
  // reopen fire a second billable call. lensRef/deepRequestedRef mirror the current
  // state so the empty-deps unmount cleanup can snapshot the latest values.
  const startedRef = useRef<boolean>(false);
  const doneRef = useRef<boolean>(!!cached && !cached.interrupted);
  const lensRef = useRef<TutorMode>(cached?.lens ?? draft.mode);
  const deepRequestedRef = useRef<boolean>(cached?.deepRequested ?? false);
  // True only once a stream actually COMPLETES in this instance. Until then, a
  // replayed interrupted cache must keep its `interrupted` flag when re-persisted
  // (a collapse toggle, say) — otherwise a partial answer silently heals to "done"
  // without the reader ever regenerating it (P1-3).
  const completedFreshRef = useRef<boolean>(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // A11Y-010: a tutor card spawned active from the selection toolbar receives
  // focus, so a keyboard reader lands on the answer they just asked for.
  useEffect(() => {
    if (props.active) cardRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const startStream = useCallback(async (which: TutorMode, tier: Depth, consent?: ConsentBinding) => {
    // R10-4: this RUN's identity, taken before any await. Superseded (a newer
    // attempt — in this instance or a remounted one) or unmounted runs must
    // go quiet at every awaited boundary — never dispatch, never mutate
    // newer state.
    const attempt = ++tutorAttemptCounter;
    attemptSeqRef.current = attempt;
    const superseded = () => !mountedRef.current || attemptSeqRef.current !== attempt;
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
      // R10-4: identity check after EVERY awaited preflight — an unmount (or
      // a newer attempt) during a delayed settings read produces ZERO asks.
      if (superseded()) return;
      if (!s.ai_provider || s.ai_provider === "none") { setPhase("blocked"); return; }
      liveProvider = s.ai_provider;
    } catch {
      if (superseded()) return;
      setPhase("blocked"); return; // can't read settings → fail closed
    }

    await ensureModel();
    if (superseded()) return; // R10-4: same check after the model preflight

    const channel = new Channel<StreamEvent>();
    channelRef.current = channel;
    let firstDelta = true;
    let errored = false;
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
        // R9-6: a done AFTER an error on this stream is not a completion —
        // partial text must never heal into a "complete" answer.
        if (!errored) {
          completedFreshRef.current = true; // a real completion clears any interrupted flag
          setPhase((p) => (p === "error" ? p : "done"));
        }
      } else if (ev.kind === "error") {
        errored = true;
        setErrorMsg(humanizeError(liveProvider, ev.message ?? "The tutor couldn't answer this time."));
        setPhase("error");
      }
    };

    // R9-6: PENDING STATE IS ARMED BEFORE THE DISPATCH. From the moment
    // cmd_ai_ask is invoked the call may be billed and deltas may stream in
    // ahead of the AskHandle resolving — an unmount in that window must
    // persist a NEUTRAL interrupted cache (provider unknown until the handle
    // reports it) so a reopen replays instead of auto-firing a second ask.
    // R10-4: this dispatch OWNS the pending state (late terminal outcomes
    // reconcile against it), and the request identity RESETS with it — new
    // text is never cached or saved under an older attempt's request id.
    startedRef.current = true;
    doneRef.current = false;
    pendingAttemptRef.current = attempt;
    tutorLatestAttempt.set(draft.draftId, attempt);
    aiReqRef.current = "";
    if (tier === "brief") {
      briefReqRef.current = null;
      setBriefRequestId(null);
      deepReqRef.current = null;
      setDeepRequestId(null);
    } else {
      // R11-6: the deep tier resets ITS OWN identity only — a failed or
      // empty deep must never clobber the brief's contributor.
      deepReqRef.current = null;
      setDeepRequestId(null);
    }
    if (tier === "brief") {
      briefProviderRef.current = null;
      setBriefProvider(null);
      deepProviderRef.current = null;
      setDeepProvider(null);
    } else {
      deepProviderRef.current = null;
      setDeepProvider(null);
    }

    try {
      const handle = await invoke<AskHandle>("cmd_ai_ask", {
        bookId: props.bookId,
        mode: which,
        depth: tier,
        selection: draft.anchoredText,
        chapter: draft.chapter || null,
        locator: draft.locator,
        userNote: null,
        // R6-1: on the confirmed retry this carries the sheet's binding; the
        // backend validates it against THIS call at the send boundary. Any
        // drift comes back as NeedsCloudConsent below — fresh sheet, fresh
        // preview, nothing sent, no consent armed.
        consent: consent ?? null,
        onEvent: channel,
      });
      // R9-6: a DELAYED handle from a superseded attempt (regenerate, lens
      // switch, unmount) is ignored — it must not attribute or re-identify
      // the CURRENT attempt's answer.
      if (channelRef.current === channel && !superseded()) {
        aiReqRef.current = handle.ai_request_id;
        if (tier === "brief") {
          briefReqRef.current = handle.ai_request_id;
          setBriefRequestId(handle.ai_request_id);
        } else {
          deepReqRef.current = handle.ai_request_id;
          setDeepRequestId(handle.ai_request_id);
        }
        // R7-9/R8-4/R9-6: attribution follows the destination the backend
        // REPORTED for this ask — the audit row's provider_host — recorded
        // PER TIER. The refs feed cache persistence (including the
        // done-before-handle ordering and the unmount snapshot).
        const pid = providerIdForHost(handle.provider_host);
        if (tier === "brief") {
          briefProviderRef.current = pid;
          setBriefProvider(pid);
        } else {
          deepProviderRef.current = pid;
          setDeepProvider(pid);
        }
      }
    } catch (e) {
      const err = e as { kind?: string; host?: string; message?: string };
      // R10-4: LATE terminal outcomes reconcile by attempt identity. A
      // delayed pre-egress refusal (NeedsCloudConsent / CapExhausted)
      // arriving after this attempt was unmounted proves ITS interrupted
      // snapshot never billed anything: clear exactly that pending state
      // (restoring the consent path on reopen) — and never touch a NEWER
      // attempt's state.
      if (channelRef.current !== channel) {
        // The PROCESS-GLOBAL registry is the authority: only when no newer
        // attempt (any instance, any remount) has dispatched for this draft
        // may the stale outcome touch the pending snapshot.
        if (tutorLatestAttempt.get(draft.draftId) !== attempt) return;
        if (err?.kind === "NeedsCloudConsent") {
          // ONLY this refusal is proven PRE-egress (R11-5): nothing left the
          // Mac, nothing was billed — clear the snapshot so a reopen walks
          // the consent path.
          tutorLatestAttempt.delete(draft.draftId);
          startedRef.current = false;
          props.onCached?.(draft.draftId, null);
        } else if (err?.kind === "CapExhausted") {
          // POST-egress terminal state: upgrade the interrupted snapshot so
          // a reopen shows the cap doors, never a silent re-send.
          props.onCached?.(draft.draftId, {
            lens: lensRef.current,
            brief: briefRef.current,
            deep: deepRef.current,
            deepRequested: deepRequestedRef.current,
            aiRequestId: briefReqRef.current,
            briefRequestId: briefReqRef.current,
            deepRequestId: deepReqRef.current,
            collapsed: false,
            interrupted: true,
            capExhausted: true,
            briefProvider: briefProviderRef.current,
            deepProvider: deepProviderRef.current,
          });
        }
        return;
      }
      if (channelRef.current === channel) {
        if (err?.kind === "NeedsCloudConsent") {
          // PROVEN PRE-EGRESS refusal: the backend refused before anything
          // left the Mac — nothing was billed, so the pending state clears
          // (R9-6) and no interrupted cache will be persisted for it.
          startedRef.current = false;
          // First cloud send — pause and ask once before anything leaves the Mac.
          // Fetch the EXACT outbound envelope so the sheet discloses precisely
          // what would be sent (PRIV-A11Y-009): every field, full bounded text.
          // FAIL-CLOSED: until it loads, Send stays disabled; a failed fetch
          // shows Retry (fetchConsentEnvelope re-runs this) and Not now only.
          setCloudConsent({ host: err.host ?? "the cloud provider", which, tier });
          fetchConsentEnvelope(which, tier);
          return;
        }
        if (err?.kind === "CapExhausted") {
          // R11-5: a 402 is POST-egress — the selection already reached the
          // relay. Persist the TERMINAL cap state so an unmount/remount
          // shows the cap doors instead of silently re-sending; doneRef
          // stops the unmount snapshot from overwriting it.
          doneRef.current = true;
          props.onCached?.(draft.draftId, {
            lens: which,
            brief: briefRef.current,
            deep: deepRef.current,
            deepRequested: deepRequestedRef.current,
            aiRequestId: briefReqRef.current,
            briefRequestId: briefReqRef.current,
            deepRequestId: deepReqRef.current,
            collapsed: false,
            interrupted: true,
            capExhausted: true,
            briefProvider: briefProviderRef.current,
            deepProvider: deepProviderRef.current,
          });
          // Company-paid credits spent — fall to the BYO-key / local floor.
          setCapExhausted(true);
          return;
        }
        // Any other rejection is NOT proven pre-egress (a network failure can
        // happen mid-send) — the pending state stays armed, so an unmount
        // persists the interrupted snapshot rather than permitting a silent
        // second ask (R9-6).
        setErrorMsg(humanizeError(liveProvider, String(err?.message ?? e)));
        setPhase("error");
      }
    }
  }, [ensureModel, props.bookId, draft.anchoredText, draft.chapter, draft.locator]);

  // Auto-start once on a GENUINE first open. A cached answer replays from initial
  // state (phase "done"), so the model is NOT called on reopen; only on first open,
  // explicit Regenerate, a new lens (pickLens), or Go deeper.
  useEffect(() => {
    // R10-4: re-arm on every effect setup — StrictMode (dev) runs
    // setup → cleanup → setup on the same instance, and a stale
    // mountedRef=false from the probe cleanup would silence the real run.
    mountedRef.current = true;
    if (!cached && isTutorEnabled()) startStream(draft.mode, "brief");
    // Dropping the channel ref on unmount soft-cancels any in-flight stream.
    return () => {
      mountedRef.current = false; // R10-4: silences any in-flight preflight
      channelRef.current = null;
      // P1-3: a paid stream that started but never settled to a "done" cache (card
      // switch / section nav mid-stream). Persist an interrupted snapshot so REOPEN
      // replays the partial answer instead of silently firing a SECOND paid call —
      // the relay already billed this one. Uses refs (not the stale mount-time
      // closure) for the latest streamed text + sub-state.
      if (startedRef.current && !doneRef.current) {
        props.onCached?.(draft.draftId, {
          lens: lensRef.current,
          brief: briefRef.current,
          deep: deepRef.current,
          deepRequested: deepRequestedRef.current,
          aiRequestId: briefReqRef.current,
          briefRequestId: briefReqRef.current,
          deepRequestId: deepReqRef.current,
          collapsed: false,
          interrupted: true,
          // R9-6: per-tier attribution rides through INTERRUPTED caches too.
          // A pending attempt whose AskHandle never resolved is null here —
          // the replay renders the NEUTRAL line, never a guess.
          briefProvider: briefProviderRef.current,
          deepProvider: deepProviderRef.current,
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Mirror sub-state into refs the unmount cleanup reads (empty-deps closure).
  useEffect(() => {
    lensRef.current = lens;
    deepRequestedRef.current = deepRequested;
  });

  // CORE-1163: persist the completed answer + sub-state to the parent so a later
  // reopen replays it. Fires when the stream settles (phase "done") and whenever a
  // persisted sub-state (collapsed / lens / deep) changes. Idempotent on replay.
  useEffect(() => {
    if (phase !== "done" || !briefAnswer) return;
    // The answer settled: a clean cache (never interrupted). doneRef stops the
    // unmount cleanup from overwriting it with an interrupted snapshot (P1-3).
    doneRef.current = true;
    props.onCached?.(draft.draftId, {
      lens,
      brief: briefAnswer,
      deep: deepAnswer,
      deepRequested,
      aiRequestId: briefRequestId,
      briefRequestId,
      deepRequestId,
      collapsed,
      // Preserve the interrupted flag on pure replay/sub-state changes; only a
      // fresh stream completion in this instance clears it (P1-3).
      interrupted: !completedFreshRef.current && !!cached?.interrupted,
      // R11 closure: the TERMINAL cap state survives every cache rewrite —
      // including THIS replay/sub-state re-persist. Without it, a reopen of
      // a brief-done + deep-402 card silently rewrote the cache without the
      // flag, and the SECOND reopen lost the cap doors. Only an explicit
      // retry (retryAfterTopUp / setup connect) clears the state.
      capExhausted,
      // R8-4/R9-6: per-tier attribution rides in the cache. Both providers
      // are deps, so an AskHandle resolving AFTER the done event re-persists
      // the entry with its attribution.
      briefProvider,
      deepProvider,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, briefAnswer, deepAnswer, deepRequested, lens, collapsed, briefProvider, deepProvider, briefRequestId, deepRequestId, capExhausted]);

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
    // R11 closure: leaving the cap screen through "Keep going free" is the
    // reader's explicit retry on a NEW provider — the terminal cap state (and
    // any half-open checkout note) clears BEFORE the replacement request, or
    // the done-persist effect would write capExhausted back into the fresh
    // answer's cache and the cap doors would swallow the streamed answer.
    setCapExhausted(false);
    setTopUpUrl(null);
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
    if (!briefReqRef.current || !briefRef.current.trim()) return;
    // R11-6: a nonempty deep tier may only be saved with ITS identity known —
    // otherwise its audit row would be silently omitted. (The Save button is
    // disabled in that state; this is the belt.)
    if (deepRef.current.trim() && !deepReqRef.current) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const body = [takeaway.trim(), briefRef.current.trim(), deepRef.current.trim()]
        .filter(Boolean)
        .join("\n\n");
      // Every contributing request rides with the save so EVERY audit row is
      // marked wrote_to_memory in the same transaction (R11-6).
      const contributing = deepRef.current.trim() && deepReqRef.current
        ? [deepReqRef.current]
        : [];
      const saved = await invoke<SavedNote>("cmd_save_ai_response_as_note", {
        aiRequestId: briefReqRef.current,
        contributingRequestIds: contributing,
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
      // DATA-004: durable save + a failed Markdown merge are separate facts.
      if (!saved.export.ok) {
        props.onExportIssue?.(saved.note.id, saved.export.message ?? "The Markdown export needs attention.");
      }
      // Let the reader see "Saved ✓" briefly before the draft becomes a note.
      setTimeout(() => props.onSaved(saved.note), 1100);
    } catch (e) {
      // DATA-005: this error renders in the CURRENT phase (inside the save
      // form), not in the unreachable phase==="error" branch — the takeaway
      // text stays, and Save retries.
      setSaveErr(humanizeError(provider, String((e as { message?: string })?.message ?? e)));
    } finally {
      setSaving(false);
    }
  }, [takeaway, draft, props, provider]);

  const briefStreaming = streaming && streamTierRef.current === "brief";
  const deepStreaming = streaming && streamTierRef.current === "deep";
  // CORE-1158: under reduced motion the answer reads as pre-resolved — no blinking
  // caret at all (the aria-busy toggle still announces the finished tier as one
  // chunk). The CSS hides the caret too; gating the element keeps it out of the
  // DOM entirely so nothing animates and assistive tech sees only the settled text.
  const reduceMotion =
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  // Permanent privacy microline at the card's bottom — honest about WHERE the
  // answer came from, per provider mode (CORE-1190). Never imply on-device when
  // the selection went to the cloud, and never claim retention on a third
  // party's behalf (BYO).
  // R7-9/R8-4/R9-6: the settled line names where the RETAINED TIERS actually
  // came from — cache-derived on replay, handle-derived on a fresh stream,
  // NEUTRAL when unknown, ENUMERATED when the tiers came from different
  // providers. Never current Settings (a provider change after the answer
  // must not re-attribute it).
  const privacyLine = tutorPrivacyLine(
    deepRequested ? [briefProvider, deepProvider] : [briefProvider],
  );

  return (
    <div
      ref={cardRef}
      className={`tl-card tl-tutor${props.active ? " active" : ""}${collapsed ? " is-collapsed" : ""}`}
      style={props.style}
      onClick={props.onActivate}
      role="complementary"
      aria-label={`Tutor — ${lensMeta.label}`}
      tabIndex={-1}
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
            You've used the generous tutoring included with your license. That's a lot of
            reading. The tutor keeps working: add your own API key or switch to a local model
            below, free. Reading is unaffected.
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
            subtitle="Use your own API key, or run a local model on this Mac. Free either way."
            onConnected={onSetupConnected}
          />
          <div className="tl-caphit-doors">
            <p className="tl-caphit-secondary">Prefer to stay on the built-in tutor?</p>
            <button
              className="tl-tutor-ghost"
              onClick={(e) => { e.stopPropagation(); topUp(); }}
            >
              Get another full allowance for $20
            </button>
            {topUpUrl !== null && (
              <p className="tl-tutorfuel-note" role="status">
                {topUpUrl === "" ? (
                  <>Couldn't start checkout. Try again in a moment.</>
                ) : (
                  <>
                    Opening checkout in your browser. If it doesn't open,{" "}
                    <a href={topUpUrl} target="_blank" rel="noopener noreferrer">continue here</a>.
                    After you buy, activation happens automatically, then{" "}
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
              Think you hit this unusually early? Reply to your purchase email and tell me.
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
            <div className="tl-tutor-answer tl-md" aria-live="polite" aria-busy={briefStreaming}>
              <Prose text={briefAnswer} />
              {!reduceMotion && briefStreaming && <span className="tl-caret" />}
              {!reduceMotion && phase === "thinking" && streamTierRef.current === "brief" && !briefAnswer && (
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
              <div className="tl-tutor-answer tl-md" aria-live="polite" aria-busy={deepStreaming}>
                <Prose text={deepAnswer} />
                {!reduceMotion && deepStreaming && <span className="tl-caret" />}
                {!reduceMotion && phase === "thinking" && streamTierRef.current === "deep" && !deepAnswer && (
                  <span className="tl-caret" />
                )}
              </div>
            </div>
          )}

          {/* P1-3: the first answer was interrupted (a card switch mid-stream). We
              replay what streamed rather than silently re-charge; tell the reader it
              is partial so they can Regenerate deliberately. */}
          {!collapsed && cached?.interrupted && phase === "done" && (
            <p className="tl-tutor-note" role="status">
              This answer was interrupted.{" "}
              <button className="tl-tutor-deeper-link" onClick={(e) => { e.stopPropagation(); regenerate(); }}>
                Ask again
              </button>
            </p>
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
                {saveErr && (
                  <p className="tl-tutor-note" role="alert">
                    Couldn't save this to your notes ({saveErr}). Your takeaway is still here — try Save again.
                  </p>
                )}
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
                {/* Lens row: pills in one row; the active chip is the accent-FILLED
                    pill (handoff: the lens row is the card's primary affordance). */}
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
                {/* Footer: a quiet Save text button + where the NOTE is kept (with a
                    lock glyph), then the permanent privacy microline (honest about
                    where the ANSWER came from). */}
                <div className="tl-tutor-foot">
                  <div className="tl-tutor-foot-row">
                    {/* R10-4/R11-6: never a silently inert Save — the button
                        is disabled with the honest reason while ANY retained
                        nonempty tier's request identity is unknown (an
                        interrupted replay, a handle that never arrived). */}
                    <button
                      className="tl-tutor-save"
                      disabled={
                        !briefRequestId || (!!deepAnswer.trim() && !deepRequestId)
                      }
                      title={
                        briefRequestId && (!deepAnswer.trim() || deepRequestId)
                          ? undefined
                          : "Part of this answer didn't finish, so it can't be saved yet — Ask again first."
                      }
                      onClick={(e) => { e.stopPropagation(); setShowSave(true); }}
                    >
                      <TLIcon name="pencil" size={13} /> Save as note
                    </button>
                    <span className="tl-tutor-foot-sp" />
                    <span className="tl-tutor-foot-note"><TLIcon name="shield" size={11} /> On this Mac only</span>
                  </div>
                  {/* Low-allowance strip (company mode, only when low) — the card's
                      one legitimate warning, sitting just above the privacy line. */}
                  {!capExhausted && <TutorFuel provider={provider} />}
                  <p className="tl-tutor-privacy"><TLIcon name="shield" size={11} /> {privacyLine}</p>
                </div>
              </>
            )
          )}
        </>
      )}

      {cloudConsent && (
        <CloudConsentSheet
          host={cloudConsent.host}
          disclosure={
            // R6-1: the disclosure names the provider the ENVELOPE resolved —
            // the same authority the heading's host and the send binding come
            // from — never separately-cached component state.
            AI_PROVIDERS.find((p) => p.id === (cloudConsent.envelope?.provider ?? provider))?.disclosure
              ?? `Your selected passage (below) is sent to ${cloudConsent.host} so the tutor can answer, with the book's title, author, and chapter name for context — never the whole book.`
          }
          envelope={cloudConsent.envelope}
          onRetryEnvelope={() => fetchConsentEnvelope(cloudConsent.which, cloudConsent.tier)}
          onCancel={() => {
            setCloudConsent(null);
            setPhase("error");
            setErrorMsg("Cloud AI wasn't confirmed — enable it anytime in Settings.");
          }}
          onConfirm={async () => {
            // R6-1: no confirm-then-send race. The confirmed ask carries the
            // binding the backend issued with this exact preview; the send
            // boundary re-resolves the call and validates provider + host +
            // envelope fingerprint before anything egresses. Consent is
            // recorded THERE, only when the binding matches. Drift comes back
            // as NeedsCloudConsent: startStream's catch reopens this sheet
            // with the new destination and its fresh matching preview.
            const c = cloudConsent;
            const env = c.envelope;
            if (!env) throw new Error("the preview hasn't loaded — nothing was sent");
            setCloudConsent(null);
            await startStream(c.which, c.tier, {
              provider: env.provider,
              host: env.host,
              fingerprint: env.fingerprint,
            });
          }}
        />
      )}
    </div>
  );
}

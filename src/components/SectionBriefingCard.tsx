import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import AiSetupSheet from "./AiSetupSheet";
import CloudConsentSheet, { type ConsentBinding, type EnvelopePreview } from "./CloudConsentSheet";
import { aiProviderLabel, errorMessage, providerIdForHost, type AskHandle, type SettingsDto, type StreamEvent } from "../types";
import { humanizeError, looksUnavailable } from "../aiErrors";
import { isTutorEnabled, setTutorEnabled } from "../tutorConsent";
import {
  getCachedBriefing,
  setCachedBriefing,
  clearCachedBriefing,
  getBriefingAttempt,
  setBriefingAttempt,
  clearBriefingAttempt,
  getBriefingPending,
  setBriefingPending,
  clearBriefingPending,
  parseBriefing,
} from "../sectionBriefing";
import "../tl-tutor.css";

/**
 * Deep Study "Section briefing" — prepared marginalia for today's section.
 *
 * On session start (the parent only mounts this once `session != null`), this
 * either replays the session's in-memory briefing instantly or, with the
 * reader's tutor consent, streams a fresh one from the reader's chosen
 * provider — local by default, cloud only through the same explicit consent
 * gate the lenses use. It is spoiler-safe, regenerable, and dismissable, and
 * it never auto-fires without that consent.
 *
 * Privacy (CLAUDE.md): prompts + injection hardening live server-side; this
 * UI renders only the streamed briefing. Only the current section's text is
 * sent — never the whole book. The briefing is cached in memory for this
 * session only (counsel posture: non-persistent unless saved) and becomes
 * durable only when the reader saves it as a note.
 */
type Phase = "consent" | "thinking" | "streaming" | "done" | "error" | "blocked";

// R10-4: attempt tokens are process-global so a remounted card can never
// collide with (or accidentally reconcile) a previous instance's attempt.
let briefingAttemptCounter = 0;

function InlineMd({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>;
    return <span key={i}>{p}</span>;
  });
}

export default function SectionBriefingCard(props: {
  bookId: string;
  sectionId: string;
  sourceSha: string;
  /** "deep_study" — part of the cache key so a mode change re-prepares. */
  mode: string;
  chapter: string;
  locator: string;
  /** The section text to prepare a briefing for (parent passes the loaded text). */
  sectionText: string;
  onDismiss: () => void;
  /** Deep Study v2 marker action. When provided, each "Watch for" item becomes a
   *  subtle marker the reader can tap to open a Context tutor flow on that theme.
   *  Reader-initiated, local-only, same consent rules — never auto-opens. */
  onAskContext?: (theme: string) => void;
  /** Book title + author, threaded into the cold-start setup sheet's fallback
   *  prompt. Optional: the sheet degrades calmly without them. */
  bookTitle?: string;
  author?: string | null;
}) {
  const { bookId, sectionId, sourceSha, mode } = props;
  const cached = getCachedBriefing(bookId, sectionId, sourceSha, mode);
  // FT-13 (CORE-1046): a briefing that already failed this session must NOT
  // re-fire just because the reader remounted the card (nav / re-entry). Mount
  // straight into the error state and wait for a deliberate [Try again].
  const priorFailed = !cached && getBriefingAttempt(bookId, sectionId, sourceSha, mode) === "failed";
  // R10-4: a PENDING marker (armed immediately before a dispatch) with no
  // cache means an ask for this section is already in flight or was
  // interrupted by an unmount — remounting must NOT auto-fire a second one.
  const pendingInterrupted =
    !cached && !priorFailed && getBriefingPending(bookId, sectionId, sourceSha, mode) != null;

  const [phase, setPhase] = useState<Phase>(
    cached
      ? "done"
      : priorFailed || pendingInterrupted
        ? "error"
        : isTutorEnabled()
          ? "thinking"
          : "consent",
  );
  const [text, setText] = useState(cached?.text ?? "");
  const [errorMsg, setErrorMsg] = useState(
    priorFailed
      ? "The briefing couldn't be prepared this time. Try again."
      : pendingInterrupted
        ? "The briefing was interrupted before it finished. Try again to prepare it."
        : "",
  );
  const mountedRef = useRef(true);
  // R11-4: the instance's CURRENT attempt token (see generate()).
  const attemptSeqRef = useRef(0);
  // Provider posture, loaded from settings. Drives WHERE the section text goes
  // (badge + consent copy). The briefing is disabled only when no provider is
  // chosen; "local" keeps the on-device promise, a chosen cloud provider was
  // explicitly opted into with disclosure. null = not yet known.
  const [provider, setProvider] = useState<string | null>(null);
  // R7-9/R8-4: the provider the SETTLED briefing actually came from —
  // handle-derived on a fresh stream, CACHE-derived on replay, never
  // mount-time Settings state. Null renders neutral, never "local".
  const [answeredProvider, setAnsweredProvider] = useState<string | null>(
    cached?.answeredProvider ?? null,
  );
  const answeredProviderRef = useRef<string | null>(cached?.answeredProvider ?? null);
  const settledRef = useRef(cached != null);
  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => setProvider(s.ai_provider || "none"))
      .catch(() => setProvider("none")); // fail closed
  }, []);

  const channelRef = useRef<Channel<StreamEvent> | null>(null);
  const textRef = useRef<string>(cached?.text ?? "");
  const cardRef = useRef<HTMLDivElement | null>(null);

  // First-cloud-send consent (PRIV-A11Y-009 / TRUST-002): when this briefing is
  // the reader's FIRST cloud action, cmd_ai_ask returns NeedsCloudConsent and
  // the SAME fail-closed sheet the lenses use opens here — with the exact
  // SECTION envelope, since a briefing sends the section, not a selection.
  const [cloudConsent, setCloudConsent] = useState<{
    host: string;
    /** undefined while loading, null when the fetch failed (Send stays disabled). */
    envelope?: EnvelopePreview | null;
  } | null>(null);
  const fetchConsentEnvelope = useCallback(() => {
    setCloudConsent((cur) => (cur ? { ...cur, envelope: undefined } : cur));
    invoke<EnvelopePreview>("cmd_outbound_envelope", {
      bookId,
      mode: "section_briefing",
      selection: props.sectionText,
      chapter: props.chapter || null,
      userNote: null,
      depth: "brief",
    })
      // R5: the envelope's host is authoritative at preview time (see
      // MarginTutorCard) — re-bind host + preview together on drift. A
      // null/hostless response is a failed preview (Send stays disabled).
      .then((env) =>
        setCloudConsent((cur) =>
          cur ? { ...cur, host: env?.host ?? cur.host, envelope: env ?? null } : cur,
        ),
      )
      .catch(() => setCloudConsent((cur) => (cur ? { ...cur, envelope: null } : cur)));
  }, [bookId, props.sectionText, props.chapter]);

  const ensureModel = useCallback(async () => {
    try {
      const s = await invoke<SettingsDto>("cmd_get_settings");
      // Only the local server needs model auto-detection; cloud models default.
      if (s.ai_provider !== "local" || s.ai_model?.trim()) return;
      const conn = await invoke<{ reachable: boolean; first_model_id: string | null }>("cmd_test_ai_connection", {});
      if (conn.reachable && conn.first_model_id) {
        await invoke<SettingsDto>("cmd_set_ai_settings", { provider: "local", model: conn.first_model_id });
      }
    } catch { /* the call below surfaces a clear error if this didn't help */ }
  }, []);

  const generate = useCallback(async (consent?: ConsentBinding) => {
    // R10-4/R11-4: this RUN's identity, taken before any await. Superseded
    // means unmounted OR no longer the instance's CURRENT attempt — a run
    // overtaken during its preflights never dispatches and never mutates the
    // newer attempt's state.
    const attempt = ++briefingAttemptCounter;
    attemptSeqRef.current = attempt;
    const superseded = () => !mountedRef.current || attemptSeqRef.current !== attempt;
    // R11-4: the moment a newer generation begins, the OLD channel is dead —
    // its stream events are dropped immediately, not merely after this run's
    // preflights finish and install a new channel.
    channelRef.current = null;
    setPhase("thinking");
    setErrorMsg("");
    setText(""); textRef.current = "";
    // R9-6: EVERY generation starts with fresh settle + attribution state. A
    // stale settledRef=true from the previous answer would let this run's
    // post-invoke patch write PARTIAL streamed text into the cache as
    // completed; a stale provider ref would attribute the new text to the
    // previous destination.
    settledRef.current = false;
    answeredProviderRef.current = null;
    setAnsweredProvider(null);

    // PROVIDER GATE (authoritative, just before sending). The briefing sends the
    // section's text, so a provider must be explicitly chosen. Local stays
    // on-device; a chosen cloud provider was opted into with disclosure. The
    // backend re-checks per call. Re-read live so a Settings change takes effect.
    // The live provider also feeds error copy below, so failures name the
    // provider actually asked.
    let liveProvider = "none";
    try {
      const s = await invoke<SettingsDto>("cmd_get_settings");
      // R10-4: identity check after EVERY awaited preflight — an unmount
      // during a delayed settings read must produce ZERO asks.
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
    let first = true;
    let errored = false;
    channel.onmessage = (ev) => {
      if (channelRef.current !== channel) return; // superseded → drop
      if (ev.kind === "delta") {
        if (first) { first = false; setPhase("streaming"); }
        textRef.current += ev.text ?? "";
        setText(textRef.current);
      } else if (ev.kind === "done") {
        // R9-6: a done AFTER an error is not a completion — partial text is
        // never cached as a completed briefing.
        if (errored) return;
        clearBriefingPending(bookId, sectionId, sourceSha, mode, attempt);
        setPhase((p) => (p === "error" ? p : "done"));
        settledRef.current = true;
        if (textRef.current.trim()) {
          // R8-4: the cache carries the attribution the ask REPORTED. If the
          // AskHandle resolves after this done event, the post-invoke patch
          // below rewrites the entry with it.
          setCachedBriefing(
            bookId,
            sectionId,
            sourceSha,
            mode,
            textRef.current,
            answeredProviderRef.current,
          );
          setBriefingAttempt(bookId, sectionId, sourceSha, mode, "ok");
        }
      } else if (ev.kind === "error") {
        errored = true;
        clearBriefingPending(bookId, sectionId, sourceSha, mode, attempt);
        setBriefingAttempt(bookId, sectionId, sourceSha, mode, "failed");
        setErrorMsg(humanizeError(liveProvider, ev.message ?? "The briefing couldn't be prepared this time."));
        setPhase("error");
      }
    };

    // R10-4: the SESSION pending marker is armed IMMEDIATELY BEFORE the
    // dispatch — a dispatch → unmount → remount sequence finds it and does
    // not auto-fire a second ask (exactly one ask per deliberate action).
    setBriefingPending(bookId, sectionId, sourceSha, mode, attempt);
    try {
      const handle = await invoke<AskHandle>("cmd_ai_ask", {
        bookId,
        mode: "section_briefing",
        depth: "brief",
        selection: props.sectionText,
        chapter: props.chapter || null,
        locator: props.locator,
        userNote: null,
        // R6-1: the confirmed retry carries the sheet's binding; the backend
        // validates it against THIS call at the send boundary and records
        // consent only on a match. Drift returns NeedsCloudConsent below.
        consent: consent ?? null,
        onEvent: channel,
      });
      // R7-9/R8-4: attribution follows the destination the backend REPORTED.
      if (channelRef.current === channel) {
        answeredProviderRef.current = providerIdForHost(handle.provider_host);
        setAnsweredProvider(answeredProviderRef.current);
        // done-before-AskHandle ordering: the cache entry written by the
        // done handler predates this handle — patch its attribution in.
        if (settledRef.current && textRef.current.trim()) {
          setCachedBriefing(
            bookId,
            sectionId,
            sourceSha,
            mode,
            textRef.current,
            answeredProviderRef.current,
          );
        }
      }
    } catch (e) {
      // R10-4/R11-5: LATE terminal outcomes reconcile by attempt identity.
      // ONLY NeedsCloudConsent is proven PRE-egress (the backend refused
      // before anything left the Mac): its pending marker clears so the next
      // remount may auto-generate and walk the consent path again.
      // CapExhausted is POST-egress — the section already reached the relay
      // (the 402 came back from it) — so it settles as a TERMINAL failed
      // state: no marker-clear-and-rearm, no silent resend; only a
      // deliberate Try again re-sends. Any other late outcome leaves the
      // marker standing, and a NEWER attempt's marker is never touched
      // (token match).
      if (channelRef.current !== channel) {
        const lateErr = e as { kind?: string };
        if (lateErr?.kind === "NeedsCloudConsent") {
          clearBriefingPending(bookId, sectionId, sourceSha, mode, attempt);
        } else if (lateErr?.kind === "CapExhausted") {
          setBriefingAttempt(bookId, sectionId, sourceSha, mode, "failed");
          clearBriefingPending(bookId, sectionId, sourceSha, mode, attempt);
        }
        return;
      }
      if (channelRef.current === channel) {
        clearBriefingPending(bookId, sectionId, sourceSha, mode, attempt);
        setBriefingAttempt(bookId, sectionId, sourceSha, mode, "failed");
        // P1-2: branch on the AppError kind. NeedsCloudConsent and CapExhausted have
        // no `message` historically, so the old String(e) rendered "[object Object]"
        // and Try again re-fired the identical rejection forever. Give each an
        // actionable line, and otherwise fall back to errorMessage() (which reads the
        // now-backstopped `message`) so no reject ever surfaces as garbage.
        const err = e as { kind?: string; host?: string };
        if (err?.kind === "NeedsCloudConsent") {
          // First cloud send, and this briefing is the first cloud action —
          // open the SAME fail-closed consent sheet the lenses use, with the
          // exact SECTION envelope (never a detour to "go ask the tutor
          // somewhere else first"). Nothing was sent; the attempt marker is
          // cleared so a confirmed consent can regenerate immediately.
          clearBriefingAttempt(bookId, sectionId, sourceSha, mode);
          setCloudConsent({ host: err.host ?? "the cloud provider" });
          fetchConsentEnvelope();
          return;
        }
        if (err?.kind === "CapExhausted") {
          setErrorMsg(
            "You've used your Throughline AI for now. Add your own key or a local model in Settings to keep going.",
          );
        } else {
          setErrorMsg(humanizeError(liveProvider, errorMessage(e)));
        }
        setPhase("error");
      }
    }
  }, [ensureModel, bookId, sectionId, sourceSha, mode, props.sectionText, props.chapter, props.locator]);

  // A deliberate reader action (Prepare / Try again / regenerate / setup
  // recovery) clears any failed marker so the one explicit send is allowed; the
  // mount effect itself never clears it (FT-13). One marker, two guards.
  const retry = useCallback((consent?: ConsentBinding) => {
    clearBriefingAttempt(bookId, sectionId, sourceSha, mode);
    clearBriefingPending(bookId, sectionId, sourceSha, mode); // deliberate action
    generate(consent);
  }, [bookId, sectionId, sourceSha, mode, generate]);

  // Auto-prepare once on mount when already consented and not cached — but only
  // when there is no attempt this session. A cached briefing shows instantly
  // with no call; a remembered failure mounts into the error state above and
  // waits for [Try again]. Without consent we wait for the tap.
  useEffect(() => {
    // R10-4: re-arm on every effect setup (StrictMode runs
    // setup → cleanup → setup on the same instance).
    mountedRef.current = true;
    if (!cached && !priorFailed && !pendingInterrupted && isTutorEnabled()) generate();
    return () => {
      mountedRef.current = false; // R10-4: silences in-flight preflights
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the streaming tail in view — but ONLY inside a genuinely bounded scroll
  // region (the narrow overlay drawer / side panel / flow fallback). In the wide
  // spread the card grows in normal flow with no internal scroll, so the desk is
  // never yanked while the briefing streams.
  useEffect(() => {
    if (phase !== "streaming" && phase !== "thinking") return;
    const panel = cardRef.current?.closest(".tl-margin-inner, .tl-sidepanel, .tl-margin.flow") as HTMLElement | null;
    if (panel && panel.scrollHeight > panel.clientHeight + 1) panel.scrollTop = panel.scrollHeight;
  }, [text, phase]);

  const enableAndPrepare = useCallback(async () => {
    setTutorEnabled(true);
    clearBriefingAttempt(bookId, sectionId, sourceSha, mode);
    clearBriefingPending(bookId, sectionId, sourceSha, mode); // deliberate action
    await generate();
  }, [bookId, sectionId, sourceSha, mode, generate]);

  const regenerate = useCallback(() => {
    clearCachedBriefing(bookId, sectionId, sourceSha, mode);
    clearBriefingAttempt(bookId, sectionId, sourceSha, mode);
    clearBriefingPending(bookId, sectionId, sourceSha, mode); // deliberate action
    generate();
  }, [bookId, sectionId, sourceSha, mode, generate]);

  // Cold-start recovery: the setup sheet connected (or asked us to retry). Read
  // the live provider and immediately prepare the briefing — no Settings detour.
  const onSetupConnected = useCallback((connected: string) => {
    setTutorEnabled(true);
    if (connected) setProvider(connected);
    clearBriefingAttempt(bookId, sectionId, sourceSha, mode);
    generate();
  }, [bookId, sectionId, sourceSha, mode, generate]);

  const streaming = phase === "thinking" || phase === "streaming";
  const parts = parseBriefing(text);

  return (
    <div ref={cardRef} tabIndex={-1} className="tl-card tl-tutor tl-briefing" role="complementary" aria-label="Section briefing">
      <div className="tl-tutor-head">
        <span className="tl-tutor-badge"><TLIcon name="sparkle" size={13} /> Section briefing</span>
        <span className="tl-tutor-status">
          {streaming ? (
            <span className="tl-tutor-live"><span className="tl-tutor-livedot" /><span className="tl-tutor-liveword">Preparing</span><span className="tl-tutor-liveell">…</span></span>
          ) : phase === "done" ? (
            // R7-9/R8-4: the settled badge names where the briefing ACTUALLY
            // came from — cache/handle-derived, NEUTRAL when unknown, and
            // NEVER current Settings (nor "local" for an unknown host).
            answeredProvider === "local" ? (
              <span className="tl-tutor-local"><TLIcon name="shield" size={12} /> On this Mac</span>
            ) : (
              <span className="tl-tutor-remote" title={`Answered by ${aiProviderLabel(answeredProvider ?? "")}`}>{aiProviderLabel(answeredProvider ?? "")}</span>
            )
          ) : null}
        </span>
        {phase === "done" && (
          <button className="tl-iconbtn" aria-label="Regenerate briefing" title="Regenerate" onClick={(e) => { e.stopPropagation(); regenerate(); }}>
            <TLIcon name="refresh" size={14} />
          </button>
        )}
        <button className="tl-iconbtn" aria-label="Dismiss briefing" title="Dismiss" onClick={(e) => { e.stopPropagation(); channelRef.current = null; props.onDismiss(); }}>
          <TLIcon name="x" size={14} />
        </button>
      </div>

      {phase === "blocked" || (phase === "consent" && (provider === "none" || provider === "")) ? (
        // Cold-start: no provider wired up. Setup at the moment of intent rather
        // than a dead-end pointer to Settings.
        <AiSetupSheet
          ctx={{
            mode: "section_briefing",
            selectedText: props.sectionText,
            bookTitle: props.bookTitle ?? "",
            author: props.author ?? null,
            sectionLabel: props.chapter || null,
            sectionText: props.sectionText,
          }}
          initialState="not_connected"
          onConnected={onSetupConnected}
        />
      ) : phase === "error" && looksUnavailable(errorMsg) ? (
        // Configured-but-unavailable: "Tutor paused" recovery, never Settings-only.
        <AiSetupSheet
          ctx={{
            mode: "section_briefing",
            selectedText: props.sectionText,
            bookTitle: props.bookTitle ?? "",
            author: props.author ?? null,
            sectionLabel: props.chapter || null,
            sectionText: props.sectionText,
          }}
          initialState="unavailable"
          provider={provider ?? undefined}
          onConnected={onSetupConnected}
        />
      ) : phase === "consent" ? (
        <div className="tl-tutor-consent">
          <p>
            Deep Study can prepare a spoiler-safe briefing for this section — what it's about, what
            to watch for, key terms, and a question to carry.{" "}
            {provider === "local"
              ? "It runs on your Mac; nothing leaves your device."
              : `This sends the section's text to ${aiProviderLabel(provider ?? "")}.`}
          </p>
          <div className="tl-tutor-consent-btns">
            <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); props.onDismiss(); }}>Not now</button>
            <button className="tl-btn tl-btn-primary" onClick={(e) => { e.stopPropagation(); enableAndPrepare(); }}>Prepare briefing</button>
          </div>
        </div>
      ) : phase === "error" ? (
        <div className="tl-tutor-errbox" role="alert">
          <p>{errorMsg}</p>
          <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); retry(); }}>
            <TLIcon name="refresh" size={14} /> Try again
          </button>
        </div>
      ) : (
        <div className="tl-briefing-body tl-md" aria-live="polite">
          {parts.unstructured ? (
            <p>{parts.beforeYouRead}{streaming && <span className="tl-caret" />}</p>
          ) : (
            <>
              {parts.beforeYouRead && (
                <section className="tl-briefing-part">
                  <h4>Before you read</h4>
                  <p><InlineMd text={parts.beforeYouRead} /></p>
                </section>
              )}
              {parts.watchFor.length > 0 && (
                <section className="tl-briefing-part">
                  <h4>Watch for</h4>
                  {props.onAskContext ? (
                    // v2 markers: each watch-for item is a subtle "context available"
                    // marker. Tapping opens a Context tutor flow for that theme — a
                    // thematic lookup, not a claim about an exact passage location
                    // (safe v1 anchoring: no fake precision). Never auto-opens.
                    <ul className="tl-briefing-markers">
                      {parts.watchFor.map((b, i) => (
                        <li key={i}>
                          <button
                            className="tl-briefing-marker"
                            title="Ask the tutor for context on this"
                            onClick={(e) => { e.stopPropagation(); props.onAskContext?.(b); }}
                          >
                            <span className="tl-briefing-marker-dot" />
                            <span className="tl-briefing-marker-text"><InlineMd text={b} /></span>
                            <TLIcon name="sparkle" size={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <ul>{parts.watchFor.map((b, i) => <li key={i}><InlineMd text={b} /></li>)}</ul>
                  )}
                </section>
              )}
              {parts.keyTerms.length > 0 && (
                <section className="tl-briefing-part">
                  <h4>Key terms</h4>
                  <ul className="tl-briefing-terms">{parts.keyTerms.map((b, i) => <li key={i}><InlineMd text={b} /></li>)}</ul>
                </section>
              )}
              {parts.theMove && (
                <section className="tl-briefing-part">
                  <h4>The move</h4>
                  <p><InlineMd text={parts.theMove} /></p>
                </section>
              )}
              {parts.readingQuestion && (
                <section className="tl-briefing-part tl-briefing-q">
                  <h4>Reading question</h4>
                  <p><InlineMd text={parts.readingQuestion} /></p>
                </section>
              )}
              {streaming && <span className="tl-caret" />}
            </>
          )}
          {phase === "done" && (
            <p className="tl-briefing-prov">
              <TLIcon name="shield" size={11} />{" "}
              {answeredProvider === "local"
                ? "Prepared on this Mac for today's section."
                : `Prepared via ${aiProviderLabel(answeredProvider ?? "")} for today's section.`}
            </p>
          )}
        </div>
      )}

      {cloudConsent && (
        <CloudConsentSheet
          host={cloudConsent.host}
          subject="section"
          disclosure={`Today's section (below) is sent to ${cloudConsent.host} so Deep Study can prepare the briefing, with the book's title, author, and chapter name for context — never the whole book.`}
          envelope={cloudConsent.envelope}
          returnFocus={cardRef}
          onRetryEnvelope={fetchConsentEnvelope}
          onCancel={() => {
            setCloudConsent(null);
            setErrorMsg("Cloud AI wasn't confirmed — enable it anytime in Settings.");
            setPhase("error");
          }}
          onConfirm={async () => {
            // R6-1: no confirm-then-send race (see MarginTutorCard). The
            // confirmed ask carries the binding the backend issued with THIS
            // preview; the send boundary validates provider + host + envelope
            // fingerprint and records consent only on a match. Drift comes
            // back as NeedsCloudConsent: generate's catch reopens this sheet
            // with the new destination and its fresh matching preview.
            const c = cloudConsent;
            const env = c.envelope;
            if (!env) throw new Error("the preview hasn't loaded — nothing was sent");
            setCloudConsent(null);
            retry({ provider: env.provider, host: env.host, fingerprint: env.fingerprint });
          }}
        />
      )}
    </div>
  );
}

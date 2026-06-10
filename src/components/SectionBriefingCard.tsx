import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import AiSetupSheet from "./AiSetupSheet";
import { aiProviderLabel, type AskHandle, type SettingsDto, type StreamEvent } from "../types";
import { humanizeError, looksUnavailable } from "../aiErrors";
import { isTutorEnabled, setTutorEnabled } from "../tutorConsent";
import {
  getCachedBriefing,
  setCachedBriefing,
  clearCachedBriefing,
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

  const [phase, setPhase] = useState<Phase>(
    cached ? "done" : isTutorEnabled() ? "thinking" : "consent",
  );
  const [text, setText] = useState(cached ?? "");
  const [errorMsg, setErrorMsg] = useState("");
  // Provider posture, loaded from settings. Drives WHERE the section text goes
  // (badge + consent copy). The briefing is disabled only when no provider is
  // chosen; "local" keeps the on-device promise, a chosen cloud provider was
  // explicitly opted into with disclosure. null = not yet known.
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    invoke<SettingsDto>("cmd_get_settings")
      .then((s) => setProvider(s.ai_provider || "none"))
      .catch(() => setProvider("none")); // fail closed
  }, []);

  const channelRef = useRef<Channel<StreamEvent> | null>(null);
  const textRef = useRef<string>(cached ?? "");
  const cardRef = useRef<HTMLDivElement | null>(null);

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

  const generate = useCallback(async () => {
    setPhase("thinking");
    setErrorMsg("");
    setText(""); textRef.current = "";

    // PROVIDER GATE (authoritative, just before sending). The briefing sends the
    // section's text, so a provider must be explicitly chosen. Local stays
    // on-device; a chosen cloud provider was opted into with disclosure. The
    // backend re-checks per call. Re-read live so a Settings change takes effect.
    // The live provider also feeds error copy below, so failures name the
    // provider actually asked.
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
    let first = true;
    channel.onmessage = (ev) => {
      if (channelRef.current !== channel) return; // superseded → drop
      if (ev.kind === "delta") {
        if (first) { first = false; setPhase("streaming"); }
        textRef.current += ev.text ?? "";
        setText(textRef.current);
      } else if (ev.kind === "done") {
        setPhase((p) => (p === "error" ? p : "done"));
        if (textRef.current.trim()) {
          setCachedBriefing(bookId, sectionId, sourceSha, mode, textRef.current);
        }
      } else if (ev.kind === "error") {
        setErrorMsg(humanizeError(liveProvider, ev.message ?? "The briefing couldn't be prepared this time."));
        setPhase("error");
      }
    };

    try {
      await invoke<AskHandle>("cmd_ai_ask", {
        bookId,
        mode: "section_briefing",
        depth: "brief",
        selection: props.sectionText,
        chapter: props.chapter || null,
        locator: props.locator,
        userNote: null,
        onEvent: channel,
      });
    } catch (e) {
      if (channelRef.current === channel) {
        setErrorMsg(humanizeError(liveProvider, String((e as { message?: string })?.message ?? e)));
        setPhase("error");
      }
    }
  }, [ensureModel, bookId, sectionId, sourceSha, mode, props.sectionText, props.chapter, props.locator]);

  // Auto-prepare once on mount when already consented and not cached. A cached
  // briefing shows instantly with no call. Without consent we wait for the tap.
  useEffect(() => {
    if (!cached && isTutorEnabled()) generate();
    return () => { channelRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the streaming tail in view within the panel.
  useEffect(() => {
    if (phase !== "streaming" && phase !== "thinking") return;
    const panel = cardRef.current?.closest(".tl-sidepanel") as HTMLElement | null;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [text, phase]);

  const enableAndPrepare = useCallback(async () => {
    setTutorEnabled(true);
    await generate();
  }, [generate]);

  const regenerate = useCallback(() => {
    clearCachedBriefing(bookId, sectionId, sourceSha, mode);
    generate();
  }, [bookId, sectionId, sourceSha, mode, generate]);

  // Cold-start recovery: the setup sheet connected (or asked us to retry). Read
  // the live provider and immediately prepare the briefing — no Settings detour.
  const onSetupConnected = useCallback((connected: string) => {
    setTutorEnabled(true);
    if (connected) setProvider(connected);
    generate();
  }, [generate]);

  const streaming = phase === "thinking" || phase === "streaming";
  const parts = parseBriefing(text);

  return (
    <div ref={cardRef} className="tl-card tl-tutor tl-briefing" role="complementary" aria-label="Section briefing">
      <div className="tl-tutor-head">
        <span className="tl-tutor-badge"><TLIcon name="sparkle" size={13} /> Section briefing</span>
        <span className="tl-tutor-status">
          {streaming ? (
            <span className="tl-tutor-live"><span className="tl-tutor-livedot" /><span className="tl-tutor-liveword">Preparing</span><span className="tl-tutor-liveell">…</span></span>
          ) : phase === "done" ? (
            provider === "local" ? (
              <span className="tl-tutor-local"><TLIcon name="shield" size={12} /> Local-only</span>
            ) : (
              <span className="tl-tutor-remote">via {aiProviderLabel(provider ?? "")}</span>
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
          <button className="tl-tutor-ghost" onClick={(e) => { e.stopPropagation(); generate(); }}>
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
              {provider === "local"
                ? "Prepared on this Mac for today's section."
                : `Prepared via ${aiProviderLabel(provider ?? "")} for today's section.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

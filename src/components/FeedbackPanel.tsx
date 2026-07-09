import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * CORE-1094 feedback panel — now the "Send feedback" rail destination in Settings
 * (settings redesign), rendered per the canonical six-state spec. Behavior and the
 * privacy contract are UNCHANGED from CORE-1094: it shows the EXACT values that will
 * leave the Mac before the reader taps Send, and only those. All egress happens in
 * Rust (cmd_send_feedback builds an allowlisted payload); this panel only collects
 * the message + optional reply email and previews the Rust-sourced diagnostics.
 *
 * The six states: the collapsed state is gone (the rail item replaced it); open-empty,
 * open-filled, sending, success, and failure/offline are all here. The draft (message
 * + reply email) persists across pane switches and app relaunches until sent.
 */

const HONEST_LINE =
  "Throughline never sends anything on its own. When you tap Send, this is exactly what leaves your Mac: your message, the app version, your macOS version, and which tutor mode you're using, nothing else.";

const MAX_MESSAGE_CHARS = 6000; // mirrors the relay + Rust cap
// The app's one support address. The design handoff's README shows
// feedback@throughline.app — deliberately NOT adopted; the shipped constant is
// the address that actually receives mail (flagged in the redesign notes).
const SUPPORT_EMAIL = "hello@readthroughline.com";

/** Draft persistence (message + reply email survive relaunch until sent). */
const DRAFT_KEY = "tl.feedbackDraft";
const DRAFT_EMAIL_KEY = "tl.feedbackDraftEmail";

interface Diagnostics {
  app_version: string;
  macos_version: string;
  mode: string; // included | own_key | local (mirrors Settings' modeForProvider)
}

type Phase = "idle" | "sending" | "sent" | "error";

export default function FeedbackPanel({ mode, onClose }: { mode: string; onClose: () => void }) {
  const [message, setMessage] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
  const [email, setEmail] = useState(() => localStorage.getItem(DRAFT_EMAIL_KEY) ?? "");
  // Honeypot: a real user never fills it. Bots that auto-fill every field trip it.
  const [honeypot, setHoneypot] = useState("");
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // The 3 diagnostics are sourced in Rust so the preview is byte-identical to what is sent.
    invoke<Diagnostics>("cmd_feedback_diagnostics")
      .then(setDiag)
      .catch(() => setDiag(null));
    textareaRef.current?.focus();
  }, []);

  // The draft survives pane switches and relaunch — a failure never loses words.
  useEffect(() => {
    if (message) localStorage.setItem(DRAFT_KEY, message);
    else localStorage.removeItem(DRAFT_KEY);
  }, [message]);
  useEffect(() => {
    if (email) localStorage.setItem(DRAFT_EMAIL_KEY, email);
    else localStorage.removeItem(DRAFT_EMAIL_KEY);
  }, [email]);

  // Escape returns to the previously viewed pane (spec), preserving the draft.
  // Inert while sending — the in-flight request should resolve into a real state.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || phase === "sending") return;
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  // The mode we PREVIEW is the exact value Rust will send (diag.mode); `mode` (from Settings'
  // modeForProvider) seeds the first render before diagnostics load. Both use the same mapping.
  const appVersion = diag?.app_version ?? "loading";
  const macosVersion = diag?.macos_version ?? "loading";
  const shownMode = diag?.mode ?? mode;

  /** The exact text a mailto/copy fallback carries: the message plus the same diagnostics. */
  function feedbackText(): string {
    const lines = [
      message.trim(),
      "",
      `App version: ${appVersion}`,
      `macOS version: ${macosVersion}`,
      `Tutor mode: ${shownMode}`,
    ];
    if (email.trim()) lines.push(`Reply email: ${email.trim()}`);
    return lines.join("\n");
  }

  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    "Throughline feedback",
  )}&body=${encodeURIComponent(feedbackText())}`;

  async function send() {
    // Honeypot filled → this is a bot. Behave like success but send NOTHING.
    if (honeypot.trim().length > 0) {
      setPhase("sent");
      setMessage("");
      return;
    }
    if (!message.trim()) return;
    // Offline → don't pretend to send; go straight to the safe fallback.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setPhase("error");
      return;
    }
    setPhase("sending");
    try {
      await invoke("cmd_send_feedback", {
        message,
        email: email.trim() ? email.trim() : null, // omitted when blank
      });
      // Clear ONLY on confirmed success, so a failure never loses the reader's words.
      setPhase("sent");
      setMessage("");
      setEmail("");
    } catch {
      setPhase("error");
    }
  }

  async function copyFeedback() {
    try {
      await navigator.clipboard?.writeText(feedbackText());
    } catch {
      /* clipboard is best-effort; the mailto still carries the text */
    }
  }

  // ── State 5: success — the pane content is replaced whole. ──
  if (phase === "sent") {
    return (
      <div className="feedback-pane" aria-label="Send feedback">
        <div className="fb-head">
          <h3 className="set-pane-title">Thank you.</h3>
          <p className="fb-intro">Your feedback is on its way.</p>
        </div>
        <div className="fb-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const sending = phase === "sending";
  const over = message.length > MAX_MESSAGE_CHARS;

  return (
    <div className="feedback-pane" aria-label="Send feedback">
      <div className="fb-head">
        <h3 className="set-pane-title">Send feedback</h3>
        <p className="fb-intro">A note goes straight to the people building Throughline.</p>
      </div>

      {/* ── State 6: failure/offline — a calm notice ABOVE the preserved fields. ── */}
      {phase === "error" && (
        <div className="fb-error" role="alert">
          <p>Couldn't send just now. Your message is safe below.</p>
          <div className="fb-error-actions">
            <a className="fb-ghost" href={mailtoHref}>
              Email it instead
            </a>
            <button className="fb-ghost" type="button" onClick={copyFeedback}>
              Copy feedback
            </button>
          </div>
        </div>
      )}

      <div className={sending ? "fb-field fb-dim" : "fb-field"}>
        <label className="field-label" htmlFor="feedback-message">
          Your message
        </label>
        <textarea
          id="feedback-message"
          ref={textareaRef}
          className="feedback-textarea"
          value={message}
          maxLength={MAX_MESSAGE_CHARS}
          rows={4}
          placeholder="What's working, what isn't, what you wish it did."
          disabled={sending}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <div className={sending ? "fb-field fb-dim" : "fb-field"}>
        <label className="field-label" htmlFor="feedback-email">
          Reply email <span className="fb-opt">(optional)</span>
        </label>
        <input
          id="feedback-email"
          className="feedback-email"
          type="email"
          value={email}
          placeholder="Only if you'd like a reply"
          disabled={sending}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      {/* Honeypot: visually hidden AND removed from the tab order. Real users never see or
          reach it; a bot that fills every field trips it and we send nothing. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={honeypot}
        onChange={(e) => setHoneypot(e.target.value)}
        style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
      />

      {/* The honest line leads directly into the LITERAL preview: exactly what
          leaves the Mac, and only that. Two columns — muted labels, ink values,
          tabular numerals on versions. */}
      <div className="fb-privacy">
        <p className="feedback-honest">{HONEST_LINE}</p>
        <div className="feedback-preview-grid" role="group" aria-label="Exactly what will be sent">
          <span className="fb-k">Your message</span>
          <span
            className={message.trim() ? "fb-v" : "fb-v fb-v-empty"}
            data-testid="preview-message"
          >
            {message.trim() ? message.trim() : "(your message above)"}
          </span>
          {email.trim() && (
            <>
              <span className="fb-k">Reply email</span>
              <span className="fb-v" data-testid="preview-email">
                {email.trim()}
              </span>
            </>
          )}
          <span className="fb-k">App version</span>
          <span className="fb-v fb-num" data-testid="preview-app-version">
            {appVersion}
          </span>
          <span className="fb-k">macOS version</span>
          <span className="fb-v fb-num" data-testid="preview-macos">
            {macosVersion}
          </span>
          <span className="fb-k">Tutor mode</span>
          <span className="fb-v" data-testid="preview-mode">
            {shownMode}
          </span>
        </div>
      </div>

      <div className="fb-foot">
        <button className="btn" type="button" onClick={onClose} disabled={sending}>
          Cancel
        </button>
        <button
          className="btn btn-accent"
          type="button"
          onClick={send}
          disabled={sending || !message.trim() || over}
        >
          {sending ? "Sending…" : phase === "error" ? "Send again" : "Send"}
        </button>
      </div>
    </div>
  );
}

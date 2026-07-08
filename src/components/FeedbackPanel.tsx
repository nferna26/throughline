import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * CORE-1094 feedback panel. Mirrors the CORE-1177 consent-sheet idiom: it shows the EXACT
 * values that will leave the Mac before the reader taps Send, and only those. All egress
 * happens in Rust (cmd_send_feedback builds an allowlisted payload); this panel only collects
 * the message + optional reply email and previews the Rust-sourced diagnostics.
 */

const HONEST_LINE =
  "Throughline never sends anything on its own. When you tap Send, this is exactly what leaves your Mac: your message, the app version, your macOS version, and which tutor mode you're using, nothing else.";

const MAX_MESSAGE_CHARS = 6000; // mirrors the relay + Rust cap
const SUPPORT_EMAIL = "hello@readthroughline.com";

interface Diagnostics {
  app_version: string;
  macos_version: string;
  mode: string; // included | own_key | local (mirrors Settings' modeForProvider)
}

type Phase = "idle" | "sending" | "sent" | "error";

export default function FeedbackPanel({ mode, onClose }: { mode: string; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
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

  if (phase === "sent") {
    return (
      <div className="feedback-panel" role="dialog" aria-label="Send feedback">
        <p className="row-title">Thank you. Your feedback is on its way.</p>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  const over = message.length > MAX_MESSAGE_CHARS;

  return (
    <div className="feedback-panel" role="dialog" aria-label="Send feedback">
      <label className="field-label" htmlFor="feedback-message">
        Your message
      </label>
      <textarea
        id="feedback-message"
        ref={textareaRef}
        className="feedback-textarea"
        value={message}
        maxLength={MAX_MESSAGE_CHARS}
        rows={5}
        placeholder="What's working, what isn't, what you wish it did."
        onChange={(e) => setMessage(e.target.value)}
      />

      <label className="field-label" htmlFor="feedback-email">
        Reply email (optional)
      </label>
      <input
        id="feedback-email"
        className="feedback-email"
        type="email"
        value={email}
        placeholder="Only if you'd like a reply"
        onChange={(e) => setEmail(e.target.value)}
      />

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

      {/* LITERAL preview: exactly what leaves the Mac, beside the honest line. */}
      <div className="feedback-preview">
        <p className="feedback-honest">{HONEST_LINE}</p>
        <ul className="feedback-values" aria-label="Exactly what will be sent">
          <li>
            <span className="feedback-k">Your message</span>
            <span className="feedback-v" data-testid="preview-message">
              {message.trim() ? message.trim() : "(your message above)"}
            </span>
          </li>
          <li>
            <span className="feedback-k">App version</span>
            <span className="feedback-v" data-testid="preview-app-version">
              {appVersion}
            </span>
          </li>
          <li>
            <span className="feedback-k">macOS version</span>
            <span className="feedback-v" data-testid="preview-macos">
              {macosVersion}
            </span>
          </li>
          <li>
            <span className="feedback-k">Tutor mode</span>
            <span className="feedback-v" data-testid="preview-mode">
              {shownMode}
            </span>
          </li>
          {email.trim() && (
            <li>
              <span className="feedback-k">Reply email</span>
              <span className="feedback-v" data-testid="preview-email">
                {email.trim()}
              </span>
            </li>
          )}
        </ul>
      </div>

      {phase === "error" && (
        <div className="feedback-error" role="alert">
          <p>Couldn't send just now. Your message is safe below.</p>
          <div className="feedback-fallback">
            <a className="btn" href={mailtoHref}>
              Email it instead
            </a>
            <button className="btn" type="button" onClick={copyFeedback}>
              Copy feedback
            </button>
          </div>
        </div>
      )}

      <div className="feedback-actions">
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-accent"
          type="button"
          onClick={send}
          disabled={phase === "sending" || !message.trim() || over}
        >
          {phase === "sending" ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

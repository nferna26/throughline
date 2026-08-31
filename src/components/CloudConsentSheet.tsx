import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../types";
import { useDialog } from "../hooks/useDialog";

/** The exact outbound envelope preview (cmd_outbound_envelope). `provider`
 *  and `fingerprint` are the backend-issued consent binding (R6-1): passed
 *  back verbatim with the confirmed ask, where the send boundary validates
 *  them against what that very call resolves to. */
export interface EnvelopePreview {
  host: string;
  provider: string;
  fingerprint: string;
  envelope: {
    book_title: string;
    author: string | null;
    chapter: string | null;
    selection_bounded: string;
    prompt: string;
  };
}

/** What the reader confirmed, exactly as the backend issued it. */
export interface ConsentBinding {
  provider: string;
  host: string;
  fingerprint: string;
}

/**
 * PRIV-A11Y-009: the first-cloud-send consent sheet — an irreversible privacy
 * decision, so it is a REAL modal (dialog semantics on the sheet, focus trapped
 * via useDialog, Escape cancels, invoker focus restored) and it discloses the
 * EXACT outbound envelope: destination, every book-derived field, and the FULL
 * bounded text — never a truncated substitute. Shared by every first-cloud
 * surface (the selection lenses AND Deep Study's section briefing), so the
 * privacy promise is delivered identically wherever the first send happens.
 *
 * FAIL-CLOSED twice over:
 * - Send is enabled ONLY once the exact envelope loaded; a failed preview
 *   keeps Send disabled and offers Retry (and Not now) — nothing can be
 *   confirmed against an unknown payload.
 * - A FAILED confirm (`onConfirm` throwing) keeps the sheet OPEN with the
 *   error and a working Send-again; closing it would leave the reader
 *   believing they consented while nothing was recorded and nothing was sent.
 *   (R6-1: consent itself is recorded by the BACKEND, at the send boundary,
 *   only when the confirmed binding matches the ask being dispatched.)
 *
 * Initial focus lands on "Not now": the safe choice.
 */
export default function CloudConsentSheet(props: {
  host: string;
  disclosure: string;
  /** What is being sent — drives every line of copy: "passage" for the
   *  selection lenses, "section" for Deep Study's briefing (R4). */
  subject?: "passage" | "section";
  envelope: EnvelopePreview | null | undefined;
  onRetryEnvelope: () => void;
  onCancel: () => void;
  /** MUST throw/reject on failure — the sheet then stays open and recoverable.
   *  Close the sheet in the caller only after this resolves. */
  onConfirm: () => void | Promise<void>;
  /** Durable focus-return target for close/cancel — required for surfaces
   *  whose invoker can be transient (Deep Study auto-trigger). */
  returnFocus?: React.RefObject<HTMLElement | null>;
}) {
  const subject = props.subject ?? "passage";
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const notNowRef = useRef<HTMLButtonElement | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  // R4: CANCELLATION AUTHORITY. While the confirm is settling, Not now /
  // Escape / the scrim are inert — a cancel racing a confirm-in-flight could
  // close the sheet, and a then-resolving confirm would record consent and
  // START THE SEND after the reader said no. The ref (not state) is what the
  // Escape handler reads, so a mid-flight keydown can't see a stale value.
  const confirmingRef = useRef(false);
  const guardedCancel = useCallback(() => {
    if (!confirmingRef.current) props.onCancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onCancel]);
  useDialog(sheetRef, guardedCancel, notNowRef, props.returnFocus);

  async function handleConfirm() {
    setConfirming(true);
    confirmingRef.current = true;
    setConfirmErr(null);
    try {
      await props.onConfirm();
    } catch (e) {
      // The consent was NOT recorded and nothing was sent — say so and keep
      // every affordance live (recoverable, never a silent dead sheet).
      setConfirmErr(errorMessage(e));
    } finally {
      setConfirming(false);
      confirmingRef.current = false;
    }
  }

  const env = props.envelope ?? null;
  const loading = props.envelope === undefined;
  const failed = props.envelope === null;
  const passage = env ? env.envelope.selection_bounded : "";
  const fields: string[] = env
    ? [
        `Book: ${env.envelope.book_title}${env.envelope.author ? ` by ${env.envelope.author}` : ""}`,
        ...(env.envelope.chapter ? [`Chapter: ${env.envelope.chapter}`] : []),
      ]
    : [];

  // PORTALED to document.body (a real full-screen modal, not a card overlay).
  // Both invokers mount this sheet from deep inside the margin rail — the
  // anchored tutor card and Deep Study's briefing card — and that subtree is
  // hostile territory for a `position: fixed` scrim:
  //   - the narrow-window overlay drawer puts `transform: translateX(…)` on
  //     `.tl-margin-rail`, which makes the RAIL the containing block for fixed
  //     descendants — the "full-screen" scrim then sizes/clips to the drawer;
  //   - the rail's opacity transition and the anchored card's open animation
  //     each create transient stacking contexts, trapping the scrim's z-index
  //     under sibling chrome while they run;
  //   - the always-mounted rail is `inert` + `overflow: hidden` when closed.
  // An irreversible privacy decision must never render partially covered,
  // clipped, or inert, so the sheet escapes to <body>. React portals keep
  // SYNTHETIC event bubbling through the component tree (unchanged behavior
  // for the cards' onClick handlers); focus trapping, Escape, initial focus,
  // and focus restoration all live on the sheet's own node via useDialog, so
  // they are unaffected by where the DOM node parks.
  return createPortal(
    <div className="tl-scrim" onClick={guardedCancel}>
      <div
        ref={sheetRef}
        className="tl-replan-sheet"
        style={{ maxWidth: 460 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tl-consent-title"
        aria-describedby="tl-consent-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="tl-consent-title">Send this {subject} to {props.host}?</h3>
        {/* The first sentence is the caller's disclosure (the provider's own
            line for the lenses; the section-scoped line for Deep Study), so
            this dialog and its surface can never drift. */}
        <p className="ctx" id="tl-consent-desc">
          {props.disclosure} Your book file never leaves this Mac. Asked once, then remembered.
        </p>
        {fields.length > 0 && (
          <p className="ctx" style={{ marginBottom: 4 }}>
            Sent along with it: {fields.join(" · ")}.
          </p>
        )}
        {failed ? (
          // FAIL CLOSED: without the exact preview, nothing may be sent. The
          // reader retries or declines — Send below stays disabled throughout.
          <p className="ctx" role="alert" style={{ marginBottom: 4 }}>
            Couldn't prepare the exact text to be sent, so nothing will be sent.{" "}
            <button
              className="tl-tutor-deeper-link"
              onClick={(e) => {
                e.stopPropagation();
                props.onRetryEnvelope();
              }}
            >
              Try again
            </button>
          </p>
        ) : (
          <p className="ctx" style={{ marginBottom: 4 }}>
            {loading
              ? "Preparing the exact text to be sent…"
              : `This is the ${subject}, exactly as it will be sent:`}
          </p>
        )}
        {!failed && (
          <blockquote
            style={{
              margin: "0 0 var(--tl-4)",
              padding: "8px 12px",
              borderLeft: "2px solid var(--tl-line)",
              color: "var(--tl-muted)",
              fontSize: 13,
              fontStyle: "italic",
              maxHeight: 180,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            "{passage}"
          </blockquote>
        )}
        {confirmErr && (
          <p className="ctx" role="alert" style={{ marginBottom: 4 }}>
            Couldn't record your OK ({confirmErr}), so nothing was sent. Try again, or Not now.
          </p>
        )}
        <div className="tl-replan-foot">
          <span className="keep">→ {props.host}</span>
          <span className="right">
            <button
              ref={notNowRef}
              className="tl-btn tl-btn-ghost"
              disabled={confirming}
              onClick={guardedCancel}
            >
              Not now
            </button>
            <button
              className="tl-btn tl-btn-primary"
              disabled={!env || confirming}
              onClick={() => void handleConfirm()}
            >
              Send to {props.host}
            </button>
          </span>
        </div>
        {env && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>
              Show the full request, word for word
            </summary>
            <pre
              style={{
                maxHeight: 200,
                overflow: "auto",
                fontSize: 11,
                whiteSpace: "pre-wrap",
                userSelect: "text",
              }}
            >
              {env.envelope.prompt}
            </pre>
          </details>
        )}
      </div>
    </div>,
    document.body,
  );
}

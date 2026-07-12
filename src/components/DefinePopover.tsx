import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";
import type { AskHandle, StreamEvent } from "../types";
import { isTutorEnabled } from "../tutorConsent";

// CORE-1158: Define is a LIGHT inline popover at the selection, not a margin card.
// It sends the EXACT same vocabulary/brief request as the margin card (UX only,
// payload unchanged), renders the short gloss in place, and dismisses on the next
// click or Escape. The heavier flows (first-cloud consent, cap exhausted, the
// not-enabled setup sheet, errors) belong to the proven margin card, so the
// popover defers to it via onOpenInMargin and closes rather than re-implementing
// them in a tooltip.
export default function DefinePopover(props: {
  term: string;
  bookId: string;
  chapter: string | null;
  locator: string;
  x: number;
  y: number;
  below: boolean;
  onClose: () => void;
  onOpenInMargin: () => void;
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"thinking" | "streaming" | "done" | "error">("thinking");
  const channelRef = useRef<Channel<StreamEvent> | null>(null);
  const bufRef = useRef("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { onClose, onOpenInMargin } = props;

  // Defer to the margin card for the heavier flows, then close the popover.
  const escalate = useCallback(() => {
    onOpenInMargin();
    onClose();
  }, [onOpenInMargin, onClose]);

  useEffect(() => {
    if (!isTutorEnabled()) {
      // Not configured yet: hand off to the card's guided setup.
      escalate();
      return;
    }
    const channel = new Channel<StreamEvent>();
    channelRef.current = channel;
    channel.onmessage = (ev) => {
      if (channelRef.current !== channel) return; // superseded → drop
      if (ev.kind === "delta") {
        setPhase((p) => (p === "thinking" ? "streaming" : p));
        bufRef.current += ev.text ?? "";
        setText(bufRef.current);
      } else if (ev.kind === "done") {
        setPhase((p) => (p === "error" ? p : "done"));
      } else if (ev.kind === "error") {
        setPhase("error");
      }
    };
    invoke<AskHandle>("cmd_ai_ask", {
      bookId: props.bookId,
      mode: "vocabulary",
      depth: "brief",
      selection: props.term,
      chapter: props.chapter,
      locator: props.locator,
      userNote: null,
      onEvent: channel,
    }).catch((e) => {
      if (channelRef.current !== channel) return;
      const err = e as { kind?: string };
      // First-cloud consent or spent allowance → hand to the full card.
      if (err?.kind === "NeedsCloudConsent" || err?.kind === "CapExhausted") {
        escalate();
        return;
      }
      setPhase("error");
    });
    return () => {
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A11Y-010: deterministic initial focus — the popover itself takes focus on
  // mount, so its dialog name + streaming definition are announced and Escape
  // works immediately without hunting for the popover.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Dismiss on the next click anywhere outside the popover, and on Escape.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    // Defer the click listener a tick so the click that opened it doesn't close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className={props.below ? "tl-define below" : "tl-define"}
      tabIndex={-1}
      style={{ left: props.x, top: props.y }}
      role="dialog"
      aria-label={`Define ${props.term}`}
    >
      <div className="tl-define-head">
        <span className="tl-define-term">{props.term}</span>
        <button className="tl-iconbtn tl-define-close" aria-label="Dismiss" onClick={onClose}>
          <TLIcon name="x" size={13} />
        </button>
      </div>
      <div className="tl-define-body tl-md" aria-live="polite" aria-busy={phase === "thinking" || phase === "streaming"}>
        {phase === "error" ? (
          <p className="tl-define-err">
            Couldn't define this right now.{" "}
            <button className="tl-define-link" onClick={escalate}>
              Open in the margin
            </button>
          </p>
        ) : text ? (
          <p>{text}</p>
        ) : (
          <p className="tl-define-wait">Defining…</p>
        )}
      </div>
      {phase === "done" && (
        <button className="tl-define-link tl-define-deeper" onClick={escalate}>
          Go deeper in the margin <TLIcon name="chevronRight" size={12} />
        </button>
      )}
    </div>
  );
}

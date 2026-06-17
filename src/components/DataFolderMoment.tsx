import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import TLIcon from "./TLIcon";

/**
 * The one-time data-folder moment (handoff §6). Shown ONCE, the first time a
 * reader imports their own file: it states where everything lives and that
 * catalogue books need no backup, then never returns — no badge, no recurring
 * "back up now" guilt. Calm and dismissible; "Got it" is the safe default.
 *
 * a11y mirrors the remove dialog: role="dialog" + aria-modal, focus moves in on
 * open and returns to the opener on close, Esc and the scrim dismiss, and Tab is
 * trapped within the card.
 */
export default function DataFolderMoment({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement;
    okRef.current?.focus();
    return () => prevFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const f = sheetRef.current?.querySelectorAll<HTMLElement>("button");
        if (!f || f.length === 0) return;
        const list = Array.from(f);
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tl-scrim" onClick={onClose}>
      <div
        className="tl-datafolder"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tl-datafolder-title"
        aria-describedby="tl-datafolder-body"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tl-datafolder-icon" aria-hidden="true">
          <TLIcon name="folder" size={18} />
        </div>
        <h3 id="tl-datafolder-title" className="tl-datafolder-title">
          Everything lives in one folder
        </h3>
        <p id="tl-datafolder-body" className="tl-datafolder-body">
          Your books and notes are kept here on this Mac. Catalogue books re-download anytime, so
          there’s nothing you must back up. If you’d like a copy, this is the folder to save.
        </p>
        <span className="tl-datafolder-path">
          <TLIcon name="folder" size={13} />
          <span className="tl-datafolder-pathtext">{path}</span>
        </span>
        <div className="tl-datafolder-act">
          <button
            type="button"
            className="tl-btn tl-btn-primary"
            onClick={() => {
              void invoke("cmd_reveal_data_folder").catch(() => {});
            }}
          >
            <TLIcon name="folder" size={15} /> Show in Finder
          </button>
          <button type="button" className="tl-btn tl-btn-ghost" ref={okRef} onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { Provenance } from "../types";

/**
 * "Remove from library" confirmation (handoff §3). One verb, TWO source-specific
 * confirmations because the loss genuinely differs: a catalogue book is cheap to
 * re-add, an imported book's reading state is the real thing being deleted.
 * Neither ever touches the reader's original file, and there is NO "delete file"
 * — and never any "this is your only copy" language, because it never is.
 *
 * a11y: role="dialog" + aria-modal, focus moves to "Keep it" (the safe default)
 * on open and returns to the opener on close, Esc and the scrim both keep the
 * book, and Tab is trapped within the sheet. The destructive "Remove" is the
 * clay button on the right; an accidental Enter lands on "Keep it".
 */
export default function RemoveBookDialog({
  title,
  provenance,
  onKeep,
  onRemove,
}: {
  title: string;
  provenance: Provenance;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement;
    // Land on "Keep it" — the reversible choice — not the destructive one.
    keepRef.current?.focus();
    return () => prevFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onKeep();
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
  }, [onKeep]);

  const catalogue = provenance === "catalogue";

  return (
    <div className="tl-scrim" onClick={onKeep}>
      <div
        className="tl-confirm-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tl-remove-title"
        aria-describedby="tl-remove-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="tl-remove-title">Remove {title}?</h3>
        {catalogue ? (
          <>
            <p id="tl-remove-body" className="tl-dlg-body">
              It leaves your library. You can add it back from the catalogue anytime, free.
            </p>
            <p className="tl-dlg-fine">Your reading plan and notes for it will be cleared.</p>
          </>
        ) : (
          <>
            <p id="tl-remove-body" className="tl-dlg-body">
              Your reading progress, notes, and tutor history for it will be deleted.
            </p>
            <p className="tl-dlg-fine">
              Your original file isn’t affected, it stays wherever you keep it, and you can import it
              again.
            </p>
          </>
        )}
        <div className="tl-confirm-foot">
          <button className="tl-btn tl-btn-ghost" ref={keepRef} onClick={onKeep}>
            Keep it
          </button>
          <button className="tl-btn tl-btn-clay" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

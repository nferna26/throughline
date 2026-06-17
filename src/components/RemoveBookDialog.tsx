import { useEffect, useRef } from "react";

/**
 * "Remove from library" confirmation (CORE-1093). A deliberate, focus-trapped
 * confirm — distinct from the first-run back-nav UNDO (which never asks). Calm
 * and in-voice: it names the book and says plainly what goes with it (the
 * reader's place and notes for THIS book), then a clear Remove / Cancel.
 *
 * The a11y contract mirrors RePlanDialog: role="dialog" + aria-modal, focus
 * moves in on open and returns to the opener on close, ESC and the scrim both
 * cancel, and Tab is trapped within the sheet. The primary action lands on
 * Cancel (the safe choice) so an accidental Enter doesn't delete a book.
 */
export default function RemoveBookDialog({
  bookTitle,
  onConfirm,
  onCancel,
}: {
  bookTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement;
    // Land on Cancel — the reversible choice — not the destructive one.
    cancelRef.current?.focus();
    return () => prevFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
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
  }, [onCancel]);

  return (
    <div className="tl-scrim" onClick={onCancel}>
      <div
        className="tl-confirm-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tl-remove-title"
        aria-describedby="tl-remove-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="tl-remove-title">Remove “{bookTitle}” from your library?</h3>
        <p id="tl-remove-body" className="ctx">
          Your place and notes for it will be deleted. The book itself stays free
          to add again later.
        </p>
        <div className="tl-confirm-foot">
          <button className="tl-btn tl-btn-ghost" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button className="tl-btn tl-btn-danger" onClick={onConfirm}>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

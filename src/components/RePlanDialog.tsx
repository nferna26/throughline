import { useEffect, useRef, useState } from "react";

type Choice = "keep" | "pause" | "replace";

/**
 * The "you already have a plan" decision moment (design handoff). A focus-trapped
 * dialog with three calm, shame-free outcomes as radio rows (default = keep). Shown
 * before a new plan is created for a book that already has a live one.
 */
export default function RePlanDialog({
  bookTitle,
  planName,
  progressLine,
  onResolve,
  onCancel,
}: {
  bookTitle: string;
  planName: string;
  progressLine?: string | null;
  onResolve: (choice: Choice) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<Choice>("keep");
  const sheetRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement;
    sheetRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
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
        const f = sheetRef.current?.querySelectorAll<HTMLElement>('button, [role="radio"]');
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

  const name = planName || "the one you started";
  const opts: { id: Choice; t: string; s: string }[] = [
    { id: "keep", t: "Keep my current plan", s: `Stay with ${planName || "your current plan"}. Nothing changes.` },
    { id: "pause", t: "Pause it and start fresh", s: "Set the current one aside and begin a new plan with a clean pace. You can resume it anytime." },
    { id: "replace", t: "Replace it", s: "Begin a new plan and keep the old one as history." },
  ];
  const confirmLabel = choice === "keep" ? "Keep reading" : choice === "pause" ? "Pause & start fresh" : "Replace & start";

  return (
    <div className="tl-scrim" onClick={onCancel}>
      <div
        className="tl-replan-sheet"
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tl-replan-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="tl-replan-title">You already have a plan for {bookTitle}</h3>
        <p className="ctx">
          Your current plan, <b>{name}</b>
          {progressLine ? <>, is on <b>{progressLine}</b></> : ""}. How would you like to begin?
        </p>
        <div className="tl-options" role="radiogroup" aria-label="What to do">
          {opts.map((o) => (
            <button
              key={o.id}
              className="tl-option"
              role="radio"
              aria-checked={choice === o.id}
              onClick={() => setChoice(o.id)}
            >
              <span className="tl-radio" />
              <span>
                <span className="o-t">{o.t}</span>
                <span className="o-s">{o.s}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="tl-replan-foot">
          <span className="keep">Your notes are always kept.</span>
          <span className="right">
            <button className="tl-btn tl-btn-ghost" onClick={onCancel}>Cancel</button>
            <button className="tl-btn tl-btn-primary" onClick={() => onResolve(choice)}>{confirmLabel}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

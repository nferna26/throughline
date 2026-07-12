import { useEffect, type RefObject } from "react";

/**
 * Modal accessibility primitive — call once at the top of every modal panel.
 *
 * Wires up:
 *  - **Escape closes the modal** (calls `onClose`).
 *  - **Focus trap**: Tab cycles inside the modal's focusable elements;
 *    Shift+Tab wraps to the last; Tab past the last wraps to the first.
 *  - **Initial focus**: when the modal mounts, focus moves to the first
 *    focusable element inside `ref` (or the panel itself if none found).
 *  - **Focus restoration**: when the modal unmounts, focus returns to the
 *    element that was focused before the modal opened.
 *
 * Pair with `role="dialog"` + `aria-modal="true"` + `aria-labelledby={…}`
 * on the panel element itself. See `pat-interaction-pattern-catalog-seed`
 * "Escape Hatch" + `guard-accessibility-baseline-wcag-aa` keyboard rules.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  /** Optional explicit initial-focus target (e.g. a consent sheet's "Not now",
   *  so the SAFE choice is focused first regardless of DOM order). Falls back
   *  to the first focusable element. */
  initialFocus?: RefObject<HTMLElement | null>,
  /** Optional DURABLE focus-return target, preferred over whatever happened to
   *  be focused when the modal opened. For modals that open from transient or
   *  auto-triggered contexts (R4: Deep Study's consent sheet can open on
   *  mount), the previously-focused element may be gone or `body` — this
   *  gives focus a real home to land on. */
  returnFocus?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Remember who had focus before we opened.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Initial focus: the explicit target when given, else the first focusable
    // inside the panel, else the panel itself.
    const initial = initialFocus?.current ?? firstFocusable(node) ?? node;
    initial.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusables = getFocusable(node!);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || !node!.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !node!.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    node.addEventListener("keydown", handleKey);
    return () => {
      node.removeEventListener("keydown", handleKey);
      // Restore focus: the durable explicit target first (when given and
      // still in the DOM), else the previously-focused element.
      const durable = returnFocus?.current;
      if (durable && document.contains(durable)) {
        try { durable.focus(); return; } catch { /* fall through */ }
      }
      if (previouslyFocused && document.contains(previouslyFocused)) {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** CSS-style list of focusable selectors, sans elements with tabindex=-1. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  // A <details> disclosure's <summary> is natively focusable/activatable —
  // include it so full-request disclosures stay reachable inside the trap
  // (PRIV-A11Y-009).
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute("disabled"))
    .filter((el) => el.tabIndex !== -1)
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function firstFocusable(root: HTMLElement): HTMLElement | null {
  return getFocusable(root)[0] ?? null;
}

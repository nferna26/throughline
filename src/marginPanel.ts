// Companion-margin visibility, as a tiny pure state machine so the reading
// experience is testable without rendering the (DOM-selection-heavy) reader.
//
// The reading column is the default; the margin is brought in only when it has
// something to hold. Two pieces of state:
//   - open:   is the margin panel currently shown beside the text?
//   - pinned: did the reader deliberately keep it open (the toolbar toggle)?
//             A pin survives an empty section and persists across loads.
//
// Bare text selection NEVER opens the margin (it only shows the floating action
// toolbar). The margin opens when the reader captures something (note / highlight
// / tutor draft / Deep Study briefing); it collapses again when the last item is
// removed — unless the reader pinned it.

export interface MarginState {
  open: boolean;
  pinned: boolean;
}

export type MarginEvent =
  | "select" // reader selected text — the action toolbar shows; the margin must NOT open
  | "capture" // reader created/opened a note, highlight, tutor draft, or briefing
  | "emptied" // the section's last note/draft/briefing was removed
  | "togglePin" // the toolbar's margin toggle
  | "close"; // the panel's × (closes and clears the pin)

/// Initial state on load: open only if the reader had pinned the margin.
export function initialMarginState(pinned: boolean): MarginState {
  return { open: pinned, pinned };
}

// STUB (RED): every event is a no-op, so the behavior tests fail until the GREEN
// commit implements the real transitions.
export function reduceMargin(state: MarginState, _event: MarginEvent): MarginState {
  return state;
}

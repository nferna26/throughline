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

export function reduceMargin(state: MarginState, event: MarginEvent): MarginState {
  switch (event) {
    case "select":
      // A bare selection only raises the floating action toolbar — the margin
      // stays as it was (closed by default), so the text is never crowded by an
      // empty panel just for selecting a passage.
      return state;
    case "capture":
      // The reader made/opened something the margin should hold.
      return { ...state, open: true };
    case "emptied":
      // The last item is gone. Collapse back to the single column — unless the
      // reader explicitly pinned the margin open.
      return state.pinned ? state : { ...state, open: false };
    case "togglePin":
      // The toolbar toggle keys on what the reader SEES: if the margin is open
      // (whether pinned, or just opened by a capture), one click hides it;
      // otherwise it pins the margin open. Keying on `open` — not `pinned` —
      // means the post-capture {open:true, pinned:false} state hides in a single
      // click, matching the button's "Hide notes panel" label.
      return state.open ? { open: false, pinned: false } : { open: true, pinned: true };
    case "close":
      // The panel's × closes it and clears any pin.
      return { open: false, pinned: false };
    default:
      return state;
  }
}

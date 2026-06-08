// Companion-margin visibility, as a tiny pure state machine so the reading
// experience is testable without rendering the (DOM-selection-heavy) reader.
//
// The reading column is the default; the margin is brought in only when it has
// something to hold. Two pieces of state:
//   - open:   did the reader open the margin THIS session (a capture, or an
//             explicit toggle)? Never restored from storage.
//   - pinned: the reader's persisted preference to keep the margin beside the
//             text. Remembered across loads, but it must NEVER force an EMPTY
//             panel open on load — see `marginVisible`.
//
// A bare text selection never opens the margin (it only shows the floating action
// toolbar). The margin shows when the reader captured something, or when they
// pinned it AND there is content for the section. An empty section opens to a
// clean single column even for a pinned reader.

export interface MarginState {
  open: boolean;
  pinned: boolean;
}

export type MarginEvent =
  | "select" // reader selected text — the action toolbar shows; the margin must NOT open
  | "capture" // reader created/opened a note, highlight, tutor draft, or briefing
  | "emptied" // the section's last note/draft/briefing was removed
  | "show" // reader opened the margin (toggle while hidden)
  | "hide"; // reader closed the margin (toggle while visible, or the panel ×)

/// Initial state on load: NEVER open. The pin is remembered, but the margin only
/// re-appears once there is content to hold (or the reader opens it).
export function initialMarginState(pinned: boolean): MarginState {
  return { open: false, pinned };
}

export function reduceMargin(state: MarginState, event: MarginEvent): MarginState {
  switch (event) {
    case "select":
      return state;
    case "capture":
      return { ...state, open: true };
    case "emptied":
      return state.pinned ? state : { ...state, open: false };
    case "show":
      return { open: true, pinned: true };
    case "hide":
      return { open: false, pinned: false };
    default:
      return state;
  }
}

// Whether the margin panel is actually shown beside the text. It shows when the
// reader opened it this session, OR when they've pinned it AND there is something
// to hold. A pinned-but-empty margin on load stays collapsed — the reader opens
// to a clean column, never an empty half-panel.
export function marginVisible(state: MarginState, hasContent: boolean): boolean {
  return state.open || (state.pinned && hasContent);
}

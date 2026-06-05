// Local AI tutor consent — a single source of truth for the opt-in flag.
//
// AGENTS.md: AI is opt-in. The reader enables the local tutor once (via the
// in-margin consent card OR the Settings → Assistance toggle); the choice
// persists in localStorage and is REVOCABLE from Settings. Turning it off makes
// the next tutor-lens click ask for consent again. This is a UI preference, so
// it lives in localStorage alongside fontSize / lineWidth / panelOpen — not in
// the Rust settings DB (which governs the endpoint, model, and local-only).

const KEY = "rg.tutorEnabled";

/** True only when the reader has explicitly enabled the local tutor. */
export function isTutorEnabled(): boolean {
  return localStorage.getItem(KEY) === "true";
}

/** Enable or revoke the local tutor. Revoking re-arms the consent gate. */
export function setTutorEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? "true" : "false");
}

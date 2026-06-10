/**
 * Reader-facing copy for the auto-updater (FT-15 / CORE-1048).
 *
 * tauri-plugin-updater raises raw plumbing on failure — e.g. "Could not fetch a
 * valid release JSON from the remote", and a future network failure surfaces
 * reqwest text that can carry the github.com URL. None of that belongs on a
 * reader's screen: "release JSON", "remote", "endpoint", and a bare URL are all
 * plumbing words the experience bar forbids. This mirrors aiErrors.humanizeError
 * — map the raw failure to calm copy that says what happened and what to do
 * next, and never returns the raw string.
 */

/** Which step failed — check (looking for an update) vs download (installing). */
export type UpdatePhase = "check" | "download";

const CHECK_COPY =
  "Couldn't check for updates right now. Make sure you're connected to the internet and try again in a moment.";
const DOWNLOAD_COPY =
  "The update couldn't finish downloading. Your current version keeps working — try again in a few minutes.";

/**
 * Turn a raw updater failure into calm reader copy. `phase` defaults to the
 * check step; the download step gets its own reassuring copy. The raw message
 * is never returned — the default branch is the check-phase copy.
 */
export function humanizeUpdateError(_raw: string, phase: UpdatePhase = "check"): string {
  return phase === "download" ? DOWNLOAD_COPY : CHECK_COPY;
}

// Deep Study "Section briefing" — cache + parser.
//
// The briefing is AI-derived study scaffolding for a whole section, generated
// once on session start (Deep Study mode only) and cached so revisiting a
// section within the SAME sitting is instant and never re-spams the model. It
// is regenerable and dismissable; it is never exported (exports carry only the
// reader's own words).
//
// **The cache is session-only, by policy** (CLAUDE.md §3, counsel-reviewed):
// briefings stay "non-persistent unless saved", so AI output derived from book
// text lives in process memory and dies with the app. Earlier builds persisted
// it in localStorage; `purgeLegacyBriefings()` (called once at startup) removes
// those leftover keys.
//
// Cache key = bookId | sectionId | source_sha256 | mode: a new section, a
// re-imported source (new sha), or a different margin-help mode all miss the
// cache and re-prepare; the same trio hits instantly within the sitting.

import { LEGACY_PREFIX } from "./legacyStorage";

export type MarginHelp = "quiet" | "guided" | "deep_study";

export const BRIEFING_LABELS = [
  "BEFORE YOU READ",
  "WATCH FOR",
  "KEY TERMS",
  "THE MOVE",
  "READING QUESTION",
] as const;

export interface BriefingParts {
  beforeYouRead: string;
  watchFor: string[];
  keyTerms: string[];
  theMove: string;
  readingQuestion: string;
  /** True when none of the labels were found — caller should show raw text. */
  unstructured: boolean;
}

/**
 * Deep Study stale-text identity guard (pure, so it's unit-testable without a
 * DOM or epub.js). A section briefing may ONLY be generated/cached when the
 * loaded section text provably belongs to the section currently displayed —
 * otherwise navigating A→B while A's text is still in state could brief section
 * B using section A's text and cache it under B's id (AGENTS.md invariant).
 *
 * The reader funnels through this: TextReader passes `loadedSectionId` (its
 * `textSectionId` state). EPUB books now read through the same TextReader path
 * (their text is extracted to plain text at import), so there is one code path.
 *
 * Returns true only when there IS a current section, its text has loaded, the
 * loaded text's section id matches the current section, and the text is
 * non-empty. Any mismatch (mid-navigation) or missing piece returns false.
 */
export function briefingTextReady(
  currentSectionId: string | null | undefined,
  loadedSectionId: string | null | undefined,
  loadedText: string | null | undefined,
): boolean {
  if (!currentSectionId) return false;
  if (!loadedSectionId) return false;
  if (loadedSectionId !== currentSectionId) return false;
  return !!loadedText && loadedText.trim().length > 0;
}

/** The pre-v0.3.x persistent cache's localStorage prefix (under the pre-rename
 *  app prefix) — used only by `purgeLegacyBriefings` to clean older installs.
 *  New code never writes it. */
const LEGACY_BRIEFING_PREFIX = `${LEGACY_PREFIX}.briefing.`;

/** R8-4: a cached briefing carries its ATTRIBUTION — the provider id the
 *  answer actually came from (null = unknown → neutral). A replay attributes
 *  from here, never from current Settings. */
export type CachedBriefing = { text: string; answeredProvider: string | null };

/** Session-only store. Process memory by design — see the module header. */
const cache = new Map<string, CachedBriefing>();

function cacheKey(bookId: string, sectionId: string, sha: string, mode: string): string {
  return `${bookId}|${sectionId}|${sha}|${mode}`;
}

export function getCachedBriefing(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
): CachedBriefing | null {
  return cache.get(cacheKey(bookId, sectionId, sha, mode)) ?? null;
}

export function setCachedBriefing(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
  text: string,
  answeredProvider: string | null = null,
): void {
  cache.set(cacheKey(bookId, sectionId, sha, mode), { text, answeredProvider });
}

export function clearCachedBriefing(bookId: string, sectionId: string, sha: string, mode: string): void {
  cache.delete(cacheKey(bookId, sectionId, sha, mode));
}

/** Drop everything cached this session. Test hook (the cache is module-level,
 *  so suites reset it between cases). */
export function resetBriefingCache(): void {
  cache.clear();
}

// ── Session attempt markers (FT-13 / CORE-1046) ────────────────────────────
// A failed briefing must NOT silently re-fire every time the reader remounts
// the card — the reader nav remounts it on each Next/Prev (key={section.id})
// and on re-entering the reader, and a failed generate() is one cmd_ai_ask =
// one history row + one metered section-text send. The mount effect may
// auto-fire only when there is no attempt this session; a recorded "failed"
// mounts straight into the error state, and only a deliberate reader action
// (Prepare / Try again / regenerate) clears the marker and re-sends.
//
// Session-only by the same policy as the cache: process memory, dies with the
// app. The key is the same trio so a new section / re-import / mode change is a
// fresh attempt.
export type BriefingAttempt = "failed" | "ok";

const attempts = new Map<string, BriefingAttempt>();

export function getBriefingAttempt(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
): BriefingAttempt | null {
  return attempts.get(cacheKey(bookId, sectionId, sha, mode)) ?? null;
}

export function setBriefingAttempt(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
  outcome: BriefingAttempt,
): void {
  attempts.set(cacheKey(bookId, sectionId, sha, mode), outcome);
}

export function clearBriefingAttempt(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
): void {
  attempts.delete(cacheKey(bookId, sectionId, sha, mode));
}

/** Drop every attempt marker this session. Test hook (module-level map). */
export function resetBriefingAttempts(): void {
  attempts.clear();
}

// ── Session PENDING markers (R10-4) ─────────────────────────────────────────
// Armed IMMEDIATELY BEFORE a briefing's cmd_ai_ask dispatches, carrying that
// attempt's token. A remount that finds a pending marker (and no cache) knows
// an ask for this exact section is already in flight or was interrupted — it
// must NOT auto-fire a second one (dispatch → unmount → remount = exactly one
// ask). The marker clears when ITS attempt reaches a terminal outcome, or
// when a late PRE-EGRESS refusal (NeedsCloudConsent) reconciles it — matched
// by token, so a late outcome never clears a NEWER attempt's marker.
// Session-only by the same policy as the cache.
const pendingAsks = new Map<string, number>();

export function setBriefingPending(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
  attemptToken: number,
): void {
  pendingAsks.set(cacheKey(bookId, sectionId, sha, mode), attemptToken);
}

export function getBriefingPending(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
): number | null {
  return pendingAsks.get(cacheKey(bookId, sectionId, sha, mode)) ?? null;
}

/** Clear the pending marker — only when it still belongs to `attemptToken`
 *  (omit the token for a deliberate reader action like Try again). */
export function clearBriefingPending(
  bookId: string,
  sectionId: string,
  sha: string,
  mode: string,
  attemptToken?: number,
): void {
  const key = cacheKey(bookId, sectionId, sha, mode);
  if (attemptToken === undefined || pendingAsks.get(key) === attemptToken) {
    pendingAsks.delete(key);
  }
}

/** Drop every pending marker this session. Test hook (module-level map). */
export function resetBriefingPending(): void {
  pendingAsks.clear();
}

/** One-time startup cleanup (App.tsx): earlier builds persisted briefings in
 *  localStorage under the legacy briefing prefix, which the counsel posture
 *  forbids — remove any leftovers so no unsaved AI output survives on disk. */
export function purgeLegacyBriefings(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_BRIEFING_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage unavailable — then nothing persisted to purge */
  }
}

/** Strip a leading bullet marker ("- ", "* ", "• ") from a line. */
function stripBullet(line: string): string {
  return line.replace(/^\s*[-*•]\s+/, "").trim();
}

/**
 * Parse a five-part briefing into its labeled sections. Tolerant: labels are
 * matched case-insensitively at the start of a line (ignoring stray markdown),
 * bullet/term parts are split into lines, prose parts are joined. If no labels
 * are found at all, returns `unstructured: true` with the whole text in
 * `beforeYouRead` so the card can still render something useful.
 */
export function parseBriefing(text: string): BriefingParts {
  const empty: BriefingParts = {
    beforeYouRead: "",
    watchFor: [],
    keyTerms: [],
    theMove: "",
    readingQuestion: "",
    unstructured: false,
  };
  if (!text.trim()) return empty;

  const lines = text.split("\n");
  // Map each line index to a label if it IS a label line.
  const norm = (s: string) => s.replace(/[#*_`]/g, "").trim().toUpperCase();
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  let sawAnyLabel = false;

  for (const raw of lines) {
    const n = norm(raw);
    const matched = BRIEFING_LABELS.find((l) => n === l);
    if (matched) {
      current = matched;
      sections[current] = [];
      sawAnyLabel = true;
      continue;
    }
    if (current && raw.trim()) sections[current].push(raw);
  }

  if (!sawAnyLabel) {
    return { ...empty, beforeYouRead: text.trim(), unstructured: true };
  }

  const prose = (label: string) => (sections[label] ?? []).map((l) => l.trim()).join(" ").trim();
  const bullets = (label: string) =>
    (sections[label] ?? []).map(stripBullet).filter((l) => l.length > 0);

  return {
    beforeYouRead: prose("BEFORE YOU READ"),
    watchFor: bullets("WATCH FOR"),
    keyTerms: bullets("KEY TERMS"),
    theMove: prose("THE MOVE"),
    readingQuestion: prose("READING QUESTION"),
    unstructured: false,
  };
}

// Deep Study "Section briefing" — cache + parser.
//
// The briefing is AI-derived study scaffolding for a whole section, generated
// once on session start (Deep Study mode only) and cached LOCALLY so revisiting
// a section is instant and never re-spams the model. It is regenerable and
// dismissable; it is never exported (AGENTS.md: raw source + AI output stay
// local; exports carry only the reader's own words). The cache lives in
// localStorage — a reversible, on-this-Mac cache, not operational DB state.
//
// Cache key = bookId | sectionId | source_sha256 | mode, exactly as specced: a
// new section, a re-imported source (new sha), or a different margin-help mode
// all miss the cache and re-prepare; the same trio hits instantly.

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

const PREFIX = "rg.briefing.";

function cacheKey(bookId: string, sectionId: string, sha: string, mode: string): string {
  return `${PREFIX}${bookId}|${sectionId}|${sha}|${mode}`;
}

export function getCachedBriefing(bookId: string, sectionId: string, sha: string, mode: string): string | null {
  try {
    return localStorage.getItem(cacheKey(bookId, sectionId, sha, mode));
  } catch {
    return null;
  }
}

export function setCachedBriefing(bookId: string, sectionId: string, sha: string, mode: string, text: string): void {
  try {
    localStorage.setItem(cacheKey(bookId, sectionId, sha, mode), text);
  } catch {
    /* quota / unavailable — caching is best-effort, the briefing still shows */
  }
}

export function clearCachedBriefing(bookId: string, sectionId: string, sha: string, mode: string): void {
  try {
    localStorage.removeItem(cacheKey(bookId, sectionId, sha, mode));
  } catch {
    /* ignore */
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

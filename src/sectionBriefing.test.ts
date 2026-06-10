import { describe, it, expect, beforeEach } from "vitest";
import {
  parseBriefing,
  getCachedBriefing,
  setCachedBriefing,
  clearCachedBriefing,
  resetBriefingCache,
  purgeLegacyBriefings,
  briefingTextReady,
} from "./sectionBriefing";

beforeEach(() => {
  localStorage.clear();
  resetBriefingCache();
});

const SAMPLE = `BEFORE YOU READ
This section establishes the central tension between humanity and God.

WATCH FOR
- The paradox of knowing versus calling upon God.
- Humanity framed as "a particle of Thy creation".

KEY TERMS
- Particle of Thy creation — human smallness before God.
- To call on Thee — prayer, which Augustine questions.

THE MOVE
It sets up the whole trajectory of the Confessions.

READING QUESTION
Can you seek something you do not already know?`;

describe("parseBriefing", () => {
  it("splits the five labeled parts into prose + bullet lists", () => {
    const p = parseBriefing(SAMPLE);
    expect(p.unstructured).toBe(false);
    expect(p.beforeYouRead).toMatch(/central tension/);
    expect(p.watchFor).toHaveLength(2);
    expect(p.watchFor[0]).toBe("The paradox of knowing versus calling upon God.");
    expect(p.keyTerms).toHaveLength(2);
    expect(p.keyTerms[0]).toMatch(/Particle of Thy creation — human smallness/);
    expect(p.theMove).toMatch(/trajectory of the Confessions/);
    expect(p.readingQuestion).toMatch(/\?$/);
  });

  it("strips bullet markers from Watch for / Key terms", () => {
    const p = parseBriefing(SAMPLE);
    expect(p.watchFor.every((b) => !b.startsWith("-"))).toBe(true);
  });

  it("tolerates labels that arrive with stray markdown (## WATCH FOR)", () => {
    const p = parseBriefing("## BEFORE YOU READ\nHi.\n\n**WATCH FOR**\n- one");
    expect(p.beforeYouRead).toBe("Hi.");
    expect(p.watchFor).toEqual(["one"]);
  });

  it("falls back to unstructured when no labels are present (partial stream)", () => {
    const p = parseBriefing("Augustine is asking whether");
    expect(p.unstructured).toBe(true);
    expect(p.beforeYouRead).toBe("Augustine is asking whether");
  });

  it("returns empty (not unstructured) for empty text", () => {
    const p = parseBriefing("   ");
    expect(p.unstructured).toBe(false);
    expect(p.beforeYouRead).toBe("");
  });
});

describe("section briefing cache", () => {
  it("round-trips by book|section|sha|mode and misses on any key change", () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", "BRIEF");
    expect(getCachedBriefing("bk", "s1", "sha1", "deep_study")).toBe("BRIEF");
    // A different section / sha / mode is a cache miss (re-prepare).
    expect(getCachedBriefing("bk", "s2", "sha1", "deep_study")).toBeNull();
    expect(getCachedBriefing("bk", "s1", "sha2", "deep_study")).toBeNull();
    expect(getCachedBriefing("bk", "s1", "sha1", "guided")).toBeNull();
  });

  it("clear removes a cached briefing (regenerate path)", () => {
    setCachedBriefing("bk", "s1", "sha1", "deep_study", "BRIEF");
    clearCachedBriefing("bk", "s1", "sha1", "deep_study");
    expect(getCachedBriefing("bk", "s1", "sha1", "deep_study")).toBeNull();
  });

  // COUNSEL POSTURE (CLAUDE.md §3, review P1-3 / CORE-1001): briefings are
  // "non-persistent unless saved". The cache may live only in process memory —
  // a round-trip must work within the session WITHOUT ever touching
  // localStorage, so nothing AI-derived survives an app restart unsaved.
  it("persists nothing to localStorage (session-only cache)", () => {
    setCachedBriefing("bk", "s9", "sha9", "deep_study", "TEXT");
    expect(getCachedBriefing("bk", "s9", "sha9", "deep_study")).toBe("TEXT");
    // The round-trip above must be served from process memory: scan ALL of
    // localStorage and assert no briefing key (legacy `rg.briefing.*` or any
    // future spelling) was written.
    const persisted: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.toLowerCase().includes("briefing")) persisted.push(k);
    }
    expect(persisted).toEqual([]);
  });

  it("purges legacy persisted briefings from older installs, leaving other keys", () => {
    localStorage.setItem("rg.briefing.bk|s1|sha1|deep_study", "OLD AI TEXT");
    localStorage.setItem("rg.briefing.bk2|s2|sha2|deep_study", "MORE OLD");
    localStorage.setItem("rg.fontSize", "18"); // unrelated reader prefs survive
    purgeLegacyBriefings();
    expect(localStorage.getItem("rg.briefing.bk|s1|sha1|deep_study")).toBeNull();
    expect(localStorage.getItem("rg.briefing.bk2|s2|sha2|deep_study")).toBeNull();
    expect(localStorage.getItem("rg.fontSize")).toBe("18");
  });
});

describe("briefingTextReady — Deep Study stale-text identity guard", () => {
  it("is true only when loaded text belongs to the current section and is non-empty", () => {
    expect(briefingTextReady("sB", "sB", "section B body")).toBe(true);
  });

  it("is FALSE when the loaded text still belongs to a previous section (the A→B race)", () => {
    // Navigated to B, but the in-state text is still section A's. This is the
    // exact stale-text leak the guard prevents.
    expect(briefingTextReady("sB", "sA", "section A body")).toBe(false);
  });

  it("is FALSE before this section's text has loaded (loadedSectionId null)", () => {
    expect(briefingTextReady("sB", null, "")).toBe(false);
    expect(briefingTextReady("sB", null, "stale leftover")).toBe(false);
  });

  it("is FALSE when there is no current section", () => {
    expect(briefingTextReady(null, "sB", "text")).toBe(false);
    expect(briefingTextReady(undefined, "sB", "text")).toBe(false);
  });

  it("is FALSE when matching section's text is empty or whitespace", () => {
    expect(briefingTextReady("sB", "sB", "")).toBe(false);
    expect(briefingTextReady("sB", "sB", "   \n ")).toBe(false);
    expect(briefingTextReady("sB", "sB", null)).toBe(false);
  });
});

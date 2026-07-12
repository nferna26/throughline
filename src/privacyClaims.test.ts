// R5: the APP's own reader-facing privacy sentences must disclose the
// title/author/chapter context wherever they make categorical claims about
// what is sent — matching the website's audited copy (privacyCopy.test.ts in
// throughline-site does the same for every public page).
import { describe, expect, it } from "vitest";
import frontDoorSource from "./screens/FrontDoor.tsx?raw";
import settingsSource from "./screens/Settings.tsx?raw";
import aiSetupSource from "./components/AiSetupSheet.tsx?raw";
import typesSource from "./types.ts?raw";
import tutorCardSource from "./components/MarginTutorCard.tsx?raw";
import briefingCardSource from "./components/SectionBriefingCard.tsx?raw";

describe("app privacy sentences disclose the context fields (R5)", () => {
  it.each([
    ["FrontDoor trust line", frontDoorSource],
    ["Settings privacy row", settingsSource],
    ["AiSetupSheet disclosures", aiSetupSource],
    ["consent-sheet fallback (tutor)", tutorCardSource],
    ["consent-sheet disclosure (Deep Study)", briefingCardSource],
  ])("%s names title/author/chapter", (_name, source) => {
    expect(source).toMatch(/title, author,\s+(?:.*\n?\s*)?and chapter/);
  });

  it("every AI_PROVIDERS cloud disclosure carries the context clause", () => {
    // Each remote provider's one-line disclosure (shown before any call and
    // inside the consent sheet) must include the context fields.
    const disclosures = [...typesSource.matchAll(/disclosure: "([^"]+)"/g)].map((m) => m[1]);
    expect(disclosures.length).toBeGreaterThanOrEqual(4);
    for (const d of disclosures) {
      if (/never the whole book/.test(d)) {
        expect(d, d).toMatch(/title, author, and chapter/);
      }
    }
  });

  it("the Settings AI-history summary discloses the context fields, not a bare 'single passage'", () => {
    expect(settingsSource).toContain(
      "Each was a single passage or section you chose, with the book's title, author, and chapter name for context",
    );
    expect(settingsSource).not.toContain(
      "Each was a single passage you selected — never a whole book",
    );
  });

  it("AiSetupSheet never claims passage-only sends anymore", () => {
    expect(aiSetupSource).not.toMatch(
      /sends only the passage or section you ask\s*\n?\s*about\.(?!.{0,120}title)/,
    );
  });
});

// ── R6-8: EVERY categorical send-sentence in the app's own string literals is
// scanned — not merely one accurate sentence per file. Mirrors the site's
// privacyCopy.test.ts scanner, over the reader-facing sources above. ──
describe("app-side sentence-level categorical send-claims (R6-8)", () => {
  /** Every string/template literal long enough to be reader copy. */
  function literalCopy(source: string): string[] {
    const out: string[] = [];
    const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(['"])/g, "$1").replace(/\s+/g, " ");
      if (s.length >= 40) out.push(s);
    }
    return out;
  }

  /** A categorical claim about what is SENT that names the passage/section
   *  must disclose title/author AND chapter within its own literal. */
  function misleadingClaims(source: string): string[] {
    const categorical = /\b(only|nothing|never|one thing|exactly one)\b/i;
    const sendVerb =
      /\b(leaves? (your|the|this) (mac|device|machine|computer)|ever leaves|is sent|are sent|sent (to|for)|sends?|goes to)\b/i;
    const subject = /\b(passage|section)\b/i;
    const out: string[] = [];
    for (const literal of literalCopy(source)) {
      const sentences = literal.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        if (!categorical.test(s) || !sendVerb.test(s) || !subject.test(s)) continue;
        const windowText = [sentences[i - 1] ?? "", s, sentences[i + 1] ?? ""].join(" ");
        if (!/title, author/i.test(windowText) || !/chapter/i.test(windowText)) out.push(s);
      }
    }
    return out;
  }

  it.each([
    ["FrontDoor", frontDoorSource],
    ["Settings", settingsSource],
    ["AiSetupSheet", aiSetupSource],
    ["types.ts", typesSource],
    ["MarginTutorCard", tutorCardSource],
    ["SectionBriefingCard", briefingCardSource],
  ])("%s has no categorical send-claim without the full context disclosure", (_name, source) => {
    expect(misleadingClaims(source)).toEqual([]);
  });

  it("the scanner catches an under-disclosing claim (self-test)", () => {
    expect(
      misleadingClaims('const x = "Only the passage you select is sent to the cloud provider.";'),
    ).toHaveLength(1);
    expect(
      misleadingClaims(
        "const x = \"Only the passage you select is sent, with the book's title, author, and chapter name for context.\";",
      ),
    ).toEqual([]);
  });
});

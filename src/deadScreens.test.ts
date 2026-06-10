import { describe, it, expect } from "vitest";

// CORE-1031 guardrail: AiPanel.tsx (Shot-4 era) and Onboarding.tsx (unrouted)
// were deleted as dead weight. This source scan pins the deletion — if either
// screen is re-introduced AND imported, the import shows up here first and the
// re-introduction gets a deliberate decision instead of a quiet revival.
//
// `import.meta.glob` (raw, eager) keeps this a frontend test — no node:fs —
// and Vite resolves the glob relative to this file, i.e. over all of src/.
const sources = import.meta.glob("./**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("dead screens stay dead (CORE-1031)", () => {
  it("no file under src/ imports screens/AiPanel or screens/Onboarding", () => {
    const banned = /screens\/(AiPanel|Onboarding)\b/;
    const offenders = Object.entries(sources)
      .filter(([path]) => !/\.test\./.test(path))
      .filter(([, code]) => banned.test(code))
      .map(([path]) => path);
    expect(offenders, `references to deleted screens in: ${offenders.join(", ")}`).toEqual([]);
  });
});

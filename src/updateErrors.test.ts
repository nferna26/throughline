import { describe, it, expect } from "vitest";
import { humanizeUpdateError } from "./updateErrors";

// FT-15 (CORE-1048): the updater's raw failures are plumbing — "Could not fetch
// a valid release JSON from the remote", or a reqwest "error sending request for
// url (https://github.com/…)". None of that may reach the reader: no "release
// JSON", "remote", "endpoint", or bare URL. Mirrors aiErrors.test.ts's
// banned-word posture.

// Anything that reads like plumbing must never appear in the humanized copy.
const PLUMBING = /json|remote|endpoint|url|http|api|fetch/i;

const RAW_CHECK_FAILURES = [
  "Could not fetch a valid release JSON from the remote",
  "error sending request for url (https://github.com/owner/repo/releases/latest)",
];

describe("humanizeUpdateError", () => {
  it("check-phase failures lose all plumbing words and guide the reader", () => {
    for (const raw of RAW_CHECK_FAILURES) {
      const msg = humanizeUpdateError(raw);
      expect(msg, `raw=${raw}`).not.toMatch(PLUMBING);
      expect(msg, `raw=${raw}`).toMatch(/internet/i);
      expect(msg, `raw=${raw}`).toMatch(/try again/i);
      // The raw plumbing string is never returned verbatim.
      expect(msg).not.toContain(raw);
    }
  });

  it("download-phase failures reassure that the current version keeps working", () => {
    const msg = humanizeUpdateError("connection reset by peer", "download");
    expect(msg).not.toMatch(PLUMBING);
    expect(msg).toMatch(/try again/i);
    expect(msg.toLowerCase()).toContain("current version");
  });

  it("never echoes the raw message — even an unrecognized one", () => {
    const raw = "totally unexpected https://github.com/x error";
    expect(humanizeUpdateError(raw)).not.toContain(raw);
    expect(humanizeUpdateError(raw)).not.toMatch(PLUMBING);
  });
});

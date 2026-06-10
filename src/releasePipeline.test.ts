import { describe, it, expect } from "vitest";
// CORE-1073 / FT-05: every shipped release stalled as an unpublished GitHub
// draft — the updater endpoint resolves /releases/latest, drafts don't count,
// and the manual "review the draft → Publish" step was skipped four releases
// in a row. The workflow must publish on tag; review happens before tagging.
// The workflow imported as raw text (?raw, the repo's source-scan idiom) —
// no node:fs, no live endpoints, fully hermetic.
import workflow from "../.github/workflows/release.yml?raw";

describe("release pipeline publishes on tag (CORE-1073)", () => {
  it("tauri-action publishes the release instead of leaving a draft", () => {
    expect(workflow).toContain("releaseDraft: false");
  });

  it("the draft switch never comes back", () => {
    expect(workflow).not.toMatch(/releaseDraft:\s*true/);
  });
});

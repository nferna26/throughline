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

  it("publishes download and updater artifacts to the R2 distribution bucket", () => {
    expect(workflow).toContain("R2_BUCKET: throughline-downloads");
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("r2 object put \"$R2_BUCKET/Throughline.dmg\"");
    expect(workflow).toContain("r2 object put \"$R2_BUCKET/updates/$UPDATE_FILENAME\"");
    expect(workflow).toContain("r2 object put \"$R2_BUCKET/updates/latest.json\"");
  });

  it("rewrites latest.json updater urls to readthroughline.com before upload", () => {
    expect(workflow).toContain("DISTRIBUTION_ORIGIN: https://readthroughline.com");
    expect(workflow).toContain("value.url = updateUrl");
    expect(workflow).toContain("Verify R2-hosted updater and download assets resolve");
  });
});

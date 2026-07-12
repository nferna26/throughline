import { describe, it, expect } from "vitest";
// CORE-1073 / FT-05 / REL-008: the release pipeline's invariants, pinned at the
// source level. The workflow imported as raw text (?raw, the repo's source-scan
// idiom) — no node:fs, no live endpoints, fully hermetic.
//
// History: every early release stalled as an unpublished GitHub draft
// (CORE-1073) — the fix keeps GitHub publication automatic. The public-beta
// audit (REL-008) then found the pipeline failed OPEN: a tag on any commit
// released; missing Apple secrets fell back to unsigned; stable R2 pointers
// were overwritten before any verification; actions floated on mutable tags.
// The workflow now fails CLOSED, and these tests keep it that way.
import workflow from "../.github/workflows/release.yml?raw";
import candidateWorkflow from "../.github/workflows/release-candidate.yml?raw";
import ci from "../.github/workflows/ci.yml?raw";
import stageRelease from "../scripts/stage-release.mjs?raw";

describe("release candidate workflow — verified artifact with no publication authority", () => {
  it("is manual-only and requires exact-SHA green CI on main", () => {
    expect(candidateWorkflow).toContain("workflow_dispatch:");
    expect(candidateWorkflow).not.toMatch(/^\s*push:/m);
    expect(candidateWorkflow).toContain('GITHUB_REF" != "refs/heads/main"');
    expect(candidateWorkflow).toContain("actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}");
    expect(candidateWorkflow).toMatch(/conclusion=="success"/);
  });

  it("has read-only permissions and no production publication path", () => {
    expect(candidateWorkflow).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
    expect(candidateWorkflow).not.toMatch(/contents:\s*write/);
    expect(candidateWorkflow).not.toMatch(/actions:\s*write/);
    expect(candidateWorkflow).not.toContain("secrets.CLOUDFLARE");
    expect(candidateWorkflow).not.toContain("scripts/stage-release.mjs");
    expect(candidateWorkflow).not.toContain("gh release create");
    expect(candidateWorkflow).not.toMatch(/^\s*(npx\s+)?wrangler\b/m);
  });

  it("applies the same signed/notarized/universal/minisign gates as a release", () => {
    for (const gate of [
      "codesign --verify --deep --strict",
      "Authority=Developer ID Application",
      "lipo -archs",
      "CFBundleShortVersionString",
      "stapler validate",
      "spctl --assess",
      "--example verify_minisign",
      "--local-payload",
    ]) {
      expect(candidateWorkflow, `${gate} must gate the candidate artifact`).toContain(gate);
    }
  });

  it("encrypts before upload and never uploads the plaintext candidate directory", () => {
    const encrypt = candidateWorkflow.indexOf("openssl cms -encrypt");
    const removePlaintext = candidateWorkflow.indexOf('rm -rf "$PLAIN" "$TAR"');
    const upload = candidateWorkflow.indexOf("actions/upload-artifact@");
    expect(encrypt).toBeGreaterThan(-1);
    expect(removePlaintext).toBeGreaterThan(encrypt);
    expect(upload).toBeGreaterThan(removePlaintext);
    expect(candidateWorkflow).toContain(".github/rc-artifact-encryption.crt");
    expect(candidateWorkflow.slice(upload)).not.toContain("candidate-output/private-artifact");
    expect(candidateWorkflow.slice(upload)).toContain("steps.encrypted.outputs.ciphertext");
    expect(candidateWorkflow.slice(upload)).toMatch(/retention-days:\s*1/);
  });
});

describe("release gate — nothing publishes without green CI on the exact tag SHA (REL-008)", () => {
  it("requires the tag commit to be an ancestor of main", () => {
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toMatch(/is NOT on main/);
  });

  it("requires a successful CI run for the exact commit before building", () => {
    expect(workflow).toContain("actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}");
    expect(workflow).toMatch(/conclusion=="success"/);
  });

  it("the publish job depends on the gate and runs in the protected release environment", () => {
    expect(workflow).toMatch(/needs:\s*gate/);
    expect(workflow).toMatch(/environment:\s*release/);
  });
});

describe("release secrets — missing signing/updater/R2 material fails BEFORE the build (REL-008)", () => {
  it("preflights every required secret and never falls back to unsigned", () => {
    for (const name of [
      "TAURI_SIGNING_PRIVATE_KEY",
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_SIGNING_IDENTITY",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]) {
      expect(workflow, `${name} must be preflighted`).toContain(name);
    }
    expect(workflow).toMatch(/NEVER falls back to unsigned/);
    // The old fail-open escape hatches must stay gone.
    expect(workflow).not.toMatch(/skipping .*notarization/i);
    expect(workflow).not.toMatch(/falls back to UNSIGNED/);
  });
});

describe("release workflow is EXECUTABLE — toolchain + path contracts (R4)", () => {
  it("the workflow's Node satisfies the LOCKED wrangler's engines requirement", async () => {
    const wranglerPkg = (await import("../node_modules/wrangler/package.json")) as {
      version: string;
      engines: { node: string };
    };
    const pkg = await import("../package.json");
    expect(wranglerPkg.version).toBe(pkg.devDependencies.wrangler);
    const required = Number(/>=\s*(\d+)/.exec(wranglerPkg.engines.node)?.[1]);
    expect(required).toBeGreaterThan(0);
    const workflowNode = Number(/node-version:\s*"?(\d+)/.exec(workflow)?.[1]);
    expect(
      workflowNode,
      `release workflow node-version ${workflowNode} must satisfy wrangler engines.node ${wranglerPkg.engines.node}`,
    ).toBeGreaterThanOrEqual(required);
  });

  it("preflights the deployed Worker's manifest-resolution capability BEFORE publishing", () => {
    const preflight = workflow.indexOf("x-tl-download-resolution");
    const publish = workflow.indexOf("node scripts/stage-release.mjs"); // the invocation, not the section comment
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(publish);
  });

  it("EVERY failure after the pointer may have moved flows into the recovery step — including publish-step failures before postverify (R5)", () => {
    // The publish step itself is continue-on-error so a failure after the
    // pointer PUT (or after promotion, before postverify starts) still
    // reaches the recovery step.
    expect(workflow).toMatch(/id: publish\s*\n[\s\S]{0,400}?continue-on-error: true/);
    expect(workflow).toMatch(/id: postverify\s*\n\s*if: steps\.publish\.outcome == 'success'\s*\n\s*continue-on-error: true/);
    expect(workflow).toContain(
      "if: always() && (steps.publish.outcome == 'failure' || steps.postverify.outcome == 'failure')",
    );
    // The publish step persists the pre-stage state + promotion-attempted marker.
    expect(workflow).toContain("--pre-stage-out r2-release/pre-stage.json");
  });

  it("the recovery NEVER blindly rolls back a failure proven to occur before promotion (R5)", () => {
    expect(workflow).toMatch(/promotionAttempted/);
    expect(workflow).toMatch(/provably BEFORE the pointer promotion[\s\S]*?NOT rolling back/);
    expect(workflow).toMatch(/before the pre-stage state was captured[\s\S]*?NOT rolling back/);
  });

  it("the recovery analyzes the live pointer (report-only without CAS) and verifies any safe state INCLUDING DMG BYTES", () => {
    expect(workflow).toContain("--restore-pointer r2-release/pre-stage.json");
    expect(workflow).toContain("--restore-report r2-release/restore-report.json");
    // R7-6: the wrangler store has no compare-and-swap — the recovery NEVER
    // auto-writes over a potentially concurrent release; a warranted restore
    // is reported for the operator.
    expect(workflow).toMatch(/no conditional write[\s\S]*?never auto-writes/);
    expect(workflow).toMatch(/NOT AUTO-RESTORED[\s\S]*?exit 1/);
    // The restored origin is verified against the restored version, with the
    // captured pre-stage DMG hash when one exists (pre-dmg rollbacks included).
    expect(workflow).toContain('--expected-version "v${RESTORED_VERSION}"');
    expect(workflow).toMatch(/PREV_DMG_SHA[\s\S]*?--dmg-sha256 \$PREV_DMG_SHA/);
    // Every recovery path ends the run red with the honest live state.
    expect(workflow).toMatch(/was not released\."\s*\n\s*exit 1/);
    // The GitHub release only exists when publish AND verification succeeded.
    expect(workflow).toContain("if: steps.publish.outcome == 'success' && steps.postverify.outcome == 'success'");
  });

  it("the Rust reference verifier runs from the REPO ROOT via --manifest-path (never cd src-tauri)", () => {
    // The artifact paths handed to the verifier are repo-root-relative
    // (src-tauri/target/…); a `cd src-tauri` would silently double the prefix.
    expect(workflow).toContain(
      "cargo run --locked --manifest-path src-tauri/Cargo.toml --example verify_minisign",
    );
    // No step actually EXECUTES a directory change into src-tauri (the string
    // may appear in comments explaining the ban).
    expect(workflow).not.toMatch(/^\s*\(?cd src-tauri/m);
    // And it reads the pubkey via the root-relative conf path.
    expect(workflow).toContain("--pubkey-from-tauri-conf src-tauri/tauri.conf.json");
  });
});

describe("artifact verification happens BEFORE any publication (REL-008)", () => {
  it("verifies codesign, Developer ID, hardened runtime, universal arch, exact version, stapling", () => {
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Authority=Developer ID Application");
    expect(workflow).toMatch(/flags=\.\*runtime/);
    expect(workflow).toContain("lipo -archs");
    expect(workflow).toContain("CFBundleShortVersionString");
    expect(workflow).toContain("stapler validate");
    expect(workflow).toContain("spctl --assess");
  });

  it("verifies the updater signature cryptographically on the built payload", () => {
    expect(workflow).toContain("--local-payload");
    expect(workflow).toContain("--pubkey-from-tauri-conf src-tauri/tauri.conf.json");
  });

  it("every verification step precedes the publication step and the GitHub release", () => {
    const firstPublish = workflow.indexOf("scripts/stage-release.mjs");
    expect(firstPublish).toBeGreaterThan(-1);
    for (const gate of [
      "codesign --verify --deep --strict",
      "--local-payload",
      "stapler validate",
    ]) {
      const at = workflow.indexOf(gate);
      expect(at, `${gate} must run before any publication`).toBeGreaterThan(-1);
      expect(at, `${gate} must run before any publication`).toBeLessThan(firstPublish);
    }
    const ghRelease = workflow.indexOf("gh release create");
    expect(ghRelease).toBeGreaterThan(firstPublish);
  });

  it("the gate proves the release environment's required reviewers from API metadata", () => {
    expect(workflow).toContain("environments/release");
    expect(workflow).toMatch(/required_reviewers/);
    const gateAt = workflow.indexOf("Require the protected release environment");
    const buildAt = workflow.indexOf("build-and-publish:");
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(buildAt);
  });

  it("generates the manifest deterministically instead of scraping a build side-effect", () => {
    expect(workflow).toContain("scripts/generate-latest-json.mjs");
    expect(workflow).toContain("--pub-date");
    expect(workflow).not.toMatch(/find .* -name latest\.json/);
  });

  it("verifies the public DMG by hash, not merely by resolving", () => {
    expect(workflow).toContain("--dmg-sha256");
  });
});

describe("staged, verified, atomic R2 publication with rollback (REL-008 — scripts/stage-release.mjs)", () => {
  // The staging ENGINE's behavior (rerun safety, mid-publication failure,
  // read-back, rollback) is exercised with an injected store in
  // src/stageRelease.test.ts. Here the SOURCE ordering + workflow wiring are
  // pinned so the shipped pipeline actually routes through that engine.
  it("the immutable tuple lands first; ONE mutable pointer (the manifest) promotes it atomically", () => {
    expect(stageRelease).toContain("contentAddressedKey");
    const versioned = stageRelease.indexOf("stage 1: the complete immutable tuple");
    const rollback = stageRelease.indexOf("stage 2: retain the previous manifest");
    const pointer = stageRelease.indexOf("stage 3: THE atomic promotion");
    expect(versioned).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(versioned);
    expect(pointer).toBeGreaterThan(rollback);
    // The manifest names the dmg; there is NO separate mutable DMG pointer.
    expect(stageRelease).toContain("final.dmg = {");
    expect(stageRelease).not.toMatch(/putPointer\(store, "Throughline\.dmg"/);
  });

  it("guards against downgrades and serializes runs", () => {
    expect(stageRelease).toContain("DOWNGRADE REFUSED");
    expect(workflow).toMatch(/concurrency:\s+group: release-publish/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
  });

  it("release tooling is the LOCKED local executable, never npx --yes", () => {
    expect(stageRelease).toContain("lockedWranglerBin");
    // Ban npx as an INVOKED command (quoted string / shell line), not the word
    // in comments explaining the ban.
    expect(stageRelease).not.toMatch(/["'`]npx["'`]/);
    expect(workflow).not.toMatch(/^\s*npx\b/m); // no step line INVOKES npx
    expect(workflow).not.toMatch(/\bnpx wrangler\b/);
  });

  it("the workflow runs the Rust reference verifier AND the JS cross-check before publishing", () => {
    const rustVerify = workflow.indexOf("--example verify_minisign");
    const jsVerify = workflow.indexOf("--local-payload");
    const publish = workflow.indexOf("scripts/stage-release.mjs");
    expect(rustVerify).toBeGreaterThan(-1);
    expect(jsVerify).toBeGreaterThan(-1);
    expect(rustVerify).toBeLessThan(publish);
    expect(jsVerify).toBeLessThan(publish);
  });

  it("read-back-verifies every uploaded object and refuses immutability violations", () => {
    expect(stageRelease).toContain("read-back mismatch");
    expect(stageRelease).toContain("IMMUTABILITY VIOLATION");
  });

  it("retains the previous manifest as updates/rollback.json before switching", () => {
    expect(stageRelease).toContain('"updates/rollback.json"');
  });

  it("the workflow publishes through the staging engine", () => {
    expect(workflow).toContain("node scripts/stage-release.mjs");
  });

  it("re-verifies the public origin (with the cryptographic signature) after the switch", () => {
    const publicVerify = workflow.indexOf("Verify public origin serves the verified release");
    const stage = workflow.indexOf("node scripts/stage-release.mjs");
    expect(publicVerify).toBeGreaterThan(stage);
    expect(workflow.slice(publicVerify)).toContain("--pubkey-from-tauri-conf");
  });
});

describe("release pipeline publishes on tag — GitHub release last, never a draft (CORE-1073)", () => {
  it("creates the GitHub release only after every gate, published on creation", () => {
    expect(workflow).toContain("gh release create");
    expect(workflow).not.toContain("--draft");
    expect(workflow).toContain("--verify-tag");
  });

  it("the draft switch never comes back", () => {
    expect(workflow).not.toMatch(/releaseDraft:\s*true/);
    expect(workflow).not.toMatch(/--draft\b/);
  });

  it("publishes download and updater artifacts to the R2 distribution bucket", () => {
    expect(workflow).toContain("R2_BUCKET: throughline-downloads");
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(stageRelease).toContain('"updates/latest.json"');
  });

  it("the staging engine is the single writer of manifest urls, pointed at the distribution origin", () => {
    expect(workflow).toContain("DISTRIBUTION_ORIGIN: https://readthroughline.com");
    expect(stageRelease).toContain("value.url = updateUrl");
    expect(workflow).toContain("Verify public origin serves the verified release");
  });
});

describe("supply chain — actions and tooling pinned to immutable revisions (REL-008)", () => {
  const shaPin = /uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}/;

  it("every third-party action in release.yml is pinned to a full commit SHA", () => {
    const uses = workflow.match(/uses:\s+\S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, `${line} must be pinned to a 40-char commit SHA`).toMatch(shaPin);
    }
  });

  it("every third-party action in ci.yml is pinned to a full commit SHA", () => {
    const uses = ci.match(/uses:\s+\S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, `${line} must be pinned to a 40-char commit SHA`).toMatch(shaPin);
    }
  });

  it("every third-party action in release-candidate.yml is pinned to a full commit SHA", () => {
    const uses = candidateWorkflow.match(/uses:\s+\S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, `${line} must be pinned to a 40-char commit SHA`).toMatch(shaPin);
    }
  });

  it("wrangler is pinned exactly in package.json (locked via npm ci)", async () => {
    const pkg = await import("../package.json");
    expect(pkg.devDependencies.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

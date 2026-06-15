import { describe, expect, it } from "vitest";
// @ts-expect-error The release verifier is a Node CLI script with named testable exports.
import { parseArgs, verifyReleaseAssets } from "../scripts/verify-release-assets.mjs";

const repo = "owner/repo";
const manifestUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
const payloadUrl = `https://github.com/${repo}/releases/download/v1.2.3/Throughline_universal.app.tar.gz`;
const sigUrl = `${payloadUrl}.sig`;
const dmgUrl = `https://github.com/${repo}/releases/download/v1.2.3/Throughline_1.2.3_universal.dmg`;

function response(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function fetchFrom(fixtures: Record<string, string | number>, seen: string[] = []) {
  return async (url: string | URL) => {
    seen.push(String(url));
    const hit = fixtures[String(url)];
    if (!hit) return response("not found", 404);
    return typeof hit === "number" ? response("", hit) : response(hit);
  };
}

function manifest(signature = "sig-text") {
  return JSON.stringify({
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": { signature, url: payloadUrl },
      "darwin-x86_64": { signature, url: payloadUrl },
      linux: { signature: "ignored", url: "https://example.test/linux.tar.gz" },
    },
  });
}

describe("verifyReleaseAssets", () => {
  it("verifies latest.json, darwin updater payload/signature, and the universal dmg", async () => {
    const seen: string[] = [];
    const logs: string[] = [];

    const result = await verifyReleaseAssets({
      repo,
      expectedVersion: "v1.2.3",
      fetchImpl: fetchFrom(
        {
          [manifestUrl]: manifest(),
          [payloadUrl]: "app bytes",
          [sigUrl]: "sig-text",
          [dmgUrl]: "dmg bytes",
        },
        seen,
      ),
      log: (line: string) => logs.push(line),
    });

    expect(result).toMatchObject({
      repo,
      version: "1.2.3",
      platformCount: 2,
      payloadCount: 1,
      signatureCount: 1,
      dmgUrl,
    });
    expect(seen).toEqual([manifestUrl, payloadUrl, sigUrl, dmgUrl]);
    expect(logs.join("\n")).toContain("signature matches .sig asset");
  });

  it("fails when latest.json does not resolve", async () => {
    await expect(
      verifyReleaseAssets({
        repo,
        fetchImpl: fetchFrom({ [manifestUrl]: 404 }),
        log: () => {},
      }),
    ).rejects.toThrow("latest.json did not resolve (404)");
  });

  it("fails when latest.json and the .sig asset disagree", async () => {
    await expect(
      verifyReleaseAssets({
        repo,
        fetchImpl: fetchFrom({
          [manifestUrl]: manifest("manifest-sig"),
          [payloadUrl]: "app bytes",
          [sigUrl]: "asset-sig",
        }),
        log: () => {},
      }),
    ).rejects.toThrow("signature in latest.json does not match");
  });
});

describe("parseArgs", () => {
  it("accepts repo, tag, and expected-version options", () => {
    expect(parseArgs(["--repo", "a/b", "--tag", "v1.2.3", "--expected-version", "1.2.3"])).toEqual({
      repo: "a/b",
      tag: "v1.2.3",
      expectedVersion: "1.2.3",
    });
  });
});

import { describe, expect, it } from "vitest";
// @ts-expect-error The release verifier is a Node CLI script with named testable exports.
import { parseArgs, verifyReleaseAssets } from "../scripts/verify-release-assets.mjs";

const origin = "https://readthroughline.com";
const manifestUrl = `${origin}/updates/latest.json`;
const payloadUrl = `${origin}/updates/Throughline.app.tar.gz`;
const sigUrl = `${payloadUrl}.sig`;
const dmgUrl = `${origin}/download`;

function response(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

type FixtureValue = string | number | Error;
type FixtureMap = Record<string, FixtureValue | FixtureValue[]>;

function fetchFrom(fixtures: FixtureMap, seen: string[] = []) {
  const calls = new Map<string, number>();

  return async (url: string | URL) => {
    const key = String(url);
    seen.push(key);
    if (!Object.prototype.hasOwnProperty.call(fixtures, key)) return response("not found", 404);

    const hit = fixtures[key];
    const values = Array.isArray(hit) ? hit : [hit];
    const index = calls.get(key) ?? 0;
    calls.set(key, index + 1);

    const value = values[Math.min(index, values.length - 1)];
    if (value instanceof Error) throw value;
    return typeof value === "number" ? response("", value) : response(value);
  };
}

function manifest(signature = "sig-text", url = payloadUrl) {
  return JSON.stringify({
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": { signature, url },
      "darwin-x86_64": { signature, url },
      linux: { signature: "ignored", url: "https://example.test/linux.tar.gz" },
    },
  });
}

describe("verifyReleaseAssets", () => {
  it("verifies R2 latest.json, darwin updater payload/signature, and the public dmg", async () => {
    const seen: string[] = [];
    const logs: string[] = [];

    const result = await verifyReleaseAssets({
      origin,
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
      retry: { attempts: 1, delayMs: 0 },
    });

    expect(result).toMatchObject({
      origin,
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
        origin,
        fetchImpl: fetchFrom({ [manifestUrl]: 404 }),
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow("latest.json did not resolve (404)");
  });

  it("retries transient site propagation failures before succeeding", async () => {
    const seen: string[] = [];
    const logs: string[] = [];

    const result = await verifyReleaseAssets({
      origin,
      fetchImpl: fetchFrom(
        {
          [manifestUrl]: [404, new Error("cdn reset"), manifest()],
          [payloadUrl]: [404, "app bytes"],
          [sigUrl]: "sig-text",
          [dmgUrl]: [503, "dmg bytes"],
        },
        seen,
      ),
      log: (line: string) => logs.push(line),
      retry: { attempts: 3, delayMs: 0 },
    });

    expect(result).toMatchObject({ origin, version: "1.2.3", dmgUrl });
    expect(seen.filter((url) => url === manifestUrl)).toHaveLength(3);
    expect(seen.filter((url) => url === payloadUrl)).toHaveLength(2);
    expect(seen.filter((url) => url === sigUrl)).toHaveLength(1);
    expect(seen.filter((url) => url === dmgUrl)).toHaveLength(2);
    expect(logs.join("\n")).toContain("retry 2/3");
    expect(logs.join("\n")).toContain("retry 3/3");
    expect(logs.join("\n")).toContain("network error: cdn reset");
  });

  it("stops retrying after the configured attempt limit", async () => {
    const seen: string[] = [];
    const logs: string[] = [];

    await expect(
      verifyReleaseAssets({
        origin,
        fetchImpl: fetchFrom({ [manifestUrl]: 404 }, seen),
        log: (line: string) => logs.push(line),
        retry: { attempts: 2, delayMs: 0 },
      }),
    ).rejects.toThrow("latest.json did not resolve (404)");

    expect(seen).toEqual([manifestUrl, manifestUrl]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("retry 2/2");
  });

  it("fails when latest.json still points updater payloads at GitHub", async () => {
    await expect(
      verifyReleaseAssets({
        origin,
        fetchImpl: fetchFrom({
          [manifestUrl]: manifest(
            "sig-text",
            "https://github.com/nferna26/throughline/releases/download/v1.2.3/Throughline.app.tar.gz",
          ),
        }),
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow("updater payload must use https://readthroughline.com/updates/");
  });

  it("fails when latest.json and the .sig asset disagree", async () => {
    await expect(
      verifyReleaseAssets({
        origin,
        fetchImpl: fetchFrom({
          [manifestUrl]: manifest("manifest-sig"),
          [payloadUrl]: "app bytes",
          [sigUrl]: "asset-sig",
        }),
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow("signature in latest.json does not match");
  });
});

describe("parseArgs", () => {
  it("accepts origin and expected-version options", () => {
    expect(parseArgs(["--origin", "https://example.com/", "--expected-version", "1.2.3"])).toEqual({
      origin: "https://example.com",
      expectedVersion: "1.2.3",
    });
  });
});

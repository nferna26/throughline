import { describe, expect, it } from "vitest";
// @ts-expect-error The release verifier is a Node CLI script with named testable exports.
import { parseArgs, verifyReleaseAssets } from "../scripts/verify-release-assets.mjs";
// The frontend tsconfig carries no node types; these fixtures are Node-only
// (vitest runs them in Node regardless). Declare the one global we use.
declare const Buffer: { from(v: unknown, enc?: string): any; concat(list: unknown[]): any };
type Buffer = any;
// @ts-expect-error node builtin — no node types in the frontend tsconfig (same idiom as the .mjs import above).
import { generateKeyPairSync, createHash, sign as edSign } from "node:crypto";
// @ts-expect-error node builtin (see above).
import { mkdtempSync, writeFileSync } from "node:fs";
// @ts-expect-error node builtin (see above).
import { tmpdir } from "node:os";
// @ts-expect-error node builtin (see above).
import { join } from "node:path";

const origin = "https://readthroughline.com";
const manifestUrl = `${origin}/updates/latest.json`;
// R9-5: the contract ties every updater URL to the manifest version + a
// content-hash segment, and the verifier re-derives that segment from the
// SERVED bytes — fixture URLs are therefore computed from their bodies.
const shaOf12 = (body: string) =>
  createHash("sha256").update(Buffer.from(body)).digest("hex").slice(0, 12);
const tiedPayloadUrl = (body: string, version = "1.2.3") =>
  `${origin}/updates/Throughline-${version}-${shaOf12(body)}.app.tar.gz`;
const PAYLOAD_BODY = "app bytes";
const payloadUrl = tiedPayloadUrl(PAYLOAD_BODY);
const sigUrl = `${payloadUrl}.sig`;
const dmgUrl = `${origin}/download`;

/** R9-5: a STRUCTURALLY valid minisign signature document (4 lines, 74-byte
 *  Ed box, trusted comment, 64-byte global signature), base64-wrapped the way
 *  the updater consumes it. Deterministic per seed; cryptographically
 *  meaningless (the real-crypto fixtures below stay authoritative). */
function sigDocB64(seed: string): string {
  const box = Buffer.concat([
    Buffer.from("Ed"),
    createHash("sha256").update(`${seed}:keyid`).digest().subarray(0, 8),
    createHash("sha512").update(`${seed}:sig`).digest(),
  ]);
  const globalSig = createHash("sha512").update(`${seed}:global`).digest();
  const doc = [
    "untrusted comment: signature from tauri secret key",
    box.toString("base64"),
    "trusted comment: timestamp:1751980800\tfile:payload.app.tar.gz",
    globalSig.toString("base64"),
    "",
  ].join("\n");
  return Buffer.from(doc).toString("base64");
}
const SIG_DOC = sigDocB64("primary");

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

function manifest(signature = SIG_DOC, url = payloadUrl) {
  return JSON.stringify({
    version: "1.2.3",
    platforms: {
      "darwin-aarch64": { signature, url },
      "darwin-x86_64": { signature, url },
      // (R8-5: a non-darwin key is now refused by the CONTRACT — the old
      // "linux entries are ignored" behavior is superseded by refusal.)
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
          [payloadUrl]: PAYLOAD_BODY,
          [sigUrl]: SIG_DOC,
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
          [payloadUrl]: [404, PAYLOAD_BODY],
          [sigUrl]: SIG_DOC,
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
            SIG_DOC,
            "https://github.com/nferna26/throughline/releases/download/v1.2.3/Throughline.app.tar.gz",
          ),
        }),
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow(/not on the distribution origin/);
  });

  it("fails when latest.json and the .sig asset disagree", async () => {
    await expect(
      verifyReleaseAssets({
        origin,
        fetchImpl: fetchFrom({
          [manifestUrl]: manifest(sigDocB64("manifest-side")),
          [payloadUrl]: PAYLOAD_BODY,
          [sigUrl]: sigDocB64("asset-side"),
        }),
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow("signature in latest.json does not match");
  });
});

describe("R5: /download bytes are verified against the manifest's OWN dmg.sha256 (rollback proof, not HTTP 200)", () => {
  function shaOf(s: string) {
    return createHash("sha256").update(Buffer.from(s)).digest("hex");
  }
  function manifestWithDmg(dmgSha: unknown) {
    // R7-7: the dmg key is TIED to the manifest version + hash by contract.
    const tied = `updates/Throughline-1.2.3-${String(dmgSha).slice(0, 12)}.dmg`;
    return JSON.stringify({
      version: "1.2.3",
      platforms: { "darwin-aarch64": { signature: SIG_DOC, url: payloadUrl } },
      dmg: { url: `${origin}/${tied}`, key: tied, sha256: dmgSha },
    });
  }
  const baseFixtures = { [payloadUrl]: PAYLOAD_BODY, [sigUrl]: SIG_DOC };

  it("FAILS when the served DMG bytes mismatch dmg.sha256 — with NO --dmg-sha256 flag (the wrong-rollback-bytes case)", async () => {
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        fetchImpl: fetchFrom({
          ...baseFixtures,
          [manifestUrl]: manifestWithDmg(shaOf("the dmg the manifest names")),
          [dmgUrl]: "some OTHER dmg the origin actually serves",
        }),
      }),
    ).rejects.toThrow(/public DMG hash mismatch vs latest\.json dmg\.sha256/);
  });

  it("passes when the served bytes match the manifest's dmg.sha256", async () => {
    const dmgBytes = "the exact dmg bytes";
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        fetchImpl: fetchFrom({
          ...baseFixtures,
          [manifestUrl]: manifestWithDmg(shaOf(dmgBytes)),
          [dmgUrl]: dmgBytes,
        }),
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
  });

  it("rejects a MALFORMED dmg.sha256 instead of skipping the byte check", async () => {
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        fetchImpl: fetchFrom({
          ...baseFixtures,
          [manifestUrl]: manifestWithDmg("not-a-hash"),
          [dmgUrl]: "whatever",
        }),
      }),
    ).rejects.toThrow(/dmg\.sha256 is not a 64-hex hash/);
  });

  it("rejects a dmg block with NO sha256 at all — never mislabels it pre-dmg (R6-7)", async () => {
    // The gap the review flagged: a PRESENT dmg block whose sha256 is missing
    // used to fall through to the "pre-dmg manifest" log line — a broken
    // dmg-bearing release passing as a legacy one, with zero byte checks.
    const manifest = JSON.parse(manifestWithDmg("ab".repeat(32)));
    delete manifest.dmg.sha256;
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        fetchImpl: fetchFrom({
          ...baseFixtures,
          [manifestUrl]: JSON.stringify(manifest),
          [dmgUrl]: "whatever",
        }),
      }),
    ).rejects.toThrow(/dmg\.sha256 is not a 64-hex hash/);
  });

  // ── R7-7: the shared adversarial contract matrix (same labels as
  // stageRelease.test.ts and the Worker's download.test.ts) — every refusal
  // happens BEFORE any artifact (payload, sig, or the named DMG) is fetched ──
  it.each([
    ["whitespace version", (m: Record<string, any>) => { m.version = " 1.2.3"; }, /no canonical x\.y\.z version/],
    ["dmg: null (legacy means the property is ABSENT)", (m: Record<string, any>) => { m.dmg = null; }, /legacy means the property is ABSENT/],
    ["a dmg key not tied to this version+hash", (m: Record<string, any>) => { m.dmg.key = "updates/Throughline-9.9.9-abababababab.dmg"; }, /not the content-addressed key/],
    ["an out-of-prefix dmg key", (m: Record<string, any>) => { m.dmg.key = "secrets/steal.dmg"; }, /not the content-addressed key/],
    ["a malformed dmg url", (m: Record<string, any>) => { m.dmg.url = "not a url"; }, /dmg url is not a valid URL/],
    ["Linux-only platforms (no darwin entry)", (m: Record<string, any>) => { m.platforms = { "linux-x86_64": { url: "https://x/u", signature: "S" } }; }, /no darwin platform entry/],
    ["a platform entry with an empty url", (m: Record<string, any>) => { m.platforms["darwin-aarch64"].url = ""; }, /url is missing or empty/],
    ["a platform url with surrounding whitespace", (m: Record<string, any>) => { m.platforms["darwin-aarch64"].url = ` ${m.platforms["darwin-aarch64"].url} `; }, /has surrounding whitespace/],
    ["a platform entry with no signature", (m: Record<string, any>) => { delete m.platforms["darwin-aarch64"].signature; }, /signature is missing or empty/],
    ["platform entries with DIFFERENT signatures (R10-3)", (m: Record<string, any>) => { m.platforms["darwin-x86_64"] = { ...m.platforms["darwin-aarch64"], signature: sigDocB64("a-different-doc") }; }, /signature differs from the other entries/],
  ])("contract matrix: %s is refused BEFORE any artifact fetch (R7-7)", async (_label, mutate, msg) => {
    const manifest = JSON.parse(manifestWithDmg("ab".repeat(32)));
    mutate(manifest);
    const fetched: string[] = [];
    const inner = fetchFrom({ ...baseFixtures, [manifestUrl]: JSON.stringify(manifest), [dmgUrl]: "whatever" });
    const spying = (url: string) => {
      fetched.push(url);
      return inner(url);
    };
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        fetchImpl: spying,
      }),
    ).rejects.toThrow(msg);
    expect(fetched, "only the manifest itself was fetched").toEqual([manifestUrl]);
  });

  it("enforces BOTH pins when --dmg-sha256 is also given (pre-dmg rollback anchor)", async () => {
    const dmgBytes = "legacy dmg bytes";
    // Manifest hash matches, caller pin does not → still a failure.
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        dmgSha256: shaOf("a different artifact"),
        fetchImpl: fetchFrom({
          ...baseFixtures,
          [manifestUrl]: manifestWithDmg(shaOf(dmgBytes)),
          [dmgUrl]: dmgBytes,
        }),
      }),
    ).rejects.toThrow(/public DMG hash mismatch vs --dmg-sha256/);
    // A pre-dmg (legacy) manifest with only the captured caller pin: enforced.
    await expect(
      verifyReleaseAssets({
        origin,
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
        dmgSha256: shaOf(dmgBytes),
        fetchImpl: fetchFrom({
          ...baseFixtures,
          [manifestUrl]: manifest(),
          [dmgUrl]: "the WRONG legacy dmg",
        }),
      }),
    ).rejects.toThrow(/public DMG hash mismatch vs --dmg-sha256/);
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

// ── REL-008: cryptographic minisign verification ──
// A synthetic Ed25519 key pair, minisign-framed exactly the way Tauri frames
// its updater keys (base64 of the two-line minisign document), proves the
// verifier accepts a genuine signature and rejects a tampered payload.
// @ts-expect-error same Node CLI module, named testable exports.
import { verifyMinisign, verifyLocalArtifacts } from "../scripts/verify-release-assets.mjs";

function minisignFixture(payload: Buffer, options: { keyId?: Buffer; trustedComment?: string } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const keyId = options.keyId ?? Buffer.from("0102030405060708", "hex");
  const pubBox = Buffer.concat([Buffer.from("Ed"), keyId, rawPub]);
  const pubDoc = `untrusted comment: minisign public key\n${pubBox.toString("base64")}\n`;
  // Tauri stores the pubkey as base64 of the WHOLE document.
  const publicKeyText = Buffer.from(pubDoc).toString("base64");

  // "ED" = Ed25519 over Blake2b-512(payload) — what Tauri/rsign2 emit — plus
  // the REAL minisign GLOBAL signature: Ed25519 over sig64 ‖ trusted-comment
  // text (exactly what minisign-verify checks; a fake fourth line must fail).
  const digest = createHash("blake2b512").update(payload).digest();
  const sig = edSign(null, digest, privateKey);
  const sigBox = Buffer.concat([Buffer.from("ED"), keyId, sig]);
  const trustedComment = options.trustedComment ?? "timestamp:1234\tfile:test.tar.gz";
  const globalSig = edSign(null, Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]), privateKey);
  const sigDoc = `untrusted comment: signature from tauri secret key\n${sigBox.toString("base64")}\ntrusted comment: ${trustedComment}\n${globalSig.toString("base64")}\n`;
  const signatureText = Buffer.from(sigDoc).toString("base64");
  return { publicKeyText, signatureText, sigDoc, keyId };
}

/** Mutate one line of a (base64-wrapped) minisign signature document. */
function mutateSigDoc(signatureText: string, fn: (lines: string[]) => string[] | null) {
  const doc = Buffer.from(signatureText, "base64").toString("utf8");
  const lines = fn(doc.split("\n").filter((l: string, i: number, a: string[]) => !(l === "" && i === a.length - 1)));
  if (lines == null) return Buffer.from("", "base64").toString("base64");
  return Buffer.from(lines.join("\n") + "\n").toString("base64");
}

describe("verifyMinisign (REL-008 — exact minisign-verify 0.2.5 / tauri-plugin-updater 2.10.1 semantics)", () => {
  const payload = Buffer.from("the exact updater payload bytes");

  it("accepts a genuine four-line signature (primary + global) over the exact payload bytes", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    expect(verifyMinisign({ payload, signatureText, publicKeyText })).toBe(true);
  });

  // The crate's canonical vector, framed EXACTLY as the updater consumes it:
  // base64 of the 2-line key document and base64 of the 4-line signature
  // document (tauri-plugin-updater base64_to_string → ::decode).
  const VECTOR_PUB_DOC = "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
  const VECTOR_SIG_DOC =
    "untrusted comment: signature from minisign secret key\n" +
    "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n" +
    "trusted comment: timestamp:1633700835\tfile:test\tprehashed\n" +
    "wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n";

  it("accepts the minisign-verify crate's own canonical test vector (cross-implementation check)", () => {
    // The exact fixture minisign-verify 0.2.5 documents and tests — verifying
    // it here proves the JS semantics match the Rust reference verifier the
    // shipped updater uses.
    const publicKeyText = Buffer.from(VECTOR_PUB_DOC).toString("base64");
    const signatureText = Buffer.from(VECTOR_SIG_DOC).toString("base64");
    expect(
      verifyMinisign({ payload: Buffer.from("test"), signatureText, publicKeyText }),
    ).toBe(true);
    // And a changed trusted comment breaks its GLOBAL signature.
    const tampered = Buffer.from(VECTOR_SIG_DOC.replace("file:test", "file:evil")).toString("base64");
    expect(() =>
      verifyMinisign({ payload: Buffer.from("test"), signatureText: tampered, publicKeyText }),
    ).toThrow(/GLOBAL signature/);
  });

  // ── R4: the updater's OUTER encoding, exactly ──

  it("rejects a RAW signature document — the updater expects base64 of the document", () => {
    const publicKeyText = Buffer.from(VECTOR_PUB_DOC).toString("base64");
    expect(() =>
      verifyMinisign({ payload: Buffer.from("test"), signatureText: VECTOR_SIG_DOC, publicKeyText }),
    ).toThrow(/RAW minisign document/);
  });

  it("rejects a RAW public-key document and a bare key box — updater framing only", () => {
    const signatureText = Buffer.from(VECTOR_SIG_DOC).toString("base64");
    expect(() =>
      verifyMinisign({ payload: Buffer.from("test"), signatureText, publicKeyText: VECTOR_PUB_DOC }),
    ).toThrow(/RAW minisign document/);
    expect(() =>
      verifyMinisign({
        payload: Buffer.from("test"),
        signatureText,
        // The bare 42-byte box (PublicKey::from_base64 form) is NOT what the
        // updater consumes from tauri.conf.json.
        publicKeyText: "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
      }),
    ).toThrow(/not a minisign document/);
  });

  it("the review regression: a `!` inserted into an otherwise-valid global-signature line must fail", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const mutated = mutateSigDoc(signatureText, (lines) => [
      lines[0],
      lines[1],
      lines[2],
      // Node's permissive Buffer.from would SKIP the `!` and decode the rest —
      // the shipped updater's strict decoder rejects the line outright.
      lines[3].slice(0, 10) + "!" + lines[3].slice(10),
    ]);
    expect(() => verifyMinisign({ payload, signatureText: mutated, publicKeyText })).toThrow(
      /not canonical base64/,
    );
  });

  it("rejects invalid characters, bad padding, and noncanonical base64 in the outer wrapping", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    // Invalid character in the outer base64.
    expect(() =>
      verifyMinisign({ payload, signatureText: "!" + signatureText.slice(1), publicKeyText }),
    ).toThrow(/not canonical base64/);
    // Broken padding (length no longer a multiple of 4).
    expect(() =>
      verifyMinisign({ payload, signatureText: signatureText + "=", publicKeyText }),
    ).toThrow(/not canonical base64/);
    // Noncanonical trailing bits: valid charset + padding, different decode.
    const noncanonical = "MR=="; // decodes like "MQ==" under permissive rules
    expect(() =>
      verifyMinisign({ payload, signatureText: noncanonical, publicKeyText }),
    ).toThrow(/not canonical base64/);
  });

  it("rejects a tampered payload", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    expect(() =>
      verifyMinisign({ payload: Buffer.from("tampered bytes"), signatureText, publicKeyText }),
    ).toThrow(/did not verify/);
  });

  it("rejects a signature from a different key (wrong key id or wrong key)", () => {
    const { signatureText } = minisignFixture(payload);
    const { publicKeyText: otherKey } = minisignFixture(payload, {
      keyId: Buffer.from("f1f2f3f4f5f6f7f8", "hex"),
    });
    expect(() => verifyMinisign({ payload, signatureText, publicKeyText: otherKey })).toThrow(
      /key id/,
    );
    // Same key id but a different Ed25519 key: primary signature fails.
    const { publicKeyText: sameIdOtherKey } = minisignFixture(payload);
    expect(() =>
      verifyMinisign({ payload, signatureText, publicKeyText: sameIdOtherKey }),
    ).toThrow(/did not verify/);
  });

  it("rejects a MISSING fourth line (no global signature)", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const mutated = mutateSigDoc(signatureText, (lines) => lines.slice(0, 3));
    expect(() => verifyMinisign({ payload, signatureText: mutated, publicKeyText })).toThrow(
      /4 lines|not a minisign document/,
    );
  });

  it("rejects a MALFORMED fourth line (wrong-length global signature)", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const mutated = mutateSigDoc(signatureText, (lines) => [
      ...lines.slice(0, 3),
      Buffer.from("short").toString("base64"),
    ]);
    expect(() => verifyMinisign({ payload, signatureText: mutated, publicKeyText })).toThrow(
      /64-byte global signature/,
    );
  });

  it("rejects a CHANGED trusted comment (the global signature covers it)", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const mutated = mutateSigDoc(signatureText, (lines) => [
      lines[0],
      lines[1],
      "trusted comment: timestamp:9999\tfile:evil.tar.gz",
      lines[3],
    ]);
    expect(() => verifyMinisign({ payload, signatureText: mutated, publicKeyText })).toThrow(
      /GLOBAL signature/,
    );
  });

  it("rejects a trusted-comment line without the required prefix", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const mutated = mutateSigDoc(signatureText, (lines) => [
      lines[0],
      lines[1],
      "totally not the right line",
      lines[3],
    ]);
    expect(() => verifyMinisign({ payload, signatureText: mutated, publicKeyText })).toThrow(
      /trusted comment/,
    );
  });

  it("rejects a DAMAGED primary signature", () => {
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const mutated = mutateSigDoc(signatureText, (lines) => {
      const box = Buffer.from(lines[1], "base64");
      box[20] ^= 0xff; // flip a byte inside the 64-byte signature
      return [lines[0], box.toString("base64"), lines[2], lines[3]];
    });
    expect(() => verifyMinisign({ payload, signatureText: mutated, publicKeyText })).toThrow(
      /did not verify/,
    );
  });
});

describe("verifyLocalArtifacts (the pre-publication gate)", () => {
  function localFixture(tamper: "none" | "payload" | "manifest-sig" = "none") {
    const dir = mkdtempSync(join(tmpdir(), "tl-verify-local-"));
    const payload = Buffer.from("built .app.tar.gz bytes");
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const payloadPath = join(dir, "Throughline.app.tar.gz");
    writeFileSync(payloadPath, tamper === "payload" ? Buffer.from("evil bytes") : payload);
    const sigPath = join(dir, "Throughline.app.tar.gz.sig");
    writeFileSync(sigPath, signatureText);
    const manifestPath = join(dir, "latest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: "1.2.3",
        platforms: {
          "darwin-aarch64": {
            signature: tamper === "manifest-sig" ? "someone-else" : signatureText,
            url: "https://readthroughline.com/updates/Throughline-1.2.3.app.tar.gz",
          },
        },
      }),
    );
    return { payloadPath, sigPath, manifestPath, publicKeyText };
  }

  it("passes a coherent built artifact set and enforces the expected version", () => {
    const f = localFixture();
    const result = verifyLocalArtifacts({
      localPayload: f.payloadPath,
      localSig: f.sigPath,
      localManifest: f.manifestPath,
      publicKeyText: f.publicKeyText,
      expectedVersion: "v1.2.3",
      log: () => {},
    });
    expect(result.version).toBe("1.2.3");
    expect(() =>
      verifyLocalArtifacts({
        localPayload: f.payloadPath,
        localSig: f.sigPath,
        localManifest: f.manifestPath,
        publicKeyText: f.publicKeyText,
        expectedVersion: "v9.9.9",
        log: () => {},
      }),
    ).toThrow(/did not match expected/);
  });

  it("fails when the payload does not match its signature", () => {
    const f = localFixture("payload");
    expect(() =>
      verifyLocalArtifacts({
        localPayload: f.payloadPath,
        localSig: f.sigPath,
        localManifest: f.manifestPath,
        publicKeyText: f.publicKeyText,
        log: () => {},
      }),
    ).toThrow(/did not verify/);
  });

  it("fails when the manifest's signature field disagrees with the .sig file", () => {
    const f = localFixture("manifest-sig");
    expect(() =>
      verifyLocalArtifacts({
        localPayload: f.payloadPath,
        localSig: f.sigPath,
        localManifest: f.manifestPath,
        publicKeyText: f.publicKeyText,
        log: () => {},
      }),
    ).toThrow(/does not match/);
  });
});

describe("verifyReleaseAssets with a public key verifies the SERVED payload bytes", () => {
  it("rejects a swapped payload on the public origin even when it resolves", async () => {
    const payload = Buffer.from("published payload bytes");
    const { publicKeyText, signatureText } = minisignFixture(payload);
    // The swapped payload is content-addressed-consistent with its OWN url
    // (otherwise the R9-5 bytes/url tie fires first) — the cryptographic
    // check is what must reject it.
    const swappedBody = "NOT the signed bytes";
    const swappedUrl = tiedPayloadUrl(swappedBody);
    const fixtures: Record<string, string> = {
      [manifestUrl]: JSON.stringify({
        version: "1.2.3",
        platforms: { "darwin-aarch64": { signature: signatureText, url: swappedUrl } },
      }),
      [swappedUrl]: swappedBody,
      [`${swappedUrl}.sig`]: signatureText,
      [dmgUrl]: "dmg bytes",
    };
    await expect(
      verifyReleaseAssets({
        origin,
        publicKeyText,
        fetchImpl: fetchFrom(fixtures),
        log: () => {},
        retry: { attempts: 1, delayMs: 0 },
      }),
    ).rejects.toThrow(/did not verify/);
  });

  it("passes when the served bytes are exactly the signed bytes", async () => {
    const payload = Buffer.from("published payload bytes");
    const { publicKeyText, signatureText } = minisignFixture(payload);
    const signedUrl = tiedPayloadUrl(payload.toString());
    const fixtures: Record<string, string> = {
      [manifestUrl]: JSON.stringify({
        version: "1.2.3",
        platforms: { "darwin-aarch64": { signature: signatureText, url: signedUrl } },
      }),
      [signedUrl]: payload.toString(),
      [`${signedUrl}.sig`]: signatureText,
      [dmgUrl]: "dmg bytes",
    };
    const result = await verifyReleaseAssets({
      origin,
      publicKeyText,
      fetchImpl: fetchFrom(fixtures),
      log: () => {},
      retry: { attempts: 1, delayMs: 0 },
    });
    expect(result.version).toBe("1.2.3");
  });
});

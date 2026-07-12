// REL-008: the staged-publication engine, driven with an injected in-memory
// store — proving without credentials: ONE atomic mutable pointer, immutable
// content-addressed objects, rerun safety, read-back verification, rollback
// retention, the monotonic downgrade guard, wrangler-get error semantics, and
// the OLD-OR-NEW invariant under a failure injected at EVERY operation
// boundary (an interrupted run exposes the complete old release or the
// complete new release, never a mixed tuple).
import { describe, expect, it } from "vitest";
// @ts-expect-error Node CLI module with named testable exports (repo idiom).
import { stageRelease, contentAddressedKey, semverGreater, semverEqual, wranglerStore, isNotFoundStderr, rollbackPointer, restorePointer, resolveReleaseGuard, resolveRestoredGuard, isMinisignSignatureDocument } from "../scripts/stage-release.mjs";
// @ts-expect-error same idiom.
import { generateManifest, URL_PLACEHOLDER, DEFAULT_DARWIN_PLATFORMS } from "../scripts/generate-latest-json.mjs";
// @ts-expect-error node builtin — no node types in the frontend tsconfig (repo idiom).
import { createHash } from "node:crypto";

declare const Buffer: {
  from(v: unknown, enc?: string): any;
  compare(a: any, b: any): number;
  alloc(n: number, fill?: number): any;
  concat(list: any[]): any;
};
type Bytes = any;

/** R9-5: the contract requires base64 of an ACTUAL minisign signature
 *  document (4 lines: untrusted comment / 74-byte Ed box / trusted comment /
 *  64-byte global signature) — bare base64 like "U0lHVEVYVA==" no longer
 *  passes. Deterministic per seed, structurally exact, cryptographically
 *  meaningless (crypto stays in the verifier's fixtures). */
function minisignDocB64(seed: string): string {
  const box = Buffer.concat([
    Buffer.from("Ed"),
    createHash("sha256").update(`${seed}:keyid`).digest().subarray(0, 8),
    createHash("sha512").update(`${seed}:sig`).digest(), // 64 bytes
  ]); // 74 bytes total
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

function memoryStore(initial: Record<string, Bytes> = {}) {
  const objects = new Map<string, Bytes>(Object.entries(initial));
  const ops: string[] = []; // every store operation, in order: "put:key" | "get:key"
  const puts: string[] = [];
  let failAtOp: number | null = null; // fail when ops.length reaches this index
  let failOnPut: string | null = null;
  let failOncePut: string | null = null; // one-shot: fail the NEXT put of this key
  let corruptOnceGet: string | null = null; // one-shot: the NEXT get of this key returns garbage
  return {
    objects,
    ops,
    puts,
    setFailAtOp(n: number | null) {
      failAtOp = n;
    },
    setFailOnPut(key: string | null) {
      failOnPut = key;
    },
    setFailOncePut(key: string | null) {
      failOncePut = key;
    },
    setCorruptOnceGet(key: string | null) {
      corruptOnceGet = key;
    },
    async put(key: string, bytes: Bytes) {
      ops.push(`put:${key}`);
      if (failAtOp != null && ops.length > failAtOp) throw new Error(`injected failure at op ${ops.length}`);
      if (failOnPut && key === failOnPut) throw new Error(`injected put failure for ${key}`);
      if (failOncePut && key === failOncePut) {
        failOncePut = null;
        throw new Error(`injected one-shot put failure for ${key}`);
      }
      puts.push(key);
      objects.set(key, Buffer.from(bytes));
    },
    /** R7-6: compare-and-swap — writes ONLY when the current bytes equal the
     *  expected snapshot (or both are absent). The comparison happens at
     *  write time, so a concurrent write between a read and this call makes
     *  the precondition fail instead of being clobbered. */
    async putIfMatch(key: string, bytes: Bytes, expected: Bytes | null) {
      ops.push(`cas:${key}`);
      const cur = objects.get(key) ?? null;
      const matches =
        expected == null
          ? cur == null
          : cur != null && Buffer.compare(Buffer.from(cur), Buffer.from(expected)) === 0;
      if (!matches) throw new Error(`conditional write precondition failed for ${key}`);
      puts.push(key);
      objects.set(key, Buffer.from(bytes));
    },
    async get(key: string) {
      ops.push(`get:${key}`);
      if (failAtOp != null && ops.length > failAtOp) throw new Error(`injected failure at op ${ops.length}`);
      if (corruptOnceGet && key === corruptOnceGet) {
        corruptOnceGet = null;
        return Buffer.from("CORRUPTED READ-BACK BYTES");
      }
      const v = objects.get(key);
      return v == null ? null : Buffer.from(v);
    },
    snapshot() {
      const out: Record<string, string> = {};
      for (const [k, v] of objects) out[k] = Buffer.from(v).toString("base64");
      return out;
    },
  };
}

const SIG_B64 = minisignDocB64("primary"); // contract-valid minisign document
const SIG_B64_ALT = minisignDocB64("alternate"); // a DIFFERENT valid document

function manifestFor(version: string) {
  return generateManifest({
    signature: SIG_B64,
    version,
    pubDate: "2026-07-09T12:00:00Z",
  });
}

const baseArgs = (store: ReturnType<typeof memoryStore>, over: Record<string, unknown> = {}) => ({
  store,
  version: "v1.2.3",
  origin: "https://readthroughline.com",
  payload: Buffer.from("payload bytes v1"),
  sig: Buffer.from(SIG_B64),
  dmg: Buffer.from("dmg bytes v1"),
  manifest: manifestFor("1.2.3"),
  log: () => {},
  ...over,
});

/** R9-3: publish AND resolve the write-ahead guard — what the workflow does
 *  after its public post-verification passes. Tests that model a COMPLETED
 *  release use this; tests about in-flight/failed releases call stageRelease
 *  directly and assert on the standing guard. */
async function publishResolved(store: ReturnType<typeof memoryStore>, args: Record<string, unknown>) {
  const result = await stageRelease(args);
  await resolveReleaseGuard({ quiescence: "release-lease",
    store,
    releaseId: result.releaseId,
    newPointerSha256: result.newPointerSha256,
    log: () => {},
  });
  return result;
}

function standingGuard(store: ReturnType<typeof memoryStore>): Record<string, unknown> | null {
  const raw = store.objects.get("updates/unresolved.json");
  return raw == null ? null : JSON.parse(Buffer.from(raw).toString());
}

/** The coherence oracle: the live manifest must parse and every object it
 *  names (platform payload urls + sig + dmg key) must exist in the store with
 *  self-consistent bytes. Returns the manifest version. */
function assertCoherent(store: ReturnType<typeof memoryStore>): string | null {
  const raw = store.objects.get("updates/latest.json");
  if (raw == null) return null; // no release published yet — coherent by vacuity
  const manifest = JSON.parse(Buffer.from(raw).toString());
  const urls = new Set<string>();
  for (const entry of Object.values(manifest.platforms) as Array<{ url: string }>) {
    urls.add(entry.url);
  }
  for (const url of urls) {
    const key = url.replace("https://readthroughline.com/", "");
    expect(store.objects.has(key), `manifest names missing payload ${key}`).toBe(true);
    expect(store.objects.has(`${key}.sig`), `manifest payload ${key} missing its .sig`).toBe(true);
  }
  expect(manifest.dmg?.key, "manifest must name its dmg").toBeTruthy();
  expect(store.objects.has(manifest.dmg.key), `manifest names missing dmg ${manifest.dmg.key}`).toBe(true);
  return manifest.version;
}

describe("generateManifest (deterministic latest.json)", () => {
  it("is byte-deterministic for identical inputs and carries every darwin platform", () => {
    const a = manifestFor("1.2.3");
    const b = manifestFor("1.2.3");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a.platforms)).toEqual(DEFAULT_DARWIN_PLATFORMS);
    for (const entry of Object.values(a.platforms) as Array<{ signature: string; url: string }>) {
      expect(entry.signature).toBe(SIG_B64);
      expect(entry.url).toBe(URL_PLACEHOLDER);
    }
    expect(a.version).toBe("1.2.3");
    expect(a.pub_date).toBe("2026-07-09T12:00:00.000Z");
  });

  it("rejects a non-semver version, an empty signature, and a garbage date", () => {
    expect(() => generateManifest({ signature: "s", version: "nightly", pubDate: "2026-01-01T00:00:00Z" })).toThrow(/semver/);
    expect(() => generateManifest({ signature: "  ", version: "1.2.3", pubDate: "2026-01-01T00:00:00Z" })).toThrow(/signature is empty/);
    expect(() => generateManifest({ signature: "s", version: "1.2.3", pubDate: "not a date" })).toThrow(/ISO-8601/);
  });
});

describe("stageRelease — one atomic pointer, immutable tuple", () => {
  it("publishes the immutable tuple first, then promotes with ONE pointer PUT that names all of it", async () => {
    const store = memoryStore();
    const result = await stageRelease(baseArgs(store));

    expect(result.payloadKey).toMatch(/^updates\/Throughline-1\.2\.3-[0-9a-f]{12}\.app\.tar\.gz$/);
    expect(result.dmgKey).toMatch(/^updates\/Throughline-1\.2\.3-[0-9a-f]{12}\.dmg$/);
    // The manifest is the LAST put and the ONLY mutable pointer.
    expect(store.puts[store.puts.length - 1]).toBe("updates/latest.json");
    expect(store.puts.filter((k) => k === "Throughline.dmg").length).toBe(0);
    // It names the complete tuple, including the dmg with its hash.
    const published = JSON.parse(Buffer.from(store.objects.get("updates/latest.json")).toString());
    for (const entry of Object.values(published.platforms) as Array<{ url: string }>) {
      expect(entry.url).toBe(`https://readthroughline.com/${result.payloadKey}`);
    }
    expect(published.dmg).toEqual({
      url: `https://readthroughline.com/${result.dmgKey}`,
      key: result.dmgKey,
      sha256: result.dmgSha256,
    });
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("REFUSES a same-version rerun whose bytes differ ANYWHERE in the tuple (R4 — no stealth re-release)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const liveBefore = store.snapshot();
    const putsBefore = store.puts.length;

    // Each single-input difference is a different release wearing the same
    // version — every one must be refused BEFORE anything is written.
    const variants: Array<Record<string, unknown>> = [
      { payload: Buffer.from("payload bytes v1 REBUILT") },
      { dmg: Buffer.from("dmg bytes v1 REBUILT") },
      { sig: Buffer.from(SIG_B64_ALT), manifest: generateManifest({ signature: SIG_B64_ALT, version: "1.2.3", pubDate: "2026-07-09T12:00:00Z" }) },
      { manifest: generateManifest({ signature: SIG_B64, version: "1.2.3", pubDate: "2026-07-10T12:00:00Z" }) }, // moved tag → new pub date
      { severity: "critical" }, // same artifacts, different manifest metadata
    ];
    for (const over of variants) {
      await expect(
        stageRelease(baseArgs(store, over)),
        JSON.stringify(Object.keys(over)),
      ).rejects.toThrow(/SAME-VERSION RERUN REFUSED/);
    }
    expect(store.puts.length, "nothing was written by any refused rerun").toBe(putsBefore);
    expect(store.snapshot()).toEqual(liveBefore);
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("validates BOTH versions as strict x.y.z and fails closed on a malformed/missing live version (R4)", async () => {
    // Incoming garbage version: refused before anything is read or written.
    const s1 = memoryStore();
    await expect(stageRelease(baseArgs(s1, { version: "nightly-2026" }))).rejects.toThrow(/strict x\.y\.z/);
    expect(s1.puts.length).toBe(0);

    // Live manifest with NO version: unknown pointer state → fail closed.
    const noVersion = memoryStore({
      "updates/latest.json": Buffer.from(JSON.stringify({ platforms: {} })),
    });
    await expect(stageRelease(baseArgs(noVersion, { version: "v1.2.4", manifest: manifestFor("1.2.4") }))).rejects.toThrow(
      /no canonical x\.y\.z version.*unknown pointer state/,
    );
    // Live manifest with a MALFORMED version: same refusal.
    const badVersion = memoryStore({
      "updates/latest.json": Buffer.from(JSON.stringify({ version: "1.2", platforms: {} })),
    });
    await expect(stageRelease(baseArgs(badVersion, { version: "v1.2.4", manifest: manifestFor("1.2.4") }))).rejects.toThrow(
      /unknown pointer state/,
    );
  });

  it("a rerun with IDENTICAL bytes is idempotent (immutable objects skipped, rollback.json untouched)", async () => {
    const store = memoryStore();
    const first = await publishResolved(store, baseArgs(store));
    const putsAfterFirst = store.puts.length;
    const second = await stageRelease(baseArgs(store));
    expect(second.payloadKey).toBe(first.payloadKey);
    // R9-3: the rerun re-arms its own write-ahead guard before promoting.
    // R10-3: it does NOT re-put rollback.json — on a byte-identical rerun the
    // live pointer IS this release, and "retaining" it would overwrite the
    // real rollback target with the release itself.
    expect(store.puts.slice(putsAfterFirst)).toEqual([
      "updates/unresolved.json",
      "updates/latest.json",
    ]);
  });

  it("v1 → v2 → identical v2 rerun leaves rollback.json BYTE-IDENTICAL to v1 (R10-3)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store)); // v1.2.3 live
    await publishResolved(
      store,
      baseArgs(store, {
        version: "v1.2.4",
        manifest: manifestFor("1.2.4"),
        payload: Buffer.from("payload v2"),
        dmg: Buffer.from("dmg v2"),
      }),
    ); // v1.2.4 live; rollback.json retains v1.2.3
    const rollbackAfterUpgrade = store.snapshot()["updates/rollback.json"];
    expect(
      JSON.parse(Buffer.from(rollbackAfterUpgrade, "base64").toString()).version,
    ).toBe("1.2.3");

    // The byte-identical v1.2.4 rerun.
    await publishResolved(
      store,
      baseArgs(store, {
        version: "v1.2.4",
        manifest: manifestFor("1.2.4"),
        payload: Buffer.from("payload v2"),
        dmg: Buffer.from("dmg v2"),
      }),
    );
    expect(
      store.snapshot()["updates/rollback.json"],
      "the rollback target still names v1.2.3, byte-identical",
    ).toBe(rollbackAfterUpgrade);
    expect(assertCoherent(store)).toBe("1.2.4");
  });

  it("refuses loudly when a versioned key already holds DIFFERENT bytes, before any pointer moves", async () => {
    const store = memoryStore();
    const args = baseArgs(store);
    const key = contentAddressedKey("1.2.3", args.payload, ".app.tar.gz");
    store.objects.set(key, Buffer.from("previously published, different"));
    await expect(stageRelease(args)).rejects.toThrow(/IMMUTABILITY VIOLATION/);
    expect(store.objects.has("updates/latest.json")).toBe(false);
  });

  it("tags the manifest critical when the severity says so", async () => {
    const store = memoryStore();
    await stageRelease(baseArgs(store, { severity: "critical" }));
    const published = JSON.parse(Buffer.from(store.objects.get("updates/latest.json")).toString());
    expect(published.severity).toBe("critical");
    expect(published.criticalBelow).toBe("1.2.3");
  });
});

describe("stageRelease — monotonic-version / downgrade guard", () => {
  it("refuses a stale tag that would replace a NEWER live release", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store, { version: "v1.3.0", manifest: manifestFor("1.3.0") }));
    const liveBefore = store.snapshot()["updates/latest.json"];
    await expect(stageRelease(baseArgs(store))).rejects.toThrow(/DOWNGRADE REFUSED/);
    expect(store.snapshot()["updates/latest.json"]).toBe(liveBefore);
    expect(assertCoherent(store)).toBe("1.3.0");
  });

  it("allows a same-version rerun and a normal upgrade", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    await publishResolved(store, baseArgs(store)); // rerun ok
    await publishResolved(store, baseArgs(store, { version: "v1.2.4", manifest: manifestFor("1.2.4") }));
    expect(assertCoherent(store)).toBe("1.2.4");
  });

  it("refuses to publish over an unparseable live pointer", async () => {
    const store = memoryStore({ "updates/latest.json": Buffer.from("not json at all") });
    await expect(stageRelease(baseArgs(store))).rejects.toThrow(/unknown pointer state/);
  });

  it("semverGreater orders correctly", () => {
    expect(semverGreater("1.3.0", "1.2.9")).toBe(true);
    expect(semverGreater("1.2.3", "1.2.3")).toBe(false);
    expect(semverGreater("1.2.3", "1.10.0")).toBe(false);
    expect(semverGreater("2.0.0", "1.99.99")).toBe(true);
  });

  it("semverEqual compares NORMALIZED versions (v-prefix and whitespace never defeat equality)", () => {
    expect(semverEqual("1.2.3", "1.2.3")).toBe(true);
    expect(semverEqual("v1.2.3", "1.2.3")).toBe(true);
    expect(semverEqual(" 1.2.3 ", "1.2.3")).toBe(true);
    expect(semverEqual("1.2.3", "1.2.4")).toBe(false);
    expect(semverEqual("nightly", "1.2.3")).toBe(false);
  });

  it("REFUSES a live pointer with a NONCANONICAL version — a live v1.2.3 must not permit different 1.2.3 artifacts (R5)", async () => {
    // A live manifest at "v1.2.3": parseable as 1.2.3, but never a shape this
    // pipeline wrote. Under raw string comparison it would dodge the
    // same-version byte-identity guard and let a stealth 1.2.3 re-release
    // through — so it is refused as an unknown pointer state, for ANY
    // incoming version.
    const vPrefixed = memoryStore({
      "updates/latest.json": Buffer.from(JSON.stringify({ version: "v1.2.3", platforms: {} })),
    });
    const liveBefore = vPrefixed.snapshot();
    await expect(
      stageRelease(baseArgs(vPrefixed, { payload: Buffer.from("DIFFERENT 1.2.3 artifacts") })),
    ).rejects.toThrow(/no canonical x\.y\.z version.*unknown pointer state/);
    await expect(
      stageRelease(baseArgs(vPrefixed, { version: "v1.2.4", manifest: manifestFor("1.2.4") })),
    ).rejects.toThrow(/unknown pointer state/);
    expect(vPrefixed.snapshot()).toEqual(liveBefore);
  });
});

describe("stageRelease — promotion AMBIGUITY recovery (R5)", () => {
  async function liveStore() {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store)); // 1.2.3 live, guard resolved
    return store;
  }
  const upgradeArgs = (store: ReturnType<typeof memoryStore>) =>
    baseArgs(store, {
      version: "v1.2.4",
      manifest: manifestFor("1.2.4"),
      payload: Buffer.from("payload v2"),
      dmg: Buffer.from("dmg v2"),
    });

  it("a FAILED promotion PUT that provably never moved the pointer restores NOTHING and says so (R6-7)", async () => {
    const store = await liveStore();
    const oldPointer = store.snapshot()["updates/latest.json"];
    store.setFailOncePut("updates/latest.json");

    // R6-7: the recovery READS the live state first. Here the failed PUT
    // never wrote, so the pre-stage release is still live — reported as-is,
    // with no extra write issued against the pointer.
    const putsBefore = store.puts.filter((k) => k === "updates/latest.json").length;
    await expect(stageRelease(upgradeArgs(store))).rejects.toThrow(
      /still holds the exact pre-stage release — nothing new is live/,
    );
    expect(store.snapshot()["updates/latest.json"]).toBe(oldPointer);
    expect(
      store.puts.filter((k) => k === "updates/latest.json").length,
      "no restore PUT was issued over a pointer that never moved",
    ).toBe(putsBefore);
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("an AMBIGUOUS read-back after the promotion PUT (failure before read-back completes) also restores", async () => {
    const store = await liveStore();
    const oldPointer = store.snapshot()["updates/latest.json"];
    // The promotion PUT lands, but ITS read-back returns garbage — the engine
    // cannot know the pointer's true state and must restore the pre-stage
    // bytes. (Armed on the first pointer put only, so the restoration's own
    // read-back sees true bytes.)
    let promotionSeen = false;
    let corruptNextPointerGet = false;
    const wrapped = {
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json" && !promotionSeen) {
          promotionSeen = true;
          corruptNextPointerGet = true;
        }
        return store.put(key, bytes);
      },
      async get(key: string) {
        if (key === "updates/latest.json" && corruptNextPointerGet) {
          corruptNextPointerGet = false;
          return Buffer.from("CORRUPTED READ-BACK BYTES");
        }
        return store.get(key);
      },
      async putIfMatch(key: string, bytes: Bytes, expected: Bytes | null) {
        return store.putIfMatch(key, bytes, expected);
      },
    };

    await expect(stageRelease({ ...upgradeArgs(store), store: wrapped })).rejects.toThrow(
      /read-back after the promotion PUT did not match[\s\S]*RESTORED to the exact pre-stage release/,
    );
    expect(store.snapshot()["updates/latest.json"]).toBe(oldPointer);
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("when the restoration ALSO fails, it reports ROLLBACK IMPOSSIBLE loudly", async () => {
    const store = await liveStore();
    // The promotion PUT lands but its read-back is corrupted (ambiguous), the
    // live-read then shows this run's manifest (restore warranted), and the
    // CONDITIONAL restore write fails: ROLLBACK IMPOSSIBLE.
    let corruptNextPointerGet = false;
    const wrapped = {
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json") {
          corruptNextPointerGet = true; // the read-back right after
        }
        return store.put(key, bytes);
      },
      async get(key: string) {
        if (key === "updates/latest.json" && corruptNextPointerGet) {
          corruptNextPointerGet = false;
          return Buffer.from("CORRUPTED READ-BACK BYTES");
        }
        return store.get(key);
      },
      async putIfMatch() {
        throw new Error("injected conditional-restore failure");
      },
    };

    await expect(stageRelease({ ...upgradeArgs(store), store: wrapped })).rejects.toThrow(
      /ROLLBACK IMPOSSIBLE[\s\S]*Nothing was overwritten blind/,
    );
  });

  it("a concurrent 2.0.0 landing AFTER the recovery read but BEFORE the restore write stays live (R7-6 CAS)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store, { version: "v1.0.0", manifest: manifestFor("1.0.0") }));
    const concurrent = Buffer.from(
      JSON.stringify({
        version: "2.0.0",
        platforms: { "darwin-aarch64": { url: "https://readthroughline.com/updates/Throughline-2.0.0-cdcdcdcdcdcd.app.tar.gz", signature: SIG_B64 } },
        dmg: { url: "https://readthroughline.com/updates/Throughline-2.0.0-cdcdcdcdcdcd.dmg", key: "updates/Throughline-2.0.0-cdcdcdcdcdcd.dmg", sha256: "cd".repeat(32) },
      }),
    );
    // 1.1.0's promotion PUT lands but its read-back is corrupted (ambiguous).
    // The recovery read returns THIS RUN'S manifest — and immediately after
    // that read, a concurrent publish lands 2.0.0. The conditional restore's
    // precondition (tied to the read) must fail; 2.0.0 must survive.
    let corruptNextPointerGet = false;
    let promotionLanded = false;
    let injectAfterRecoveryRead = false;
    const wrapped = {
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json") {
          corruptNextPointerGet = true;
          promotionLanded = true;
        }
        return store.put(key, bytes);
      },
      async get(key: string) {
        if (key === "updates/latest.json" && corruptNextPointerGet) {
          corruptNextPointerGet = false;
          injectAfterRecoveryRead = promotionLanded;
          return Buffer.from("CORRUPTED READ-BACK BYTES");
        }
        const value = await store.get(key);
        if (key === "updates/latest.json" && injectAfterRecoveryRead) {
          // The concurrent publish wins the race right after this read.
          injectAfterRecoveryRead = false;
          await store.put(key, concurrent);
        }
        return value;
      },
      async putIfMatch(key: string, bytes: Bytes, expected: Bytes | null) {
        return store.putIfMatch(key, bytes, expected);
      },
    };

    await expect(
      stageRelease({
        ...baseArgs(store, {
          version: "v1.1.0",
          manifest: manifestFor("1.1.0"),
          payload: Buffer.from("payload v1.1"),
          dmg: Buffer.from("dmg v1.1"),
        }),
        store: wrapped,
      }),
    ).rejects.toThrow(/ROLLBACK IMPOSSIBLE[\s\S]*conditional restore did not apply/);

    expect(Buffer.from(store.snapshot()["updates/latest.json"], "base64").toString()).toBe(
      concurrent.toString(),
      );
  });

  it("a store WITHOUT compare-and-swap never auto-restores — the live state is reported for the operator (R7-6)", async () => {
    const store = await liveStore();
    let corruptNextPointerGet = false;
    const wrapped = {
      // NO putIfMatch — like the production wrangler store.
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json") corruptNextPointerGet = true;
        return store.put(key, bytes);
      },
      async get(key: string) {
        if (key === "updates/latest.json" && corruptNextPointerGet) {
          corruptNextPointerGet = false;
          return Buffer.from("CORRUPTED READ-BACK BYTES");
        }
        return store.get(key);
      },
    };

    await expect(stageRelease({ ...upgradeArgs(store), store: wrapped })).rejects.toThrow(
      /no conditional write[\s\S]*NOT auto-restoring[\s\S]*naming version 1\.2\.4/,
    );
    // Nothing was written over the (ambiguously promoted) live pointer.
    const live = JSON.parse(
      Buffer.from(store.snapshot()["updates/latest.json"], "base64").toString(),
    );
    expect(live.version).toBe("1.2.4");
  });

  it("a THIRD live state after an ambiguous promotion is NEVER clobbered — 1.0.0 → failed 1.1.0 → concurrent 2.0.0 (R6-7)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store, { version: "v1.0.0", manifest: manifestFor("1.0.0") }));

    // 1.1.0's promotion PUT throws WITHOUT writing; in that same window a
    // CONCURRENT publish lands 2.0.0. The old blind restore would have put
    // 1.0.0 back OVER the concurrent 2.0.0.
    const concurrent = Buffer.from(
      JSON.stringify({
        version: "2.0.0",
        platforms: { "darwin-aarch64": { url: "https://readthroughline.com/updates/Throughline-2.0.0-cdcdcdcdcdcd.app.tar.gz", signature: SIG_B64 } },
        dmg: { url: "https://readthroughline.com/updates/Throughline-2.0.0-cdcdcdcdcdcd.dmg", key: "updates/Throughline-2.0.0-cdcdcdcdcdcd.dmg", sha256: "cd".repeat(32) },
      }),
    );
    let armed = true;
    const wrapped = {
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json" && armed) {
          armed = false;
          await store.put(key, concurrent); // the concurrent publish wins the race
          throw new Error("injected network failure on the promotion PUT");
        }
        return store.put(key, bytes);
      },
      async get(key: string) {
        return store.get(key);
      },
    };

    await expect(
      stageRelease({
        ...baseArgs(store, {
          version: "v1.1.0",
          manifest: manifestFor("1.1.0"),
          payload: Buffer.from("payload v1.1"),
          dmg: Buffer.from("dmg v1.1"),
        }),
        store: wrapped,
      }),
    ).rejects.toThrow(/THIRD state[\s\S]*Nothing was touched/);

    // The concurrent 2.0.0 is still live — the recovery refused to roll it
    // back to 1.0.0.
    expect(Buffer.from(store.snapshot()["updates/latest.json"], "base64").toString()).toBe(
      concurrent.toString(),
    );
  });

  it("an UNREADABLE live pointer after a failed promotion restores NOTHING and reports UNKNOWN (R6-7)", async () => {
    const store = await liveStore();
    const oldPointer = store.snapshot()["updates/latest.json"];
    let failing = false;
    const wrapped = {
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json") {
          failing = true; // from here on, the pointer can't be read either
          throw new Error("injected network failure on the promotion PUT");
        }
        return store.put(key, bytes);
      },
      async get(key: string) {
        if (key === "updates/latest.json" && failing) {
          throw new Error("injected network failure on the pointer read");
        }
        return store.get(key);
      },
    };

    await expect(stageRelease({ ...upgradeArgs(store), store: wrapped })).rejects.toThrow(
      /could not be read[\s\S]*UNKNOWN/,
    );
    // Nothing was written over the unknown state.
    expect(store.snapshot()["updates/latest.json"]).toBe(oldPointer);
  });

  it("a FIRST-release ambiguous promotion is reported honestly (nothing to restore)", async () => {
    const store = memoryStore();
    store.setFailOncePut("updates/latest.json");
    await expect(stageRelease(baseArgs(store))).rejects.toThrow(
      /PROMOTION AMBIGUOUS on the FIRST release/,
    );
  });

  it("captures the pre-stage state (exact pointer bytes + DMG hash anchors) and flips promotion-attempted BEFORE the pointer PUT", async () => {
    const store = await liveStore();
    const oldPointer = store.snapshot()["updates/latest.json"];
    const oldManifest = JSON.parse(Buffer.from(oldPointer, "base64").toString());

    let preStage: Record<string, unknown> | null = null;
    let opsAtBeforePromotion = -1;
    const result = await stageRelease({
      ...upgradeArgs(store),
      onPreStage: (s: Record<string, unknown>) => {
        preStage = s;
      },
      onBeforePromotion: () => {
        opsAtBeforePromotion = store.ops.length;
      },
    });
    expect(preStage).not.toBeNull();
    expect(preStage!.pointerPresent).toBe(true);
    expect(preStage!.pointerBase64).toBe(oldPointer);
    expect(preStage!.previousVersion).toBe("1.2.3");
    // The previous manifest carries a dmg block → its sha256 is the anchor.
    expect(preStage!.previousDmgSha256).toBe(oldManifest.dmg.sha256);
    expect(preStage!.newVersion).toBe("1.2.4");
    // onBeforePromotion fired BEFORE the promotion PUT (which is the last put).
    const promotionPutIndex = store.ops.lastIndexOf("put:updates/latest.json");
    expect(opsAtBeforePromotion).toBeGreaterThan(-1);
    expect(opsAtBeforePromotion).toBeLessThanOrEqual(promotionPutIndex);
    expect(result.preStage).toBe(preStage);
  });

  it("captures the LEGACY DMG hash when the live release predates dmg metadata (pre-dmg rollback anchor)", async () => {
    const legacyDmg = Buffer.from("the legacy stable dmg bytes");
    const legacyManifest = JSON.stringify({
      version: "1.2.2",
      platforms: { "darwin-aarch64": { url: "https://readthroughline.com/updates/Throughline-1.2.2-abcdef123456.app.tar.gz", signature: SIG_B64 } },
    });
    const store = memoryStore({
      "updates/latest.json": Buffer.from(legacyManifest),
      "Throughline.dmg": legacyDmg,
    });
    let preStage: Record<string, unknown> | null = null;
    await stageRelease({ ...baseArgs(store), onPreStage: (s: Record<string, unknown>) => { preStage = s; } });
    const expected = createHash("sha256").update(legacyDmg).digest("hex");
    expect(preStage!.previousDmgSha256).toBe(expected);
  });
});

// ── R7-7: THE strict manifest contract, applied to the previous-live
// manifest BEFORE anything is staged, plus real independent DMG evidence.
// The adversarial fixture matrix below is mirrored (same labels) in
// verifyReleaseAssets.test.ts and the site Worker's download.test.ts. ──
describe("stageRelease — the manifest contract + independent DMG anchor (R6-7/R7-7)", () => {
  const TIED_SHA = "ab".repeat(32);
  const tiedKey = (v: string, sha: string) =>
    `updates/Throughline-${v}-${sha.slice(0, 12)}.dmg`;
  const liveManifest = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        version: "1.2.3",
        platforms: { "darwin-aarch64": { url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz", signature: SIG_B64 } },
        ...over,
      }),
    );
  const validDmg = (sha: string = TIED_SHA) => ({
    url: `https://readthroughline.com/${tiedKey("1.2.3", sha)}`,
    key: tiedKey("1.2.3", sha),
    sha256: sha,
  });
  const nextArgs = (store: ReturnType<typeof memoryStore>) =>
    baseArgs(store, { version: "v1.2.4", manifest: manifestFor("1.2.4") });

  it.each([
    ["whitespace version", { version: " 1.2.3" }, /no canonical x\.y\.z version/],
    ["leading-zero version (R8-5)", { version: "01.2.3" }, /no canonical x\.y\.z version/],
    [
      "an unsupported platform key (R8-5)",
      {
        platforms: {
          "darwin-arm64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: SIG_B64,
          },
        },
      },
      /not a supported darwin key/,
    ],
    [
      "an off-origin updater url (R8-5)",
      {
        platforms: {
          "darwin-aarch64": { url: "https://evil.example/updates/u.app.tar.gz", signature: SIG_B64 },
        },
      },
      /not on the distribution origin/,
    ],
    [
      "a signature that is not base64 at all (R8-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: "sig-text!",
          },
        },
      },
      /not base64 of a minisign signature document/,
    ],
    [
      "a signature that is base64 but NOT a minisign document — e.g. AAAA (R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: "AAAA",
          },
        },
      },
      /not base64 of a minisign signature document/,
    ],
    [
      "an updater url with a QUERY STRING (R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz?token=x",
            signature: SIG_B64,
          },
        },
      },
      /carries a query string/,
    ],
    [
      "an updater url with a FRAGMENT (R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz#frag",
            signature: SIG_B64,
          },
        },
      },
      /carries a fragment/,
    ],
    [
      "an updater url with embedded CREDENTIALS (R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://user:pass@readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: SIG_B64,
          },
        },
      },
      /embeds credentials/,
    ],
    [
      "an updater url outside /updates/ (R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/downloads/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: SIG_B64,
          },
        },
      },
      /not a plain file directly under \/updates\//,
    ],
    [
      "an updater url not tied to THIS manifest's version (R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-9.9.9-abcdef123456.app.tar.gz",
            signature: SIG_B64,
          },
        },
      },
      /not the content-addressed updater payload for version 1\.2\.3/,
    ],
    [
      "platform entries with DIFFERENT signatures (one payload, one signature, R10-3)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: SIG_B64,
          },
          "darwin-x86_64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: SIG_B64_ALT,
          },
        },
      },
      /signature differs from the other entries/,
    ],
    [
      "platform entries with DIFFERENT urls (one payload per release, R9-5)",
      {
        platforms: {
          "darwin-aarch64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz",
            signature: SIG_B64,
          },
          "darwin-x86_64": {
            url: "https://readthroughline.com/updates/Throughline-1.2.3-fedcba654321.app.tar.gz",
            signature: SIG_B64,
          },
        },
      },
      /differs from the other entries/,
    ],
    [
      "severity without criticalBelow (R9-5)",
      { severity: "critical" },
      /criticalBelow is not a canonical x\.y\.z/,
    ],
    [
      "a non-critical severity value (R9-5)",
      { severity: "high", criticalBelow: "1.2.3" },
      /severity must be "critical" when present/,
    ],
    [
      "criticalBelow NEWER than the version (R9-5)",
      { severity: "critical", criticalBelow: "2.0.0" },
      /criticalBelow is newer than the manifest version/,
    ],
    [
      "a dmg url that is not origin \u002b dmg.key (R9-5)",
      {
        dmg: {
          url: `https://readthroughline.com/updates/Throughline-1.2.3-000000000000.dmg`,
          key: tiedKey("1.2.3", TIED_SHA),
          sha256: TIED_SHA,
        },
      },
      /dmg\.url is not the distribution origin \+ dmg\.key/,
    ],
    ["dmg: null (legacy means the property is ABSENT)", { dmg: null }, /legacy means the property is ABSENT/],
    [
      "a dmg block with a malformed sha256",
      { dmg: { url: `https://readthroughline.com/${tiedKey("1.2.3", TIED_SHA)}`, key: tiedKey("1.2.3", TIED_SHA), sha256: "not-hex" } },
      /dmg\.sha256 is not a 64-hex hash/,
    ],
    [
      "a dmg key not tied to this version+hash",
      { dmg: { url: `https://readthroughline.com/${tiedKey("1.2.3", TIED_SHA)}`, key: tiedKey("9.9.9", TIED_SHA), sha256: TIED_SHA } },
      /not the content-addressed key/,
    ],
    [
      "an out-of-prefix dmg key",
      { dmg: { url: `https://readthroughline.com/${tiedKey("1.2.3", TIED_SHA)}`, key: "secrets/steal.dmg", sha256: TIED_SHA } },
      /not the content-addressed key/,
    ],
    [
      "a malformed dmg url",
      { dmg: { url: "not a url", key: tiedKey("1.2.3", TIED_SHA), sha256: TIED_SHA } },
      /dmg url is not a valid URL/,
    ],
    ["empty platforms", { platforms: {} }, /platforms is empty/],
    [
      "Linux-only platforms (no darwin entry)",
      { platforms: { "linux-x86_64": { url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz", signature: SIG_B64 } } },
      /no darwin platform entry/,
    ],
    [
      "a platform entry with no signature",
      { platforms: { "darwin-aarch64": { url: "https://readthroughline.com/updates/Throughline-1.2.3-abcdef123456.app.tar.gz" } } },
      /signature is missing or empty/,
    ],
    [
      "a platform entry with an empty url",
      { platforms: { "darwin-aarch64": { url: "", signature: SIG_B64 } } },
      /url is missing or empty/,
    ],
    [
      "a platform url with surrounding whitespace",
      { platforms: { "darwin-aarch64": { url: ` ${"https://readthroughline.com/updates/u.app.tar.gz"} `, signature: SIG_B64 } } },
      /has surrounding whitespace/,
    ],
    [
      "a non-https platform url",
      { platforms: { "darwin-aarch64": { url: "http://readthroughline.com/updates/u.app.tar.gz", signature: SIG_B64 } } },
      /is not https/,
    ],
  ])("refuses to promote over a live manifest with %s — and stages NOTHING", async (_name, over, msg) => {
    const store = memoryStore({ "updates/latest.json": liveManifest(over) });
    await expect(stageRelease(nextArgs(store))).rejects.toThrow(msg);
    expect(store.puts, "the refusal happened BEFORE any object was staged").toEqual([]);
  });

  it("refuses when the live release's DMG OBJECT is missing — the anchor must be real bytes, not a manifest claim", async () => {
    const store = memoryStore({
      "updates/latest.json": liveManifest({ dmg: validDmg() }),
    });
    await expect(stageRelease(nextArgs(store))).rejects.toThrow(/MISSING from the store/);
    expect(store.puts).toEqual([]);
  });

  it("refuses when the live DMG bytes do NOT hash to the manifest's declared sha256 (corrupt live tuple)", async () => {
    const store = memoryStore({
      "updates/latest.json": liveManifest({ dmg: validDmg() }),
      [tiedKey("1.2.3", TIED_SHA)]: Buffer.from("bytes that hash to something else"),
    });
    await expect(stageRelease(nextArgs(store))).rejects.toThrow(
      /do not hash to its manifest's declared sha256/,
    );
    expect(store.puts).toEqual([]);
  });

  it("refuses a pre-dmg live release whose legacy Throughline.dmg is missing — no evidence, no promotion", async () => {
    const store = memoryStore({ "updates/latest.json": liveManifest() }); // no dmg property, no legacy object
    await expect(stageRelease(nextArgs(store))).rejects.toThrow(
      /legacy Throughline\.dmg object is MISSING/,
    );
    expect(store.puts).toEqual([]);
  });

  it("the captured anchor is COMPUTED from the stored bytes (agreeing with the declared sha256)", async () => {
    const dmgBytes = Buffer.from("the genuine previous dmg bytes");
    const declared = createHash("sha256").update(dmgBytes).digest("hex");
    const store = memoryStore({
      "updates/latest.json": liveManifest({ dmg: validDmg(declared) }),
      [tiedKey("1.2.3", declared)]: dmgBytes,
    });
    let preStage: Record<string, unknown> | null = null;
    await stageRelease({ ...nextArgs(store), onPreStage: (s: Record<string, unknown>) => { preStage = s; } });
    expect(preStage!.previousDmgSha256).toBe(declared);
  });

  it("the engine SELF-CHECKS the manifest it is about to publish against the same contract", async () => {
    const store = memoryStore();
    // A generator manifest whose platform entry has a whitespace signature
    // would survive URL rewriting — the self-check refuses it before staging.
    const bad = JSON.parse(JSON.stringify(manifestFor("1.2.3")));
    bad.platforms["darwin-aarch64"].signature = "  ";
    await expect(stageRelease(baseArgs(store, { manifest: bad }))).rejects.toThrow(
      /finalized manifest violates the manifest contract/,
    );
    expect(store.puts).toEqual([]);
  });
});

// ── R8-5: the durable UNRESOLVED-RELEASE guard ──
describe("stageRelease — the WRITE-AHEAD release-guard transaction (R8-5/R9-3)", () => {
  const upgradeArgs = (store: ReturnType<typeof memoryStore>) =>
    baseArgs(store, {
      version: "v1.2.4",
      manifest: manifestFor("1.2.4"),
      payload: Buffer.from("payload v2"),
      dmg: Buffer.from("dmg v2"),
    });

  it("arms a PENDING guard (release id + exact pointer digest) BEFORE latest.json can change, read-back verified", async () => {
    const store = memoryStore();
    const result = await stageRelease(baseArgs(store));

    // The guard put + its read-back verification happened BEFORE the pointer PUT.
    const guardPut = store.ops.indexOf("put:updates/unresolved.json");
    const pointerPut = store.ops.indexOf("put:updates/latest.json");
    expect(guardPut).toBeGreaterThan(-1);
    expect(pointerPut).toBeGreaterThan(guardPut);
    expect(store.ops.slice(guardPut, pointerPut)).toContain("get:updates/unresolved.json");

    // The guard names THIS release exactly.
    const guard = standingGuard(store)!;
    expect(guard.pending).toBe(true);
    expect(guard.releaseId).toBe(result.releaseId);
    expect(guard.releaseId).toMatch(/^1\.2\.3@sha256:[0-9a-f]{64}$/);
    expect(guard.newPointerSha256).toBe(result.newPointerSha256);

    // And it stays pending through the SUCCESSFUL publication — public
    // post-verification (the workflow) is what resolves it, not promotion.
    await expect(stageRelease(upgradeArgs(store))).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);

    await resolveReleaseGuard({ quiescence: "release-lease", store, releaseId: result.releaseId, newPointerSha256: result.newPointerSha256, log: () => {} });
    expect(standingGuard(store)!.resolved).toBe(true);
    await stageRelease(upgradeArgs(store)); // now publishes
    expect(assertCoherent(store)).toBe("1.2.4");
  });

  it("a guard that cannot be written-and-read-back STOPS the release BEFORE the pointer moves", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const liveBefore = store.snapshot()["updates/latest.json"];
    const opsBefore = store.ops.length;
    store.setFailOnPut("updates/unresolved.json");
    await expect(stageRelease(upgradeArgs(store))).rejects.toThrow(/injected put failure/);
    store.setFailOnPut(null);
    expect(store.snapshot()["updates/latest.json"], "the pointer never moved").toBe(liveBefore);
    expect(store.ops.slice(opsBefore)).not.toContain("put:updates/latest.json" as never);

    // Corrupted guard READ-BACK (the get right after the pending put — not
    // the start-of-run check): same stop, same untouched pointer.
    const store2 = memoryStore();
    await publishResolved(store2, baseArgs(store2));
    const live2 = store2.snapshot()["updates/latest.json"];
    let corruptAfterGuardPut = false;
    const wrapped = {
      async put(k: string, b: Bytes) {
        const r = await store2.put(k, b);
        if (k === "updates/unresolved.json") corruptAfterGuardPut = true;
        return r;
      },
      async get(k: string) {
        if (k === "updates/unresolved.json" && corruptAfterGuardPut) {
          corruptAfterGuardPut = false;
          return Buffer.from("GARBAGE GUARD READ-BACK");
        }
        return store2.get(k);
      },
      putIfMatch: (k: string, b: Bytes, e: Bytes | null) => store2.putIfMatch(k, b, e),
    };
    await expect(stageRelease({ ...upgradeArgs(store2), store: wrapped })).rejects.toThrow(
      /write-ahead release guard did not read back/,
    );
    expect(store2.snapshot()["updates/latest.json"]).toBe(live2);
  });

  it("RUNNER DEATH at every boundary after guard creation leaves later releases blocked (R9-3)", async () => {
    // Boundary 1: death right after promotion, before post-verification —
    // modeled by a successful stageRelease with NO resolve call.
    const afterPromotion = memoryStore();
    await stageRelease(baseArgs(afterPromotion));
    await expect(stageRelease(upgradeArgs(afterPromotion))).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);

    // Boundary 2: death DURING promotion (the PUT failed one-shot).
    const midPromotion = memoryStore();
    midPromotion.setFailOncePut("updates/latest.json");
    await expect(stageRelease(baseArgs(midPromotion))).rejects.toThrow(/PROMOTION AMBIGUOUS/);
    expect(standingGuard(midPromotion)!.resolved).not.toBe(true);
    await expect(stageRelease(upgradeArgs(midPromotion))).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);

    // Boundary 3: death after promotion during a FAILED verification path —
    // the ambiguous-read-back case below also stays guarded.
  });

  it("an ambiguous promotion keeps the guard standing, and the guard BLOCKS every later release with ZERO writes until resolved", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    // Ambiguity: the promotion lands but its read-back is corrupted, and the
    // store (like production wrangler) offers no conditional write.
    let corruptNextPointerGet = false;
    const nonCas = {
      async put(key: string, bytes: Bytes) {
        if (key === "updates/latest.json") corruptNextPointerGet = true;
        return store.put(key, bytes);
      },
      async get(key: string) {
        if (key === "updates/latest.json" && corruptNextPointerGet) {
          corruptNextPointerGet = false;
          return Buffer.from("CORRUPTED READ-BACK BYTES");
        }
        return store.get(key);
      },
    };
    await expect(stageRelease({ ...upgradeArgs(store), store: nonCas })).rejects.toThrow(
      /UNRESOLVED-RELEASE guard/,
    );
    const guard = standingGuard(store)!;
    expect(guard.pending).toBe(true);
    expect(guard.releaseId).toMatch(/^1\.2\.4@sha256:[0-9a-f]{64}$/);

    // Every later release refuses to publish — with ZERO writes — until the
    // operator resolves the guard.
    const putsBefore = store.puts.length;
    await expect(
      stageRelease(baseArgs(store, { version: "v1.2.5", manifest: manifestFor("1.2.5") })),
    ).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);
    expect(store.puts.length, "the guarded refusal writes nothing").toBe(putsBefore);

    // Operator resolution (marking it resolved) unblocks publication.
    await store.put(
      "updates/unresolved.json",
      Buffer.from(JSON.stringify({ resolved: true })),
    );
    await stageRelease(
      baseArgs(store, {
        version: "v1.2.5",
        manifest: manifestFor("1.2.5"),
        payload: Buffer.from("payload v3"),
        dmg: Buffer.from("dmg v3"),
      }),
    ).then((r: { manifest: { version: string } }) => expect(r.manifest.version).toBe("1.2.5"));
  });

  it("a promoted FIRST release remains guarded after an ambiguous promotion (R9-3)", async () => {
    const store = memoryStore();
    store.setFailOncePut("updates/latest.json");
    await expect(stageRelease(baseArgs(store))).rejects.toThrow(/PROMOTION AMBIGUOUS on the FIRST release/);
    const guard = standingGuard(store)!;
    expect(guard.resolved).not.toBe(true);
    expect(guard.releaseId).toMatch(/^1\.2\.3@sha256:/);
    await expect(stageRelease(baseArgs(store))).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);
  });

  it("resolveReleaseGuard resolves ONLY the exact guard — guard A is never resolved by release B (R9-3)", async () => {
    const store = memoryStore();
    const result = await stageRelease(baseArgs(store)); // guard A standing (pending)

    // Wrong release id — refused.
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease",
        store,
        releaseId: `1.2.4@sha256:${"cd".repeat(32)}`,
        newPointerSha256: "cd".repeat(32),
        log: () => {},
      }),
    ).rejects.toThrow(/never be resolved by release B/);

    // Right id, wrong digest — refused.
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease",
        store,
        releaseId: result.releaseId,
        newPointerSha256: "cd".repeat(32),
        log: () => {},
      }),
    ).rejects.toThrow(/pointer digest does not match/);

    // Right identity but the live pointer MOVED — refused (a guard is never
    // resolved around a pointer that isn't the guarded manifest).
    const moved = memoryStore();
    const r2 = await stageRelease(baseArgs(moved));
    moved.objects.set("updates/latest.json", Buffer.from(JSON.stringify({ version: "9.9.9" })));
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease",
        store: moved,
        releaseId: r2.releaseId,
        newPointerSha256: r2.newPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/pointer moved|not the guarded manifest/);
    expect(standingGuard(moved)!.pending).toBe(true);

    // The exact guard resolves; a repeat is idempotent.
    await resolveReleaseGuard({ quiescence: "release-lease", store, releaseId: result.releaseId, newPointerSha256: result.newPointerSha256, log: () => {} });
    await resolveReleaseGuard({ quiescence: "release-lease", store, releaseId: result.releaseId, newPointerSha256: result.newPointerSha256, log: () => {} });
    expect(standingGuard(store)!.resolved).toBe(true);

    // Absent guard: refused (nothing is fabricated).
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease", store: memoryStore(), releaseId: "x@sha256:ab", newPointerSha256: "ab", log: () => {} }),
    ).rejects.toThrow(/no guard object exists/);
  });

  it("a VERIFIED RESTORE does NOT resolve the guard — only the explicit post-verification operation does (R10-3)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store)); // 1.2.3 live
    const preBytes = store.snapshot()["updates/latest.json"];
    const upgraded = await stageRelease(upgradeArgs(store)); // 1.2.4 promoted, guard pending
    const pre: Record<string, unknown> = {
      pointerPresent: true,
      pointerBase64: preBytes,
      previousVersion: "1.2.3",
      previousDmgSha256: "ab".repeat(32),
      newManifestBase64: store.snapshot()["updates/latest.json"],
      newVersion: "1.2.4",
      releaseId: upgraded.releaseId,
      newPointerSha256: upgraded.newPointerSha256,
      promotionAttempted: true,
    };

    // The conditional restore succeeds — and the guard REMAINS PENDING: a
    // restored pointer is a claim until the restored origin passes the full
    // public verification battery (payload hash, DMG hash, .sig equality,
    // cryptographic minisign).
    const report = await restorePointer({ store, preStage: pre, log: () => {} });
    expect(report.action).toBe("restored");
    expect(report.restoredPointerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(standingGuard(store)!.pending).toBe(true);

    // Failed restored-origin verification = the workflow never calls the
    // resolution op → later releases stay blocked.
    await expect(stageRelease(upgradeArgs(store))).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);

    // After verification passes, the EXPLICIT operation — original guard
    // identity + the verified restored digest — resolves it.
    await resolveRestoredGuard({ quiescence: "release-lease",
      store,
      releaseId: upgraded.releaseId,
      newPointerSha256: upgraded.newPointerSha256,
      restoredPointerSha256: report.restoredPointerSha256,
      log: () => {},
    });
    expect(standingGuard(store)!.resolved).toBe(true);
  });

  it("resolveRestoredGuard refuses every inexact case and leaves the guard pending (R10-3)", async () => {
    const setup = async () => {
      const store = memoryStore();
      await publishResolved(store, baseArgs(store));
      const preBytes = store.snapshot()["updates/latest.json"];
      const upgraded = await stageRelease(upgradeArgs(store));
      const pre = {
        pointerPresent: true,
        pointerBase64: preBytes,
        previousVersion: "1.2.3",
        previousDmgSha256: "ab".repeat(32),
        newManifestBase64: store.snapshot()["updates/latest.json"],
        newVersion: "1.2.4",
        releaseId: upgraded.releaseId,
        newPointerSha256: upgraded.newPointerSha256,
        promotionAttempted: true,
      };
      const report = await restorePointer({ store, preStage: pre, log: () => {} });
      return { store, upgraded, report };
    };

    // Wrong release id (guard A / release B).
    {
      const { store, upgraded, report } = await setup();
      await expect(
        resolveRestoredGuard({ quiescence: "release-lease",
          store,
          releaseId: `9.9.9@sha256:${"cd".repeat(32)}`,
          newPointerSha256: upgraded.newPointerSha256,
          restoredPointerSha256: report.restoredPointerSha256,
          log: () => {},
        }),
      ).rejects.toThrow(/never be resolved by release B/);
      expect(standingGuard(store)!.pending).toBe(true);
    }
    // Wrong guarded-pointer digest.
    {
      const { store, upgraded, report } = await setup();
      await expect(
        resolveRestoredGuard({ quiescence: "release-lease",
          store,
          releaseId: upgraded.releaseId,
          newPointerSha256: "cd".repeat(32),
          restoredPointerSha256: report.restoredPointerSha256,
          log: () => {},
        }),
      ).rejects.toThrow(/pointer digest does not match/);
      expect(standingGuard(store)!.pending).toBe(true);
    }
    // The live pointer moved after the restore (restored digest stale).
    {
      const { store, upgraded, report } = await setup();
      store.objects.set("updates/latest.json", Buffer.from(JSON.stringify({ version: "9.9.9" })));
      await expect(
        resolveRestoredGuard({ quiescence: "release-lease",
          store,
          releaseId: upgraded.releaseId,
          newPointerSha256: upgraded.newPointerSha256,
          restoredPointerSha256: report.restoredPointerSha256,
          log: () => {},
        }),
      ).rejects.toThrow(/not the VERIFIED restored pointer/);
      expect(standingGuard(store)!.pending).toBe(true);
    }
    // Missing identity inputs are refused outright.
    {
      const { store, report } = await setup();
      await expect(
        resolveRestoredGuard({ quiescence: "release-lease",
          store,
          releaseId: "",
          newPointerSha256: "",
          restoredPointerSha256: report.restoredPointerSha256,
          log: () => {},
        }),
      ).rejects.toThrow(/all required/);
      expect(standingGuard(store)!.pending).toBe(true);
    }
  });

  it("an UNIDENTIFIED guard is never accepted as any release's own — arm, resolve, or restore-resolve (R10-3)", async () => {
    // A standing unresolved guard with NO release id blocks everything and
    // survives every automatic path.
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    await store.put(
      "updates/unresolved.json",
      Buffer.from(JSON.stringify({ pending: true, description: "armed by an unknown run" })),
    );

    // stageRelease refuses to publish over it…
    await expect(stageRelease(upgradeArgs(store))).rejects.toThrow(/UNRESOLVED RELEASE GUARD/);
    // …resolveReleaseGuard refuses to claim it…
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease",
        store,
        releaseId: `1.2.3@sha256:${"ab".repeat(32)}`,
        newPointerSha256: "ab".repeat(32),
        log: () => {},
      }),
    ).rejects.toThrow(/unidentified guard is never resolved/);
    // …and resolveRestoredGuard refuses too.
    await expect(
      resolveRestoredGuard({ quiescence: "release-lease",
        store,
        releaseId: `1.2.3@sha256:${"ab".repeat(32)}`,
        newPointerSha256: "ab".repeat(32),
        restoredPointerSha256: "ab".repeat(32),
        log: () => {},
      }),
    ).rejects.toThrow(/unidentified guard is never resolved/);
    const guard = standingGuard(store)!;
    expect(guard.pending).toBe(true);
    expect(guard.releaseId ?? null).toBeNull();
  });

  it("guard A / guard B interleaving: release A's restore flow never resolves release B's guard (R10-3)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store)); // 1.2.3 live
    const preBytes = store.snapshot()["updates/latest.json"];
    const upgraded = await stageRelease(upgradeArgs(store)); // A = 1.2.4, guard A pending

    // Release B's guard replaces the standing one (an interleaved run).
    await store.put(
      "updates/unresolved.json",
      Buffer.from(
        JSON.stringify({ pending: true, releaseId: "9.9.9@sha256:other", newPointerSha256: "ef".repeat(32) }),
      ),
    );

    const pre = {
      pointerPresent: true,
      pointerBase64: preBytes,
      previousVersion: "1.2.3",
      previousDmgSha256: "ab".repeat(32),
      newManifestBase64: store.snapshot()["updates/latest.json"],
      newVersion: "1.2.4",
      releaseId: upgraded.releaseId,
      newPointerSha256: upgraded.newPointerSha256,
      promotionAttempted: true,
    };
    const report = await restorePointer({ store, preStage: pre, log: () => {} });
    expect(report.action).toBe("restored");
    // Guard B is untouched by A's restore…
    expect(standingGuard(store)!.releaseId).toBe("9.9.9@sha256:other");
    expect(standingGuard(store)!.pending).toBe(true);
    // …and A's explicit resolution refuses to touch it.
    await expect(
      resolveRestoredGuard({ quiescence: "release-lease",
        store,
        releaseId: upgraded.releaseId,
        newPointerSha256: upgraded.newPointerSha256,
        restoredPointerSha256: report.restoredPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/guard A must never be resolved by release B/);
    expect(standingGuard(store)!.pending).toBe(true);
  });

  it("the EXACT race: B replaces the guard after A's live read, before A's resolution write — A must not overwrite B (R11-1)", async () => {
    // resolveReleaseGuard: A validated its own guard and the live pointer;
    // in the window before A's write, concurrent release B arms ITS guard.
    const store = memoryStore();
    const a = await stageRelease(baseArgs(store)); // guard A pending, 1.2.3 live
    const guardB = Buffer.from(
      JSON.stringify({ pending: true, releaseId: "9.9.9@sha256:bbbb", newPointerSha256: "bb".repeat(32) }),
    );
    let liveReadSeen = false;
    const racy = {
      async put(k: string, b: Bytes) {
        return store.put(k, b);
      },
      async get(k: string) {
        const v = await store.get(k);
        if (k === "updates/latest.json" && !liveReadSeen) {
          // Immediately AFTER A's live read, B's guard lands.
          liveReadSeen = true;
          await store.put("updates/unresolved.json", guardB);
        }
        return v;
      },
      putIfMatch: (k: string, b: Bytes, e: Bytes | null) => store.putIfMatch(k, b, e),
    };
    await expect(
      resolveReleaseGuard({
        quiescence: "release-lease",
        store: racy,
        releaseId: a.releaseId,
        newPointerSha256: a.newPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/guard changed while this resolution was validating/);
    const standing = standingGuard(store)!;
    expect(standing.pending, "B's guard survives, still blocking").toBe(true);
    expect(standing.releaseId).toBe("9.9.9@sha256:bbbb");

    // resolveRestoredGuard: the same interleaving.
    const store2 = memoryStore();
    await publishResolved(store2, baseArgs(store2));
    const pre2Bytes = store2.snapshot()["updates/latest.json"];
    const b2 = await stageRelease(
      baseArgs(store2, {
        version: "v1.2.4",
        manifest: manifestFor("1.2.4"),
        payload: Buffer.from("p2"),
        dmg: Buffer.from("d2"),
      }),
    );
    const report = await restorePointer({
      store: store2,
      preStage: {
        pointerPresent: true,
        pointerBase64: pre2Bytes,
        previousVersion: "1.2.3",
        previousDmgSha256: "ab".repeat(32),
        newManifestBase64: store2.snapshot()["updates/latest.json"],
        newVersion: "1.2.4",
        releaseId: b2.releaseId,
        newPointerSha256: b2.newPointerSha256,
        promotionAttempted: true,
      },
      log: () => {},
    });
    let liveReadSeen2 = false;
    const racy2 = {
      async put(k: string, b: Bytes) {
        return store2.put(k, b);
      },
      async get(k: string) {
        const v = await store2.get(k);
        if (k === "updates/latest.json" && !liveReadSeen2) {
          liveReadSeen2 = true;
          await store2.put("updates/unresolved.json", guardB);
        }
        return v;
      },
      putIfMatch: (k: string, b: Bytes, e: Bytes | null) => store2.putIfMatch(k, b, e),
    };
    await expect(
      resolveRestoredGuard({
        quiescence: "release-lease",
        store: racy2,
        releaseId: b2.releaseId,
        newPointerSha256: b2.newPointerSha256,
        restoredPointerSha256: report.restoredPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/guard changed while this resolution was validating/);
    const standing2 = standingGuard(store2)!;
    expect(standing2.pending).toBe(true);
    expect(standing2.releaseId).toBe("9.9.9@sha256:bbbb");
  });

  it("both resolvers REFUSE without the asserted quiescence precondition (R11-1)", async () => {
    const store = memoryStore();
    const a = await stageRelease(baseArgs(store));
    await expect(
      resolveReleaseGuard({
        store,
        releaseId: a.releaseId,
        newPointerSha256: a.newPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/quiescence is required/);
    await expect(
      resolveRestoredGuard({
        store,
        releaseId: a.releaseId,
        newPointerSha256: a.newPointerSha256,
        restoredPointerSha256: a.newPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/quiescence is required/);
    expect(standingGuard(store)!.pending).toBe(true);
  });

  it("IDEMPOTENT resolution still validates id, digest, and the current live state (R10-3)", async () => {
    const store = memoryStore();
    const result = await publishResolved(store, baseArgs(store)); // resolved guard standing
    // Wrong digest against a RESOLVED guard: refused, not silently OK.
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease",
        store,
        releaseId: result.releaseId,
        newPointerSha256: "cd".repeat(32),
        log: () => {},
      }),
    ).rejects.toThrow(/pointer digest does not match/);
    // Moved live pointer against a RESOLVED guard: refused.
    const savedLive = store.objects.get("updates/latest.json");
    store.objects.set("updates/latest.json", Buffer.from(JSON.stringify({ version: "9.9.9" })));
    await expect(
      resolveReleaseGuard({ quiescence: "release-lease",
        store,
        releaseId: result.releaseId,
        newPointerSha256: result.newPointerSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/pointer moved|not the guarded manifest/);
    store.objects.set("updates/latest.json", savedLive);
    // Exact identity + unmoved pointer: the idempotent path revalidates and passes.
    await resolveReleaseGuard({ quiescence: "release-lease",
      store,
      releaseId: result.releaseId,
      newPointerSha256: result.newPointerSha256,
      log: () => {},
    });
    expect(standingGuard(store)!.resolved).toBe(true);
  });
});

describe("restorePointer — the workflow's exact pre-stage recovery (R5)", () => {
  it("refuses to RESTORE a pre-stage pointer whose entries carry DIFFERENT signatures (R10-3 contract row)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const bad = JSON.parse(Buffer.from(store.snapshot()["updates/latest.json"], "base64").toString());
    bad.platforms["darwin-x86_64"].signature = SIG_B64_ALT;
    const pre = {
      pointerPresent: true,
      pointerBase64: Buffer.from(JSON.stringify(bad)).toString("base64"),
      previousVersion: "1.2.3",
      previousDmgSha256: "ab".repeat(32),
      newManifestBase64: store.snapshot()["updates/latest.json"],
      newVersion: "1.2.4",
      releaseId: `1.2.4@sha256:${"ef".repeat(32)}`,
      newPointerSha256: "ef".repeat(32),
      promotionAttempted: true,
    };
    // Make the live pointer equal the "new manifest" so a restore is warranted.
    await store.put("updates/latest.json", Buffer.from(pre.newManifestBase64, "base64"));
    await expect(restorePointer({ store, preStage: pre, log: () => {} })).rejects.toThrow(
      /RESTORE NOT ATTEMPTED[\s\S]*signature differs from the other entries/,
    );
  });

  function preStageFor(store: ReturnType<typeof memoryStore>, newManifestB64: string) {
    const live = store.snapshot()["updates/latest.json"] ?? null;
    return {
      pointerPresent: live != null,
      pointerBase64: live,
      previousVersion: live ? JSON.parse(Buffer.from(live, "base64").toString()).version : null,
      previousDmgSha256: "ab".repeat(32),
      newManifestBase64: newManifestB64,
      newVersion: "1.2.4",
      releaseId: `1.2.4@sha256:${"ef".repeat(32)}`,
      newPointerSha256: "ef".repeat(32),
      promotionAttempted: true,
    };
  }

  it("restores the exact pre-stage pointer when the new manifest is live (failure after promotion, before postverify)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const pre = preStageFor(store, "");
    await stageRelease(baseArgs(store, { version: "v1.2.4", manifest: manifestFor("1.2.4"), payload: Buffer.from("p2"), dmg: Buffer.from("d2") }));
    pre.newManifestBase64 = store.snapshot()["updates/latest.json"];

    const report = await restorePointer({ store, preStage: pre, log: () => {} });
    expect(report.action).toBe("restored");
    expect(report.version).toBe("1.2.3");
    expect(report.previousDmgSha256).toBe("ab".repeat(32));
    expect(store.snapshot()["updates/latest.json"]).toBe(pre.pointerBase64);
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("restorePointer WITHOUT compare-and-swap reports the live state instead of writing (R7-6)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const pre = preStageFor(store, "");
    await stageRelease(baseArgs(store, { version: "v1.2.4", manifest: manifestFor("1.2.4"), payload: Buffer.from("p2"), dmg: Buffer.from("d2") }));
    pre.newManifestBase64 = store.snapshot()["updates/latest.json"];
    const before = store.snapshot()["updates/latest.json"];

    // Like the production wrangler store: put/get only, no putIfMatch.
    const nonCas = {
      get: (k: string) => store.get(k),
      put: (k: string, b: Bytes) => store.put(k, b),
    };
    await expect(restorePointer({ store: nonCas, preStage: pre, log: () => {} })).rejects.toThrow(
      /RESTORE NOT ATTEMPTED[\s\S]*no conditional write[\s\S]*naming version 1\.2\.4/,
    );
    expect(store.snapshot()["updates/latest.json"]).toBe(before);
  });

  it("restorePointer's conditional write refuses a pointer that moved after its read — concurrent 2.0.0 stays live (R7-6)", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const pre = preStageFor(store, "");
    await stageRelease(baseArgs(store, { version: "v1.2.4", manifest: manifestFor("1.2.4"), payload: Buffer.from("p2"), dmg: Buffer.from("d2") }));
    pre.newManifestBase64 = store.snapshot()["updates/latest.json"];

    const concurrent = Buffer.from(
      JSON.stringify({
        version: "2.0.0",
        platforms: { "darwin-aarch64": { url: "https://readthroughline.com/updates/Throughline-2.0.0-cdcdcdcdcdcd.app.tar.gz", signature: SIG_B64 } },
        dmg: { url: "https://readthroughline.com/updates/Throughline-2.0.0-cdcdcdcdcdcd.dmg", key: "updates/Throughline-2.0.0-cdcdcdcdcdcd.dmg", sha256: "cd".repeat(32) },
      }),
    );
    let injectAfterRead = true;
    const racy = {
      async get(k: string) {
        const value = await store.get(k);
        if (k === "updates/latest.json" && injectAfterRead) {
          injectAfterRead = false;
          await store.put(k, concurrent); // the concurrent publish wins the race
        }
        return value;
      },
      put: (k: string, b: Bytes) => store.put(k, b),
      putIfMatch: (k: string, b: Bytes, e: Bytes | null) => store.putIfMatch(k, b, e),
    };
    await expect(restorePointer({ store: racy, preStage: pre, log: () => {} })).rejects.toThrow(
      /ROLLBACK IMPOSSIBLE[\s\S]*conditional restore did not apply/,
    );
    expect(Buffer.from(store.snapshot()["updates/latest.json"], "base64").toString()).toBe(
      concurrent.toString(),
    );
  });

  it("is a no-op when the live pointer is already the pre-stage release", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const pre = preStageFor(store, Buffer.from("never promoted").toString("base64"));
    const report = await restorePointer({ store, preStage: pre, log: () => {} });
    expect(report.action).toBe("already-pre-stage");
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("reports still-absent when nothing was ever promoted on a first release", async () => {
    const store = memoryStore();
    const pre = {
      pointerPresent: false,
      pointerBase64: null,
      previousVersion: null,
      previousDmgSha256: null,
      newManifestBase64: Buffer.from("new").toString("base64"),
      newVersion: "1.2.3",
      promotionAttempted: true,
    };
    const report = await restorePointer({ store, preStage: pre, log: () => {} });
    expect(report.action).toBe("still-absent");
  });

  it("a PROMOTED first release cannot be restored-to-absent — ROLLBACK IMPOSSIBLE, loudly", async () => {
    const store = memoryStore();
    await stageRelease(baseArgs(store)); // first release promoted
    const pre = {
      pointerPresent: false,
      pointerBase64: null,
      previousVersion: null,
      previousDmgSha256: null,
      newManifestBase64: store.snapshot()["updates/latest.json"],
      newVersion: "1.2.3",
      promotionAttempted: true,
    };
    await expect(restorePointer({ store, preStage: pre, log: () => {} })).rejects.toThrow(
      /ROLLBACK IMPOSSIBLE: the FIRST release/,
    );
  });

  it("refuses to touch a pointer that is NEITHER the pre-stage nor this run's manifest", async () => {
    const store = memoryStore();
    await publishResolved(store, baseArgs(store));
    const pre = preStageFor(store, Buffer.from("this run's manifest").toString("base64"));
    // A concurrent publish moved the pointer underneath the run.
    store.objects.set("updates/latest.json", Buffer.from(JSON.stringify({ version: "9.9.9" })));
    await expect(restorePointer({ store, preStage: pre, log: () => {} })).rejects.toThrow(
      /ROLLBACK IMPOSSIBLE: the live updates\/latest\.json is neither/,
    );
  });
});

describe("stageRelease — OLD-OR-NEW invariant under failure at EVERY operation boundary", () => {
  it("an injected failure at every store operation leaves a complete, coherent release (old or new), never a mixed tuple", async () => {
    // First, count the operations of a clean successful upgrade run.
    const probe = memoryStore();
    await publishResolved(probe, baseArgs(probe)); // publish 1.2.3 as the live release
    const opsBeforeUpgrade = probe.ops.length;
    await stageRelease(baseArgs(probe, { version: "v1.2.4", manifest: manifestFor("1.2.4"), payload: Buffer.from("payload v2"), dmg: Buffer.from("dmg v2") }));
    const upgradeOps = probe.ops.length - opsBeforeUpgrade;
    expect(upgradeOps).toBeGreaterThan(5);

    // Now inject a failure at EVERY boundary: before op 1, between each pair,
    // and after the last (failAtOp = upgradeOps means no failure → sanity).
    for (let failAt = 0; failAt <= upgradeOps; failAt++) {
      const store = memoryStore();
      await publishResolved(store, baseArgs(store)); // live: complete 1.2.3
      const oldSnapshot = store.snapshot();
      store.ops.length = 0;
      store.setFailAtOp(failAt);

      const attempt = stageRelease(
        baseArgs(store, {
          version: "v1.2.4",
          manifest: manifestFor("1.2.4"),
          payload: Buffer.from("payload v2"),
          dmg: Buffer.from("dmg v2"),
        }),
      );
      if (failAt >= upgradeOps) {
        await attempt; // no injection reached → the upgrade completes
      } else {
        // Near the promotion boundary the engine's R5 recovery runs extra
        // (also-failing) operations, so the surfaced message may be the
        // restoration/impossible report rather than the raw injection — the
        // run must reject either way, and the store invariant below is what
        // actually matters.
        await expect(attempt).rejects.toThrow();
      }
      store.setFailAtOp(null);

      // THE invariant: whatever the failure point, the live pointer names a
      // COMPLETE tuple, and it is either exactly the old release or the new one.
      const liveVersion = assertCoherent(store);
      expect(["1.2.3", "1.2.4"]).toContain(liveVersion);
      if (liveVersion === "1.2.3") {
        // Old release: its manifest must be BYTE-identical to before the run.
        expect(store.snapshot()["updates/latest.json"]).toBe(oldSnapshot["updates/latest.json"]);
      }
    }
  });
});

describe("wranglerStore.get — null ONLY for confirmed not-found", () => {
  it("maps a confirmed object-not-found to null", async () => {
    const store = wranglerStore({
      bucket: "b",
      runner: () => ({ status: 1, stderr: Buffer.from("The specified key does not exist. [code: 10007]") }),
    });
    expect(await store.get("updates/latest.json")).toBeNull();
  });

  it("THROWS on auth/permission/network/CLI failures instead of pretending absence", async () => {
    for (const stderr of [
      "Authentication error [code: 10000]",
      "You do not have permission to access this bucket",
      "fetch failed: network timeout",
      "Unknown internal wrangler crash",
    ]) {
      const store = wranglerStore({ bucket: "b", runner: () => ({ status: 1, stderr: Buffer.from(stderr) }) });
      await expect(store.get("updates/latest.json"), stderr).rejects.toThrow(/failed \(not a not-found\)/);
    }
  });

  it("isNotFoundStderr recognizes ONLY R2 object-not-found shapes (R4 narrowing)", () => {
    // Confirmed object absence — the only null-worthy shapes.
    expect(isNotFoundStderr("The specified key does not exist.")).toBe(true);
    expect(isNotFoundStderr("The specified object does not exist. [code: 10007]")).toBe(true);
    expect(isNotFoundStderr("NoSuchKey: the object was not found")).toBe(true);
    // Everything below matched the old generic /not found|404/ and would have
    // silently bypassed the downgrade + rerun guards.
    expect(isNotFoundStderr("Authentication token not found")).toBe(false);
    expect(isNotFoundStderr("endpoint not found (404)")).toBe(false);
    expect(isNotFoundStderr("wrangler: command not found")).toBe(false);
    expect(isNotFoundStderr("The specified bucket does not exist. [code: 10006]")).toBe(false);
    expect(isNotFoundStderr("NoSuchBucket")).toBe(false);
    expect(isNotFoundStderr("bucket throughline-downloads not found")).toBe(false);
    expect(isNotFoundStderr("Authentication error")).toBe(false);
    expect(isNotFoundStderr("permission denied")).toBe(false);
  });

  it("a missing BUCKET (or auth-token/endpoint/command not-found) THROWS from get instead of returning null", async () => {
    for (const stderr of [
      "The specified bucket does not exist. [code: 10006]",
      "Authentication token not found",
      "endpoint not found (404)",
      "sh: wrangler: command not found",
    ]) {
      const store = wranglerStore({ bucket: "b", runner: () => ({ status: 1, stderr: Buffer.from(stderr) }) });
      await expect(store.get("updates/latest.json"), stderr).rejects.toThrow(/failed \(not a not-found\)/);
    }
  });
});

describe("wranglerStore.put — cache posture per object class (R4)", () => {
  function captureArgs() {
    const calls: string[][] = [];
    const runner = (args: string[]) => {
      calls.push(args);
      return { status: 0, stderr: Buffer.from("") };
    };
    return { calls, runner };
  }

  it("pointers are no-store; immutable content-addressed artifacts cache hard", async () => {
    const { calls, runner } = captureArgs();
    const store = wranglerStore({ bucket: "b", runner });
    await store.put("updates/latest.json", Buffer.from("{}"), { contentType: "application/json" });
    await store.put("updates/rollback.json", Buffer.from("{}"), { contentType: "application/json" });
    await store.put("updates/unresolved.json", Buffer.from("{}"), { contentType: "application/json" });
    await store.put("updates/Throughline-1.2.3-abcdef123456.dmg", Buffer.from("dmg"), { contentType: "application/octet-stream" });

    const cacheOf = (i: number) => calls[i][calls[i].indexOf("--cache-control") + 1];
    expect(cacheOf(0)).toBe("no-store");
    expect(cacheOf(1)).toBe("no-store");
    // R9-3: the unresolved-release guard is a mutable pointer — never cached.
    expect(cacheOf(2)).toBe("no-store");
    expect(cacheOf(3)).toBe("public, max-age=31536000, immutable");
  });
});

describe("rollbackPointer — the one-pointer rollback after a failed public verification (R4/R9-4)", () => {
  const sha256Of = (b64: string) =>
    createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

  /** live 1.2.4 with rollback.json retaining 1.2.3; returns the operator's
   *  pinned expectations. */
  async function liveWithRollback(store: ReturnType<typeof memoryStore>) {
    await publishResolved(store, baseArgs(store)); // 1.2.3 live
    const oldManifest = store.snapshot()["updates/latest.json"];
    await publishResolved(
      store,
      baseArgs(store, {
        version: "v1.2.4",
        manifest: manifestFor("1.2.4"),
        payload: Buffer.from("payload v2"),
        dmg: Buffer.from("dmg v2"),
      }),
    );
    return {
      oldManifest,
      bound: {
        expectedLiveVersion: "1.2.4",
        expectedRollbackSha256: sha256Of(store.snapshot()["updates/rollback.json"]),
      },
    };
  }

  it("REFUSES without the bound expectations — a rollback must name what it rolls back from and pin what it restores (R9-4)", async () => {
    const store = memoryStore();
    const { bound } = await liveWithRollback(store);
    const before = store.snapshot()["updates/latest.json"];
    await expect(rollbackPointer({ store, log: () => {} })).rejects.toThrow(
      /ROLLBACK NOT ATTEMPTED[\s\S]*--expect-live-version/,
    );
    await expect(
      rollbackPointer({ store, expectedLiveVersion: "1.2.4", log: () => {} }),
    ).rejects.toThrow(/ROLLBACK NOT ATTEMPTED[\s\S]*--expect-rollback-sha256/);
    await expect(
      rollbackPointer({
        store,
        expectedLiveVersion: "v1.2.4", // not canonical
        expectedRollbackSha256: bound.expectedRollbackSha256,
        log: () => {},
      }),
    ).rejects.toThrow(/ROLLBACK NOT ATTEMPTED/);
    expect(store.snapshot()["updates/latest.json"]).toBe(before);
  });

  it("rollbackPointer WITHOUT compare-and-swap refuses — never a check-then-overwrite (R8-5)", async () => {
    const store = memoryStore();
    const { bound } = await liveWithRollback(store);
    const before = store.snapshot()["updates/latest.json"];
    const nonCas = {
      get: (k: string) => store.get(k),
      put: (k: string, b: Bytes) => store.put(k, b),
    };
    await expect(rollbackPointer({ store: nonCas, ...bound, log: () => {} })).rejects.toThrow(
      /ROLLBACK NOT ATTEMPTED[\s\S]*no conditional write/,
    );
    expect(store.snapshot()["updates/latest.json"]).toBe(before);
  });

  it("puts the retained manifest back as THE pointer and the live state is coherent again", async () => {
    const store = memoryStore();
    const { oldManifest, bound } = await liveWithRollback(store);
    expect(assertCoherent(store)).toBe("1.2.4");

    // Post-switch public verification failed → roll back, with the state the
    // operator saw pinned explicitly.
    const rolledTo = await rollbackPointer({ store, ...bound, log: () => {} });
    expect(rolledTo).toBe("1.2.3");
    // The live pointer is BYTE-identical to the pre-switch manifest, and the
    // complete old tuple it names still exists (immutables are never deleted).
    expect(store.snapshot()["updates/latest.json"]).toBe(oldManifest);
    expect(assertCoherent(store)).toBe("1.2.3");
  });

  it("a STALE rollback read can never overwrite a NEWER concurrent release — live moved (R9-4)", async () => {
    // The exact scenario: the operator reads rollback v1 while 1.2.4 is live;
    // a CONCURRENT release publishes latest 3.0.0 (rolling rollback.json to
    // 1.2.4). The stale rollback attempt must refuse on BOTH binds: the live
    // pointer no longer names 1.2.4, and rollback.json no longer hashes to
    // the pinned digest.
    const store = memoryStore();
    const { bound } = await liveWithRollback(store); // operator pins this state
    await publishResolved(
      store,
      baseArgs(store, {
        version: "v3.0.0",
        manifest: manifestFor("3.0.0"),
        payload: Buffer.from("payload v3"),
        dmg: Buffer.from("dmg v3"),
      }),
    ); // the concurrent release
    const liveAfterConcurrent = store.snapshot()["updates/latest.json"];

    await expect(rollbackPointer({ store, ...bound, log: () => {} })).rejects.toThrow(
      /ROLLBACK REFUSED[\s\S]*(does not hash to the pinned digest|names "3\.0\.0")/,
    );
    expect(
      store.snapshot()["updates/latest.json"],
      "the concurrent 3.0.0 stays live — the stale rollback wrote nothing",
    ).toBe(liveAfterConcurrent);

    // Even with a freshly-pinned rollback digest, the moved LIVE pointer
    // still refuses (the operator said they were rolling back FROM 1.2.4).
    await expect(
      rollbackPointer({
        store,
        expectedLiveVersion: "1.2.4",
        expectedRollbackSha256: createHash("sha256")
          .update(Buffer.from(store.snapshot()["updates/rollback.json"], "base64"))
          .digest("hex"),
        log: () => {},
      }),
    ).rejects.toThrow(/ROLLBACK REFUSED[\s\S]*names "3\.0\.0", not the expected 1\.2\.4/);
    expect(store.snapshot()["updates/latest.json"]).toBe(liveAfterConcurrent);
  });

  it("refuses to ROLL BACK to a retained manifest whose entries carry DIFFERENT signatures (R10-3 contract row)", async () => {
    const store = memoryStore();
    const { bound } = await liveWithRollback(store);
    const retained = JSON.parse(
      Buffer.from(store.snapshot()["updates/rollback.json"], "base64").toString(),
    );
    retained.platforms["darwin-x86_64"].signature = SIG_B64_ALT;
    const bytes = Buffer.from(JSON.stringify(retained));
    await store.put("updates/rollback.json", bytes);
    await expect(
      rollbackPointer({
        store,
        expectedLiveVersion: bound.expectedLiveVersion,
        expectedRollbackSha256: createHash("sha256").update(bytes).digest("hex"),
        log: () => {},
      }),
    ).rejects.toThrow(/ROLLBACK IMPOSSIBLE[\s\S]*signature differs from the other entries/);
  });

  it("throws ROLLBACK IMPOSSIBLE when nothing was retained, or the retained manifest is unusable", async () => {
    const bound = (bytes: Bytes) => ({
      expectedLiveVersion: "1.2.4",
      expectedRollbackSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await expect(
      rollbackPointer({
        store: memoryStore(),
        expectedLiveVersion: "1.2.4",
        expectedRollbackSha256: "ab".repeat(32),
        log: () => {},
      }),
    ).rejects.toThrow(/ROLLBACK IMPOSSIBLE/);
    const notJson = Buffer.from("not json");
    await expect(
      rollbackPointer({
        store: memoryStore({ "updates/rollback.json": notJson }),
        ...bound(notJson),
        log: () => {},
      }),
    ).rejects.toThrow(/not valid JSON/);
    const nightly = Buffer.from(JSON.stringify({ version: "nightly" }));
    await expect(
      rollbackPointer({
        store: memoryStore({ "updates/rollback.json": nightly }),
        ...bound(nightly),
        log: () => {},
      }),
    ).rejects.toThrow(/no canonical x\.y\.z/);
  });
});

#!/usr/bin/env node
// REL-008: staged, verified, ATOMIC publication of a release to the R2 bucket,
// with the object store injectable so every failure mode is testable without
// credentials.
//
// The promotion model has exactly ONE mutable object — the manifest pointer
// `updates/latest.json`. Everything else is immutable and content-addressed:
//
//   updates/Throughline-<ver>-<sha12>.app.tar.gz      (updater payload)
//   updates/Throughline-<ver>-<sha12>.app.tar.gz.sig  (its minisign signature)
//   updates/Throughline-<ver>-<sha12>.dmg             (the download)
//
// The manifest names ALL of them: the per-platform updater `url`s and a
// top-level `dmg { url, key, sha256 }` block (the Tauri updater ignores
// unknown top-level fields). The website Worker's `/download` route resolves
// the DMG **through the manifest**, so switching the manifest — one atomic R2
// PUT — promotes the complete release tuple at once. An interrupted run leaves
// the old manifest naming the complete old tuple; only the final single PUT
// exposes the new one. Never a mixed tuple.
//
// Additional guarantees:
//   - Rerun-safe: identical bytes at a content-addressed key are skipped; a
//     same-key/different-bytes collision fails loudly.
//   - Monotonic: staging refuses to replace a manifest whose version is NEWER
//     than the one being published (a stale or racing tag cannot downgrade
//     the live pointer). Same-version reruns are allowed.
//   - Every upload is read back and hash-compared before the pointer switch.
//   - The previous manifest is retained as updates/rollback.json first.
//   - The store's `get` returns null ONLY for a confirmed object-not-found;
//     auth/permission/network/CLI failures throw (fail closed, never treated
//     as "absent").
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function contentAddressedKey(version, bytes, ext) {
  const v = String(version).trim().replace(/^v/i, "");
  return `updates/Throughline-${v}-${sha256(bytes).slice(0, 12)}${ext}`;
}

function equalBytes(a, b) {
  return a != null && b != null && a.length === b.length && sha256(a) === sha256(b);
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? "").trim().replace(/^v/i, ""));
  return m ? m.slice(1).map(Number) : null;
}

/** True iff `v` is the CANONICAL x.y.z form our pipeline writes (no v prefix,
 *  no whitespace). The LIVE pointer's version must be canonical: a live
 *  "v1.2.3" would compare unequal to "1.2.3" under string equality and slip
 *  past the same-version byte-identity guard while parsing as the same
 *  release (R5). */
function isCanonicalSemver(v) {
  // R8-5: leading zeros are NOT canonical — "01.2.3" parses as 1.2.3 but
  // fails string equality with it, reopening the same-version bypass the
  // canonicality gate exists to close.
  return typeof v === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
}

/** R8-5: the pipeline's ONLY distribution origin — every updater/DMG URL in
 *  a manifest must live here (mirrored by the Worker). */
export const DIST_ORIGIN = "https://readthroughline.com";

/** R8-5: the ONLY platform keys this pipeline publishes (the generator's
 *  DEFAULT_DARWIN_PLATFORMS) — anything else in a manifest is not ours. */
export const SUPPORTED_PLATFORM_KEYS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "darwin-aarch64-app",
  "darwin-x86_64-app",
];

/** R9-5: canonical base64 → bytes, or null. Node's Buffer.from(s, "base64")
 *  silently skips invalid characters and tolerates noncanonical padding, so
 *  the decode is round-trip checked. */
function decodeCanonicalBase64(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) {
    return null;
  }
  const buf = Buffer.from(s, "base64");
  return buf.toString("base64") === s ? buf : null;
}

/** R9-5: a manifest `signature` must be strict canonical base64 of an ACTUAL
 *  minisign signature document — the exact 4-line structure the shipped
 *  updater's Signature::decode requires (untrusted comment / 74-byte box with
 *  the Ed|ED algorithm / "trusted comment: " line / 64-byte global
 *  signature). "AAAA" is base64; it is not a signature. Structural only —
 *  cryptographic verification stays in the verifier and the updater.
 *  (Mirrored in the site Worker's download.ts.) */
export function isMinisignSignatureDocument(s) {
  const outer = decodeCanonicalBase64(s);
  if (outer == null) return false;
  const lines = outer.toString("utf8").trim().split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.length < 4) return false;
  if (!lines[0].startsWith("untrusted comment:")) return false;
  const box = decodeCanonicalBase64(lines[1].trim());
  if (box == null || box.length !== 74) return false;
  const alg = box.subarray(0, 2).toString("utf8");
  if (alg !== "Ed" && alg !== "ED") return false;
  if (!lines[2].startsWith("trusted comment: ")) return false;
  const globalSig = decodeCanonicalBase64(lines[3].trim());
  return globalSig != null && globalSig.length === 64;
}

/** R6-7/R7-7: THE strict manifest contract — one definition applied to every
 *  manifest this pipeline reads, writes, retains as a rollback target, or
 *  restores (mirrored verbatim in verify-release-assets.mjs and the site
 *  Worker's download.ts):
 *
 *  - canonical x.y.z `version` (no prefix, no whitespace);
 *  - `platforms`: nonempty plain object with at least one `darwin-*` entry,
 *    every entry a plain object whose `url` is a credential-free, query-free,
 *    fragment-free FILE directly under `https://readthroughline.com/updates/`,
 *    tied to this manifest's version and a content-hash segment
 *    (`Throughline-{version}-{sha12}.app.tar.gz`) and IDENTICAL across
 *    entries (one payload per release), and whose `signature` is canonical
 *    base64 of an actual minisign signature document (R9-5);
 *  - LEGACY means the `dmg` property is ABSENT — `dmg: null` is malformed;
 *  - a PRESENT `dmg` is a plain object with a 64-hex `sha256`, a `key` that
 *    IS the content-addressed key for this manifest's version + hash
 *    (`updates/Throughline-{version}-{sha12}.dmg`), and a `url` that is
 *    EXACTLY the distribution origin + that key (R9-5);
 *  - `severity`/`criticalBelow` come TOGETHER or not at all: severity must be
 *    "critical" and criticalBelow a canonical x.y.z no newer than `version`.
 *
 *  Returns a human-readable issue, or null when the contract holds. */
export function manifestContractIssue(m) {
  if (m == null || typeof m !== "object" || Array.isArray(m)) return "not a manifest object";
  if (!isCanonicalSemver(m.version)) return "no canonical x.y.z version";
  const platforms = m.platforms;
  if (platforms == null || typeof platforms !== "object" || Array.isArray(platforms)) {
    return "platforms is not an object";
  }
  const entries = Object.entries(platforms);
  if (entries.length === 0) return "platforms is empty";
  if (!entries.some(([name]) => name.startsWith("darwin-"))) {
    return "no darwin platform entry";
  }
  // R9-5: the updater payload URL, tied to THIS manifest's version and a
  // content-hash segment. One payload per release: every entry must carry
  // the identical URL.
  const payloadUrlPattern = new RegExp(
    `^${DIST_ORIGIN}/updates/Throughline-${m.version.replace(/\./g, "\\.")}-[0-9a-f]{12}\\.app\\.tar\\.gz$`,
  );
  let firstUrl = null;
  let firstSig = null;
  for (const [name, entry] of entries) {
    // R8-5: only the pipeline's own platform keys — an unexpected key is an
    // unexpected manifest, not a new platform.
    if (!SUPPORTED_PLATFORM_KEYS.includes(name)) {
      return `platform ${name} is not a supported darwin key`;
    }
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      return `platform ${name} is not an object`;
    }
    const urlIssue = stringFieldIssue(entry.url, `platform ${name} url`, { url: true });
    if (urlIssue) return urlIssue;
    if (!payloadUrlPattern.test(entry.url)) {
      return `platform ${name} url is not the content-addressed updater payload for version ${m.version}`;
    }
    if (firstUrl == null) firstUrl = entry.url;
    else if (entry.url !== firstUrl) {
      return `platform ${name} url differs from the other entries (one payload per release)`;
    }
    const sigIssue = stringFieldIssue(entry.signature, `platform ${name} signature`);
    if (sigIssue) return sigIssue;
    if (!isMinisignSignatureDocument(entry.signature)) {
      return `platform ${name} signature is not base64 of a minisign signature document`;
    }
    // R10-3: ONE payload → ONE signature. Entries carrying different
    // signature text describe different payloads wearing one manifest.
    if (firstSig == null) firstSig = entry.signature;
    else if (entry.signature !== firstSig) {
      return `platform ${name} signature differs from the other entries (one payload, one signature)`;
    }
  }
  if ("dmg" in m) {
    const dmg = m.dmg;
    if (dmg == null || typeof dmg !== "object" || Array.isArray(dmg)) {
      return "dmg is not an object (legacy means the property is ABSENT, not null)";
    }
    const urlIssue = stringFieldIssue(dmg.url, "dmg url", { url: true });
    if (urlIssue) return urlIssue;
    if (typeof dmg.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(dmg.sha256)) {
      return "dmg.sha256 is not a 64-hex hash";
    }
    const tied = `updates/Throughline-${m.version}-${dmg.sha256.slice(0, 12)}.dmg`;
    if (dmg.key !== tied) {
      return "dmg.key is not the content-addressed key for this manifest's version and hash";
    }
    // R9-5: dmg.url is EXACTLY the distribution origin + dmg.key — never a
    // second, independently-writable location.
    if (dmg.url !== `${DIST_ORIGIN}/${dmg.key}`) {
      return "dmg.url is not the distribution origin + dmg.key";
    }
  }
  // R9-5: severity and criticalBelow are a pair with one valid combination.
  if ("severity" in m || "criticalBelow" in m) {
    if (m.severity !== "critical") {
      return 'severity must be "critical" when present';
    }
    if (!isCanonicalSemver(m.criticalBelow)) {
      return "criticalBelow is not a canonical x.y.z version";
    }
    if (semverGreater(m.criticalBelow, m.version)) {
      return "criticalBelow is newer than the manifest version";
    }
  }
  return null;
}

function stringFieldIssue(value, label, { url = false } = {}) {
  if (typeof value !== "string" || value.length === 0) return `${label} is missing or empty`;
  if (value !== value.trim()) return `${label} has surrounding whitespace`;
  if (url) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return `${label} is not a valid URL`;
    }
    if (parsed.protocol !== "https:") return `${label} is not https`;
    // R8-5: every distribution URL lives on THE distribution origin — an
    // off-origin URL in a manifest points readers somewhere we don't control.
    if (parsed.origin !== DIST_ORIGIN) {
      return `${label} is not on the distribution origin`;
    }
    // R9-5: credential-free, query-free, fragment-free, and a plain FILE
    // directly under /updates/ — nothing else is a distribution URL.
    if (parsed.username !== "" || parsed.password !== "") {
      return `${label} embeds credentials`;
    }
    if (parsed.search !== "") return `${label} carries a query string`;
    if (parsed.hash !== "") return `${label} carries a fragment`;
    if (!/^\/updates\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parsed.pathname)) {
      return `${label} is not a plain file directly under /updates/`;
    }
  }
  return null;
}

/** Semantic (normalized) equality of two version strings. */
export function semverEqual(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  return pa != null && pb != null && pa.every((n, i) => n === pb[i]);
}

/** true iff a > b (both must be valid x.y.z). */
export function semverGreater(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/** Upload one object idempotently and read it back.
 *  - absent → put + read-back verify
 *  - present with identical bytes → skip (rerun-safe)
 *  - present with DIFFERENT bytes → fail loudly (immutability violation) */
async function putImmutable(store, key, bytes, contentType, log) {
  const existing = await store.get(key);
  if (existing != null) {
    if (equalBytes(existing, bytes)) {
      log(`= ${key} already present with identical bytes (rerun) — skipped`);
      return;
    }
    throw new Error(
      `IMMUTABILITY VIOLATION: ${key} already exists with different bytes — refusing to overwrite a published object`,
    );
  }
  await store.put(key, bytes, { contentType });
  const readBack = await store.get(key);
  if (!equalBytes(readBack, bytes)) {
    throw new Error(`read-back mismatch for ${key} after upload`);
  }
  log(`✓ ${key} uploaded and read-back verified (${sha256(bytes).slice(0, 12)})`);
}

/** Replace a mutable POINTER object (single atomic PUT) and read it back. */
async function putPointer(store, key, bytes, contentType, log) {
  await store.put(key, bytes, { contentType });
  const readBack = await store.get(key);
  if (!equalBytes(readBack, bytes)) {
    throw new Error(`read-back mismatch for pointer ${key}`);
  }
  log(`✓ pointer ${key} switched and read-back verified`);
}

export const UNRESOLVED_GUARD_KEY = "updates/unresolved.json";

/** R9-3: the identity of one release attempt — the version plus the digest of
 *  the EXACT pointer bytes it will publish. Deterministic (a byte-identical
 *  rerun is the same attempt); different for any other tuple. */
export function releaseGuardId(version, manifestBytes) {
  return `${version}@sha256:${sha256(manifestBytes)}`;
}

/** R9-3: enrich the standing WRITE-AHEAD guard with a failure description.
 *  The pending guard was written (and read-back verified) BEFORE the pointer
 *  could change, so this update is best-effort context, never the blocking
 *  mechanism itself. A standing guard belonging to a DIFFERENT release is
 *  left untouched — it is already blocking, and its identity must survive.
 *  Returns a suffix for the primary error. */
async function armUnresolvedGuard(store, description, identity = null) {
  try {
    const standing = await store.get(UNRESOLVED_GUARD_KEY);
    if (standing != null) {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.from(standing).toString("utf8"));
      } catch {
        /* unparseable is still a guard */
      }
      // R10-3: a standing unresolved guard that is not PROVABLY this
      // release's own — different id, or carrying NO id at all — is left
      // untouched. An unidentified guard is never adopted: overwriting it
      // with our identity would let this release resolve a block someone
      // else armed.
      if (parsed?.resolved !== true && parsed?.releaseId !== identity?.releaseId) {
        return ` A guard that is not this release's own (${parsed?.releaseId ?? "unidentified"}) is already standing and blocks later releases.`;
      }
    }
    const body = Buffer.from(
      `${JSON.stringify({ pending: true, ...(identity ?? {}), description }, null, 2)}\n`,
    );
    await store.put(UNRESOLVED_GUARD_KEY, body, { contentType: "application/json" });
    return " An UNRESOLVED-RELEASE guard is standing: no later release will publish until an operator verifies updates/latest.json and resolves updates/unresolved.json.";
  } catch (e) {
    return ` (the unresolved-release guard could not even be updated: ${e.message} — treat the pointer as unresolved regardless)`;
  }
}

/** R11-1: the resolvers' concurrency precondition. The guard object has no
 *  conditional write on the production store, so an EXACT no-overwrite
 *  guarantee between two concurrent resolvers is NOT mechanically true —
 *  the identity checks below close every interleaving up to the final
 *  re-read, and the residual window (guard replaced between the re-read and
 *  the resolution PUT) is excluded by EXTERNAL serialization, which every
 *  caller must assert explicitly:
 *  - "release-lease": the GitHub `release-publish` concurrency group (one
 *    release workflow at a time, never cancelled mid-run);
 *  - "operator": the runbook's quiescence step (no workflow running or
 *    queued while an operator resolves by hand). */
function requireQuiescence(quiescence, who) {
  if (quiescence !== "release-lease" && quiescence !== "operator") {
    throw new Error(
      `${who}: quiescence is required ("release-lease" or "operator") — without external ` +
        "serialization a concurrent release's guard could be overwritten in the window between " +
        "this resolver's final read and its write. State how this call is serialized.",
    );
  }
}

/** R9-3/R11-1: resolve the WRITE-AHEAD release guard — only after public
 *  post-verification, and only the EXACT guard this release wrote: the
 *  standing guard's release id AND pointer digest must match, the live
 *  pointer must still BE the guarded manifest, and the guard must still be
 *  byte-identical on a RE-READ immediately before the resolution write.
 *  Under the caller-asserted quiescence (see `requireQuiescence`) that makes
 *  resolving another release's guard impossible; without such serialization
 *  no such absolute holds, which is why the precondition is mandatory. */
export async function resolveReleaseGuard({ store, releaseId, newPointerSha256, quiescence, log = console.log }) {
  if (!store || !releaseId || !newPointerSha256) {
    throw new Error("resolveReleaseGuard: store, releaseId, and newPointerSha256 are all required");
  }
  requireQuiescence(quiescence, "resolveReleaseGuard");
  const guardBytes = await store.get(UNRESOLVED_GUARD_KEY);
  if (guardBytes == null) {
    throw new Error(
      "resolveReleaseGuard: no guard object exists — this release's write-ahead guard is missing; refusing to fabricate a resolution",
    );
  }
  let guard;
  try {
    guard = JSON.parse(Buffer.from(guardBytes).toString("utf8"));
  } catch {
    throw new Error("resolveReleaseGuard: the standing guard is unparseable — operator action required");
  }
  // R10-3: an UNIDENTIFIED guard is never accepted as this release's own —
  // resolved or pending.
  if (guard.releaseId == null) {
    throw new Error(
      "resolveReleaseGuard: the standing guard carries no release id — an unidentified guard is never resolved by any release; operator action required",
    );
  }
  if (guard.releaseId !== releaseId) {
    throw new Error(
      `resolveReleaseGuard: the standing guard records ${guard.releaseId}, not ${releaseId} — guard A must never be resolved by release B`,
    );
  }
  if (guard.newPointerSha256 !== newPointerSha256) {
    throw new Error(
      "resolveReleaseGuard: the standing guard's pointer digest does not match this release — refusing",
    );
  }
  const live = await store.get("updates/latest.json");
  if (live == null || sha256(live) !== newPointerSha256) {
    throw new Error(
      "resolveReleaseGuard: the live pointer is not the guarded manifest — the pointer moved since promotion; operator action required",
    );
  }
  // R10-3: even the IDEMPOTENT path validates everything above first — a
  // "resolved" record is only re-confirmed when id, digest, and the current
  // live state all still hold.
  if (guard.resolved === true) {
    log(`= release guard for ${releaseId} is already resolved (revalidated)`);
    return;
  }
  // R11-1: RE-READ immediately before the write — a guard replaced after the
  // live read (a concurrent release arming its own) must not be overwritten.
  const reread = await store.get(UNRESOLVED_GUARD_KEY);
  if (!equalBytes(reread, guardBytes)) {
    throw new Error(
      "resolveReleaseGuard: the guard changed while this resolution was validating (a concurrent release?) — refusing to overwrite it; the standing guard keeps blocking",
    );
  }
  const resolved = Buffer.from(
    `${JSON.stringify(
      { resolved: true, releaseId, newVersion: guard.newVersion ?? null, newPointerSha256 },
      null,
      2,
    )}\n`,
  );
  await store.put(UNRESOLVED_GUARD_KEY, resolved, { contentType: "application/json" });
  const readBack = await store.get(UNRESOLVED_GUARD_KEY);
  if (!equalBytes(readBack, resolved)) {
    throw new Error("resolveReleaseGuard: the resolution did not read back — treat the release as still guarded");
  }
  log(`✓ release guard resolved for ${releaseId} (public verification confirmed)`);
}

/** R7-6: human-readable description of a live pointer state for operator
 *  recovery reports. */
function describePointer(bytes) {
  if (bytes == null) return "ABSENT";
  try {
    const v = JSON.parse(Buffer.from(bytes).toString("utf8")).version;
    return `a manifest naming version ${v}`;
  } catch {
    return "an UNPARSEABLE manifest";
  }
}

/**
 * Stage and publish a release. `manifest` is the generated latest.json object
 * (see generate-latest-json.mjs); this function is the SINGLE writer of its
 * URL fields (platform urls + the dmg block — they embed the content-addressed
 * keys). Throws on any failure; the ONE mutable pointer is written only after
 * every immutable object is verified, so an interrupted run leaves the
 * previously-published release fully intact and fully coherent.
 */
export async function stageRelease({
  store,
  version,
  origin,
  payload,
  sig,
  dmg,
  manifest,
  severity = "",
  log = console.log,
  /** R5: called with the captured pre-stage state (exact live pointer bytes +
   *  verification anchors) BEFORE anything is uploaded — the workflow persists
   *  it so a failure at ANY later point can restore the exact pre-stage
   *  pointer or prove nothing was promoted. */
  onPreStage = null,
  /** R5: called immediately BEFORE the promotion PUT is issued. From this
   *  moment on, the pointer state is potentially changed — the workflow flips
   *  a durable promotion-attempted marker here, so its failure recovery knows
   *  when a rollback is warranted and never blindly rolls back a failure that
   *  provably happened before promotion. */
  onBeforePromotion = null,
}) {
  if (!store || !version || !origin || !payload || !sig || !dmg || !manifest) {
    throw new Error("stageRelease: store, version, origin, payload, sig, dmg, and manifest are all required");
  }
  const releaseVersion = String(version).trim().replace(/^v/i, "");
  // R4: BOTH versions are validated as strict x.y.z. A tag that isn't a real
  // release version must never reach the store.
  if (!parseSemver(releaseVersion)) {
    throw new Error(`stageRelease: incoming version ${JSON.stringify(String(version))} is not strict x.y.z semver`);
  }

  // R8-5: a prior release that ended AMBIGUOUSLY blocks every later release
  // until an operator resolves it — publishing over an unresolved pointer
  // compounds the ambiguity.
  const guardBytes = await store.get(UNRESOLVED_GUARD_KEY);
  if (guardBytes != null) {
    let parsedGuard = null;
    try {
      parsedGuard = JSON.parse(Buffer.from(guardBytes).toString("utf8"));
    } catch {
      /* an unparseable guard is still a guard */
    }
    if (parsedGuard?.resolved !== true) {
      throw new Error(
        "UNRESOLVED RELEASE GUARD: a prior release is unresolved (in flight, ambiguous, or never publicly verified)" +
          (parsedGuard?.releaseId ? ` — ${parsedGuard.releaseId}` : "") +
          (parsedGuard?.description ? ` (${parsedGuard.description})` : "") +
          ". Verify updates/latest.json against updates/rollback.json, then resolve updates/unresolved.json before publishing.",
      );
    }
  }

  // ── monotonic-version / downgrade guard + rollback source ──
  // One read of the live pointer serves both: a STALE or RACING tag must never
  // replace a newer live release, and the pre-switch manifest is what we
  // retain as the rollback pointer.
  const previous = await store.get("updates/latest.json");
  let previousManifest = null;
  if (previous != null) {
    try {
      previousManifest = JSON.parse(Buffer.from(previous).toString("utf8"));
    } catch {
      throw new Error("the live updates/latest.json is not valid JSON — refusing to publish over an unknown pointer state");
    }
    // R4/R5 fail-closed: a live manifest whose version is missing, malformed,
    // or NONCANONICAL (e.g. "v1.2.3" — parseable but never something this
    // pipeline writes) is an UNKNOWN pointer state — the downgrade and
    // same-version guards compare against it, so nothing may be published
    // over it. Canonicality matters: a live "v1.2.3" would fail string
    // equality with "1.2.3" and let DIFFERENT 1.2.3 artifacts replace a
    // published 1.2.3 without tripping the byte-identity guard.
    if (!isCanonicalSemver(previousManifest.version)) {
      throw new Error(
        "the live updates/latest.json carries no canonical x.y.z version — refusing to publish over an unknown pointer state",
      );
    }
    // R6-7/R7-7: the WHOLE live manifest must satisfy THE manifest contract —
    // darwin platforms with real https urls + signatures, and (when a dmg
    // block is present) a 64-hex hash with its tied content-addressed key.
    // Anything else is an unknown pointer state: the rollback pointer we
    // retain (and could restore) must never be a malformed one.
    const prevIssue = manifestContractIssue(previousManifest);
    if (prevIssue != null) {
      throw new Error(
        `the live updates/latest.json is malformed (${prevIssue}) — refusing to publish over an unknown pointer state`,
      );
    }
    if (semverGreater(previousManifest.version, releaseVersion)) {
      throw new Error(
        `DOWNGRADE REFUSED: live release is ${previousManifest.version}, tag would publish ${releaseVersion} — a stale or concurrent tag must not overwrite a newer release`,
      );
    }
  }

  // ── keys (content-addressed → immutable + rerun-safe) ──
  const payloadKey = contentAddressedKey(releaseVersion, payload, ".app.tar.gz");
  const sigKey = `${payloadKey}.sig`;
  const dmgKey = contentAddressedKey(releaseVersion, dmg, ".dmg");

  // ── finalize the manifest: platform urls + dmg block + severity ──
  const final = JSON.parse(JSON.stringify(manifest));
  if (final.version !== releaseVersion) {
    throw new Error(`manifest version ${final.version} does not match release ${releaseVersion}`);
  }
  const updateUrl = `${origin}/${payloadKey}`;
  for (const value of Object.values(final.platforms ?? {})) {
    if (value && typeof value === "object") value.url = updateUrl;
  }
  const dmgSha = sha256(dmg);
  final.dmg = { url: `${origin}/${dmgKey}`, key: dmgKey, sha256: dmgSha };
  if (severity === "critical") {
    final.severity = "critical";
    final.criticalBelow = releaseVersion;
  }
  // R7-7: the manifest THIS run is about to publish satisfies the same
  // contract every reader of the pointer enforces — self-checked before a
  // single byte is staged.
  const selfIssue = manifestContractIssue(final);
  if (selfIssue != null) {
    throw new Error(`the finalized manifest violates the manifest contract (${selfIssue}) — refusing to stage it`);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(final, null, 2)}\n`);

  // ── R4/R5: a SAME-VERSION rerun is allowed ONLY when it is byte-identical ──
  // The finalized manifest embeds the content-addressed payload/dmg keys (each
  // a hash of its artifact's bytes), the signature text, the pub date, and the
  // severity flags, so byte-equality of the manifests is equality of the whole
  // release tuple. A tag re-cut at the same x.y.z with ANY different byte —
  // payload, signature, DMG, or manifest metadata — is a stealth re-release
  // and is refused before anything is touched. Compared as NORMALIZED semver
  // (belt over the canonicality gate above), never raw strings.
  if (previousManifest != null && semverEqual(previousManifest.version, releaseVersion)) {
    if (!equalBytes(Buffer.from(previous), manifestBytes)) {
      throw new Error(
        `SAME-VERSION RERUN REFUSED: ${releaseVersion} is already live with different bytes — ` +
          "a re-cut tag must bump the version, never silently replace a published release",
      );
    }
    log(`= ${releaseVersion} rerun with a byte-identical tuple — proceeding idempotently`);
  }

  // ── R5/R6-7: capture the EXACT pre-stage pointer + verification anchors ──
  // `previousDmgSha256` lets a rollback verify the served DMG BYTES, not just
  // an HTTP 200 — and it must be REAL, INDEPENDENT evidence, computed from
  // the stored object's bytes, never a copied manifest claim. Missing or
  // contradictory previous-DMG evidence STOPS the release before promotion:
  // a failure recovery that cannot verify its rollback is no recovery.
  let previousDmgSha256 = null;
  if (previousManifest != null) {
    // R7-7: shape questions (64-hex sha256, tied content-addressed key,
    // dmg:null) were already settled by the manifest CONTRACT above — legacy
    // means the property is ABSENT. What remains here is EVIDENCE: the named
    // object must exist and its bytes must hash to the declared sha256.
    if ("dmg" in previousManifest) {
      const declared = previousManifest.dmg.sha256;
      const prevDmgKey = previousManifest.dmg.key;
      const prevDmgBytes = await store.get(prevDmgKey);
      if (prevDmgBytes == null) {
        throw new Error(
          `the live release's DMG object (${prevDmgKey}) is MISSING from the store — refusing to promote over a release that cannot be rolled back to`,
        );
      }
      const computed = sha256(prevDmgBytes);
      if (computed !== declared) {
        throw new Error(
          "the live release's DMG bytes do not hash to its manifest's declared sha256 — the live tuple is corrupt; refusing to promote until an operator verifies it",
        );
      }
      previousDmgSha256 = computed;
    } else {
      const legacy = await store.get("Throughline.dmg");
      if (legacy == null) {
        throw new Error(
          "the live release predates dmg-bearing manifests and the legacy Throughline.dmg object is MISSING — no previous-DMG evidence exists; refusing to promote",
        );
      }
      previousDmgSha256 = sha256(legacy);
    }
  }
  const releaseId = releaseGuardId(releaseVersion, manifestBytes);
  const newPointerSha256 = sha256(manifestBytes);
  const preStage = {
    pointerPresent: previous != null,
    pointerBase64: previous != null ? Buffer.from(previous).toString("base64") : null,
    previousVersion: previousManifest?.version ?? null,
    previousDmgSha256,
    newManifestBase64: manifestBytes.toString("base64"),
    newVersion: releaseVersion,
    releaseId,
    newPointerSha256,
    promotionAttempted: false,
  };
  onPreStage?.(preStage);

  // ── stage 1: the complete immutable tuple ──
  await putImmutable(store, payloadKey, payload, "application/octet-stream", log);
  await putImmutable(store, sigKey, sig, "application/octet-stream", log);
  await putImmutable(store, dmgKey, dmg, "application/octet-stream", log);

  // ── stage 2: retain the previous manifest as the rollback pointer ──
  // R10-3: on a BYTE-IDENTICAL same-version rerun the live pointer IS this
  // release — retaining it would overwrite rollback.json (which still names
  // the release before this one) with the release itself, destroying the
  // only rollback target. The rerun keeps rollback.json untouched.
  if (previous != null) {
    if (previousManifest != null && semverEqual(previousManifest.version, releaseVersion)) {
      log("= same-version rerun — updates/rollback.json left untouched (it still names the prior release)");
    } else {
      await putPointer(store, "updates/rollback.json", Buffer.from(previous), "application/json", log);
    }
  } else {
    log("no existing updates/latest.json — no rollback pointer to retain (first release)");
  }

  // ── stage 2b (R9-3): the WRITE-AHEAD guard — a durable pending record of
  // THIS release (id + exact new-pointer digest), written and READ-BACK
  // VERIFIED before latest.json can change. It stays armed through public
  // post-verification; only resolveReleaseGuard (same id + digest, live
  // pointer still the guarded manifest) resolves it. Runner death at ANY
  // later boundary leaves every later release blocked.
  const pendingGuard = Buffer.from(
    `${JSON.stringify(
      {
        pending: true,
        releaseId,
        newVersion: releaseVersion,
        newPointerSha256,
        description: `release ${releaseVersion} is in flight (promotion and public verification not yet confirmed)`,
      },
      null,
      2,
    )}\n`,
  );
  await store.put(UNRESOLVED_GUARD_KEY, pendingGuard, { contentType: "application/json" });
  const guardReadBack = await store.get(UNRESOLVED_GUARD_KEY);
  if (!equalBytes(guardReadBack, pendingGuard)) {
    throw new Error(
      "the write-ahead release guard did not read back — refusing to touch the pointer without a verified guard in place (the live release is untouched)",
    );
  }
  log(`✓ write-ahead release guard armed for ${releaseId}`);

  // ── stage 3: THE atomic promotion — one PUT of the one mutable pointer,
  // with AMBIGUITY RECOVERY (R5) ──
  onBeforePromotion?.();
  await promotePointer(store, manifestBytes, previous, releaseVersion, log, {
    releaseId,
    newVersion: releaseVersion,
    newPointerSha256,
  });

  return {
    payloadKey,
    sigKey,
    dmgKey,
    updateUrl,
    dmgSha256: dmgSha,
    manifest: final,
    preStage,
    releaseId,
    newPointerSha256,
  };
}

/**
 * R5: the promotion PUT with AMBIGUITY RECOVERY. A failed PUT — or a failed or
 * mismatched read-back after it — leaves it UNKNOWN whether the pointer moved.
 * The engine then restores the EXACT pre-stage pointer bytes it read at the
 * start (and read-back verifies the restoration), or reports rollback
 * impossible loudly. It never returns success on anything but a verified
 * promotion, and never leaves an ambiguous pointer silently in place.
 */
async function promotePointer(store, manifestBytes, previous, releaseVersion, log, identity = null) {
  const key = "updates/latest.json";
  let failure;
  try {
    await store.put(key, manifestBytes, { contentType: "application/json" });
    const readBack = await store.get(key);
    if (readBack != null && equalBytes(readBack, manifestBytes)) {
      log(`✓ pointer ${key} switched and read-back verified`);
      return;
    }
    failure = new Error(`read-back after the promotion PUT did not match (ambiguous pointer state)`);
  } catch (e) {
    failure = e;
  }

  if (previous == null) {
    // First release: there is no pre-stage pointer to restore, and the store
    // offers no delete. Either outcome (absent, or the complete new tuple) is
    // coherent — say so loudly instead of pretending anything was restored.
    const guardNote = await armUnresolvedGuard(
      store,
      `first-release promotion of ${releaseVersion} was ambiguous`,
      identity,
    );
    throw new Error(
      `PROMOTION AMBIGUOUS on the FIRST release (${failure.message}): updates/latest.json may be absent or may already name ${releaseVersion}. ` +
        "Both states are complete; verify the public origin manually before re-running." +
        guardNote,
    );
  }

  // R6-7: NEVER a blind restore. Read the live state first and restore only
  // over a provably-known one — between the failed PUT and now, a CONCURRENT
  // publish may have moved the pointer to a THIRD state that a blind restore
  // would clobber with an older release.
  let live = null;
  let liveKnown = true;
  try {
    live = await store.get(key);
  } catch {
    liveKnown = false;
  }
  if (!liveKnown) {
    const guardNote = await armUnresolvedGuard(
      store,
      `promotion of ${releaseVersion} failed and the live pointer could not be read`,
      identity,
    );
    throw new Error(
      `promotion of ${releaseVersion} failed (${failure.message}) AND the live pointer could not be read — restoring blind could overwrite a concurrent release. ` +
        "The live pointer state is UNKNOWN — operator action required (inspect updates/latest.json before touching anything)." +
        guardNote,
    );
  }
  if (live != null && equalBytes(live, Buffer.from(previous))) {
    throw new Error(
      `promotion of ${releaseVersion} failed (${failure.message}); the live pointer still holds the exact pre-stage release — nothing new is live, nothing needed restoring`,
    );
  }
  if (live != null && !equalBytes(live, manifestBytes)) {
    throw new Error(
      `promotion of ${releaseVersion} failed (${failure.message}) AND ROLLBACK IMPOSSIBLE: the live pointer holds a THIRD state (a concurrent publish?) — ` +
        "restoring the pre-stage bytes would overwrite it. Nothing was touched; operator action required.",
    );
  }
  // live is this run's manifest (the ambiguous PUT landed) or vanished
  // mid-flight — the two states a pre-stage restore is warranted over.
  //
  // R7-6: the restore is a CONDITIONAL write tied to the exact bytes just
  // read. A separate get + unconditional put is not atomic — a concurrent
  // release landing between them would be clobbered. Stores without
  // compare-and-swap never auto-write here: the live state is REPORTED for
  // operator recovery instead.
  if (typeof store.putIfMatch !== "function") {
    const guardNote = await armUnresolvedGuard(
      store,
      `promotion of ${releaseVersion} was ambiguous; live pointer was ${describePointer(live)}`,
      identity,
    );
    throw new Error(
      `promotion of ${releaseVersion} failed (${failure.message}) AND the store offers no conditional write (compare-and-swap) — ` +
        `NOT auto-restoring over a potentially concurrent release. Live pointer state: ${describePointer(live)}. ` +
        `Operator action required: verify updates/latest.json and put updates/rollback.json back ONLY if the live pointer names ${releaseVersion}.` +
        guardNote,
    );
  }
  let restored = false;
  try {
    await store.putIfMatch(
      key,
      Buffer.from(previous),
      live == null ? null : Buffer.from(live),
      { contentType: "application/json" },
    );
    const readBack = await store.get(key);
    restored = readBack != null && equalBytes(readBack, Buffer.from(previous));
  } catch {
    /* precondition failed or the write failed — nothing was overwritten blind */
  }
  if (restored) {
    throw new Error(
      `promotion of ${releaseVersion} failed (${failure.message}); the pointer was RESTORED to the exact pre-stage release (conditional write, read-back verified) — nothing new is live`,
    );
  }
  const guardNote = await armUnresolvedGuard(
    store,
    `promotion of ${releaseVersion} was ambiguous and its conditional restore did not apply`,
    identity,
  );
  throw new Error(
    `promotion of ${releaseVersion} failed (${failure.message}) AND ROLLBACK IMPOSSIBLE: the conditional restore did not apply — ` +
      "the pointer moved after the recovery read (a concurrent publish?) or the write failed. Nothing was overwritten blind. " +
      "Operator action required (inspect updates/latest.json; put updates/rollback.json back only if it still names this run's release)." +
      guardNote,
  );
}

/** R10-3: resolve the write-ahead guard AFTER a verified restore — the
 *  explicit post-verification operation. It carries the ORIGINAL guard
 *  identity (releaseId + newPointerSha256, from the persisted pre-stage
 *  state) plus the digest of the pointer the restore left live, which the
 *  caller has ALREADY verified publicly (payload hashing, DMG hashing, .sig
 *  equality, cryptographic minisign). Every mismatch — unidentified guard,
 *  wrong release, wrong digest, moved pointer — leaves the guard pending. */
export async function resolveRestoredGuard({
  store,
  releaseId,
  newPointerSha256,
  restoredPointerSha256,
  quiescence,
  log = console.log,
}) {
  if (!store || !releaseId || !newPointerSha256 || !restoredPointerSha256) {
    throw new Error(
      "resolveRestoredGuard: store, releaseId, newPointerSha256, and restoredPointerSha256 are all required",
    );
  }
  requireQuiescence(quiescence, "resolveRestoredGuard");
  const guardBytes = await store.get(UNRESOLVED_GUARD_KEY);
  if (guardBytes == null) {
    throw new Error(
      "resolveRestoredGuard: no guard object exists — nothing recorded this release; refusing to fabricate a resolution",
    );
  }
  let guard;
  try {
    guard = JSON.parse(Buffer.from(guardBytes).toString("utf8"));
  } catch {
    throw new Error("resolveRestoredGuard: the standing guard is unparseable — operator action required");
  }
  if (guard.releaseId == null) {
    throw new Error(
      "resolveRestoredGuard: the standing guard carries no release id — an unidentified guard is never resolved by any release; operator action required",
    );
  }
  if (guard.releaseId !== releaseId) {
    throw new Error(
      `resolveRestoredGuard: the standing guard records ${guard.releaseId}, not ${releaseId} — guard A must never be resolved by release B`,
    );
  }
  if (guard.newPointerSha256 !== newPointerSha256) {
    throw new Error(
      "resolveRestoredGuard: the standing guard's pointer digest does not match this release — refusing",
    );
  }
  const live = await store.get("updates/latest.json");
  if (live == null || sha256(live) !== restoredPointerSha256) {
    throw new Error(
      "resolveRestoredGuard: the live pointer is not the VERIFIED restored pointer — it moved after the restore; operator action required",
    );
  }
  // Idempotent path — everything above already revalidated.
  if (guard.resolved === true) {
    log(`= restore guard for ${releaseId} is already resolved (revalidated)`);
    return;
  }
  // R11-1: RE-READ immediately before the write (see resolveReleaseGuard).
  const reread = await store.get(UNRESOLVED_GUARD_KEY);
  if (!equalBytes(reread, guardBytes)) {
    throw new Error(
      "resolveRestoredGuard: the guard changed while this resolution was validating (a concurrent release?) — refusing to overwrite it; the standing guard keeps blocking",
    );
  }
  const resolved = Buffer.from(
    `${JSON.stringify(
      {
        resolved: true,
        releaseId,
        newVersion: guard.newVersion ?? null,
        newPointerSha256,
        restoredPointerSha256,
        resolvedBy: "verified-restore",
      },
      null,
      2,
    )}\n`,
  );
  await store.put(UNRESOLVED_GUARD_KEY, resolved, { contentType: "application/json" });
  const readBack = await store.get(UNRESOLVED_GUARD_KEY);
  if (!equalBytes(readBack, resolved)) {
    throw new Error("resolveRestoredGuard: the resolution did not read back — treat the release as still guarded");
  }
  log(`✓ release guard resolved for ${releaseId} (restored pointer publicly verified)`);
}

/**
 * R5: the workflow's failure recovery — restore the EXACT pre-stage pointer
 * captured by `stageRelease` (never a possibly-stale rollback.json). Reads the
 * live pointer first and acts only on a provably-known state:
 *
 *   live == pre-stage bytes            → nothing to do (report)
 *   live absent, none existed before   → nothing was promoted (report)
 *   live == this run's manifest        → restore the pre-stage bytes
 *   live absent but one existed before → restore the pre-stage bytes
 *   anything else                      → ROLLBACK IMPOSSIBLE, loudly
 *
 * A promoted FIRST release cannot be restored-to-absent (no delete op) — that
 * is reported as impossible for the operator to decide.
 */
export async function restorePointer({ store, preStage, log = console.log }) {
  const key = "updates/latest.json";
  const preBytes = preStage.pointerPresent ? Buffer.from(preStage.pointerBase64, "base64") : null;
  const newBytes = Buffer.from(preStage.newManifestBase64, "base64");
  const live = await store.get(key);

  if (preBytes != null && live != null && equalBytes(live, preBytes)) {
    log(`= live pointer is already the pre-stage release (${preStage.previousVersion}) — nothing to restore`);
    return {
      action: "already-pre-stage",
      version: preStage.previousVersion,
      previousDmgSha256: preStage.previousDmgSha256,
      restoredPointerSha256: sha256(preBytes),
    };
  }
  if (live == null && !preStage.pointerPresent) {
    log("= no live pointer and none existed before staging — nothing was promoted");
    return { action: "still-absent", version: null, previousDmgSha256: null };
  }
  const liveIsNew = live != null && equalBytes(live, newBytes);
  if (liveIsNew && preBytes == null) {
    throw new Error(
      "ROLLBACK IMPOSSIBLE: the FIRST release was promoted but failed verification, and there is no pre-stage pointer to restore. " +
        "Operator action required: delete updates/latest.json or fix forward, then re-verify.",
    );
  }
  if (liveIsNew || (live == null && preBytes != null)) {
    // R7-6: conditional write tied to the exact live bytes read above —
    // stores without compare-and-swap get a REPORT, never an auto-write.
    if (typeof store.putIfMatch !== "function") {
      const guardNote = await armUnresolvedGuard(
        store,
        `release ${preStage.newVersion} was promoted but failed verification; restore was not attempted (no conditional write)`,
        preStage.releaseId
          ? {
              releaseId: preStage.releaseId,
              newVersion: preStage.newVersion,
              newPointerSha256: preStage.newPointerSha256,
            }
          : null,
      );
      throw new Error(
        `RESTORE NOT ATTEMPTED: the store offers no conditional write (compare-and-swap), so nothing is auto-restored over a potentially concurrent release. ` +
          `Live pointer state: ${describePointer(live)} (this run promoted ${preStage.newVersion}). ` +
          `Operator action: confirm updates/latest.json still names ${preStage.newVersion}, then put updates/rollback.json back as updates/latest.json and re-verify.` +
          guardNote,
      );
    }
    // R9-5: the SAME manifest contract every write path applies — the bytes
    // about to become the live pointer must satisfy it, even here.
    let preParsed;
    try {
      preParsed = JSON.parse(Buffer.from(preBytes).toString("utf8"));
    } catch {
      throw new Error(
        "RESTORE NOT ATTEMPTED: the captured pre-stage pointer bytes are not valid JSON — refusing to restore an unknown pointer state",
      );
    }
    const preIssue = manifestContractIssue(preParsed);
    if (preIssue != null) {
      throw new Error(
        `RESTORE NOT ATTEMPTED: the captured pre-stage pointer violates the manifest contract (${preIssue}) — refusing to restore it as the live pointer`,
      );
    }
    try {
      await store.putIfMatch(key, preBytes, live == null ? null : Buffer.from(live), {
        contentType: "application/json",
      });
    } catch (e) {
      throw new Error(
        `ROLLBACK IMPOSSIBLE: the conditional restore did not apply — the pointer moved after the recovery read (a concurrent publish?). Nothing was overwritten blind. (${e.message})`,
      );
    }
    const readBack = await store.get(key);
    if (readBack == null || !equalBytes(readBack, preBytes)) {
      throw new Error(`read-back mismatch for pointer ${key} after the conditional restore`);
    }
    log(`✓ pointer ${key} conditionally restored and read-back verified`);
    // R10-3: the restore does NOT resolve the guard. A restored pointer is a
    // CLAIM until the restored public origin passes the full verification
    // battery (payload hashing, DMG hashing, .sig equality, cryptographic
    // minisign) — only then does resolveRestoredGuard, carrying this
    // report's restoredPointerSha256, resolve the exact standing guard.
    log("! the release guard REMAINS PENDING until the restored origin is publicly verified (resolveRestoredGuard)");
    return {
      action: "restored",
      version: preStage.previousVersion,
      previousDmgSha256: preStage.previousDmgSha256,
      restoredPointerSha256: sha256(preBytes),
    };
  }
  throw new Error(
    "ROLLBACK IMPOSSIBLE: the live updates/latest.json is neither the pre-stage pointer nor this run's manifest — it changed underneath this run (concurrent publish?). Operator action required.",
  );
}

/**
 * R4/R9-4: the ONE-POINTER ROLLBACK, for when post-switch public verification
 * fails — with the rollback state BOUND: the caller must state the release it
 * believes is live and the exact digest of the retained manifest it intends
 * to restore. Without both, no write is attempted. This closes the stale-read
 * race (read rollback v1 → a concurrent release publishes latest v3 +
 * rollback v2 → a stale v1 CAS overwrites v3): a moved live pointer fails the
 * expected-version check, and a replaced rollback.json fails the pinned
 * digest check. Validates the retained manifest against THE contract before
 * switching and reads the pointer back. Returns the rolled-back-to version.
 */
export async function rollbackPointer({
  store,
  expectedLiveVersion,
  expectedRollbackSha256,
  log = console.log,
}) {
  // R9-4: bound state, refused up front — never inferred.
  if (!isCanonicalSemver(String(expectedLiveVersion ?? "").trim())) {
    throw new Error(
      "ROLLBACK NOT ATTEMPTED: --expect-live-version (canonical x.y.z) is required — a rollback must name the release it rolls back FROM",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(String(expectedRollbackSha256 ?? "").trim())) {
    throw new Error(
      "ROLLBACK NOT ATTEMPTED: --expect-rollback-sha256 (the 64-hex digest of updates/rollback.json) is required — a rollback must pin the exact bytes it restores",
    );
  }
  const retained = await store.get("updates/rollback.json");
  if (retained == null) {
    throw new Error(
      "ROLLBACK IMPOSSIBLE: no updates/rollback.json retained (first release?) — the live pointer may still name the unverified release",
    );
  }
  // R9-4: the retained bytes must be EXACTLY the ones the operator inspected —
  // a concurrent release rewrites rollback.json, and restoring the wrong one
  // would clobber a release nobody decided to roll back.
  if (sha256(retained) !== String(expectedRollbackSha256).trim()) {
    throw new Error(
      "ROLLBACK REFUSED: updates/rollback.json does not hash to the pinned digest — it changed since it was inspected (a concurrent release?); re-inspect before rolling back",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(retained).toString("utf8"));
  } catch {
    throw new Error("ROLLBACK IMPOSSIBLE: the retained rollback manifest is not valid JSON");
  }
  // R8-5: the retained manifest must satisfy THE contract before it may ever
  // become the live pointer again.
  const retainedIssue = manifestContractIssue(parsed);
  if (retainedIssue != null) {
    throw new Error(
      `ROLLBACK IMPOSSIBLE: the retained rollback manifest violates the manifest contract (${retainedIssue})`,
    );
  }
  // R8-5: NEVER a check-then-unconditional-overwrite — the write is tied to
  // the exact live bytes read here, or it is not attempted at all.
  if (typeof store.putIfMatch !== "function") {
    throw new Error(
      "ROLLBACK NOT ATTEMPTED: the store offers no conditional write (compare-and-swap) — a check-then-overwrite could clobber a concurrent release. " +
        "Operator action: follow the rollback runbook in docs/DISTRIBUTION.md (quiesce releases, re-read and pin the live pointer, restore, read back, re-verify the public origin).",
    );
  }
  const live = await store.get("updates/latest.json");
  // R9-4: the live pointer must still BE the release the caller is rolling
  // back from — a concurrent publish moves it, and rolling back over the
  // newer release would be a stale-state overwrite even with CAS.
  if (live == null) {
    throw new Error(
      `ROLLBACK REFUSED: there is no live pointer to roll back from (expected it to name ${expectedLiveVersion})`,
    );
  }
  let liveParsed;
  try {
    liveParsed = JSON.parse(Buffer.from(live).toString("utf8"));
  } catch {
    throw new Error(
      "ROLLBACK REFUSED: the live updates/latest.json is unparseable — operator inspection required before any rollback",
    );
  }
  if (liveParsed?.version !== String(expectedLiveVersion).trim()) {
    throw new Error(
      `ROLLBACK REFUSED: the live pointer names ${JSON.stringify(liveParsed?.version ?? null)}, not the expected ${expectedLiveVersion} — the pointer moved (a concurrent release?); re-inspect before rolling back`,
    );
  }
  try {
    await store.putIfMatch(
      "updates/latest.json",
      Buffer.from(retained),
      Buffer.from(live),
      { contentType: "application/json" },
    );
  } catch (e) {
    throw new Error(
      `ROLLBACK IMPOSSIBLE: the conditional write did not apply — the pointer moved after the read (concurrent publish?). Nothing was overwritten blind. (${e.message})`,
    );
  }
  const readBack = await store.get("updates/latest.json");
  if (readBack == null || !equalBytes(readBack, Buffer.from(retained))) {
    throw new Error("read-back mismatch for pointer updates/latest.json after the conditional rollback");
  }
  log(`✓ rolled the release pointer back to ${parsed.version} (bound expectations, conditional write, read-back verified)`);
  return parsed.version;
}

// ── CLI (wrangler-backed store) ─────────────────────────────────────────────

/** Resolve the LOCKED local wrangler executable (installed via npm ci from
 *  package-lock) — release credentials never run `npx --yes` downloads. */
export function lockedWranglerBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler;
  return { script: join(pkgPath, "..", bin), version: pkg.version };
}

/** Recognize R2's confirmed OBJECT-not-found — and nothing else. ONLY these
 *  may map to null; every other failure throws (fail closed). Narrow by
 *  design (R4): the old generic /not found|404/ also swallowed
 *  "Authentication token not found", "endpoint not found (404)",
 *  "command not found", and a missing BUCKET — each of which would have
 *  bypassed the downgrade/rerun guards by masquerading as an absent object. */
export function isNotFoundStderr(stderr) {
  const text = String(stderr ?? "");
  // A missing/renamed BUCKET is configuration breakage, never object-absence.
  if (/NoSuchBucket|\[code:\s*10006\]|bucket .*(not found|does not exist)/i.test(text)) {
    return false;
  }
  return /NoSuchKey|\[code:\s*10007\]|The specified (object|key) does not exist/i.test(text);
}

// R7-6: wrangler's r2 object put offers NO conditional write (compare-and-
// swap), so this store deliberately exposes no `putIfMatch` — the recovery
// paths then REPORT the live state for operator action instead of ever
// auto-writing over a potentially concurrent release.
export function wranglerStore({ bucket, runner }) {
  const { script } = lockedWranglerBin();
  const run =
    runner ??
    ((args) =>
      spawnSync(process.execPath, [script, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      }));
  return {
    async put(key, bytes, { contentType }) {
      const tmp = join(tmpdir(), `stage-release-${process.pid}-${sha256(bytes).slice(0, 8)}`);
      writeFileSync(tmp, bytes);
      // R4 cache posture: the mutable POINTERS must never be served stale —
      // a 5-minute-cached latest.json could hand the updater the old manifest
      // while /download already serves the new DMG (or vice versa). R9-3: the
      // unresolved-release guard is a mutable pointer too — a stale cached
      // "resolved" (or "pending") guard would defeat the blocking transaction.
      // Immutable content-addressed artifacts can be cached hard forever.
      const cacheControl =
        key === "updates/latest.json" ||
        key === "updates/rollback.json" ||
        key === UNRESOLVED_GUARD_KEY
          ? "no-store"
          : "public, max-age=31536000, immutable";
      const args = [
        "r2", "object", "put", `${bucket}/${key}`,
        "--remote", "--file", tmp,
        "--content-type", contentType,
        "--cache-control", cacheControl,
      ];
      if (key.endsWith(".dmg")) {
        args.push("--content-disposition", 'attachment; filename="Throughline.dmg"');
      }
      const res = run(args);
      if (res.status !== 0) {
        throw new Error(`wrangler put ${key} failed: ${res.stderr?.toString() ?? "unknown error"}`);
      }
    },
    async get(key) {
      const tmp = join(tmpdir(), `stage-release-get-${process.pid}-${Math.random().toString(36).slice(2)}`);
      const res = run(["r2", "object", "get", `${bucket}/${key}`, "--remote", "--file", tmp]);
      if (res.status === 0) return readFileSync(tmp);
      const stderr = res.stderr?.toString() ?? "";
      if (isNotFoundStderr(stderr)) return null; // confirmed absent
      // Auth, permission, network, and CLI failures FAIL CLOSED — treating
      // them as "absent" could skip the downgrade guard or clobber state.
      throw new Error(`wrangler get ${key} failed (not a not-found): ${stderr || `exit ${res.status}`}`);
    },
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--payload") opts.payloadPath = argv[++i];
    else if (arg === "--sig") opts.sigPath = argv[++i];
    else if (arg === "--dmg") opts.dmgPath = argv[++i];
    else if (arg === "--manifest") opts.manifestPath = argv[++i];
    else if (arg === "--version") opts.version = argv[++i];
    else if (arg === "--origin") opts.origin = argv[++i];
    else if (arg === "--bucket") opts.bucket = argv[++i];
    else if (arg === "--severity") opts.severity = argv[++i];
    else if (arg === "--summary-out") opts.summaryOut = argv[++i];
    else if (arg === "--rollback") opts.rollback = true;
    else if (arg === "--rollback-version-out") opts.rollbackVersionOut = argv[++i];
    else if (arg === "--expect-live-version") opts.expectLiveVersion = argv[++i];
    else if (arg === "--expect-rollback-sha256") opts.expectRollbackSha256 = argv[++i];
    else if (arg === "--pre-stage-out") opts.preStageOut = argv[++i];
    else if (arg === "--restore-pointer") opts.restorePointerPath = argv[++i];
    else if (arg === "--restore-report") opts.restoreReport = argv[++i];
    else if (arg === "--resolve-guard") opts.resolveGuardPath = argv[++i];
    else if (arg === "--resolve-restored-guard") opts.resolveRestoredGuardPath = argv[++i];
    else if (arg === "--restored-digest") opts.restoredDigest = argv[++i];
    else if (arg === "--quiescence") opts.quiescence = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.rollback) {
    if (!opts.bucket) throw new Error("stage-release --rollback: missing --bucket");
    // R9-4: the bound expectations are REQUIRED at the CLI too — the engine
    // would refuse anyway; failing here gives the operator the exact flags.
    if (!opts.expectLiveVersion) throw new Error("stage-release --rollback: missing --expect-live-version");
    if (!opts.expectRollbackSha256) throw new Error("stage-release --rollback: missing --expect-rollback-sha256");
    return opts;
  }
  if (opts.restorePointerPath) {
    if (!opts.bucket) throw new Error("stage-release --restore-pointer: missing --bucket");
    return opts;
  }
  if (opts.resolveGuardPath) {
    if (!opts.bucket) throw new Error("stage-release --resolve-guard: missing --bucket");
    return opts;
  }
  if (opts.resolveRestoredGuardPath) {
    if (!opts.bucket) throw new Error("stage-release --resolve-restored-guard: missing --bucket");
    if (!opts.restoredDigest) throw new Error("stage-release --resolve-restored-guard: missing --restored-digest");
    return opts;
  }
  for (const req of ["payloadPath", "sigPath", "dmgPath", "manifestPath", "version", "origin", "bucket"]) {
    if (!opts[req]) throw new Error(`stage-release: missing --${req.replace("Path", "").toLowerCase()}`);
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const { version: wranglerVersion } = lockedWranglerBin();
  console.log(`using locked wrangler ${wranglerVersion} (from package-lock, never npx)`);
  if (opts.rollback) {
    const version = await rollbackPointer({
      store: wranglerStore({ bucket: opts.bucket }),
      expectedLiveVersion: opts.expectLiveVersion,
      expectedRollbackSha256: opts.expectRollbackSha256,
    });
    if (opts.rollbackVersionOut) writeFileSync(opts.rollbackVersionOut, `${version}\n`);
    return;
  }
  if (opts.restorePointerPath) {
    const preStage = JSON.parse(readFileSync(opts.restorePointerPath, "utf8"));
    const report = await restorePointer({ store: wranglerStore({ bucket: opts.bucket }), preStage });
    if (opts.restoreReport) writeFileSync(opts.restoreReport, `${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (opts.resolveGuardPath) {
    // R9-3: resolve THIS run's write-ahead guard after public verification —
    // identity comes from the persisted pre-stage state, never from guesses.
    const preStage = JSON.parse(readFileSync(opts.resolveGuardPath, "utf8"));
    await resolveReleaseGuard({
      store: wranglerStore({ bucket: opts.bucket }),
      releaseId: preStage.releaseId,
      newPointerSha256: preStage.newPointerSha256,
      quiescence: opts.quiescence,
    });
    return;
  }
  if (opts.resolveRestoredGuardPath) {
    // R10-3: resolve the guard after a RESTORED pointer passed the full
    // public verification — identity from the persisted pre-stage state,
    // the restored digest from the verified restore report.
    const preStage = JSON.parse(readFileSync(opts.resolveRestoredGuardPath, "utf8"));
    await resolveRestoredGuard({
      store: wranglerStore({ bucket: opts.bucket }),
      releaseId: preStage.releaseId,
      newPointerSha256: preStage.newPointerSha256,
      restoredPointerSha256: opts.restoredDigest,
      quiescence: opts.quiescence,
    });
    return;
  }
  // R5: persist the pre-stage state as soon as it is captured, and flip the
  // durable promotion-attempted marker just before the pointer PUT — the
  // workflow's failure recovery keys off both.
  let preStageState = null;
  const persistPreStage = () => {
    if (opts.preStageOut && preStageState) {
      writeFileSync(opts.preStageOut, `${JSON.stringify(preStageState, null, 2)}\n`);
    }
  };
  const result = await stageRelease({
    store: wranglerStore({ bucket: opts.bucket }),
    version: opts.version,
    origin: opts.origin,
    payload: readFileSync(opts.payloadPath),
    sig: readFileSync(opts.sigPath),
    dmg: readFileSync(opts.dmgPath),
    manifest: JSON.parse(readFileSync(opts.manifestPath, "utf8")),
    severity: opts.severity ?? "",
    onPreStage: (s) => {
      preStageState = s;
      persistPreStage();
    },
    onBeforePromotion: () => {
      if (preStageState) preStageState.promotionAttempted = true;
      persistPreStage();
    },
  });
  console.log(`✓ release staged: payload ${result.payloadKey}, dmg ${result.dmgKey}`);
  if (opts.summaryOut) {
    writeFileSync(opts.summaryOut, `${JSON.stringify({ payloadKey: result.payloadKey, dmgKey: result.dmgKey, updateUrl: result.updateUrl, dmgSha256: result.dmgSha256 }, null, 2)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
// R7-7: THE manifest contract has ONE definition (stage-release.mjs); this
// verifier and the engine can never disagree about what a manifest is.
import { manifestContractIssue } from "./stage-release.mjs";

const DEFAULT_ORIGIN = "https://readthroughline.com";
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

function usage() {
  return `Usage: node scripts/verify-release-assets.mjs [--origin https://readthroughline.com] [--expected-version vX.Y.Z] [--expect-severity critical] [--pubkey-from-tauri-conf src-tauri/tauri.conf.json | --pubkey <base64>]
       node scripts/verify-release-assets.mjs --local-payload <file> --local-sig <file> --local-manifest <file> --pubkey-from-tauri-conf src-tauri/tauri.conf.json [--expected-version vX.Y.Z]

Verifies the public R2-backed assets used by Throughline's updater and download links:
  - /updates/latest.json resolves from the site
  - every darwin platform payload URL resolves from /updates/
  - each darwin manifest signature matches the matching .sig asset
  - with a pubkey: each payload's minisign signature VERIFIES CRYPTOGRAPHICALLY
    over the payload bytes (REL-008)
  - /download resolves for the public DMG
  - (optional) severity tiering: with --expect-severity critical, latest.json must
    carry severity "critical" + a valid semver criticalBelow (== the expected
    version when given). Absent severity passes as routine, unchanged.

The --local-* mode runs the same manifest/signature checks against files on
disk BEFORE anything is published (the release workflow's pre-publication gate).
`;
}

// ── Minisign (the Tauri updater signature scheme) ──────────────────────────
//
// EXACT `minisign-verify` 0.2.5 semantics — the crate tauri-plugin-updater
// 2.10.1 verifies with (see verify_signature in its updater.rs):
//   - the configured pubkey and the manifest `signature` are BASE64 of the
//     minisign DOCUMENTS (2-line key doc; 4-line signature doc);
//   - Signature::decode is STRICT: line 1 untrusted comment, line 2 a 74-byte
//     box (alg[2] ‖ key_id[8] ‖ sig[64]), line 3 MUST start with
//     "trusted comment: ", line 4 a 64-byte global signature;
//   - verify(): key ids must match; alg "ED" hashes the payload with
//     Blake2b-512 first (alg "Ed" signs raw bytes — legacy, allowed because
//     the updater passes allow_legacy=true); the PRIMARY Ed25519 signature is
//     checked over that message, then the GLOBAL Ed25519 signature is checked
//     over signature_bytes ‖ trusted_comment_text (the text AFTER the
//     "trusted comment: " prefix).
// Anything else — a missing/malformed fourth line, a changed trusted comment,
// a wrong key id, a damaged signature — must fail, exactly as it would in the
// shipped updater. The release workflow ALSO runs the Rust reference verifier
// (src-tauri/examples/verify_minisign.rs, built on the same minisign-verify
// crate) over the same artifacts, so these semantics can never drift silently.

/** STRICT canonical base64 (updater parity — R4). The updater decodes the
 *  outer wrapping with Rust `base64::STANDARD` (invalid characters rejected,
 *  canonical padding required, trailing bits rejected) and the inner document
 *  lines with minisign-verify's own constant-time decoder (same strictness).
 *  Node's `Buffer.from(s, "base64")` silently SKIPS invalid characters and
 *  tolerates bad padding, so a corrupted value — e.g. a `!` inserted into the
 *  global-signature line — could "verify" here while the shipped updater
 *  rejects it. Charset + padding + length, then a round-trip equality check
 *  (which also rejects noncanonical trailing bits). */
export function strictBase64Decode(text, label) {
  const s = String(text);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new Error(`${label}: not canonical base64`);
  }
  const buf = Buffer.from(s, "base64");
  if (buf.toString("base64") !== s) {
    throw new Error(`${label}: not canonical base64`);
  }
  return buf;
}

/** The updater's OUTER encoding, exactly (tauri-plugin-updater
 *  `base64_to_string` → `::decode`): the configured pubkey and the manifest
 *  signature are strict-canonical BASE64 of the minisign documents. A raw
 *  document (starting "untrusted comment:") is REJECTED here just as the
 *  shipped updater would reject it. */
function minisignDocument(text, label) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith("untrusted comment:")) {
    throw new Error(
      `${label}: got a RAW minisign document where the updater expects base64 of the document`,
    );
  }
  const decoded = strictBase64Decode(trimmed, label).toString("utf8").trim();
  if (!decoded.startsWith("untrusted comment:")) {
    throw new Error(`${label}: not a minisign document (missing untrusted comment)`);
  }
  return decoded;
}

export function parseMinisignPublicKey(text) {
  // Updater-exact: strict base64 of the 2-line key document (PublicKey::decode
  // after base64_to_string). A bare box or raw document is not what the
  // updater consumes from tauri.conf.json.
  const doc = minisignDocument(text, "public key");
  const b64 = (doc.split("\n")[1] ?? "").trim();
  const box = strictBase64Decode(b64, "public key box");
  if (box.length !== 42) {
    throw new Error(`public key: expected a 42-byte minisign box, got ${box.length}`);
  }
  const alg = box.subarray(0, 2).toString();
  if (alg !== "Ed" && alg !== "ED") {
    throw new Error(`public key: unsupported algorithm ${JSON.stringify(alg)}`);
  }
  return { alg, keyId: box.subarray(2, 10), key: box.subarray(10) };
}

/** STRICT four-line minisign signature parse (Signature::decode parity), fed
 *  from the strict base64 outer unwrap above. */
export function parseMinisignSignature(text) {
  const doc = minisignDocument(text, "signature");
  const lines = doc.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.length < 4) {
    throw new Error(`signature: a minisign signature document has 4 lines, got ${lines.length}`);
  }
  const untrustedComment = lines[0];
  const box = strictBase64Decode(lines[1].trim(), "signature box");
  if (box.length !== 74) {
    throw new Error(`signature: expected a 74-byte minisign box, got ${box.length}`);
  }
  const trustedCommentLine = lines[2];
  if (!trustedCommentLine.startsWith("trusted comment: ")) {
    throw new Error("signature: third line must start with \"trusted comment: \"");
  }
  const globalSig = strictBase64Decode(lines[3].trim(), "global signature");
  if (globalSig.length !== 64) {
    throw new Error(`signature: expected a 64-byte global signature, got ${globalSig.length}`);
  }
  const alg = box.subarray(0, 2).toString();
  let prehashed;
  if (alg === "ED") prehashed = true;
  else if (alg === "Ed") prehashed = false;
  else throw new Error(`signature: unsupported minisign algorithm ${JSON.stringify(alg)}`);
  return {
    alg,
    prehashed,
    untrustedComment,
    keyId: box.subarray(2, 10),
    sig: box.subarray(10),
    trustedComment: trustedCommentLine.slice("trusted comment: ".length),
    globalSig,
  };
}

function ed25519Verify(message, rawKey, sig) {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]);
  const keyObject = createPublicKey({ key: spki, format: "der", type: "spki" });
  return edVerify(null, message, keyObject, sig);
}

/** Cryptographically verify a minisign signature over `payload` (a Buffer),
 *  with EXACT minisign-verify/verify(…, allow_legacy=true) semantics: key id,
 *  primary signature (prehashed or legacy), AND the global signature over
 *  signature_bytes ‖ trusted_comment_text. Throws with a precise reason on
 *  any mismatch; returns true on success. */
export function verifyMinisign({ payload, signatureText, publicKeyText }) {
  const pub = parseMinisignPublicKey(publicKeyText);
  const sig = parseMinisignSignature(signatureText);
  if (!pub.keyId.equals(sig.keyId)) {
    throw new Error(
      `signature key id ${sig.keyId.toString("hex")} does not match public key id ${pub.keyId.toString("hex")}`,
    );
  }
  const message = sig.prehashed ? createHash("blake2b512").update(payload).digest() : payload;
  if (!ed25519Verify(message, pub.key, sig.sig)) {
    throw new Error("minisign signature did not verify over the payload bytes");
  }
  const globalMessage = Buffer.concat([sig.sig, Buffer.from(sig.trustedComment, "utf8")]);
  if (!ed25519Verify(globalMessage, pub.key, sig.globalSig)) {
    throw new Error(
      "minisign GLOBAL signature did not verify over the signature + trusted comment",
    );
  }
  return true;
}

/** Resolve the updater public key from tauri.conf.json (plugins.updater.pubkey). */
export function pubkeyFromTauriConf(path) {
  const conf = JSON.parse(readFileSync(path, "utf8"));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (!pubkey || typeof pubkey !== "string") {
    throw new Error(`no plugins.updater.pubkey in ${path}`);
  }
  return pubkey;
}

// CORE-1160: a strict 3-part semver shape (release versions are always x.y.z).
function isSemver(v) {
  return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
}

export function parseArgs(argv) {
  const opts = { origin: DEFAULT_ORIGIN, expectedVersion: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--origin") {
      opts.origin = argv[++i];
    } else if (arg === "--expected-version") {
      opts.expectedVersion = argv[++i];
    } else if (arg === "--expect-severity") {
      // Set only when passed (kept off the default opts so routine callers are
      // byte-identical to before).
      opts.expectSeverity = argv[++i];
    } else if (arg === "--pubkey") {
      opts.publicKeyText = argv[++i];
    } else if (arg === "--dmg-sha256") {
      opts.dmgSha256 = argv[++i];
    } else if (arg === "--pubkey-from-tauri-conf") {
      opts.publicKeyText = pubkeyFromTauriConf(argv[++i]);
    } else if (arg === "--local-payload") {
      opts.localPayload = argv[++i];
    } else if (arg === "--local-sig") {
      opts.localSig = argv[++i];
    } else if (arg === "--local-manifest") {
      opts.localManifest = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (opts.help) return opts;
  if (opts.expectSeverity != null && opts.expectSeverity !== "critical") {
    throw new Error(`--expect-severity only supports "critical", got ${JSON.stringify(opts.expectSeverity)}`);
  }
  const localFlags = [opts.localPayload, opts.localSig, opts.localManifest];
  if (localFlags.some(Boolean)) {
    if (!localFlags.every(Boolean)) {
      throw new Error("--local-payload, --local-sig, and --local-manifest must be passed together");
    }
    if (!opts.publicKeyText) {
      throw new Error("the local mode requires --pubkey or --pubkey-from-tauri-conf (REL-008: the updater signature must verify cryptographically before publication)");
    }
    opts.local = true;
    return opts;
  }
  opts.origin = normalizeOrigin(opts.origin);
  return opts;
}

/** Pre-publication gate (REL-008): verify built artifacts ON DISK — manifest
 *  shape + version, the manifest signature equals the .sig file, and the
 *  minisign signature verifies cryptographically over the payload bytes. */
export function verifyLocalArtifacts({
  localPayload,
  localSig,
  localManifest,
  publicKeyText,
  expectedVersion = null,
  log = console.log,
}) {
  const payload = readFileSync(localPayload);
  const sigText = readFileSync(localSig, "utf8").trim();
  const manifest = parseManifest(readFileSync(localManifest, "utf8"), localManifest);

  const manifestVersion = versionWithoutV(manifest.version);
  if (!manifestVersion) throw new Error("latest.json has no version");
  if (expectedVersion && manifestVersion !== versionWithoutV(expectedVersion)) {
    throw new Error(`latest.json version ${manifest.version} did not match expected ${expectedVersion}`);
  }
  log(`✓ local manifest version: ${manifest.version}`);

  const entries = darwinEntries(manifest);
  if (entries.length === 0) throw new Error("latest.json has no darwin platform entries");
  for (const [platform, value] of entries) {
    if (!value?.signature || typeof value.signature !== "string") {
      throw new Error(`${platform} entry has no signature`);
    }
    if (value.signature.trim() !== sigText) {
      throw new Error(`${platform} signature in latest.json does not match ${localSig}`);
    }
  }
  log(`✓ manifest signatures match ${localSig} (${entries.length} darwin platform(s))`);

  verifyMinisign({ payload, signatureText: sigText, publicKeyText });
  log(`✓ minisign signature verifies cryptographically over ${localPayload}`);
  return { version: manifest.version, platformCount: entries.length };
}

function normalizeOrigin(origin) {
  const raw = String(origin || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--origin must be an absolute https URL, got ${JSON.stringify(origin)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`--origin must use https, got ${JSON.stringify(origin)}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function versionWithoutV(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function manifestUrlFor(origin) {
  return `${origin}/updates/latest.json`;
}

function dmgUrlFor(origin) {
  return `${origin}/download`;
}

function sigUrlFor(payloadUrl) {
  return `${payloadUrl}.sig`;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envRetryOptions(env = process.env) {
  return {
    attempts: positiveInt(env.VERIFY_RETRIES, DEFAULT_RETRIES),
    delayMs: nonNegativeInt(env.VERIFY_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
  };
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function resolveRetryOptions(retry = {}) {
  const fromEnv = envRetryOptions();
  return {
    attempts: positiveInt(retry.attempts, fromEnv.attempts),
    delayMs: nonNegativeInt(retry.delayMs, fromEnv.delayMs),
  };
}

function errorMessage(err) {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}

function retryMessage(label, url, attempt, attempts, delayMs, reason) {
  return `↻ ${label} did not resolve (${reason}); retry ${attempt + 1}/${attempts} in ${delayMs}ms: ${url}`;
}

async function fetchOk(fetchImpl, url, label, { retry = {}, log = console.log } = {}) {
  const { attempts, delayMs } = resolveRetryOptions(retry);
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        headers: { "user-agent": "throughline-release-asset-guard" },
      });
      if (res?.status === 200) return res;
      lastStatus = res?.status ?? "no response";
      lastError = null;
    } catch (err) {
      lastStatus = null;
      lastError = errorMessage(err);
    }

    if (attempt < attempts) {
      const reason = lastError ? `network error: ${lastError}` : lastStatus;
      log(retryMessage(label, url, attempt, attempts, delayMs, reason));
      await sleep(delayMs);
    }
  }

  if (lastError) {
    throw new Error(`${label} did not resolve (network error: ${lastError}): ${url}`);
  }
  throw new Error(`${label} did not resolve (${lastStatus ?? "no response"}): ${url}`);
}

async function fetchText(fetchImpl, url, label, options) {
  const res = await fetchOk(fetchImpl, url, label, options);
  return res.text();
}

function parseManifest(raw, url) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`latest.json was not valid JSON at ${url}: ${err.message}`);
  }
}

function darwinEntries(manifest) {
  const platforms = manifest?.platforms;
  if (!platforms || typeof platforms !== "object") {
    throw new Error("latest.json has no platforms object");
  }
  return Object.entries(platforms).filter(([key]) => key.startsWith("darwin"));
}

function assertR2UpdateUrl(origin, platform, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${platform} updater payload url is not absolute: ${url}`);
  }
  const expectedPrefix = `${origin}/updates/`;
  if (`${parsed.origin}${parsed.pathname}` !== url || !url.startsWith(expectedPrefix)) {
    throw new Error(`${platform} updater payload must use ${expectedPrefix}, got ${url}`);
  }
  if (parsed.pathname.endsWith("/")) {
    throw new Error(`${platform} updater payload url must name a file, got ${url}`);
  }
}

export async function verifyReleaseAssets({
  origin = DEFAULT_ORIGIN,
  expectedVersion = null,
  expectSeverity = null,
  publicKeyText = null,
  dmgSha256 = null,
  fetchImpl = globalThis.fetch,
  log = console.log,
  retry = {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  const normalizedOrigin = normalizeOrigin(origin);
  const latestJsonUrl = manifestUrlFor(normalizedOrigin);
  const manifestRaw = await fetchText(fetchImpl, latestJsonUrl, "latest.json", { retry, log });
  log(`✓ latest.json resolved: ${latestJsonUrl}`);

  const manifest = parseManifest(manifestRaw, latestJsonUrl);
  // R7-7: the WHOLE manifest is validated against THE contract before any
  // artifact — payload, signature, or the named DMG — is fetched.
  const contractIssue = manifestContractIssue(manifest);
  if (contractIssue != null) {
    throw new Error(`latest.json violates the manifest contract: ${contractIssue}`);
  }
  const manifestVersion = versionWithoutV(manifest.version);
  if (!manifestVersion) throw new Error("latest.json has no version");
  if (expectedVersion && manifestVersion !== versionWithoutV(expectedVersion)) {
    throw new Error(
      `latest.json version ${manifest.version} did not match expected ${expectedVersion}`,
    );
  }
  log(`✓ latest.json version: ${manifest.version}`);

  // CORE-1160 — optional severity tier. A routine release omits `severity`
  // entirely and passes exactly as before. When the caller expects critical (or a
  // severity is present at all), it must be well-formed: severity "critical" and a
  // valid semver criticalBelow (matching the expected version when one is given).
  const { severity, criticalBelow } = manifest;
  if (expectSeverity) {
    if (severity !== expectSeverity) {
      throw new Error(
        `expected latest.json severity ${JSON.stringify(expectSeverity)}, got ${JSON.stringify(severity ?? null)}`,
      );
    }
    if (!isSemver(criticalBelow)) {
      throw new Error(`latest.json criticalBelow is not valid semver: ${JSON.stringify(criticalBelow ?? null)}`);
    }
    if (expectedVersion && versionWithoutV(criticalBelow) !== versionWithoutV(expectedVersion)) {
      throw new Error(`latest.json criticalBelow ${criticalBelow} did not match expected ${expectedVersion}`);
    }
    log(`✓ latest.json severity: ${severity} (criticalBelow ${criticalBelow})`);
  } else if (severity !== undefined && severity !== null) {
    if (severity !== "critical") {
      throw new Error(`latest.json severity must be "critical" when present, got ${JSON.stringify(severity)}`);
    }
    if (!isSemver(criticalBelow)) {
      throw new Error(`latest.json criticalBelow is not valid semver: ${JSON.stringify(criticalBelow ?? null)}`);
    }
    log(`✓ latest.json severity: ${severity} (criticalBelow ${criticalBelow})`);
  }

  const entries = darwinEntries(manifest);
  if (entries.length === 0) throw new Error("latest.json has no darwin platform entries");

  const resolvedPayloads = new Set();
  const resolvedSigs = new Map();
  for (const [platform, value] of entries) {
    if (!value || typeof value !== "object") {
      throw new Error(`${platform} entry is not an object`);
    }
    if (!value.url || typeof value.url !== "string") {
      throw new Error(`${platform} entry has no url`);
    }
    if (!value.signature || typeof value.signature !== "string") {
      throw new Error(`${platform} entry has no signature`);
    }
    assertR2UpdateUrl(normalizedOrigin, platform, value.url);

    if (!resolvedPayloads.has(value.url)) {
      const payloadRes = await fetchOk(fetchImpl, value.url, `${platform} updater payload`, { retry, log });
      log(`✓ updater payload resolved: ${value.url}`);
      const bytes = Buffer.from(await payloadRes.arrayBuffer());
      // R9-5: the updater URL embeds a content-hash segment — the SERVED
      // bytes must hash to it, or the URL pins one payload while the origin
      // serves another.
      const servedSha12 = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      const expectedName = `Throughline-${manifestVersion}-${servedSha12}.app.tar.gz`;
      const urlName = new URL(value.url).pathname.split("/").pop();
      if (urlName !== expectedName) {
        throw new Error(
          `${platform} served payload bytes do not match the content-addressed URL: the url names ${urlName}, the bytes hash to ${expectedName}`,
        );
      }
      log(`✓ ${platform} served payload bytes match the content-addressed URL (${servedSha12})`);
      if (publicKeyText) {
        // REL-008: the signature must verify CRYPTOGRAPHICALLY over the served
        // bytes — resolving is not proof the payload is the signed one.
        verifyMinisign({ payload: bytes, signatureText: value.signature, publicKeyText });
        log(`✓ ${platform} minisign signature verifies over the served payload bytes`);
      }
      resolvedPayloads.add(value.url);
    }

    const sigUrl = sigUrlFor(value.url);
    let sigText = resolvedSigs.get(sigUrl);
    if (sigText === undefined) {
      sigText = await fetchText(fetchImpl, sigUrl, `${platform} updater signature`, { retry, log });
      resolvedSigs.set(sigUrl, sigText);
      log(`✓ updater signature resolved: ${sigUrl}`);
    }
    if (value.signature !== sigText) {
      throw new Error(`${platform} signature in latest.json does not match ${sigUrl}`);
    }
    log(`✓ ${platform} signature matches .sig asset`);
  }

  const dmgUrl = dmgUrlFor(normalizedOrigin);
  const dmgRes = await fetchOk(fetchImpl, dmgUrl, "public DMG download", { retry, log });
  // R5: an HTTP 200 is never proof. The served DMG bytes are ALWAYS hashed and
  // verified against the live manifest's own dmg.sha256 when it carries one —
  // this is what makes a ROLLBACK verification real (the restored manifest
  // names the bytes /download must serve). An explicit --dmg-sha256 adds a
  // second, caller-supplied pin (e.g. the captured legacy hash for a pre-dmg
  // rollback) — both must hold when both are present.
  const manifestDmgSha = manifest?.dmg?.sha256;
  // R6-7: a manifest that CARRIES a dmg block promises a verifiable DMG — a
  // missing (or malformed) sha256 there is a broken release and is REJECTED,
  // never mislabeled "pre-dmg" (that label is reserved for manifests with no
  // dmg block at all).
  if (manifest?.dmg !== undefined && !/^[0-9a-f]{64}$/i.test(String(manifestDmgSha))) {
    throw new Error(
      manifestDmgSha === undefined
        ? "latest.json has a dmg block but NO dmg.sha256 — a dmg-bearing manifest must pin its bytes"
        : `latest.json dmg.sha256 is malformed: ${JSON.stringify(manifestDmgSha)}`,
    );
  }
  const expectedHashes = [
    ...(manifestDmgSha ? [["latest.json dmg.sha256", String(manifestDmgSha).toLowerCase()]] : []),
    ...(dmgSha256 ? [["--dmg-sha256", String(dmgSha256).toLowerCase()]] : []),
  ];
  if (expectedHashes.length > 0) {
    const bytes = Buffer.from(await dmgRes.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    for (const [source, expected] of expectedHashes) {
      if (got !== expected) {
        throw new Error(`public DMG hash mismatch vs ${source}: expected ${expected}, got ${got}: ${dmgUrl}`);
      }
    }
    log(`✓ public DMG bytes verified against ${expectedHashes.map(([s]) => s).join(" + ")} (${got.slice(0, 12)}…)`);
  } else {
    log(`✓ public DMG download resolved: ${dmgUrl} (no dmg hash available — pre-dmg manifest and no --dmg-sha256)`);
  }
  log(`✓ release assets verified for ${normalizedOrigin} ${manifest.version}`);

  return {
    origin: normalizedOrigin,
    version: manifest.version,
    manifestUrl: latestJsonUrl,
    platformCount: entries.length,
    payloadCount: resolvedPayloads.size,
    signatureCount: resolvedSigs.size,
    dmgUrl,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (opts.local) {
    verifyLocalArtifacts(opts);
    return;
  }
  await verifyReleaseAssets(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  });
}

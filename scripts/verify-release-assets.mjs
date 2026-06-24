#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_ORIGIN = "https://readthroughline.com";
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

function usage() {
  return `Usage: node scripts/verify-release-assets.mjs [--origin https://readthroughline.com] [--expected-version vX.Y.Z] [--expect-severity critical]

Verifies the public R2-backed assets used by Throughline's updater and download links:
  - /updates/latest.json resolves from the site
  - every darwin platform payload URL resolves from /updates/
  - each darwin manifest signature matches the matching .sig asset
  - /download resolves for the public DMG
  - (optional) severity tiering: with --expect-severity critical, latest.json must
    carry severity "critical" + a valid semver criticalBelow (== the expected
    version when given). Absent severity passes as routine, unchanged.
`;
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
  opts.origin = normalizeOrigin(opts.origin);
  return opts;
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
      await fetchOk(fetchImpl, value.url, `${platform} updater payload`, { retry, log });
      resolvedPayloads.add(value.url);
      log(`✓ updater payload resolved: ${value.url}`);
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
  await fetchOk(fetchImpl, dmgUrl, "public DMG download", { retry, log });
  log(`✓ public DMG download resolved: ${dmgUrl}`);
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
  await verifyReleaseAssets(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  });
}

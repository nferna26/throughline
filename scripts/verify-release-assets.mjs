#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DEFAULT_REPO = "nferna26/throughline";
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 2_000;

function usage() {
  return `Usage: node scripts/verify-release-assets.mjs [--repo owner/name] [--tag vX.Y.Z] [--expected-version vX.Y.Z]

Verifies the public GitHub release assets used by Throughline's updater and download links:
  - latest.json resolves
  - every darwin platform payload URL resolves
  - each darwin manifest signature matches the matching .sig asset
  - Throughline_<version>_universal.dmg resolves
`;
}

export function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, tag: null, expectedVersion: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      opts.repo = argv[++i];
    } else if (arg === "--tag") {
      opts.tag = argv[++i];
    } else if (arg === "--expected-version") {
      opts.expectedVersion = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (opts.help) return opts;
  if (!opts.repo || !/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
    throw new Error(`--repo must be owner/name, got ${JSON.stringify(opts.repo)}`);
  }
  return opts;
}

function versionWithoutV(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function releaseDownloadBase(repo, tag) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
}

function manifestUrlFor(repo, tag) {
  if (tag) return `${releaseDownloadBase(repo, tag)}/latest.json`;
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
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

async function fetchText(fetchImpl, url, label, { retry = {}, log = console.log } = {}) {
  const { attempts, delayMs } = resolveRetryOptions(retry);
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        headers: { "user-agent": "throughline-release-asset-guard" },
      });
      if (res?.status === 200) return res.text();
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

export async function verifyReleaseAssets({
  repo = DEFAULT_REPO,
  tag = null,
  expectedVersion = null,
  fetchImpl = globalThis.fetch,
  log = console.log,
  retry = {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  const latestJsonUrl = manifestUrlFor(repo, tag);
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

    if (!resolvedPayloads.has(value.url)) {
      await fetchText(fetchImpl, value.url, `${platform} updater payload`, { retry, log });
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

  const releaseTag = tag || `v${manifestVersion}`;
  const dmgName = `Throughline_${manifestVersion}_universal.dmg`;
  const dmgUrl = `${releaseDownloadBase(repo, releaseTag)}/${dmgName}`;
  await fetchText(fetchImpl, dmgUrl, "universal DMG", { retry, log });
  log(`✓ universal DMG resolved: ${dmgUrl}`);
  log(`✓ release assets verified for ${repo} ${manifest.version}`);

  return {
    repo,
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

#!/usr/bin/env node
// REL-008: generate the updater manifest (latest.json) DETERMINISTICALLY from
// the built artifacts — never scraped from a build side-effect. Inputs pin the
// output completely: the payload's .sig content, the tag version, the pub date
// (the tag commit's own timestamp, so a rerun reproduces the same manifest for
// the same inputs), and the Darwin platform keys. The per-platform `url` is a
// placeholder here; `stage-release.mjs` is the single writer of final URLs
// (they embed the content-addressed object key, known only at staging time).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The platform keys the shipped updater resolves for a universal macOS build —
// mirrors the keys production has served since v0.9.x (both arches, plus the
// -app variants tauri-action emits for .app-target updaters).
export const DEFAULT_DARWIN_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "darwin-aarch64-app",
  "darwin-x86_64-app",
];

export const URL_PLACEHOLDER = "about:blank#stage-release-sets-this";

function usage() {
  return `Usage: node scripts/generate-latest-json.mjs --sig <payload.sig> --version vX.Y.Z --pub-date <ISO8601> --out <latest.json> [--notes <text>] [--platforms a,b,c]`;
}

export function parseArgs(argv) {
  const opts = { platforms: DEFAULT_DARWIN_PLATFORMS, notes: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sig") opts.sigPath = argv[++i];
    else if (arg === "--version") opts.version = argv[++i];
    else if (arg === "--pub-date") opts.pubDate = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--notes") opts.notes = argv[++i];
    else if (arg === "--platforms") opts.platforms = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  return opts;
}

/** Build the manifest object. Pure and deterministic for identical inputs. */
export function generateManifest({ signature, version, pubDate, notes = "", platforms = DEFAULT_DARWIN_PLATFORMS }) {
  const v = String(version || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`--version must be a semver tag, got ${JSON.stringify(version)}`);
  const sig = String(signature || "").trim();
  if (!sig) throw new Error("the payload signature is empty");
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) throw new Error(`--pub-date must be an ISO-8601 timestamp, got ${JSON.stringify(pubDate)}`);
  if (!platforms.length) throw new Error("at least one platform key is required");
  const entries = {};
  for (const key of platforms) {
    entries[key] = { signature: sig, url: URL_PLACEHOLDER };
  }
  return {
    version: v,
    notes,
    pub_date: date.toISOString(),
    platforms: entries,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  for (const req of ["sigPath", "version", "pubDate", "out"]) {
    if (!opts[req]) throw new Error(`missing required argument for ${req}\n${usage()}`);
  }
  const signature = readFileSync(opts.sigPath, "utf8").trim();
  const manifest = generateManifest({
    signature,
    version: opts.version,
    pubDate: opts.pubDate,
    notes: opts.notes,
    platforms: opts.platforms,
  });
  writeFileSync(opts.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ wrote ${opts.out} (version ${manifest.version}, ${Object.keys(manifest.platforms).length} platforms)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  });
}

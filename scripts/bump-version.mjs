#!/usr/bin/env node
// The app version is defined in THREE files that must stay in lockstep:
//   src-tauri/tauri.conf.json  (drives the bundle version + what the updater compares)
//   package.json
//   src-tauri/Cargo.toml
// If they drift, you can ship a release whose latest.json version isn't actually
// greater than the installed build — and the in-app updater silently never offers
// it. This script keeps them aligned.
//
// Usage:
//   node scripts/bump-version.mjs 0.2.0    # set all three to 0.2.0
//   node scripts/bump-version.mjs --check  # verify they match (used in CI)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;

// Targeted regex edits (not JSON.parse/stringify) so formatting stays intact and
// diffs stay to a single line. The first `version` in each file is the top-level
// / [package] one.
const targets = [
  {
    file: "src-tauri/tauri.conf.json",
    read: (s) => s.match(/"version":\s*"([^"]+)"/)?.[1],
    write: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: "package.json",
    read: (s) => s.match(/"version":\s*"([^"]+)"/)?.[1],
    write: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  {
    file: "src-tauri/Cargo.toml",
    read: (s) => s.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    write: (s, v) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  },
];

const current = () =>
  targets.map((t) => {
    const text = readFileSync(join(root, t.file), "utf8");
    return { ...t, text, version: t.read(text) };
  });

const arg = process.argv[2];

if (arg === "--check" || !arg) {
  const cur = current();
  for (const t of cur) console.log(`  ${t.version ?? "??"}  ${t.file}`);
  const versions = [...new Set(cur.map((t) => t.version))];
  if (versions.length !== 1 || !versions[0]) {
    console.error(
      `\n✗ versions disagree (${versions.join(", ")}). Run: node scripts/bump-version.mjs <x.y.z>`,
    );
    process.exit(1);
  }
  console.log(`\n✓ all three at ${versions[0]}`);
  process.exit(0);
}

if (!SEMVER.test(arg)) {
  console.error(`Expected a semver like 0.2.0, got "${arg}"`);
  process.exit(1);
}

for (const t of current()) {
  writeFileSync(join(root, t.file), t.write(t.text, arg));
  console.log(`  ${t.version} → ${arg}  ${t.file}`);
}
console.log(`\n✓ bumped to ${arg}. Next: update CHANGELOG.md, commit, then: git tag v${arg} && git push origin v${arg}`);

#!/usr/bin/env node
// Release-tool dependency audit — a BLOCKING CI gate (ci.yml).
//
// The production audit (`npm audit --omit=dev`) covers what ships INSIDE the
// app; this gate covers the tools that BUILD and PUBLISH a release, because
// they run with publication credentials on the release runner:
//   - `wrangler`        — invoked by scripts/stage-release.mjs with the R2
//     token (always the LOCKED local executable from package-lock, never npx);
//   - `@tauri-apps/cli` — drives the signed/notarized release build
//     (tauri-action resolves the locally installed CLI).
// A known-vulnerable release toolchain is a supply-chain risk in the exact
// place the secrets live, so an advisory ANYWHERE in these packages' resolved
// subtrees fails CI — at any severity, dev-dependency status notwithstanding.
//
// Method: `npm audit --json` (report version 2) lists each vulnerable package
// with `effects` — the packages it makes vulnerable one level up. The
// transitive closure of `effects` names every top-level package a finding
// reaches, so a finding whose closure touches (or is) a release-tool root
// belongs to the release toolchain. FAIL-CLOSED: a missing root, or an
// unreadable/unparseable audit report, is itself a gate failure.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The packages that hold release credentials in their hands. Keep in sync
 *  with scripts/stage-release.mjs (lockedWranglerBin) and release.yml. */
const RELEASE_TOOL_ROOTS = ["wrangler", "@tauri-apps/cli"];

function fail(msg) {
  console.error(`✗ release-tool audit: ${msg}`);
  process.exit(1);
}

// The gate must audit what it claims to audit: every root has to be a
// declared dependency, or a rename/removal would silently drop coverage.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
for (const name of RELEASE_TOOL_ROOTS) {
  if (!declared[name]) {
    fail(
      `root "${name}" is not a declared dependency — update RELEASE_TOOL_ROOTS in scripts/audit-release-tool.mjs to match the actual release toolchain.`,
    );
  }
}

// `npm audit --json` exits nonzero when findings exist anywhere in the tree —
// capture the report regardless and decide from its contents.
const res = spawnSync("npm", ["audit", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (!res.stdout) fail(`npm audit produced no report (${res.error?.message ?? res.stderr ?? "unknown error"})`);
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  fail(`npm audit output was not parseable JSON:\n${res.stdout.slice(0, 400)}`);
}
if (report.auditReportVersion !== 2) {
  fail(`unexpected audit report version ${report.auditReportVersion} — update this script for the new schema.`);
}
if (report.error) fail(`npm audit reported an error: ${JSON.stringify(report.error)}`);

const vulns = report.vulnerabilities ?? {};

/** Upward closure over `effects`: every package a finding in `name` reaches. */
function reaches(name) {
  const seen = new Set();
  const queue = [name];
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const eff of vulns[cur]?.effects ?? []) queue.push(eff);
  }
  return seen;
}

const findings = [];
for (const [name, v] of Object.entries(vulns)) {
  const closure = reaches(name);
  const hits = RELEASE_TOOL_ROOTS.filter((r) => closure.has(r));
  if (hits.length === 0) continue;
  const advisories = (v.via ?? [])
    .filter((x) => typeof x === "object")
    .map((x) => `${x.url ?? x.source ?? "?"} — ${x.title ?? ""}`.trim());
  findings.push({ name, severity: v.severity, range: v.range, roots: hits, advisories });
}

const rootVersions = RELEASE_TOOL_ROOTS.map((name) => {
  try {
    return `${name}@${JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version}`;
  } catch {
    return `${name}@(not installed — run npm ci)`;
  }
});

if (findings.length > 0) {
  console.error(`✗ release-tool audit: ${findings.length} advisory package(s) inside the release toolchain (${rootVersions.join(", ")}):`);
  for (const f of findings) {
    console.error(`  - ${f.name} (${f.severity}, ${f.range}) → reaches ${f.roots.join(", ")}`);
    for (const a of f.advisories) console.error(`      ${a}`);
  }
  console.error(
    "  Fix by refreshing the pinned tool (package.json + package-lock.json) — never by unpinning or npx.",
  );
  process.exit(1);
}

const totalElsewhere = Object.keys(vulns).length;
console.log(
  `✓ release-tool dependency subtrees clean (${rootVersions.join(", ")})` +
    (totalElsewhere ? ` — ${totalElsewhere} finding(s) elsewhere in the dev tree are outside these subtrees` : ""),
);

// R3-6 contract closure: the IPC surface documented in docs/IPC.md must be the
// EXACT set of commands registered with Tauri, and the version claims in the
// README, IPC.md, and lib.rs must agree. A command that ships undocumented is
// an unauditable surface; a documented command that no longer exists is a lie.
import { describe, expect, it } from "vitest";
import libRs from "../src-tauri/src/lib.rs?raw";
import ipcMd from "../docs/IPC.md?raw";
import readmeMd from "../README.md?raw";

/** Every cmd_* registered in the ONE generate_handler! block. */
function registeredCommands(): Set<string> {
  const block = libRs.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error("generate_handler! block not found in lib.rs");
  return new Set(block[1].match(/cmd_[a-z0-9_]+/g) ?? []);
}

/** Every cmd_* named in a `#### `-level heading of docs/IPC.md (combined
 *  headings like `#### \`cmd_a\` / \`cmd_b\`` document both). */
function documentedCommands(): Set<string> {
  const out = new Set<string>();
  for (const line of ipcMd.split("\n")) {
    if (!line.startsWith("#### ")) continue;
    for (const m of line.match(/cmd_[a-z0-9_]+/g) ?? []) out.add(m);
  }
  return out;
}

describe("IPC contract inventory (docs/IPC.md vs generate_handler!)", () => {
  it("every registered command is documented", () => {
    const documented = documentedCommands();
    const undocumented = [...registeredCommands()].filter((c) => !documented.has(c)).sort();
    expect(undocumented).toEqual([]);
  });

  it("every documented command is registered (no ghost docs)", () => {
    const registered = registeredCommands();
    const ghosts = [...documentedCommands()].filter((c) => !registered.has(c)).sort();
    expect(ghosts).toEqual([]);
  });

  it("the inventory parser actually found a real surface (sanity floor)", () => {
    expect(registeredCommands().size).toBeGreaterThan(50);
  });

  it("README, IPC.md, and lib.rs agree on the API version", () => {
    const rust = libRs.match(/COMMAND_API_VERSION: u32 = (\d+)/)?.[1];
    expect(rust).toBeDefined();
    expect(ipcMd).toContain(`The current API version is **${rust}**,`);
    expect(ipcMd).toContain(`(currently \`${rust}\`)`);
    expect(readmeMd).toContain(`Current API version is \`${rust}\`,`);
  });

  it("EVERY current-version constant/example in the docs matches lib.rs (R4 — no stale examples)", () => {
    const rust = Number(libRs.match(/COMMAND_API_VERSION: u32 = (\d+)/)?.[1]);
    expect(rust).toBeGreaterThan(0);
    // The recommended frontend check example must name the CURRENT version.
    const example = ipcMd.match(/FRONTEND_EXPECTED_API_VERSION = (\d+)/);
    expect(example, "the IPC.md example constant exists").not.toBeNull();
    expect(Number(example![1])).toBe(rust);
    // Any "current(ly) N" phrasing anywhere in either doc must be the real N.
    for (const doc of [ipcMd, readmeMd]) {
      for (const m of doc.matchAll(/current(?:ly)?(?: API)?(?: version)?(?: is)?[^.\d]{0,12}[`*]{0,2}(\d+)[`*]{0,2}/gi)) {
        expect(Number(m[1]), `stale current-version claim: ${JSON.stringify(m[0])}`).toBe(rust);
      }
    }
  });

  it("the version-check example is documented as NOT wired — and stays honest if someone wires it", () => {
    // Scan every non-test frontend source for an actual cmd_api_version call.
    const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.*"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const wired = Object.values(sources).some((src) =>
      /invoke(?:<[^>]*>)?\(\s*"cmd_api_version"/.test(src),
    );
    if (ipcMd.includes("**not currently wired**")) {
      expect(wired, "IPC.md says the check is not wired, but a frontend call exists — update the doc").toBe(false);
    } else {
      expect(wired, "IPC.md no longer says 'not currently wired', so the frontend must actually call cmd_api_version").toBe(true);
    }
  });

  it("no doc line claims the shipped frontend performs a startup version comparison (R6-8)", () => {
    // The R5 pass fixed the bottom of IPC.md but left the semver-commitment
    // section claiming "Frontends compare against their expected version on
    // startup" — a direct contradiction of the not-wired reality two hundred
    // lines down. Any startup-comparison sentence must state the honest
    // posture in the same line.
    expect(ipcMd).not.toMatch(/Frontends compare against their expected version on startup/);
    for (const doc of [ipcMd, readmeMd]) {
      for (const line of doc.split("\n")) {
        if (!/startup/i.test(line) || !/version/i.test(line) || !/compar/i.test(line)) continue;
        expect(line, `wired-implying startup-comparison claim: ${line}`).toMatch(
          /performs no startup version check|not wired|MAY compare/,
        );
      }
    }
  });

  it("EVERY runtime-version sentence says exposed-but-not-wired consistently (R5)", () => {
    // README and both IPC.md mentions carry the same honest posture: the
    // command is EXPOSED; the shipped frontend performs NO startup check.
    expect(readmeMd).toContain("performs no startup version check");
    expect(ipcMd).toContain("performs no startup version check");
    expect(ipcMd).toMatch(/cmd_api_version[\s\S]{0,600}?performs\s*\nno startup version check|performs\s+no startup version check/);
    // The old wired-implying phrasings stay gone.
    expect(readmeMd).not.toMatch(/Read at runtime via `invoke\("cmd_api_version"\)`\./);
    expect(ipcMd).not.toContain("Use this from the frontend on startup");
  });

  it("the NeedsCloudConsent shape carries host in both the TS type and the doc", async () => {
    const typesTs = (await import("./types.ts?raw")).default as string;
    expect(typesTs).toContain('{ kind: "NeedsCloudConsent"; message: string; host: string }');
    expect(ipcMd).toContain('{ kind: "NeedsCloudConsent"; message: string; host: string }');
  });

  it("cmd_confirm_cloud_send stays REMOVED: no registration, no docs, no frontend caller (R6-1)", () => {
    // The freestanding confirm was the consent-vs-send race; consent now rides
    // the ask itself. A reintroduction anywhere is a regression of R6-1.
    expect(registeredCommands().has("cmd_confirm_cloud_send")).toBe(false);
    expect(documentedCommands().has("cmd_confirm_cloud_send")).toBe(false);
    const sources = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.*"], {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    for (const [path, src] of Object.entries(sources)) {
      expect(src, `${path} must not invoke cmd_confirm_cloud_send`).not.toMatch(
        /invoke(?:<[^>]*>)?\(\s*"cmd_confirm_cloud_send"/,
      );
    }
    // The ask itself carries the binding: both consent surfaces pass `consent`.
    const tutor = sources["./components/MarginTutorCard.tsx"];
    const briefing = sources["./components/SectionBriefingCard.tsx"];
    expect(tutor).toMatch(/consent: consent \?\? null/);
    expect(briefing).toMatch(/consent: consent \?\? null/);
  });
});

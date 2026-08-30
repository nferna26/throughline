# Distributing Throughline from your own website

Throughline is sold and downloaded **directly from your site** — not the Mac App
Store. Users download a `.dmg`, open it, and drag the app into Applications, the
same as any Mac app from a popular site. This doc is the end-to-end pipeline:
build → sign → notarize → publish → host the download → auto-update.

Two related-but-separate docs:
- [`SIGNING.md`](./SIGNING.md) — the one-time Apple Developer ID + notarization setup.
- [`UPDATES.md`](./UPDATES.md) — how the in-app updater is wired.

---

## The shape of a release

> **Fail-closed since the public-beta audit (REL-008).** A tag no longer
> releases unconditionally. The pipeline refuses to publish anything unless:
> the tag's exact commit has a **green full CI run** and is an **ancestor of
> main**; **every** signing/notary/updater/R2 secret is present (there is no
> unsigned fallback any more); the built artifacts pass codesign (Developer ID
> + hardened runtime), universal-arch, exact-version, notarization/stapling,
> and a **cryptographic minisign check** of the updater payload (the Rust
> reference verifier — the exact `minisign-verify` crate + call the updater
> ships with — plus the JS implementation as a cross-check); and the immutable
> content-addressed objects read back byte-identical from R2. Only then is
> **the one mutable pointer** switched — a single atomic PUT of
> `updates/latest.json`, which names the whole release tuple including the DMG
> — with the previous manifest retained as `updates/rollback.json`, the public
> origin re-verified cryptographically, and the GitHub release created last.
>
> **One pointer, by design.** Every artifact lives at an immutable
> content-addressed key: `updates/Throughline-<ver>-<sha12>.app.tar.gz`, its
> `.sig`, and `updates/Throughline-<ver>-<sha12>.dmg` (first 12 hex chars of
> each file's SHA-256). The engine refuses to overwrite an existing key with
> different bytes (an interrupted rerun re-puts identical bytes only). The
> manifest carries the platform URLs **and** a `dmg { url, key, sha256 }`
> block, so promoting a release — or rolling one back — is exactly one object
> write. The site Worker's `/download` route resolves the DMG *through* the
> manifest, so the public download and the updater can never disagree about
> which release is live. There is no separate `Throughline.dmg` pointer write
> any more (the Worker falls back to that legacy key only if the manifest is
> absent).
>
> **Serialization + downgrade guard.** The workflow runs under a
> `release-publish` concurrency group (`cancel-in-progress: false`), so two
> tag pushes can never interleave their publication steps; independently, the
> staging engine reads the live manifest first and **refuses** to publish a
> version lower than the one already live (`DOWNGRADE REFUSED`), and fails
> closed on an unreadable/unparseable live pointer rather than guessing.
>
> **Locked tooling.** `wrangler` is an exact-pinned devDependency installed by
> `npm ci` from `package-lock.json`; the staging engine invokes that locked
> local executable directly. Publication credentials never run `npx --yes`
> (i.e. never execute code fetched at publish time). The pinned toolchain is
> also AUDITED as a blocking CI gate: `scripts/audit-release-tool.mjs` fails
> the build on any advisory anywhere in the `wrangler` or `@tauri-apps/cli`
> subtrees — the packages that run with these credentials (see
> `docs/AUDIT.md`).
>
> **One-time operator actions (Nick):** ① create the `release` GitHub
> **environment** (Settings → Environments → New environment → `release`),
> add yourself as a required reviewer, and move the release secrets onto it —
> the gate job API-checks this and fails until it exists; ② deploy the updated
> site Worker (throughline-site) **before** cutting the next release, because
> the pipeline no longer writes the legacy `Throughline.dmg` key and the old
> Worker would keep serving a stale DMG (the post-publish origin check would
> catch this and fail the run).
>
> **The release guard is a write-ahead transaction (R9-3).** Before the
> pointer can change, the workflow writes `updates/unresolved.json` as a
> PENDING record naming the release id and the exact new-pointer digest, and
> read-back-verifies it. The guard stays armed through promotion AND the
> public post-verification; only then does the workflow resolve it (matched
> by release id + digest, re-read immediately before the resolution write).
> R11-1: the "never resolves another release's guard" property holds UNDER
> SERIALIZATION — the `release-publish` concurrency group for workflow runs,
> the quiescence step below for operator runs — and both resolvers refuse to
> run without that precondition asserted (`--quiescence release-lease` /
> `--quiescence operator`). The guard store has no conditional write, so
> without that serialization the window between the resolver's final re-read
> and its write is not mechanically closed.
> A runner that dies at any boundary after the guard was written leaves every
> later release blocked until an operator resolves it. The guard is stored
> `no-store` like the other mutable pointers — never trust a cached copy.
> R10-3: a RESTORED pointer does not resolve the guard either — the restore
> is a claim until the restored origin passes the full cryptographic
> verification, after which the workflow runs the explicit restore-resolution
> (`--resolve-restored-guard`, carrying the original guard's release id +
> pointer digest plus the verified restored-pointer digest). On the non-CAS
> production store the automated paths remain REPORT-ONLY: the engine
> guarantees it never writes over an unverified or concurrent state, not that
> it can complete a rollback for you — completing one is the runbook below.
>
> **Rollback (an OPERATOR action — nothing rolls back automatically):**
> R2 offers no conditional write through wrangler, so neither the workflow's
> failure recovery nor `--rollback` will ever auto-overwrite the live pointer
> — an ambiguous run instead REPORTS the live state and leaves the
> `updates/unresolved.json` guard standing. `--rollback` additionally
> requires the operator to BIND the state they saw
> (`--expect-live-version x.y.z --expect-rollback-sha256 <64-hex>`) and
> refuses if either has moved. The manual runbook (a bare
> check-then-`put` is NOT safe — a concurrent release between your check and
> your put would be silently clobbered):
>
> 1. **Quiesce:** confirm no release workflow is running or queued
>    (`gh run list --workflow release.yml`), and do not resolve the guard —
>    it is what blocks new releases while you work.
> 2. **Pin what you see:** download both pointers and record their digests —
>    `wrangler r2 object get throughline-downloads/updates/latest.json --file live.json`,
>    `wrangler r2 object get throughline-downloads/updates/rollback.json --file rollback.json`,
>    then `shasum -a 256 live.json rollback.json`. Verify `rollback.json`
>    names the release you intend to restore (its content-addressed artifacts
>    are all still in the bucket — nothing immutable is ever deleted).
> 3. **Restore:** `wrangler r2 object put throughline-downloads/updates/latest.json --file rollback.json --content-type application/json --cache-control no-store`.
> 4. **Read back:** `get` `updates/latest.json` again and compare its digest
>    to the `rollback.json` digest from step 2 — byte-identical or you stop
>    and re-inspect.
> 5. **Verify publicly — cryptographically (MANDATORY):**
>    `node scripts/verify-release-assets.mjs --expected-version v<rolled-back-to>
>    --pubkey-from-tauri-conf src-tauri/tauri.conf.json` — the payload bytes
>    must hash to their content-addressed URL, the DMG bytes must match the
>    manifest's own `dmg.sha256`, the manifest signature must equal the
>    served `.sig`, and the minisign signature must verify over the served
>    payload. Do NOT resolve the guard on anything less.
> 6. **Only now resolve the guard** (you asserted quiescence in step 1 —
>    that is the serialization the resolver requires):
>    `node scripts/stage-release.mjs --resolve-guard <pre-stage.json> --bucket
>    throughline-downloads --quiescence operator` — or overwrite
>    `updates/unresolved.json` with
>    `{"resolved": true, "releaseId": "<the guarded id>"}` (or delete it).
>    While any step above fails, leave it standing — it is the only thing
>    preventing the next tag from publishing over an unverified pointer.

Everything is built in CI by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
when you push a version tag. One macOS job produces, for a **universal** binary
(one download runs on Apple Silicon **and** Intel):

| Artifact | What it's for |
| --- | --- |
| `Throughline_<ver>_universal.dmg` | **The download.** Drag-to-Applications installer for your website. |
| `Throughline.app.tar.gz` | The auto-update payload (existing users download this, not the dmg). |
| `Throughline.app.tar.gz.sig` | minisign signature of the payload. |
| `latest.json` | The update manifest the app polls. |

tauri-action is **build-only** here — it builds, signs, and notarizes but
publishes nothing. Runtime distribution lives on Cloudflare R2 behind
`readthroughline.com`: the workflow uploads the content-addressed payload,
`.sig`, and DMG, then promotes them with the single `updates/latest.json`
write; the GitHub release (a convenience mirror of the same verified bytes)
is created last. Pushing the tag is the single switch, so all review happens
**before** tagging (the repo's RC practice: `SHOT1_RC.md`,
`WEEKEND_RC_LOG.md`).

```
git tag vX.Y.Z
git push origin vX.Y.Z       # → CI builds, signs, notarizes, PUBLISHES the release
```

---

## Why notarization is non-negotiable here

App Store apps are vouched for by Apple automatically. A `.dmg` from your own
site is **not** — so without notarization, Gatekeeper shows *"Throughline is
damaged and can't be opened"* or *"unidentified developer,"* and a paying
customer's first experience is a scary error. To avoid that, the app must be:

1. **Signed** with a *Developer ID Application* certificate (not "Apple
   Development"), and
2. **Notarized + stapled** by Apple.

The release workflow does both automatically — see [`SIGNING.md`](./SIGNING.md).
There is **no unsigned fallback**: a secrets preflight fails the run before the
build starts if any Apple/updater/R2 secret is missing, so an unsigned `.dmg`
can never be produced by the release pipeline, let alone shipped.

> **The `.dmg` container is notarized too, not just the app.** Tauri notarizes
> and staples the `.app` (which is what the auto-updater ships), but it does *not*
> notarize the `.dmg` itself — and a quarantined, un-notarized `.dmg` triggers
> *"can't be opened because Apple cannot check it for malicious software"* on the
> first double-click. So the workflow has a dedicated step that runs
> `xcrun notarytool submit … --wait` + `xcrun stapler staple` on the `.dmg` and
> replaces the release asset. Verify any release with
> `xcrun stapler validate <dmg>` and `spctl -a -t open --context context:primary-signature -vvv <dmg>`
> (want: `source=Notarized Developer ID`).

---

## Required CI secrets

Set these in the GitHub repo: **Settings → Secrets and variables → Actions**.

**Updater (required — the build fails without it):**

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | full contents of `~/.throughline-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (the key was generated without one) |

**Cloudflare R2 distribution (required before the repo goes private):**

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token with R2 object edit access |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns `throughline-downloads` |

**Apple signing + notarization (required for a clean install):**

| Secret | Where it comes from |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of your Developer ID `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an **app-specific password** (not your Apple ID password) |
| `APPLE_TEAM_ID` | your 10-char Team ID |

Full walkthrough for the Apple ones: [`SIGNING.md`](./SIGNING.md).

---

## Putting the download on your website

The public install URL is stable:

```
https://readthroughline.com/download
```

The site Worker reads `updates/latest.json` from the Cloudflare R2 bucket
`throughline-downloads`, resolves the immutable DMG key it names
(`manifest.dmg.key`), and streams that object — the reader still saves a file
named `Throughline.dmg`. Because the download resolves through the same
manifest the updater polls, one atomic manifest write moves both. This keeps
the customer download independent of GitHub Releases, so the source repo can
be private without breaking install.

---

## Where auto-update artifacts live

The in-app updater (Settings → Software → Updates) fetches
`https://readthroughline.com/updates/latest.json`, configured in
`tauri.conf.json → plugins.updater.endpoints`.

The release workflow uploads the release tuple to the same R2 bucket under
`updates/`, at immutable content-addressed keys, then promotes it with the
manifest:

- `updates/Throughline-<ver>-<sha12>.app.tar.gz` (updater payload)
- `updates/Throughline-<ver>-<sha12>.app.tar.gz.sig` (minisign signature)
- `updates/Throughline-<ver>-<sha12>.dmg` (public download)
- `updates/latest.json` — the ONE mutable object; its platform `url`s point at
  the content-addressed payload above, and its `dmg` block names the DMG.

The staging engine rewrites each `latest.json` platform `url` to the
content-addressed payload URL. It does not alter or re-sign the payload; the
minisign signature remains valid because it covers the `.app.tar.gz` bytes,
not the URL where those bytes are hosted.

Either way the payload is **minisign-signed** and verified against the public key
baked into `tauri.conf.json`, so hosting it publicly is safe — a tampered update
won't install.

---

## Cutting a release (checklist)

1. **Bump the version in all three** (they must match):
   - `src-tauri/tauri.conf.json` → `version`
   - `package.json` → `version`
   - `src-tauri/Cargo.toml` → `version`

   The updater only offers an update when `latest.json`'s `version` is **greater
   than** the installed app's, so this must climb every release.
2. Update `CHANGELOG.md`.
3. Review the release candidate **now** — pushing the tag publishes, there is no
   draft to catch mistakes afterwards.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. Watch the **Release** workflow go green. The release is usable the moment the
   workflow finishes: `https://readthroughline.com/download` serves the newest
   DMG, and existing users get the update next time they click *Check for
   updates*.
6. **Confirm the updater can see it** — this gate is what catches a broken
   pipeline before a reader does:

   ```
   curl -sL -o /dev/null -w '%{http_code}' \
     https://readthroughline.com/updates/latest.json
   ```

   Must print `200`. Also confirm `https://readthroughline.com/download`
   resolves. Anything else means the R2 publish or site Worker is broken — stop
   and fix before announcing or making the repo private.
7. Sanity-check the `.dmg` opens cleanly on a real Mac (ideally one that never
   had the dev build).

---

## Shipping status (current release line: v0.9.3)

This pipeline is live — the standing prerequisites are in place, and the 0.9.x
line (through **v0.9.3**, 2026-07-12; see `CHANGELOG.md`) ships through it:

- ✅ **Apple signing + notarization secrets** set, and the *Developer ID
  Application: Trainable LLC* cert is in the keychain.
- ✅ **Updater signing key** (`TAURI_SIGNING_PRIVATE_KEY`) uploaded; its public
  half matches the `pubkey` baked into `tauri.conf.json`.
- ✅ **Releases publish on tag**, fail-closed: green-CI + main-ancestry gate,
  the protected `release` environment (required reviewers), staged
  content-addressed R2 publication, and the single atomic manifest promotion.
- ✅ **Release tooling is pinned AND audited** — exact-pinned wrangler invoked
  locally (never `npx`), with a blocking CI audit over the release-tool
  subtrees (`scripts/audit-release-tool.mjs`; see `docs/AUDIT.md`).

Per release, after the workflow goes green (steps 6–7 of the checklist above):

- **Verify the public origin**: `/updates/latest.json` returns `200` and
  `/download` resolves from `readthroughline.com` (the workflow's post-verify
  step already proved the bytes cryptographically — this is the human
  spot-check).
- **Sanity-check the `.dmg` on a clean Mac** — Gatekeeper opens it with no
  warning and no right-click.
- **Keep the repo public until R2 is proven** — if the repo is ever made
  private, do it only while `/download` and `/updates/latest.json` serve from
  R2, since GitHub Releases are just a convenience mirror.

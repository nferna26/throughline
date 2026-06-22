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

Everything is built in CI by [`.github/workflows/release.yml`](../.github/workflows/release.yml)
when you push a version tag. One macOS job produces, for a **universal** binary
(one download runs on Apple Silicon **and** Intel):

| Artifact | What it's for |
| --- | --- |
| `Throughline_<ver>_universal.dmg` | **The download.** Drag-to-Applications installer for your website. |
| `Throughline.app.tar.gz` | The auto-update payload (existing users download this, not the dmg). |
| `Throughline.app.tar.gz.sig` | minisign signature of the payload. |
| `latest.json` | The update manifest the app polls. |

tauri-action still builds, signs, notarizes, and may upload the artifacts to a
GitHub Release, but runtime distribution lives on Cloudflare R2 behind
`readthroughline.com`. Pushing the tag is the single switch that uploads
`Throughline.dmg`, the updater payload, its `.sig`, and `latest.json` to R2, so
all review happens **before** tagging (the repo's RC practice: `SHOT1_RC.md`,
`WEEKEND_RC_LOG.md`).

```
git tag v0.1.0
git push origin v0.1.0       # → CI builds, signs, notarizes, PUBLISHES the release
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

The release workflow does both automatically **once the Apple secrets are set**
— see [`SIGNING.md`](./SIGNING.md). Until they are, CI still builds a `.dmg`, but
it's **unsigned** and users must right-click → Open. Do not ship the unsigned
one to customers.

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

The site Worker streams `Throughline.dmg` from the Cloudflare R2 bucket
`throughline-downloads`. The release workflow uploads the newest universal DMG
to that object key after signing and notarization. This keeps the customer
download independent of GitHub Releases, so the source repo can be private
without breaking install.

---

## Where auto-update artifacts live

The in-app updater (Settings → Software → Updates) fetches
`https://readthroughline.com/updates/latest.json`, configured in
`tauri.conf.json → plugins.updater.endpoints`.

The release workflow uploads three updater files to the same R2 bucket under
`updates/`:

- `updates/latest.json`
- `updates/Throughline.app.tar.gz`
- `updates/Throughline.app.tar.gz.sig`

Before upload, the workflow rewrites each `latest.json` platform `url` to
`https://readthroughline.com/updates/Throughline.app.tar.gz`. It does not alter
or re-sign the payload; the minisign signature remains valid because it covers
the `.app.tar.gz` bytes, not the URL where those bytes are hosted.

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

## Status / what's left before the first public release

Done:
- ✅ **Apple signing + notarization secrets** set, and the *Developer ID
  Application: Trainable LLC* cert is in the keychain.
- ✅ **Updater signing key** (`TAURI_SIGNING_PRIVATE_KEY`) uploaded; its public
  half matches the `pubkey` baked into `tauri.conf.json`.
- ✅ **Releases publish on tag.** The workflow publishes every future tag
  directly, then uploads runtime distribution artifacts to R2.

Remaining:
- **Push the branch + a tag.** The release workflow checks out the tagged commit,
  so the commits must be on GitHub. Bump with `npm run version:set <x.y.z>`, then
  `git push` the branch and `git tag vX.Y.Z && git push origin vX.Y.Z`.
- **Test the notarized `.dmg`** on a clean Mac — Gatekeeper should open it with no
  warning and no right-click.
- **Do not make the GitHub repo private** until a real release has uploaded
  `Throughline.dmg`, `updates/latest.json`, `updates/Throughline.app.tar.gz`,
  and `updates/Throughline.app.tar.gz.sig` to R2, and both `/download` and
  `/updates/latest.json` resolve from `readthroughline.com`.

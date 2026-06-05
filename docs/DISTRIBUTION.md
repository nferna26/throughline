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

tauri-action uploads all four to a GitHub **draft** Release. You review, then
publish. Publishing is the single switch that (a) makes the download link live
and (b) activates auto-update for existing users.

```
git tag v0.1.0
git push origin v0.1.0       # → CI builds, signs, notarizes, creates a DRAFT release
# review the draft on GitHub → Publish
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

---

## Required CI secrets

Set these in the GitHub repo: **Settings → Secrets and variables → Actions**.

**Updater (required — the build fails without it):**

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | full contents of `~/.throughline-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (the key was generated without one) |

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

The published GitHub release exposes a **stable** asset URL:

```
https://github.com/<owner>/<repo>/releases/latest/download/Throughline_<ver>_universal.dmg
```

Two ways to wire your site's **Download / Buy** button:

- **Link straight to that URL.** Simplest. The catch: a public GitHub release is
  publicly downloadable, so the `$5` is honor-system (which fits the "$5, or free
  for vibecoders" model — the free path is the open-source guts anyway).
- **Deliver the `.dmg` through your store after payment.** Upload the same `.dmg`
  to your checkout (Gumroad, Lemon Squeezy, Paddle, etc.) and let it hand the
  file to buyers. This gates the *download*. Note that auto-update still needs
  the manifest + payload reachable publicly (next section), so updates are not
  gated even if the first download is — fine, since only people who already paid
  for/installed the app ever fetch them.

> **Heads-up on the public release.** If you want the very first `.dmg` to be
> paid-only, you have two choices: (a) deliver it via your store and keep the
> GitHub release for updater artifacts only, or (b) accept the honor-system
> model. You cannot have a published release whose `latest.json` is public but
> whose `.dmg` asset is private — published assets are all public.

---

## Where auto-update artifacts live

The in-app updater (Settings → Software → Updates) fetches the URL in
`tauri.conf.json → plugins.updater.endpoints`. Two hosting options:

1. **GitHub Releases (default, zero extra infra).** Endpoint stays
   `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
   tauri-action already publishes `latest.json` + the payload there. Nothing else
   to host. **Recommended to start.**

2. **Your own domain.** Point the endpoint at e.g.
   `https://yourdomain.com/throughline/latest.json` and upload the three updater
   files (`latest.json`, `*.app.tar.gz`, `*.app.tar.gz.sig`) there each release.
   Full control + lets you keep GitHub out of the loop entirely. Costs you an
   upload step (rsync/S3/Netlify) and keeping the URLs in `latest.json` pointing
   at your host.

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
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Watch the **Release** workflow go green.
5. Open the **draft** release on GitHub, sanity-check the `.dmg` opens cleanly on
   a real Mac (ideally one that never had the dev build), then **Publish**.
6. Your website's download link (pointing at `/releases/latest/download/...`)
   now serves it; existing users get the update next time they click *Check for
   updates*.

---

## ⚠️ Finalize before the first public release

- **Repo name in the endpoint.** `tauri.conf.json → plugins.updater.endpoints`
  is `https://github.com/nferna26/throughline/...`. The repo is still
  **`ReadingGym`** at the time of writing. The endpoint **must** match the real
  repo (owner + name) or the updater 404s. Update it, or switch to the
  own-domain option above.
- **Apple + updater secrets set** (tables above).
- **Tested the notarized `.dmg`** on a clean Mac — Gatekeeper opens it with no
  warning and no right-click.

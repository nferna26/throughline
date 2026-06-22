# Auto-update (Throughline)

Throughline ships a **reader-initiated** auto-updater (Settings → Software →
Updates): it checks **only when the user clicks**, never on launch or a timer, so
it stays within the no-background-network posture. On an available update it
downloads the **signed** package, installs it, and relaunches into the new
version — like the Claude desktop app.

## How it's wired (already in the repo)

- **Plugins:** `tauri-plugin-updater` + `tauri-plugin-process` (`Cargo.toml`,
  `package.json`, registered in `src-tauri/src/lib.rs`). These are explicitly
  *not* `tauri-plugin-http`/`tauri-plugin-shell` (which the guardrail bans).
- **Config:** `src-tauri/tauri.conf.json` → `plugins.updater` (`endpoints`,
  `pubkey`) and `bundle.createUpdaterArtifacts: true`.
- **Permissions:** `src-tauri/capabilities/default.json` → `updater:default`,
  `process:allow-restart`.
- **UI:** `src/components/UpdateChecker.tsx`, shown in Settings.

## Signing keys

The updater verifies every download against a **minisign** public key baked into
`tauri.conf.json`. The matching private key signs each release.

- **Public key:** in `tauri.conf.json` → `plugins.updater.pubkey` (safe to commit).
- **Private key:** generated to `~/.throughline-updater.key` (password was empty).
  **Keep it secret — it is NOT in the repo.** Store it as a CI secret. To rotate:
  `npx tauri signer generate -w ~/.throughline-updater.key` and replace the pubkey.

## Releasing an update

The release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml))
now builds, signs, notarizes, and uploads everything below on a `v*` tag,
including the updater signing env (`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). The full website-distribution pipeline
(secrets, hosting, cutting a release) lives in
[`DISTRIBUTION.md`](./DISTRIBUTION.md). Review happens before tagging, and once
the workflow goes green, the public site serves both install and update assets
from Cloudflare R2. Each release publishes to `readthroughline.com`:

1. The signed + notarized `.app` (you already build this in CI — see
   [`SIGNING.md`](./SIGNING.md)).
2. The updater artifacts Tauri emits when `createUpdaterArtifacts` is on:
   `Throughline.app.tar.gz` and `Throughline.app.tar.gz.sig`.
3. A `latest.json` manifest, e.g.:

   ```json
   {
     "version": "0.2.0",
     "notes": "What changed",
     "pub_date": "2026-06-04T00:00:00Z",
     "platforms": {
         "darwin-aarch64": {
           "signature": "<contents of Throughline.app.tar.gz.sig>",
           "url": "https://readthroughline.com/updates/Throughline.app.tar.gz"
         },
       "darwin-x86_64": { "signature": "...", "url": "..." }
     }
   }
   ```

`tauri-apps/tauri-action` still builds and minisign-signs the updater payload.
The workflow then rewrites only the manifest URL fields and uploads the
unchanged `.app.tar.gz`, its `.sig`, and the rewritten `latest.json` to R2. The
env is already wired; you just set the matching **repo secrets**:

- `TAURI_SIGNING_PRIVATE_KEY` = contents of `~/.throughline-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `` (empty, as generated)
- `CLOUDFLARE_API_TOKEN` = Cloudflare token with R2 object edit access
- `CLOUDFLARE_ACCOUNT_ID` = Cloudflare account that owns `throughline-downloads`

## ⚠️ Finalize before shipping

- **Endpoint URL.** `plugins.updater.endpoints` points at
  `https://readthroughline.com/updates/latest.json`. Do not make the repo
  private until a real release has uploaded `latest.json`, the payload, and the
  `.sig` to R2 and the post-release check in [`DISTRIBUTION.md`](./DISTRIBUTION.md)
  passes.
- **`version`** in `tauri.conf.json` must increase for each release, and
  `latest.json`'s `version` must be greater than the installed app's for the
  updater to offer it.
- The app must be **signed + notarized** for macOS to launch the updated `.app`.

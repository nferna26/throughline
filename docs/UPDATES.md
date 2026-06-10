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
now builds, signs, and publishes everything below automatically on a `v*` tag —
including the updater signing env (`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). The full website-distribution pipeline
(secrets, hosting, cutting a release) lives in
[`DISTRIBUTION.md`](./DISTRIBUTION.md). The workflow **publishes the release as
part of the tag build** — review happens before tagging, and once the workflow
goes green, `/releases/latest` resolves and every installed app's *Check for
updates* sees it. Each release publishes, to the GitHub Releases of the repo
the `endpoints` URL points at:

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
         "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/Throughline.app.tar.gz"
       },
       "darwin-x86_64": { "signature": "...", "url": "..." }
     }
   }
   ```

This is handled by **`tauri-apps/tauri-action`** in the release workflow, which
builds, signs the update, and uploads `latest.json` for you. The env is already
wired; you just set the matching **repo secrets**:

- `TAURI_SIGNING_PRIVATE_KEY` = contents of `~/.throughline-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = `` (empty, as generated)

## ⚠️ Finalize before shipping

- **Endpoint URL.** `plugins.updater.endpoints` points at
  `https://github.com/nferna26/throughline/releases/latest/download/latest.json`.
  This resolves as long as the latest tagged release went green — the release
  workflow publishes on tag, and the post-release check in
  [`DISTRIBUTION.md`](./DISTRIBUTION.md) (curl must print `200`) confirms it.
- **`version`** in `tauri.conf.json` must increase for each release, and
  `latest.json`'s `version` must be greater than the installed app's for the
  updater to offer it.
- The app must be **signed + notarized** for macOS to launch the updated `.app`.

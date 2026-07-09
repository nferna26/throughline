# Updater UX report — reading-gym (branch `fable/updater-ux`)

CORE-1192 (the dead "Download update" button + first-click) and CORE-1193 (durable
manual update path + match-Claude polish), per the research memo. **No merge.** One
commit, `5d657fa`, branched from `main` @ `94b9966` (v0.9.1). App-only: the relay,
money/consent paths, and the embedded minisign verification are untouched.

## What changed

**One state machine** (`src/updateMachine.ts`) now owns the whole update lifecycle:
`idle → checking → (upToDate | available) → downloading(progress) → readyToRestart →
relaunching`, plus `error(offline | check | download | restart)`, with a `critical`
flag alongside. The pill (`UpdateChecker.tsx`) and the new Settings › Software Update
pane (`SoftwareUpdate.tsx`) are thin views over the same store, so every click acts on
the machine's live phase (never stale React state) and dismissing the pill never hides
the truth from Settings.

- **CORE-1192:** `openUrl` (tauri-plugin-opener) replaces `window.open` — a no-op in
  wry and the whole reason the button was dead. Capability scoped to
  `https://readthroughline.com/*` only. `acceptFirstMouse: true` on the window (wry
  #637). The pill's failure state is "Try again" (re-runs in-app); the external
  website download is demoted to last-resort recovery in the Settings error state.
- **CORE-1193:** Settings › Software Update (new rail destination) with the memo's
  verbatim copy for every state; macOS app-menu "Check for Updates…" (inserted into
  `Menu::default`'s app submenu, right after About) that focuses the window, jumps to
  the section, and starts a manual check; manual checks always bypass the 30-minute
  cooldown while the four automatic triggers (launch / focus / wake / backstop,
  CORE-1159) keep respecting it; auto-download ON by default with a
  "Download updates automatically" toggle (localStorage, like the app's other
  frontend-only prefs); critical updates re-surface a dismissed pill once per launch —
  still no forced modal, no forced restart, explicit `relaunch()` only on the reader's
  click.
- **Tests:** the old suite asserted a mocked `window.open` — green forever while the
  shipped button did nothing. Those assertions are deleted; the opener is mocked as
  `@tauri-apps/plugin-opener` and asserted as `openUrl` with the exact URL; a
  source-scan test bans `window.open` on the update path; `e2e/update.spec.ts` drives
  real clicks in the real React app and observes the real plugins' IPC at the faked
  `__TAURI_INTERNALS__` boundary (opener URL, relaunch-marker-before-restart ordering,
  CORE-1191 no-phantom-pill).

## Gates (all at `5d657fa`)

- `cargo test --all-targets -- --test-threads=1`: **377 passed, 0 failed** (CORE-1178
  flake avoided by single-threading)
- vitest: **528 passed** (45 files) · `tsc --noEmit` clean · vite build ok
- clippy `-D warnings` clean · `cargo fmt --check` clean
- Playwright: **107 passed** (walkthrough + a11y + library + tutor-anchor + the new
  update spec; Software Update added to the a11y rail sweep)
- Golden loop: `cargo run --example stage2_golden_loop` → **GOLDEN LOOP PASS**

## Real-app verification (vs. mocked)

Verified in a **real release build** (`tauri build`, signed
`Developer ID Application: Trainable LLC`, hardened runtime; local build not
notarized — no notary credentials in this session) run against an isolated
`THROUGHLINE_DATA_DIR`, with the **real production endpoint** and **zero mocks**. To
make the shipped 0.9.1 release count as an update, the build carried a temporary,
uncommitted `version: 0.9.0`; the temp config was reverted after.

Observed in the real app, unattended (auto-download default, no clicks):

1. Launch check (8s) hit `https://readthroughline.com/updates/latest.json` and found
   0.9.1.
2. The pill surfaced **"Updating"** with the quiet progress bar (screenshot), no
   percentage in the pill, reading untouched.
3. The real 20 MB `Throughline.app.tar.gz` downloaded; the **embedded minisign
   verification ran against the real signature and accepted it**; the updater
   **installed the real artifact**: the on-disk bundle's `CFBundleShortVersionString`
   flipped 0.9.0 → 0.9.1, and `spctl -a -vv` on the replaced bundle reports
   **"accepted · source=Notarized Developer ID"** — i.e. the notarized production app
   is what got installed.
4. No auto-relaunch happened (the old process kept running) — the macOS constraint
   holds: restart only on the reader's explicit click.
5. The pill settled on **"Restart to update"** with its dismiss control (screenshot).
6. The custom app menu built and the app ran clean (startup logs error-free; menu code
   would fail setup loudly).

Covered by mocked tests + the real-click Playwright e2e (not by the real-app run):

- The opener click itself (`openUrl` → browser): unit-asserted with the exact URL and
  driven by a real click in the e2e, where the real plugin's
  `plugin:opener|open_url` IPC was observed leaving the webview. In the real app the
  error state that exposes the button requires a failing download, which needs either
  a config that weakens update transport (blocked, correctly) or network tampering
  (not acceptable on this machine).
- Signature-mismatch rejection: reducer/e2e-covered (`signature mismatch` →
  error(download) → "Try again" + website last-resort). The real-app run proves the
  verifier is active in the real pipeline (it verified and accepted the genuine
  artifact); no tampered-artifact rejection was staged for the reason above.
- Restart-click relaunch: e2e observes marker-then-`plugin:process|restart` ordering;
  unit tests cover the failure path (marker consumed, error(restart), retry re-offers).

**Not verifiable this session** (no accessibility permission for synthetic input, and
the operator was actively using the machine): a physical first-click on an unfocused
window (`acceptFirstMouse`), and a hand-click through the menu item / Settings
buttons in the real app. Each is a ~30-second hand check:

1. Focus another app, then single-click the "Restart to update" pill — it must act on
   that first click.
2. Throughline menu → "Check for Updates…" → lands on Settings › Software Update,
   checking immediately.

## Notes for review

- `Settings` grew an eighth rail destination ("Software Update"). CLAUDE.md's
  "seven destinations" enumeration predates this memo-mandated section and should be
  updated on merge.
- The `online` event is a new, narrowly-scoped recovery trigger: it re-checks only
  from the offline-error state (keeping the Settings copy's promise); the four
  automatic triggers and their cooldown are otherwise unchanged.
- The critical-update pill is now dismissable (was: no dismiss control), per the memo:
  dismissal is session-only and a critical update re-surfaces the pill once per
  launch.

# macOS Code Signing & Notarization

This is the one-time setup to make Throughline's `.dmg` open cleanly on any Mac
(no Gatekeeper warning). The release workflow (`.github/workflows/release.yml`)
already consumes the secrets below — once you set them, tagged releases sign +
notarize automatically.

> **Status check:** run `security find-identity -v -p codesigning`. You
> currently have **Apple Development** certs only. Those can't notarize. You
> need a **Developer ID Application** cert (step 1). It's free to create with
> your existing paid developer account.

---

## 1. Create the Developer ID Application certificate

**Easiest — via Xcode:**

1. Xcode → Settings → Accounts → select your Apple ID → **Manage Certificates…**
2. Click **+** → **Developer ID Application**.
3. It generates and installs into your login keychain.

(Requires the **Account Holder** role on the developer team. If the **+** menu
doesn't offer "Developer ID Application," your role doesn't permit it — ask the
account holder, or create it at developer.apple.com → Certificates → **+** →
Developer ID Application, uploading a CSR from Keychain Access → Certificate
Assistant → Request a Certificate from a Certificate Authority.)

**Verify it landed:**

```bash
security find-identity -v -p codesigning
```

You should now see a line like:

```
"Developer ID Application: Nicholas Fernandez (XXXXXXXXXX)"
```

The 10-character code in parentheses is your **Team ID**. The full quoted string
is your **signing identity**.

---

## 2. Export the cert as a .p12

1. Open **Keychain Access** → **login** keychain → **My Certificates**.
2. Find **Developer ID Application: …**, expand it (there's a private key under it).
3. Right-click the certificate → **Export "Developer ID Application: …"** →
   save as `throughline-cert.p12`. Set a strong export password — you'll need it
   in step 4 (this is `APPLE_CERTIFICATE_PASSWORD`).

Base64-encode it for GitHub (secrets must be text):

```bash
base64 -i throughline-cert.p12 | pbcopy   # now on your clipboard
# or to a file:
base64 -i throughline-cert.p12 -o throughline-cert.p12.b64
```

---

## 3. Create an app-specific password for notarization

Apple won't accept your main Apple ID password here. Generate a dedicated one:

1. Go to <https://appleid.apple.com> → **Sign-In and Security** → **App-Specific Passwords**.
2. Generate one named e.g. `throughline-notarize`. Copy the `xxxx-xxxx-xxxx-xxxx` value.
   This is `APPLE_PASSWORD`.

---

## 4. Set the six GitHub secrets

From the repo root, with the `gh` CLI authenticated (`gh auth status`):

```bash
# The base64 cert (paste the clipboard contents, or pipe the .b64 file):
gh secret set APPLE_CERTIFICATE < throughline-cert.p12.b64

# The .p12 export password from step 2:
gh secret set APPLE_CERTIFICATE_PASSWORD

# The full identity string from step 1 (include the quotes' contents, not the quotes):
gh secret set APPLE_SIGNING_IDENTITY
# when prompted, paste:  Developer ID Application: Nicholas Fernandez (XXXXXXXXXX)

# Your Apple ID email:
gh secret set APPLE_ID
# paste:  you@example.com   (or whichever the cert is under)

# The app-specific password from step 3:
gh secret set APPLE_PASSWORD

# Your 10-char Team ID from step 1:
gh secret set APPLE_TEAM_ID
```

`gh secret set NAME` (no `<`) prompts for the value interactively and never
echoes it to history. Confirm they all landed:

```bash
gh secret list
```

You should see all six: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

---

## 5. Clean up the local cert files

Don't leave the exported cert lying around:

```bash
rm -f throughline-cert.p12 throughline-cert.p12.b64
```

The cert is now only in your login keychain (for local builds) and GitHub's
encrypted secret store (for CI). Never commit the `.p12` or its base64.

---

## 6. Release

```bash
git push origin v0.1.0
```

The `Release` workflow builds a universal `.dmg`, signs it with your Developer
ID cert, submits it to Apple for notarization, staples the ticket, and drafts a
GitHub Release with the `.dmg` attached. Notarization usually takes 1–5 minutes;
the workflow waits for it. Once it succeeds, anyone can download the `.dmg` and
open it with no Gatekeeper warning.

---

## Local signed build (optional — to test before pushing a tag)

To produce a signed+notarized `.dmg` on your own machine:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Nicholas Fernandez (XXXXXXXXXX)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run tauri build
```

(Local builds use the cert already in your keychain, so you don't need
`APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` — those are only for CI, which
has no keychain.)

Output lands at `src-tauri/target/release/bundle/dmg/`. Verify the signature and
notarization:

```bash
# Signature valid + hardened runtime:
codesign -dv --verbose=4 "src-tauri/target/release/bundle/macos/Throughline.app"

# Gatekeeper accepts it (the real test):
spctl -a -t exec -vv "src-tauri/target/release/bundle/macos/Throughline.app"
# Expect: "accepted" + "source=Notarized Developer ID"
```

---

## Troubleshooting

- **"The specified item could not be found in the keychain"** in CI → the
  `APPLE_CERTIFICATE` base64 is malformed or the password is wrong. Re-export and
  re-set the secret.
- **Notarization fails with "The binary is not signed with a valid Developer ID
  certificate"** → you signed with an Apple Development cert, not Developer ID.
  Re-check step 1.
- **Notarization "Invalid" status** → run
  `xcrun notarytool log <submission-id> --apple-id … --team-id … --password …`
  to see which file failed. Usually an unsigned nested binary; Tauri normally
  handles this, but custom sidecar binaries would need explicit signing.
- **`spctl` says "rejected"** but `codesign` is fine → the app was signed but not
  notarized, or the ticket wasn't stapled. The CI workflow staples
  automatically; for local builds, notarization + stapling happen when the
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` env vars are set during build.

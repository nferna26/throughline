# Self-verification — driving Throughline end to end

Throughline is a Tauri/macOS app, and macOS's WebView (WKWebView) has **no
WebDriver/CDP**, so there's no single "drive the real app" tool. The end-to-end
loop is therefore **layered** — three lenses that together cover backend, UI, and
the real packaged app:

## 1. Backend / data loop — `cargo` acceptance examples (real, isolated DB)
The real import → sectionize → plan → read → note → **Markdown export** loop runs
headless against an **isolated** data dir (never the user's real DB — enforced by
`bin_guardrail`):

```
cd src-tauri
cargo run --example shot1_acceptance     # import → plan → note → export round-trip
cargo run --example ai_acceptance        # AI prompt / contract path
cargo test --all-targets                 # unit + integration + proptest + corpus
```

## 2. UI loop — Playwright browser harness (drive + screenshot every state)
Runs the **real React frontend** (vite dev) in headless Chromium with the Tauri
IPC layer faked (`e2e/fake-backend.js`, seeded with a sample book + section +
note). Because Chromium has real layout (unlike jsdom), the selection → margin →
**streaming tutor** flow actually runs.

```
npm run verify:ui            # → e2e/shots/*.png  (read these to see each state)
npm run verify:ui:headed     # watch it drive
npx playwright test -g tutor # one state
```

Screenshots written to `e2e/shots/` (gitignored): `01-today`, `02-reader`,
`03-selection-toolbar`, `04-margin-tutor`, `05-settings`, `06-discover`,
`07-notes`. Add a state by adding a `test()` to `e2e/walkthrough.spec.ts`.

**The fake must mirror real shapes.** Gotcha already hit: section
`start_locator`/`end_locator` are **bare number strings** (`"0"`), while *note*
anchors are tagged (`"char:0"`). Keep `fake-backend.js` in sync with
`src/types.ts` and the Rust command return shapes.

## 3. Real-app spot-check — `screencapture` the live window
Confirms the actual packaged app (real Rust backend + WKWebView) matches the
harness, and is the only way to exercise VoiceOver / real keyboard a11y:

```
npm run tauri dev &           # launch the real app
scripts/shoot.sh /tmp/app.png # capture the live window (read the PNG)
```

`shoot.sh` needs Accessibility + Screen-Recording permission for the terminal to
crop to the window; without it, it falls back to a full-screen grab.

## When closing a gap
- Backend/Rust change → **layer 1** (cargo example + tests).
- Any UI/UX change → **layer 2** (`npm run verify:ui`, read the new shot), then
  **layer 3** once before shipping (real app + a11y pass).

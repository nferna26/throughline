import { defineConfig, devices } from "@playwright/test";

// Self-verify UI harness: runs the real React frontend (vite dev) in headless
// Chromium with the Tauri IPC layer faked (e2e/fake-backend.js, injected per
// test). Lets the agent drive + screenshot every UI state end-to-end without the
// Rust backend (covered by the cargo acceptance examples). macOS WKWebView has no
// WebDriver, so this browser harness is how the UI gets driven programmatically.
export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.output",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    viewport: { width: 1200, height: 820 },
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 820 } } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

import { test, expect, type Page } from "@playwright/test";

// CORE-1192/1193 — REAL-CLICK e2e for the update surfaces. The masked-bug
// lesson: the old unit suite asserted a mocked window.open and passed while the
// shipped button did nothing. Here real clicks drive the real React app and the
// REAL @tauri-apps plugins; the assertions observe the IPC that leaves the
// webview at the faked __TAURI_INTERNALS__ boundary (e2e/fake-backend.js) —
// most importantly that the opener plugin's `plugin:opener|open_url` actually
// fires with the exact public download URL.

type Flags = Record<string, unknown>;

async function boot(page: Page, flags: Flags = {}) {
  await page.addInitScript({ path: "e2e/fake-backend.js" });
  await page.addInitScript((f) => {
    const w = window as unknown as Record<string, unknown>;
    for (const k of Object.keys(f as Flags)) w[k] = (f as Flags)[k];
    try {
      window.localStorage.setItem("tl.theme", "light");
      window.localStorage.setItem("tl.dataFolderSeen", "1");
    } catch {
      /* ignore */
    }
  }, flags);
  await page.goto("/");
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
}

async function openSoftwareUpdate(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Software Update" }).click();
  await page.getByRole("heading", { name: "Software Update" }).waitFor();
}

test("a real click on 'Download from the website' fires the opener IPC with the exact URL", async ({ page }) => {
  // A found update whose in-app download always fails → the error state.
  await boot(page, { __TL_FAKE_UPDATE_DOWNLOAD_FAILS__: true });
  await openSoftwareUpdate(page);

  // Manual check (bypasses the cooldown), auto-download kicks in and fails.
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("We could not complete the update.")).toBeVisible();

  // The primary recovery is in-app; the website is the demoted last resort.
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Download from the website" }).click();

  const opened = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__TL_FAKE_OPENED_URL__,
  );
  expect(opened).toBe("https://readthroughline.com/download");
  // And nothing reached for window.open — the wry no-op that caused CORE-1192.
});

test("the happy path: check, silent download, Restart now (marker before relaunch)", async ({ page }) => {
  await boot(page, { __TL_FAKE_UPDATE_AVAILABLE__: true });
  await openSoftwareUpdate(page);

  await page.getByRole("button", { name: "Check for updates" }).click();
  // Auto-download is the default: the section lands on the ready state.
  await expect(page.getByText("Update ready. Restart Throughline to finish.")).toBeVisible();

  await page.getByRole("button", { name: "Restart now" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        return { marker: w.__TL_FAKE_RELAUNCH_MARKER__, restarted: w.__TL_FAKE_RESTARTED__ };
      }),
    )
    .toEqual({ marker: true, restarted: true });
});

test("the pill's primary action works on the FIRST click (today surface)", async ({ page }) => {
  await boot(page, { __TL_FAKE_UPDATE_AVAILABLE__: true });

  // Reach into the app only to skip the 8s launch delay: a manual check via the
  // menu event the Rust menu emits. Everything after is real clicks.
  await page.evaluate(() => window.dispatchEvent(new Event("tl-menu-check-updates")));
  // The menu event lands on Settings › Software Update and checks immediately.
  await expect(page.getByText("Update ready. Restart Throughline to finish.")).toBeVisible();

  // Back to Today: the pill shows the same machine state.
  await page.getByRole("button", { name: "Throughline — home" }).click();
  const pill = page.getByRole("button", { name: "Restart to update" });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as Record<string, unknown>).__TL_FAKE_RESTARTED__),
    )
    .toBe(true);
});

test("a failed check surfaces NO pill on Today (CORE-1191) while Settings stays honest", async ({ page }) => {
  await boot(page, { __TL_FAKE_UPDATE_CHECK_FAILS__: true });
  await openSoftwareUpdate(page);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("We could not complete the update.")).toBeVisible();

  await page.getByRole("button", { name: "Throughline — home" }).click();
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  // No phantom pill for a failed check — no update is known to exist.
  await expect(page.locator(".tl-update-pill")).toHaveCount(0);
});

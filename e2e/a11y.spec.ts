import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The a11y floor (Gap 6): no critical/serious axe violations on the core states,
// plus a keyboard-reachability sanity check. The harness fakes the Tauri backend
// (e2e/fake-backend.js) so these run in plain Chromium.

const SERIOUS = new Set(["critical", "serious"]);

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: "e2e/fake-backend.js" });
});

async function serious(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const v = r.violations.filter((x) => SERIOUS.has(x.impact || ""));
  if (v.length) {
    console.log(
      "  axe:",
      v.map((x) => `${x.id}(${x.impact}) x${x.nodes.length}`).join(", "),
    );
  }
  return v;
}

test("a11y: welcome", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EMPTY__ = true; });
  await page.goto("/");
  await page.getByRole("heading", { name: /Welcome/i }).waitFor();
  expect(await serious(page)).toEqual([]);
});

test("a11y: today", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "Meditations" }).waitFor();
  expect(await serious(page)).toEqual([]);
});

test("a11y: reader", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await page.locator(".tl-readcol p").first().waitFor();
  expect(await serious(page)).toEqual([]);
});

test("a11y: settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText(/export|provider|AI/i).first().waitFor();
  expect(await serious(page)).toEqual([]);
});

test("a11y: every Today control is keyboard-reachable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().waitFor();
  // Tab through the document; every actionable element must be focusable.
  const reachable = await page.evaluate(() => {
    const actionable = Array.from(
      document.querySelectorAll("button, a[href], [role=tab], input, select, textarea"),
    ).filter((el) => (el as HTMLElement).offsetParent !== null);
    return actionable.every((el) => (el as HTMLElement).tabIndex >= 0);
  });
  expect(reachable).toBe(true);
});

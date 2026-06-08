import { test, expect, type Page } from "@playwright/test";

// Drives the real frontend through its key states (seeded fake backend) and
// writes a labelled screenshot of each to e2e/shots/ — the images the agent reads
// to self-verify UI work. Each state is its own test so one broken selector never
// suppresses the other screenshots.

const SHOTS = "e2e/shots";

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: "e2e/fake-backend.js" });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [page error]", m.text());
  });
});

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test("welcome-first-run", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EMPTY__ = true; });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Welcome to Throughline/i })).toBeVisible();
  // The privacy + durability promise (the switching-anxiety answer) is stated plainly.
  await expect(page.getByText(/never leave this Mac/i)).toBeVisible();
  await expect(page.getByText(/Markdown that outlives the app/i)).toBeVisible();
  await shoot(page, "00-welcome");
});

test("recovery-when-behind", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_BEHIND__ = true; });
  await page.goto("/");
  // Falling behind must never dead-end: a visible recovery panel with options.
  await expect(page.getByText(/calm way back|behind/i).first()).toBeVisible();
  await expect(page.getByText(/extend|re-pace|finish by/i).first()).toBeVisible();
  await shoot(page, "09-recovery");
});

test("today", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Meditations" })).toBeVisible();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
  await shoot(page, "01-today");
});

test("reader", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
  await shoot(page, "02-reader");
});

test("reader-margin-and-tutor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await expect(page.locator(".tl-readcol p").first()).toBeVisible();

  // Select a passage with a REAL range (Chromium has real layout, unlike jsdom),
  // then fire the mouseup the reader listens for → the selection toolbar appears.
  await page.evaluate(() => {
    const ps = document.querySelectorAll(".tl-readcol p");
    const p = ps[1] || ps[0]; // a paragraph without the seed highlight
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p); // robust to inline highlight/emphasis children
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.querySelector(".tl-reader-main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  const explain = page.getByRole("button", { name: /^Explain/ });
  await expect(explain).toBeVisible();
  await shoot(page, "03-selection-toolbar");

  // Open a tutor lens → the margin opens and streams the (faked) answer.
  await explain.click();
  await page.waitForTimeout(2000);
  await shoot(page, "04-margin-tutor");
  await expect.soft(page.getByText(/Aurelius is bracing himself|telling himself|Stoic|cooperation/).first()).toBeVisible();
});

test("export-warning", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EXPORT_BROKEN__ = true; });
  await page.goto("/");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/can't save notes/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /choose a folder/i })).toBeVisible();
  await shoot(page, "08-export-warning");
});

test("model-picker-with-price-chip", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  // Choose a cloud provider → the model picker + price chip appear (Epic B2).
  await page.getByLabel("AI provider").selectOption("anthropic");
  const modelSel = page.getByLabel("AI model");
  await expect(modelSel).toBeVisible();
  // The bundled default is Sonnet, and its per-Mtok price is shown.
  await expect(modelSel).toHaveValue("claude-sonnet-4-6");
  await expect(page.getByText(/\$3 \/ \$15/).first()).toBeVisible();
  await shoot(page, "10-model-picker");
});

test("ai-usage-card", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("AI usage").first()).toBeVisible();
  await expect(page.getByText("all time").first()).toBeVisible();
  await expect(page.getByLabel(/spend cap in dollars/i)).toBeVisible();
  await page.getByText("AI usage").first().scrollIntoViewIfNeeded();
  await shoot(page, "11-ai-usage");
});

test("settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText(/export|AI|provider/i).first()).toBeVisible();
  await shoot(page, "05-settings");
});

test("discover", async ({ page }) => {
  await page.goto("/");
  // The book switcher / Today both expose a route to the catalogue.
  const find = page.getByRole("button", { name: /find another book|discover|browse/i }).first();
  if (await find.count()) {
    await find.click();
    await expect(page.getByText(/Pride and Prejudice|Moby Dick/).first()).toBeVisible();
    await shoot(page, "06-discover");
  }
});

test("notes-tab", async ({ page }) => {
  await page.goto("/");
  const notesTab = page.getByRole("tab", { name: "Notes" });
  if (await notesTab.count()) {
    await notesTab.click();
    await shoot(page, "07-notes");
  }
});

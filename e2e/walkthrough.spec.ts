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

test("plans-frontispiece", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /see plans for this book/i }).click();
  // The live plan is the focal plate; earlier attempts are quiet back-matter.
  await expect(page.getByText("Slow mornings")).toBeVisible();
  await expect(page.getByText("Live").first()).toBeVisible();
  await expect(page.getByText(/Earlier attempts/i)).toBeVisible();
  await expect(page.getByText("Winter read")).toBeVisible();
  await shoot(page, "12-plans-frontispiece");
});

test("plans-resting", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_RESTING__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: /see plans for this book/i }).click();
  await expect(page.getByText(/No live plan right now/i)).toBeVisible();
  await shoot(page, "13-plans-resting");
});

test("replan-decision", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /see plans for this book/i }).click();
  // "Start a new plan" while a live plan exists → the shame-free decision dialog.
  await page.getByRole("button", { name: /start a new plan/i }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/already have a plan/i)).toBeVisible();
  await expect(page.getByRole("radio", { name: /Keep my current plan/i })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Replace it/i })).toBeVisible();
  await shoot(page, "14-replan-decision");
});

test("finished-book", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_DONE__ = true; });
  await page.goto("/");
  // The finishing moment is a calm card, not silence (Epic E1).
  await expect(page.getByText(/You finished Meditations/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Review your notes/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Find another book/i })).toBeVisible();
  await shoot(page, "17-finished-book");
});

test("teaser-on-plan-ready", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_PLAN_READY__ = true; });
  await page.goto("/");
  // E2: the "Before you read" teaser shows even on a freshly-ready plan.
  await expect(page.getByText(/BEFORE YOU READ/i)).toBeVisible();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
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

test("cloud-consent-gate", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_NEEDS_CONSENT__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await expect(page.locator(".tl-readcol p").first()).toBeVisible();
  await page.evaluate(() => {
    const ps = document.querySelectorAll(".tl-readcol p");
    const p = ps[1] || ps[0];
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.querySelector(".tl-reader-main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: /^Explain/ }).click();
  // The first cloud send is gated by the consent sheet (nothing left the Mac yet).
  await expect(page.getByRole("dialog", { name: /confirm cloud ai/i })).toBeVisible();
  await expect(page.getByText(/api\.anthropic\.com/i).first()).toBeVisible();
  await expect(page.getByText(/book file never leaves this Mac/i)).toBeVisible();
  await shoot(page, "16-cloud-consent");
});

test("cap-exhausted-fallback", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_CAP_EXHAUSTED__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await expect(page.locator(".tl-readcol p").first()).toBeVisible();
  await page.evaluate(() => {
    const ps = document.querySelectorAll(".tl-readcol p");
    const p = ps[1] || ps[0];
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.querySelector(".tl-reader-main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: /^Explain/ }).click();
  // Credits spent → the three-door cap screen, free path first, never a dead end.
  await expect(page.getByText(/included Throughline AI is used up/i)).toBeVisible();
  await expect(page.getByText(/Reading and notes are untouched/i)).toBeVisible();
  // PRIMARY free door (the only tl-btn-primary), SECONDARY $20 ghost, TERTIARY quiet link.
  await expect(page.getByText("Keep going free")).toBeVisible();
  const freeBtn = page.getByRole("button", { name: /Paste API key & ask/i });
  await expect(freeBtn).toHaveClass(/tl-btn-primary/);
  const buyBtn = page.getByRole("button", { name: /another full allowance — \$20/i });
  await expect(buyBtn).toBeVisible();
  await expect(buyBtn).not.toHaveClass(/tl-btn-primary/);
  await expect(page.getByRole("button", { name: /Let me know/i })).toBeVisible();
  await shoot(page, "20-cap-exhausted");
  // The $20 door reuses checkout and offers the post-activation retry.
  await buyBtn.click();
  await expect(page.getByText(/Opening checkout in your browser/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
  await shoot(page, "20b-cap-topup");
});

test("tutor-fuel-nudge-75", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    w.__TL_FAKE_REMAINING_FRACTION__ = 0.2; // 80% used → gentle nudge
  });
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await expect(page.locator(".tl-readcol p").first()).toBeVisible();
  await page.evaluate(() => {
    const ps = document.querySelectorAll(".tl-readcol p");
    const p = ps[1] || ps[0];
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.querySelector(".tl-reader-main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: /^Explain/ }).click();
  // The answer still streams (non-blocking), with the gentle free-path nudge below.
  await expect(page.getByText(/About a quarter of your included AI left/i)).toBeVisible();
  await expect(page.getByText(/keep going free with your own key or a local model/i)).toBeVisible();
  await shoot(page, "22-fuel-nudge75");
});

test("tutor-fuel-nudge-90", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    w.__TL_FAKE_REMAINING_FRACTION__ = 0.07; // 93% used → clearer nudge
  });
  await page.goto("/");
  await page.getByRole("button", { name: /session/i }).first().click();
  await expect(page.locator(".tl-readcol p").first()).toBeVisible();
  await page.evaluate(() => {
    const ps = document.querySelectorAll(".tl-readcol p");
    const p = ps[1] || ps[0];
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.querySelector(".tl-reader-main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: /^Explain/ }).click();
  await expect(page.getByText(/included AI is almost done/i)).toBeVisible();
  await expect(page.getByText(/LM Studio on this Mac, about two minutes/i)).toBeVisible();
  await shoot(page, "23-fuel-nudge90");
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

test("cloud-trust-copy", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_CLOUD__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  // With a cloud provider active, the trust card names the host + reassures.
  await expect(page.getByText(/api\.anthropic\.com/i).first()).toBeVisible();
  await expect(page.getByText(/your book file never does/i)).toBeVisible();
  await shoot(page, "15-cloud-trust");
});

test("company-activation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  // Choosing Throughline AI shows the buy + activation surface (not a key field).
  await page.selectOption('select[aria-label="AI provider"]', "company");
  await expect(page.getByRole("button", { name: /Get Throughline AI — \$20/i })).toBeVisible();
  await expect(page.getByPlaceholder("XXXX-XXXX-XXXX")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Activate$/ })).toBeVisible();
  await page.getByText(/Throughline AI — \$20 once/i).scrollIntoViewIfNeeded();
  await shoot(page, "18-company-activate");
});

test("company-checkout", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.selectOption('select[aria-label="AI provider"]', "company");
  // Clicking buy hits cmd_company_checkout (which opens the browser) and shows a fallback link.
  await page.getByRole("button", { name: /Get Throughline AI — \$20/i }).click();
  await expect(page.getByText(/Opening checkout in your browser/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /continue here/i })).toBeVisible();
  await shoot(page, "21-company-checkout");
});

test("company-fuel-gauge", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_COMPANY_ACTIVE__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  // Active company mode shows the fuel gauge, not a "buy" prompt.
  await expect(page.getByText(/Throughline AI is active/i)).toBeVisible();
  await expect(page.getByText(/Plenty of AI left/i)).toBeVisible();
  await page.getByText(/Throughline AI is active/i).scrollIntoViewIfNeeded();
  await shoot(page, "19-company-fuel");
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

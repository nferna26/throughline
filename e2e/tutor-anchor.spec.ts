import { test, expect, type Page } from "@playwright/test";

// CORE-1158: the tutor answer, anchored to the selection. Chromium has REAL layout
// (unlike jsdom), so this spec both (a) writes labelled screenshots of the anchored
// states in light + dark for human review, and (b) asserts the two load-bearing
// must-ships in real layout: the card anchors beside its line (top > column top),
// and the reading column never moves on reveal or during the stream.

const SHOTS = "e2e/shots";

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: "e2e/fake-backend.js" });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [page error]", m.text());
  });
});

function dark(page: Page) {
  return page.addInitScript(() => {
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function openReader(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
  await expect(page.locator(".tl-readcol p").first()).toBeVisible();
}

// Select paragraph `idx` with a real Range and fire the mouseup the reader listens
// for → the selection toolbar appears.
async function selectPara(page: Page, idx: number) {
  await page.evaluate((i) => {
    const ps = document.querySelectorAll(".tl-readcol p");
    const p = (ps[i] || ps[0]) as HTMLElement;
    if (!p) return;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.querySelector(".tl-reader-main")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, idx);
}

async function explainPara(page: Page, idx: number) {
  await selectPara(page, idx);
  await page.getByRole("button", { name: /^Explain/ }).click();
}

// ── The load-bearing assertions (real Chromium layout) ──────────────────────
test("anchors the card beside its line and never moves the reading column", async ({ page }) => {
  await openReader(page);

  const scrollTopBefore = await page.locator(".tl-reader-main").evaluate((el) => el.scrollTop);

  await explainPara(page, 2); // a mid/lower paragraph, away from the column top
  const card = page.locator(".tl-anchored.is-active");
  await expect(card).toBeVisible();

  // (1) Anchored beside its line: the card's top is well below the column top,
  //     not pinned to 0 (the bug this fixes).
  const top = await card.evaluate((el) => parseFloat((el as HTMLElement).style.top || "0"));
  expect(top).toBeGreaterThan(0);

  // (2) The reader's place held across reveal.
  const afterReveal = await page.locator(".tl-reader-main").evaluate((el) => el.scrollTop);
  expect(afterReveal).toBe(scrollTopBefore);

  // (3) ...and across the whole stream (no per-token scroll, no jump).
  await page.waitForTimeout(2000);
  const afterStream = await page.locator(".tl-reader-main").evaluate((el) => el.scrollTop);
  expect(afterStream).toBe(scrollTopBefore);

  // (4) CORE-1163 ONE growth model: the active card has NO maxHeight and is NOT an
  //     internal scroll container (the rail is the single scroll container).
  const box = await card.evaluate((el) => {
    const cs = getComputedStyle(el as HTMLElement);
    return { maxHeight: cs.maxHeight, overflowY: cs.overflowY };
  });
  expect(box.maxHeight).toBe("none");
  expect(["visible", "clip"]).toContain(box.overflowY);
});

// ── Screenshots of the states (light + dark) ────────────────────────────────
test("shot: mid-page Explain (hero)", async ({ page }) => {
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(2000);
  await expect(page.locator(".tl-anchored.is-active")).toBeVisible();
  await shoot(page, "tutor-anchor-01-midpage-explain");
});

test("shot: mid-page Explain (hero) — dark", async ({ page }) => {
  await dark(page);
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(2000);
  await shoot(page, "tutor-anchor-01b-midpage-explain-dark");
});

test("shot: streaming (caret, reserved position)", async ({ page }) => {
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(150); // mid-stream
  await shoot(page, "tutor-anchor-02-streaming");
});

test("shot: streaming — dark", async ({ page }) => {
  await dark(page);
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(150);
  await shoot(page, "tutor-anchor-02b-streaming-dark");
});

test("shot: go deeper (longer answer, internal scroll)", async ({ page }) => {
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(2000);
  const deeper = page.getByRole("button", { name: /Go deeper/i });
  if (await deeper.isVisible()) {
    await deeper.click();
    await page.waitForTimeout(2000);
  }
  await shoot(page, "tutor-anchor-03-go-deeper");
});

test("shot: go deeper — dark", async ({ page }) => {
  await dark(page);
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(2000);
  const deeper = page.getByRole("button", { name: /Go deeper/i });
  if (await deeper.isVisible()) {
    await deeper.click();
    await page.waitForTimeout(2000);
  }
  await shoot(page, "tutor-anchor-03b-go-deeper-dark");
});

test("shot: collision — one active card, the other a kept marker", async ({ page }) => {
  await openReader(page);
  await explainPara(page, 1);
  await page.waitForTimeout(1500);
  await explainPara(page, 2); // a second answer → the first collapses to a marker
  await page.waitForTimeout(1500);
  await expect(page.locator(".tl-anchored.is-active")).toHaveCount(1);
  await expect(page.locator(".tl-kmark").first()).toBeVisible();
  await shoot(page, "tutor-anchor-04-collision");
});

test("shot: collision — dark", async ({ page }) => {
  await dark(page);
  await openReader(page);
  await explainPara(page, 1);
  await page.waitForTimeout(1500);
  await explainPara(page, 2);
  await page.waitForTimeout(1500);
  await shoot(page, "tutor-anchor-04b-collision-dark");
});

test("shot: Define — light inline popover at the selection", async ({ page }) => {
  await openReader(page);
  await selectPara(page, 2);
  await page.getByRole("button", { name: /^Define/ }).click();
  await expect(page.locator(".tl-define")).toBeVisible();
  await page.waitForTimeout(1500);
  await shoot(page, "tutor-anchor-05-define");
});

test("shot: Define — dark", async ({ page }) => {
  await dark(page);
  await openReader(page);
  await selectPara(page, 2);
  await page.getByRole("button", { name: /^Define/ }).click();
  await expect(page.locator(".tl-define")).toBeVisible();
  await page.waitForTimeout(1500);
  await shoot(page, "tutor-anchor-05b-define-dark");
});

test("shot: responsive — narrow window (inline/drawer render)", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 820 });
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(2000);
  await shoot(page, "tutor-anchor-06-responsive-narrow");
});

test("shot: responsive — narrow window dark", async ({ page }) => {
  await dark(page);
  await page.setViewportSize({ width: 640, height: 820 });
  await openReader(page);
  await explainPara(page, 2);
  await page.waitForTimeout(2000);
  await shoot(page, "tutor-anchor-06b-responsive-narrow-dark");
});

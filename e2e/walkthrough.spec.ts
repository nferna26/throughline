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
  // The privacy + durability promise (the switching-anxiety answer) is stated
  // plainly — and truthfully: books stay local; an opted-in tutor sends only
  // the selected passage (review P1-4, CORE-1002).
  await expect(page.getByText(/only the passage you select is sent, never the book/i)).toBeVisible();
  await expect(page.getByText(/Markdown that outlives the app/i)).toBeVisible();
  await shoot(page, "00-welcome");
});

test("returning-after-a-lapse", async ({ page }) => {
  // "Behind" is unrepresentable (Stage 2): however long the reader was away,
  // the screen welcomes them back with no tally, no recovery, no options.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_RETURNING__ = true; });
  await page.goto("/");
  await expect(page.getByText("Welcome back")).toBeVisible();
  await expect(page.getByText("The story kept your place.")).toBeVisible();
  await expect(page.getByText(/Book II is waiting where you left it/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue reading" })).toBeVisible();
  await expect(page.getByText(/behind|streak|missed|catch.?up|recovery/i)).toHaveCount(0);
  await shoot(page, "09-returning");
});

test("plans-frontispiece", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /earlier attempt/i }).click();
  // The live plan is the focal plate; earlier attempts are quiet back-matter.
  await expect(page.getByText("Slow mornings")).toBeVisible();
  await expect(page.getByText("Live").first()).toBeVisible();
  // The progress line binds fraction_complete (0.18 in the seed).
  await expect(page.getByText("18% through")).toBeVisible();
  await expect(page.getByText(/Earlier attempts/i)).toBeVisible();
  await expect(page.getByText("Winter read")).toBeVisible();
  await shoot(page, "12-plans-frontispiece");
});

test("plans-resting", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_RESTING__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: /earlier attempt/i }).click();
  await expect(page.getByText(/No live plan right now/i)).toBeVisible();
  await shoot(page, "13-plans-resting");
});

test("replan-decision", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /earlier attempt/i }).click();
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

test("day-one-does-not-preprint-the-opening", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_DAY_ONE__ = true; });
  await page.goto("/");
  // Day one is calm and bare: no clock, no fill in the hairline — and the
  // section's opening is NOT pre-printed (CORE-1049): the reader meets it the
  // instant they tap Begin reading.
  await expect(page.getByText("Beginning today")).toBeVisible();
  await expect(page.getByText("We've set an unhurried pace.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Begin reading" })).toBeVisible();
  await expect(page.getByText(/Begin the morning by saying to thyself/)).toHaveCount(0);
  await shoot(page, "24-day-one");
});

test("today", async ({ page }) => {
  await page.goto("/");
  // The book on the desk: title largest, the chapter line, minutes as
  // reassurance, the hairline as the only (silent) position signal.
  await expect(page.getByRole("heading", { name: "Meditations" })).toBeVisible();
  await expect(page.getByText(/^This (morning|afternoon|evening)$/)).toBeVisible();
  await expect(page.getByText("Book II", { exact: true })).toBeVisible();
  await expect(page.getByText("About six minutes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue reading" })).toBeVisible();
  await expect(page.locator(".tl-hairline .fill")).toBeAttached();
  await expect(page.getByText(/\d+\s*%/)).toHaveCount(0);
  await shoot(page, "01-today");
});

test("phrase-slot-swap-is-zero-CLS", async ({ page }) => {
  // The chapter label carries the screen until Stage 3's phrase arrives; the
  // slot reserves its height NOW, so the swap must not move the button.
  await page.goto("/");
  await expect(page.getByText("Book II", { exact: true })).toBeVisible();
  const before = await page.getByRole("button", { name: "Continue reading" }).boundingBox();

  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_PHRASE__ = true; });
  await page.goto("/");
  await expect(page.getByText(/the morning resolve at the day's door/)).toBeVisible();
  const after = await page.getByRole("button", { name: "Continue reading" }).boundingBox();

  expect(after!.y).toBe(before!.y);
});

test("begin-reading-never-opens-a-sectionless-reader", async ({ page }) => {
  // If the fresh card has nothing to open (no section), Begin reading lands on
  // Today rather than a dead reader.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_NO_PLAN__ = true;
    w.__TL_FAKE_STAY_PLANLESS__ = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();
  await page.getByRole("button", { name: "Begin reading" }).click();

  await expect(page.getByText(/There's no plan right now/)).toBeVisible();
  await expect(page.locator(".tl-readcol")).toHaveCount(0);
});

test("today-dark", async ({ page }) => {
  await page.addInitScript(() => { try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Meditations" })).toBeVisible();
  await shoot(page, "01b-today-dark");
});

test("reader", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
  await shoot(page, "02-reader");
});

test("plan-setup-one-question", async ({ page }) => {
  // The app-level loop segment: a plan-less book → Start a plan → the ONE
  // question → Begin reading lands straight in the first sitting.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_NO_PLAN__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();

  await expect(page.getByText("New on your desk")).toBeVisible();
  await expect(page.getByText("How much feels right at a sitting?")).toBeVisible();
  await expect(page.getByRole("radio", { name: /A steady sitting/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/you'd finish around (early|mid|late) /)).toBeVisible();
  // Every debt-forming surface is gone.
  await expect(page.getByText(/finish by|days a week|margin help|name this plan|behind|streak/i)).toHaveCount(0);
  await shoot(page, "25-plan-one-question");

  await page.getByRole("button", { name: "Begin reading" }).click();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
});

test("sitting-bounded-reader", async ({ page }) => {
  // A split sitting (sub-range of Book II): the reader renders only the
  // sitting's slice and navigation cannot leave the sitting.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_SPLIT_SITTING__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
  // Text past the sitting end never renders.
  await expect(page.getByText(/But I who have seen the nature of the good/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Next section/i })).toBeDisabled();
  await shoot(page, "26-sitting-bounded");
});

test("reader-margin-and-tutor", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
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
  await page.getByRole("button", { name: "Continue reading" }).click();
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
  await page.getByRole("button", { name: "Continue reading" }).click();
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

test("tutor-fuel-strip-when-low", async ({ page }) => {
  // The old two-tier nudges are ONE quiet strip in the tutor footer now:
  // absent until 75% of the allowance is used, then "Running low" with the
  // relay's own approximate-questions number (0.2 remaining -> about 80).
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    w.__TL_FAKE_REMAINING_FRACTION__ = 0.2;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
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
  await expect(page.getByText(/Running low/)).toBeVisible();
  await expect(page.getByText(/about 80 left/)).toBeVisible();
  await shoot(page, "22-fuel-low");
});

test("tutor-fuel-strip-stays-quiet-with-plenty-left", async ({ page }) => {
  // Below the 75%-used threshold the strip is genuinely absent — quiet by
  // default, no gauge competing with the answer.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true; // fake default: 0.75 remaining
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
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
  await expect(page.getByText(/Aurelius is bracing himself|Stoic/).first()).toBeVisible();
  await expect(page.getByText(/Running low/)).toHaveCount(0);
  await shoot(page, "23-fuel-quiet");
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
  // The picker moved behind Settings -> Reading assistant -> "Use your own AI
  // instead"; the model select and its price chip are unchanged once reached.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  // The fake's saved provider is local, so the expander is already open on
  // "On this Mac only" — switch to the key path.
  await page.getByRole("button", { name: "Your own key" }).click();
  await expect(page.getByLabel("Which service")).toHaveValue("anthropic");
  const modelSel = page.getByLabel("AI model");
  await expect(modelSel).toBeVisible();
  await expect(modelSel).toHaveValue("claude-sonnet-4-6");
  await expect(page.getByText(/\$3 \/ \$15/).first()).toBeVisible();
  await shoot(page, "10-model-picker");
});

test("cloud-trust-copy", async ({ page }) => {
  // Hostnames live in the reader's consent sheet (cloud-consent-gate pins
  // that); the Settings trust card is mode-aware and plumbing-free.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_CLOUD__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Everything stays on this Mac")).toBeVisible();
  await expect(page.getByText(/your own Anthropic/)).toBeVisible();
  await expect(page.getByText(/are sent there to be answered/)).toBeVisible();
  await expect(page.getByText(/api\.anthropic\.com/i)).toHaveCount(0);
  await shoot(page, "15-cloud-trust");
});

test("company-activation", async ({ page }) => {
  // Activation-by-code lives in Settings -> Reading assistant (the door the
  // activation-failure banner points at), beside the deep-link path.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_COMPANY_UNLICENSED__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Already bought Throughline AI?")).toBeVisible();
  const code = page.getByLabel("Activation code");
  await expect(code).toHaveAttribute("placeholder", "XXXX-XXXX-XXXX");
  await code.fill("ABCD-1234-EFGH");
  await shoot(page, "18-company-activate");
  await page.getByRole("button", { name: "Activate" }).click();
  // The same window event the deep link fires refreshes the surface in place.
  await expect(page.getByText("Throughline AI is active.")).toBeVisible();
  await expect(page.getByText("Reading help remaining")).toBeVisible();
});

test("company-checkout", async ({ page }) => {
  // The $20 door lives on the cap-hit screen; this pins the full fallback
  // copy, including the "continue here" link the main cap test leaves out.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_CAP_EXHAUSTED__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Continue reading" }).click();
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
  await page.getByRole("button", { name: /another full allowance — \$20/i }).click();
  await expect(page.getByText(/Opening checkout in your browser/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /continue here/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
  await shoot(page, "21-company-checkout");
});

test("company-fuel-gauge", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_COMPANY_ACTIVE__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  // Company status + the real allowance meter, in reader language.
  await expect(page.getByText("Throughline AI is active.")).toBeVisible();
  await expect(page.getByText("Reading help remaining")).toBeVisible();
  await expect(page.getByText("Plenty left")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: /Reading help remaining/i })).toBeVisible();
  await shoot(page, "19-company-fuel");
});

test("usage-as-questions-not-dollars", async ({ page }) => {
  // Replaces the dollars/spend-cap usage card: usage reads as approximate
  // questions from the relay's own numbers — never tokens, never dollars.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_COMPANY_ACTIVE__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("About 300 questions left.")).toBeVisible();
  await expect(page.getByText(/spend cap/i)).toHaveCount(0);
  await expect(page.getByText(/token/i)).toHaveCount(0);
  await shoot(page, "11-usage-questions");
});

test("phrase-arrives-mid-view-with-zero-CLS", async ({ page }) => {
  // A phrase lands while Today is on screen (the fire-and-forget upsert path
  // emits tl-phrases-updated): the slot swaps text in place and the button
  // does not move a pixel.
  await page.goto("/");
  await expect(page.getByText("Book II", { exact: true })).toBeVisible();
  const before = await page.getByRole("button", { name: "Continue reading" }).boundingBox();
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__TL_FAKE_PHRASE__ = true;
    window.dispatchEvent(new Event("tl-phrases-updated"));
  });
  await expect(page.getByText(/the morning resolve at the day's door/)).toBeVisible();
  const after = await page.getByRole("button", { name: "Continue reading" }).boundingBox();
  expect(after!.y).toBe(before!.y);
  await shoot(page, "27-phrase-live");
});

test("phrase-slot-holds-at-contract-maxima", async ({ page }) => {
  // The worst legal content (long ", continued" label + a near-80-char
  // phrase) must still not move the button: the slot is capped, not just
  // reserved.
  await page.goto("/");
  await expect(page.getByText("Book II", { exact: true })).toBeVisible();
  const before = await page.getByRole("button", { name: "Continue reading" }).boundingBox();
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__TL_FAKE_PHRASE_MAX__ = true;
    window.dispatchEvent(new Event("tl-phrases-updated"));
  });
  await expect(page.getByText(/the busybody, the ungrateful/)).toBeVisible();
  const after = await page.getByRole("button", { name: "Continue reading" }).boundingBox();
  expect(after!.y).toBe(before!.y);
});

test("activation-door-reachable-from-any-mode", async ({ page }) => {
  // A failed deep link can land in Settings while the reader is on local or
  // their own key — the code door must exist there too, not only in company
  // mode (the fake's default provider is local).
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Already bought Throughline AI?")).toBeVisible();
  await expect(page.getByLabel("Activation code")).toBeVisible();
});

test("session-names-toggle-in-settings", async ({ page }) => {
  // The phrases on/off switch round-trips through cmd_set_ai_settings.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const toggle = page.getByRole("switch", { name: "Session names" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await shoot(page, "28-session-names-toggle");
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

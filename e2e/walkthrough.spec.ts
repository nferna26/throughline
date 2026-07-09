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

// CORE-1154 long-title torture string: an unbounded EPUB dc:title with edition
// (comma), subtitle (colon), and series tail (parens) — exactly the shape that
// overflowed the Today hero and the chosen screen.
const CHASM_TITLE =
  "Crossing the Chasm, 3rd Edition: Marketing and Selling Disruptive Products to Mainstream Customers (Collins Business Essentials)";

// The three window widths the fluid type + responsive chrome must stay calm at.
const WIDTHS = [
  { name: "narrow", w: 640 },
  { name: "default", w: 960 },
  { name: "max", w: 1440 },
] as const;

async function shootWidths(page: Page, base: string) {
  for (const { name, w } of WIDTHS) {
    await page.setViewportSize({ width: w, height: 820 });
    await shoot(page, `${base}-${name}`);
  }
}

test("front-door-first-run", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EMPTY__ = true; });
  await page.goto("/");
  // The front door: serif hero, the three cloth covers as the primary invitation,
  // Browse + Import, the trust line, and the quiet activation whisper.
  await expect(page.getByRole("heading", { name: /Begin with a book you mean to finish/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Browse the library/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Import a \.txt or \.epub/i })).toBeVisible();
  await expect(page.getByText(/Everything stays on this Mac, no account, no cloud, nothing tracked/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Bought Throughline\? Enter your code/i })).toBeVisible();
  // A starter cover resolves into a real "Start reading" button (the cover thread).
  await expect(page.getByRole("button", { name: /Start reading Meditations by Marcus Aurelius/i })).toBeVisible();
  await shoot(page, "00-frontdoor");
});

test("front-door-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_EMPTY__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Begin with a book you mean to finish/i })).toBeVisible();
  await shoot(page, "00b-frontdoor-dark");
});

test("front-door-activation-states", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EMPTY__ = true; });
  await page.goto("/");
  // Entering: the mono field, helper line, Activate, Not now.
  await page.getByRole("button", { name: /Bought Throughline\? Enter your code/i }).click();
  await expect(page.getByText("Enter your activation code")).toBeVisible();
  await page.getByLabel("Activation code").fill("56HA-N460-C47S");
  await shoot(page, "29-activation-entering");
  // Success: the same confirmation the deep link shows.
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("You're activated. Welcome in.")).toBeVisible();
  await shoot(page, "30-activation-success");
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
  // The post-finish "add another book?" moment: a quiet question with both
  // acquisition paths and a dismissible "Not now" (never a nag).
  await expect(page.getByText("Want to add another book?")).toBeVisible();
  await expect(page.getByRole("button", { name: /Find another book/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import a file" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Not now" })).toBeVisible();
  await shoot(page, "17-finished-book");
});

test("finished-book-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_DONE__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.getByText(/You finished Meditations/i)).toBeVisible();
  await expect(page.getByText("Want to add another book?")).toBeVisible();
  await shoot(page, "17b-finished-book-dark");
});

test("day-one-does-not-preprint-the-opening", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_DAY_ONE__ = true; });
  await page.goto("/");
  // Day one is calm and bare: no clock, no fill in the hairline — and the
  // section's opening is NOT pre-printed (CORE-1049): the reader meets it the
  // instant they tap Begin reading.
  await expect(page.getByText("Beginning today")).toBeVisible();
  await expect(page.getByText("The first chapter, at the pace you set. No clock but your own.")).toBeVisible();
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
  await page.getByRole("button", { name: "Continue" }).click();
  // The pace step's primary is "Start reading"; with no section it must land on
  // Today, never a dead reader.
  await page.getByRole("button", { name: "Start reading" }).click();

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

test("book-chosen-then-reading-pace", async ({ page }) => {
  // The first-journey beat, now TWO separate screens: a new book → the cover
  // rises ("Added to Today") → Continue → the ONE pace question in reading terms
  // → Start reading lands in the first sitting.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_NO_PLAN__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();

  // Screen A — book chosen. The pace question is NOT here yet.
  await expect(page.getByText("Added to Today")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Meditations is yours to begin/ })).toBeVisible();
  await expect(page.getByText("What feels like a good sitting?")).toHaveCount(0);
  await shoot(page, "25-book-chosen");

  // Continue → Screen B — reading pace, a chapter preselected; the chosen hero is gone.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("What feels like a good sitting?")).toBeVisible();
  await expect(page.getByText("Added to Today")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /A chapter/ })).toHaveAttribute("aria-checked", "true");
  // Never a clock: no minute count, finish date, or timer readout on the cards.
  await expect(page.getByText(/you'd finish|finish by|of reading|\d+\s*minutes?\b/i)).toHaveCount(0);
  await expect(page.getByText(/days a week|margin help|name this plan|behind|streak/i)).toHaveCount(0);
  await shoot(page, "25b-reading-pace");

  await page.getByRole("button", { name: "Start reading" }).click();
  await expect(page.getByText(/Begin the morning by saying to thyself/).first()).toBeVisible();
});

test("book-chosen-then-reading-pace-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_NO_PLAN__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();
  await expect(page.getByText("Added to Today")).toBeVisible();
  await shoot(page, "25c-book-chosen-dark");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("What feels like a good sitting?")).toBeVisible();
  await shoot(page, "25d-reading-pace-dark");
});

test("remove-from-library-affordance-and-confirm", async ({ page }) => {
  // CORE-1093 / handoff §3: the deliberate "Remove from library" affordance (the
  // book detail view) and the source-specific confirmation (focus on "Keep it",
  // in-voice copy). The detail view is an imported book → it names the real loss.
  await page.goto("/");
  await page.getByRole("button", { name: /earlier attempt/i }).click();
  const remove = page.getByRole("button", { name: /Remove from library/i });
  await expect(remove).toBeVisible();
  await shoot(page, "26-remove-from-library");

  await remove.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Remove Meditations?" })).toBeVisible();
  await expect(dialog.getByText(/tutor history for it will be deleted/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await shoot(page, "27-remove-confirm");
});

test("remove-from-library-affordance-and-confirm-dark", async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByRole("button", { name: /earlier attempt/i }).click();
  const remove = page.getByRole("button", { name: /Remove from library/i });
  await expect(remove).toBeVisible();
  await shoot(page, "26b-remove-from-library-dark");

  await remove.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shoot(page, "27b-remove-confirm-dark");
});

test("book-switcher-per-book-remove", async ({ page }) => {
  // The same removal reachable by right-clicking a book in the switcher (§2).
  await page.goto("/");
  await page.getByTitle("Switch book").click();
  await page.getByRole("button", { name: "Meditations, Marcus Aurelius, reading" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove from library" })).toBeVisible();
  await shoot(page, "28-switcher-remove");
});

test("switcher-add-a-book-and-mini-covers", async ({ page }) => {
  // The acquisition affordance regressed when it was dropped from the switcher;
  // it returns as two quiet rows below "All books in your library". The recents
  // thumbnails use the no-text "mini" cover (cloth + spine, no clipped title).
  await page.goto("/");
  await page.getByTitle("Switch book").click();
  await expect(page.getByRole("button", { name: "All books in your library" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find a book in the catalogue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import a file" })).toBeVisible();
  // The recents rows render the text-free mini cover.
  expect(await page.locator(".tl-cover.sz-mini").count()).toBeGreaterThan(0);
  await shoot(page, "31-switcher-add-a-book");
});

test("switcher-add-a-book-and-mini-covers-dark", async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByTitle("Switch book").click();
  await expect(page.getByRole("button", { name: "Find a book in the catalogue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import a file" })).toBeVisible();
  expect(await page.locator(".tl-cover.sz-mini").count()).toBeGreaterThan(0);
  await shoot(page, "31b-switcher-add-a-book-dark");
});

test("library-tab-add-a-book", async ({ page }) => {
  // The in-app Library surface (not the catalogue): its header carries the same
  // add-a-book pair so acquisition is reachable wherever books are managed.
  await page.goto("/");
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a book" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import a file" })).toBeVisible();
  await shoot(page, "32-library-add-a-book");
});

test("library-tab-add-a-book-dark", async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a book" })).toBeVisible();
  await shoot(page, "32b-library-add-a-book-dark");
});

test("returning-reader-skips-the-pace-step", async ({ page }) => {
  // A reader who already set a pace lands straight on Today — the question is
  // never re-asked. Start a plan goes through configure → Today, no pace UI.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_NO_PLAN__ = true;
    w.__TL_FAKE_PACE_CHOSEN__ = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();
  // No pace question; the book's plan is configured and Today shows the reading card.
  await expect(page.getByText("What feels like a good sitting?")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Meditations" })).toBeVisible();
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
  await expect(page.getByText(/You've used the generous tutoring included with your license/i)).toBeVisible();
  await expect(page.getByText(/Reading is unaffected/i)).toBeVisible();
  // PRIMARY free door (the only tl-btn-primary), SECONDARY $20 ghost, TERTIARY quiet link.
  await expect(page.getByText("Keep going free")).toBeVisible();
  const freeBtn = page.getByRole("button", { name: /Paste API key & ask/i });
  await expect(freeBtn).toHaveClass(/tl-btn-primary/);
  const buyBtn = page.getByRole("button", { name: /another full allowance for \$20/i });
  await expect(buyBtn).toBeVisible();
  await expect(buyBtn).not.toHaveClass(/tl-btn-primary/);
  await expect(page.getByRole("button", { name: /Reply to your purchase email/i })).toBeVisible();
  // HARD RULE: no usage count, no percent, no bar on the cap-hit screen.
  await expect(page.getByRole("progressbar")).toHaveCount(0);
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
  await expect(page.getByText(/Included tutoring is running low/i)).toBeVisible();
  // HARD RULE: the low-note has no number and no depleting bar.
  await expect(page.getByText(/about 80 left/)).toHaveCount(0);
  await expect(page.locator(".tl-fuel-bar")).toHaveCount(0);
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
  await expect(page.getByText(/running low/i)).toHaveCount(0);
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
  // The picker lives behind Settings -> Assistant -> the "Answers come from"
  // setup sheet; the model select and its price chip are unchanged once reached.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  // The fake's saved provider is local, so the row offers "Set up" — the sheet
  // opens on "On this Mac only"; switch to the key path.
  await page.getByRole("button", { name: "Set up" }).click();
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
  await page.getByRole("button", { name: "Privacy" }).click();
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
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText("Already bought Throughline AI?")).toBeVisible();
  const code = page.getByLabel("Activation code");
  await expect(code).toHaveAttribute("placeholder", "XXXX-XXXX-XXXX");
  await code.fill("ABCD-1234-EFGH");
  await shoot(page, "18-company-activate");
  await page.getByRole("button", { name: "Activate" }).click();
  // The same window event the deep link fires refreshes the surface in place.
  await expect(page.getByText("Throughline AI is active.")).toBeVisible();
  await expect(page.getByText("Included tutoring")).toBeVisible();
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
  await page.getByRole("button", { name: /another full allowance for \$20/i }).click();
  await expect(page.getByText(/Opening checkout in your browser/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /continue here/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
  await shoot(page, "21-company-checkout");
});

test("company-fuel-gauge", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_COMPANY_ACTIVE__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  // Calm qualitative status — NO bar, NO number, NO percent (the no-counter rule).
  await expect(page.getByText("Throughline AI is active.")).toBeVisible();
  await expect(page.getByText("Included tutoring")).toBeVisible();
  await expect(page.getByText("On · plenty remaining")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator(".meter")).toHaveCount(0);
  await shoot(page, "19-company-fuel");
});

test("company-fuel-gauge-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText("On · plenty remaining")).toBeVisible();
  await shoot(page, "19b-company-fuel-dark");
});

test("settings-tutoring-low", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    w.__TL_FAKE_REMAINING_FRACTION__ = 0.1; // <= 0.33 -> calm "Running low"
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText(/Your included tutoring is running low/i)).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await shoot(page, "19c-settings-low");
});

test("settings-tutoring-low-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    w.__TL_FAKE_REMAINING_FRACTION__ = 0.1;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText(/Your included tutoring is running low/i)).toBeVisible();
  await shoot(page, "19d-settings-low-dark");
});

test("included-tutoring-status-no-counter", async ({ page }) => {
  // The no-counter rule: the included-tutoring status is a calm qualitative line,
  // never a usage number, percent, bar, spend-cap, tokens, or dollars.
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_COMPANY_ACTIVE__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText("On · plenty remaining")).toBeVisible();
  await expect(page.getByText(/\d+\s*questions/i)).toHaveCount(0);
  await expect(page.getByText(/spend cap/i)).toHaveCount(0);
  await expect(page.getByText(/token/i)).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await shoot(page, "11-usage-questions");
});

test("cap-exhausted-fallback-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_CAP_EXHAUSTED__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
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
  await expect(page.getByText(/You've used the generous tutoring included with your license/i)).toBeVisible();
  await shoot(page, "20c-cap-exhausted-dark");
});

test("tutor-fuel-strip-when-low-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_COMPANY_ACTIVE__ = true;
    w.__TL_FAKE_REMAINING_FRACTION__ = 0.2;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
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
  await expect(page.getByText(/Included tutoring is running low/i)).toBeVisible();
  await shoot(page, "22b-fuel-low-dark");
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
  await page.getByRole("button", { name: "Assistant" }).click();
  await expect(page.getByText("Already bought Throughline AI?")).toBeVisible();
  await expect(page.getByLabel("Activation code")).toBeVisible();
});

test("session-names-toggle-in-settings", async ({ page }) => {
  // The phrases on/off switch round-trips through cmd_set_ai_settings.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Assistant" }).click();
  const toggle = page.getByRole("switch", { name: "Session names" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await shoot(page, "28-session-names-toggle");
});

test("settings", async ({ page }) => {
  // The redesigned frame: a quiet left rail of seven destinations, the pane
  // opening on Reading, and the promise lines pinned to the rail's foot.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  for (const item of ["Reading", "Appearance", "Assistant", "Privacy", "Files", "Shortcuts", "Send feedback"]) {
    await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: item })).toBeVisible();
  }
  await expect(page.getByText("A good sitting")).toBeVisible();
  await expect(page.getByText("No accounts. No tracking.")).toBeVisible();
  await shoot(page, "05-settings");
});

test("settings-appearance-and-files", async ({ page }) => {
  // Appearance: theme segmented + typeface + text size + line spacing, all live.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByRole("group", { name: "Theme" })).toBeVisible();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByLabel("Typeface").selectOption("charter");
  await expect(page.locator("html")).toHaveAttribute("data-typeface", "charter");
  await page.getByRole("button", { name: "Larger text" }).click();
  await expect(page.getByText("19 pt")).toBeVisible();
  await shoot(page, "05b-settings-appearance");
  // Files: the live last-backup line, the toggle, and the restore picker.
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.getByText(/last backup/i)).toBeVisible();
  await page.getByRole("button", { name: "Choose a backup" }).click();
  await expect(page.getByRole("dialog", { name: "Restore from backup" })).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeVisible();
  await shoot(page, "05c-settings-restore");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("settings-send-feedback-destination", async ({ page }) => {
  // Send feedback is its own rail destination (CORE-1094 → redesign): the six
  // states' idle form with the literal preview and the verbatim honest line.
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByRole("heading", { name: "Send feedback" })).toBeVisible();
  await expect(page.getByText(/Throughline never sends anything on its own/)).toBeVisible();
  // Empty state: Send disabled, preview echoes the placeholder + live diagnostics.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByText("(your message above)")).toBeVisible();
  await page.getByLabel("Your message").fill("The margin tutor covers the last line sometimes.");
  await expect(page.getByTestId("preview-message")).toHaveText(
    "The margin tutor covers the last line sometimes.",
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await shoot(page, "05d-settings-feedback");
});

test("browse-library-shelves", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EMPTY__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: /Browse the library/i }).click();
  await expect(page.getByRole("heading", { name: "The library" })).toBeVisible();
  // The curated doorways are the navigation (no filter pills).
  await expect(page.getByText("Short classics")).toBeVisible();
  await expect(page.getByText("Familiar names")).toBeVisible();
  await expect(page.getByText("Finish in a weekend")).toBeVisible();
  // A curated cell carries its authored blurb (one of the two cell types).
  await expect(page.getByText("A man wakes as an insect, and his family adjusts with alarming speed.")).toBeVisible();
  await shoot(page, "06-browse-shelves");
});

test("browse-library-shelves-dark", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_EMPTY__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Browse the library/i }).click();
  await expect(page.getByText("Short classics")).toBeVisible();
  await shoot(page, "06b-browse-shelves-dark");
});

test("browse-library-search", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__TL_FAKE_EMPTY__ = true; });
  await page.goto("/");
  await page.getByRole("button", { name: /Browse the library/i }).click();
  await page.getByLabel(/Search the library by title or author/i).fill("pride");
  // The search cell shows cover + title + author only — no blurb, honest sort.
  await expect(page.getByText("Sorted by how often they're read")).toBeVisible();
  await expect(page.getByRole("button", { name: /Start reading Pride and Prejudice by Jane Austen/i })).toBeVisible();
  await shoot(page, "06c-browse-search");
});

test("notes-tab", async ({ page }) => {
  await page.goto("/");
  const notesTab = page.getByRole("tab", { name: "Notes" });
  if (await notesTab.count()) {
    await notesTab.click();
    await shoot(page, "07-notes");
  }
});

// ════════ CORE-1154: fluid title typography + responsive chrome ════════

test("long-title-hero-stays-bounded (torture)", async ({ page }) => {
  await page.addInitScript((t) => { (window as unknown as Record<string, unknown>).__TL_FAKE_LONG_TITLE__ = t; }, CHASM_TITLE);
  await page.goto("/");
  const h1 = page.locator("h1.tl-desk-title");
  await expect(h1).toBeVisible();
  // The FULL stored title is kept for hover (title=) and screen readers (aria-label);
  // the visible headline is the bounded main part (split on the first colon only).
  await expect(h1).toHaveAttribute("title", CHASM_TITLE);
  await expect(h1).toHaveAttribute("aria-label", CHASM_TITLE);
  await expect(h1).toContainText("Crossing the Chasm, 3rd Edition");
  await expect(page.locator(".tl-desk-subtitle")).toContainText("Marketing and Selling Disruptive Products");
  // Bounded at every width: a clamped height (never the ~8 lines an unbounded
  // 46px title would wrap to) and no horizontal overflow.
  for (const { w } of WIDTHS) {
    await page.setViewportSize({ width: w, height: 820 });
    const box = await h1.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(200);
    const overflow = await h1.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  await shootWidths(page, "33-long-title-hero");
});

test("long-title-hero-stays-bounded-dark (torture)", async ({ page }) => {
  await page.addInitScript((t) => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_LONG_TITLE__ = t;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  }, CHASM_TITLE);
  await page.goto("/");
  await expect(page.locator("h1.tl-desk-title")).toContainText("Crossing the Chasm, 3rd Edition");
  await shootWidths(page, "33b-long-title-hero-dark");
});

test("short-title-hero-reads-grand", async ({ page }) => {
  // The default seed is the short "Meditations" — it must still read large and
  // centered at all three widths (the clamp's lower bound, not a shrunk title).
  await page.goto("/");
  await expect(page.locator("h1.tl-desk-title")).toHaveText("Meditations");
  await shootWidths(page, "36-short-title-hero");
});

test("short-title-hero-reads-grand-dark", async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await expect(page.locator("h1.tl-desk-title")).toHaveText("Meditations");
  await shootWidths(page, "36b-short-title-hero-dark");
});

test("long-title-chosen-screen-stays-bounded (torture)", async ({ page }) => {
  await page.addInitScript((t) => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_LONG_TITLE__ = t;
    w.__TL_FAKE_NO_PLAN__ = true;
  }, CHASM_TITLE);
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();
  const h1 = page.locator("h1.tl-chosen-h");
  await expect(h1).toBeVisible();
  await expect(h1).toHaveAttribute("title", CHASM_TITLE);
  await expect(h1).toHaveAttribute("aria-label", `${CHASM_TITLE} is yours to begin.`);
  await expect(h1).toContainText("Crossing the Chasm, 3rd Edition is yours to begin.");
  await expect(page.locator(".tl-chosen-subtitle")).toContainText("Marketing and Selling Disruptive Products");
  for (const { w } of WIDTHS) {
    await page.setViewportSize({ width: w, height: 820 });
    const box = await h1.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(220);
    const overflow = await h1.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
  await shootWidths(page, "34-long-title-chosen");
});

test("long-title-chosen-screen-stays-bounded-dark (torture)", async ({ page }) => {
  await page.addInitScript((t) => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_LONG_TITLE__ = t;
    w.__TL_FAKE_NO_PLAN__ = true;
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  }, CHASM_TITLE);
  await page.goto("/");
  await page.getByRole("button", { name: "Start a plan" }).click();
  await expect(page.locator("h1.tl-chosen-h")).toContainText("Crossing the Chasm, 3rd Edition is yours to begin.");
  await shoot(page, "34b-long-title-chosen-dark");
});

test("long-title-plans-screen-stays-bounded (torture)", async ({ page }) => {
  // The "earlier attempts" screen reached from the Today hero renders the book
  // title big too — it gets the same bounded treatment (review-found sibling).
  await page.addInitScript((t) => { (window as unknown as Record<string, unknown>).__TL_FAKE_LONG_TITLE__ = t; }, CHASM_TITLE);
  await page.goto("/");
  await page.getByRole("button", { name: /earlier attempt/i }).click();
  const h1 = page.locator("h1.tl-plans-book");
  await expect(h1).toBeVisible();
  await expect(h1).toHaveAttribute("title", CHASM_TITLE);
  await expect(h1).toHaveAttribute("aria-label", CHASM_TITLE);
  await expect(h1).toContainText("Crossing the Chasm, 3rd Edition");
  await expect(page.locator(".tl-plans-subtitle")).toContainText("Marketing and Selling Disruptive Products");
  const box = await h1.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThan(180);
  const overflow = await h1.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shoot(page, "37-long-title-plans");
});

test("topbar-labels-wide-icons-narrow", async ({ page }) => {
  await page.goto("/");
  // Wide: the segmented control shows text labels.
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator("#tab-today .tl-seg-label")).toBeVisible();
  await expect(page.locator("#tab-today .tl-seg-ico")).toBeHidden();
  await shoot(page, "35-topbar-wide-labels");
  // Tight bar (bookbar container < 30rem): labels collapse to icons, accessible
  // names preserved via each tab's aria-label.
  await page.setViewportSize({ width: 460, height: 800 });
  await expect(page.locator("#tab-today .tl-seg-label")).toBeHidden();
  await expect(page.locator("#tab-today .tl-seg-ico")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Today" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Notes" })).toBeVisible();
  await shoot(page, "35b-topbar-narrow-icons");
});

test("topbar-labels-wide-icons-narrow-dark", async ({ page }) => {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("tl.theme", "dark"); } catch { /* ignore */ }
  });
  await page.goto("/");
  await page.setViewportSize({ width: 1100, height: 800 });
  await shoot(page, "35c-topbar-wide-labels-dark");
  await page.setViewportSize({ width: 460, height: 800 });
  await expect(page.locator("#tab-today .tl-seg-ico")).toBeVisible();
  await shoot(page, "35d-topbar-narrow-icons-dark");
});

import { test, expect, type Page } from "@playwright/test";

// Drives the LIBRARY surfaces (handoff) through their states against the seeded
// fake backend and writes a labelled screenshot of each to e2e/shots/ — light and
// dark. Each state is its own test so one broken selector never suppresses the
// rest. (a11y for these states lives in a11y.spec.ts.)

const SHOTS = "e2e/shots";

type Flags = Record<string, unknown>;

async function boot(page: Page, flags: Flags = {}, dark = false) {
  await page.addInitScript({ path: "e2e/fake-backend.js" });
  await page.addInitScript(
    ([f, d]) => {
      const w = window as unknown as Record<string, unknown>;
      for (const k of Object.keys(f as Flags)) w[k] = (f as Flags)[k];
      try {
        window.localStorage.setItem("tl.theme", d ? "dark" : "light");
        window.localStorage.setItem("tl.dataFolderSeen", "1"); // suppress the moment unless a test clears it
      } catch {
        /* ignore */
      }
    },
    [flags, dark] as const,
  );
  await page.goto("/");
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function openLibrary(page: Page) {
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  await page.getByRole("tab", { name: "Library" }).click();
  await page.getByRole("heading", { name: "Your library" }).waitFor();
}

// ── the library surface at three sizes ──
test("library-few-light", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 });
  await openLibrary(page);
  await expect(page.getByText("Reading now")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reading" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finished" })).toBeVisible();
  await shoot(page, "40-library-few");
});

test("library-few-dark", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 }, true);
  await openLibrary(page);
  await shoot(page, "40b-library-few-dark");
});

test("library-dense-light", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 21 });
  await openLibrary(page);
  await expect(page.getByText("21 books")).toBeVisible();
  await shoot(page, "41-library-dense");
});

test("library-dense-dark", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 21 }, true);
  await openLibrary(page);
  await shoot(page, "41b-library-dense-dark");
});

test("library-search-light", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 58 });
  await openLibrary(page);
  await expect(page.getByPlaceholder("Find a book in your library")).toBeVisible();
  await shoot(page, "42-library-search");
});

test("library-empty", async ({ page }) => {
  // Forced for the screenshot: a card-bearing Today but an empty shelf renders
  // the calm empty/return state (in normal flow the front door owns zero books).
  await boot(page, { __TL_FAKE_LIBRARY_N__: 0 });
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page.getByText("Your library is empty for now")).toBeVisible();
  await shoot(page, "42b-library-empty");
});

// ── the switcher + its per-book context menu ──
test("switcher-and-menu-dark", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 }, true);
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  await page.getByTitle("Switch book").click();
  await expect(page.getByText("Recent")).toBeVisible();
  await expect(page.getByText("Now")).toBeVisible();
  await page.getByRole("button", { name: "Dracula, Bram Stoker, reading" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Continue reading" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Show in library" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove from library" })).toBeVisible();
  await shoot(page, "43-switcher-menu-dark");
});

test("switcher-light", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 });
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  await page.getByTitle("Switch book").click();
  await expect(page.getByText("All books in your library")).toBeVisible();
  await shoot(page, "43b-switcher-light");
});

// ── the two remove confirmations + the undo toast ──
async function openRemoveFor(page: Page, rowName: string) {
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  await page.getByTitle("Switch book").click();
  await page.getByRole("button", { name: rowName }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from library" }).click();
  await page.getByRole("dialog").waitFor();
}

test("remove-imported-light", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 });
  await openRemoveFor(page, "Meditations, Marcus Aurelius, reading");
  await expect(page.getByText(/tutor history for it will be deleted/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep it" })).toBeVisible();
  await shoot(page, "44-remove-imported");
});

test("remove-catalogue-dark", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 }, true);
  await openRemoveFor(page, "Dracula, Bram Stoker, reading");
  await expect(page.getByText(/add it back from the catalogue anytime, free/)).toBeVisible();
  await shoot(page, "45-remove-catalogue-dark");
});

test("remove-undo-toast", async ({ page }) => {
  await boot(page, { __TL_FAKE_LIBRARY_N__: 6 });
  await openRemoveFor(page, "Dracula, Bram Stoker, reading");
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Dracula removed from your library.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await shoot(page, "46-remove-undo");
});

// ── the calm moved-file note (book detail) ──
test("moved-file-note", async ({ page }) => {
  await boot(page, { __TL_FAKE_MOVED_FILE__: true });
  await page.getByRole("heading", { name: "Meditations" }).first().waitFor();
  await page.getByRole("button", { name: /earlier attempt/i }).click();
  await expect(page.getByText("Still here, still readable")).toBeVisible();
  await expect(page.getByText("Imported · your file")).toBeVisible();
  await shoot(page, "47-moved-file");
});

// ── the one-time data-folder moment (first own-file import) ──
test("data-folder-moment", async ({ page }) => {
  await page.addInitScript({ path: "e2e/fake-backend.js" });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__TL_FAKE_EMPTY__ = true;
    w.__TL_FAKE_PICK_PATH__ = "/Users/demo/Books/sapiens.epub";
    try {
      window.localStorage.removeItem("tl.dataFolderSeen"); // not seen yet
    } catch {
      /* ignore */
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Import a \.txt or \.epub/i }).click();
  await expect(page.getByText("Everything lives in one folder")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show in Finder" })).toBeVisible();
  await shoot(page, "48-data-folder");
});

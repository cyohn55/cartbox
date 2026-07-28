/**
 * Verifies the console's content tabs on small phones.
 *
 * verify-console.mjs drives the whole flow at one comfortable viewport (390x844).
 * This one checks the two content-bearing tabs at the smallest widths the site
 * targets — 360x640 is the common small-Android viewport — where the screen
 * inside the chassis is only ~250px wide and layouts that merely "fit" at 390
 * start to collapse.
 *
 * Run with Windows Node against a CDP-attached Chrome; see verify-console.mjs
 * for the WSL setup this shares.
 *
 *   node scripts/verify-small-phone.mjs
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const CDP_URL = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const BASE_URL = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(SHOT_DIR, { recursive: true });

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 320, height: 568 },
];

const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function pressShellButton(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await button.dispatchEvent("pointerup", { pointerId: 1 });
}

const browser = await chromium.connectOverCDP(CDP_URL);

try {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({
      viewport,
      hasTouch: true,
      isMobile: true,
      userAgent: MOBILE_USER_AGENT,
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await page.goto(`${BASE_URL}/console`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("title-screen").waitFor({ timeout: 20000 });
    await pressShellButton(page, "Start");
    await page.getByTestId("auth-screen").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "Continue as guest" }).click();

    // The device must not overflow the viewport, however short it is.
    const deviceFits = await page.evaluate(() => {
      const device = document.querySelector(".hh-img-device, .hh-device");
      if (!device) return false;
      const rect = device.getBoundingClientRect();
      return rect.width <= window.innerWidth + 1 && rect.height <= window.innerHeight + 1;
    });
    check(`${label}: device fits the viewport`, deviceFits);

    // --- Feed ---------------------------------------------------------------
    await page.getByTestId("home-feed").waitFor({ timeout: 20000 });
    const feedCards = await page.locator(".os-card").count();
    check(`${label}: feed renders cards`, feedCards > 0, `${feedCards} cards`);
    await page.screenshot({ path: `${SHOT_DIR}/feed-${label}.png` });

    // --- Browse -------------------------------------------------------------
    await page.getByRole("button", { name: "BROWSE" }).click();
    await page.getByTestId("browse-screen").waitFor({ timeout: 10000 });
    await page
      .locator(".os-grid-card, .os-empty")
      .first()
      .waitFor({ timeout: 20000 })
      .catch(() => {});

    const browse = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".os-grid-card")];
      const grid = document.querySelector(".os-grid");
      // Distinct left edges = how many columns the grid actually laid out.
      const columns = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)));
      return {
        cards: cards.length,
        columns: columns.size,
        stillLoading: Boolean(document.querySelector(".os-loading")),
        // A card taller than the screen means one giant cartridge per view.
        overflows: grid
          ? cards.some((card) => card.getBoundingClientRect().height > grid.clientHeight)
          : false,
      };
    });

    check(`${label}: browse lists the catalog`, browse.cards > 0 && !browse.stillLoading, `${browse.cards} cards`);
    // The shelf must read as a shelf: never one oversized cartridge per row.
    check(`${label}: browse keeps at least two columns`, browse.columns >= 2, `${browse.columns} columns`);
    check(`${label}: no cartridge taller than the screen`, !browse.overflows);
    await page.screenshot({ path: `${SHOT_DIR}/browse-${label}.png` });

    check(`${label}: no page errors`, pageErrors.length === 0, pageErrors[0] ?? "");
    await context.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

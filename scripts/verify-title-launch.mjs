// Launches a catalog title through the real console flow and reports what the
// player screen ends up showing.
//
// Loading a runtime's boot page directly proves the bundle is deliverable; it
// does not prove the console can launch it. This drives the actual path a player
// takes — /console → past boot/title/auth → Browse → CARTBOX → tap the
// cartridge — and then watches the player stage for the loading overlay clearing.
//
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-title-launch.mjs "C-Dogs" "Doom"
//
// Env overrides: CBX_BASE_URL, CBX_CDP_URL, CBX_SHOT_DIR.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "https://cartbox-web-bfug.vercel.app";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-console";
const titles = process.argv.slice(2);

/** How long a title gets to clear its loading overlay before it counts as stuck. */
const READY_TIMEOUT_MS = 150000;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);

/**
 * Loads a page, riding out a protected deployment's security checkpoint.
 *
 * The checkpoint answers the first request with a 403 interstitial and only
 * hands out its cookie once that page's script has run, so a single navigation
 * lands on the challenge rather than the app.
 */
async function gotoPastCheckpoint(page, url, isReady) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    if (await isReady()) return true;
  }
  return false;
}

/** Walks the shell from a cold load to the Browse grid. */
async function openBrowse(page) {
  const arrived = await gotoPastCheckpoint(page, `${BASE}/console`, () =>
    page
      .getByTestId("title-screen")
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false),
  );
  if (!arrived) throw new Error("never got past the security checkpoint to the title screen");
  await page.getByTestId("title-screen").click();
  // Guest play skips the account, which is what a first-time visitor does.
  const guest = page.getByRole("button", { name: /guest/i }).first();
  if (await guest.isVisible({ timeout: 10000 }).catch(() => false)) await guest.click();
  await page.getByTestId("console-shell").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Browse" }).first().click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 20000 });
  // The grid is populated from /api/carts + /api/titles, so wait for a card.
  await page.locator('[data-entry-kind="game"]').first().waitFor({ timeout: 30000 });
}

async function probe(context, titleName) {
  const page = await context.newPage();
  const events = [];
  page.on("console", (message) => {
    if (message.type() === "error") events.push(`console.error: ${message.text().slice(0, 240)}`);
  });
  page.on("pageerror", (error) => events.push(`pageerror: ${String(error).slice(0, 240)}`));
  page.on("requestfailed", (request) =>
    events.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      events.push(`HTTP ${response.status()}: ${response.url()} (${response.headers()["content-type"] ?? "?"})`);
    }
  });

  console.log(`\n=== ${titleName}`);
  try {
    // Measure a first-time visitor: drop the HTTP cache so the bundle is really
    // downloaded, but keep cookies so a protected deployment's checkpoint stays
    // solved. Re-running with a warm cache reports ~1s for every title and hides
    // exactly the download this is trying to time.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.clearBrowserCache");
    await cdp.detach();

    await openBrowse(page);
    const card = page.locator('[data-entry-kind="game"]', { hasText: titleName }).first();
    await card.waitFor({ timeout: 20000 });
    await card.click();
    await page.getByTestId("game-screen").waitFor({ timeout: 30000 });

    // What the player experiences as "loading" is the overlay's lifetime, so
    // time it from the tap rather than from any internal engine milestone.
    const launchedAt = Date.now();
    const loading = page.locator(".os-loading");
    const deadline = launchedAt + READY_TIMEOUT_MS;
    let cleared = false;
    while (Date.now() < deadline) {
      const count = await loading.count();
      if (count === 0) { cleared = true; break; }
      const text = (await loading.first().innerText().catch(() => "")).trim();
      if (/ERROR/i.test(text)) { console.log(`  overlay: ${text}`); break; }
      await page.waitForTimeout(500);
    }
    const seconds = ((Date.now() - launchedAt) / 1000).toFixed(1);
    const overlay = (await loading.first().innerText().catch(() => "")).trim();
    console.log(
      `  loading overlay cleared: ${cleared} after ${seconds}s${overlay ? ` (last: "${overlay}")` : ""}`,
    );
    await page.waitForTimeout(8000);
    await page.screenshot({ path: `${OUT}/${titleName.replace(/[^a-z0-9]+/gi, "-")}.png` });
  } catch (error) {
    console.log(`  flow failed: ${error.message.split("\n")[0]}`);
    await page.screenshot({ path: `${OUT}/${titleName.replace(/[^a-z0-9]+/gi, "-")}-failed.png` }).catch(() => {});
  }
  for (const event of events.slice(0, 25)) console.log(`  ${event}`);
  await page.close();
}

try {
  // CBX_PHONE drives the portrait handheld layout most visitors actually get,
  // which sizes the player stage very differently from a desktop window.
  const context = await browser.newContext(
    process.env.CBX_PHONE
      ? {
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        }
      : { viewport: { width: 1280, height: 900 } },
  );
  // The home page is what clears a protected deployment's security checkpoint
  // for the whole context; going straight to /console just collects 403s.
  const warmup = await context.newPage();
  await warmup.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await warmup.waitForTimeout(8000);
  console.log(`warm-up: ${warmup.url()} — "${await warmup.title()}"`);
  await warmup.close();

  for (const title of titles) await probe(context, title);
  await context.close();
} finally {
  await browser.close();
}

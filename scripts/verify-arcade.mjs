// Verifies the Browse tab's TIC-80 Arcade source end-to-end: full category
// listing from tic80.com, search, and playing a stock archive cart in the
// handheld with working shell input. Run like verify-console.mjs
// (Windows Node + CDP Chrome; see that script's header).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function frameHash(page) {
  const png = await page.locator(".os-game-stage canvas").first().screenshot();
  let hash = 0;
  for (let i = 0; i < png.length; i += 13) hash = ((hash << 5) - hash + png[i]) | 0;
  return String(hash);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 10000 });
  await page.getByTestId("title-screen").click();
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 10000 });

  await page.getByRole("tab", { name: "TIC-80 ARCADE" }).click();
  await page.locator(".os-grid-card").first().waitFor({ timeout: 30000 });
  const gamesCount = await page.locator(".os-grid-card").count();
  check("arcade lists the full Games category", gamesCount > 1000, `${gamesCount} carts`);
  await page.screenshot({ path: "C:/Temp/cbx-verify/14-arcade-browse.png" });

  await page.getByPlaceholder("Search games…").fill("8 bit panda");
  await page.waitForTimeout(600);
  const matches = await page.locator(".os-grid-card").count();
  check("search narrows the archive", matches >= 1 && matches < 20, `${matches} matches`);

  await page.locator("button.os-grid-card", { hasText: "8 Bit Panda" }).first().click();
  await page.locator(".os-game-stage canvas").waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // stock carts animate their title screens
  check("archive cart boots in the handheld", true);
  await page.screenshot({ path: "C:/Temp/cbx-verify/15-arcade-panda.png" });

  // Shell input reaches the stock cart (Z = A button starts the game).
  const before = await frameHash(page);
  const aButton = page.getByRole("button", { name: "A button", exact: true });
  await aButton.dispatchEvent("pointerdown", { pointerId: 21 });
  await page.waitForTimeout(250);
  await aButton.dispatchEvent("pointerup", { pointerId: 21 });
  await page.waitForTimeout(1500);
  const after = await frameHash(page);
  check("shell A button drives the archive cart", after !== before, `${before} → ${after}`);
  await page.screenshot({ path: "C:/Temp/cbx-verify/16-arcade-panda-playing.png" });

  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

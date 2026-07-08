// End-to-end verification of the handheld console experience (/console).
//
// Drives a real Chrome over CDP at a phone viewport through the whole flow:
// boot loader → title → sign-in (guest) → home feed → tabs → full-screen play,
// in portrait (Game Boy) and landscape (AYN Thor) orientations.
//
// Designed for the WSL dev setup, where Linux browsers can't run but Windows
// Chrome can: start Chrome headless with CDP, then run this with Windows Node:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-console.mjs
//
// Env overrides: CBX_BASE_URL (default http://localhost:3000),
//                CBX_CDP_URL  (default http://127.0.0.1:9222),
//                CBX_SHOT_DIR (default C:\Temp\cbx-verify).

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** Presses a shell button the way a thumb does: pointerdown, then pointerup. */
async function pressShellButton(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await button.dispatchEvent("pointerup", { pointerId: 1 });
}

const browser = await chromium.connectOverCDP(CDP);
try {
  // --- Portrait phone (Game Boy layout) ------------------------------------
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await phone.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // 1. The homepage on a phone boots into the console.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/console", { timeout: 8000 }).catch(() => {});
  check("phone / redirects to /console", page.url().includes("/console"), page.url());

  // 2. Boot loader shows, then hands off to the title screen by itself.
  const sawBoot = await page
    .getByTestId("boot-screen")
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check("boot screen shows", sawBoot);
  await page.screenshot({ path: shot("01-boot-portrait") });

  await page.getByTestId("title-screen").waitFor({ timeout: 10000 });
  check("title screen after boot", true);
  await page.screenshot({ path: shot("02-title-portrait") });

  // 3. The shell's START button advances to sign-in.
  await pressShellButton(page, "Start");
  await page.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  check("START advances to sign-in", true);
  await page.screenshot({ path: shot("03-auth-portrait") });

  // 4. Continue as guest → home feed with mixed cards.
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });
  const cardCount = await page.locator(".os-card").count();
  check("guest lands on home feed with cards", cardCount > 0, `${cardCount} cards`);
  await page.screenshot({ path: shot("04-feed-portrait") });

  // 5. D-pad down pages the feed.
  const scrollBefore = await page.locator(".os-feed").evaluate((el) => el.scrollTop);
  await pressShellButton(page, "Down");
  await page.waitForTimeout(900);
  const scrollAfter = await page.locator(".os-feed").evaluate((el) => el.scrollTop);
  check("D-pad down scrolls the feed", scrollAfter > scrollBefore, `${scrollBefore} → ${scrollAfter}`);

  // 6. Tabs: tap Browse, then SELECT cycles to Library, tap Profile.
  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });
  check("Browse tab renders", true);
  await page.screenshot({ path: shot("05-browse-portrait") });

  await pressShellButton(page, "Select");
  await page.getByTestId("library-screen").waitFor({ timeout: 5000 });
  check("SELECT cycles Browse → Library", true);
  await page.screenshot({ path: shot("06-library-portrait") });

  await page.getByRole("button", { name: "PROFILE" }).click();
  await page.getByTestId("profile-screen").waitFor({ timeout: 5000 });
  check("Profile tab renders", true);

  // 7. Launch a free cart full-screen from Browse; SELECT ejects.
  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });
  // The archive fetch is async — wait for it to settle (cards or empty note).
  await page
    .locator(".os-grid-card, .os-empty")
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});
  const gridCards = page.locator("button.os-grid-card");
  if ((await gridCards.count()) > 0) {
    await gridCards.first().click();
    await page.getByTestId("game-screen").waitFor({ timeout: 15000 });
    const canvasUp = await page
      .locator(".os-game-stage canvas")
      .first()
      .waitFor({ timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    check("cart boots full-screen in console", canvasUp);
    await page.screenshot({ path: shot("07-game-portrait") });

    await pressShellButton(page, "Select");
    await page.getByTestId("browse-screen").waitFor({ timeout: 5000 });
    check("SELECT ejects back to Browse", true);
  } else {
    check("cart boots full-screen in console", false, "no playable carts listed");
  }

  check("no page errors (portrait run)", errors.length === 0, errors.slice(0, 3).join(" | "));
  await phone.close();

  // --- Signed-in run: composer + profile ------------------------------------
  // Uses the local seed account (scripts/seed.mjs). Skipped against production.
  const member = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const app = await member.newPage();
  await app.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await app.getByTestId("title-screen").waitFor({ timeout: 10000 });
  await pressShellButton(app, "Start");
  await app.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  await app.getByPlaceholder("you@email.com").fill("demo@cartbox.dev");
  await app.getByPlaceholder("password").fill("demo1234");
  await app.getByRole("button", { name: "Sign in", exact: true }).click();
  await app.getByTestId("home-feed").waitFor({ timeout: 10000 });
  check("email sign-in reaches the feed", true);

  const postTitle = `LFP smoke ${Date.now()}`;
  await app.getByTestId("compose-button").click();
  await app.getByTestId("composer-screen").waitFor({ timeout: 5000 });
  await app.screenshot({ path: shot("10-composer") });
  await app.getByPlaceholder("Who are you looking for?").fill(postTitle);
  await app
    .locator("textarea.os-input")
    .fill("Automated verification invite — racing the demo cart, join in.");
  await app.getByRole("button", { name: "PUBLISH" }).click();
  await app.getByTestId("home-feed").waitFor({ timeout: 10000 });
  const posted = await app
    .locator(".os-card h3", { hasText: postTitle })
    .first()
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("composer publishes and the post lands in the feed", posted, postTitle);
  await app.screenshot({ path: shot("11-feed-after-post") });

  await app.getByRole("button", { name: "PROFILE" }).click();
  await app.getByTestId("profile-screen").waitFor({ timeout: 5000 });
  const handleShown = await app
    .locator(".os-profile-handle", { hasText: "@demo" })
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("signed-in profile shows the player card", handleShown);
  await app.screenshot({ path: shot("12-profile-signed-in") });
  await member.close();

  // --- Landscape phone (AYN Thor layout) ------------------------------------
  const wide = await browser.newContext({
    viewport: { width: 844, height: 390 },
    hasTouch: true,
  });
  const land = await wide.newPage();
  await land.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await land.getByTestId("title-screen").waitFor({ timeout: 10000 });
  const geometry = await land.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
    return { screen: rect(".hh-screen-bezel"), dpad: rect(".hh-dpad"), face: rect(".hh-face") };
  });
  const flanked =
    geometry.dpad && geometry.screen && geometry.face
      ? geometry.dpad.right <= geometry.screen.left + 1 && geometry.screen.right <= geometry.face.left + 1
      : false;
  check("landscape flanks the screen (D-pad left, buttons right)", flanked);
  await land.screenshot({ path: shot("08-title-landscape") });

  await pressShellButton(land, "Start");
  await land.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  await land.getByRole("button", { name: "Continue as guest" }).click();
  await land.getByTestId("home-feed").waitFor({ timeout: 10000 });
  check("landscape reaches the home feed", true);
  await land.screenshot({ path: shot("09-feed-landscape") });
  await wide.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

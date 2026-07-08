// Visual verification of the cartridge-shell cards in Browse and Library.
//
// Drives Windows Chrome over CDP (see verify-console.mjs for the WSL setup):
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-cartridge-cards.mjs
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

/** Asserts every card in the current grid shows the shell with the label on it. */
async function auditGrid(page, screenName) {
  const cards = page.locator(".os-cart-card");
  const cardCount = await cards.count();
  check(`${screenName}: cartridge cards present`, cardCount > 0, `${cardCount} cards`);
  if (cardCount === 0) {
    return;
  }

  const shellCount = await page.locator(".os-cart-card .os-cart-shell-img").count();
  check(`${screenName}: every card has the cartridge shell`, shellCount === cardCount);

  const labelCount = await page.locator(".os-cart-card .os-cart-label").count();
  check(`${screenName}: every card has a label (cover or placeholder)`, labelCount === cardCount);

  // The cover must sit inside the shell, horizontally centered on it.
  const layout = await page
    .locator(".os-cart-card .os-cart-shell")
    .first()
    .evaluate((shell) => {
      const shellRect = shell.getBoundingClientRect();
      const labelRect = shell.querySelector(".os-cart-label").getBoundingClientRect();
      return {
        inside:
          labelRect.left >= shellRect.left &&
          labelRect.right <= shellRect.right &&
          labelRect.top >= shellRect.top &&
          labelRect.bottom <= shellRect.bottom,
        centerDrift: Math.abs(
          (labelRect.left + labelRect.right) / 2 - (shellRect.left + shellRect.right) / 2,
        ),
      };
    });
  check(`${screenName}: cover sits inside the shell`, layout.inside);
  check(`${screenName}: cover is centered on the shell`, layout.centerDrift < 2, `drift ${layout.centerDrift.toFixed(1)}px`);

  // The cover is drawn 15% wider than the recess-fitted 76% → 87.4%.
  const widthRatio = await page
    .locator(".os-cart-card .os-cart-shell")
    .first()
    .evaluate((shell) => {
      const labelRect = shell.querySelector(".os-cart-label").getBoundingClientRect();
      return labelRect.width / shell.getBoundingClientRect().width;
    });
  check(
    `${screenName}: cover is 15% enlarged (≈87.4% of shell width)`,
    Math.abs(widthRatio - 0.874) < 0.01,
    `${(widthRatio * 100).toFixed(1)}%`,
  );

  // The cover must out-stack the CRT film so the art stays crisp.
  const stacking = await page.evaluate(() => {
    const stage = document.querySelector(".os-stage.os-shell");
    const label = document.querySelector(".os-cart-label");
    return {
      film: Number(getComputedStyle(stage, "::after").zIndex),
      label: Number(getComputedStyle(label).zIndex),
    };
  });
  check(
    `${screenName}: cover art stacks above the CRT film`,
    stacking.label > stacking.film,
    `label z ${stacking.label} vs film z ${stacking.film}`,
  );

  const shellLoaded = await page
    .locator(".os-cart-card .os-cart-shell-img")
    .first()
    .evaluate((img) => img.complete && img.naturalWidth > 0);
  check(`${screenName}: cartridge PNG actually loads`, shellLoaded);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await phone.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 15000 });
  await pressShellButton(page, "Start");
  await page.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  // Sign in with the local seed account so the Library shelf has carts on it.
  await page.getByPlaceholder("you@email.com").fill("demo@cartbox.dev");
  await page.getByPlaceholder("password").fill("demo1234");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });
  await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await auditGrid(page, "Browse");
  await page.screenshot({ path: shot("cart-browse") });

  // The TIC-80 ARCADE tab lists carts with real cover art — verify a cover
  // image (not just the placeholder) composites onto the label.
  await page.getByRole("tab", { name: "TIC-80 ARCADE" }).click();
  await page.locator("img.os-cart-label").first().waitFor({ timeout: 15000 });
  // Covers lazy-load from tic80.com — poll until at least one has pixels.
  const coverLoaded = await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll("img.os-cart-label")].some(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      undefined,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check("Arcade: real cover art loads on the label", coverLoaded);
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("cart-arcade") });
  await page.getByRole("tab", { name: "CARTBOX", exact: true }).click();
  await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 10000 });

  await page.getByRole("button", { name: "LIBRARY" }).click();
  await page.getByTestId("library-screen").waitFor({ timeout: 5000 });
  await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await auditGrid(page, "Library");
  await page.screenshot({ path: shot("cart-library") });

  // Hovering (or D-pad focusing) a cart rocks it back and forth.
  const hoverCard = page.locator("button.os-cart-card").first();
  await hoverCard.hover();
  const wobbleName = await hoverCard
    .locator(".os-cart-shell")
    .evaluate((shell) => getComputedStyle(shell).animationName);
  check("hovered cart runs the selection wobble", wobbleName === "os-cart-wobble", wobbleName);

  // Selecting a cart spins it three times, zooms it out, THEN boots it.
  const selectedAt = Date.now();
  await hoverCard.click();
  const launching = await page
    .locator('[data-launching="true"] .os-cart-shell')
    .waitFor({ timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  check("selection enters the launch state", launching);
  if (launching) {
    const launchName = await page
      .locator('[data-launching="true"] .os-cart-shell')
      .evaluate((shell) => getComputedStyle(shell).animationName);
    check("launch runs the triple-spin animation", launchName === "os-cart-launch", launchName);
    await page.screenshot({ path: shot("cart-launching") });
  }
  await page.getByTestId("game-screen").waitFor({ timeout: 20000 });
  const bootDelay = Date.now() - selectedAt;
  check("boot waits for the spin + zoom (≥1.5s)", bootDelay >= 1500, `${bootDelay}ms`);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

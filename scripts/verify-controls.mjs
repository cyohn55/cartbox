// Proves the handheld is fully playable with its physical controls alone:
// boot → title → guest sign-in → feed → tabs → Browse → launch a cart → eject,
// every step via shell buttons (no taps on screen content). Then exercises
// personalization: START opens settings, themes/joystick apply, and the
// Konami code hands the controls to the background mini-game.
// Run like verify-console.mjs (Windows Node + CDP Chrome).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** One thumb press on a shell button: pointerdown, short hold, pointerup. */
async function press(page, label, holdMs = 60) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await page.waitForTimeout(holdMs);
  await button.dispatchEvent("pointerup", { pointerId: 1 });
  await page.waitForTimeout(120);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 12000 });

  // 1. Title → auth via START.
  await press(page, "Start");
  await page.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  check("START advances title → sign-in", true);

  // 2. Sign in as guest using only the D-pad + A.
  // Cursor starts at the top; walk down to "Continue as guest" and press A.
  for (let i = 0; i < 8; i += 1) {
    await press(page, "Down");
    const focusedText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    if (focusedText === "Continue as guest") {
      break;
    }
  }
  const onGuest = await page.evaluate(
    () => document.activeElement?.textContent?.trim() === "Continue as guest",
  );
  check("D-pad walks the cursor to 'Continue as guest'", onGuest);
  await page.screenshot({ path: `${OUT}/20-cursor-auth.png` });
  await press(page, "A button");
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });
  check("A activates it — guest lands on the feed", true);

  // 3. Feed: D-pad down pages cards.
  const before = await page.locator(".os-feed").evaluate((el) => el.scrollTop);
  await press(page, "Down");
  await page.waitForTimeout(800);
  const after = await page.locator(".os-feed").evaluate((el) => el.scrollTop);
  check("D-pad pages the feed", after > before, `${before} → ${after}`);

  // 4. SELECT cycles to Browse; cursor + A launch a cart.
  await press(page, "Select");
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });
  check("SELECT cycles feed → Browse", true);
  await page.locator(".os-grid-card").first().waitFor({ timeout: 10000 });

  // Walk the cursor down into the cart grid, then A to insert the cartridge.
  for (let i = 0; i < 6; i += 1) {
    await press(page, "Down");
    const inGrid = await page.evaluate(() => document.activeElement?.classList.contains("os-grid-card") ?? false);
    if (inGrid) {
      break;
    }
  }
  const focusedCard = await page.evaluate(() => document.activeElement?.classList.contains("os-grid-card") ?? false);
  check("cursor reaches the Browse cart grid", focusedCard);
  await page.screenshot({ path: `${OUT}/21-cursor-browse.png` });
  await press(page, "A button");
  await page.getByTestId("game-screen").waitFor({ timeout: 15000 });
  await page.locator(".os-game-stage canvas").waitFor({ timeout: 25000 });
  check("A launches the focused cart", true);
  await press(page, "Select");
  await page.getByTestId("browse-screen").waitFor({ timeout: 5000 });
  check("SELECT ejects back to Browse", true);

  // 5. START opens settings; pick themes/joystick with taps (already proven
  //    navigable); confirm they apply to the shell.
  await press(page, "Start");
  await page.getByTestId("settings-screen").waitFor({ timeout: 5000 });
  check("START opens console settings", true);

  await page.getByRole("radio", { name: "RETRO HANDHELD" }).click();
  let theme = await page.locator(".hh-root").getAttribute("data-theme");
  check("retro theme applies to the shell", theme === "retro");
  await page.screenshot({ path: `${OUT}/22-theme-retro.png` });

  await page.getByRole("radio", { name: "JOYSTICK" }).click();
  const joystick = await page.locator(".hh-joystick").count();
  check("joystick layout replaces the D-pad", joystick === 1);
  await page.screenshot({ path: `${OUT}/23-joystick.png` });
  await page.getByRole("radio", { name: "D-PAD" }).click();

  await page.getByRole("radio", { name: "NEON" }).click();
  const buttons = await page.locator(".hh-root").getAttribute("data-buttons");
  check("neon button colors apply", buttons === "neon");

  await page.getByRole("radio", { name: "ARCADE SHELL" }).click();
  theme = await page.locator(".hh-root").getAttribute("data-theme");
  const dockIdle = await page.locator(".hh-minigame").count();
  check("arcade shell docks the mini-game (attract mode)", theme === "arcade" && dockIdle === 1);
  await page.screenshot({ path: `${OUT}/24-theme-arcade.png` });

  // B backs out of settings (data-console-back).
  await press(page, "B button");
  await page.getByTestId("settings-screen").waitFor({ state: "detached", timeout: 5000 });
  check("B closes settings", true);

  // 6. Konami code hands the controls to the background game.
  for (const label of ["Up", "Up", "Down", "Down", "Left", "Right", "Left", "Right", "B button", "A button"]) {
    await press(page, label, 40);
  }
  const live = await page.locator('.hh-minigame[data-live="true"]').count();
  check("Konami code activates the mini-game", live === 1);
  await page.screenshot({ path: `${OUT}/25-konami-live.png` });

  // While the mini-game holds the controls, SELECT must not switch tabs.
  await press(page, "Select");
  const backToIdle = await page.locator('.hh-minigame[data-live="true"]').count();
  const stillBrowse = await page.getByTestId("browse-screen").count();
  check("SELECT returns the controls to the console", backToIdle === 0 && stillBrowse === 1);

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

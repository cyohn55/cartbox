// End-to-end verification of the /world build tools: the hover cursor that
// previews where a block lands, and the persistence that keeps a build across
// visits.
//
// Drives a real Chrome over CDP through the whole flow: boot the in-world OS,
// confirm a handheld to enter walk mode, hover the terrain (cursor appears),
// tap to place a block, then reload and assert the block is still standing.
//
// Designed for the WSL dev setup, where Linux browsers can't run but Windows
// Chrome can: start Chrome headless with CDP, then run this with Windows Node:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-world-build.mjs
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

/** Where the world remembers a build (must match worldStorage.BUILD_LAYER_KEY). */
const BUILD_KEY = "cartbox.world.build";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** How wide a window around the aimed pixel the cursor checks look at. */
const WINDOW = 32;

/**
 * Read back a square of drawn canvas pixels centred on a point given as a
 * fraction of the canvas. Only a window is read because the rest of the frame is
 * always in motion — falling snow, the bobbing handheld — while the terrain under
 * a still camera is not, so a local window isolates what the cursor drew.
 */
async function canvasWindow(page, fx, fy) {
  return page.evaluate(
    ({ fx, fy, window: size }) => {
      const canvas = document.querySelector("canvas");
      const context = canvas.getContext("2d");
      const x = Math.round(canvas.width * fx - size / 2);
      const y = Math.round(canvas.height * fy - size / 2);
      return Array.from(context.getImageData(x, y, size, size).data);
    },
    { fx, fy, window: WINDOW },
  );
}

/** Pixels that differ between two windows — how that patch of frame changed. */
function changedPixels(before, after) {
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * Count distinctly cyan pixels — the crystal material's colour, which nothing on
 * the grassy surface shares (white snow is excluded by the margin). Counting the
 * built material's own colour survives the small camera differences between
 * visits, which a pixel-for-pixel comparison across a reload would not.
 */
function cyanPixels(window) {
  let cyan = 0;
  for (let i = 0; i < window.length; i += 4) {
    const [r, g, b] = [window[i], window[i + 1], window[i + 2]];
    if (b > r + 40 && g > r + 40) cyan += 1;
  }
  return cyan;
}

/** Boot the in-world OS and confirm a handheld, which drops the player into walk mode. */
async function enterWalkMode(page) {
  await page.waitForTimeout(2500); // the OS boot sweep runs for ~1.3s
  await page.keyboard.press("z"); // A: menu → customizer
  await page.waitForTimeout(150);
  await page.keyboard.press("z"); // A: selector → swatch panel
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press("ArrowDown"); // walk the panel down to PICK
    await page.waitForTimeout(30);
  }
  await page.keyboard.press("z"); // A: confirm → walk mode
  await page.waitForTimeout(600);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${BASE}/world`, { waitUntil: "networkidle" });
  await page.evaluate((key) => window.localStorage.removeItem(key), BUILD_KEY); // start clean
  await page.reload({ waitUntil: "networkidle" });

  const canvas = page.locator("canvas");
  await canvas.waitFor({ state: "visible" });
  check("world canvas renders", true);

  await enterWalkMode(page);
  const palette = page.getByRole("radiogroup", { name: "Build material" });
  check("build-material palette appears in walk mode", await palette.isVisible());
  await page.screenshot({ path: shot("world-walk-mode") });

  // --- Hover cursor --------------------------------------------------------
  let box = await canvas.boundingBox();
  // A point low on the canvas: below the horizon, so it lands on terrain.
  const aimFx = 0.5;
  const aimFy = 0.85;
  // Page coordinates of the aimed point. Re-read whenever the page may have
  // scrolled (clicking the palette scrolls it into view), or the pointer lands
  // somewhere else entirely.
  let aimX = box.x + box.width * aimFx;
  let aimY = box.y + box.height * aimFy;
  const reaim = async () => {
    box = await canvas.boundingBox();
    aimX = box.x + box.width * aimFx;
    aimY = box.y + box.height * aimFy;
  };

  // Two readings with the pointer away from the target measure the frame's own
  // churn (drifting snow), so the cursor has to beat that noise, not just exceed zero.
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.waitForTimeout(250);
  const idleA = await canvasWindow(page, aimFx, aimFy);
  await page.waitForTimeout(250);
  const idleB = await canvasWindow(page, aimFx, aimFy);
  const noise = changedPixels(idleA, idleB);

  await page.mouse.move(aimX, aimY);
  await page.waitForTimeout(300);
  const hovered = await canvasWindow(page, aimFx, aimFy);
  const cursorPixels = changedPixels(idleB, hovered);
  check(
    "hover draws a build cursor on the aimed cell",
    cursorPixels > noise * 3 + 10,
    `${cursorPixels} px changed vs ${noise} px of frame noise`,
  );
  await page.screenshot({ path: shot("world-hover-cursor") });

  // --- Place a block -------------------------------------------------------
  // Build with crystal: cyan, so the block can be found by its own colour amongst
  // the grass both now and after a reload.
  check("the grass carries no crystal colour to begin with", cyanPixels(idleB) === 0, `${cyanPixels(idleB)} px`);
  await page.getByRole("radio", { name: "crystal" }).click();
  await reaim(); // that click may have scrolled the palette into view
  await page.mouse.move(aimX, aimY);
  await page.waitForTimeout(300);
  await page.mouse.click(aimX, aimY);
  await page.waitForTimeout(400);
  await page.mouse.move(box.x + 4, box.y + 4); // park off-target: only the block remains
  await page.waitForTimeout(400);
  const built = await canvasWindow(page, aimFx, aimFy);
  check(
    "the tapped cell is filled with the chosen material",
    cyanPixels(built) > 5,
    `${cyanPixels(built)} crystal px`,
  );
  await page.waitForTimeout(1000); // let the debounced save fire

  const saved = await page.evaluate((key) => window.localStorage.getItem(key), BUILD_KEY);
  check("placing a block persists the build layer", Boolean(saved), saved ? `${saved.length} bytes` : "no entry");
  const savedCount = saved ? JSON.parse(saved).count : 0;
  check("exactly one block was stored", savedCount === 1, `count=${savedCount}`);
  await page.screenshot({ path: shot("world-block-placed") });

  // --- Reload: the build is still standing ---------------------------------
  await page.reload({ waitUntil: "networkidle" });
  await canvas.waitFor({ state: "visible" });
  const stillSaved = await page.evaluate((key) => window.localStorage.getItem(key), BUILD_KEY);
  check("the save survives a reload", stillSaved === saved);

  await enterWalkMode(page);
  await reaim();
  await page.mouse.move(box.x + 4, box.y + 4); // no cursor: only the world itself
  await page.waitForTimeout(500);
  const restored = await canvasWindow(page, aimFx, aimFy);
  // The crystal block is standing in the world again, found by its own colour
  // (the camera settles a hair differently each visit, so its exact pixels move).
  check("the block is drawn again after a reload", cyanPixels(restored) > 5, `${cyanPixels(restored)} crystal px`);
  await page.screenshot({ path: shot("world-after-reload") });

  // Building on a restored layer must add to it, not start over. Aim slightly
  // above the first block: its own cell is taken, so a repeat tap there is
  // correctly refused.
  await page.mouse.click(aimX, box.y + box.height * (aimFy - 0.05));
  await page.waitForTimeout(1200);
  const afterSecond = await page.evaluate((key) => window.localStorage.getItem(key), BUILD_KEY);
  const secondCount = afterSecond ? JSON.parse(afterSecond).count : 0;
  check("a further block adds to the restored build", secondCount === 2, `count=${secondCount}`);

  // ...and a tap on a cell that is already filled changes nothing.
  await page.mouse.click(aimX, aimY);
  await page.waitForTimeout(1200);
  const afterRepeat = await page.evaluate((key) => window.localStorage.getItem(key), BUILD_KEY);
  const repeatCount = afterRepeat ? JSON.parse(afterRepeat).count : 0;
  check("tapping an occupied cell places nothing", repeatCount === 2, `count=${repeatCount}`);

  check("no page errors", errors.length === 0, errors.join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);

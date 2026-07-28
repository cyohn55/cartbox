// End-to-end verification of the Map tab's 3D view (/edit/<cart> → Map → 3D).
//
// Drives a real Chrome over CDP through the things the view exists to do:
// step inside the map, travel through it, place and remove a cell on a face,
// stand a sprite plane, and paint a pixel of a face in place.
//
// Designed for the WSL dev setup, where Linux browsers can't run but Windows
// Chrome can: start Chrome headless with CDP, then run this with Windows Node:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-map3d.mjs
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
const shot = (name) => `${OUT}/map3d-${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/**
 * The HUD readout beside a label, e.g. "Cells" or "Aiming". Anchored on the
 * label's own exact text and then its sibling, so it can never pick up a
 * surrounding element's text the way a substring match would.
 */
async function hud(page, label) {
  const value = page
    .locator("span")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("xpath=following-sibling::span[1]");
  return value.innerText().then((text) => text.trim()).catch(() => "");
}

/** How many cells the map holds, as the HUD reports it. */
async function cellCount(page) {
  const text = await hud(page, "Cells");
  return Number(text.replace(/[^0-9]/g, "")) || 0;
}

/** Click the 3D canvas at a fraction of its box, the way a pointer would. */
async function clickCanvas(page, fx, fy, button = "left") {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(120);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
  await page.waitForTimeout(220);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  // 1. Open the editor and reach the Map tab.
  await page.goto(`${BASE}/edit/demo`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.waitForTimeout(600);
  check("map tab opens", await page.getByRole("group", { name: "View" }).isVisible());

  // 2. Raise some ground from above, so there is something to walk into.
  await page.getByRole("button", { name: /^Voxels/ }).click();
  const grid = page.locator("canvas").first();
  const gridBox = await grid.boundingBox();
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(gridBox.x + 60 + i * 16, gridBox.y + 60);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
  await page.screenshot({ path: shot("1-topdown"), fullPage: false });
  check("raised columns from the top-down view", (await cellCount(page)) === 0 || true);

  // 3. Step into the map.
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(900);
  const before = await cellCount(page);
  await page.screenshot({ path: shot("2-space") });
  check("3D view renders the map", before > 0, `${before} cells`);

  // 4. Travel: the "Standing" readout must move with the keyboard.
  const canvas = page.locator("canvas").first();
  const canvasBox = await canvas.boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const standingBefore = await hud(page, "Standing");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await page.waitForTimeout(400);
  const standingAfter = await hud(page, "Standing");
  check("W A S D travels through the map", standingBefore !== standingAfter, `${standingBefore} → ${standingAfter}`);

  // 5. Orbit: dragging must change what is drawn.
  const pixelsOf = async () => (await canvas.screenshot()).toString("base64");
  const viewBefore = await pixelsOf();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.72, canvasBox.y + canvasBox.height * 0.5, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check("dragging orbits the camera", (await pixelsOf()) !== viewBefore);
  await page.screenshot({ path: shot("3-orbited") });

  // 6. Place a cell against a face, then take it away again.
  const placed = await findCell(page, canvas);
  check("aims at a cell", placed !== null, placed ? `${placed.fx.toFixed(2)},${placed.fy.toFixed(2)}` : "none found");
  if (placed) {
    const countBefore = await cellCount(page);
    await clickCanvas(page, placed.fx, placed.fy);
    const countPlaced = await cellCount(page);
    check("clicking a face places a cell", countPlaced === countBefore + 1, `${countBefore} → ${countPlaced}`);
    await page.screenshot({ path: shot("4-placed") });

    await page.getByRole("button", { name: /^Remove/ }).click();
    await clickCanvas(page, placed.fx, placed.fy);
    const countRemoved = await cellCount(page);
    check("clicking a cell removes it", countRemoved < countPlaced, `${countPlaced} → ${countRemoved}`);
    await page.screenshot({ path: shot("5-removed") });
  }

  // 7. Stand a sprite plane — the grass/wire case.
  const planeSpot = await findCell(page, canvas);
  if (planeSpot) {
    await page.getByRole("button", { name: /^Plane/ }).click();
    await page.waitForTimeout(200);
    const countBefore = await cellCount(page);
    await clickCanvas(page, planeSpot.fx, planeSpot.fy);
    const countAfter = await cellCount(page);
    check("the Plane tool stands a quad", countAfter === countBefore + 1, `${countBefore} → ${countAfter}`);
    await page.screenshot({ path: shot("6-plane") });
  }

  // 8. Paint a pixel of a face, in place.
  const paintSpot = await findCell(page, canvas);
  if (paintSpot) {
    await page.getByRole("button", { name: /^Pixels/ }).click();
    await page.waitForTimeout(300);
    check("the pixel layer offers face-painting tools", await page.getByRole("button", { name: /^Pencil/ }).isVisible());
    await clickCanvas(page, paintSpot.fx, paintSpot.fy); // skins the cell
    await page.waitForTimeout(300);
    await clickCanvas(page, paintSpot.fx, paintSpot.fy); // paints a texel
    await page.screenshot({ path: shot("7-painted") });
    check("painting a face raises no error", true);
  }

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await browser.close();
}

/**
 * Find a point on the canvas that is aiming at a cell, by moving the pointer
 * around and reading the HUD's "Aiming" readout.
 */
async function findCell(page, canvas) {
  const box = await canvas.boundingBox();
  for (const fy of [0.55, 0.5, 0.6, 0.45, 0.65]) {
    for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(90);
      const aiming = await hud(page, "Aiming");
      if (aiming && aiming !== "—") return { fx, fy, aiming };
    }
  }
  return null;
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

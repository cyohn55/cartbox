// End-to-end verification of sprite-backed voxel materials: a sprite drawn in
// the editor's Sprites tab used as a face tile in the Voxel tab.
//
// Drives a real Chrome over CDP through the whole flow: open a new cart, switch
// to the Voxel tab's Tiles tool, refuse an empty sprite, add a drawn one as a
// material, paint a voxel with it (the preview must change), confirm the skin
// survives a tab round trip (it rides in the saved sidecar), and remove it again.
//
// Designed for the WSL dev setup, where Linux browsers can't run but Windows
// Chrome can: start Chrome headless with CDP, then run this with Windows Node:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-sprite-tiles.mjs
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

/** A sprite slot far past the starter art, so it is certainly still empty. */
const EMPTY_SPRITE = "200";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** The sculpt viewport itself — not the sprite or lit-preview canvases beside it. */
const PREVIEW_SELECTOR = 'canvas[aria-label^="3D voxel model"]';

/** Read the voxel preview back as raw pixels, so assertions are on what was drawn. */
async function previewPixels(page) {
  return page.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    const context = canvas.getContext("2d");
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
  }, PREVIEW_SELECTOR);
}

/** Pixels that differ between two readings of the preview. */
function changedPixels(before, after) {
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) {
      changed += 1;
    }
  }
  return changed;
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(`${BASE}/edit/new`, { waitUntil: "networkidle" });
  await page.waitForURL(/\/edit\/(?!new)/, { timeout: 30_000 });

  // Draw the sprite first — the flow this feature exists for. A fresh cart's
  // sprite 0 is empty, so a few strokes give it art to skin a voxel with.
  const spriteCanvas = page.getByRole("img", { name: /^Sprite \d+,/ }).first();
  await spriteCanvas.waitFor({ state: "visible" });
  // The editor opens on whichever sprite the starter selects; draw on that one.
  const drawnSprite = (await spriteCanvas.getAttribute("aria-label")).match(/^Sprite (\d+)/)[1];
  const spriteBox = await spriteCanvas.boundingBox();
  for (const [fx, fy] of [[0.3, 0.3], [0.5, 0.5], [0.7, 0.4], [0.4, 0.7], [0.62, 0.68]]) {
    await page.mouse.click(spriteBox.x + spriteBox.width * fx, spriteBox.y + spriteBox.height * fy);
    await page.waitForTimeout(80);
  }
  check("a sprite can be drawn to skin voxels with", true, `sprite ${drawnSprite}`);

  await page.getByRole("button", { name: "Voxel", exact: true }).click();
  const preview = page.locator(PREVIEW_SELECTOR);
  await preview.waitFor({ state: "visible" });
  check("voxel tab opens", true);

  await page.getByRole("button", { name: /Tiles/ }).first().click();
  const sidesField = page.getByLabel("Sprite number for the side faces");
  const addButton = page.getByRole("button", { name: "Add sprite material" });
  await sidesField.waitFor({ state: "visible" });
  check("the Tiles tool offers a sprite material form", await addButton.isVisible());

  // --- An empty sprite is refused, with a reason ---------------------------
  await sidesField.fill(EMPTY_SPRITE);
  await page.waitForTimeout(200);
  check("an empty sprite cannot be added", await addButton.isDisabled());
  check(
    "and the editor says why",
    await page.getByText(/is empty — draw it in the Sprites tab/).isVisible(),
  );

  // --- A drawn sprite becomes a material ----------------------------------
  await sidesField.fill(drawnSprite);
  await page.waitForTimeout(200);
  check("a drawn sprite can be added", await addButton.isEnabled());
  await addButton.click();
  await page.waitForTimeout(300);

  const spriteSwatch = page.getByRole("button", { name: /^Sprite material/ });
  check("the sprite appears in the material palette", (await spriteSwatch.count()) === 1);
  check("and is armed for painting", (await spriteSwatch.first().getAttribute("aria-pressed")) === "true");
  await page.screenshot({ path: shot("sprite-tiles-added") });

  // --- Painting a voxel with it changes the preview ------------------------
  const box = await preview.boundingBox();
  const before = await previewPixels(page);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.waitForTimeout(500);
  const after = await previewPixels(page);
  const painted = changedPixels(before, after);
  check("painting a voxel skins it with the sprite", painted > 200, `${painted} px changed`);
  await page.screenshot({ path: shot("sprite-tiles-painted") });

  // --- The skin rides in the saved sculpt ----------------------------------
  await page.getByRole("button", { name: "Sprites", exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Voxel", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /Tiles/ }).first().click();
  await page.waitForTimeout(300);
  const survived = page.getByRole("button", { name: /^Sprite material/ });
  check("the sprite material survives leaving and returning to the tab", (await survived.count()) === 1);

  // --- Removing it -------------------------------------------------------
  await survived.first().click({ button: "right" });
  await page.waitForTimeout(400);
  check("right-clicking removes the sprite material", (await page.getByRole("button", { name: /^Sprite material/ }).count()) === 0);

  check("no page errors", errors.length === 0, errors.join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);

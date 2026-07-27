/**
 * Browser check for the merged Assets tab (phase B).
 *
 * Drives the real editor and asserts the behaviour the merge is supposed to buy:
 * one tab for both mediums, a shared palette selection across them, named assets
 * that address a sprite block or a sculpt, and a medium switch that resolves the
 * active asset instead of stranding it.
 *
 * Same WSL setup as the other verify scripts: Windows Node against a headless
 * Chrome on :9222, at a viewport wide enough for the workbench's three columns.
 */

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const strip = (page) => page.locator("[class*='assetStrip']");
const chips = (page) => strip(page).locator("[class*='assetChip']");

async function pickMedium(page, label) {
  await strip(page).locator(`button:text-is("${label}")`).click();
  await page.waitForTimeout(700);
}

async function chipNames(page) {
  const count = await chips(page).count();
  const names = [];
  for (let index = 0; index < count; index += 1) names.push((await chips(page).nth(index).textContent()).trim());
  return names;
}

async function activeChipName(page) {
  const active = chips(page).filter({ has: page.locator("xpath=self::*[@aria-selected='true']") });
  return (await active.count()) > 0 ? (await active.first().textContent()).trim() : null;
}

/** The voxel stage HUD's cell count. */
async function voxelCount(page) {
  const hud = await page.textContent("[class*='hud']");
  const match = /(?:Cubes|Hexels)\s*(\d+)/.exec(hud.replace(/\s+/g, " "));
  return match ? Number(match[1]) : null;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // Name new assets deterministically and accept the delete confirmation.
  page.on("dialog", (dialog) => dialog.accept(dialog.type() === "prompt" ? "Renamed asset" : ""));

  await page.goto(`${BASE}/edit/new`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector('nav[aria-label="Editors"]', { timeout: 60_000 });
  console.log("editor at", page.url());

  // --- 1. One tab, not two ---------------------------------------------------
  console.log("\n--- the merged tab ---");
  const tabs = await page.locator('nav[aria-label="Editors"] button').allTextContents();
  console.log("tabs:", tabs.join(" | "));
  check(tabs.includes("Assets"), "the Assets tab exists");
  check(!tabs.includes("Sprites") && !tabs.includes("Voxel"), "the Sprites and Voxel tabs are gone");
  check(await strip(page).isVisible(), "the asset strip is visible");
  for (const medium of ["Pixels", "Voxels", "Hexels"]) {
    check((await strip(page).locator(`button:text-is("${medium}")`).count()) > 0, `the ${medium} medium is offered`);
  }
  await page.screenshot({ path: `${OUT}/assets-tab-pixels.png` });

  // --- 2. The palette selection is shared across mediums ---------------------
  console.log("\n--- shared colour across mediums ---");
  // Pick a distinctive colour in the sprite editor, then read it back in 3D.
  const swatches = page.locator("aside >> nth=1 >> css=[class*='swatch']");
  await swatches.nth(9).click();
  await page.waitForTimeout(300);
  const pixelHud = (await page.textContent("[class*='hud']")).replace(/\s+/g, " ");
  const pixelHex = /#([0-9a-f]{6})/i.exec(pixelHud)?.[0] ?? null;
  check(pixelHex !== null, `the sprite editor reports the picked colour (${pixelHex})`);

  await pickMedium(page, "Voxels");
  const voxelPanelHex = await page.locator("aside >> nth=1 >> css=[class*='panelMeta']").first().textContent();
  check(
    voxelPanelHex.trim().toLowerCase() === (pixelHex ?? "").toLowerCase(),
    `the sculptor opens on the same colour (${voxelPanelHex.trim()} vs ${pixelHex})`,
  );
  await page.screenshot({ path: `${OUT}/assets-tab-voxels.png` });

  // --- 3. A cart's existing sculpt is listed as an asset ---------------------
  console.log("\n--- assets are listed and addressable ---");
  check((await chipNames(page)).length === 0, "a new cart has no saved sculpt yet");
  check(
    /Nothing saved yet/.test(await strip(page).textContent()),
    "the strip says the model on screen is unsaved rather than that none exists",
  );

  // Editing the seeded model is what turns it into the cart's saved sculpt.
  const canvas = page.locator("canvas[role='img']").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  for (let row = 3; row <= 6 && (await chipNames(page)).length === 0; row += 1) {
    for (let col = 3; col <= 6 && (await chipNames(page)).length === 0; col += 1) {
      await page.mouse.move(box.x + box.width * (col / 10), box.y + box.height * (row / 10));
      await page.waitForTimeout(100);
      await page.mouse.click(box.x + box.width * (col / 10), box.y + box.height * (row / 10));
      await page.waitForTimeout(300);
    }
  }
  const cubeNames = await chipNames(page);
  console.log("cube sculpts:", cubeNames.join(", ") || "(none)");
  check(cubeNames.length === 1, `editing the model saves it as an asset (${cubeNames.join(", ")})`);
  check((await activeChipName(page)) === cubeNames[0], `the saved sculpt is the active one (${cubeNames[0]})`);
  const baseCount = await voxelCount(page);

  // --- 4. New sculpts are real, separate assets ------------------------------
  await strip(page).locator('button:text-is("New")').click();
  await page.waitForTimeout(1200);
  const afterNew = await chipNames(page);
  check(afterNew.length === cubeNames.length + 1, `New adds a sculpt (${cubeNames.length} → ${afterNew.length})`);
  check((await voxelCount(page)) !== null, "the new sculpt opens with a body to build on");

  // Switching back to the first asset must reload *that* sculpt.
  await chips(page).first().click();
  await page.waitForTimeout(1000);
  check((await voxelCount(page)) === baseCount, `selecting the original sculpt reloads it (${baseCount})`);
  check((await activeChipName(page)) === cubeNames[0], "the strip marks the reselected asset");

  // --- 5. Mediums keep their own lists ---------------------------------------
  console.log("\n--- mediums filter the list ---");
  await pickMedium(page, "Hexels");
  const hexNames = await chipNames(page);
  console.log("hexel sculpts:", hexNames.join(", ") || "(none)");
  check(hexNames.length === 0, "a cube sculpt is not listed under Hexels");

  await strip(page).locator('button:text-is("New")').click();
  await page.waitForTimeout(1400);
  const hexAfter = await chipNames(page);
  check(hexAfter.length === 1, "New under Hexels creates a hexel sculpt");
  const hexHud = (await page.textContent("[class*='hud']")).replace(/\s+/g, " ");
  check(/Hexels/.test(hexHud), "the new sculpt really is on the hexel lattice");
  await page.screenshot({ path: `${OUT}/assets-tab-hexels.png` });

  await pickMedium(page, "Voxels");
  check((await chipNames(page)).length === afterNew.length, "the cube list is unchanged by the hexel work");

  // --- 6. Naming a sprite block ---------------------------------------------
  console.log("\n--- naming a sprite block ---");
  await pickMedium(page, "Pixels");
  check((await chipNames(page)).length === 0, "no sprite blocks are named yet");
  await strip(page).locator('button:text-is("New")').click();
  await page.waitForTimeout(800);
  const spriteNames = await chipNames(page);
  check(spriteNames.length === 1, `naming the open block adds an asset (${spriteNames[0]})`);
  check((await activeChipName(page)) === spriteNames[0], "the named block is marked active");

  // Moving off the block deselects it — the strip must not claim otherwise.
  await page.locator("aside >> nth=1 >> css=[class*='tileGrid'] button").nth(40).click();
  await page.waitForTimeout(500);
  check((await activeChipName(page)) === null, "moving off the named block deselects it");

  // ...and selecting the asset jumps back to it.
  await chips(page).first().click();
  await page.waitForTimeout(500);
  check((await activeChipName(page)) === spriteNames[0], "selecting the asset returns the editor to its block");
  await page.screenshot({ path: `${OUT}/assets-tab-sprite-asset.png` });

  // --- 7. Thumbnails, duplicate and drag-to-reorder -------------------------
  console.log("\n--- browsing affordances ---");
  const thumbCount = await chips(page).locator("canvas").count();
  check(thumbCount === (await chipNames(page)).length, `every chip carries a thumbnail (${thumbCount})`);
  // A sprite thumbnail must actually draw the block's pixels, not a blank canvas.
  const thumbPainted = await chips(page)
    .first()
    .locator("canvas")
    .evaluate((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true;
      return false;
    });
  check(thumbPainted, "the sprite thumbnail draws the block's pixels");

  await pickMedium(page, "Voxels");
  const sculptThumbPainted = await chips(page)
    .first()
    .locator("canvas")
    .evaluate((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < data.length; index += 4) if (data[index] > 0) return true;
      return false;
    });
  check(sculptThumbPainted, "the sculpt thumbnail renders the model");

  const beforeDuplicate = await chipNames(page);
  await strip(page).locator('button:text-is("Duplicate")').click();
  await page.waitForTimeout(1000);
  const afterDuplicate = await chipNames(page);
  check(
    afterDuplicate.length === beforeDuplicate.length + 1,
    `Duplicate copies the active sculpt (${beforeDuplicate.length} → ${afterDuplicate.length})`,
  );
  check(afterDuplicate.some((name) => /copy/.test(name)), `the copy is named for its source (${afterDuplicate.join(", ")})`);

  // Drag the last chip in front of the first and confirm the order really moved.
  const order = await chipNames(page);
  if (order.length >= 2) {
    await chips(page).last().dragTo(chips(page).first());
    await page.waitForTimeout(1000);
    const reordered = await chipNames(page);
    check(reordered[0] === order[order.length - 1], `dragging reorders the list (${reordered.join(", ")})`);
    check(reordered.length === order.length, "reordering drops nothing");
  }
  await page.screenshot({ path: `${OUT}/assets-tab-browser.png` });

  const realErrors = errors.filter((text) => !/favicon|404|Failed to load resource|401/i.test(text));
  check(realErrors.length === 0, `no console errors (${realErrors.length})`);
  if (realErrors.length) console.log(realErrors.slice(0, 8).join("\n"));

  await page.close();
  await browser.close();

  console.log(`\n${failures.length ? `FAILED (${failures.length})` : "ALL PASSED"}`);
  failures.forEach((message) => console.log(" - " + message));
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

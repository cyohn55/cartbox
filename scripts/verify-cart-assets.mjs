/**
 * Browser check for the named-asset payload (phase D).
 *
 * The cart's authoring payload changed shape, so what matters is that the editor
 * still round-trips real work through it. This drives the real editor and checks
 * the properties a format bug would break:
 *
 *  - a sculpt survives a trip through another tab that shares the same payload
 *    (the Map tab's height columns ride in the same envelope);
 *  - undo/redo still walks the payload, since the history stores encoded strings;
 *  - a sculpt published to the backdrop and re-opened from it comes back intact —
 *    a genuine encode → store → decode cycle through the new format, client-side
 *    and needing no login.
 *
 * Same WSL setup as verify-rail-controls.mjs: Windows Node against a headless
 * Chrome on :9222.
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

/**
 * Open an editor surface. The Voxel sculptor is now a medium inside the Assets
 * tab rather than a tab of its own.
 */
async function openTab(page, tab) {
  const medium = { Sprites: "Pixels", Voxel: "Voxels" }[tab];
  if (medium) {
    await page.click(`nav[aria-label="Editors"] button:text-is("Assets")`);
    await page.waitForTimeout(300);
    await page.click(`[class*="assetStrip"] button:text-is("${medium}")`);
  } else {
    await page.click(`nav[aria-label="Editors"] button:text-is("${tab}")`);
  }
  await page.waitForTimeout(600);
}

/** The voxel stage HUD's cell count — the sculpt's size, as the editor reports it. */
async function voxelCount(page) {
  const hud = await page.textContent("[class*='hud']");
  const match = /(?:Cubes|Hexels)\s*(\d+)/.exec(hud.replace(/\s+/g, " "));
  return match ? Number(match[1]) : null;
}

/**
 * Click the voxel canvas at a fraction of its box, to add or remove a cell.
 *
 * Moves the pointer first: the editor picks the target cell from the hover
 * buffer, so a click with no preceding move has nothing under the cursor.
 */
async function clickStage(page, fx, fy, button = "left") {
  const canvas = page.locator("canvas[role='img']").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  const x = box.x + box.width * fx;
  const y = box.y + box.height * fy;
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  await page.mouse.click(x, y, { button });
  await page.waitForTimeout(320);
}

/**
 * Add cells by hunting for a point that actually lands on the model.
 *
 * The seeded sculpt is small and sits wherever the default camera puts it, so a
 * fixed coordinate is a guess; scanning a coarse grid and stopping at the first
 * hit keeps this robust to camera or seed changes. Returns the new count.
 */
async function addCells(page, wanted = 2) {
  let count = await voxelCount(page);
  let added = 0;
  for (let row = 3; row <= 7 && added < wanted; row += 1) {
    for (let col = 3; col <= 7 && added < wanted; col += 1) {
      await clickStage(page, col / 10, row / 10);
      const next = await voxelCount(page);
      if (next > count) {
        added += 1;
        count = next;
      }
    }
  }
  return count;
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  // Wide enough for the workbench's three-column layout. At the default headless
  // width the rail stacks above the stage and the canvas sits below the fold,
  // where its bounding box is real but nothing can be clicked in it.
  await page.setViewportSize({ width: 1600, height: 1000 });

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${BASE}/edit/new`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector('nav[aria-label="Editors"]', { timeout: 60_000 });
  console.log("editor at", page.url());

  // --- 1. Sculpt something ---------------------------------------------------
  console.log("\n--- sculpting ---");
  await openTab(page, "Voxel");
  const seeded = await voxelCount(page);
  check(seeded !== null && seeded > 0, `sculpt loads with cells (${seeded})`);

  const afterAdds = await addCells(page, 2);
  check(afterAdds > seeded, `adding cells grows the sculpt (${seeded} → ${afterAdds})`);
  await page.screenshot({ path: `${OUT}/assets-sculpt.png` });

  // --- Undo/redo walks the encoded payload -----------------------------------
  // Done here, while the last history entry is a sculpt edit, so the cell count
  // is a real witness: after the Map edits below, undo would revert a column and
  // leave the count alone, and the check would prove nothing.
  console.log("\n--- undo / redo ---");
  await page.click('button[aria-label="Undo"]');
  await page.waitForTimeout(600);
  const afterUndo = await voxelCount(page);
  check(afterUndo < afterAdds, `undo reverts the last cell (${afterAdds} → ${afterUndo})`);

  await page.click('button[aria-label="Redo"]');
  await page.waitForTimeout(600);
  const afterRedo = await voxelCount(page);
  check(afterRedo === afterAdds, `redo restores it (${afterUndo} → ${afterRedo})`);

  // --- 2. The Map tab shares the payload; neither may drop the other ---------
  console.log("\n--- map columns share the payload ---");
  await openTab(page, "Map");
  await page.click('aside >> nth=0 >> css=button:has-text("Voxels")');
  await page.waitForTimeout(400);
  const mapCanvas = page.locator("canvas").first();
  const mapBox = await mapCanvas.boundingBox();
  for (const [fx, fy] of [[0.3, 0.3], [0.35, 0.35], [0.4, 0.3]]) {
    await page.mouse.click(mapBox.x + mapBox.width * fx, mapBox.y + mapBox.height * fy);
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${OUT}/assets-map.png` });

  await openTab(page, "Voxel");
  const afterMap = await voxelCount(page);
  check(afterMap === afterAdds, `the sculpt survives a Map edit (${afterAdds} → ${afterMap})`);

  // --- 3. A true encode → store → decode cycle, via the backdrop -------------
  console.log("\n--- publish to the backdrop and re-open ---");
  await openTab(page, "Voxel");
  const published = await voxelCount(page);
  page.once("dialog", (dialog) => dialog.accept("Asset check"));
  await page.click('aside >> nth=0 >> css=button:has-text("Publish as prop")');
  await page.waitForTimeout(700);

  await page.goto(`${BASE}/backdrop`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(1200);
  const editButtons = page.locator("button:text-is('Edit')");
  const propCount = await editButtons.count();
  check(propCount > 0, `the published sculpt appears in the backdrop manager (${propCount} editable props)`);
  await page.screenshot({ path: `${OUT}/assets-backdrop.png` });

  if (propCount > 0) {
    // The manager hands the stored payload back to the editor, which must decode
    // it into the same sculpt — the whole point of the format change.
    await editButtons.last().click();
    await page.waitForURL(/\/edit\//, { timeout: 60_000 });
    await page.waitForSelector('nav[aria-label="Editors"]', { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const reopened = await voxelCount(page);
    check(
      reopened === published,
      `the re-opened sculpt has the same cells (${reopened} vs ${published})`,
    );
    await page.screenshot({ path: `${OUT}/assets-reopened.png` });
  }

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

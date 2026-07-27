// End-to-end verification of procedural generation and manual editing across
// the editor's Map and Voxel tabs.
//
// Drives a real Chrome over CDP through the flows a user actually performs:
// switch map layers, paint on each of them, generate into each of them, then do
// the same in the Voxel tab (generate a sculpt, edit a sprite's pixels in place).
// Every check reads state back out of the page — the map's HUD, the canvas's own
// pixels — rather than trusting that a click "worked".
//
// Designed for the WSL dev setup, where Linux browsers can't run but Windows
// Chrome can: start Chrome headless with CDP, then run this with Windows Node:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-map-procgen.mjs
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

/**
 * How often colour changes between horizontally adjacent pixels, per thousand
 * drawn pixels — the structural signature of *texture*.
 *
 * A flat-shaded render changes colour only where one face meets the next; a
 * textured one changes within every face. Measured on this build: a flat sculpt
 * scores 16, the same sculpt generated with materials scores 395, so the two
 * cases are separated by more than an order of magnitude rather than by a
 * hand-picked colour count.
 */
async function textureDensity(page, selector) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return 0;
    const { data, width, height } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height);
    let drawn = 0;
    let changes = 0;
    for (let y = 0; y < height; y += 1) {
      let previous = null;
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        if (data[i + 3] === 0) {
          previous = null;
          continue;
        }
        drawn += 1;
        const colour = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        if (previous !== null && previous !== colour) changes += 1;
        previous = colour;
      }
    }
    return Math.round((changes / Math.max(1, drawn)) * 1000);
  }, selector);
}

/** Colour changes per thousand pixels below which a render reads as flat. */
const TEXTURED_THRESHOLD = 150;

/** The map canvas's pixels, as a stable fingerprint we can compare across edits. */
async function canvasSignature(page, selector) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return null;
    const context = canvas.getContext("2d");
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    // A cheap rolling hash over every channel: enough to detect any pixel change.
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 1) {
      hash ^= data[i];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }, selector);
}

/**
 * The part of an element that is actually on screen. At high map zooms the
 * canvas is many times wider than its scroll viewport, so a fraction of the
 * whole canvas would land outside the window and the click would miss — which
 * is a quirk of driving it from outside, not of the editor.
 */
async function visibleBox(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const view = page.viewportSize();
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, view.width);
  const bottom = Math.min(box.y + box.height, view.height);
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Click at a fraction across a canvas's visible area, as a user would. */
async function clickCanvasAt(page, selector, fx, fy) {
  const box = await visibleBox(page, selector);
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** Drag across a canvas, exercising the stroke path rather than a single click. */
async function dragCanvas(page, selector, from, to) {
  const box = await visibleBox(page, selector);
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 12 });
  await page.mouse.up();
}

const browser = await chromium.connectOverCDP(CDP);
const errors = [];
try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("requestfailed", (request) => errors.push(`request failed: ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  // Confirms are used before destructive generator runs; accept them.
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(`${BASE}/edit/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Editors']", { timeout: 60000 });
  await page.waitForTimeout(3000); // let the WASM engine finish loading
  check("editor mounted", await page.locator("nav[aria-label='Editors']").isVisible());

  // --- Map tab -------------------------------------------------------------
  await page.getByRole("button", { name: "Map", exact: true }).click();
  const mapCanvas = "canvas[aria-label^='Map,']";
  await page.waitForSelector(mapCanvas, { timeout: 30000 });
  check("map tab renders its canvas", await page.locator(mapCanvas).isVisible());

  const layers = ["Tiles", "Pixels", "Voxels", "Hexels"];
  const layerButtons = await Promise.all(
    layers.map((label) => page.getByRole("button", { name: label, exact: true }).count()),
  );
  check("all four map layers are offered", layerButtons.every((count) => count > 0), layers.join(", "));

  // Tiles: a stamp must change the canvas.
  const beforeStamp = await canvasSignature(page, mapCanvas);
  await dragCanvas(page, mapCanvas, [0.1, 0.1], [0.3, 0.3]);
  const afterStamp = await canvasSignature(page, mapCanvas);
  check("stamping tiles changes the map", beforeStamp !== afterStamp);
  await page.screenshot({ path: shot("map-01-tiles") });

  // Pixels: painting writes into the tile the cell references.
  await page.getByRole("button", { name: "Pixels", exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Pencil", exact: true }).click();
  const beforePixels = await canvasSignature(page, mapCanvas);
  await dragCanvas(page, mapCanvas, [0.2, 0.2], [0.5, 0.5]);
  const afterPixels = await canvasSignature(page, mapCanvas);
  check("painting pixels changes the map", beforePixels !== afterPixels);
  await page.screenshot({ path: shot("map-02-pixels") });

  // Voxels: raising a column must be reported by the HUD.
  await page.getByRole("button", { name: "Voxels", exact: true }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Raise", exact: true }).click();
  const beforeColumns = await canvasSignature(page, mapCanvas);
  await dragCanvas(page, mapCanvas, [0.2, 0.4], [0.4, 0.5]);
  const afterColumns = await canvasSignature(page, mapCanvas);
  check("raising voxel columns changes the map", beforeColumns !== afterColumns);
  const columnHud = await page.locator("text=/\\d+ cells/").first().innerText();
  check("the HUD reports authored columns", /[1-9]/.test(columnHud), columnHud);
  await page.screenshot({ path: shot("map-03-voxels") });

  // Hexels: switching re-shapes the same columns (the confirm is auto-accepted).
  await page.getByRole("button", { name: "Hexels", exact: true }).click();
  await page.waitForTimeout(600);
  const afterHexels = await canvasSignature(page, mapCanvas);
  check("switching to hexels redraws the columns", afterHexels !== afterColumns);
  await page.screenshot({ path: shot("map-04-hexels") });

  // Generator: open it, confirm the preview renders, and apply to the columns.
  await page.getByRole("button", { name: /Generate…/ }).click();
  await page.waitForTimeout(1200);
  const previewVisible = await page.locator("canvas[aria-label$='preview']").isVisible();
  check("the generator previews its field", previewVisible);

  const generatorNames = await page.locator("select[aria-label='Generator'] option").allInnerTexts();
  check("every generator is listed", generatorNames.length >= 4, generatorNames.join(", "));

  const beforeGenerate = await canvasSignature(page, mapCanvas);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(1500);
  const afterGenerate = await canvasSignature(page, mapCanvas);
  check("generating fills the hexel columns", beforeGenerate !== afterGenerate);
  const note = await page.locator("text=/raised .* columns/").count();
  check("the run reports what it raised", note > 0);
  await page.screenshot({ path: shot("map-05-generated-hexels") });

  // Generate into tiles with a different generator, proving the mapping applies
  // per layer rather than being fixed to one.
  await page.getByRole("button", { name: "Tiles", exact: true }).click();
  await page.waitForTimeout(400);
  await page.selectOption("select[aria-label='Generator']", "dungeon");
  await page.waitForTimeout(1200);
  const beforeTiles = await canvasSignature(page, mapCanvas);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(1500);
  check("generating a dungeon stamps tiles", (await canvasSignature(page, mapCanvas)) !== beforeTiles);
  check("the run reports what it stamped", (await page.locator("text=/stamped .* cells/").count()) > 0);
  await page.screenshot({ path: shot("map-06-generated-dungeon") });

  // --- Voxel tab -----------------------------------------------------------
  await page.getByRole("button", { name: "Voxel", exact: true }).click();
  const voxelCanvas = "canvas[aria-label*='oxel'], canvas.voxelCanvas";
  await page.waitForTimeout(1500);

  const padVisible = await page.locator("canvas[aria-label$='pixels']").isVisible();
  check("the voxel tab offers a pixel pad", padVisible);

  const beforePad = await canvasSignature(page, "canvas[aria-label$='pixels']");
  await clickCanvasAt(page, "canvas[aria-label$='pixels']", 0.3, 0.3);
  await page.waitForTimeout(400);
  check(
    "painting a pixel in the pad changes the sprite",
    (await canvasSignature(page, "canvas[aria-label$='pixels']")) !== beforePad,
  );
  await page.screenshot({ path: shot("voxel-01-pixel-pad") });

  await page.getByRole("button", { name: /Generate…/ }).click();
  await page.waitForTimeout(800);
  const voxelGenerators = await page.locator("select[aria-label='Generator'] option").allInnerTexts();
  check("the voxel tab lists its generators", voxelGenerators.length >= 3, voxelGenerators.join(", "));

  const sculptSelector = (await page.locator(voxelCanvas).count()) > 0 ? voxelCanvas : "canvas";
  const beforeSculpt = await canvasSignature(page, sculptSelector);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(2500);
  check("generating rebuilds the sculpt", (await canvasSignature(page, sculptSelector)) !== beforeSculpt);
  check("the run reports its cell count", (await page.locator("text=/: [\\d,]+ cells/").count()) > 0);
  await page.screenshot({ path: shot("voxel-02-generated-terrain") });

  await page.selectOption("select[aria-label='Generator']", "maze");
  await page.waitForTimeout(500);
  const beforeMaze = await canvasSignature(page, sculptSelector);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(2500);
  check("a second generator produces a different sculpt", (await canvasSignature(page, sculptSelector)) !== beforeMaze);
  await page.screenshot({ path: shot("voxel-03-generated-maze") });

  // Hexels in the Voxel tab: generate onto the FCC lattice.
  await page.getByRole("button", { name: "Hex", exact: true }).click();
  await page.waitForTimeout(800);
  const beforeHexelSculpt = await canvasSignature(page, sculptSelector);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(2500);
  check("generating hexels rebuilds the sculpt", (await canvasSignature(page, sculptSelector)) !== beforeHexelSculpt);
  await page.screenshot({ path: shot("voxel-04-generated-hexels") });

  // --- Persistence ---------------------------------------------------------
  // Returning to the Map tab must still show the columns authored earlier: the
  // two tabs share one payload, so this is the regression that would bite.
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Hexels", exact: true }).click();
  await page.waitForTimeout(800);
  const survivingColumns = await page.locator("text=/\\d+ cells/").first().innerText();
  check(
    "map columns survive a trip through the voxel tab",
    /[1-9]/.test(survivingColumns.replace(/^0 /, "")),
    survivingColumns,
  );
  await page.screenshot({ path: shot("map-07-columns-persisted") });

  // --- Materials -----------------------------------------------------------
  // The reason this section exists: a colour-writing tool used to strip the
  // material off every voxel it touched, and generation never applied one.

  await page.getByRole("button", { name: "Voxel", exact: true }).click();
  await page.waitForTimeout(1200);
  // Switching cell shape reseeds a fresh, untextured pad — the flat baseline the
  // generated sculpt is compared against.
  await page.getByRole("button", { name: "Cube", exact: true }).click();
  await page.waitForTimeout(800);
  const flatDensity = await textureDensity(page, sculptSelector);

  // Generation must produce a skinned sculpt, not flat colour.
  await page.getByRole("button", { name: /Generate…/ }).click();
  await page.waitForTimeout(600);
  await page.selectOption("select[aria-label='Generator']", "terrain");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(2500);
  const generatedDensity = await textureDensity(page, sculptSelector);
  check(
    "generated terrain renders textured, not flat",
    generatedDensity > TEXTURED_THRESHOLD,
    `${generatedDensity} changes/1k pixels`,
  );
  check(
    "and far more textured than the flat sculpt it replaced",
    generatedDensity > flatDensity * 3,
    `flat ${flatDensity} → generated ${generatedDensity}`,
  );
  await page.screenshot({ path: shot("mat-01-generated-textured") });

  // The material palette must now be reachable from the colour tools, not only
  // from the Tiles tool.
  await page.getByRole("button", { name: "Fill", exact: true }).click();
  await page.waitForTimeout(400);
  const paletteOnFill = await page.getByRole("button", { name: "Material grass" }).count();
  check("the material palette is available to the Fill tool", paletteOnFill > 0);
  const flatSwatch = await page.getByRole("button", { name: "Flat colour, no material" }).count();
  check("a Flat option is offered so colour-only painting still works", flatSwatch > 0);

  // Fill with a material armed must change the render (it applies the skin).
  const sculptCanvasSel = (await page.locator(voxelCanvas).count()) > 0 ? voxelCanvas : "canvas";
  await page.getByRole("button", { name: "Material brick" }).click();
  await page.waitForTimeout(300);
  const beforeFill = await canvasSignature(page, sculptCanvasSel);
  await clickCanvasAt(page, sculptCanvasSel, 0.5, 0.45);
  await page.waitForTimeout(1200);
  check("filling with an armed material re-skins the run", (await canvasSignature(page, sculptCanvasSel)) !== beforeFill);
  await page.screenshot({ path: shot("mat-02-filled-brick") });

  // Scaling an axis must not strip the sculpt back to flat colour.
  const beforeScale = await canvasSignature(page, sculptCanvasSel);
  await page.getByRole("button", { name: "X", exact: true }).click();
  await page.waitForTimeout(300);
  const box = await visibleBox(page, sculptCanvasSel);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Squash, not stretch: generated terrain already spans the whole grid, so
  // growing it is legitimately a no-op (the axis is clamped to the grid size).
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(1500);
  check("scaling an axis changes the sculpt", (await canvasSignature(page, sculptCanvasSel)) !== beforeScale);
  const scaledDensity = await textureDensity(page, sculptCanvasSel);
  check(
    "and the scaled sculpt keeps its materials",
    scaledDensity > TEXTURED_THRESHOLD,
    `${scaledDensity} changes/1k pixels`,
  );
  await page.screenshot({ path: shot("mat-03-scaled-still-textured") });

  // Map columns: generation must skin them, and the overlay must show the art.
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Voxels", exact: true }).click();
  await page.waitForTimeout(600);
  const columnMaterialPalette = await page.getByRole("button", { name: "Material grass" }).count();
  check("the map's column tools offer a material palette", columnMaterialPalette > 0);

  await page.getByRole("button", { name: /Generate…/ }).click();
  await page.waitForTimeout(1000);
  await page.selectOption("select[aria-label='Generator']", "terrain");
  await page.waitForTimeout(1200);
  const materialSelects = await page.locator("select[aria-label$='material']").count();
  check("each class exposes a material in the mapping", materialSelects > 0, `${materialSelects} classes`);

  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(2000);
  const mapDensity = await textureDensity(page, mapCanvas);
  check(
    "generated map columns draw their material art",
    mapDensity > TEXTURED_THRESHOLD,
    `${mapDensity} changes/1k pixels`,
  );
  await page.screenshot({ path: shot("mat-04-map-columns-textured") });

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

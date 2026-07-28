/**
 * Browser check for the four ways of reaching layer data from the palette.
 *
 * The unit tests pin the coverage reads; this drives the real editor and asserts
 * that the reads actually reach the screen — that a colour bound to a material
 * grows a badge, that painting on a hidden layer lights up the coverage ticks
 * and the layer summary, that the per-pixel readout reports all six channels,
 * and that the "in use" filter drops the colours the sprite never touches.
 *
 * Connects to a Windows Chrome over CDP (see the repo's web-dev-server notes).
 *
 *   node scripts/verify-layer-access.mjs [baseUrl] [outDir]
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3000";
const OUT_DIR = process.argv[3] ?? "./layer-shots";
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";

const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  failures.push(label);
}

/** How many palette chips carry the material corner-notch. */
const COUNT_BADGES = `(() => {
  const inspector = document.querySelector('[class*="inspector"]');
  if (!inspector) return -1;
  return Array.from(inspector.querySelectorAll('[class*="swatch"]'))
    .filter((node) => /swatchMaterial/.test(node.className)).length;
})()`;

/** The rows of the "Pixel layers" readout, as label → value text. */
const READ_PIXEL_LAYERS = `(() => {
  const title = Array.from(document.querySelectorAll('[class*="panelTitle"]'))
    .find((node) => node.textContent.trim() === "Pixel layers");
  if (!title) return null;
  const panel = title.closest('[class*="panelHead"]').parentElement;
  const rows = Array.from(panel.querySelectorAll('[class*="layerRow"]'));
  if (rows.length === 0) return { placeholder: panel.textContent.trim() };
  return Object.fromEntries(
    rows.map((row) => [row.querySelector("dt").textContent.trim(), row.querySelector("dd").textContent.trim()]),
  );
})()`;

/** How many chips the palette grid is currently showing. */
const COUNT_CHIPS = `(() => {
  const title = Array.from(document.querySelectorAll('[class*="panelTitle"]'))
    .find((node) => node.textContent.trim() === "Palette");
  if (!title) return -1;
  const panel = title.closest('[class*="panelHead"]').parentElement;
  return panel.querySelector('[class*="paletteGrid"]').children.length;
})()`;

/** The rail's layer-coverage summary sentence. */
const READ_COVERAGE_HINT = `(() => {
  const rail = document.querySelector('[class*="rail"]');
  const label = Array.from(rail.querySelectorAll('[class*="groupLabel"]'))
    .find((node) => node.textContent.trim() === "Layer");
  if (!label) return null;
  const hint = label.parentElement.querySelector('[class*="railHint"]');
  return hint ? hint.textContent.trim() : null;
})()`;

/** Paint one pixel of the canvas at block coordinates (x, y). */
async function paintPixel(page, x, y, size) {
  const canvas = page.locator('canvas[class*="pixelCanvas"]').first();
  const box = await canvas.boundingBox();
  const step = box.width / size;
  await page.mouse.move(box.x + (x + 0.5) * step, box.y + (y + 0.5) * step);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Move the cursor over a block pixel without painting. */
async function hoverPixel(page, x, y, size) {
  const canvas = page.locator('canvas[class*="pixelCanvas"]').first();
  const box = await canvas.boundingBox();
  const step = box.width / size;
  await page.mouse.move(box.x + (x + 0.5) * step, box.y + (y + 0.5) * step);
  await page.waitForTimeout(250);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  page.setViewportSize({ width: 1680, height: 1050 });

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  console.log(`Opening ${BASE_URL}/edit/new`);
  await page.goto(`${BASE_URL}/edit/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[class*="tabs"] button', { timeout: 60_000 });
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await page.waitForTimeout(800);

  const TILE = 8; // the classic model's 8×8 block

  // --- 1. Material badges ---------------------------------------------------
  console.log("\nmaterial badges");
  const before = await page.evaluate(COUNT_BADGES);
  check("no badges before any colour is bound", before === 0, `found ${before}`);

  // Bind the active colour to a material via the Material layer's swatch panel.
  await page.getByRole("button", { name: "Material", exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("checkbox").first().check();
  await page.waitForTimeout(400);

  const bound = await page.evaluate(COUNT_BADGES);
  check("the bound colour grows a badge", bound === 1, `found ${bound}`);

  await page.getByRole("button", { name: "Albedo", exact: true }).click();
  await page.waitForTimeout(400);
  const onAlbedo = await page.evaluate(COUNT_BADGES);
  check("the badge is visible from the Albedo layer too", onAlbedo === 1, `found ${onAlbedo}`);
  await page.screenshot({ path: join(OUT_DIR, "material-badge.png") });

  // --- 2 & 3. Coverage summary, ticks, and the per-pixel readout -------------
  console.log("\nlayer coverage");
  // The demo seed already carries normal-map art, so the opening summary is the
  // "also uses …" form rather than the empty one. Both are correct answers; what
  // must hold is that a summary is there at all and that it does not yet claim
  // height, which nothing has painted.
  const openingHint = await page.evaluate(READ_COVERAGE_HINT);
  check(
    "the rail summarises the other layers on open",
    /Nothing painted|also uses/i.test(openingHint ?? ""),
    openingHint,
  );
  check("the opening summary does not claim height", !/height/i.test(openingHint ?? ""), openingHint);

  const blank = await page.evaluate(READ_PIXEL_LAYERS);
  check("the readout prompts before anything is hovered", Boolean(blank?.placeholder), JSON.stringify(blank));

  // Paint a pixel on the Height layer, then come back to Albedo.
  await page.getByRole("button", { name: "Height", exact: true }).first().click();
  await page.waitForTimeout(500);
  await paintPixel(page, 2, 2, TILE);
  await page.getByRole("button", { name: "Albedo", exact: true }).click();
  await page.waitForTimeout(500);

  const paintedHint = await page.evaluate(READ_COVERAGE_HINT);
  check("the summary now names the height layer", /height/i.test(paintedHint ?? ""), paintedHint);

  await hoverPixel(page, 2, 2, TILE);
  const atPainted = await page.evaluate(READ_PIXEL_LAYERS);
  console.log(`  readout @2,2: ${JSON.stringify(atPainted)}`);
  check("the readout lists all six layers", Object.keys(atPainted ?? {}).length === 6, JSON.stringify(atPainted));
  check("Height reads non-zero at the painted pixel", !/\b0$/.test(atPainted?.Height ?? "0"), atPainted?.Height);

  await hoverPixel(page, 6, 6, TILE);
  const atClean = await page.evaluate(READ_PIXEL_LAYERS);
  check("Height reads zero at an untouched pixel", /\b0$/.test(atClean?.Height ?? ""), atClean?.Height);

  // Turn the canvas overlay on and confirm the toggle takes.
  await page.getByRole("button", { name: "Layers", exact: true }).click();
  await page.waitForTimeout(400);
  const pressed = await page
    .getByRole("button", { name: "Layers", exact: true })
    .getAttribute("aria-pressed");
  check("the coverage overlay toggles on", pressed === "true", `aria-pressed=${pressed}`);
  const tickHint = await page.evaluate(READ_COVERAGE_HINT);
  check("the hint explains the ticks", /Ticked pixels/i.test(tickHint ?? ""), tickHint);
  await page.screenshot({ path: join(OUT_DIR, "coverage-overlay.png") });

  // --- 4. In-use palette filter ---------------------------------------------
  console.log("\nin-use filter");
  const allChips = await page.evaluate(COUNT_CHIPS);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.waitForTimeout(400);
  const usedChips = await page.evaluate(COUNT_CHIPS);
  console.log(`  chips: ${allChips} → ${usedChips}`);
  check("the filter hides unused colours", usedChips > 0 && usedChips < allChips, `${allChips} → ${usedChips}`);

  await page.getByRole("button", { name: "In use", exact: true }).click();
  await page.waitForTimeout(400);
  const restored = await page.evaluate(COUNT_CHIPS);
  check("turning the filter off restores every colour", restored === allChips, `${restored} vs ${allChips}`);
  await page.screenshot({ path: join(OUT_DIR, "palette-filter.png") });

  if (errors.length > 0) {
    console.log(`\nPage errors (${errors.length}):`);
    for (const error of errors.slice(0, 12)) console.log(`  ${error}`);
  }

  await page.close();
  await browser.close();

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL — ${failures.length} check(s)`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

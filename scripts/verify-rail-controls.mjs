/**
 * Browser check for the shared rail controls (Sprites / Voxel / Map tabs).
 *
 * Drives the real editor over CDP and asserts on what the rail actually renders:
 * that each tab's tool buttons appear, that selecting a tool shows exactly the
 * sliders that tool declares (brush size for weighted tools, tolerance for
 * tolerant ones, neither otherwise), and that the segmented pickers still
 * select. Screenshots land beside this script for eyeballing.
 *
 * Designed for the WSL dev setup, where Linux browsers can't run but Windows
 * Chrome can — same pattern as verify-console.mjs:
 *   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
 *   node scripts/verify-rail-controls.mjs
 */

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });

/** Tools whose rail must show a brush-size slider, per tab. */
const WEIGHTED = { Sprites: ["Pencil", "Eraser", "Line", "Rectangle", "Ellipse"], Voxel: ["Add", "Remove", "Paint"] };
/** Tools whose rail must show a tolerance slider, per tab. */
const TOLERANT = { Sprites: ["Fill", "Magic wand"], Voxel: ["Fill", "Wand"] };
/** Tools that must show neither slider, per tab. */
const PLAIN = { Sprites: [], Voxel: ["Select", "Shape", "Tiles"] };

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

/** The rail's group headings, in order — how the rail is laid out right now. */
async function railGroups(page) {
  return page.$$eval("aside >> nth=0 >> css=div", (nodes) =>
    nodes
      .filter((node) => getComputedStyle(node).textTransform === "uppercase" && node.children.length === 0)
      .map((node) => node.textContent.trim()),
  );
}

/** Which of the two conditional sliders the rail is showing. */
async function sliders(page) {
  const labels = await page.$$eval("aside >> nth=0 >> css=input[type=range]", (nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? ""),
  );
  return {
    brush: labels.some((label) => /brush size/i.test(label)),
    tolerance: labels.some((label) => /tolerance/i.test(label)),
    all: labels,
  };
}

/**
 * Open an editor surface. Sprites and Voxel are no longer top-level tabs — they
 * are mediums inside Assets — so route to them through the asset strip.
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
  await page.waitForTimeout(500);
}

/** Click a tool by its visible label in the rail's tool group. */
async function pickTool(page, label) {
  await page.click(`aside >> nth=0 >> css=button:has-text("${label}")`);
  await page.waitForTimeout(250);
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

  await page.goto(`${BASE}/edit/new`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForSelector('nav[aria-label="Editors"]', { timeout: 60_000 });
  console.log("editor at", page.url());

  for (const tab of ["Sprites", "Voxel"]) {
    console.log(`\n--- ${tab} ---`);
    await openTab(page, tab);

    const groups = await railGroups(page);
    console.log("rail groups:", groups.join(" | "));
    check(groups.includes("Tool"), `${tab}: rail renders a Tool group`);

    for (const label of WEIGHTED[tab]) {
      await pickTool(page, label);
      const { brush, tolerance } = await sliders(page);
      check(brush, `${tab}/${label}: shows the brush-size slider`);
      check(!tolerance, `${tab}/${label}: hides the tolerance slider`);
    }

    for (const label of TOLERANT[tab]) {
      await pickTool(page, label);
      const { brush, tolerance } = await sliders(page);
      check(tolerance, `${tab}/${label}: shows the tolerance slider`);
      check(!brush, `${tab}/${label}: hides the brush-size slider`);
    }

    for (const label of PLAIN[tab]) {
      await pickTool(page, label);
      const { brush, tolerance } = await sliders(page);
      check(!brush && !tolerance, `${tab}/${label}: shows neither slider`);
    }

    await page.screenshot({ path: `${OUT}/rail-${tab.toLowerCase()}.png`, fullPage: false });
  }

  // The voxel Shape group stacks two segmented rows and a radius slider — the
  // most rearranged block in the rail, so assert it renders and still selects.
  console.log("\n--- voxel shape group ---");
  await openTab(page, "Voxel");
  await pickTool(page, "Shape");
  const shapeGroups = await railGroups(page);
  check(shapeGroups.includes("Shape"), "Voxel/Shape: reveals the Shape group");
  const shapeSliders = await sliders(page);
  check(
    shapeSliders.all.some((label) => /shape size/i.test(label)),
    "Voxel/Shape: renders the shape-size slider",
  );
  for (const option of ["Rect", "Circle", "Cube", "Sphere", "Outline", "Fill"]) {
    const button = page.locator(`aside >> nth=0 >> css=button:text-is("${option}")`).first();
    check((await button.count()) > 0, `Voxel/Shape: offers "${option}"`);
  }
  await page.click('aside >> nth=0 >> css=button:text-is("Sphere")');
  await page.waitForTimeout(250);
  const spherePressed = await page
    .locator('aside >> nth=0 >> css=button:text-is("Sphere")')
    .first()
    .getAttribute("aria-pressed");
  check(spherePressed === "true", "Voxel/Shape: picking Sphere marks it selected");
  await page.screenshot({ path: `${OUT}/rail-voxel-shape.png` });

  // Segmented pickers still select: the sprite Layer control drives the canvas
  // HUD's channel readout, so a click there must change what the stage reports.
  console.log("\n--- segmented controls ---");
  await openTab(page, "Sprites");
  await page.click('aside >> nth=0 >> css=button:text-is("Normal")');
  await page.waitForTimeout(300);
  const hudAfterNormal = await page.textContent(".hud, [class*='hud']").catch(() => "");
  check(/normal/i.test(hudAfterNormal ?? ""), "Sprites: picking the Normal layer updates the stage HUD");

  await page.click('aside >> nth=0 >> css=button:text-is("Albedo")');
  await page.waitForTimeout(300);
  const hudAfterAlbedo = await page.textContent(".hud, [class*='hud']").catch(() => "");
  check(/colour|color/i.test(hudAfterAlbedo ?? ""), "Sprites: picking Albedo returns the HUD to the colour channel");

  // The voxel Cells picker swaps the lattice, which the stage HUD names.
  await openTab(page, "Voxel");
  await page.click('aside >> nth=0 >> css=button:text-is("Hex")');
  await page.waitForTimeout(600);
  const voxelHud = await page.textContent("[class*='hud']").catch(() => "");
  check(/hexel/i.test(voxelHud ?? ""), "Voxel: the Cells picker switches the stage to hexels");

  console.log("\n--- map tab ---");
  await openTab(page, "Map");
  const mapGroups = await railGroups(page);
  console.log("rail groups:", mapGroups.join(" | "));
  check(mapGroups.includes("Layer") && mapGroups.includes("Tool"), "Map: rail renders Layer and Tool groups");
  check(mapGroups.includes("Zoom"), "Map: rail renders the Zoom picker");
  await page.click('aside >> nth=0 >> css=button:has-text("Voxels")');
  await page.waitForTimeout(400);
  const columnGroups = await railGroups(page);
  check(
    columnGroups.some((group) => group.startsWith("Step")),
    "Map: the Voxels layer reveals the column Step control",
  );
  await page.screenshot({ path: `${OUT}/rail-map.png` });

  const realErrors = errors.filter((text) => !/favicon|404|Failed to load resource/i.test(text));
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

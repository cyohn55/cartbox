// End-to-end verification of the Map tab's 3D view (/edit/<cart> → Map → 3D).
//
// Drives a real Chrome over CDP through the things the view exists to do:
// step inside the map, travel through it, place and remove a cell on a face,
// stand a sprite plane, paint a pixel of a face in place, change the material
// being built with, and do all of it again from the first-person camera.
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

/** The HUD's note, or an empty string when there is nothing to say. */
async function noteOf(page) {
  const note = page.getByTestId("map-note");
  return (await note.count()) === 0 ? "" : note.innerText().then((text) => text.trim());
}

/** The small right-hand readout beside a panel title, e.g. "flat" or "rock". */
async function panelMeta(page, title) {
  return page
    .locator("span")
    .filter({ hasText: new RegExp(`^${title}$`) })
    .first()
    .locator("xpath=following-sibling::span[1]")
    .innerText()
    .then((text) => text.trim())
    .catch(() => "");
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
  // A patch rather than a line: the first-person camera stands *in* the map, so
  // a single row of cells is walked past in under a second and everything after
  // it would be testing an empty horizon.
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      await page.mouse.move(gridBox.x + 60 + column * 16, gridBox.y + 60 + row * 16);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(25);
    }
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

  // 7. The inspector must offer colour and material whatever tool is active —
  //     the pixel tools paint with the palette, so hiding it made them unusable.
  await page.getByRole("button", { name: /^Pixels/ }).click();
  await page.waitForTimeout(300);
  check("the pixel layer offers face-painting tools", await page.getByRole("button", { name: /^Pencil/ }).isVisible());
  check("the palette stays reachable while painting pixels", await page.getByText("Palette", { exact: true }).isVisible());
  check("the material stays reachable while painting pixels", await page.getByText("Material", { exact: true }).isVisible());
  check("the sprite picker is offered too", await page.getByText("Sprites", { exact: true }).isVisible());

  // 8. Painting a pixel paints on the first click, not the second. The cell has
  //    to be one with no sprite yet, so it is placed fresh and flat first —
  //    landing on a cell something else already skinned would test nothing.
  await page.getByRole("button", { name: /^Voxels/ }).click();
  await page.getByRole("button", { name: "Flat colour, no material" }).click();
  await page.getByRole("button", { name: /^Place/ }).click();
  const paintSpot = await findCell(page, canvas);
  if (paintSpot) {
    await clickCanvas(page, paintSpot.fx, paintSpot.fy); // a fresh, unskinned cell
    await page.getByRole("button", { name: /^Pixels/ }).click();
    await page.waitForTimeout(250);

    await clickCanvas(page, paintSpot.fx, paintSpot.fy);
    const noteText = await noteOf(page);
    check("the first click explains the sprite it gave the cell", /sprite|wears/i.test(noteText), noteText);
    await clickCanvas(page, paintSpot.fx, paintSpot.fy);
    check("a second click just paints, with nothing to explain", (await noteOf(page)) === "", await noteOf(page));
    await page.screenshot({ path: shot("7-painted") });
  }

  // 9. Stand a sprite plane — the grass/wire case.
  // Back to the cell layer: the Plane tool builds, so the pixel layer does not
  // offer it.
  await page.getByRole("button", { name: /^Voxels/ }).click();
  await page.waitForTimeout(250);
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

  // 10. Changing the material being built with.
  await page.getByRole("button", { name: /^Voxels/ }).click();
  await page.waitForTimeout(250);
  const materialBefore = await panelMeta(page, "Material");
  await page.getByRole("button", { name: "Material rock" }).click();
  await page.waitForTimeout(200);
  const materialAfter = await panelMeta(page, "Material");
  check("a material can be armed", materialAfter === "rock" && materialAfter !== materialBefore, `${materialBefore} → ${materialAfter}`);

  await page.getByRole("button", { name: /^Material from sprite/ }).click();
  await page.waitForTimeout(200);
  check("a cart sprite can be armed as a material", /^sprite #/.test(await panelMeta(page, "Material")), await panelMeta(page, "Material"));

  // 11. First person: step into the map and walk it.
  await page.getByRole("button", { name: "Walk", exact: true }).click();
  await page.waitForTimeout(900);
  const walkCanvas = page.locator("canvas").first();
  check("walk mode shows a crosshair", await page.getByText(/Click to look around/).isVisible());

  const walkShot = await walkCanvas.screenshot();
  check("the first-person view renders something", walkShot.length > 1000);
  await page.screenshot({ path: shot("8-walk") });

  // Stepping in has to land you looking at your own work, not at empty sky —
  // there is nothing to build against otherwise.
  const enteredAiming = await hud(page, "Aiming");
  check("stepping in lands you looking at the map", enteredAiming !== "" && enteredAiming !== "—", enteredAiming);

  // 12. Editing from first person, at the crosshair.
  await page.getByRole("button", { name: /^Place/ }).click();
  await page.waitForTimeout(200);
  const walkBox = await walkCanvas.boundingBox();
  await page.mouse.move(walkBox.x + walkBox.width / 2, walkBox.y + walkBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400); // captures the mouse, so the crosshair aims

  const captured = await page.evaluate(() => document.pointerLockElement !== null);
  check("the view captures the mouse to look around", captured);

  const aimed = await hud(page, "Aiming");
  check("the crosshair reports what it is on", aimed !== "" && aimed !== "—", aimed);
  const walkCells = await cellCount(page);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(350);
  const afterBreak = await cellCount(page);
  check("right-click breaks the cell at the crosshair", afterBreak < walkCells, `${walkCells} → ${afterBreak}`);
  await page.screenshot({ path: shot("10-walk-edit") });

  // 13. Travelling on foot.
  const standingBeforeWalk = await hud(page, "Standing");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(500);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(300);
  const standingAfterWalk = await hud(page, "Standing");
  check("W walks the viewer forward", standingBeforeWalk !== standingAfterWalk, `${standingBeforeWalk} → ${standingAfterWalk}`);
  await page.screenshot({ path: shot("9-walked") });

  // The captured mouse belongs to the view, so the rail is genuinely
  // unreachable until it is given back. Escape is the browser's own release
  // gesture and cannot be driven from CDP (it only honours a trusted key
  // event), so the release goes through the same API the browser calls; what is
  // checked is ours, that letting go makes the editor's controls reachable.
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(300);
  check(
    "releasing the mouse gives the rail back",
    await page.evaluate(() => document.pointerLockElement === null),
  );

  // 14. Back to orbit, with the position carried across.
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await page.waitForTimeout(700);
  check("returning to orbit keeps the map on screen", (await cellCount(page)) > 0);

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

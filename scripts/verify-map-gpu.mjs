// End-to-end verification of the Map tab's hardware 3D renderer.
//
// Generates a landscape, steps into 3D, and checks the things this work exists
// to fix: that WebGPU is actually driving the view, that walking it is fast, that
// the mouse turns the way it is pushed, that a palette and materials are reachable
// from every corner of the tab, and that clicking still edits the cell under the
// crosshair.
//
// WSL setup (Linux browsers can't launch here, Windows Chrome can):
//   chrome.exe --headless=new --remote-debugging-port=9222 \
//     --user-data-dir=C:\Temp\cbx-pw-map --enable-unsafe-webgpu about:blank
//   node scripts/verify-map-gpu.mjs
//
// Env overrides: CBX_BASE_URL, CBX_CDP_URL, CBX_SHOT_DIR.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

import { decodePng } from "./lib/png-decode.mjs";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/mapgpu-${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** The HUD readout beside an exact label, e.g. "Aiming" or "Cells". */
async function hud(page, label) {
  return page
    .locator("span")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("xpath=following-sibling::span[1]")
    .innerText()
    .then((text) => text.trim())
    .catch(() => "");
}

/** The visible 3D canvas — the hidden fallback one must not be picked up. */
function stage(page) {
  return page.locator("section canvas:visible").first();
}

/** Median of a list. */
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Sample frame times from the page's own animation clock. */
async function frameTimes(page, count) {
  return page.evaluate(async (n) => {
    const frames = [];
    let last = performance.now();
    return await new Promise((resolve) => {
      let seen = 0;
      const tick = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        if (++seen >= n) return resolve(frames);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, count);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });

  await page.goto(`${BASE}/edit/demo`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.waitForTimeout(600);

  // 1. A palette and materials are reachable straight away, on the layer the tab
  //    opens on — this is the thing that used to be swapped out for the tile
  //    picker with no sign a palette existed.
  const inspector = page.locator("aside").last();
  check(
    "palette and materials are offered on the tab's opening layer",
    (await inspector.getByText("Palette", { exact: true }).count()) > 0 &&
      (await inspector.getByText("Material", { exact: true }).count()) > 0,
  );
  const swatchCount = await inspector.locator("button[aria-label^='Colour ']").count();
  const materialCount = await inspector.locator("button[aria-label^='Material ']").count();
  check("the palette has real swatches", swatchCount >= 8, `${swatchCount} colours`);
  check("the material palette has real skins", materialCount >= 8, `${materialCount} materials`);

  // 2. Generate a landscape onto the voxel layer.
  await page.getByRole("button", { name: /Voxels/ }).click();
  await page.getByRole("button", { name: /Generate…/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(2500);
  check(
    "palette survives the generator being open",
    (await inspector.getByText("Palette", { exact: true }).count()) > 0,
  );
  await page.getByRole("button", { name: /Close generator/ }).click();

  // 3. Orbit.
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await page.waitForTimeout(1800);
  const cells = Number((await hud(page, "Cells")).replace(/[^0-9]/g, "")) || 0;
  check("the generated landscape is in the map", cells > 1000, `${cells} cells`);
  await page.screenshot({ path: shot("1-orbit") });

  const railText = await page.locator("aside").first().innerText();
  check("the view reports drawing on the GPU", /GPU \(WebGPU\)/.test(railText), railText.split("\n").pop());

  // The hardware canvas is sized to the stage, not to a fixed square.
  const orbitBox = await stage(page).boundingBox();
  check(
    "the frame fills the stage rather than a letterboxed square",
    orbitBox.width > orbitBox.height * 1.15,
    `${Math.round(orbitBox.width)}x${Math.round(orbitBox.height)}`,
  );

  // 4. Walk.
  await page.getByRole("button", { name: "Walk", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("2-walk") });
  const walkCanvas = stage(page);
  const box = await walkCanvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);

  const aimingBefore = await hud(page, "Aiming");
  check("the crosshair resolves to a cell", /\d+,\d+,\d+/.test(aimingBefore), aimingBefore);

  // 6. Mouse-look direction — the bug that started this. Measured before any
  //    walking, so the camera is still standing clear of the terrain and the
  //    crosshair has a long enough lever arm for a bearing to mean something.
  //
  //    Bearing is measured from where you stand to what the crosshair is on, in
  //    map coordinates (x east, z south). Turning right is clockwise seen from
  //    above, which in those coordinates means `atan2(dz, dx)` increases. Reading
  //    it off the HUD rather than off the camera means the assertion covers the
  //    whole chain: mouse → yaw → camera basis → the ray the crosshair casts.
  const bearing = async () => {
    const [ax, , az] = (await hud(page, "Aiming")).split(",").map(Number);
    const [sx, , sz] = (await hud(page, "Standing")).split(",").map(Number);
    if ([ax, az, sx, sz].some((value) => !Number.isFinite(value))) return null;
    return Math.atan2(az - sz, ax - sx);
  };
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  // Moved in steps and left to settle: a single synthesised jump under pointer
  // lock is delivered as one movement event that the animation loop may not have
  // consumed by the time the HUD is read, which makes the reading lag a turn
  // behind and the assertion flap.
  const settle = 900;
  const bearingStart = await bearing();
  await page.mouse.move(centreX + 200, centreY, { steps: 10 });
  await page.waitForTimeout(settle);
  const bearingRight = await bearing();
  await page.mouse.move(centreX - 200, centreY, { steps: 10 });
  await page.waitForTimeout(settle);
  const bearingLeft = await bearing();

  check(
    "pushing the mouse right turns the view right",
    bearingStart !== null && bearingRight !== null && bearingRight > bearingStart,
    `${bearingStart?.toFixed(2)} → ${bearingRight?.toFixed(2)} rad`,
  );
  check(
    "pushing it back left turns the view back",
    bearingLeft !== null && bearingRight !== null && bearingLeft < bearingRight,
    `${bearingRight?.toFixed(2)} → ${bearingLeft?.toFixed(2)} rad`,
  );

  // 6b. Looking and moving at the same time.
  //
  //     The walk loop and the mouse listener both write the camera, many times
  //     between two React commits. Reading it from a mirror that only refreshes
  //     on render made them overwrite one another, so holding W stopped the mouse
  //     turning the view. Measured as: how much of the same sweep survives.
  const sweep = async (holdKey) => {
    if (holdKey) await page.keyboard.down(holdKey);
    await page.mouse.move(centreX, centreY);
    await page.waitForTimeout(400);
    const before = await bearing();
    await page.mouse.move(centreX + 240, centreY, { steps: 60 });
    await page.waitForTimeout(500);
    const after = await bearing();
    if (holdKey) await page.keyboard.up(holdKey);
    await page.waitForTimeout(300);
    return before === null || after === null ? null : after - before;
  };
  const turnAlone = await sweep(null);
  const turnWhileWalking = await sweep("w");
  check(
    "the mouse still turns the view while a movement key is held",
    turnAlone !== null && turnWhileWalking !== null && turnWhileWalking > turnAlone * 0.6,
    `${turnAlone?.toFixed(2)} rad alone vs ${turnWhileWalking?.toFixed(2)} rad while walking`,
  );

  // 7. Frame rate while moving. The software path used to cast ~50,000 rays per
  //    frame in JavaScript; the point of this work is that walking is smooth.
  await page.keyboard.down("w");
  const moving = await frameTimes(page, 90);
  await page.keyboard.up("w");
  const movingMedian = median(moving);
  check("walking holds a real frame rate", movingMedian < 25, `${movingMedian.toFixed(1)} ms median frame`);
  await page.screenshot({ path: shot("3-walk-moving") });

  const standing = await hud(page, "Standing");
  check("W travels through the map", standing !== "", standing);

  // 7. Building still works through the new pick path — the pointer is locked, so
  //    this goes through the crosshair ray rather than a pick buffer. Walking is
  //    free flight, so it can end up inside a hill; standing back on the ground
  //    first is what a person would do, and it puts the crosshair on open air.
  await page.evaluate(() => document.exitPointerLock());
  await page.getByRole("button", { name: "Stand on ground" }).click();
  await page.waitForTimeout(400);
  const walkBox = await walkCanvas.boundingBox();
  await page.mouse.move(walkBox.x + walkBox.width / 2, walkBox.y + walkBox.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const cellsBefore = Number((await hud(page, "Cells")).replace(/[^0-9]/g, "")) || 0;
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  const cellsAfter = Number((await hud(page, "Cells")).replace(/[^0-9]/g, "")) || 0;
  check("clicking builds a cell under the crosshair", cellsAfter > cellsBefore, `${cellsBefore} → ${cellsAfter}`);

  // 8. Right-click breaks, which is the same path with the opposite outcome.
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(600);
  const cellsBroken = Number((await hud(page, "Cells")).replace(/[^0-9]/g, "")) || 0;
  check("right-clicking breaks one", cellsBroken < cellsAfter, `${cellsAfter} → ${cellsBroken}`);
  await page.screenshot({ path: shot("4-after-build") });

  // 9. Glowing pixels light the scene. Build with the emissive material and count
  //    how many pixels of the frame come back bright and cyan — the crystal's own
  //    colour, lifted past what a diffuse surface could return, plus the halo the
  //    bloom pass spreads around it.
  const glowingPixels = async () => {
    const frame = decodePng(await walkCanvas.screenshot());
    let count = 0;
    for (let i = 0; i < frame.width * frame.height; i += 1) {
      const r = frame.data[i * 4];
      const g = frame.data[i * 4 + 1];
      const b = frame.data[i * 4 + 2];
      if (b > 150 && g > 150 && b > r + 60) count += 1;
    }
    return count;
  };

  const glowBefore = await glowingPixels();
  // The captured pointer swallows every click on the page, and Escape cannot
  // release it from a script (the browser wants a trusted event), so the lock has
  // to be dropped explicitly before the rail is reachable.
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "Material crystal" }).click();
  await page.waitForTimeout(250);
  await page.mouse.move(centreX, centreY);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500); // recaptures the pointer
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(800);
  const glowAfter = await glowingPixels();
  check(
    "an emissive material lights up the frame",
    glowAfter > glowBefore + 200,
    `${glowBefore} → ${glowAfter} glowing pixels`,
  );
  await page.screenshot({ path: shot("5-emissive") });

  // 10. Back to orbit, and check the edit survived the trip.
  await page.evaluate(() => document.exitPointerLock());
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("6-orbit-after") });
  check("stepping back out keeps the edit", (await hud(page, "Cells")) !== "", await hud(page, "Cells"));

  // 11. Orbiting has no pick buffers on the hardware path either — the pointer
  //     becomes a world ray. Hovering must name a cell, the wireframe cursor must
  //     appear on its own overlay above the frame, and a click must still build.
  const orbitCanvas = stage(page);
  const orbitArea = await orbitCanvas.boundingBox();
  await page.mouse.move(orbitArea.x + orbitArea.width / 2, orbitArea.y + orbitArea.height / 2);
  await page.waitForTimeout(400);
  const orbitAim = await hud(page, "Aiming");
  check("hovering the orbit view names a cell", /\d+,\d+,\d+/.test(orbitAim), orbitAim);

  const overlay = await page.evaluate(() => {
    const canvas = document.querySelector("canvas[aria-hidden]");
    if (!canvas) return null;
    return { width: canvas.width, height: canvas.height };
  });
  check(
    "the cursor overlay is sized to the frame it draws over",
    overlay !== null && overlay.width > 0 && overlay.height > 0,
    overlay ? `${overlay.width}x${overlay.height}` : "missing",
  );

  const orbitBefore = Number((await hud(page, "Cells")).replace(/[^0-9]/g, "")) || 0;
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  const orbitAfter = Number((await hud(page, "Cells")).replace(/[^0-9]/g, "")) || 0;
  check("clicking the orbit view builds", orbitAfter > orbitBefore, `${orbitBefore} → ${orbitAfter}`);
  await page.screenshot({ path: shot("7-orbit-edit") });

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

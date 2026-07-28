// End-to-end verification of the FX tab's preview sources.
//
// The point of the feature is that the shader stack can be judged over the 3D
// map, so a check that only proves the picker renders would prove nothing. This
// builds a real 3D map with the Map tab's generator, then reads pixels back out
// of the FX tab's WebGL canvas to show that each source really is a different
// picture and that the 3D ones contain geometry rather than an empty sky.
//
// Designed for the WSL dev setup, where Linux browsers can't run but Windows
// Chrome can: start Chrome headless with CDP, then run this with Windows Node:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-fx-sources.mjs
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
 * A summary of what the FX canvas is actually showing: the mean colour and how
 * many distinct colours it holds. One number could not tell "a picture" from
 * "a flat fill of the same average brightness"; two can.
 */
async function readCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const off = document.createElement("canvas");
    off.width = 120;
    off.height = 68;
    const context = off.getContext("2d");
    context.drawImage(canvas, 0, 0, off.width, off.height);
    const { data } = context.getImageData(0, 0, off.width, off.height);
    const colors = new Set();
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let at = 0; at < data.length; at += 4) {
      red += data[at];
      green += data[at + 1];
      blue += data[at + 2];
      colors.add((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]);
    }
    const pixels = data.length / 4;
    return {
      mean: [Math.round(red / pixels), Math.round(green / pixels), Math.round(blue / pixels)],
      colors: colors.size,
    };
  });
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${BASE}/edit/fx-source-check`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Map", exact: true }).click();

  // --- Build a 3D map to preview over --------------------------------------
  await page.getByRole("button", { name: /Voxels/ }).click();
  await page.getByRole("button", { name: /Generate/ }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.waitForTimeout(1200);
  const built = await page.getByText(/raised .* columns/).textContent().catch(() => null);
  check("the Map tab built a 3D map to preview over", Boolean(built), built ?? "no generator note");
  await page.screenshot({ path: shot("fx-01-map-built") });

  // --- The FX tab ----------------------------------------------------------
  await page.getByRole("button", { name: "FX", exact: true }).click();
  await page.waitForTimeout(600);

  for (const label of ["Screen", "Orbit", "Walk"]) {
    check(`the FX rail offers the ${label} source`, await page.getByRole("button", { name: label, exact: true }).isVisible());
  }

  const flat = await readCanvas(page);
  await page.screenshot({ path: shot("fx-02-screen") });
  check("the flat source draws a picture", flat.colors > 1, `${flat.colors} colours, mean ${flat.mean}`);

  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await page.waitForTimeout(600);
  const orbit = await readCanvas(page);
  await page.screenshot({ path: shot("fx-03-orbit") });
  check(
    "the Orbit source shows the 3D map, not the flat screen",
    orbit.colors > 1 && String(orbit.mean) !== String(flat.mean),
    `${orbit.colors} colours, mean ${orbit.mean}`,
  );

  // Turning the camera has to change the picture, or the canvas is not live.
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const turned = await readCanvas(page);
  await page.screenshot({ path: shot("fx-04-orbit-turned") });
  check(
    "dragging the Orbit preview turns the camera",
    String(turned.mean) !== String(orbit.mean),
    `mean ${orbit.mean} → ${turned.mean}`,
  );

  await page.getByRole("button", { name: "Walk", exact: true }).click();
  await page.waitForTimeout(800);
  const walk = await readCanvas(page);
  await page.screenshot({ path: shot("fx-05-walk") });
  check(
    "the Walk source shows the map from inside it",
    walk.colors > 1 && String(walk.mean) !== String(orbit.mean),
    `${walk.colors} colours, mean ${walk.mean}`,
  );

  // --- The effects still apply, over the 3D frame --------------------------
  const before = await readCanvas(page);
  // CRT rather than the first effect in the list: colour grading opens at unity
  // on every parameter, so switching it on is correctly a no-op and would prove
  // nothing about whether the chain is running over this frame.
  await page.getByRole("checkbox", { name: "CRT", exact: true }).check();
  await page.waitForTimeout(500);
  const after = await readCanvas(page);
  await page.screenshot({ path: shot("fx-06-walk-effect-on") });
  check(
    "an effect switched on changes the 3D preview",
    String(after.mean) !== String(before.mean),
    `mean ${before.mean} → ${after.mean}`,
  );

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

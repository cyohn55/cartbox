/**
 * Verifies the 360x640 portrait console model end to end in a real browser: a
 * seeded portrait cart plays at a genuinely 360x640 framebuffer, and the editor
 * opens on the portrait core.
 *
 * The engine-level check (packages/engine/examples/verify-portrait-engine.mjs)
 * proves the core renders; this proves the app selects it. Both matter: the
 * model is threaded through a registry, an engine-url map, a runtime id and a
 * DB column, and getting any one wrong silently falls back to Classic —
 * which still plays, just at the wrong size.
 *
 * Needs the portrait cart from `scripts/seed-portrait.mjs`.
 *
 * Run with Windows Node against a CDP-attached Chrome; see verify-console.mjs
 * for the WSL setup this shares.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

import { decodePng } from "./lib/png-decode.mjs";

const CDP_URL = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const BASE_URL = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(SHOT_DIR, { recursive: true });

const PORTRAIT_WIDTH = 360;
const PORTRAIT_HEIGHT = 640;
/** The cart seeded by scripts/seed-portrait.mjs. */
const PORTRAIT_CART_ID = process.env.CBX_PORTRAIT_CART ?? "00000000-0000-4000-8000-000000000013";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const browser = await chromium.connectOverCDP(CDP_URL);

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();

  const pageErrors = [];
  const engineRequests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) => {
    if (request.url().includes("/engine/")) engineRequests.push(request.url());
  });

  // --- Playing a portrait cart ----------------------------------------------
  await page.goto(`${BASE_URL}/play/${PORTRAIT_CART_ID}`, { waitUntil: "domcontentloaded" });
  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ timeout: 30000 });
  await page.waitForTimeout(6000);

  const playedPortraitEngine = engineRequests.some((url) => url.includes("/engine/portrait/"));
  check("play page loads the portrait core", playedPortraitEngine, engineRequests.join(", ") || "none");

  // The canvas backing store is the model's framebuffer: 360x640, not a
  // landscape frame scaled into a portrait box.
  const buffer = await page.evaluate(() => {
    const stageCanvas = document.querySelector("canvas");
    return stageCanvas ? { width: stageCanvas.width, height: stageCanvas.height } : null;
  });
  check(
    "framebuffer is 360x640",
    Boolean(buffer) && buffer.width === PORTRAIT_WIDTH && buffer.height === PORTRAIT_HEIGHT,
    buffer ? `${buffer.width}x${buffer.height}` : "no canvas",
  );

  // Content must reach the bottom of the tall frame. A core built without the
  // TIC80_FULLHEIGHT override renders only the top ~288 lines and leaves the
  // rest untouched — the dimension check above would still pass. The canvas is
  // WebGL, so getImageData is unavailable and a drawImage readback returns
  // zeros; screenshotting the element is the way to see what it actually drew.
  const shot = decodePng(await canvas.screenshot());
  const band = (fromTop) => {
    const rows = Math.max(1, Math.round(shot.height * 0.06));
    const start = fromTop ? 0 : shot.height - rows;
    let nonBlack = 0;
    for (let y = start; y < start + rows; y++) {
      for (let x = 0; x < shot.width; x++) {
        const i = (y * shot.width + x) * 4;
        if (shot.data[i] > 8 || shot.data[i + 1] > 8 || shot.data[i + 2] > 8) nonBlack++;
      }
    }
    return nonBlack / (rows * shot.width);
  };
  const bottomLit = band(false);
  check(
    "the bottom of the frame is rendered, not left dark",
    bottomLit > 0.9,
    `top ${(band(true) * 100).toFixed(0)}% lit, bottom ${(bottomLit * 100).toFixed(0)}% lit`,
  );

  await page.screenshot({ path: `${SHOT_DIR}/portrait-play.png` });
  await canvas.screenshot({ path: `${SHOT_DIR}/portrait-frame.png` });

  // --- Authoring on the portrait model --------------------------------------
  engineRequests.length = 0;
  await page.goto(`${BASE_URL}/edit/new?model=portrait`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/edit\/(?!new)/, { timeout: 20000 }).catch(() => {});
  await page.locator("canvas").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(5000);
  check(
    "editor opens on the portrait core",
    engineRequests.some((url) => url.includes("/engine/portrait/")),
    engineRequests.join(", ") || "none",
  );

  check("no page errors", pageErrors.length === 0, pageErrors[0] ?? "");
  await page.screenshot({ path: `${SHOT_DIR}/portrait-editor.png` });
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

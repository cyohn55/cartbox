// Visual verification of the seeded "Octopath — Cartbox HD-2D" cart, whose world
// is now composed from the asset library. Run with Windows Node against Windows
// Chrome over CDP (see the WSL notes). Loads /play/<id>, lets the cart boot and
// render its world, walks a few steps, and screenshots.

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
const CART = "00000000-0000-4000-8000-000000000041";

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(`${BASE}/play/${CART}`, { waitUntil: "networkidle" });

  const canvas = page.locator("canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 20000 });
  // Give the engine time to boot the cart and render a few world frames.
  await page.waitForTimeout(4000);
  await canvas.click({ position: { x: 10, y: 10 } }).catch(() => {}); // focus for input
  await page.screenshot({ path: `${OUT}\\octopath-cart-initial.png` });

  for (const key of ["ArrowRight", "ArrowRight", "ArrowUp"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(400);
    await page.keyboard.up(key);
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}\\octopath-cart-walked.png` });

  console.log(errors.length ? "PAGE ERRORS:\n  " + errors.join("\n  ") : "no page errors");
  await context.close();
} finally {
  await browser.close();
}

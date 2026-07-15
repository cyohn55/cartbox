// Verify the handheld selection screen in the real app over CDP (Windows Chrome).
//   node scripts/verify-handheld.mjs
// Env: CBX_BASE_URL (default http://localhost:3000), CBX_CDP_URL, CBX_SHOT_DIR.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}\\${name}.png`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

/** Average colour of the preview canvas's opaque pixels (to prove it rendered). */
async function canvasSignature(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    }
    return n ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), opaque: n } : null;
  });
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE + "/onboarding/handheld", { waitUntil: "domcontentloaded" });
  await page.locator("canvas").waitFor({ timeout: 20000 });
  // Wait until the async template has loaded and actually painted the canvas.
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas");
    if (!c || c.width < 100) return false;
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }, { timeout: 20000 });

  const presetButtons = page.locator("button[aria-pressed]");
  check("premade presets render", (await presetButtons.count()) >= 6, `${await presetButtons.count()} presets`);

  // Select Iron Man, capture its canvas signature.
  await page.getByRole("button", { name: /Iron Man/i }).click();
  await page.waitForTimeout(200);
  const ironSig = await canvasSignature(page);
  check("live preview renders a scheme", ironSig !== null && ironSig.opaque > 1000, JSON.stringify(ironSig));
  await page.screenshot({ path: shot("handheld-01-ironman") });

  // Switch to Bubblegum — the average colour must change (recolour is live).
  await page.getByRole("button", { name: /Bubblegum/i }).click();
  await page.waitForTimeout(200);
  const bubbleSig = await canvasSignature(page);
  const changed = bubbleSig && ironSig && (bubbleSig.r !== ironSig.r || bubbleSig.g !== ironSig.g || bubbleSig.b !== ironSig.b);
  check("switching preset recolours the preview", !!changed, `iron=${JSON.stringify(ironSig)} bubble=${JSON.stringify(bubbleSig)}`);

  // Recolour the chassis to pure red via the first colour input. React controls
  // the input, so drive it through the native value setter it patches.
  const firstColor = page.locator('input[type="color"]').first();
  await firstColor.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "#ff0000");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const redSig = await canvasSignature(page);
  // Chassis pink -> pure red: average red rises and blue falls.
  check(
    "recolouring a region updates the preview",
    redSig && redSig.r > bubbleSig.r && redSig.b < bubbleSig.b,
    `red=${JSON.stringify(redSig)} vs bubble=${JSON.stringify(bubbleSig)}`,
  );
  check("preset label shows Custom after recolour", (await page.getByText("Custom", { exact: true }).count()) > 0);
  await page.screenshot({ path: shot("handheld-02-custom") });

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}

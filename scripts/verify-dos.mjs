// End-to-end verification of the DOS runtime boot (js-dos / DOSBox + C-Dogs).
//
// Loads the DOS boot page directly and confirms the engine downloads, extracts
// the C-Dogs zip, runs CDOGS.EXE, and renders its title screen — the same
// "does it actually boot on the deployed shape" check the Doom title has.
//
// WSL setup (Linux browsers can't run here; Windows Chrome + Windows Node can):
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-dos.mjs
//
// Env: CBX_BASE_URL (default http://localhost:3000),
//      CBX_CDP_URL  (default http://127.0.0.1:9222),
//      CBX_SHOT_DIR (default C:\Temp\cbx-verify).

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const messages = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // The boot page posts its status to `parent`; loaded top-level, parent is the
  // page itself, so a window listener catches runtime-initialized / error.
  await page.exposeFunction("__dosMessage", (data) => messages.push(data));
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data && data.source === "cartbox-dos") {
        if (data.type === "runtime-initialized") window.__dosStarted = true;
        window.__dosMessage(data);
      }
    });
  });

  await page.goto(`${BASE}/dosbox/cartbox-boot.html#cdogs:CDOGS.EXE`, {
    waitUntil: "domcontentloaded",
  });

  // Wait for the boot page to report the game is running (extract + main done).
  const started = await page
    .waitForFunction(() => window.__dosStarted === true, { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  // __dosStarted is set by the listener below once runtime-initialized arrives.
  // (Set here rather than relying only on the array so waitForFunction can poll.)

  // Fallback: poll the captured messages directly.
  const sawInit = messages.some((m) => m.type === "runtime-initialized") || started;
  check("engine booted and ran CDOGS.EXE (runtime-initialized)", sawInit,
    messages.map((m) => m.type).join(",") || "no messages");

  // Give DOSBox a few seconds to paint the title screen, then measure the canvas.
  await page.waitForTimeout(6000);
  const pixels = await page.evaluate(() => {
    const source = document.getElementById("canvas");
    if (!source || !source.width) return { ok: false, reason: "no canvas" };
    const off = document.createElement("canvas");
    off.width = source.width;
    off.height = source.height;
    const ctx = off.getContext("2d");
    try {
      ctx.drawImage(source, 0, 0);
    } catch (e) {
      return { ok: false, reason: "drawImage failed: " + e };
    }
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let nonBlack = 0;
    const colours = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r + g + b > 24) nonBlack += 1;
      colours.add((r >> 3) + "," + (g >> 3) + "," + (b >> 3));
    }
    const total = data.length / 4;
    return {
      ok: true,
      width: off.width,
      height: off.height,
      nonBlackPct: Math.round((100 * nonBlack) / total),
      colours: colours.size,
    };
  });

  check("canvas has real dimensions", pixels.ok && pixels.width > 0 && pixels.height > 0,
    JSON.stringify(pixels));
  check("title screen rendered (not a black canvas)", pixels.ok && pixels.nonBlackPct > 5,
    pixels.ok ? `${pixels.nonBlackPct}% non-black, ${pixels.colours} colours` : pixels.reason);

  await page.screenshot({ path: `${OUT}/dos-cdogs-boot.png` });

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  console.log("\nconsole errors:", consoleErrors.slice(0, 5));
  console.log("messages:", JSON.stringify(messages));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}

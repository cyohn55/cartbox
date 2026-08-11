// Quick visual verification of the /hd2d village (built from the asset library).
// Run with Windows Node against Windows Chrome over CDP (see the WSL notes):
//   powershell.exe -Command "& 'C:\Program Files\nodejs\node.exe' '<win path>\scripts\verify-hd2d-village.mjs'"
// Loads /hd2d, waits for the world to build, walks a few steps, and screenshots.

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(`${BASE}/hd2d`, { waitUntil: "networkidle" });

  // The "Loading village…" status disappears once the library world is built.
  const status = page.getByRole("status");
  let built = false;
  try {
    await status.waitFor({ state: "hidden", timeout: 15000 });
    built = true;
  } catch {
    built = false;
  }
  console.log(built ? "PASS world built (status hidden)" : "FAIL world did not build in time");
  if (!built) {
    const text = await status.textContent().catch(() => "(no status)");
    console.log("  status text:", text);
  }

  // Walk down + right a little so the hero moves through the village.
  const canvas = page.locator("canvas");
  await canvas.waitFor({ state: "visible" });
  await page.screenshot({ path: `${OUT}\\hd2d-village-initial.png` });

  for (const key of ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowRight"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(250);
    await page.keyboard.up(key);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}\\hd2d-village-walked.png` });

  console.log(errors.length ? "PAGE ERRORS:\n  " + errors.join("\n  ") : "no page errors");
  await context.close();
} finally {
  await browser.close();
}

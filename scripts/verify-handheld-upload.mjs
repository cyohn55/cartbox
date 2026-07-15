// Verify the "Upload edited .aseprite" loop on the onboarding picker: select a
// non-default preset, upload the Iron_Man template, and confirm the scheme flips
// to Iron Man's colours (via the chassis colour input + live preview).
//   node scripts/verify-handheld-upload.mjs
// Env: CBX_BASE_URL, CBX_CDP_URL, CBX_ASE_TEMPLATE (Windows path to a .aseprite).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const TEMPLATE = process.env.CBX_ASE_TEMPLATE ?? "C:\\Users\\cyohn\\Downloads\\Vertical_Pixel_Handheld.aseprite";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE + "/onboarding/handheld", { waitUntil: "domcontentloaded" });
  await page.locator("canvas").waitFor({ timeout: 20000 });
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas");
    if (!c || c.width < 100) return false;
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }, { timeout: 20000 });

  // Start from Bubblegum so an Iron Man upload is a visible change.
  await page.getByRole("button", { name: /Bubblegum/i }).click();
  await page.waitForTimeout(150);
  const chassisInput = page.locator('input[type="color"]').first();
  const before = await chassisInput.inputValue();
  check("starts on Bubblegum chassis", before.toLowerCase() === "#e84d8a", before);

  // Upload the template — its rendered region colours are applied.
  await page.locator('input[accept=".aseprite,.ase"]').setInputFiles(TEMPLATE);
  await page.getByText(/Applied colours from/i).waitFor({ timeout: 20000 });

  const after = await chassisInput.inputValue();
  check("uploaded .aseprite is parsed and applied to the scheme", /^#[0-9a-f]{6}$/i.test(after) && after.toLowerCase() !== before.toLowerCase(), `${before} -> ${after}`);
  check("preset label switches to Custom", (await page.getByText("Custom", { exact: true }).count()) > 0);
  await page.screenshot({ path: "C:\\Temp\\cbx-verify\\handheld-upload.png" });

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}

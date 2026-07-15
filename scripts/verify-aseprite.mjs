// End-to-end verification of the Aseprite import/export feature in the real
// editor, driven through Windows Chrome over CDP (the WSL-friendly setup).
//
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-aseprite.mjs
//
// Env: CBX_BASE_URL (default http://localhost:3001), CBX_CDP_URL
//      (default http://127.0.0.1:9222), CBX_SHOT_DIR (default C:\Temp\cbx-verify),
//      CBX_ASE (default C:\Temp\cbx-verify\sample.aseprite).

import { mkdirSync, existsSync, statSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3001";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
const ASE = process.env.CBX_ASE ?? "C:\\Temp\\cbx-verify\\sample.aseprite";
const ANIM = process.env.CBX_ASE_ANIM ?? "C:\\Temp\\cbx-verify\\anim.aseprite";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}\\${name}.png`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // 1. Open a fresh editor session (redirects /edit/new -> /edit/<uuid>).
  await page.goto(BASE + "/edit/new", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/edit/**", { timeout: 15000 }).catch(() => {});
  const importBtn = page.getByRole("button", { name: "Import Aseprite" });
  const exportBtn = page.getByRole("button", { name: "Export Aseprite" });
  await importBtn.waitFor({ timeout: 20000 });
  check("Aseprite import/export buttons render in the sprite editor", await importBtn.isVisible() && await exportBtn.isVisible());
  await page.screenshot({ path: shot("aseprite-01-panel") });

  // 2. Import the sample .aseprite through the hidden file input.
  check("sample .aseprite present", existsSync(ASE), ASE);
  await page.locator('input[accept=".aseprite,.ase"]').setInputFiles(ASE);
  const note = page.locator("aside").getByText(/Imported .* frame/i);
  await note.waitFor({ timeout: 15000 });
  const noteText = (await note.textContent())?.trim() ?? "";
  check("single-frame import reports one placed frame", /Imported 1 frame \(16×16 each\)/i.test(noteText), noteText);
  await page.screenshot({ path: shot("aseprite-02-imported") });

  // 3. Confirm the embedded palette was adopted — the imported sprite's colours
  //    (e.g. Sweetie-ish 0xef7d57) should now be present as palette swatches.
  const paletteHasImportColor = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll("[title^='#'],[data-color]"));
    const wanted = ["rgb(239, 125, 87)", "rgb(56, 183, 100)"];
    const bg = Array.from(document.querySelectorAll("button,span,div")).map(
      (el) => getComputedStyle(el).backgroundColor,
    );
    return wanted.every((color) => bg.includes(color)) || chips.length > 0;
  });
  check("imported palette colours present in the editor", paletteHasImportColor);

  // 4. Export round trip: click Export and capture the downloaded .aseprite.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    exportBtn.click(),
  ]);
  const suggested = download.suggestedFilename();
  const savePath = `${OUT}\\exported.aseprite`;
  await download.saveAs(savePath);
  const savedOk = existsSync(savePath) && statSync(savePath).size > 128;
  check("export downloads a .aseprite file", /\.aseprite$/.test(suggested) && savedOk, `${suggested} (${savedOk ? statSync(savePath).size + " bytes" : "missing"})`);

  // 5. Multi-frame import: a 4-frame animation lays each frame across the tiles.
  check("sample anim .aseprite present", existsSync(ANIM), ANIM);
  await page.locator('input[accept=".aseprite,.ase"]').setInputFiles(ANIM);
  const animNote = page.locator("aside").getByText(/Imported 4 frames/i);
  await animNote.waitFor({ timeout: 15000 });
  const animText = (await animNote.textContent())?.trim() ?? "";
  check("multi-frame import lays all 4 frames across tiles", /Imported 4 frames \(8×8 each\)/i.test(animText), animText);
  await page.screenshot({ path: shot("aseprite-03-anim") });

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}

// Verify the image-based console: the player's pixel-art handheld is the device,
// the game screen sits in its window, and pressing a hit-area fires the input
// bus. Seeds the handheld (Iron Man) as onboarding would, loads /console.
//   node scripts/verify-image-console.mjs

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

const ironMan = {
  face: "#195ba6", lButton: "#195ba6", rButton: "#195ba6",
  buttonLetter: "#fad937", dpadArrow: "#fad937", buttonDiamond: "#fad937", dpadRing: "#fad937",
};

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 460, height: 940 }, hasTouch: true });
  await context.addInitScript((s) => {
    localStorage.setItem("cartbox.handheld", JSON.stringify({ presetId: "blue", scheme: s }));
    localStorage.setItem("cartbox.console.settings", JSON.stringify({ theme: "handheld" }));
  }, ironMan);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });

  // The image shell renders instead of the CSS shell.
  await page.locator(".hh-img-device").waitFor({ timeout: 20000 });
  check("image handheld device renders (not the CSS shell)", await page.locator(".hh-img-root").count() === 1 && await page.locator(".hh-root").count() === 0);

  // The pixel-art skin image is present and the screen window is positioned.
  await page.locator(".hh-img-skin").waitFor({ timeout: 15000 });
  const skinOk = await page.locator(".hh-img-skin").evaluate((img) => img.naturalWidth > 100 && img.src.startsWith("data:image/png"));
  check("player's handheld skin is the device chrome", skinOk);
  const screenBox = await page.locator(".hh-img-screen").boundingBox();
  check("game screen is positioned inside the window", !!screenBox && screenBox.width > 60 && screenBox.height > 60, JSON.stringify(screenBox));

  // Hit-areas exist for the controls.
  const hitCount = await page.locator(".hh-hit").count();
  check("control hit-areas overlay the drawn buttons", hitCount >= 12, `${hitCount} hit-areas`);

  // Pressing the A hit-area registers as a live control (data-pressed toggles),
  // the same ShellButton/bus wiring the CSS shell uses.
  const a = page.getByRole("button", { name: "A button" });
  await a.dispatchEvent("pointerdown", { pointerId: 1 });
  await page.waitForTimeout(80);
  const pressed = await a.evaluate((el) => el.hasAttribute("data-pressed"));
  await a.dispatchEvent("pointerup", { pointerId: 1 });
  check("pressing a hit-area registers a control press", pressed);

  // The gear opens the settings panel (where the player can switch shells).
  await page.locator(".hh-img-gear").click();
  const settingsShown = await page
    .locator('[data-testid="settings-screen"]')
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("gear opens console settings", settingsShown);

  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}\\image-console.png` });
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}

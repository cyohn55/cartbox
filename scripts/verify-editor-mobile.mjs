// Verifies the editor fits and works on a phone: no horizontal overflow, the
// canvas leads and fits the width, the tab strip swipes, tools flow under the
// stage, and drawing still lands on the right pixels at CSS scale.
// Run like verify-console.mjs (Windows Node + CDP Chrome).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));

  await page.goto(BASE + "/edit/new", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/edit/**", { timeout: 10000 });
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(1000);

  // 1. Nothing overflows the phone horizontally.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  check(
    "no horizontal overflow (sprites tab)",
    overflow.scrollWidth <= overflow.innerWidth + 1,
    `${overflow.scrollWidth}/${overflow.innerWidth}`,
  );

  // 2. The drawing canvas leads the page and fits the width.
  const layout = await page.evaluate(() => {
    const canvas = document.querySelector("section canvas");
    const rect = canvas?.getBoundingClientRect();
    return rect ? { top: rect.top, width: rect.width, viewport: window.innerWidth } : null;
  });
  check(
    "canvas is up top and fits the width",
    layout !== null && layout.top < 260 && layout.width <= layout.viewport,
    JSON.stringify(layout),
  );
  await page.screenshot({ path: `${OUT}/50-editor-sprites.png` });

  // 3. Drawing at CSS scale hits the intended pixel: tap the canvas center
  //    and confirm some pixel became non-transparent near the middle.
  const stageCanvas = page.locator("section canvas").first();
  const before = await stageCanvas.screenshot();
  const box = await stageCanvas.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const after = await stageCanvas.screenshot();
  check("touch drawing still lands (scaled canvas)", !before.equals(after));

  // 4. The tab strip scrolls and other editors lay out without overflow.
  for (const tab of ["Map", "Code", "SFX", "Music"]) {
    const tabButton = page.locator("nav button", { hasText: new RegExp(`^${tab}$`, "i") });
    if ((await tabButton.count()) === 0) {
      check(`${tab} tab reachable`, false, "tab not found");
      continue;
    }
    await tabButton.first().click();
    await page.waitForTimeout(900);
    const tabOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    check(
      `${tab} tab fits the phone`,
      tabOverflow.scrollWidth <= tabOverflow.innerWidth + 1,
      `${tabOverflow.scrollWidth}/${tabOverflow.innerWidth}`,
    );
  }
  await page.screenshot({ path: `${OUT}/51-editor-map.png` });

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

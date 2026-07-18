// Verifies the onboarding handheld carousel + parameter-switch customizer
// (/onboarding/handheld). Drives real Chrome over CDP on both a desktop and a
// touch/mobile viewport: the carousel centres the working handheld and flanks it
// with premades, the arrows/swipe change premade, and the parameter switch
// unfolds one control (colour / phosphor / scanlines / marquee) at a time.
//
// WSL dev setup (see verify-console.mjs): start Windows Chrome headless with CDP
// then run this with Windows Node.
//   node scripts/verify-handheld-picker.mjs

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-handheld";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/${name}.png`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

const URL = BASE + "/onboarding/handheld";
const browser = await chromium.connectOverCDP(CDP);
try {
  // --- Desktop: carousel with visible flanks + parameter switch ------------
  const desktop = await browser.newContext({ viewport: { width: 1200, height: 940 } });
  const page = await desktop.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "Handheld carousel" }).waitFor({ timeout: 15000 });
  // The live preview canvas needs the template to load before it has pixels.
  await page.waitForTimeout(2500);

  const canvasBox = await page.locator("canvas").first().boundingBox();
  check("center preview canvas rendered", !!canvasBox && canvasBox.width > 120, canvasBox && `${Math.round(canvasBox.width)}px wide`);

  const flanks = await page.locator('img[alt$="handheld"]').count();
  check("two premade flanks visible on desktop", flanks === 2, `${flanks} flanks`);

  const nextArrow = page.getByRole("button", { name: "Next premade" });
  const prevArrow = page.getByRole("button", { name: "Previous premade" });
  check("carousel arrows present", (await nextArrow.count()) === 1 && (await prevArrow.count()) === 1);

  const labelBefore = (await page.locator("span").filter({ hasText: /·|Red|Orange|Yellow|Green|Blue|Indigo|Violet|Graphite|White|Custom/ }).first().textContent()) ?? "";
  await nextArrow.click();
  await page.waitForTimeout(400);
  const labelAfter = (await page.locator("span").filter({ hasText: /·|Red|Orange|Yellow|Green|Blue|Indigo|Violet|Graphite|White|Custom/ }).first().textContent()) ?? "";
  check("next arrow changes premade", labelBefore !== labelAfter, `"${labelBefore.trim()}" -> "${labelAfter.trim()}"`);
  await page.screenshot({ path: shot("01-carousel-desktop") });

  // Parameter switch: panel is collapsed until a part is chosen.
  const hintVisible = await page.getByText("Pick a part above").isVisible().catch(() => false);
  check("customize panel starts collapsed (hint shown)", hintVisible);

  // Chassis → a colour control unfolds.
  await page.getByRole("tab", { name: "Chassis" }).click();
  await page.waitForTimeout(200);
  const chassisColor = await page.locator('input[type="color"]').first().isVisible();
  check("Chassis param unfolds a colour picker", chassisColor);
  await page.screenshot({ path: shot("02-chassis-color") });

  // Phosphor → presets + a custom colour picker.
  await page.getByRole("tab", { name: "Phosphor" }).click();
  await page.waitForTimeout(200);
  const phosphorCustom = await page.getByLabel("Custom phosphor colour").isVisible().catch(() => false);
  const phosphorPreset = await page.getByRole("button", { name: /Amber/ }).first().isVisible().catch(() => false);
  check("Phosphor param shows presets + custom colour", phosphorCustom && phosphorPreset);
  await page.screenshot({ path: shot("03-phosphor") });

  // Scanlines → a checkbox.
  await page.getByRole("tab", { name: "Scanlines" }).click();
  await page.waitForTimeout(150);
  const scan = await page.locator('input[type="checkbox"]').first().isVisible();
  check("Scanlines param shows a checkbox", scan);

  // Marquee → the animation grid (None + presets).
  await page.getByRole("tab", { name: "Marquee" }).click();
  await page.waitForTimeout(150);
  const none = await page.getByRole("button", { name: "None" }).isVisible().catch(() => false);
  const marqueeCards = await page.locator("button").filter({ hasText: /Pac-Man|Space Invaders|Asteroids/ }).count();
  check("Marquee param shows animation grid", none && marqueeCards >= 1, `${marqueeCards} scene cards`);
  await page.screenshot({ path: shot("04-marquee") });

  await desktop.close();

  // --- Mobile: no flanks, swipe changes premade ---------------------------
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const mpage = await phone.newPage();
  await mpage.goto(URL, { waitUntil: "domcontentloaded" });
  await mpage.getByRole("region", { name: "Handheld carousel" }).waitFor({ timeout: 15000 });
  await mpage.waitForTimeout(2500);

  const flankVisible = await mpage.locator('img[alt$="handheld"]').first().isVisible().catch(() => false);
  check("flanks hidden on mobile", !flankVisible);
  await mpage.screenshot({ path: shot("05-mobile") });

  // Swipe left over the carousel → next premade.
  const carousel = mpage.getByRole("region", { name: "Handheld carousel" });
  const box = await carousel.boundingBox();
  const mLabelBefore = (await mpage.locator("span").filter({ hasText: /·|Red|Orange|Yellow|Green|Blue|Indigo|Violet|Graphite|White|Custom/ }).first().textContent()) ?? "";
  if (box) {
    const y = box.y + box.height / 2;
    await mpage.touchscreen.tap(box.x + box.width * 0.7, y); // ensure focus
    await mpage.dispatchEvent('[aria-label="Handheld carousel"]', "touchstart", {});
  }
  // Use the React handlers directly via real touch events on the element.
  await carousel.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const mk = (type, x) =>
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        changedTouches: [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
        touches: type === "touchend" ? [] : [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })],
      });
    el.dispatchEvent(mk("touchstart", rect.left + rect.width * 0.8));
    el.dispatchEvent(mk("touchend", rect.left + rect.width * 0.2));
  });
  await mpage.waitForTimeout(400);
  const mLabelAfter = (await mpage.locator("span").filter({ hasText: /·|Red|Orange|Yellow|Green|Blue|Indigo|Violet|Graphite|White|Custom/ }).first().textContent()) ?? "";
  check("swipe changes premade on mobile", mLabelBefore !== mLabelAfter, `"${mLabelBefore.trim()}" -> "${mLabelAfter.trim()}"`);
  await mpage.screenshot({ path: shot("06-mobile-after-swipe") });

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);

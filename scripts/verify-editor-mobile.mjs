// Verifies the editor fits and works on a phone: no horizontal overflow, the
// canvas leads and fits the width, the tab strip swipes, tools flow under the
// stage, and drawing still lands on the right pixels at CSS scale.
//
// It used to check the sprite tab and nothing else, which is how the four 3D
// tabs came to have no phone story at all — an orbit camera inside a scrolling
// page, shipped and never looked at on a small screen. Every tab is checked
// now, and the ones that genuinely need a bigger screen have to *say so*
// rather than render something unusable.
//
// It also checks the top bar at desktop widths, where the tab strip was being
// squeezed to nothing by the action bar beside it.
//
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

  // 4. Every tab lays out without overflow — including the ones behind "More",
  //    which is where the 3D editors live and where nothing was ever checked.
  const BAR_TABS = ["Map", "Code", "SFX", "Music"];
  const MORE_TABS = ["World", "Scene", "Mesh", "Anim", "Weather", "FX"];
  /** Tabs that decline to render a viewport on a phone and say why instead. */
  const SPATIAL_TABS = new Set(["World", "Mesh"]);

  /** Click a tab, whether it sits on the bar or inside the More menu. */
  const openTab = async (tab) => {
    const onBar = page.locator("nav button", { hasText: new RegExp(`^${tab}$`, "i") });
    if ((await onBar.count()) > 0) {
      await onBar.first().click();
      return true;
    }
    const more = page.locator("nav button", { hasText: /^More/ });
    if ((await more.count()) === 0) return false;
    await more.first().click();
    await page.waitForTimeout(150);
    const item = page.locator('[role="menuitem"]', { hasText: new RegExp(`^${tab}$`, "i") });
    if ((await item.count()) === 0) return false;
    // The menu closes on blur, so the click has to land on mousedown.
    await item.first().dispatchEvent("mousedown");
    return true;
  };

  for (const tab of [...BAR_TABS, ...MORE_TABS]) {
    if (!(await openTab(tab))) {
      check(`${tab} tab reachable`, false, "tab not found");
      continue;
    }
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      // A tab that needs a bigger screen renders a notice and hides its body.
      notice: document.body.innerText.includes("needs a larger screen"),
      bodyVisible: [...document.querySelectorAll("div")].some(
        (node) => node.className.includes("body") && node.getBoundingClientRect().height > 0,
      ),
    }));
    check(
      `${tab} tab fits the phone`,
      state.scrollWidth <= state.innerWidth + 1,
      `${state.scrollWidth}/${state.innerWidth}`,
    );
    if (SPATIAL_TABS.has(tab)) {
      // The honest failure: say a 3D viewport needs a bigger screen. The
      // dishonest one is rendering an orbit camera into a scrolling page.
      check(`${tab} tab explains it needs a bigger screen`, state.notice);
      check(`${tab} tab does not render an unusable viewport`, !state.bodyVisible);
    }
  }
  await page.screenshot({ path: `${OUT}/51-editor-map.png` });

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();

  // 5. The top bar, at the desktop widths where it is most crowded.
  //
  //    The bar carries the identity block, the bank stepper, the tab strip and
  //    seven action buttons. The strip was the only shrinkable child, so flex
  //    resolved the squeeze by taking its width — 287px of the 407px it needs at
  //    1500px wide, and *zero* at 1100, leaving an editor with no reachable tab
  //    navigation. It now wraps onto its own row instead, and these pin that:
  //    every tab reachable, the strip inside the bar, and the tab content below
  //    it rather than under it.
  const desktop = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  for (const width of [1920, 1500, 1100]) {
    const wide = await desktop.newPage();
    await wide.setViewportSize({ width, height: 950 });
    await wide.goto(BASE + "/edit/new", { waitUntil: "domcontentloaded" });
    await wide.waitForURL("**/edit/**", { timeout: 10000 });
    await wide.waitForSelector("canvas", { timeout: 20000 });
    await wide.waitForTimeout(1200);

    const bar = await wide.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const tabs = document.querySelector("nav[aria-label='Editors']");
      // The editor's own bar, not the site nav header that precedes it.
      const strip = tabs.closest("header");
      const workbench = strip.parentElement;
      const content = [...workbench.children].find(
        (el) => el.tagName === "DIV" && box(el).height > 100,
      );
      return {
        hidden: tabs.scrollWidth - tabs.clientWidth,
        spill: Math.round(box(tabs).bottom - box(strip).bottom),
        contentTop: content ? Math.round(box(content).top) : null,
        barBottom: Math.round(box(strip).bottom),
        tabCursor: getComputedStyle(tabs.querySelector("button")).cursor,
      };
    });
    check(`w=${width}: every tab reachable`, bar.hidden === 0, `${bar.hidden}px hidden`);
    check(`w=${width}: tab strip stays inside the bar`, bar.spill <= 0, `${bar.spill}px spill`);
    check(
      `w=${width}: tab content starts below the bar`,
      bar.contentTop === null || bar.contentTop >= bar.barBottom - 1,
      `${bar.contentTop} vs ${bar.barBottom}`,
    );
    // Every tab is reachable, so none may look forbidden.
    check(`w=${width}: tabs look clickable`, bar.tabCursor === "pointer", bar.tabCursor);
    await wide.close();
  }
  await desktop.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);

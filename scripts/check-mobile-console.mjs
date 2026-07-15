import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222");
const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
try {
  for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 640 }, { width: 320, height: 568 }]) {
    const context = await browser.newContext({ viewport: vp, hasTouch: true, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
    await page.locator(".hh-img-device, .hh-root").first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    const info = await page.evaluate(() => {
      const root = document.querySelector(".hh-img-root");
      const dev = document.querySelector(".hh-img-device");
      const skin = document.querySelector(".hh-img-skin");
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const rr = r(root), rd = r(dev), rs = r(skin);
      return {
        hasRoot: !!root,
        rootBox: rr && { w: Math.round(rr.width), h: Math.round(rr.height) },
        deviceBox: rd && { w: Math.round(rd.width), h: Math.round(rd.height) },
        skinBox: rs && { w: Math.round(rs.width), h: Math.round(rs.height), natW: skin.naturalWidth },
        theme: document.querySelector(".hh-img-root,.hh-root")?.getAttribute("data-theme") ?? null,
      };
    });
    console.log(`${vp.width}x${vp.height}:`, JSON.stringify(info), errors.length ? `ERRORS: ${errors[0]}` : "");
    await page.screenshot({ path: `C:\\Temp\\cbx-verify\\mobile-${vp.width}.png` });
    await context.close();
  }
} finally {
  await browser.close();
}

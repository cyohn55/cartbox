import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222");
try {
  // Clean context: no localStorage, so the global default theme is what renders.
  const context = await browser.newContext({ viewport: { width: 440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto((process.env.CBX_BASE_URL ?? "http://localhost:3000") + "/console", { waitUntil: "domcontentloaded" });
  await page.locator(".hh-img-device, .hh-root").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  const image = await page.locator(".hh-img-device").count();
  const css = await page.locator(".hh-root").count();
  console.log(image === 1 && css === 0 ? "PASS default console = image handheld" : `FAIL image:${image} css:${css}`);
} finally {
  await browser.close();
}

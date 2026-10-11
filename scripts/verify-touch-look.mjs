/**
 * Touch look, a floating stick and gyro aim in Lockout on a phone
 * (CONTROLLER_SETTINGS_ROADMAP.md C4b): with drag-to-look on, the right stick
 * gives way to a look zone that takes a finger; with a floating stick, the
 * move stick comes to where the thumb lands and goes home after; gyro aim
 * reads motion without error. Real CDP touches in a landscape phone window.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-touch-look.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). Exits non-zero if a check fails.
 */
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => {
  if (!/supabase/i.test(e.message)) errors.push(e.message);
});
const cdp = await ctx.newCDPSession(page);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};
const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

await page.goto(`${BASE}/lockout`, { waitUntil: "load", timeout: 600000 });
await page.evaluate(() =>
  localStorage.setItem("cartbox:settings:lockout", JSON.stringify({ controls: { touchLookMode: "drag", floatingStick: true, gyroAim: "always" } })),
);
await page.reload({ waitUntil: "load" });
await page.getByRole("button", { name: "Play", exact: true }).click();
await page.locator("[data-cbx-touch]").waitFor({ timeout: 120000 });

// Start a match with the pad's A (the cart reads its sticks once playing).
const a = page.getByRole("button", { name: "A button" });
const zone = page.getByLabel("Look (drag here)");
const opted = await until(async () => {
  await a.dispatchEvent("pointerdown", { pointerId: 9 });
  await page.waitForTimeout(80);
  await a.dispatchEvent("pointerup", { pointerId: 9 });
  return zone.isVisible();
}, 60000);
check("drag-to-look shows a look zone once the game reads sticks", opted);
check("…in place of the right stick", !(await page.locator('[data-cbx-stick="right"]').isVisible()));

// Drag on the right of the screen: the zone takes the finger (and nothing else does).
const box = await zone.boundingBox();
const x0 = box.x + box.width * 0.5;
const y0 = box.y + box.height * 0.5;
await touch("touchStart", [[x0, y0]]);
for (let i = 1; i <= 8; i += 1) {
  await touch("touchMove", [[x0 + i * 12, y0]]);
  await page.waitForTimeout(16);
}
await touch("touchEnd", []);
check("a drag on the look zone plays without error", errors.length === 0, errors.join(" | "));

// Floating stick: a thumb on the left brings the move stick to it, and it goes home after.
const stick = page.locator('[data-cbx-stick="left"]');
const home = await stick.boundingBox();
const tx = 260;
const ty = 250;
await touch("touchStart", [[tx, ty]]);
await page.waitForTimeout(100);
const moved = await stick.boundingBox();
const cx = moved.x + moved.width / 2;
const cy = moved.y + moved.height / 2;
check("the move stick comes to the thumb", Math.abs(cx - tx) < 8 && Math.abs(cy - ty) < 8, `centre ${cx.toFixed(0)},${cy.toFixed(0)} vs ${tx},${ty}`);
await page.screenshot({ path: `${OUT}/touch-look.png` });
await touch("touchEnd", []);
await page.waitForTimeout(100);
const back = await stick.boundingBox();
check("…and goes home on release", Math.abs(back.x - home.x) < 2 && Math.abs(back.y - home.y) < 2);

// Gyro aim: motion events are read without error.
await page.evaluate(() => {
  for (let i = 0; i < 20; i += 1) {
    window.dispatchEvent(Object.assign(new Event("devicemotion"), { rotationRate: { alpha: 0, beta: 0, gamma: -60 } }));
  }
});
await page.waitForTimeout(500);
check("gyro aim reads motion without error", errors.length === 0, errors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed; screenshot in ${OUT}`);
process.exit(failed ? 1 : 0);

/**
 * Touch sticks never stay stuck: a finger whose release the browser never
 * delivers (iOS swallows it on a system gesture, an app switch, or when the
 * stick couldn't capture the pointer) must not hold a stick, a look zone or a
 * button down for good. Lockout on a landscape phone, with pointer events
 * dispatched on the pad's own elements.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-touch-stuck.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). Exits non-zero if a check fails.
 */
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => {
  if (!/supabase/i.test(e.message)) errors.push(e.message);
});
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

await page.goto(`${BASE}/lockout`, { waitUntil: "load", timeout: 600000 });
await page.evaluate(() => localStorage.removeItem("cartbox:settings:lockout"));
await page.reload({ waitUntil: "load" });
await page.getByRole("button", { name: "Play", exact: true }).click();
await page.locator("[data-cbx-touch]").waitFor({ timeout: 120000 });

/** A pointer event on an element, at an offset (px) from its centre. */
const fire = (selector, type, id, dx = 0, dy = 0) =>
  page.evaluate(
    ([sel, type, id, dx, dy]) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2 + dx;
      const y = r.top + r.height / 2 + dy;
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    [selector, type, id, dx, dy],
  );
/** The knob's offset from centre (px), from its transform. */
const knob = (selector) =>
  page.evaluate((sel) => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector(sel).firstElementChild.style.transform);
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  }, selector);

const LEFT = '[data-cbx-stick="left"]';

// 1. A finger leans the stick right, and its release never arrives.
await fire(LEFT, "pointerdown", 101, 40, 0);
const held = await knob(LEFT);
check("a finger leans the stick", held[0] > 10, JSON.stringify(held));

// 2. The next finger on the stick leans it left: the stick follows it.
await fire(LEFT, "pointerdown", 102, -40, 0);
await fire(LEFT, "pointermove", 102, -40, 0);
const next = await knob(LEFT);
check("a new finger takes over a stick whose last release was lost", next[0] < -10, JSON.stringify(next));
await fire(LEFT, "pointerup", 102, -40, 0);
check("…and lifting it centres the stick", (await knob(LEFT))[0] === 0);

// 3. A finger still down when the page is hidden (an app switch) lets go.
await fire(LEFT, "pointerdown", 103, 40, 0);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});
check("leaving the page centres a held stick", (await knob(LEFT))[0] === 0);

// 4. The same for a face button: lost release, then every finger lifts.
const A = '[data-cbx-button="A"]';
await fire(A, "pointerdown", 104);
const pressedBg = await page.evaluate((sel) => document.querySelector(sel).style.background, A);
await page.evaluate(() => document.dispatchEvent(Object.assign(new Event("touchend", { bubbles: true }), { touches: [] })));
const afterBg = await page.evaluate((sel) => document.querySelector(sel).style.background, A);
check("a button whose release was lost lets go once no finger is down", pressedBg !== afterBg, `${pressedBg} → ${afterBg}`);

// 5. Normal play is untouched: a thumb holds the stick while the other taps a
// button and lifts (a finger is still down, so nothing lets go).
await fire(LEFT, "pointerdown", 105, 40, 0);
await fire(A, "pointerdown", 106);
await fire(A, "pointerup", 106);
await page.evaluate(() => document.dispatchEvent(Object.assign(new Event("touchend", { bubbles: true }), { touches: [{ identifier: 105 }] })));
check("a stick held by one thumb stays leaned while the other taps a button", (await knob(LEFT))[0] > 10);
await fire(LEFT, "pointerup", 105, 40, 0);

check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

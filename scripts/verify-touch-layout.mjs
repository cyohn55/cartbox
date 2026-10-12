/**
 * Moving and resizing the touch pad's controls in Lockout on a phone: from the
 * Start menu's Touch tab, drag the A button and the left stick to new spots
 * and make A bigger, save, and play with them there; cancel throws a change
 * away; the layout is kept across a reload; Reset positions puts them back.
 * Real CDP touches in a landscape phone window.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-touch-layout.mjs
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
/** One finger from one point to another, in steps. */
async function drag([x0, y0], [x1, y1]) {
  await touch("touchStart", [[x0, y0]]);
  for (let i = 1; i <= 10; i += 1) {
    await touch("touchMove", [[x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10]]);
    await page.waitForTimeout(16);
  }
  await touch("touchEnd", []);
  await page.waitForTimeout(100);
}
const centre = async (selector) => {
  const b = await page.locator(selector).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width };
};
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("cartbox:settings:lockout") ?? "{}").controls?.touchLayout ?? null);
const near = (a, b, tol = 4) => Math.abs(a.x - b[0]) < tol && Math.abs(a.y - b[1]) < tol;

const A = '[data-cbx-button="A"]';
const Y = '[data-cbx-button="Y"]';
const LEFT = '[data-cbx-stick="left"]';

async function play() {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.locator("[data-cbx-touch]").waitFor({ timeout: 120000 });
  // Start a match with the pad's A (the right stick shows once the game reads sticks).
  const a = page.getByRole("button", { name: "A button" });
  const end = Date.now() + 60000;
  while (Date.now() < end && !(await page.locator('[data-cbx-stick="right"]').isVisible())) {
    await a.dispatchEvent("pointerdown", { pointerId: 9 });
    await page.waitForTimeout(80);
    await a.dispatchEvent("pointerup", { pointerId: 9 });
  }
}
async function openEditor() {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("tab", { name: "Touch" }).click();
  await page.getByRole("button", { name: "Move & resize" }).click();
  await page.locator("[data-cbx-layout-editor]").waitFor();
}

await page.goto(`${BASE}/lockout`, { waitUntil: "load", timeout: 600000 });
await page.evaluate(() => localStorage.removeItem("cartbox:settings:lockout"));
await page.reload({ waitUntil: "load" });
await play();
const aHome = await centre(A);
const yHome = await centre(Y);

// 0. The game's actions with no face button get buttons of their own (LOCKOUT_EQUIPMENT_ROADMAP.md E1).
const actionButtons = await page.locator("[data-cbx-action]").evaluateAll((els) => els.map((e) => e.getAttribute("data-cbx-action")));
check("the actions no face button carries get touch buttons", JSON.stringify(actionButtons) === JSON.stringify(["grenade", "zoom", "equipment"]), JSON.stringify(actionButtons));

// 1. Move A and the left stick, and make A bigger.
await openEditor();
check("the editor opens over the game, the menu out of the way", (await page.getByRole("dialog", { name: "Start menu" }).count()) === 0);
await drag([aHome.x, aHome.y], [300, 150]);
await page.getByRole("button", { name: "Bigger" }).click();
await page.getByRole("button", { name: "Bigger" }).click();
const left0 = await centre(LEFT);
await drag([left0.x, left0.y], [560, 260]);
const eqHome = await centre('[data-cbx-action="equipment"]');
await drag([eqHome.x, eqHome.y], [180, 120]);
await page.screenshot({ path: `${OUT}/touch-layout-editing.png` });
await page.getByRole("button", { name: "Save layout" }).click();
check("saving brings the menu back on its Touch tab", (await page.getByRole("tab", { name: "Touch" }).getAttribute("aria-selected")) === "true");
const layout = await saved();
check(
  "the layout is kept in the player's settings",
  layout && Math.abs(layout.A.x - 300 / 844) < 0.01 && Math.abs(layout.A.y - 150 / 390) < 0.015 && layout.A.size === 1.2 && Boolean(layout.leftStick),
  JSON.stringify(layout),
);
await page.getByRole("button", { name: "Resume" }).click();

// 2. Play with them where they were put.
const aNow = await centre(A);
check("A sits where it was dragged", near(aNow, [300, 150]), JSON.stringify(aNow));
check("the equipment button sits where it was dragged", near(await centre('[data-cbx-action="equipment"]'), [180, 120]));
check("…and the layout keeps it", Boolean(layout["act:equipment"]));
check("…at its new size", Math.abs(aNow.w / aHome.w - 1.2) < 0.05, `${aHome.w.toFixed(1)} → ${aNow.w.toFixed(1)}`);
check("a touch there presses A", await page.evaluate(() => document.elementFromPoint(300, 150)?.closest("[data-cbx-button]")?.getAttribute("data-cbx-button") === "A"));
const leftNow = await centre(LEFT);
check("the left stick sits where it was dragged", near(leftNow, [560, 260]), JSON.stringify(leftNow));
await touch("touchStart", [[leftNow.x + 35, leftNow.y]]);
await page.waitForTimeout(80);
const lean = await page.evaluate((sel) => document.querySelector(sel).firstElementChild.style.transform, LEFT);
await touch("touchEnd", []);
check("…and leans there", /translate\((?!0px)/.test(lean), lean);
await page.screenshot({ path: `${OUT}/touch-layout-playing.png` });

// 3. A control left under the editor's bar can still be reached: move the bar.
await openEditor();
await page.getByRole("button", { name: "Move this bar" }).click();
await drag([300, 150], [320, 160]);
await page.getByRole("button", { name: "Save layout" }).click();
await page.getByRole("button", { name: "Resume" }).click();
check("with the bar moved, a control that was under it can be dragged", near(await centre(A), [320, 160]), JSON.stringify(await centre(A)));
const layoutAfterBar = await saved();

// 4. Cancel throws a change away.
await openEditor();
await drag([yHome.x, yHome.y], [420, 120]);
await page.getByRole("button", { name: "Cancel layout" }).click();
await page.getByRole("button", { name: "Resume" }).click();
check("cancel leaves Y where it was", near(await centre(Y), [yHome.x, yHome.y], 2));
check("…and the saved layout as it was", JSON.stringify(await saved()) === JSON.stringify(layoutAfterBar));

// 5. Kept across a reload.
await page.reload({ waitUntil: "load" });
await play();
check("the layout is there after a reload", near(await centre(A), [320, 160]));

// 6. Reset positions puts them back.
await page.getByRole("button", { name: "Menu", exact: true }).click();
await page.getByRole("tab", { name: "Touch" }).click();
await page.getByRole("button", { name: "Reset positions" }).click();
await page.getByRole("button", { name: "Resume" }).click();
check("reset positions puts A back in the diamond", near(await centre(A), [aHome.x, aHome.y], 2));

check("no errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed; screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);

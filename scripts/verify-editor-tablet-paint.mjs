/**
 * Painting on a tablet, end to end (TABLET_EDITOR_ROADMAP.md T2): the sprite
 * pixel canvas, the map canvas and the Mesh tab's UV view driven with real
 * touch (CDP multi-touch) and Apple Pencil (pen pointer with force) events in
 * an iPad-sized window.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-editor-tablet-paint.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). Exits non-zero if a check fails.
 */
import { tmpdir } from "node:os";
import { chromium } from "playwright";
const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const launch = (args) => chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args });
const browser = await launch(["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]);

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

/** A fresh iPad-sized page with touch, and its CDP session for raw input. */
async function open(path, on = browser) {
  const ctx = await on.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { if (!/supabase/i.test(e.message)) console.log("pageerror", e.message); });
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 600000 });
  await page.waitForTimeout(8000);
  const start = page.getByRole("button", { name: "Start creating" });
  if (await start.count()) await start.click();
  await page.waitForTimeout(1500);
  const settle = () => page.waitForTimeout(400);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 8, radiusY: 8, force: 1 })) });
  const pen = (type, x, y, force = 0.8) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force });
  /** A one-finger drag from a to b in steps. */
  const swipe = async ([ax, ay], [bx, by], steps = 8) => {
    await touch("touchStart", [[ax, ay]]);
    for (let k = 1; k <= steps; k++) { await touch("touchMove", [[ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]]); await page.waitForTimeout(20); }
    await touch("touchEnd", []);
    await settle();
  };
  /** Two fingers spreading apart about (x, y), by `by` px each. */
  const spread = async (x, y, by = 90) => {
    await touch("touchStart", [[x - 30, y], [x + 30, y]]);
    for (let k = 1; k <= 8; k++) { await touch("touchMove", [[x - 30 - (by * k) / 8, y], [x + 30 + (by * k) / 8, y]]); await page.waitForTimeout(30); }
    await touch("touchEnd", []);
    await settle();
  };
  const longPress = async (x, y) => {
    await touch("touchStart", [[x, y]]);
    await page.waitForTimeout(800);
    await touch("touchEnd", []);
    await settle();
  };
  const penStroke = async (from, to, force = 0.8, palm = null) => {
    await pen("mousePressed", from[0], from[1], force);
    if (palm) await touch("touchStart", [palm]);
    for (let k = 1; k <= 10; k++) {
      await pen("mouseMoved", from[0] + ((to[0] - from[0]) * k) / 10, from[1] + ((to[1] - from[1]) * k) / 10, force);
      if (palm) await touch("touchMove", [[palm[0] - k * 3, palm[1] - k]]);
      await page.waitForTimeout(20);
    }
    await pen("mouseReleased", to[0], to[1], force);
    if (palm) await touch("touchEnd", []);
    await settle();
  };
  return { ctx, page, touch, pen, swipe, spread, longPress, penStroke, settle };
}

/** A canvas's pixels where it shows in the window (2D canvases read back directly). */
const pixelsOf = (locator) => locator.evaluate((c) => {
  const r = c.getBoundingClientRect();
  const sx = c.width / r.width, sy = c.height / r.height;
  const x0 = Math.max(0, Math.floor(-r.left * sx)), y0 = Math.max(0, Math.floor(-r.top * sy));
  const x1 = Math.min(c.width, Math.ceil((innerWidth - r.left) * sx)), y1 = Math.min(c.height, Math.ceil((innerHeight - r.top) * sy));
  return Array.from(c.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data);
});
/** Pixels that differ by more than shading noise (the views re-shade their material grain slightly after an edit commits). */
/** All of a canvas's pixels, wherever it is scrolled to. */
const allPixelsOf = (locator) => locator.evaluate((c) => Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data));
const differ = (a, b) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n + Math.abs(a.length - b.length) / 4; };
/** The colour at a page point of a canvas. */
const colourAt = (locator, x, y) => locator.evaluate((c, [px, py]) => {
  const r = c.getBoundingClientRect();
  const d = c.getContext("2d").getImageData(Math.floor(((px - r.left) / r.width) * c.width), Math.floor(((py - r.top) / r.height) * c.height), 1, 1).data;
  return `${d[0]},${d[1]},${d[2]}`;
}, [x, y]);

// CBX_ONLY=sprites|map|uv runs one section.
const run = (section) => !process.env.CBX_ONLY || process.env.CBX_ONLY === section;

// --- The sprite pixel canvas (Assets → Pixels). ---
if (run("sprites")) {
  const t = await open("/edit/new?model=xbox360");
  const { page } = t;
  const canvas = page.locator('canvas[aria-label^="Sprite "]').first();
  await page.getByRole("button", { name: /Pencil$/ }).first().click();
  const swatch = (i) => page.locator(`button[aria-label*=" ${i}, #"]`).first();
  await swatch(8).click();
  let box = await canvas.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

  // 1. Before a Pencil is used, one finger draws.
  let before = await pixelsOf(canvas);
  await t.swipe(at(0.1, 0.15), at(0.9, 0.15));
  const afterFinger = await pixelsOf(canvas);
  check("sprites: one finger draws before a Pencil is used", differ(before, afterFinger) > 0, `${differ(before, afterFinger)} px`);
  const painted = await colourAt(canvas, ...at(0.5, 0.15));

  // 2. A finger stroke that a second finger turns into a gesture is undone.
  await t.touch("touchStart", [at(0.1, 0.6)]);
  for (let k = 1; k <= 6; k++) { await t.touch("touchMove", [[at(0.1, 0.6)[0] + k * 25, at(0.1, 0.6)[1]]]); await page.waitForTimeout(20); }
  const midStroke = await pixelsOf(canvas);
  await t.touch("touchStart", [[at(0.1, 0.6)[0] + 150, at(0.1, 0.6)[1]], at(0.6, 0.85)]);
  for (let k = 1; k <= 6; k++) { await t.touch("touchMove", [[at(0.1, 0.6)[0] + 150 + k * 4, at(0.1, 0.6)[1] + k * 4], [at(0.6, 0.85)[0] + k * 4, at(0.6, 0.85)[1] + k * 4]]); await page.waitForTimeout(20); }
  await t.touch("touchEnd", []);
  await t.settle();
  const afterCancel = await pixelsOf(canvas);
  check("sprites: a stroke turned into a two-finger gesture is put back", differ(afterFinger, midStroke) > 0 && differ(afterFinger, afterCancel) === 0, `painted mid-stroke ${differ(afterFinger, midStroke)} px, left ${differ(afterFinger, afterCancel)} px`);

  // 3. A long press picks the colour under it (the eyedropper).
  await swatch(3).click();
  await t.longPress(...at(0.5, 0.15));
  const picked = await swatch(8).getAttribute("aria-pressed");
  check("sprites: a long press picks the colour under it", picked === "true", `swatch 8 pressed ${picked}, painted ${painted}`);

  // 4. Spreading two fingers zooms the canvas in.
  const widthBefore = box.width;
  await t.spread(box.x + box.width / 2, box.y + box.height / 2);
  box = await canvas.boundingBox();
  check("sprites: spreading two fingers zooms in", box.width > widthBefore * 1.2, `${widthBefore.toFixed(0)} -> ${box.width.toFixed(0)} px`);
  await page.getByRole("slider", { name: "Canvas zoom" }).first().fill?.("100").catch(() => {});
  await t.spread(box.x + box.width / 2, box.y + box.height / 2, -25);
  box = await canvas.boundingBox();

  // 5. A Pencil stroke paints while a palm rests (and moves) on the canvas; the palm paints nothing.
  await swatch(12).click();
  const palm = at(0.85, 0.9);
  const palmBefore = await colourAt(canvas, ...palm);
  before = await pixelsOf(canvas);
  await t.penStroke(at(0.1, 0.4), at(0.6, 0.4), 0.8, palm);
  const afterPen = await pixelsOf(canvas);
  check("sprites: a Pencil stroke paints under a resting palm", differ(before, afterPen) > 0, `${differ(before, afterPen)} px`);
  check("sprites: the palm paints nothing", (await colourAt(canvas, ...palm)) === palmBefore && (await colourAt(canvas, palm[0] - 20, palm[1] - 6)) === palmBefore, `${palmBefore}`);

  // 6. Once a Pencil is used, one finger no longer draws. (It scrolls the panel, so the whole sprite is
  // compared; and the Pencil hovers off the canvas first, so its hover outline isn't counted.)
  const hoverAway = async () => {
    await t.pen("mouseMoved", 4, 4, 0);
    await t.settle();
  };
  await hoverAway();
  const settled = await allPixelsOf(canvas);
  await t.swipe(at(0.1, 0.75), at(0.9, 0.75));
  await hoverAway();
  const afterSwipe = await allPixelsOf(canvas);
  check("sprites: after a Pencil, one finger draws nothing", differ(settled, afterSwipe) === 0, `${differ(settled, afterSwipe)} px`);
  await page.screenshot({ path: `${OUT}/tablet-sprites.png` });
  await t.ctx.close();
}

// --- The map canvas (Map tab). ---
if (run("map")) {
  const t = await open("/edit/new?model=xbox360");
  const { page } = t;
  await page.getByRole("button", { name: /Map$/ }).first().click();
  await page.waitForTimeout(8000);
  const canvas = page.locator('canvas[aria-label^="Map, "]').first();
  // The canvas covers only the part of the map in view (T4), so the map's size is its box's.
  const content = canvas.locator("xpath=..");
  const viewport = canvas.locator("xpath=../..");
  let box = await content.boundingBox();
  const view = await viewport.boundingBox();
  const mid = [view.x + view.width / 2, view.y + view.height / 2];

  // 7. A finger stroke turned into a two-finger pan is put back.
  let before = await pixelsOf(canvas);
  await t.touch("touchStart", [[mid[0] - 120, mid[1]]]);
  for (let k = 1; k <= 6; k++) { await t.touch("touchMove", [[mid[0] - 120 + k * 20, mid[1]]]); await page.waitForTimeout(20); }
  const midStroke = await pixelsOf(canvas);
  await t.touch("touchStart", [[mid[0], mid[1]], [mid[0], mid[1] + 60]]);
  for (let k = 1; k <= 6; k++) { await t.touch("touchMove", [[mid[0] + k * 3, mid[1] + k * 3], [mid[0] + k * 3, mid[1] + 60 + k * 3]]); await page.waitForTimeout(20); }
  await t.touch("touchEnd", []);
  await t.settle();
  check("map: a stroke turned into a two-finger gesture is put back", differ(before, midStroke) > 0 && differ(before, await pixelsOf(canvas)) === 0, `painted mid-stroke ${differ(before, midStroke)} cells' px`);

  // 8. A Pencil stroke paints, a resting palm paints nothing.
  before = await pixelsOf(canvas);
  await t.penStroke([mid[0] - 150, mid[1] - 60], [mid[0] + 100, mid[1] - 60], 0.8, [view.x + view.width - 40, view.y + view.height - 40]);
  const afterPen = await pixelsOf(canvas);
  await page.screenshot({ path: `${OUT}/tablet-map-pen.png` });
  check("map: a Pencil stroke paints under a resting palm", differ(before, afterPen) > 0, `${differ(before, afterPen)} px`);
  // 9. Spreading two fingers steps the zoom in (one step: this map at the largest steps is past what a canvas can hold).
  const widthBefore = box.width;
  await t.spread(...mid, 12);
  box = await content.boundingBox();
  check("map: spreading two fingers zooms in", box.width > widthBefore * 1.2, `${widthBefore.toFixed(0)} -> ${box.width.toFixed(0)} px`);

  // 10. Two fingers pan the map.
  const scroll = () => viewport.evaluate((v) => [v.scrollLeft, v.scrollTop]);
  const s0 = await scroll();
  await t.touch("touchStart", [[mid[0] - 30, mid[1]], [mid[0] + 30, mid[1]]]);
  for (let k = 1; k <= 8; k++) { await t.touch("touchMove", [[mid[0] - 30 - k * 15, mid[1] - k * 10], [mid[0] + 30 - k * 15, mid[1] - k * 10]]); await page.waitForTimeout(25); }
  await t.touch("touchEnd", []);
  await t.settle();
  const s1 = await scroll();
  check("map: two fingers pan the map", s1[0] > s0[0] && s1[1] > s0[1], `scroll ${s0} -> ${s1}`);

  await page.screenshot({ path: `${OUT}/tablet-map.png` });
  await t.ctx.close();
}

// --- The Mesh tab's UV view (Lockout's Spartan, Paint mode). ---
if (run("uv")) {
  const t = await open("/edit/new?model=xbox360&starter=lockout");
  const { page } = t;
  await page.getByRole("button", { name: /More/ }).first().click();
  await page.getByText(/^.?Mesh$/).first().click();
  await page.waitForTimeout(4000);
  await page.getByText("bot 1", { exact: true }).first().click();
  await page.waitForTimeout(3000);
  // (The Edit modes overflow the rail at this width, which T4 fixes, so the button is pressed directly.)
  await page.getByRole("button", { name: "Paint", exact: true }).first().dispatchEvent("click");
  await page.waitForTimeout(3000);
  const unwrap = page.getByRole("button", { name: "Unwrap this part" });
  if (await unwrap.count()) {
    await unwrap.first().dispatchEvent("click");
    await page.waitForTimeout(3000);
  }
  const canvas = page.locator('canvas[aria-label^="UV view"]').first();
  await canvas.scrollIntoViewIfNeeded();
  let box = await canvas.boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const colour = page.getByLabel("Colour to paint").first();

  // 11. A Pencil stroke paints the layer.
  const before = await pixelsOf(canvas);
  await t.penStroke(at(0.2, 0.3), at(0.8, 0.3), 1);
  const afterPen = await pixelsOf(canvas);
  check("uv: a Pencil stroke paints", differ(before, afterPen) > 0, `${differ(before, afterPen)} px`);

  // 12. A long press picks the colour under it.
  const painted = await colour.inputValue();
  await colour.fill("#10ff20");
  // The first save drops the "New map size" choice, and filling the colour can scroll the rail: measure again.
  await page.waitForTimeout(300);
  box = await canvas.boundingBox();
  const under = await colourAt(canvas, ...at(0.5, 0.3));
  await t.longPress(...at(0.5, 0.3));
  const pickedValue = await colour.inputValue();
  const hex = (rgb) => "#" + rgb.split(",").map((v) => Number(v).toString(16).padStart(2, "0")).join("");
  const near = (a, b) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 4);
  check("uv: a long press picks the colour under it", pickedValue !== "#10ff20" && pickedValue !== "#ffffff" && near(pickedValue, hex(under)), `painting ${painted}, set #10ff20, picked ${pickedValue} (the view shows ${hex(under)} there)`);

  // 13. Spreading two fingers zooms the view.
  const widthBefore = box.width;
  await t.spread(box.x + box.width / 2, box.y + box.height / 2, 60);
  box = await canvas.boundingBox();
  check("uv: spreading two fingers zooms in", box.width > widthBefore * 1.2, `${widthBefore.toFixed(0)} -> ${box.width.toFixed(0)} px`);
  await page.screenshot({ path: `${OUT}/tablet-uv.png` });
  await t.ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

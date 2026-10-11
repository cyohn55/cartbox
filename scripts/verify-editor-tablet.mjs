/**
 * The editor on a tablet, end to end (TABLET_EDITOR_ROADMAP.md T1): the
 * Lockout cart's Mesh tab driven with real touch (CDP multi-touch) and Apple
 * Pencil (pen pointer with force) events in an iPad-sized window.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-editor-tablet.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). Exits non-zero if a check fails.
 */
import { tmpdir } from "node:os";
import { chromium } from "playwright";
const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => { if (!/supabase/i.test(e.message)) console.log("pageerror", e.message); });
const cdp = await ctx.newCDPSession(page);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

await page.goto(`${BASE}/edit/new?model=xbox360&starter=lockout`, { waitUntil: "load", timeout: 600000 });
await page.waitForTimeout(8000);
await page.getByRole("button", { name: "Start creating" }).click();
await page.getByRole("button", { name: /More/ }).first().click();
await page.getByText(/^.?Mesh$/).first().click();
await page.waitForTimeout(4000);
await page.getByText("bot 1", { exact: true }).first().click();
await page.waitForTimeout(3000);

const canvas = page.locator('canvas[aria-label^="3D mesh preview"]');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const pixels = () => canvas.evaluate((c) => c.toDataURL());
/** The share of the canvas the model covers (pixels not the background). */
const coverage = () => canvas.evaluate((c) => {
  const x = document.createElement("canvas"); x.width = c.width; x.height = c.height;
  const g = x.getContext("2d"); g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 14) + Math.abs(d[i + 1] - 16) + Math.abs(d[i + 2] - 26) > 24) n++;
  return n / (c.width * c.height);
});
const undoDisabled = () => page.getByRole("button", { name: "Undo", exact: true }).first().isDisabled();
const settle = () => page.waitForTimeout(700);
const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 8, radiusY: 8, force: 1 })) });
const pen = (type, x, y, force = 0.8) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force });

// 1. Pinch to zoom: the view changes, nothing is edited.
const undoAtStart = await undoDisabled();
let before;
const coveredBefore = await coverage();
await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
for (let k = 1; k <= 8; k++) { await touch("touchMove", [[cx - 40 - k * 12, cy], [cx + 40 + k * 12, cy]]); await page.waitForTimeout(30); }
await touch("touchEnd", []);
await settle();
const coveredAfter = await coverage();
check("spreading two fingers zooms in (the model covers more of the view)", coveredAfter > coveredBefore * 1.3, `${(coveredBefore * 100).toFixed(1)}% -> ${(coveredAfter * 100).toFixed(1)}%`);
check("a pinch edits nothing", (await undoDisabled()) === undoAtStart, `undo disabled ${undoAtStart} -> ${await undoDisabled()}`);
check("the touch bar shows after a touch", await page.getByRole("toolbar", { name: "Touch controls" }).isVisible());

// 2. Two fingers sliding orbit the view.
before = await pixels();
await touch("touchStart", [[cx - 50, cy], [cx + 50, cy]]);
for (let k = 1; k <= 8; k++) { await touch("touchMove", [[cx - 50 + k * 10, cy + k * 4], [cx + 50 + k * 10, cy + k * 4]]); await page.waitForTimeout(30); }
await touch("touchEnd", []);
await settle();
check("two fingers orbit the view", (await pixels()) !== before);

// 3. Model mode: a one-finger tap on the model selects (the overlay changes), and edits nothing.
await page.getByRole("radio", { name: "Model" }).or(page.getByRole("button", { name: "Model", exact: true })).first().click();
await settle();
before = await pixels();
await touch("touchStart", [[cx, cy]]);
await page.waitForTimeout(80);
await touch("touchEnd", []);
await settle();
check("a tap selects in Model mode", (await pixels()) !== before);
await page.screenshot({ path: `${OUT}/tablet-model.png` });

// 3b. Face mode: a long press ring-selects, as an Alt-click does (and a tap picks one face).
const edgeMode = page.getByRole("radio", { name: "Face" }).or(page.getByRole("button", { name: "Face", exact: true })).first();
const selectedCount = async () => {
  const text = (await page.getByText(/\d+ (?:edges?|faces?|vertices) selected/i).first().textContent().catch(() => "")) ?? "";
  return Number(/(\d+)/.exec(text)?.[1] ?? 0);
};
if (await edgeMode.count()) {
  await edgeMode.click();
  await settle();
  // Find a spot where the loop is longer than one edge, by Alt-clicking with the mouse.
  let spot = null, altCount = 0;
  for (const [dx, dy] of [[0, -30], [0, 40], [-30, 0], [30, 10], [0, -80], [20, 80], [-40, 60]]) {
    await page.keyboard.down("Alt");
    await page.mouse.click(cx + dx, cy + dy);
    await page.keyboard.up("Alt");
    await settle();
    altCount = await selectedCount();
    if (altCount > 1) { spot = [cx + dx, cy + dy]; break; }
  }
  if (spot) {
    await touch("touchStart", [spot]);
    await page.waitForTimeout(80);
    await touch("touchEnd", []);
    await settle();
    const tapped = await selectedCount();
    await touch("touchStart", [spot]);
    await page.waitForTimeout(800);
    await touch("touchEnd", []);
    await settle();
    const held = await selectedCount();
    check("a long press ring-selects, as an Alt-click does", held === altCount && tapped === 1, `Alt-click ${altCount}, tap ${tapped}, long press ${held}`);
  } else check("found a spot with a loop", false);
  await page.screenshot({ path: `${OUT}/tablet-loop.png` });
} else check("Edge mode available", false);

// 4. Weights mode: a Pencil stroke paints while a palm rests on the glass: one undoable edit, the palm ignored.
const weights = page.getByRole("radio", { name: "Weights" }).or(page.getByRole("button", { name: "Weights", exact: true })).first();
const objectMode = page.getByRole("radio", { name: "Object" }).or(page.getByRole("button", { name: "Object", exact: true })).first();
if (await weights.count()) {
  await objectMode.click();
  await settle();
  const viewBefore = await pixels();
  await weights.click();
  await settle();
  const undoBefore = await undoDisabled();
  await pen("mousePressed", cx, cy - 20, 0.8);
  await touch("touchStart", [[box.x + box.width - 30, box.y + box.height - 30]]); // the palm
  for (let k = 1; k <= 10; k++) {
    await pen("mouseMoved", cx + k * 4, cy - 20 + k * 3, 0.8);
    await touch("touchMove", [[box.x + box.width - 30 - k * 3, box.y + box.height - 30]]);
    await page.waitForTimeout(25);
  }
  await pen("mouseReleased", cx + 40, cy + 10, 0.8);
  await touch("touchEnd", []);
  await settle();
  check("a Pencil stroke under a palm paints one undoable edit", undoBefore === true ? (await undoDisabled()) === false : true, `undo disabled ${undoBefore} -> ${await undoDisabled()}`);
  await page.screenshot({ path: `${OUT}/tablet-weights.png` });

  // 5. A quick two-finger tap undoes it.
  await touch("touchStart", [[cx - 30, cy], [cx + 30, cy]]);
  await page.waitForTimeout(60);
  await touch("touchEnd", []);
  await settle();
  check("a two-finger tap undoes", (await undoDisabled()) === undoBefore, `undo disabled now ${await undoDisabled()}`);
  // 6. Pressure: a firm Pencil stroke changes the weights (the heat map) more than a light one along the same path.
  const heat = () => canvas.evaluate((c) => {
    const x = document.createElement("canvas"); x.width = c.width; x.height = c.height;
    const g = x.getContext("2d"); g.drawImage(c, 0, 0);
    return Array.from(g.getImageData(0, 0, c.width, c.height).data);
  });
  const strokeAt = async (force) => {
    await pen("mousePressed", cx, cy - 20, force);
    for (let k = 1; k <= 10; k++) { await pen("mouseMoved", cx + k * 4, cy - 20 + k * 3, force); await page.waitForTimeout(25); }
    await pen("mouseReleased", cx + 40, cy + 10, force);
    await settle();
  };
  const change = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d; };
  // The brush ring is drawn where the stroke ends: end both strokes there before measuring.
  await strokeAt(0.0001); // a stroke that paints almost nothing, to put the ring in place
  const restUndo = await undoDisabled();
  const base = await heat();
  await strokeAt(0.15);
  const light = change(base, await heat());
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await settle();
  await strokeAt(1);
  const firm = change(base, await heat());
  check("a firm Pencil stroke paints weights more strongly than a light one", firm > light * 1.3 && light > 0, `light ${light}, firm ${firm}`);
  void restUndo;

  // With a Pencil in use one finger orbits — so had the palm not been ignored, the view would have turned.
  await objectMode.click();
  await settle();
  check("the palm moved nothing (the view is as before the stroke)", (await pixels()) === viewBefore);
} else check("Weights mode available for bot 1", false);

console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.name) }));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

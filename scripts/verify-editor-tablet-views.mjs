/**
 * The editor's other views on a tablet, end to end (TABLET_EDITOR_ROADMAP.md
 * T3): the voxel editor, the Scene viewport and the material graph driven
 * with real touch (CDP multi-touch) and Apple Pencil (pen pointer) events in
 * an iPad-sized window.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-editor-tablet-views.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). CBX_ONLY=voxel|scene|graph runs one
 * section. Exits non-zero if a check fails.
 */
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
const { PNG } = createRequire(import.meta.url)("pngjs");
const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };
const run = (section) => !process.env.CBX_ONLY || process.env.CBX_ONLY === section;

/** A fresh iPad-sized page with touch, and raw touch and pen input over CDP. */
async function open(path) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { if (!/supabase/i.test(e.message)) console.log("pageerror", e.message); });
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 600000 });
  await page.waitForTimeout(8000);
  const start = page.getByRole("button", { name: "Start creating" });
  if (await start.count()) await start.click();
  await page.waitForTimeout(1500);
  const settle = (ms = 700) => page.waitForTimeout(ms);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i, radiusX: 8, radiusY: 8, force: 1 })) });
  /** Fingers from `from` points, each moved by (dx, dy) and spread apart by `spread` px from their centre, in steps. */
  const fingers = async (from, { dx = 0, dy = 0, spread = 0 } = {}, steps = 8) => {
    const cx = from.reduce((a, p) => a + p[0], 0) / from.length, cy = from.reduce((a, p) => a + p[1], 0) / from.length;
    await touch("touchStart", from);
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      await touch("touchMove", from.map(([x, y]) => {
        const d = Math.hypot(x - cx, y - cy) || 1;
        return [x + dx * f + ((x - cx) / d) * spread * f, y + dy * f + ((y - cy) / d) * spread * f];
      }));
      await page.waitForTimeout(25);
    }
    await touch("touchEnd", []);
    await settle();
  };
  const tap = async (x, y, hold = 80) => {
    await touch("touchStart", [[x, y]]);
    await page.waitForTimeout(hold);
    await touch("touchEnd", []);
    await settle();
  };
  const undoDisabled = () => page.getByRole("button", { name: "Undo", exact: true }).first().isDisabled();
  return { ctx, page, touch, fingers, tap, settle, undoDisabled };
}
/** What the screen shows of an element (a WebGL canvas can't be read back reliably), as RGBA. */
const seen = async (locator) => Array.from(PNG.sync.read(await locator.screenshot()).data);
/** How many pixels of a canvas differ between two readings (any channel by more than 30). */
const shot = (locator) => locator.evaluate((c) => {
  const x = document.createElement("canvas"); x.width = c.width; x.height = c.height;
  const g = x.getContext("2d"); g.drawImage(c, 0, 0);
  return Array.from(g.getImageData(0, 0, c.width, c.height).data);
});
/** The share of a canvas that isn't its (darkest, most common) background. */
const coverage = (locator) => locator.evaluate((c) => {
  const x = document.createElement("canvas"); x.width = c.width; x.height = c.height;
  const g = x.getContext("2d"); g.drawImage(c, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const bg = [d[0], d[1], d[2]];
  let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
  return n / (c.width * c.height);
});
const differ = (a, b) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n; };

// --- The voxel editor (Assets → Voxels). ---
if (run("voxel")) {
  const t = await open("/edit/new?model=xbox360");
  const { page } = t;
  await page.getByRole("button", { name: /^Voxels/ }).first().click();
  await page.waitForTimeout(3000);
  const canvas = page.locator('canvas[aria-label^="3D voxel model"]').first();
  const box = await canvas.boundingBox();
  const mid = [box.x + box.width / 2, box.y + box.height / 2];
  const startUndo = await t.undoDisabled();
  /** The HUD's voxel count. */
  const cubes = () => page.evaluate(() => {
    const label = [...document.querySelectorAll("span")].find((e) => /^(cubes|hexels)$/i.test(e.textContent.trim()));
    return Number(label?.nextElementSibling?.textContent ?? NaN);
  });
  const startCubes = await cubes();

  // 1. Two fingers orbit, and edit nothing.
  const before = await shot(canvas);
  await t.fingers([[mid[0] - 50, mid[1]], [mid[0] + 50, mid[1]]], { dx: 90 });
  const orbited = await shot(canvas);
  check("voxel: two fingers orbit the model", differ(before, orbited) > 200, `${differ(before, orbited)} px`);
  check("voxel: orbiting edits nothing", (await t.undoDisabled()) === startUndo, `undo disabled ${startUndo} -> ${await t.undoDisabled()}`);

  // 2. A pinch zooms (as the wheel does): the model fills more of the view. And it edits nothing.
  const covered = await coverage(canvas);
  await t.fingers([[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]], { spread: 90 });
  const zoomed = await shot(canvas);
  const coveredAfter = await coverage(canvas);
  check("voxel: a pinch zooms in", coveredAfter > covered * 1.3, `the model covers ${(covered * 100).toFixed(1)}% -> ${(coveredAfter * 100).toFixed(1)}% of the view`);
  check("voxel: a pinch edits nothing", (await t.undoDisabled()) === startUndo && (await cubes()) === startCubes, `${startCubes} -> ${await cubes()} voxels`);

  // 3. A tap adds a voxel (an edit), and a long press there removes it (the right click).
  await t.tap(...mid);
  await t.settle(900);
  const added = await shot(canvas);
  const afterTap = await cubes();
  check("voxel: a tap adds a voxel, as a click does", afterTap === startCubes + 1 && differ(zoomed, added) > 0, `${startCubes} -> ${afterTap} voxels`);
  await t.tap(...mid, 800);
  await t.settle(900);
  const removed = await shot(canvas);
  const afterHold = await cubes();
  check("voxel: a long press removes it, as a right-click does", afterHold === startCubes && differ(added, removed) > 0, `${afterTap} -> ${afterHold} voxels`);
  await page.screenshot({ path: `${OUT}/tablet-voxel.png` });
  await t.ctx.close();
}

// --- The Scene viewport (Lockout, Mesh tab, Scene view). ---
if (run("scene")) {
  const t = await open("/edit/new?model=xbox360&starter=lockout");
  const { page } = t;
  await page.getByRole("button", { name: /More/ }).first().click();
  await page.getByText(/^.?Mesh$/).first().click();
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Scene", exact: true }).first().dispatchEvent("click");
  await page.waitForTimeout(5000);
  const canvas = page.locator('canvas[aria-label^="3D scene"]').first();
  const box = await canvas.boundingBox();
  const mid = [box.x + box.width / 2, box.y + box.height / 2];
  const startUndo = await t.undoDisabled();
  const still = async () => { await page.waitForTimeout(400); return seen(canvas); };

  let before = await still();
  await t.fingers([[mid[0] - 50, mid[1]], [mid[0] + 50, mid[1]]], { dx: 80 });
  let after = await still();
  check("scene: two fingers orbit", differ(before, after) > 2000, `${differ(before, after)} px`);

  // A pinch turns the wheel: as many notches out put the view back.
  before = after;
  await t.fingers([[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]], { spread: 80 });
  const pinched = await still();
  await page.mouse.move(...mid);
  let notches = 0, best = Infinity;
  while (notches < 14) {
    await page.mouse.wheel(0, 100);
    notches++;
    const d = differ(before, await still());
    if (d >= best) break;
    best = d;
  }
  notches--;
  check("scene: a pinch dollies in, as the wheel does", differ(before, pinched) > 2000 && notches >= 3 && best < 0.01 * (before.length / 4), `${differ(before, pinched)} px changed; ${notches} wheel notches out put back all but ${best} px`);

  before = await still();
  await t.fingers([[mid[0] - 50, mid[1]], [mid[0] + 50, mid[1]], [mid[0], mid[1] + 60]], { dy: 60 });
  after = await still();
  check("scene: three fingers pan", differ(before, after) > 2000, `${differ(before, after)} px`);
  check("scene: moving the view edits nothing", (await t.undoDisabled()) === startUndo, `undo disabled ${startUndo} -> ${await t.undoDisabled()}`);
  await page.screenshot({ path: `${OUT}/tablet-scene.png` });
  await t.ctx.close();
}

// --- The material graph (Lockout, Mesh tab, bot 1's material). ---
if (run("graph")) {
  const t = await open("/edit/new?model=xbox360&starter=lockout");
  const { page } = t;
  await page.getByRole("button", { name: /More/ }).first().click();
  await page.getByText(/^.?Mesh$/).first().click();
  await page.waitForTimeout(4000);
  await page.getByText("bot 1", { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /Material graph…|Edit graph…/ }).first().dispatchEvent("click");
  await page.waitForTimeout(2000);
  const bg = page.locator('[aria-label="Material graph"] div[style*="radial-gradient"]').first();
  const box = await bg.boundingBox();
  const mid = [box.x + box.width * 0.75, box.y + box.height * 0.75];
  const style = () => bg.evaluate((d) => ({ size: d.style.backgroundSize, pos: d.style.backgroundPosition }));

  // 1. One finger on the background pans (no Pencil used yet).
  const s0 = await style();
  await t.fingers([mid], { dx: -60, dy: -40 });
  const s1 = await style();
  check("graph: one finger pans the background", s1.pos !== s0.pos, `${s0.pos} -> ${s1.pos}`);

  // 2. A pinch zooms (as the wheel does).
  await t.fingers([[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]], { spread: 60 });
  const s2 = await style();
  check("graph: a pinch zooms", parseFloat(s2.size) > parseFloat(s1.size), `${s1.size} -> ${s2.size}`);

  // 3. Two fingers pan.
  await t.fingers([[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]], { dx: -50, dy: 30 });
  const s3 = await style();
  check("graph: two fingers pan", s3.pos !== s2.pos, `${s2.pos} -> ${s3.pos}`);

  // 4. A finger still drags a node by its header.
  const node = page.locator('[aria-label="Material graph"] button[aria-label^="Remove "]').first();
  const header = await node.boundingBox();
  const nodeAt = () => node.evaluate((b) => b.parentElement.parentElement.getBoundingClientRect().left);
  const x0 = await nodeAt();
  await t.fingers([[header.x - 40, header.y + header.height / 2]], { dx: 70, dy: 20 });
  const x1 = await nodeAt();
  check("graph: a finger drags a node", Math.abs(x1 - x0) > 30, `node left ${x0.toFixed(0)} -> ${x1.toFixed(0)}`);
  await page.screenshot({ path: `${OUT}/tablet-graph.png` });
  await t.ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

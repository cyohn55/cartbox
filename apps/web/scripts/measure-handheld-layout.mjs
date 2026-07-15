/**
 * Measure the handheld's control geometry from the shipped assets so the
 * image-based console can position the screen and place interactive hit-areas
 * over the drawn controls. Reads base.png (chrome) + mask.png (region ids) and
 * writes handheld-layout.json (all rects as 0..1 fractions of the art) plus a
 * debug overlay. Run once when the template art changes:
 *   node --experimental-transform-types apps/web/scripts/measure-handheld-layout.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(here, "../public/handheld");
const base = PNG.sync.read(fs.readFileSync(path.join(DIR, "base.png")));
const mask = PNG.sync.read(fs.readFileSync(path.join(DIR, "mask.png")));
const W = base.width;
const H = base.height;

// Region ids (mask.png red channel), per HANDHELD_REGIONS order.
const REGION = { face: 1, buttonLetter: 2, dpadArrow: 3, lButton: 4, rButton: 5, buttonDiamond: 6, dpadRing: 7 };

const frac = (r) => ({ x: r.x0 / W, y: r.y0 / H, w: (r.x1 - r.x0 + 1) / W, h: (r.y1 - r.y0 + 1) / H });
const emptyRect = () => ({ x0: W, y0: H, x1: -1, y1: -1 });
const grow = (r, x, y) => {
  if (x < r.x0) r.x0 = x;
  if (y < r.y0) r.y0 = y;
  if (x > r.x1) r.x1 = x;
  if (y > r.y1) r.y1 = y;
};

/** Bounding box of every pixel whose mask red channel equals `id`. */
function regionBox(id) {
  const r = emptyRect();
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (mask.data[(y * W + x) * 4] === id) grow(r, x, y);
  }
  return r;
}

/** Connected components (4-neighbour) of pixels matching `id`, as boxes. */
function components(id, minArea) {
  const seen = new Uint8Array(W * H);
  const boxes = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const start = y * W + x;
      if (seen[start] || mask.data[start * 4] !== id) continue;
      const box = emptyRect();
      let area = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % W;
        const py = (p / W) | 0;
        grow(box, px, py);
        area += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const np = ny * W + nx;
          if (!seen[np] && mask.data[np * 4] === id) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }
      if (area >= minArea) boxes.push({ box, area, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2 });
    }
  }
  return boxes;
}

/**
 * The screen is the largest ENCLOSED transparent hole in the base whose centre
 * is in the upper area (the outer background is transparent too, but it touches
 * the image border; the cart slot is enclosed but sits low). Flood transparent
 * regions, drop any that touch the edge, and pick the upper one.
 */
function screenBox() {
  const seen = new Uint8Array(W * H);
  const transparent = (p) => base.data[p * 4 + 3] < 40;
  let best = null;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const start = y * W + x;
      if (seen[start] || !transparent(start)) continue;
      const box = emptyRect();
      let area = 0;
      let touchesEdge = false;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % W;
        const py = (p / W) | 0;
        if (px === 0 || py === 0 || px === W - 1 || py === H - 1) touchesEdge = true;
        grow(box, px, py);
        area += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const np = ny * W + nx;
          if (!seen[np] && transparent(np)) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }
      const centreY = (box.y0 + box.y1) / 2 / H;
      if (touchesEdge || centreY > 0.6) continue; // outer background or cart slot
      if (!best || area > best.area) best = { box, area };
    }
  }
  return best.box;
}

// D-pad: the ring + arrows together give the cross's bounds.
const dpadRing = regionBox(REGION.dpadRing);
const dpadArrow = regionBox(REGION.dpadArrow);
const dpad = { x0: Math.min(dpadRing.x0, dpadArrow.x0), y0: Math.min(dpadRing.y0, dpadArrow.y0), x1: Math.max(dpadRing.x1, dpadArrow.x1), y1: Math.max(dpadRing.y1, dpadArrow.y1) };

// Face buttons: the four letter glyphs are separate blobs (the circles are
// joined by the diamond frame). Use the letters for position, and size each
// hit-area from the whole button cluster. Labels by layout: Y top, X left,
// B right, A bottom.
const diamondBox = regionBox(REGION.buttonDiamond);
const buttonSize = Math.min(diamondBox.x1 - diamondBox.x0, diamondBox.y1 - diamondBox.y0) * 0.34;
const letters = components(REGION.buttonLetter, 30).sort((a, b) => b.area - a.area).slice(0, 4);
if (letters.length < 4) throw new Error(`Expected 4 button letters, found ${letters.length}`);
const boxAround = (c) => ({ x0: c.cx - buttonSize / 2, y0: c.cy - buttonSize / 2, x1: c.cx + buttonSize / 2, y1: c.cy + buttonSize / 2 });
const byY = [...letters].sort((a, b) => a.cy - b.cy);
const byX = [...letters].sort((a, b) => a.cx - b.cx);
const buttons = { y: { box: boxAround(byY[0]) }, a: { box: boxAround(byY[3]) }, x: { box: boxAround(byX[0]) }, b: { box: boxAround(byX[3]) } };

// Select/Start: two dark pills in the gap between the D-pad and the buttons.
// Detect them as dark opaque blobs in that band (left = Select, right = Start).
function darkPills() {
  const seen = new Uint8Array(W * H);
  const dark = (p) => base.data[p * 4 + 3] > 200 && (base.data[p * 4] + base.data[p * 4 + 1] + base.data[p * 4 + 2]) / 3 < 75;
  const boxes = [];
  const [ax, bx, ay, by] = [Math.floor(W * 0.33), Math.floor(W * 0.63), Math.floor(H * 0.7), Math.floor(H * 0.78)];
  for (let y = ay; y < by; y += 1) {
    for (let x = ax; x < bx; x += 1) {
      const s = y * W + x;
      if (seen[s] || !dark(s)) continue;
      const box = emptyRect();
      let area = 0;
      const st = [s];
      seen[s] = 1;
      while (st.length) {
        const p = st.pop();
        const px = p % W;
        const py = (p / W) | 0;
        grow(box, px, py);
        area += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < ax || ny < ay || nx >= bx || ny >= by) continue;
          const np = ny * W + nx;
          if (!seen[np] && dark(np)) {
            seen[np] = 1;
            st.push(np);
          }
        }
      }
      if (area > 120) boxes.push({ box, cx: (box.x0 + box.x1) / 2 });
    }
  }
  return boxes.sort((a, b) => a.cx - b.cx);
}

const pills = darkPills();
const layout = {
  aspect: W / H,
  screen: frac(screenBox()),
  dpad: frac(dpad),
  buttons: Object.fromEntries(Object.entries(buttons).map(([k, v]) => [k, frac(v.box)])),
  // The physical shoulder tabs live on the top-left and top-right edges (not a
  // colour region), so they're placed by proportion.
  shoulders: {
    l: { x: 0.0, y: 0.135, w: 0.055, h: 0.16 },
    r: { x: 0.945, y: 0.135, w: 0.055, h: 0.16 },
  },
  system:
    pills.length >= 2
      ? { select: frac(pills[0].box), start: frac(pills[1].box) }
      : {
          select: { x: 0.37, y: 0.725, w: 0.085, h: 0.022 },
          start: { x: 0.5, y: 0.725, w: 0.085, h: 0.022 },
        },
};

fs.writeFileSync(path.join(DIR, "handheld-layout.json"), JSON.stringify(layout, null, 2));
console.log(JSON.stringify(layout, null, 2));

// Debug overlay: draw each rect on a copy of the base for a visual check.
const dbg = new PNG({ width: W, height: H });
base.data.copy(dbg.data);
const strokeFrac = (r, col) => {
  const x0 = Math.round(r.x * W), y0 = Math.round(r.y * H), x1 = Math.round((r.x + r.w) * W), y1 = Math.round((r.y + r.h) * H);
  for (let x = x0; x <= x1; x += 1) for (const y of [y0, y1]) { const b = (y * W + x) * 4; dbg.data[b] = col[0]; dbg.data[b + 1] = col[1]; dbg.data[b + 2] = col[2]; dbg.data[b + 3] = 255; }
  for (let y = y0; y <= y1; y += 1) for (const x of [x0, x1]) { const b = (y * W + x) * 4; dbg.data[b] = col[0]; dbg.data[b + 1] = col[1]; dbg.data[b + 2] = col[2]; dbg.data[b + 3] = 255; }
};
strokeFrac(layout.screen, [255, 0, 255]);
strokeFrac(layout.dpad, [0, 255, 255]);
for (const r of Object.values(layout.buttons)) strokeFrac(r, [255, 0, 0]);
strokeFrac(layout.shoulders.l, [0, 255, 0]);
strokeFrac(layout.shoulders.r, [0, 255, 0]);
strokeFrac(layout.system.select, [255, 128, 0]);
strokeFrac(layout.system.start, [255, 128, 0]);
fs.writeFileSync("/mnt/c/Temp/cbx-verify/layout-debug.png", PNG.sync.write(dbg));
console.log("debug -> /mnt/c/Temp/cbx-verify/layout-debug.png");

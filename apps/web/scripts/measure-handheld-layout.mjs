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
const REGION = { face: 1, dpadPanel: 2, buttonPanel: 3, decal: 4, text: 5, dpad: 6, buttonColor: 7, dpadArrow: 8, buttonLetter: 9 };

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

// D-pad: the recess panel behind it bounds the cross cleanly. (The dark D-pad
// fill layer also carries the face-button circles, so its own box spans the
// whole width — the panel and arrow masks are the reliable bound.)
const dpadPanel = regionBox(REGION.dpadPanel);
const dpadArrow = regionBox(REGION.dpadArrow);
const dpad = { x0: Math.min(dpadPanel.x0, dpadArrow.x0), y0: Math.min(dpadPanel.y0, dpadArrow.y0), x1: Math.max(dpadPanel.x1, dpadArrow.x1), y1: Math.max(dpadPanel.y1, dpadArrow.y1) };

// Face buttons: the four letter glyphs are separate blobs. Use the letters for
// position, and size each hit-area from the whole button cluster (the recess
// panel behind them). Labels by layout: Y top, X left, B right, A bottom.
const panelBox = regionBox(REGION.buttonPanel);
const buttonSize = Math.min(panelBox.x1 - panelBox.x0, panelBox.y1 - panelBox.y0) * 0.34;
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
  // The pill row sits below the face buttons. Start past the D-pad's right edge
  // so its dark arrow fill can't be mistaken for a pill.
  const [ax, bx, ay, by] = [Math.floor(W * 0.40), Math.floor(W * 0.62), Math.floor(H * 0.72), Math.floor(H * 0.80)];
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
      if (area > 800) boxes.push({ box, cx: (box.x0 + box.x1) / 2 }); // the pills; smaller blobs are letter glyphs
    }
  }
  return boxes.sort((a, b) => a.cx - b.cx);
}

/**
 * The four shoulder buttons sit in a row beneath the screen. This art places
 * them R1, R2 (left) and L1, L2 (right) with the scroll wheel between. They are
 * uniform dark button pills on the chassis, so detect dark blobs in that band
 * and keep the four button-sized ones, ordered left to right. The scroll wheel
 * has no colour region of its own; it occupies the gap between the inner two.
 */
function shoulderButtons() {
  const dark = (p) => base.data[p * 4 + 3] > 180 && (base.data[p * 4] + base.data[p * 4 + 1] + base.data[p * 4 + 2]) / 3 < 90;
  const [ay, by] = [Math.floor(H * 0.55), Math.floor(H * 0.645)];
  const seen = new Uint8Array(W * H);
  const blobs = [];
  for (let y = ay; y < by; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const s = y * W + x;
      if (seen[s] || !dark(s)) continue;
      const box = emptyRect();
      let area = 0;
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % W;
        const py = (p / W) | 0;
        grow(box, px, py);
        area += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < ay || nx >= W || ny >= by) continue;
          const np = ny * W + nx;
          if (!seen[np] && dark(np)) { seen[np] = 1; stack.push(np); }
        }
      }
      const w = (box.x1 - box.x0 + 1) / W;
      const h = (box.y1 - box.y0 + 1) / H;
      // Keep only button-sized blobs — this drops the side rails and the
      // full-width recess shelf the buttons sit on.
      if (w >= 0.08 && w <= 0.13 && h >= 0.02 && h <= 0.045) blobs.push(box);
    }
  }
  return blobs.sort((a, b) => a.x0 + a.x1 - (b.x0 + b.x1));
}

const shoulderBoxes = shoulderButtons();
if (shoulderBoxes.length !== 4) throw new Error(`Expected 4 shoulder buttons, found ${shoulderBoxes.length}`);
// Authored order, left to right: L2, L1, (wheel), R1, R2.
const [l2Box, l1Box, r1Box, r2Box] = shoulderBoxes;
// The wheel lives between the inner two shoulders (L1 and R1), inset from each so
// its hit-area doesn't overlap them.
const wheelGap = r1Box.x0 - l1Box.x1;
const wheelBox = {
  x0: l1Box.x1 + Math.round(wheelGap * 0.16),
  x1: r1Box.x0 - Math.round(wheelGap * 0.16),
  y0: Math.min(l1Box.y0, r1Box.y0),
  y1: Math.max(l1Box.y1, r1Box.y1),
};

const pills = darkPills();
const layout = {
  aspect: W / H,
  screen: frac(screenBox()),
  dpad: frac(dpad),
  buttons: Object.fromEntries(Object.entries(buttons).map(([k, v]) => [k, frac(v.box)])),
  // Four shoulder buttons in a row beneath the screen, detected from the art:
  // left pair is R1/R2, right pair is L1/L2 (as authored).
  shoulders: {
    r1: frac(r1Box),
    r2: frac(r2Box),
    l1: frac(l1Box),
    l2: frac(l2Box),
  },
  wheel: frac(wheelBox),
  system:
    pills.length >= 2
      ? { select: frac(pills[0].box), start: frac(pills[1].box) }
      : {
          select: { x: 0.364, y: 0.772, w: 0.085, h: 0.02 },
          start: { x: 0.503, y: 0.772, w: 0.085, h: 0.02 },
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
for (const r of Object.values(layout.shoulders)) strokeFrac(r, [0, 255, 0]);
strokeFrac(layout.wheel, [0, 128, 255]);
strokeFrac(layout.system.select, [255, 128, 0]);
strokeFrac(layout.system.start, [255, 128, 0]);
fs.writeFileSync("/mnt/c/Temp/cbx-verify/layout-debug.png", PNG.sync.write(dbg));
console.log("debug -> /mnt/c/Temp/cbx-verify/layout-debug.png");

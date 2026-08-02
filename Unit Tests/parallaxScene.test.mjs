/**
 * Tests the runtime parallax + atmosphere compositor (Working/cinematic-artstyle/
 * parallaxScene.ts, gap #3). Assertions are relational — a near layer parallaxes
 * more than a far one, distant colours desaturate and haze toward fog, painter's
 * order puts near over far — not memorised pixels, so real behaviour is pinned.
 *
 * Run: node --experimental-transform-types "Unit Tests/parallaxScene.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(here, "../packages/player/src/scene/parallaxScene.ts");
const { composeParallax, hazeColor, parallaxOf } = await import(pathToFileURL(modPath).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// A solid WxH layer of one colour, fully opaque.
function solidLayer(w, h, [r, g, b], depth, extra = {}) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    pixels[i * 4] = r; pixels[i * 4 + 1] = g; pixels[i * 4 + 2] = b; pixels[i * 4 + 3] = 255;
  }
  return { pixels, width: w, height: h, depth, ...extra };
}
// A layer with one opaque column at x, else transparent — to track parallax shift.
function markerLayer(w, h, x, depth) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const i = (y * w + x) * 4;
    pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255;
  }
  return { pixels, width: w, height: h, depth, wrapX: false };
}
const px = (buf, w, x, y) => {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
};
// The marker is the only opaque column (background stays alpha 0); its colour may
// be hazed when the layer is far, so key on alpha alone, not on white.
const firstOpaqueX = (buf, w, h, y = 0) => {
  for (let x = 0; x < w; x += 1) if (buf[(y * w + x) * 4 + 3] === 255) return x;
  return -1;
};

const ATMO = { fog: [120, 140, 190], density: 0.85, desaturate: 0.7, lift: 0.4 };

test("parallaxOf: nearer layers (low depth) move more than far ones", () => {
  assert.ok(parallaxOf({ depth: 0 }) > parallaxOf({ depth: 0.5 }));
  assert.ok(parallaxOf({ depth: 0.5 }) > parallaxOf({ depth: 1 }));
  assert.equal(parallaxOf({ depth: 0.3, parallax: 0.9 }), 0.9); // explicit override wins
});

test("hazeColor: no haze is identity; full haze pulls toward fog", () => {
  const c = [200, 60, 40];
  assert.deepEqual(hazeColor(c, 0, ATMO), c);
  const far = hazeColor(c, 1, ATMO);
  // each channel moves toward the fog colour
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(far[i] - ATMO.fog[i]) < Math.abs(c[i] - ATMO.fog[i]), `channel ${i} hazes toward fog`);
  }
});

test("hazeColor: distance desaturates — a far colour's channel spread shrinks", () => {
  const c = [220, 40, 30];
  const spread = (t) => { const h = hazeColor(c, t, ATMO); return Math.max(...h) - Math.min(...h); };
  assert.ok(spread(1) < spread(0.2), "farther = less saturated (smaller channel spread)");
});

test("a near layer shifts more than a far layer for the same camera pan", () => {
  const W = 40, H = 4, CAM = { x: 10, y: 0 };
  const nearOut = new Uint8ClampedArray(W * H * 4);
  const farOut = new Uint8ClampedArray(W * H * 4);
  composeParallax(nearOut, W, H, [markerLayer(W, H, 20, 0.0)], CAM, ATMO);
  composeParallax(farOut, W, H, [markerLayer(W, H, 20, 0.9)], CAM, ATMO);
  const nearX = firstOpaqueX(nearOut, W, H);
  const farX = firstOpaqueX(farOut, W, H);
  // camera panned right (+x) → layers shift left; the near layer shifts further left.
  assert.ok(nearX >= 0 && farX >= 0, "both markers rendered");
  assert.ok(20 - nearX > 20 - farX, `near shifted ${20 - nearX}px > far ${20 - farX}px`);
});

test("painter's order: a near opaque layer covers a far one", () => {
  const W = 4, H = 4;
  const out = new Uint8ClampedArray(W * H * 4);
  const far = solidLayer(W, H, [200, 30, 30], 1.0);
  const near = solidLayer(W, H, [30, 200, 30], 0.0);
  composeParallax(out, W, H, [near, far], { x: 0, y: 0 }, { ...ATMO, density: 0 });
  assert.deepEqual(px(out, W, 1, 1), [30, 200, 30, 255], "near green wins over far red");
});

test("the same layer reads dimmer/hazier when placed farther away", () => {
  const W = 4, H = 4;
  const nearOut = new Uint8ClampedArray(W * H * 4);
  const farOut = new Uint8ClampedArray(W * H * 4);
  composeParallax(nearOut, W, H, [solidLayer(W, H, [210, 70, 50], 0.0)], { x: 0, y: 0 }, ATMO);
  composeParallax(farOut, W, H, [solidLayer(W, H, [210, 70, 50], 1.0)], { x: 0, y: 0 }, ATMO);
  const near = px(nearOut, W, 1, 1), far = px(farOut, W, 1, 1);
  // the far one is closer to the fog colour on every channel
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(far[i] - ATMO.fog[i]) < Math.abs(near[i] - ATMO.fog[i]), `channel ${i} hazier when far`);
  }
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nparallaxScene: ${passed}/${cases.length} passed`);

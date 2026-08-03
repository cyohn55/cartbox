/**
 * Tests the gap-#1 scene-layer animation overrides: the new composeParallax
 * per-layer params (opacity / offsetX / emissive) and SceneBackdropSurface's
 * setLayerOverrides that drives them per frame. All relational (no hard-coded
 * pixels beyond what the inputs imply), against solid layers so the arithmetic is
 * visible. Confirms the overrides never touch baked layer pixels, keeping the
 * pre-haze cache valid.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/anim-scene-overrides.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../packages/player/src/scene");
const { composeParallax } = await import(pathToFileURL(path.join(dir, "parallaxScene.ts")).href);
const { SceneBackdropSurface } = await import(pathToFileURL(path.join(dir, "SceneBackdropSurface.ts")).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const NO_HAZE = { fog: [0, 0, 0], density: 0, desaturate: 0, lift: 0 };
const px = (b, w, x, y) => { const i = (y * w + x) * 4; return [b[i], b[i + 1], b[i + 2]]; };

function solidLayer(w, h, color, over = {}) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = 255;
  }
  // depth 0 so composeParallax applies no haze regardless of the hazed flag.
  return { pixels, width: w, height: h, depth: 0, wrapX: true, offsetY: 0, ...over };
}

// ---- composeParallax params ---------------------------------------------------

test("opacity multiplies the layer's alpha", () => {
  const out = new Uint8ClampedArray(4); // black, alpha 0
  composeParallax(out, 1, 1, [solidLayer(1, 1, [200, 100, 40], { opacity: 0.5 })], { x: 0, y: 0 }, NO_HAZE);
  assert.deepEqual(px(out, 1, 0, 0), [100, 50, 20], "half-blended over black");
});

test("opacity 0 makes the layer contribute nothing", () => {
  const out = new Uint8ClampedArray([5, 6, 7, 255]);
  composeParallax(out, 1, 1, [solidLayer(1, 1, [200, 100, 40], { opacity: 0 })], { x: 0, y: 0 }, NO_HAZE);
  assert.deepEqual(px(out, 1, 0, 0), [5, 6, 7], "background untouched");
});

test("emissive gains the layer's RGB (and the clamped output caps overshoot)", () => {
  const out = new Uint8ClampedArray(4);
  composeParallax(out, 1, 1, [solidLayer(1, 1, [100, 100, 100], { emissive: 2 })], { x: 0, y: 0 }, NO_HAZE);
  assert.deepEqual(px(out, 1, 0, 0), [200, 200, 200], "doubled");
  const out2 = new Uint8ClampedArray(4);
  composeParallax(out2, 1, 1, [solidLayer(1, 1, [200, 200, 200], { emissive: 4 })], { x: 0, y: 0 }, NO_HAZE);
  assert.deepEqual(px(out2, 1, 0, 0), [255, 255, 255], "clamped at 255");
});

test("offsetX shifts where a non-wrapping layer lands", () => {
  const W = 20;
  const marker = new Uint8ClampedArray(W * 4);
  marker.set([255, 255, 255, 255], 10 * 4); // opaque column at source x=10
  const layer = { pixels: marker, width: W, height: 1, depth: 0, wrapX: false, offsetY: 0 };
  const markerX = (buf) => { for (let x = 0; x < W; x += 1) if (buf[x * 4] === 255) return x; return -1; };

  const a = new Uint8ClampedArray(W * 4);
  composeParallax(a, W, 1, [layer], { x: 0, y: 0 }, NO_HAZE);
  const b = new Uint8ClampedArray(W * 4);
  composeParallax(b, W, 1, [{ ...layer, offsetX: 5 }], { x: 0, y: 0 }, NO_HAZE);
  assert.equal(markerX(b) - markerX(a), 5, "offsetX moved the marker by 5px");
});

// ---- SceneBackdropSurface.setLayerOverrides -----------------------------------

const KEY = [10, 12, 22];
const SPEC = { layers: [], atmosphere: NO_HAZE, camera: { autoScrollX: 0 }, keyColor: 0 };
function fakeInner() {
  return { last: null, blit(rgba) { this.last = rgba.slice(); }, destroy() {} };
}
const keyFrame = (w, h) => { const f = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i += 1) f.set([...KEY, 255], i * 4); return f; };

test("setLayerOverrides opacity 0 removes a backdrop layer for that frame only", () => {
  const W = 1, H = 1;
  const inner = fakeInner();
  const surface = new SceneBackdropSurface(inner, W, H, [solidLayer(1, 1, [200, 50, 50])], SPEC, KEY);

  surface.setLayerOverrides({ 0: { opacity: 0 } });
  surface.blit(keyFrame(W, H));
  assert.notDeepEqual(px(inner.last, W, 0, 0), [200, 50, 50], "layer hidden this frame");

  surface.setLayerOverrides(null);
  surface.blit(keyFrame(W, H));
  assert.deepEqual(px(inner.last, W, 0, 0), [200, 50, 50], "layer restored when overrides cleared");
});

test("setLayerOverrides offsetX slides a layer relative to no override", () => {
  const W = 20, H = 1;
  const marker = new Uint8ClampedArray(W * 4);
  marker.set([255, 255, 255, 255], 8 * 4);
  const layer = { pixels: marker, width: W, height: 1, depth: 0, wrapX: false, offsetY: 0 };
  const markerX = (buf) => { for (let x = 0; x < W; x += 1) if (buf[x * 4] === 255) return x; return -1; };

  const inner = fakeInner();
  const surface = new SceneBackdropSurface(inner, W, H, [layer], SPEC, KEY);
  surface.blit(keyFrame(W, H));
  const base = markerX(inner.last);
  surface.setLayerOverrides({ 0: { offsetX: 4 } });
  surface.blit(keyFrame(W, H));
  const shifted = markerX(inner.last);
  assert.equal(shifted - base, 4, "override shifted the layer by 4px");
});

test("overrides do not mutate the cached layer pixels (prehaze cache stays valid)", () => {
  const W = 1, H = 1;
  const inner = fakeInner();
  const layer = solidLayer(1, 1, [200, 50, 50]);
  const before = layer.pixels.slice();
  const surface = new SceneBackdropSurface(inner, W, H, [layer], SPEC, KEY);
  surface.setLayerOverrides({ 0: { opacity: 0.3, emissive: 2, offsetX: 3 } });
  surface.blit(keyFrame(W, H));
  assert.deepEqual([...layer.pixels], [...before], "source layer pixels untouched");
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nanim-scene-overrides: ${passed}/${cases.length} passed`);

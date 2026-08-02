/**
 * Tests SceneBackdropSurface (packages/player/src/scene/SceneBackdropSurface.ts):
 * the decorator that composites a parallax backdrop behind the cart's frame and
 * presents it through an inner surface. Driven against a fake inner surface that
 * records blits — no browser — so the composite (background → backdrop, foreground
 * kept), the per-frame camera advance, and destroy-delegation are all pinned.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/scene-surface.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const surfPath = path.resolve(here, "../packages/player/src/scene/SceneBackdropSurface.ts");
const { SceneBackdropSurface } = await import(pathToFileURL(surfPath).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const KEY = [10, 12, 22];
const SPEC = { layers: [], atmosphere: { fog: [110, 130, 185], density: 0, desaturate: 0, lift: 0 }, camera: { autoScrollX: 0 }, keyColor: 0 };
// density 0 → the backdrop layers keep their own colour (no haze), easy to assert.

function solidLayer(w, h, color, over = {}) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = 255;
  }
  return { pixels, width: w, height: h, depth: 0, wrapX: true, offsetY: 0, ...over };
}
// A fake inner surface that keeps the last blitted frame.
function fakeInner() {
  return { last: null, destroyed: false, blit(rgba) { this.last = rgba.slice(); }, destroy() { this.destroyed = true; } };
}
const px = (b, w, x, y) => { const i = (y * w + x) * 4; return [b[i], b[i + 1], b[i + 2]]; };

test("background (key) pixels show the backdrop; foreground is kept", () => {
  const W = 2, H = 1;
  const inner = fakeInner();
  const layers = [solidLayer(W, H, [200, 50, 50])];
  const surface = new SceneBackdropSurface(inner, W, H, layers, SPEC, KEY);

  const frame = new Uint8Array(W * H * 4);
  // x0 = background (key), x1 = a foreground colour
  frame.set([...KEY, 255], 0);
  frame.set([240, 230, 20, 255], 4);
  surface.blit(frame);

  assert.deepEqual(px(inner.last, W, 0, 0), [200, 50, 50], "background → backdrop layer colour");
  assert.deepEqual(px(inner.last, W, 1, 0), [240, 230, 20], "foreground pixel kept");
});

test("the camera advances each frame (backdrop scrolls)", () => {
  const W = 40, H = 1;
  const inner = fakeInner();
  // A non-wrapping near marker layer: one opaque white column at x=20.
  const pixels = new Uint8ClampedArray(W * H * 4);
  pixels.set([255, 255, 255, 255], 20 * 4);
  const layers = [{ pixels, width: W, height: H, depth: 0, wrapX: false, offsetY: 0 }];
  const spec = { ...SPEC, camera: { autoScrollX: 3 } };
  const surface = new SceneBackdropSurface(inner, W, H, layers, spec, KEY);

  const bg = new Uint8Array(W * H * 4);
  for (let x = 0; x < W; x += 1) bg.set([...KEY, 255], x * 4); // all background → all backdrop

  const markerX = (buf) => { for (let x = 0; x < W; x += 1) if (buf[x * 4] === 255) return x; return -1; };
  surface.blit(bg); const a = markerX(inner.last);
  surface.blit(bg); const b = markerX(inner.last);
  assert.ok(a >= 0 && b >= 0, "marker rendered both frames");
  assert.ok(b < a, `camera advanced: marker slid left (${a} → ${b})`);
});

test("destroy delegates to the inner surface", () => {
  const inner = fakeInner();
  const surface = new SceneBackdropSurface(inner, 1, 1, [solidLayer(1, 1, [0, 0, 0])], SPEC, KEY);
  surface.destroy();
  assert.equal(inner.destroyed, true);
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nscene-surface: ${passed}/${cases.length} passed`);

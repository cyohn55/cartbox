/**
 * Tests the gap-#3 part-3 keyed composite (Working/cinematic-artstyle/
 * sceneComposite.ts): the cart's background colour is replaced by the backdrop,
 * foreground pixels are kept, and the tolerance widens the key match. Assertions
 * are on the composited pixels given known inputs — the whole point of the pass.
 *
 * Run: node --experimental-transform-types "Unit Tests/scene-composite.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { compositeOverBackdrop } = await import(
  pathToFileURL(path.resolve(here, "../packages/player/src/scene/sceneComposite.ts")).href
);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// Build a WxH RGBA buffer from a per-pixel colour function.
function buf(w, h, fn) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const [r, g, b] = fn(x, y);
    const i = (y * w + x) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  }
  return out;
}
const px = (b, w, x, y) => { const i = (y * w + x) * 4; return [b[i], b[i + 1], b[i + 2]]; };

const KEY = [8, 10, 18]; // the cart's background colour

test("key-coloured cart pixels are replaced by the backdrop", () => {
  const W = 2, H = 1;
  const cart = buf(W, H, () => KEY);             // all background
  const back = buf(W, H, () => [200, 100, 50]);  // backdrop
  const out = compositeOverBackdrop(cart, back, W, H, KEY);
  assert.deepEqual(px(out, W, 0, 0), [200, 100, 50]);
  assert.deepEqual(px(out, W, 1, 0), [200, 100, 50]);
});

test("foreground (non-key) pixels are kept over the backdrop", () => {
  const W = 2, H = 1;
  const cart = buf(W, H, (x) => (x === 0 ? KEY : [255, 220, 120])); // x0 bg, x1 fg
  const back = buf(W, H, () => [30, 40, 60]);
  const out = compositeOverBackdrop(cart, back, W, H, KEY);
  assert.deepEqual(px(out, W, 0, 0), [30, 40, 60], "background → backdrop");
  assert.deepEqual(px(out, W, 1, 0), [255, 220, 120], "foreground kept");
});

test("tolerance widens the key so near-background pixels also show the backdrop", () => {
  const W = 1, H = 1;
  const cart = buf(W, H, () => [12, 14, 22]); // 4 off the key on each channel
  const back = buf(W, H, () => [90, 90, 90]);
  const exact = compositeOverBackdrop(cart, back, W, H, KEY, 0);
  assert.deepEqual(px(exact, W, 0, 0), [12, 14, 22], "exact match keeps the near pixel");
  const loose = compositeOverBackdrop(cart, back, W, H, KEY, 6);
  assert.deepEqual(px(loose, W, 0, 0), [90, 90, 90], "tolerance 6 keys it out");
});

test("a supplied out buffer is written and returned (no allocation)", () => {
  const W = 1, H = 1;
  const cart = buf(W, H, () => KEY);
  const back = buf(W, H, () => [1, 2, 3]);
  const out = new Uint8ClampedArray(W * H * 4);
  const ret = compositeOverBackdrop(cart, back, W, H, KEY, 0, out);
  assert.equal(ret, out, "returns the same buffer");
  assert.deepEqual(px(out, W, 0, 0), [1, 2, 3]);
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nscene-composite: ${passed}/${cases.length} passed`);

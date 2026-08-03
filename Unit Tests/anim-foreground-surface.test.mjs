/**
 * Tests AnimatedForegroundSurface (packages/player/src/anim/AnimatedForegroundSurface.ts):
 * the decorator that composites animated placements over the presented frame.
 * Driven against a fake inner surface + a stub region source (no browser/WASM) so
 * the pass-through fast path, positioned/scaled/alpha compositing, painter order,
 * region caching, and destroy-delegation are all pinned.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/anim-foreground-surface.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const surfPath = path.resolve(here, "../packages/player/src/anim/AnimatedForegroundSurface.ts");
const { AnimatedForegroundSurface } = await import(pathToFileURL(surfPath).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// A fake inner surface that keeps the last blitted frame.
function fakeInner() {
  return { last: null, destroyed: false, blit(rgba) { this.last = rgba.slice(); }, destroy() { this.destroyed = true; } };
}
// A region source returning a solid-colour region of a fixed size, counting reads.
function stubSource(width, height, color) {
  return {
    reads: 0,
    readRegion() {
      this.reads += 1;
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = 255;
      }
      return { pixels, width, height };
    },
  };
}
const px = (b, w, x, y) => { const i = (y * w + x) * 4; return [b[i], b[i + 1], b[i + 2]]; };
const placement = (over = {}) => ({ region: { page: 0, tile: 0, tilesW: 1, tilesH: 1 }, frameIndex: 0, x: 0, y: 0, opacity: 1, scale: 1, depth: 0, ...over });
const blackFrame = (w, h) => new Uint8Array(w * h * 4);

test("no placements → the frame passes straight through unchanged", () => {
  const W = 2, H = 1;
  const inner = fakeInner();
  const surface = new AnimatedForegroundSurface(inner, W, H, stubSource(1, 1, [255, 0, 0]));
  const frame = new Uint8Array([9, 9, 9, 255, 8, 8, 8, 255]);
  surface.setPlacements([]);
  surface.blit(frame);
  assert.deepEqual([...inner.last], [...frame]);
});

test("an opaque placement lands at its position over the frame", () => {
  const W = 3, H = 1;
  const inner = fakeInner();
  const surface = new AnimatedForegroundSurface(inner, W, H, stubSource(1, 1, [200, 40, 40]));
  surface.setPlacements([placement({ x: 1, y: 0 })]);
  surface.blit(blackFrame(W, H));
  assert.deepEqual(px(inner.last, W, 0, 0), [0, 0, 0], "untouched pixel");
  assert.deepEqual(px(inner.last, W, 1, 0), [200, 40, 40], "placement pixel");
});

test("opacity blends the placement over the frame (straight-alpha)", () => {
  const W = 1, H = 1;
  const inner = fakeInner();
  const surface = new AnimatedForegroundSurface(inner, W, H, stubSource(1, 1, [200, 0, 0]));
  surface.setPlacements([placement({ opacity: 0.5 })]);
  surface.blit(blackFrame(W, H));
  assert.deepEqual(px(inner.last, W, 0, 0), [100, 0, 0], "lerp(0, 200, 0.5)");
});

test("scale enlarges the placement footprint (nearest-neighbour)", () => {
  const W = 2, H = 2;
  const inner = fakeInner();
  const surface = new AnimatedForegroundSurface(inner, W, H, stubSource(1, 1, [10, 220, 10]));
  surface.setPlacements([placement({ scale: 2 })]); // 1x1 → 2x2
  surface.blit(blackFrame(W, H));
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    assert.deepEqual(px(inner.last, W, x, y), [10, 220, 10], `covered (${x},${y})`);
  }
});

test("placements are drawn far-first so nearer depth wins overlap", () => {
  const W = 1, H = 1;
  const inner = fakeInner();
  const surface = new AnimatedForegroundSurface(inner, W, H, stubSource(1, 1, [0, 0, 0]));
  // Two overlapping opaque placements; the source colour is the same, so instead
  // assert ordering via a source that colours by the region tile.
  const source = {
    readRegion(_page, tile) {
      const color = tile === 1 ? [255, 0, 0] : [0, 0, 255];
      const pixels = new Uint8ClampedArray(4);
      pixels.set([...color, 255], 0);
      return { pixels, width: 1, height: 1 };
    },
  };
  const surf = new AnimatedForegroundSurface(inner, W, H, source);
  surf.setPlacements([
    placement({ region: { page: 0, tile: 1, tilesW: 1, tilesH: 1 }, depth: 0 }),   // near (red)
    placement({ region: { page: 0, tile: 2, tilesW: 1, tilesH: 1 }, depth: 1 }),   // far (blue)
  ]);
  surf.blit(blackFrame(W, H));
  assert.deepEqual(px(inner.last, W, 0, 0), [255, 0, 0], "near (depth 0) drawn over far");
});

test("region pixels are read once and cached across frames", () => {
  const W = 1, H = 1;
  const inner = fakeInner();
  const source = stubSource(1, 1, [1, 2, 3]);
  const surface = new AnimatedForegroundSurface(inner, W, H, source);
  surface.setPlacements([placement()]);
  surface.blit(blackFrame(W, H));
  surface.blit(blackFrame(W, H));
  surface.blit(blackFrame(W, H));
  assert.equal(source.reads, 1, "same region key read only once");
});

test("destroy delegates to the inner surface", () => {
  const inner = fakeInner();
  const surface = new AnimatedForegroundSurface(inner, 1, 1, stubSource(1, 1, [0, 0, 0]));
  surface.destroy();
  assert.equal(inner.destroyed, true);
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nanim-foreground-surface: ${passed}/${cases.length} passed`);

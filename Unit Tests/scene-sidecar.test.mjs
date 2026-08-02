/**
 * Tests the gap-#3 scene sidecar model + backdrop renderer (Working/
 * cinematic-artstyle/sceneModel.ts + sceneRender.ts). Parsing is checked for
 * defensive validation (untrusted JSON → safe SceneSpec, bad layers dropped);
 * rendering is checked relationally (a layer's region becomes a parallax layer,
 * the camera auto-scrolls, a far layer hazes toward fog) rather than by pixels.
 *
 * Run: node --experimental-transform-types "Unit Tests/scene-sidecar.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../packages/player/src/scene");
const { parseScene, DEFAULT_ATMOSPHERE } = await import(pathToFileURL(path.join(dir, "sceneModel.ts")).href);
const { resolveSceneLayers, cameraAt, renderSceneBackdrop, fillSky } =
  await import(pathToFileURL(path.join(dir, "sceneRender.ts")).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const region = (over = {}) => ({ page: 0, tile: 1, tilesW: 2, tilesH: 2, ...over });
const layer = (over = {}) => ({ source: region(), depth: 0.5, ...over });

// A source that returns a solid-colour region of the requested tile size.
function solidSource(color) {
  return {
    readRegion(page, tile, tilesW, tilesH) {
      const width = tilesW * 8, height = tilesH * 8;
      const pixels = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i += 1) {
        pixels[i * 4] = color[0]; pixels[i * 4 + 1] = color[1]; pixels[i * 4 + 2] = color[2]; pixels[i * 4 + 3] = 255;
      }
      return { pixels, width, height };
    },
  };
}
const px = (buf, w, x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]; };

// --- parseScene ---

test("non-objects and empty layer lists yield no scene", () => {
  assert.equal(parseScene(null), null);
  assert.equal(parseScene(42), null);
  assert.equal(parseScene({ layers: [] }), null);
  assert.equal(parseScene({ layers: [{ depth: 0.5 }] }), null, "a layer with no valid source is dropped");
});

test("a valid scene parses, defaulting atmosphere + camera", () => {
  const spec = parseScene({ layers: [layer()] });
  assert.equal(spec.layers.length, 1);
  assert.deepEqual(spec.atmosphere, DEFAULT_ATMOSPHERE);
  assert.equal(spec.camera.autoScrollX, 0);
});

test("depth is clamped to 0..1 and parallax to 0..4", () => {
  const spec = parseScene({ layers: [layer({ depth: 5, parallax: -9 }), layer({ depth: -2, parallax: 99 })] });
  assert.equal(spec.layers[0].depth, 1);
  assert.equal(spec.layers[0].parallax, 0);
  assert.equal(spec.layers[1].depth, 0);
  assert.equal(spec.layers[1].parallax, 4);
});

test("malformed layers are dropped, valid ones kept, capped at 8", () => {
  const many = Array.from({ length: 20 }, () => layer());
  const spec = parseScene({ layers: [layer(), "nope", { source: null }, ...many] });
  assert.ok(spec.layers.length <= 8, "capped at MAX_LAYERS");
});

test("atmosphere fields are validated and clamped", () => {
  const spec = parseScene({
    layers: [layer()],
    atmosphere: { fog: [300, -5, 128], density: 2, desaturate: "x", lift: 0.3 },
  });
  assert.deepEqual(spec.atmosphere.fog, [255, 0, 128]);
  assert.equal(spec.atmosphere.density, 1);
  assert.equal(spec.atmosphere.desaturate, DEFAULT_ATMOSPHERE.desaturate); // non-number → default
  assert.equal(spec.atmosphere.lift, 0.3);
});

// --- resolveSceneLayers / cameraAt ---

test("resolve reads each region and carries the layer's depth + placement", () => {
  const spec = parseScene({ layers: [layer({ depth: 0.8, offsetY: 12, wrapX: false, parallax: 0.3 })] });
  const layers = resolveSceneLayers(spec, solidSource([200, 100, 50]));
  assert.equal(layers.length, 1);
  assert.equal(layers[0].width, 16); // tilesW 2 * 8
  assert.equal(layers[0].height, 16);
  assert.equal(layers[0].depth, 0.8);
  assert.equal(layers[0].offsetY, 12);
  assert.equal(layers[0].wrapX, false);
  assert.equal(layers[0].parallax, 0.3);
});

test("cameraAt applies auto-scroll per frame on top of a base offset", () => {
  const spec = parseScene({ layers: [layer()], camera: { autoScrollX: 2, autoScrollY: -1 } });
  assert.deepEqual(cameraAt(spec, 0), { x: 0, y: 0 });
  assert.deepEqual(cameraAt(spec, 10), { x: 20, y: -10 });
  assert.deepEqual(cameraAt(spec, 10, { x: 100, y: 0 }), { x: 120, y: -10 });
});

// --- renderSceneBackdrop ---

test("fillSky lays a dark-zenith → fog-horizon gradient", () => {
  const W = 2, H = 40;
  const out = new Uint8ClampedArray(W * H * 4);
  fillSky(out, W, H, DEFAULT_ATMOSPHERE);
  const top = px(out, W, 0, 0), bottom = px(out, W, 0, H - 1);
  assert.ok(bottom[2] > top[2], "horizon is brighter/bluer than the zenith");
});

test("a far layer renders hazed toward fog over the sky", () => {
  const W = 16, H = 16;
  const spec = parseScene({ layers: [layer({ depth: 1.0, source: region({ tilesW: 2, tilesH: 2 }) })] });
  const layers = resolveSceneLayers(spec, solidSource([220, 40, 30])); // vivid red
  const out = new Uint8ClampedArray(W * H * 4);
  renderSceneBackdrop(out, W, H, layers, spec, 0);
  const mid = px(out, W, 8, 8);
  // The vivid red is pulled toward the cool fog by full-depth atmosphere.
  assert.ok(mid[0] < 220 && mid[2] > 30, "distant red desaturates + hazes cool");
});

test("the backdrop scrolls: a non-wrapping near layer moves with the camera", () => {
  const W = 40, H = 8;
  const spec = parseScene({ layers: [layer({ depth: 0, wrapX: false, source: region({ tilesW: 1, tilesH: 1 }) })], camera: { autoScrollX: 3 } });
  const layers = resolveSceneLayers(spec, solidSource([255, 255, 255]));
  const firstOpaque = (out) => { for (let x = 0; x < W; x += 1) if (out[(4 * (0 * W + x)) + 3] === 255 && out[x * 4] > 200) return x; return -1; };
  const a = new Uint8ClampedArray(W * H * 4); renderSceneBackdrop(a, W, H, layers, spec, 0);
  const b = new Uint8ClampedArray(W * H * 4); renderSceneBackdrop(b, W, H, layers, spec, 4);
  // camera moved right → near layer (parallax 1) shifts left between frame 0 and 4.
  assert.ok(firstOpaque(b) < firstOpaque(a), "the near layer slid left as the camera panned");
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nscene-sidecar: ${passed}/${cases.length} passed`);

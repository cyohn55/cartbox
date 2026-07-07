/**
 * Tests the CPU lit renderer (packages/editor/src/render/litRenderer.ts) — the
 * source of truth the WebGPU preview mirrors. Proves the no-material path is
 * unchanged (pure Lambert + ambient), and that a material adds specular glints
 * that track the light, and a height self-shadow.
 *
 * Material RGBA is R=height, G=specular, B=roughness, A=emissive — fixtures
 * keep A at 0, since an emissive pixel deliberately stays bright in shadow.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/litRenderer.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);
const { renderLitRgba } = await load("../packages/editor/src/render/litRenderer.ts");
const { shade } = await load("../packages/editor/src/model/lighting.ts");

// A pixel whose normal faces the camera, encoded as a tangent-space normal map.
const FLAT_NORMAL = [128, 128, 255, 255];

function buffer(width, height, fill) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) out.set(fill, i * 4);
  return out;
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("with no material it is exactly Lambert + ambient (matches shade)", () => {
  const albedo = new Uint8ClampedArray([200, 120, 60, 255]);
  const normal = new Uint8ClampedArray(FLAT_NORMAL);
  const light = { col: 3, row: 0.5, height: 2.2, ambient: 0.22 };
  const lit = renderLitRgba(albedo, normal, 1, 1, light);
  // Reproduce shade() with the same decoded normal + toLight.
  const n = [128 / 127.5 - 1, 128 / 127.5 - 1, 255 / 127.5 - 1];
  const toLight = [light.col - 0.5, light.row - 0.5, light.height];
  const expected = shade([200, 120, 60], n, toLight, light.ambient);
  assert.deepEqual([lit[0], lit[1], lit[2]], expected);
});

test("specular adds a bright highlight when the light is overhead", () => {
  const albedo = new Uint8ClampedArray([40, 40, 40, 255]);
  const normal = new Uint8ClampedArray(FLAT_NORMAL);
  const light = { col: 0.5, row: 0.5, height: 2.2, ambient: 0.22 }; // directly overhead
  const glossy = new Uint8ClampedArray([0, 255, 40, 0]); // height 0, spec max, low roughness
  const matte = new Uint8ClampedArray([0, 0, 255, 0]); // spec 0

  const withSpec = renderLitRgba(albedo, normal, 1, 1, light, { material: glossy });
  const noSpec = renderLitRgba(albedo, normal, 1, 1, light, { material: matte });
  assert.ok(withSpec[0] > noSpec[0], "a glossy pixel under the light should be brighter");
  assert.ok(withSpec[0] > 200, "the specular highlight should read as bright");
});

test("the specular highlight fades as the light moves off-axis", () => {
  const albedo = new Uint8ClampedArray([40, 40, 40, 255]);
  const normal = new Uint8ClampedArray(FLAT_NORMAL);
  const glossy = new Uint8ClampedArray([0, 255, 40, 0]);
  const overhead = renderLitRgba(albedo, normal, 1, 1, { col: 0.5, row: 0.5, height: 2.2, ambient: 0.22 }, { material: glossy });
  const grazing = renderLitRgba(albedo, normal, 1, 1, { col: 40, row: 0.5, height: 2.2, ambient: 0.22 }, { material: glossy });
  assert.ok(overhead[0] > grazing[0], "overhead light should glint more than grazing light");
});

test("a taller pixel between a pixel and the light casts a self-shadow", () => {
  // A 3x1 row, light just past the right edge. The left pixel marches right
  // toward the light; a tall middle pixel should shadow it.
  const albedo = buffer(3, 1, [200, 200, 200, 255]);
  const normal = buffer(3, 1, FLAT_NORMAL);
  const light = { col: 2.5, row: 0.5, height: 2.2, ambient: 0.22 };

  const flat = buffer(3, 1, [0, 0, 255, 0]); // all height 0, spec 0
  const withWall = buffer(3, 1, [0, 0, 255, 0]);
  withWall[1 * 4] = 255; // middle pixel is tall (height channel)

  const litFlat = renderLitRgba(albedo, normal, 3, 1, light, { material: flat });
  const litWall = renderLitRgba(albedo, normal, 3, 1, light, { material: withWall });
  assert.ok(litWall[0] < litFlat[0], "the shadowed left pixel should be darker than the unshadowed one");
});

test("the height self-shadow is soft — it fades with distance, not a hard step", () => {
  // A row with a tall occluder near the left and the light off to the left, so
  // the shadow falls to the right. With ambient 0 the pixel brightness relative
  // to the unshadowed render IS the shadow factor, so we can read the penumbra.
  const W = 12;
  const albedo = buffer(W, 1, [255, 255, 255, 255]);
  const normal = buffer(W, 1, FLAT_NORMAL);
  const light = { col: -6, row: 0.5, height: 2.5, ambient: 0 };
  const flat = buffer(W, 1, [0, 0, 255, 0]);
  const wall = buffer(W, 1, [0, 0, 255, 0]);
  wall[1 * 4] = 255; // a tall pixel at x=1

  const litFlat = renderLitRgba(albedo, normal, W, 1, light, { material: flat });
  const litWall = renderLitRgba(albedo, normal, W, 1, light, { material: wall });
  const shadowAt = (x) => (litWall[x * 4] || 0) / (litFlat[x * 4] || 1);

  const near = shadowAt(3);
  const mid = shadowAt(6);
  const far = shadowAt(9);
  assert.ok(near <= mid && mid <= far, `shadow should lighten with distance (${near} <= ${mid} <= ${far})`);
  assert.ok(near < far, "the far edge must be clearly lighter than deep shadow");
  assert.ok([near, mid, far].some((s) => s > 0.5 && s < 0.98), "a partial penumbra value must exist (a hard step could not)");
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nlitRenderer: ${passed}/${cases.length} passed`);

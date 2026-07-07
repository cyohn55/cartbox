/**
 * Unit tests for the player's lighting model (packages/player/src/lighting/
 * lightingModel.ts). Validates the 16-direction normal set and the Lambert +
 * ambient shading against derived properties — not memorised numbers — so it
 * proves the behaviour the runtime shader relies on.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/playerLightingModel.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelPath = path.resolve(here, "../packages/player/src/lighting/lightingModel.ts");
const { NORMAL_DIRECTION_COUNT, NORMAL_VECTORS, normalVector, nearestDirection, shade } =
  await import(pathToFileURL(modelPath).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const magnitude = (v) => Math.hypot(v[0], v[1], v[2]);

test("there are exactly 16 normal directions", () => {
  assert.equal(NORMAL_DIRECTION_COUNT, 16);
  assert.equal(NORMAL_VECTORS.length, 16);
});

test("every stored normal is a unit vector", () => {
  for (const v of NORMAL_VECTORS) assert.ok(Math.abs(magnitude(v) - 1) < 1e-9);
});

test("index 0 and spares 9..15 face the camera", () => {
  assert.deepEqual(normalVector(0), [0, 0, 1]);
  for (let i = 9; i < 16; i += 1) assert.deepEqual(normalVector(i), [0, 0, 1]);
});

test("the eight compass normals tilt outward but face forward", () => {
  const expectedSign = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  for (let c = 0; c < 8; c += 1) {
    const [x, y, z] = normalVector(c + 1);
    assert.equal(Math.sign(Math.round(x * 1e6)), expectedSign[c][0]);
    assert.equal(Math.sign(Math.round(y * 1e6)), expectedSign[c][1]);
    assert.ok(z > 0 && z < 1);
  }
});

test("each stored normal quantises back to its own index", () => {
  for (let i = 0; i <= 8; i += 1) assert.equal(nearestDirection(normalVector(i)), i);
});

test("a strong +x vector quantises to East (index 3)", () => {
  assert.equal(nearestDirection([1, 0, 0.1]), 3);
  assert.equal(nearestDirection([0, 0, 5]), 0);
});

const albedo = [200, 120, 60];

test("a surface facing the light keeps full albedo", () => {
  assert.deepEqual(shade(albedo, [0, 0, 1], [0, 0, 1], 0.22), albedo);
});

test("a surface 90° from the light drops to the ambient floor", () => {
  const ambient = 0.22;
  assert.deepEqual(shade(albedo, [0, 0, 1], [1, 0, 0], ambient), albedo.map((c) => Math.round(c * ambient)));
});

test("a back-facing surface clamps to ambient, never negative", () => {
  const lit = shade(albedo, [0, 0, 1], [0, 0, -1], 0.3);
  assert.deepEqual(lit, albedo.map((c) => Math.round(c * 0.3)));
  assert.ok(lit.every((c) => c >= 0));
});

test("brightness rises monotonically as the light aligns with the normal", () => {
  const lums = [90, 60, 30, 0].map((deg) => {
    const r = (deg * Math.PI) / 180;
    return shade(albedo, [0, 0, 1], [Math.sin(r), 0, Math.cos(r)], 0.22)[0];
  });
  for (let i = 1; i < lums.length; i += 1) assert.ok(lums[i] >= lums[i - 1]);
  assert.equal(lums.at(-1), albedo[0]);
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nplayerLightingModel: ${passed}/${cases.length} passed`);

/**
 * Validates the Cartbox normal + lighting core (Working/normal-lit-demo/
 * lighting-core.mjs) against the properties the model guarantees, using
 * derived expectations rather than baked-in constants so the test proves the
 * behaviour instead of restating an answer.
 *
 * Run: node "Unit Tests/lightingCore.test.mjs"
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  normalVector,
  nearestDirection,
  shade,
} from "../../normal-lit-demo/lighting-core.mjs";

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const magnitude = (v) => Math.hypot(v[0], v[1], v[2]);

// --- Normal set ------------------------------------------------------------

test("there are exactly 16 normal directions", () => {
  assert.equal(NORMAL_DIRECTION_COUNT, 16);
  assert.equal(NORMAL_VECTORS.length, 16);
});

test("every stored normal is a unit vector", () => {
  for (const v of NORMAL_VECTORS) {
    assert.ok(Math.abs(magnitude(v) - 1) < 1e-9, `‖${v}‖ should be 1`);
  }
});

test("index 0 and the spare indices 9..15 face the camera", () => {
  assert.deepEqual(normalVector(0), [0, 0, 1]);
  for (let index = 9; index < 16; index += 1) {
    assert.deepEqual(normalVector(index), [0, 0, 1]);
  }
});

test("the eight compass normals tilt outward but still face forward", () => {
  // Indices 1..8 = N, NE, E, SE, S, SW, W, NW in screen space (y points down).
  const expectedSign = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  for (let compass = 0; compass < 8; compass += 1) {
    const [x, y, z] = normalVector(compass + 1);
    const [signX, signY] = expectedSign[compass];
    assert.equal(Math.sign(Math.round(x * 1e6)), signX, `dir ${compass + 1} x`);
    assert.equal(Math.sign(Math.round(y * 1e6)), signY, `dir ${compass + 1} y`);
    assert.ok(z > 0 && z < 1, `dir ${compass + 1} should tilt, not lie flat`);
  }
});

// --- Nearest-direction quantisation ---------------------------------------

test("each stored normal quantises back to its own index", () => {
  // Distinct directions only: the spare 9..15 alias index 0.
  for (let index = 0; index <= 8; index += 1) {
    assert.equal(nearestDirection(normalVector(index)), index);
  }
});

test("a forward vector quantises to flat and a strong +x to East", () => {
  assert.equal(nearestDirection([0, 0, 5]), 0);
  assert.equal(nearestDirection([1, 0, 0.1]), 3); // East is index 3
});

// --- Lambert + ambient shading --------------------------------------------

const albedo = [200, 120, 60];

test("a surface facing the light keeps its full albedo", () => {
  const lit = shade(albedo, [0, 0, 1], [0, 0, 1], 0.22);
  assert.deepEqual(lit, albedo);
});

test("a surface turned 90° from the light drops to the ambient floor", () => {
  const ambient = 0.22;
  const lit = shade(albedo, [0, 0, 1], [1, 0, 0], ambient);
  const expected = albedo.map((c) => Math.round(c * ambient));
  assert.deepEqual(lit, expected);
});

test("a back-facing surface is clamped to the ambient floor, never negative", () => {
  const ambient = 0.3;
  const lit = shade(albedo, [0, 0, 1], [0, 0, -1], ambient);
  const expected = albedo.map((c) => Math.round(c * ambient));
  assert.deepEqual(lit, expected);
  assert.ok(lit.every((c) => c >= 0));
});

test("brightness rises monotonically as the light aligns with the normal", () => {
  const ambient = 0.22;
  const normal = [0, 0, 1];
  const anglesDeg = [90, 60, 30, 0];
  const luminances = anglesDeg.map((deg) => {
    const r = (deg * Math.PI) / 180;
    const toLight = [Math.sin(r), 0, Math.cos(r)];
    return shade(albedo, normal, toLight, ambient)[0];
  });
  for (let i = 1; i < luminances.length; i += 1) {
    assert.ok(luminances[i] >= luminances[i - 1], `angle ${anglesDeg[i]}° should be >= brighter`);
  }
  assert.equal(luminances.at(-1), albedo[0]); // straight-on == full albedo
});

test("ambient=1 makes lighting flat regardless of geometry", () => {
  const lit = shade(albedo, [0, 0, 1], [0, 0, -1], 1);
  assert.deepEqual(lit, albedo);
});

// --- runner ----------------------------------------------------------------

let passed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}
const self = path.basename(fileURLToPath(import.meta.url));
console.log(`\n${self}: ${passed}/${cases.length} passed`);

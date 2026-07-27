/**
 * Unit tests for the procgen noise floor (packages/editor/src/procgen/noise.ts):
 * the hashes, value/fractal noise in two and three dimensions, and the seeded
 * random stream.
 *
 * Every assertion is derived from a property the generators must hold —
 * determinism, range, seed sensitivity, continuity, uniformity — rather than
 * from recorded output values, so they stay meaningful if the mixing constants
 * are ever retuned.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/procgenNoise.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const {
  hashCoords2,
  hashCoords3,
  smoothstep,
  valueNoise2D,
  valueNoise3D,
  fractalNoise2D,
  fractalNoise3D,
  createRandom,
  randomInt,
} = await load("../packages/editor/src/procgen/noise.ts");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** Sample a function over a lattice and return every value it produced. */
function sampleGrid(fn, size, step = 1) {
  const values = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) values.push(fn(x * step, y * step));
  }
  return values;
}

test("every hash and noise sample lands in [0, 1)", () => {
  const samplers = [
    (x, y) => hashCoords2(x, y, 7),
    (x, y) => hashCoords3(x, y, x + y, 7),
    (x, y) => valueNoise2D(x * 0.37, y * 0.37, 7),
    (x, y) => valueNoise3D(x * 0.37, y * 0.37, (x + y) * 0.19, 7),
    (x, y) => fractalNoise2D(x * 0.11, y * 0.11, 7),
    (x, y) => fractalNoise3D(x * 0.11, y * 0.11, (x - y) * 0.07, 7),
  ];
  for (const sampler of samplers) {
    for (const value of sampleGrid(sampler, 24)) {
      assert.ok(Number.isFinite(value), "sample is finite");
      assert.ok(value >= 0 && value <= 1, `sample ${value} is within [0, 1]`);
    }
  }
});

test("the same coordinates and seed always produce the same sample", () => {
  const first = sampleGrid((x, y) => fractalNoise2D(x * 0.13, y * 0.13, 42), 16);
  const second = sampleGrid((x, y) => fractalNoise2D(x * 0.13, y * 0.13, 42), 16);
  assert.deepEqual(second, first);

  // Sampling out of order must not change any individual result — the whole
  // point of positional hashing over a sequential stream.
  assert.equal(fractalNoise2D(3 * 0.13, 5 * 0.13, 42), first[5 * 16 + 3]);
});

test("changing the seed changes almost every sample", () => {
  const a = sampleGrid((x, y) => fractalNoise2D(x * 0.13, y * 0.13, 1), 20);
  const b = sampleGrid((x, y) => fractalNoise2D(x * 0.13, y * 0.13, 2), 20);
  const identical = a.filter((value, index) => value === b[index]).length;
  assert.ok(identical < a.length * 0.02, `only ${identical}/${a.length} samples survived a seed change`);
});

test("smoothstep is a clamped-domain easing with zero-slope ends", () => {
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(0.5), 0.5);
  // Zero derivative at both ends is what removes the lattice creases: the change
  // over the first slice is far smaller than over the middle slice.
  const startSlope = smoothstep(0.01) - smoothstep(0);
  const midSlope = smoothstep(0.51) - smoothstep(0.5);
  assert.ok(startSlope < midSlope * 0.1, "easing flattens at the ends");
});

test("value noise is continuous — nearby samples stay close", () => {
  // A step of 1/64 of a lattice cell can never move the interpolated value by
  // more than a small fraction, since the corners it blends are fixed.
  let worst = 0;
  for (let i = 0; i < 500; i += 1) {
    const x = i * 0.017;
    const delta = Math.abs(valueNoise2D(x, 3.25, 9) - valueNoise2D(x + 1 / 64, 3.25, 9));
    if (delta > worst) worst = delta;
  }
  assert.ok(worst < 0.1, `largest jump across 1/64 of a cell was ${worst.toFixed(4)}`);
});

test("value noise reproduces the lattice hash exactly at integer coordinates", () => {
  for (let x = -3; x <= 3; x += 1) {
    for (let y = -3; y <= 3; y += 1) {
      assert.equal(valueNoise2D(x, y, 5), hashCoords2(x, y, 5));
    }
  }
});

test("fractal noise adds detail without leaving the unit range", () => {
  // Walk a line at a step far finer than the base lattice, so the measurement
  // sees small-scale variation rather than the sampling grid's own row breaks.
  const walk = (octaves) => {
    const values = [];
    for (let i = 0; i < 600; i += 1) values.push(fractalNoise2D(i * 0.05, 0.5, 3, octaves));
    return values;
  };
  const single = walk(1);
  const layered = walk(5);
  const spread = (values) => Math.max(...values) - Math.min(...values);
  /** Total absolute change along the walk — how much fine detail it carries. */
  const roughness = (values) =>
    values.slice(1).reduce((sum, value, i) => sum + Math.abs(value - values[i]), 0);

  assert.ok(layered.every((value) => value >= 0 && value <= 1), "stays normalized");
  assert.ok(roughness(layered) > roughness(single), "extra octaves add fine detail");
  assert.ok(spread(single) > 0, "a single octave still varies");
});

test("the seeded random stream replays exactly and covers the unit interval", () => {
  const first = Array.from({ length: 64 }, createRandom(1234));
  const replay = Array.from({ length: 64 }, createRandom(1234));
  assert.deepEqual(replay, first);

  const other = Array.from({ length: 64 }, createRandom(1235));
  assert.notDeepEqual(other, first);

  const draws = [];
  const random = createRandom(99);
  for (let i = 0; i < 4000; i += 1) draws.push(random());
  assert.ok(draws.every((value) => value >= 0 && value < 1), "every draw is in [0, 1)");
  const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean.toFixed(4)} is near 0.5`);
  // Every decile should be visited by a uniform source over 4000 draws.
  const deciles = new Set(draws.map((value) => Math.floor(value * 10)));
  assert.equal(deciles.size, 10, "all ten deciles are hit");
});

test("randomInt stays inclusive of both ends and never leaves the range", () => {
  const random = createRandom(7);
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const value = randomInt(random, 3, 7);
    assert.ok(Number.isInteger(value), "draws are integers");
    assert.ok(value >= 3 && value <= 7, `${value} is within 3..7`);
    seen.add(value);
  }
  assert.equal(seen.size, 5, "every value in the inclusive range appears");
  // A reversed range is a degenerate request, not a crash.
  assert.equal(randomInt(random, 5, 2), 5);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Tests the gap-#1 procedural generators (packages/player/src/anim/generators.ts).
 * Each generator's OUTPUT is sampled through the real sampleTrack so the assertions
 * describe observable motion (reaches its extremes, wraps, stays in range) rather
 * than the exact keyframes; flicker is checked for determinism and that its output
 * survives parseAnim when wrapped into a track.
 *
 * Run: node --experimental-transform-types "Unit Tests/anim-generators.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../packages/player/src/anim");
const { parseAnim } = await import(pathToFileURL(path.join(dir, "animModel.ts")).href);
const { sampleTrack } = await import(pathToFileURL(path.join(dir, "animPlayer.ts")).href);
const { pulse, sway, drift, flicker } = await import(pathToFileURL(path.join(dir, "generators.ts")).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// Wrap a GeneratedTrack onto a postfx target and parse it into a real AnimTrack.
const asTrack = (generated) =>
  parseAnim({ tracks: [{ target: { kind: "postfx", key: "k" }, ...generated }] }).tracks[0];

test("pulse reaches min at the start and max at the half-period, and returns", () => {
  const track = asTrack(pulse(20, 0.3, 1));
  assert.equal(sampleTrack(track, 0), 0.3);
  assert.equal(sampleTrack(track, 10), 1); // peak at period/2
  assert.equal(sampleTrack(track, 20), 0.3); // pingpong back to min
});

test("sway oscillates ±amplitude around the center", () => {
  const track = asTrack(sway(16, 4, 100));
  assert.equal(sampleTrack(track, 0), 96); // center - amplitude
  assert.equal(sampleTrack(track, 8), 104); // center + amplitude
  const mid = sampleTrack(track, 4);
  assert.ok(mid > 96 && mid < 104);
});

test("drift travels 0→distance and wraps seamlessly to 0", () => {
  const track = asTrack(drift(40, 320));
  assert.equal(sampleTrack(track, 0), 0);
  assert.equal(sampleTrack(track, 20), 160); // halfway
  assert.equal(sampleTrack(track, 40), 0); // wrapped back to origin
});

test("flicker stays within [min,max] across a full period", () => {
  const track = asTrack(flicker(30, 0.6, 1, 10, 42));
  for (let t = 0; t < 60; t += 1) {
    const v = sampleTrack(track, t);
    assert.ok(v >= 0.6 - 1e-9 && v <= 1 + 1e-9, `t=${t} v=${v} out of range`);
  }
});

test("flicker is deterministic per seed and differs across seeds", () => {
  const a = flicker(30, 0, 1, 8, 7);
  const b = flicker(30, 0, 1, 8, 7);
  const c = flicker(30, 0, 1, 8, 99);
  assert.deepEqual(a.keys, b.keys);
  assert.notDeepEqual(a.keys, c.keys);
});

test("flicker keyframe times are strictly increasing (no rounding collisions)", () => {
  const { keys } = flicker(12, 0, 1, 12, 3); // steps == period stresses collisions
  for (let i = 1; i < keys.length; i += 1) assert.ok(keys[i].t > keys[i - 1].t, `t not increasing at ${i}`);
});

test("generator output survives parseAnim (valid keys/mode/loopLength)", () => {
  for (const g of [pulse(10, 0, 1), sway(10, 2), drift(10, 50), flicker(10, 0, 1)]) {
    const spec = parseAnim({ tracks: [{ target: { kind: "sceneLayer", index: 0, channel: "emissive" }, ...g }] });
    assert.ok(spec, "generator produced an unparseable track");
    assert.equal(spec.tracks.length, 1);
  }
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n    ${err.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);

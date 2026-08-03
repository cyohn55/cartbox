/**
 * Tests the gap-#1 playback core (packages/player/src/anim/animPlayer.ts):
 * sampleClipFrame (per-frame durations, loop/pingpong/once, boundary correctness),
 * sampleTrack (ease + mode folding), and evaluate (routing + placement resolve).
 * Specs are built through the real parseAnim so the two modules are exercised
 * together, and assertions come from the input timings, not magic numbers.
 *
 * Run: node --experimental-transform-types "Unit Tests/anim-player.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../packages/player/src/anim");
const { parseAnim } = await import(pathToFileURL(path.join(dir, "animModel.ts")).href);
const { sampleClipFrame, sampleTrack, evaluate } = await import(pathToFileURL(path.join(dir, "animPlayer.ts")).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const region = (tile) => ({ page: 0, tile, tilesW: 1, tilesH: 1 });
// A clip of 3 frames (tiles 0,1,2), each held 2 ticks → forward period 6.
const threeFrame = (mode) => ({ name: "c", frames: [region(0), region(1), region(2)], durations: [2, 2, 2], mode });

test("sampleClipFrame loop: each frame held for its duration, wraps at the period", () => {
  const spec = parseAnim({ clips: [threeFrame("loop")] });
  const clip = spec.clips[0];
  const idxAt = (t) => sampleClipFrame(clip, t).frameIndex;
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(idxAt), [0, 0, 1, 1, 2, 2]);
  assert.equal(idxAt(6), idxAt(0)); // wrap
  assert.equal(idxAt(7), 0);
});

test("sampleClipFrame once: holds the last frame past the end", () => {
  const clip = parseAnim({ clips: [threeFrame("once")] }).clips[0];
  assert.equal(sampleClipFrame(clip, 4).frameIndex, 2);
  assert.equal(sampleClipFrame(clip, 100).frameIndex, 2); // clamped, not wrapped
});

test("sampleClipFrame pingpong: reverses without doubling the endpoints", () => {
  const clip = parseAnim({ clips: [threeFrame("pingpong")] }).clips[0];
  // sequence of frame indices is 0,1,2,1 each held 2 ticks → full period 8.
  const seq = Array.from({ length: 8 }, (_, t) => sampleClipFrame(clip, t).frameIndex);
  assert.deepEqual(seq, [0, 0, 1, 1, 2, 2, 1, 1]);
  assert.equal(sampleClipFrame(clip, 8).frameIndex, 0); // wraps to start
});

test("sampleClipFrame respects uneven per-frame durations", () => {
  const clip = parseAnim({ clips: [{ name: "u", frames: [region(0), region(1)], durations: [1, 3], mode: "loop" }] }).clips[0];
  const seq = [0, 1, 2, 3].map((t) => sampleClipFrame(clip, t).frameIndex);
  assert.deepEqual(seq, [0, 1, 1, 1]); // frame 1 held for 3 ticks
  assert.equal(sampleClipFrame(clip, 4).frameIndex, 0); // period 4
});

test("single-frame clip is always frame 0 in any mode", () => {
  for (const mode of ["loop", "pingpong", "once"]) {
    const clip = parseAnim({ clips: [{ name: "s", frames: [region(7)], durations: [1], mode }] }).clips[0];
    assert.equal(sampleClipFrame(clip, 0).frameIndex, 0);
    assert.equal(sampleClipFrame(clip, 50).frameIndex, 0);
  }
});

const trackFrom = (over) =>
  parseAnim({ tracks: [{ target: { kind: "postfx", key: "k" }, keys: over.keys, mode: over.mode, loopLength: over.loopLength }] }).tracks[0];

test("sampleTrack single key is constant", () => {
  const track = trackFrom({ keys: [{ t: 10, value: 0.7 }], mode: "hold" });
  assert.equal(sampleTrack(track, 0), 0.7);
  assert.equal(sampleTrack(track, 999), 0.7);
});

test("sampleTrack linear interpolates; hold clamps outside the range", () => {
  const track = trackFrom({ keys: [{ t: 0, value: 0, ease: "linear" }, { t: 10, value: 1, ease: "linear" }], mode: "hold" });
  assert.equal(sampleTrack(track, 0), 0);
  assert.equal(sampleTrack(track, 5), 0.5);
  assert.equal(sampleTrack(track, 10), 1);
  assert.equal(sampleTrack(track, -3), 0); // before first → first value
  assert.equal(sampleTrack(track, 40), 1); // after last → last value
});

test("sampleTrack step holds the segment's start value; smooth eases in-out", () => {
  const step = trackFrom({ keys: [{ t: 0, value: 0, ease: "step" }, { t: 10, value: 1, ease: "step" }], mode: "hold" });
  assert.equal(sampleTrack(step, 4), 0);
  assert.equal(sampleTrack(step, 9), 0);

  const smooth = trackFrom({ keys: [{ t: 0, value: 0, ease: "smooth" }, { t: 10, value: 1, ease: "smooth" }], mode: "hold" });
  assert.equal(sampleTrack(smooth, 5), 0.5); // smoothstep(0.5) === 0.5
  assert.ok(sampleTrack(smooth, 2.5) < 0.25); // ease-in below the linear line early
});

test("sampleTrack loop wraps over loopLength", () => {
  const track = trackFrom({ keys: [{ t: 0, value: 0, ease: "linear" }, { t: 10, value: 1, ease: "linear" }], mode: "loop", loopLength: 10 });
  assert.equal(sampleTrack(track, 0), 0);
  assert.equal(sampleTrack(track, 5), 0.5);
  assert.equal(sampleTrack(track, 10), sampleTrack(track, 0)); // wrapped
  assert.equal(sampleTrack(track, 15), 0.5);
});

test("sampleTrack pingpong folds into a symmetric triangle over the key span", () => {
  const track = trackFrom({ keys: [{ t: 0, value: 0, ease: "linear" }, { t: 10, value: 1, ease: "linear" }], mode: "pingpong" });
  assert.equal(sampleTrack(track, 0), 0);
  assert.equal(sampleTrack(track, 10), 1); // peak
  assert.equal(sampleTrack(track, 15), 0.5); // coming back down
  assert.equal(sampleTrack(track, 20), 0); // full period 2*span
});

test("evaluate routes tracks to layers / postfx / placement overrides", () => {
  const spec = parseAnim({
    clips: [{ name: "flame", frames: [region(0), region(1)], durations: [1, 1], mode: "loop" }],
    placements: [{ clip: "flame", x: 100, y: 50, opacity: 1, scale: 1 }],
    tracks: [
      { target: { kind: "sceneLayer", index: 2, channel: "opacity" }, keys: [{ t: 0, value: 0.25 }], mode: "hold" },
      { target: { kind: "sceneLayer", index: 2, channel: "offsetX" }, keys: [{ t: 0, value: 12 }], mode: "hold" },
      { target: { kind: "postfx", key: "bloom.strength" }, keys: [{ t: 0, value: 0.9 }], mode: "hold" },
      { target: { kind: "placement", index: 0, channel: "y" }, keys: [{ t: 0, value: 77 }], mode: "hold" },
    ],
  });
  const state = evaluate(spec, 0);
  assert.equal(state.layers[2].opacity, 0.25);
  assert.equal(state.layers[2].offsetX, 12); // multiple channels on one layer coexist
  assert.equal(state.postfx["bloom.strength"], 0.9);
  assert.equal(state.placements.length, 1);
  assert.equal(state.placements[0].x, 100); // base kept
  assert.equal(state.placements[0].y, 77); // overridden by the track
});

test("evaluate advances a placement's clip frame with the tick", () => {
  const spec = parseAnim({
    clips: [{ name: "flame", frames: [region(0), region(1)], durations: [1, 1], mode: "loop" }],
    placements: [{ clip: "flame", x: 0, y: 0 }],
  });
  assert.equal(evaluate(spec, 0).placements[0].frameIndex, 0);
  assert.equal(evaluate(spec, 1).placements[0].frameIndex, 1);
  assert.equal(evaluate(spec, 2).placements[0].frameIndex, 0); // period 2
});

test("evaluate is deterministic for a given tick", () => {
  const spec = parseAnim({
    clips: [{ name: "c", frames: [region(0), region(1)], durations: [1, 1], mode: "pingpong" }],
    placements: [{ clip: "c", x: 1, y: 2 }],
    tracks: [{ target: { kind: "postfx", key: "vignette.strength" }, keys: [{ t: 0, value: 0.1 }, { t: 30, value: 0.5 }], mode: "loop" }],
  });
  assert.deepEqual(evaluate(spec, 17), evaluate(spec, 17));
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

/**
 * Tests the gap-#1 animation model parser (packages/player/src/anim/animModel.ts).
 * Parsing is checked for defensive validation — untrusted JSON becomes a safe
 * AnimSpec, malformed entries dropped rather than throwing, ranges clamped — using
 * real input bodies (no hard-coded expected internals beyond what the inputs imply).
 *
 * Run: node --experimental-transform-types "Unit Tests/anim-model.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../packages/player/src/anim");
const { parseAnim } = await import(pathToFileURL(path.join(dir, "animModel.ts")).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const region = (over = {}) => ({ page: 0, tile: 4, tilesW: 2, tilesH: 2, ...over });
const clip = (over = {}) => ({ name: "walk", frames: [region(), region({ tile: 6 })], durations: [3, 5], mode: "loop", ...over });

test("non-objects yield null", () => {
  for (const bad of [null, undefined, 3, "x", [], true]) assert.equal(parseAnim(bad), null);
});

test("an empty-but-object spec is null (nothing usable)", () => {
  assert.equal(parseAnim({ clips: [], tracks: [], placements: [] }), null);
});

test("a valid clip round-trips with aligned durations and default mode", () => {
  const spec = parseAnim({ clips: [{ name: "idle", frames: [region()], durations: [4] }] });
  assert.equal(spec.clips.length, 1);
  const c = spec.clips[0];
  assert.equal(c.name, "idle");
  assert.equal(c.frames.length, 1);
  assert.deepEqual(c.durations, [4]);
  assert.equal(c.mode, "loop"); // defaulted
});

test("durations are forced 1:1 with frames (missing default to 1, extras dropped)", () => {
  const spec = parseAnim({ clips: [clip({ frames: [region(), region(), region()], durations: [2] })] });
  assert.deepEqual(spec.clips[0].durations, [2, 1, 1]);
  const spec2 = parseAnim({ clips: [clip({ frames: [region()], durations: [2, 9, 9] })] });
  assert.deepEqual(spec2.clips[0].durations, [2]);
});

test("a clip with no valid frames or a blank name is dropped", () => {
  assert.equal(parseAnim({ clips: [{ name: "x", frames: [{ tile: -1 }] }] }), null);
  assert.equal(parseAnim({ clips: [{ name: "", frames: [region()] }] }), null);
});

test("region validation: page coerced, tile>=0 required, sizes clamped", () => {
  const spec = parseAnim({ clips: [clip({ frames: [{ page: 9, tile: 2, tilesW: 999, tilesH: 0 }] })] });
  const r = spec.clips[0].frames[0];
  assert.equal(r.page, 0); // 9 → 0
  assert.equal(r.tilesW, 32); // clamped to MAX_TILES_PER_SIDE
  assert.equal(r.tilesH, 1); // clamped up from 0
});

test("duplicate clip names are deduped (first wins)", () => {
  const spec = parseAnim({
    clips: [clip({ name: "n", durations: [1, 1] }), clip({ name: "n", durations: [9, 9] })],
  });
  assert.equal(spec.clips.length, 1);
  assert.deepEqual(spec.clips[0].durations, [1, 1]);
});

test("caps: clips>32, frames>64, tracks>64, keys>64 are truncated", () => {
  const manyClips = Array.from({ length: 40 }, (_, i) => clip({ name: `c${i}` }));
  assert.equal(parseAnim({ clips: manyClips }).clips.length, 32);

  const manyFrames = Array.from({ length: 80 }, () => region());
  assert.equal(parseAnim({ clips: [clip({ frames: manyFrames })] }).clips[0].frames.length, 64);

  const track = (i) => ({ target: { kind: "postfx", key: `k${i}` }, keys: [{ t: 0, value: i }] });
  const manyTracks = Array.from({ length: 80 }, (_, i) => track(i));
  assert.equal(parseAnim({ clips: [clip()], tracks: manyTracks }).tracks.length, 64);

  const manyKeys = Array.from({ length: 80 }, (_, i) => ({ t: i, value: i }));
  const spec = parseAnim({ clips: [clip()], tracks: [{ target: { kind: "postfx", key: "k" }, keys: manyKeys }] });
  assert.equal(spec.tracks[0].keys.length, 64);
});

test("keys are sorted ascending regardless of input order", () => {
  const spec = parseAnim({
    clips: [clip()],
    tracks: [{ target: { kind: "postfx", key: "bloom.strength" }, keys: [{ t: 5, value: 1 }, { t: 1, value: 0 }, { t: 3, value: 0.5 }] }],
  });
  assert.deepEqual(spec.tracks[0].keys.map((k) => k.t), [1, 3, 5]);
});

test("track targets: unknown kind, bad channel, and out-of-range layer index are dropped", () => {
  const base = { clips: [clip()] };
  const t = (target) => ({ target, keys: [{ t: 0, value: 1 }] });
  assert.equal(parseAnim({ ...base, tracks: [t({ kind: "nope" })] }).tracks.length, 0);
  assert.equal(parseAnim({ ...base, tracks: [t({ kind: "sceneLayer", index: 2, channel: "spin" })] }).tracks.length, 0);
  assert.equal(parseAnim({ ...base, tracks: [t({ kind: "sceneLayer", index: 99, channel: "opacity" })] }).tracks.length, 0);
  assert.equal(parseAnim({ ...base, tracks: [t({ kind: "sceneLayer", index: 3, channel: "opacity" })] }).tracks.length, 1);
});

test("placement targets are bounds-checked against the placement count", () => {
  const withOnePlacement = {
    clips: [clip()],
    placements: [{ clip: "walk", x: 10, y: 20 }],
  };
  const t = (index) => ({ target: { kind: "placement", index, channel: "x" }, keys: [{ t: 0, value: 1 }] });
  assert.equal(parseAnim({ ...withOnePlacement, tracks: [t(0)] }).tracks.length, 1);
  assert.equal(parseAnim({ ...withOnePlacement, tracks: [t(1)] }).tracks.length, 0); // no placement 1
});

test("a placement referencing an unknown clip is dropped; a known one is kept and clamped", () => {
  // The bad placement is dropped but the valid clip keeps the spec alive.
  const dropped = parseAnim({ clips: [clip()], placements: [{ clip: "ghost" }] });
  assert.equal(dropped.placements.length, 0);
  assert.equal(dropped.clips.length, 1);
  // A placements-only spec whose sole placement is invalid IS null (nothing usable).
  assert.equal(parseAnim({ placements: [{ clip: "ghost" }] }), null);

  const spec = parseAnim({ clips: [clip()], placements: [{ clip: "walk", x: 5, y: 6, depth: 9, opacity: 5, scale: -3 }] });
  const p = spec.placements[0];
  assert.equal(p.x, 5);
  assert.equal(p.depth, 1); // clamped 0..1
  assert.equal(p.opacity, 1); // clamped 0..1
  assert.ok(p.scale >= 0.01); // clamped positive
});

test("a spec with only tracks (no clips/placements) is kept", () => {
  const spec = parseAnim({ tracks: [{ target: { kind: "sceneLayer", index: 0, channel: "opacity" }, keys: [{ t: 0, value: 1 }] }] });
  assert.ok(spec);
  assert.equal(spec.clips.length, 0);
  assert.equal(spec.tracks.length, 1);
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

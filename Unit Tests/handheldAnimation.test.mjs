/**
 * Unit tests for the animated handheld skin model
 * (packages/editor/src/model/handheldAnimation.ts).
 *
 * Uses a synthetic, fully-opaque template big enough for the marquee lane to
 * contain moving sprites, so every assertion is derived from the model's own
 * outputs (frame sizes, which pixels change, which are preserved) rather than
 * hard-coded pixel values. Imports the model file directly (not the editor
 * index) to avoid pulling the WASM engine under the raw TS hook.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/handheldAnimation.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, "../packages/editor/src/model", rel)).href);

const { HANDHELD_ANIMATED_PRESETS, handheldAnimatedPreset, renderAnimatedFrame, renderAnimatedFrames } =
  await load("handheldAnimation.ts");
const { HANDHELD_REGIONS, renderHandheld } = await load("handheldSkin.ts");

let passed = 0;

const HEX = /^#[0-9a-f]{6}$/i;

/** A fully-opaque template of the given size (every pixel is on-device). */
function opaqueTemplate(width, height) {
  const base = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    base[i * 4] = 50;
    base[i * 4 + 1] = 50;
    base[i * 4 + 2] = 50;
    base[i * 4 + 3] = 255;
  }
  return { width, height, base, regionMask: new Uint8Array(width * height) };
}

// 1. The animated preset catalogue is well-formed: the arcade scenes plus the
//    gamer-HUD marquees, each with a complete scheme and gate-legal bounds.
{
  const EXPECTED_GAMES = [
    "space-invaders",
    "pac-man",
    "asteroids",
    "bullet-hell",
    "equalizer",
    "xp-bar",
    "gamertag",
    "virtual-pet",
  ];
  assert.equal(HANDHELD_ANIMATED_PRESETS.length, EXPECTED_GAMES.length, "every marquee has a preset");
  const games = new Set(HANDHELD_ANIMATED_PRESETS.map((preset) => preset.game));
  for (const game of EXPECTED_GAMES) {
    assert.ok(games.has(game), `has the ${game} scene`);
  }
  const ids = new Set();
  for (const preset of HANDHELD_ANIMATED_PRESETS) {
    assert.ok(preset.id && !ids.has(preset.id), `unique id ${preset.id}`);
    ids.add(preset.id);
    assert.ok(preset.frames >= 2 && preset.frames <= 8, `${preset.id} frames within the art gate`);
    assert.ok(preset.durationMs >= 20 && preset.durationMs <= 2000, `${preset.id} duration within the art gate`);
    for (const region of HANDHELD_REGIONS) {
      assert.match(preset.scheme[region.id], HEX, `${preset.id}.${region.id} is a valid colour`);
    }
    assert.notEqual(preset.scheme.dpadArrow, preset.scheme.dpad, `${preset.id}: arrows differ from the D-pad`);
    assert.notEqual(preset.scheme.buttonLetter, preset.scheme.buttonColor, `${preset.id}: letters differ from the buttons`);
    assert.equal(handheldAnimatedPreset(preset.id), preset, "looks up by id");
  }
  assert.equal(handheldAnimatedPreset("not-a-preset"), undefined, "unknown id resolves to undefined");
  passed += 1;
}

// 2. renderAnimatedFrames yields `frames` RGBA buffers of the template's size.
{
  const template = opaqueTemplate(220, 380);
  for (const preset of HANDHELD_ANIMATED_PRESETS) {
    const frames = renderAnimatedFrames(template, preset);
    assert.equal(frames.length, preset.frames, `${preset.id} returns every frame`);
    for (const frame of frames) {
      assert.equal(frame.length, template.width * template.height * 4, `${preset.id} frame is full-size RGBA`);
    }
  }
  passed += 1;
}

// 3. The animation actually animates AND stays on the chassis: within the lane
//    at least two frames differ, while every pixel above the lane matches the
//    plain recoloured skin in every frame (the scene never touches the screen
//    area or controls).
{
  const template = opaqueTemplate(240, 400);
  for (const preset of HANDHELD_ANIMATED_PRESETS) {
    const still = renderHandheld(template, preset.scheme);
    const frames = renderAnimatedFrames(template, preset);

    // Region above the lane (lane starts at ~0.855 of height) is untouched.
    const safeRows = Math.floor(0.8 * template.height);
    for (const frame of frames) {
      for (let p = 0; p < safeRows * template.width * 4; p += 1) {
        if (frame[p] !== still[p]) {
          assert.fail(`${preset.id} drew outside the lane at byte ${p}`);
        }
      }
    }

    // Some lane pixel differs between frame 0 and a later frame.
    const laneStart = Math.floor(0.855 * template.height) * template.width * 4;
    let animated = false;
    for (let f = 1; f < frames.length && !animated; f += 1) {
      for (let p = laneStart; p < frames[f].length; p += 1) {
        if (frames[f][p] !== frames[0][p]) {
          animated = true;
          break;
        }
      }
    }
    assert.ok(animated, `${preset.id} animates across frames`);
  }
  passed += 1;
}

// 4. A single frame equals the corresponding frame of the batch (index wraps).
{
  const template = opaqueTemplate(200, 360);
  const preset = HANDHELD_ANIMATED_PRESETS[0];
  const frames = renderAnimatedFrames(template, preset);
  assert.deepEqual([...renderAnimatedFrame(template, preset, 0)], [...frames[0]], "frame 0 matches batch");
  assert.deepEqual(
    [...renderAnimatedFrame(template, preset, preset.frames)],
    [...frames[0]],
    "frame index wraps around the loop",
  );
  passed += 1;
}

console.log(`PASS — handheldAnimation: ${passed} checks green.`);

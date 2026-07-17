/**
 * Unit tests for the lit pixel-art backdrop model (apps/web/src/lib/litBackdrop.ts).
 *
 * Every assertion is derived from the model's own outputs (buffer sizes, index
 * ranges, relative brightness under different lights) rather than hard-coded
 * pixel values. Imports the module directly under the TS hook — it is dep-free
 * (no DOM, no editor barrel), so it loads without the WASM engine.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/litBackdrop.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/litBackdrop.ts")).href
);
const {
  NORMAL_DIRECTION_COUNT,
  buildBackdropScene,
  renderBackdropFrame,
  orbitLight,
  buildRetroWall,
  wallPaletteFromChassis,
} = mod;

const W = 96;
const H = 60;
const scene = buildBackdropScene(W, H);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const luminance = (buf, i) => buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2];

// 1. Every channel buffer has the exact aligned size.
check(
  "channel buffers are aligned to the pixel grid",
  scene.albedo.length === W * H * 3 &&
    scene.normalIdx.length === W * H &&
    scene.heightField.length === W * H &&
    scene.specular.length === W * H &&
    scene.roughness.length === W * H &&
    scene.emissive.length === W * H &&
    scene.emissiveColor.length === W * H * 3,
);

// 2. Normal indices stay within the 16-direction domain.
let normalsInRange = true;
for (let i = 0; i < scene.normalIdx.length; i += 1) {
  if (scene.normalIdx[i] < 0 || scene.normalIdx[i] >= NORMAL_DIRECTION_COUNT) normalsInRange = false;
}
check("normal indices are within 0..15", normalsInRange);

// 3. The generator is deterministic — the same size rebuilds identically.
const again = buildBackdropScene(W, H);
check("scene rebuilds identically", Buffer.compare(Buffer.from(scene.albedo), Buffer.from(again.albedo)) === 0);

// 4. A camera-facing (flat) panel pixel is brighter lit from overhead than from
//    a shallow side angle — the Lambert response the engine `shade` defines.
let flatPixel = -1;
for (let y = 0; y < H && flatPixel < 0; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const i = y * W + x;
    // A flat, mid-raised, non-emissive interior pixel with flat neighbours (so
    // the height self-shadow cannot confound the comparison).
    if (
      scene.normalIdx[i] === 0 &&
      scene.emissive[i] === 0 &&
      scene.heightField[i] > 0.5 &&
      x > 2 && x < W - 6 && y > 2 && y < H - 2
    ) {
      flatPixel = i;
      break;
    }
  }
}
check("found a flat interior test pixel", flatPixel >= 0);
{
  const px = flatPixel % W;
  const py = Math.floor(flatPixel / W);
  const overhead = renderBackdropFrame(scene, { x: px, y: py, z: 40 });
  const shallow = renderBackdropFrame(scene, { x: px + W, y: py, z: 4 });
  check(
    "overhead light beats a shallow side light on a flat pixel",
    luminance(overhead, flatPixel) > luminance(shallow, flatPixel),
  );
}

// 5. Emissive pixels stay lit even with the light far away and low (they carry
//    their own light), so their neon colour survives into the output.
let emissivePixel = -1;
for (let i = 0; i < scene.emissive.length; i += 1) {
  if (scene.emissive[i] > 0) {
    emissivePixel = i;
    break;
  }
}
check("found an emissive pixel", emissivePixel >= 0);
{
  const far = renderBackdropFrame(scene, { x: -200, y: -200, z: 1 });
  const ei = emissivePixel;
  const litMax = Math.max(far[ei * 4], far[ei * 4 + 1], far[ei * 4 + 2]);
  const emisMax = Math.max(
    scene.emissiveColor[ei * 3],
    scene.emissiveColor[ei * 3 + 1],
    scene.emissiveColor[ei * 3 + 2],
  );
  check("an emissive pixel keeps its neon brightness in shadow", litMax >= emisMax - 1);
}

// 6. The orbit light stays inside a sane band around the scene centre.
let orbitInBounds = true;
for (let t = 0; t < 20; t += 0.5) {
  const light = orbitLight(W, H, t);
  if (light.x < -W || light.x > W * 2 || light.y < -H || light.y > H * 2 || light.z <= 0) orbitInBounds = false;
}
check("orbit light stays within a sane band", orbitInBounds);

// 7. buildRetroWall omits the stars when asked (the onboarding backdrop does).
{
  const withStars = buildRetroWall(80, 60);
  const noStars = buildRetroWall(80, 60, undefined, false);
  let starCount = 0;
  for (let i = 0; i < withStars.emissive.length; i += 1) if (withStars.emissive[i] > 0) starCount += 1;
  let noStarCount = 0;
  for (let i = 0; i < noStars.emissive.length; i += 1) if (noStars.emissive[i] > 0) noStarCount += 1;
  check("default wall has stars", starCount > 0);
  check("stars can be turned off", noStarCount === 0);
}

// 8. The chassis-derived wall is a deep, MATCHING-TONE shade of the chassis hue
//    (same hue, richer/darker), so the background is cohesive yet the bright
//    chassis pops by value/saturation contrast. Derived from the colour, not
//    hard-coded.
{
  const sum = (c) => c[0] + c[1] + c[2];
  // A red chassis → a deep-red wall (red channel dominates).
  const red = wallPaletteFromChassis("#e03a3a").wallTop;
  check("red chassis → red-leaning wall", red[0] > red[1] && red[0] > red[2]);
  // A blue chassis → a deep-blue wall (blue channel dominates).
  const blue = wallPaletteFromChassis("#3a80d0").wallTop;
  check("blue chassis → blue-leaning wall", blue[2] > blue[0] && blue[2] > blue[1]);
  // The wall reads as a clear colour (not black) yet stays deep enough to keep
  // the picker legible on top.
  check(
    "chassis wall is a deep, visible colour",
    sum(red) > 3 * 24 && sum(red) < 3 * 120 && sum(blue) > 3 * 24 && sum(blue) < 3 * 120,
  );
  // A near-grey chassis stays a neutral dark wall (channels close together).
  const grey = wallPaletteFromChassis("#8a8c90").wallTop;
  check("near-grey chassis → neutral wall", Math.max(...grey) - Math.min(...grey) < 24);
  // No stars in the chassis palette.
  check("chassis palette has no star colour", sum(wallPaletteFromChassis("#e03a3a").star) === 0);
}

console.log(`litBackdrop: ${passed}/${passed} checks passed`);

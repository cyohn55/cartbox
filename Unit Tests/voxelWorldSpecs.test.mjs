/**
 * Unit tests for the voxel-world generator (apps/web/src/lib/voxelWorldSpecs.ts):
 * the deterministic Minecraft-style island behind the handheld picker.
 *
 * Assertions are derived from the generator's contract, not hard-coded outputs:
 * every column is grounded and contiguous, blocks stay inside the grid, the same
 * seed reproduces the same world while a new seed changes it, trees add volume
 * above the terrain, and the chassis-tinted sky is a valid gradient that reacts
 * to the chassis hue. Dep-free, so it runs under the plain node TS hook.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelWorldSpecs.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const specs = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/voxelWorldSpecs.ts")).href
);
const { generateWorld, DEFAULT_WORLD_PARAMS, worldParamsForDetail, skyGradientFromChassis } = specs;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const HEX = /^#[0-9a-f]{6}$/;

// --- Bounds: every block sits inside the declared grid ---
const world = generateWorld(DEFAULT_WORLD_PARAMS);
check("grid dims match params", world.sizeX === DEFAULT_WORLD_PARAMS.width && world.sizeZ === DEFAULT_WORLD_PARAMS.depth);
check("a substantial world is generated", world.cells.length > 5000);
check(
  "every block is inside the grid",
  world.cells.every(
    (c) => c.x >= 0 && c.x < world.sizeX && c.y >= 0 && c.y < world.sizeY && c.z >= 0 && c.z < world.sizeZ,
  ),
);
check(
  "colours and emissive are byte-ranged",
  world.cells.every(
    (c) =>
      [c.r, c.g, c.b, c.emissive].every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
  ),
);

// --- Terrain is solid ground: with no trees and no water, every populated
// column runs contiguously from bedrock (y=0) up to its surface, so nothing
// floats and there are no caves. ---
const solidTerrain = generateWorld({ ...DEFAULT_WORLD_PARAMS, treeDensity: 0, seaLevel: 0 });
const columns = new Map();
for (const c of solidTerrain.cells) {
  const key = `${c.x},${c.z}`;
  const ys = columns.get(key) ?? [];
  ys.push(c.y);
  columns.set(key, ys);
}
check("terrain covers the whole footprint", columns.size === solidTerrain.sizeX * solidTerrain.sizeZ);
let contiguous = true;
for (const ys of columns.values()) {
  ys.sort((a, b) => a - b);
  if (ys[0] !== 0) contiguous = false; // grounded on bedrock
  for (let i = 1; i < ys.length; i += 1) if (ys[i] !== ys[i - 1] + 1) contiguous = false; // no gaps
}
check("every terrain column is grounded and contiguous", contiguous);

// --- Determinism and seed sensitivity ---
const repeat = generateWorld(DEFAULT_WORLD_PARAMS);
check(
  "same params reproduce the same world",
  JSON.stringify(repeat.cells) === JSON.stringify(world.cells),
);
const reseeded = generateWorld({ ...DEFAULT_WORLD_PARAMS, seed: DEFAULT_WORLD_PARAMS.seed + 1 });
check(
  "a different seed changes the world",
  JSON.stringify(reseeded.cells) !== JSON.stringify(world.cells),
);

// --- Trees add volume above the terrain ---
const treeless = generateWorld({ ...DEFAULT_WORLD_PARAMS, treeDensity: 0 });
const forested = generateWorld({ ...DEFAULT_WORLD_PARAMS, treeDensity: 0.15 });
const maxY = (w) => w.cells.reduce((m, c) => Math.max(m, c.y), 0);
check("trees add blocks", forested.cells.length > treeless.cells.length);
check("tree canopies rise above the bare terrain", maxY(forested) > maxY(treeless));
check("some blocks glow (water sheen / lanterns)", world.cells.some((c) => c.emissive > 0));

// --- Granularity knob: worldParamsForDetail scales resolution coherently ---
const coarse = worldParamsForDetail(1);
const fine = worldParamsForDetail(2);
check("higher detail scales every block dimension up", fine.width > coarse.width && fine.height > coarse.height && fine.depth > coarse.depth);
check("detail 2 roughly doubles the footprint", Math.abs(fine.width / coarse.width - 2) < 0.05);
check("detail clamps to a sane floor", worldParamsForDetail(0).width >= worldParamsForDetail(0.5).width);
const coarseWorld = generateWorld(coarse);
const fineWorld = generateWorld(fine);
// The same landscape at higher detail is built from far more (finer) voxels.
check("finer detail yields many more blocks", fineWorld.cells.length > coarseWorld.cells.length * 3);
// Shape stability: the terrain's relative silhouette is preserved, not made
// spikier — the fraction of the footprint that is above the ground plane (hills)
// stays close across resolutions because noise frequency tracks the width.
const hillFraction = (world) => {
  const surface = new Map();
  for (const c of world.cells) {
    const key = `${c.x},${c.z}`;
    surface.set(key, Math.max(surface.get(key) ?? 0, c.y));
  }
  let above = 0;
  for (const top of surface.values()) if (top > world.sizeY * 0.28) above += 1;
  return above / surface.size;
};
check("terrain silhouette is stable across detail (not spikier)", Math.abs(hillFraction(fineWorld) - hillFraction(coarseWorld)) < 0.15);

// --- Chassis-tinted sky ---
const grey = skyGradientFromChassis("#808080");
check("sky endpoints are valid hex", HEX.test(grey.top) && HEX.test(grey.horizon));
check("sky determinism", skyGradientFromChassis("#808080").top === grey.top);
const blue = skyGradientFromChassis("#3b7bd8");
const red = skyGradientFromChassis("#d83b3b");
check("different chassis hues tint the sky differently", blue.top !== red.top);
check("a saturated chassis shifts the sky off the grey-chassis default", blue.top !== grey.top);

console.log(`voxelWorldSpecs: ${passed} checks passed`);

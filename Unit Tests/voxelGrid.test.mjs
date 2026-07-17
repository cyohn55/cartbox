/**
 * Unit tests for the dense 3D voxel grid (packages/editor/src/model/VoxelGrid.ts).
 *
 * Assertions come from the grid's contract — occupancy and colour round-trip
 * through set/get/clear, bounds are respected, dimensions are capped, and
 * serialize→deserialize reproduces the grid — all derived from the inputs, never
 * from hard-coded byte layouts. Loads under the TS hook (VoxelGrid pulls only the
 * pure voxelModel geometry).
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelGrid.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { VoxelGrid, serializeVoxelGrid, deserializeVoxelGrid, MAX_VOXEL_GRID_DIM } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/VoxelGrid.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

// 1. A fresh grid is empty and the right size.
{
  const grid = new VoxelGrid(4, 5, 6);
  check("dims stored", grid.sizeX === 4 && grid.sizeY === 5 && grid.sizeZ === 6);
  check("starts empty", grid.filledCount === 0);
  check("colours buffer sized cells*4", grid.colors.length === 4 * 5 * 6 * 4);
  check("emissive buffer sized cells", grid.emissive.length === 4 * 5 * 6);
}

// 2. set/get/clear round-trip an occupied cell with colour + emissive.
{
  const grid = new VoxelGrid(3, 3, 3);
  grid.set(1, 2, 0, 200, 100, 50, 128);
  check("cell now filled", grid.isFilled(1, 2, 0));
  const cell = grid.get(1, 2, 0);
  check("colour + emissive read back", cell.r === 200 && cell.g === 100 && cell.b === 50 && cell.emissive === 128);
  check("filledCount reflects one cell", grid.filledCount === 1);
  grid.clear(1, 2, 0);
  check("cleared cell empty", !grid.isFilled(1, 2, 0) && grid.get(1, 2, 0) === null);
  check("filledCount back to zero", grid.filledCount === 0);
}

// 3. Out-of-bounds writes/reads are safe no-ops.
{
  const grid = new VoxelGrid(2, 2, 2);
  grid.set(-1, 0, 0, 255, 255, 255);
  grid.set(2, 0, 0, 255, 255, 255);
  check("oob writes ignored", grid.filledCount === 0);
  check("oob isFilled false", !grid.isFilled(5, 5, 5));
  check("oob get null", grid.get(-1, -1, -1) === null);
}

// 4. forEachFilled visits exactly the occupied cells.
{
  const grid = new VoxelGrid(3, 3, 3);
  const placed = [
    [0, 0, 0],
    [2, 1, 2],
    [1, 2, 0],
  ];
  for (const [x, y, z] of placed) grid.set(x, y, z, 10, 20, 30);
  const seen = [];
  grid.forEachFilled((x, y, z) => seen.push(`${x},${y},${z}`));
  check("visits every filled cell once", seen.length === placed.length);
  check("visits exactly the placed cells", placed.every(([x, y, z]) => seen.includes(`${x},${y},${z}`)));
}

// 5. clone is an independent deep copy.
{
  const grid = new VoxelGrid(2, 2, 2);
  grid.set(0, 0, 0, 1, 2, 3, 4);
  const copy = grid.clone();
  copy.set(1, 1, 1, 9, 9, 9);
  check("clone has the original cell", copy.isFilled(0, 0, 0));
  check("clone is independent", grid.filledCount === 1 && copy.filledCount === 2);
}

// 6. Dimensions are validated: zero, non-integer, and over-cap are rejected.
{
  assert.throws(() => new VoxelGrid(0, 4, 4), RangeError);
  passed += 1;
  assert.throws(() => new VoxelGrid(4, 4.5, 4), RangeError);
  passed += 1;
  assert.throws(() => new VoxelGrid(MAX_VOXEL_GRID_DIM + 1, 4, 4), RangeError);
  passed += 1;
  const max = new VoxelGrid(MAX_VOXEL_GRID_DIM, MAX_VOXEL_GRID_DIM, MAX_VOXEL_GRID_DIM);
  check("max dimension allowed", max.sizeX === MAX_VOXEL_GRID_DIM);
}

// 7. serialize → deserialize reproduces occupancy, colour, emissive, and dims.
{
  const grid = new VoxelGrid(5, 4, 3);
  grid.set(0, 0, 0, 255, 0, 0, 0);
  grid.set(4, 3, 2, 12, 34, 56, 200);
  grid.set(2, 2, 1, 7, 7, 7, 0);
  const restored = deserializeVoxelGrid(serializeVoxelGrid(grid));
  check("dims round-trip", restored.sizeX === 5 && restored.sizeY === 4 && restored.sizeZ === 3);
  check("filledCount round-trips", restored.filledCount === grid.filledCount);
  let match = true;
  grid.forEachFilled((x, y, z, cell) => {
    const r = restored.get(x, y, z);
    if (!r || r.r !== cell.r || r.g !== cell.g || r.b !== cell.b || r.emissive !== cell.emissive) match = false;
  });
  check("every filled cell round-trips exactly", match);
}

// 8. deserialize rejects a payload whose byte length disagrees with its dims.
{
  const grid = new VoxelGrid(3, 3, 3);
  grid.set(1, 1, 1, 9, 9, 9);
  const tampered = JSON.parse(serializeVoxelGrid(grid));
  tampered.sizeX = 4; // now colours/emissive lengths no longer match dims
  assert.throws(() => deserializeVoxelGrid(JSON.stringify(tampered)), /size does not match/);
  passed += 1;
}

console.log(`voxelGrid: ${passed}/${passed} checks passed`);

/**
 * Unit tests for scaleGridAxis (packages/editor/src/model/VoxelGrid.ts): the
 * non-uniform "scale on X/Y/Z" gesture that stretches or squashes a sculpt's
 * filled content along one axis by nearest-neighbour resampling.
 *
 * Assertions are derived from the transform's contract (new extent along the
 * axis, the other two axes and the voxel colours unchanged, a wheel notch always
 * moves at least one layer, clamping to the grid), never from hard-coded grids.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelScaleAxis.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/VoxelGrid.ts")).href);
const { VoxelGrid, scaleGridAxis } = mod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** Filled bounding extent [min, max, length] of a grid along one axis. */
const extent = (grid, axis) => {
  let min = Infinity;
  let max = -Infinity;
  grid.forEachFilled((x, y, z) => {
    const coord = [x, y, z][axis];
    if (coord < min) min = coord;
    if (coord > max) max = coord;
  });
  return [min, max, max - min + 1];
};

/** A solid box of `color` spanning [0,w) x [0,h) x [0,d) inside a `size` grid. */
const boxGrid = (size, w, h, d, color = [200, 120, 40]) => {
  const grid = new VoxelGrid(size, size, size);
  for (let z = 0; z < d; z += 1)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) grid.set(x, y, z, color[0], color[1], color[2]);
  return grid;
};

// 1. An empty grid scales to an empty grid (nothing to resample, no throw).
{
  const out = scaleGridAxis(new VoxelGrid(8, 8, 8), 0, 2);
  check("empty grid stays empty", out.filledCount === 0);
}

// 2. Stretching along X grows only the X extent; Y and Z extents are unchanged.
{
  const grid = boxGrid(32, 4, 3, 2);
  const [, , w0] = extent(grid, 0);
  const out = scaleGridAxis(grid, 0, 2);
  const [, , w1] = extent(out, 0);
  check("stretch x grows the x extent", w1 === Math.round(w0 * 2));
  check("stretch x keeps the y extent", extent(out, 1)[2] === extent(grid, 1)[2]);
  check("stretch x keeps the z extent", extent(out, 2)[2] === extent(grid, 2)[2]);
  check("stretch x keeps the grid dimensions", out.sizeX === grid.sizeX && out.sizeY === grid.sizeY);
}

// 3. Each axis scales independently and correctly (Y and Z too).
for (const axis of [0, 1, 2]) {
  const grid = boxGrid(40, 5, 5, 5);
  const before = extent(grid, axis)[2];
  const out = scaleGridAxis(grid, axis, 1.6);
  const after = extent(out, axis)[2];
  check(`axis ${axis} stretches to round(len*1.6)`, after === Math.round(before * 1.6));
  // The two non-scaled axes are untouched.
  for (const other of [0, 1, 2].filter((a) => a !== axis)) {
    check(`axis ${axis}: other axis ${other} unchanged`, extent(out, other)[2] === extent(grid, other)[2]);
  }
}

// 4. Shrinking reduces the extent; a tiny factor never empties a non-empty grid.
{
  const grid = boxGrid(24, 8, 2, 2);
  const shrunk = scaleGridAxis(grid, 0, 0.5);
  check("shrink x reduces the x extent", extent(shrunk, 0)[2] === 4);
  const floored = scaleGridAxis(grid, 0, 0.01);
  check("extreme shrink keeps at least one layer", floored.filledCount > 0 && extent(floored, 0)[2] === 1);
}

// 5. A wheel notch is always felt: a factor that rounds back to the same length
//    still moves by one layer in the requested direction.
{
  const grid = boxGrid(16, 3, 3, 3); // len 3; *1.1 rounds to 3 without the nudge
  const up = scaleGridAxis(grid, 1, 1.1);
  check("grow nudges up by at least one layer", extent(up, 1)[2] === 4);
  const down = scaleGridAxis(grid, 1, 0.95); // rounds to 3 without the nudge
  check("shrink nudges down by at least one layer", extent(down, 1)[2] === 2);
}

// 6. Colours and emissive survive the resample (nearest-neighbour copies cells).
{
  const grid = new VoxelGrid(20, 20, 20);
  grid.set(2, 5, 5, 10, 20, 30, 200);
  grid.set(3, 5, 5, 40, 50, 60, 0);
  const out = scaleGridAxis(grid, 0, 2);
  let sawEmissive = false;
  let sawColour = false;
  out.forEachFilled((x, y, z, cell) => {
    if (cell.emissive === 200 && cell.r === 10 && cell.g === 20 && cell.b === 30) sawEmissive = true;
    if (cell.r === 40 && cell.g === 50 && cell.b === 60) sawColour = true;
  });
  check("stretched cells keep their colour", sawColour);
  check("stretched cells keep their emissive", sawEmissive);
}

// 7. Clamping: content already filling the axis can't overflow the grid bounds.
{
  const grid = boxGrid(10, 10, 2, 2); // x already spans the whole 10-wide grid
  const out = scaleGridAxis(grid, 0, 3);
  const [min, max, len] = extent(out, 0);
  check("stretch clamps to the grid size", len === 10 && min >= 0 && max < 10);
}

console.log(`voxelScaleAxis: ${passed}/${passed} checks passed`);

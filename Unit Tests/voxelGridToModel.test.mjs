/**
 * Unit tests for voxelGridToModel (packages/editor/src/model/VoxelGrid.ts): the
 * new VoxelModel constructor that builds a renderable model from arbitrary 3D
 * occupancy.
 *
 * Assertions are derived from the geometry, not hard-coded outputs: a lone cube
 * exposes all six faces; touching cubes hide their shared faces; the interior of
 * a solid block is dropped; colour/emissive and the grid-index back-mapping carry
 * through. Face bits are read from the shared CUBE_FACES, not literals.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelGridToModel.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/render/voxelModel.ts")).href);
const gridMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/VoxelGrid.ts")).href);
const { CUBE_FACES } = modelMod;
const { VoxelGrid, voxelGridToModel } = gridMod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const ALL_FACES = CUBE_FACES.reduce((m, f) => m | f.bit, 0);
const bitFor = (nx, ny, nz) =>
  CUBE_FACES.find((f) => f.normal[0] === nx && f.normal[1] === ny && f.normal[2] === nz).bit;

// 1. A single voxel exposes all six faces and is centred on the origin.
{
  const grid = new VoxelGrid(3, 3, 3);
  grid.set(1, 1, 1, 100, 150, 200, 0);
  const model = voxelGridToModel(grid);
  check("one voxel kept", model.count === 1);
  check("all six faces exposed", model.faces[0] === ALL_FACES);
  check("centred on origin", model.x[0] === 0 && model.y[0] === 0 && model.z[0] === 0);
  check("colour carried", model.r[0] === 100 && model.g[0] === 150 && model.b[0] === 200);
  check("grid index maps back", model.gridIndex[0] === grid.index(1, 1, 1));
}

// 2. Two cubes adjacent along +X hide exactly their shared faces.
{
  const grid = new VoxelGrid(4, 3, 3);
  grid.set(1, 1, 1, 10, 10, 10);
  grid.set(2, 1, 1, 20, 20, 20); // neighbour in +X
  const model = voxelGridToModel(grid);
  check("both voxels kept", model.count === 2);
  // Find each by its grid cell.
  const left = [...model.gridIndex].indexOf(grid.index(1, 1, 1));
  const right = [...model.gridIndex].indexOf(grid.index(2, 1, 1));
  const plusX = bitFor(1, 0, 0);
  const minusX = bitFor(-1, 0, 0);
  check("left cube's +X face hidden", (model.faces[left] & plusX) === 0);
  check("right cube's -X face hidden", (model.faces[right] & minusX) === 0);
  check("left keeps its -X face", (model.faces[left] & minusX) !== 0);
  check("right keeps its +X face", (model.faces[right] & plusX) !== 0);
}

// 3. A solid 3×3×3 block drops its fully-enclosed centre cell.
{
  const grid = new VoxelGrid(3, 3, 3);
  for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.set(x, y, z, 80, 80, 80);
  const model = voxelGridToModel(grid);
  check("interior cell culled (26 of 27 kept)", model.count === 26);
  const centreKept = [...model.gridIndex].includes(grid.index(1, 1, 1));
  check("the enclosed centre is not in the model", !centreKept);
  let everyKeptHasAFace = true;
  for (let v = 0; v < model.count; v++) if (model.faces[v] === 0) everyKeptHasAFace = false;
  check("every kept voxel exposes at least one face", everyKeptHasAFace);
}

// 4. Emissive carries through as 0..1 (byte / 255).
{
  const grid = new VoxelGrid(1, 1, 1);
  grid.set(0, 0, 0, 5, 5, 5, 255);
  const model = voxelGridToModel(grid);
  check("full emissive byte becomes 1.0", Math.abs(model.emissive[0] - 1) < 1e-6);
}

// 4b. center:"content" sizes and centres on the filled cells, not the whole grid,
//     so a small sculpt in a big grid renders tight and centred (what a prop wants).
{
  const grid = new VoxelGrid(8, 8, 8);
  grid.set(1, 1, 1, 9, 9, 9); // one voxel, far from the grid centre
  const gridCentred = voxelGridToModel(grid);
  const contentCentred = voxelGridToModel(grid, { center: "content" });
  check("grid-centred keeps the full grid size", gridCentred.sizeX === 8 && gridCentred.sizeY === 8);
  check("content-centred shrinks to the 1-voxel bounds", contentCentred.sizeX === 1 && contentCentred.sizeZ === 1);
  check("content-centred puts the voxel at the origin", contentCentred.x[0] === 0 && contentCentred.y[0] === 0);
  check("grid-centred offsets the same voxel off-origin", gridCentred.x[0] !== 0);
}

// 5. An empty grid yields an empty model.
{
  const model = voxelGridToModel(new VoxelGrid(2, 2, 2));
  check("empty grid → zero voxels", model.count === 0);
}

console.log(`voxelGridToModel: ${passed}/${passed} checks passed`);

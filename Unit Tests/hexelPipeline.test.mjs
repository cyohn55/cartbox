/**
 * Unit tests for the hexel voxel pipeline: building a renderable model from an
 * FCC grid (voxelGridToModel with HEXEL_GEOMETRY), flooding over the twelve
 * rhombic neighbours (floodRegion), and persisting the cell shape through
 * serialization (serializeVoxelGrid / deserializeCellShape).
 *
 * Assertions are derived from occupancy and connectivity, not literals: a lone
 * hexel exposes all twelve faces; two face-adjacent hexels hide the one face
 * they share; a hexel with all twelve neighbours filled is dropped as interior;
 * the flood follows the diagonal FCC neighbours a six-axis flood would miss; and
 * a hexel payload round-trips its shape while a cube payload stays shape-free
 * (byte-compatible with the pre-hexel format).
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/hexelPipeline.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (p) => import(pathToFileURL(path.resolve(here, p)).href);
const gridMod = await load("../packages/editor/src/model/VoxelGrid.ts");
const geoMod = await load("../packages/editor/src/render/cellGeometry.ts");
const selectMod = await load("../packages/editor/src/model/voxelSelect.ts");
const { VoxelGrid, voxelGridToModel, serializeVoxelGrid, deserializeVoxelGrid, deserializeCellShape } = gridMod;
const { HEXEL_GEOMETRY } = geoMod;
const { floodRegion } = selectMod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const ALL_TWELVE = HEXEL_GEOMETRY.faces.reduce((m, f) => m | f.bit, 0);
const bitForOffset = (dx, dy, dz) =>
  HEXEL_GEOMETRY.faces.find((f) => f.offset[0] === dx && f.offset[1] === dy && f.offset[2] === dz).bit;

// A central even-parity site so all twelve neighbours are in bounds.
const CENTER = [4, 4, 4];

// 1. A single hexel exposes all twelve rhombic faces.
{
  const grid = new VoxelGrid(9, 9, 9);
  grid.set(CENTER[0], CENTER[1], CENTER[2], 120, 160, 210, 0);
  const model = voxelGridToModel(grid, { geometry: HEXEL_GEOMETRY });
  check("one hexel kept", model.count === 1);
  check("all twelve faces exposed", model.faces[0] === ALL_TWELVE);
  check("model carries the hexel geometry", model.geometry === HEXEL_GEOMETRY);
}

// 2. Two hexels sharing a face each hide exactly that one face.
{
  const grid = new VoxelGrid(9, 9, 9);
  const [x, y, z] = CENTER;
  const dir = HEXEL_GEOMETRY.faces[0].offset; // an arbitrary neighbour direction
  grid.set(x, y, z, 200, 80, 80, 0);
  grid.set(x + dir[0], y + dir[1], z + dir[2], 80, 200, 80, 0);
  const model = voxelGridToModel(grid, { geometry: HEXEL_GEOMETRY });
  check("both hexels kept", model.count === 2);
  // The face toward the neighbour is hidden on the first; the opposite on the second.
  const hiddenA = bitForOffset(dir[0], dir[1], dir[2]);
  const hiddenB = bitForOffset(-dir[0], -dir[1], -dir[2]);
  const gi = (target) => [...model.gridIndex].findIndex((idx) => idx === grid.index(...target));
  const maskFirst = model.faces[gi([x, y, z])];
  const maskSecond = model.faces[gi([x + dir[0], y + dir[1], z + dir[2]])];
  check("shared face hidden on the first hexel", (maskFirst & hiddenA) === 0 && maskFirst === (ALL_TWELVE & ~hiddenA));
  check("shared face hidden on the second hexel", (maskSecond & hiddenB) === 0 && maskSecond === (ALL_TWELVE & ~hiddenB));
}

// 3. A hexel with all twelve neighbours filled is fully enclosed and dropped.
{
  const grid = new VoxelGrid(11, 11, 11);
  const [x, y, z] = [5, 5, 5];
  grid.set(x, y, z, 150, 150, 150, 0);
  for (const f of HEXEL_GEOMETRY.faces) grid.set(x + f.offset[0], y + f.offset[1], z + f.offset[2], 100, 100, 100, 0);
  const model = voxelGridToModel(grid, { geometry: HEXEL_GEOMETRY });
  const centreKept = [...model.gridIndex].includes(grid.index(x, y, z));
  check("enclosed hexel is dropped (interior costs nothing)", !centreKept);
  check("only the twelve shell hexels remain", model.count === 12);
}

// 4. Flood over the twelve FCC neighbours reaches diagonally-adjacent hexels
//    that a six-axis (cube) flood cannot.
{
  const grid = new VoxelGrid(9, 9, 9);
  const [x, y, z] = CENTER;
  const dir = HEXEL_GEOMETRY.faces[0].offset; // a (±1,±1,0)-type diagonal
  grid.set(x, y, z, 90, 90, 90, 0);
  grid.set(x + dir[0], y + dir[1], z + dir[2], 90, 90, 90, 0);

  const cubeFlood = floodRegion(grid, x, y, z, {}); // default six-axis neighbours
  const hexFlood = floodRegion(grid, x, y, z, { neighbors: HEXEL_GEOMETRY.neighbors });
  check("six-axis flood cannot cross the diagonal (only the seed)", cubeFlood.length === 1);
  check("twelve-neighbour flood reaches the diagonal hexel", hexFlood.length === 2);
  check("hex flood includes both cells", hexFlood.includes(grid.index(x, y, z)) && hexFlood.includes(grid.index(x + dir[0], y + dir[1], z + dir[2])));
}

// 5. Cell shape round-trips through serialization; cubes stay shape-free.
{
  const grid = new VoxelGrid(9, 9, 9);
  grid.set(CENTER[0], CENTER[1], CENTER[2], 10, 20, 30, 40);

  const hexJson = serializeVoxelGrid(grid, "hexel");
  check("hexel payload records its shape", deserializeCellShape(hexJson) === "hexel");
  check("hexel payload still restores the grid", deserializeVoxelGrid(hexJson).filledCount === 1);

  const cubeJson = serializeVoxelGrid(grid, "cube");
  check("cube payload omits the shape field", !JSON.parse(cubeJson).shape);
  check("cube payload defaults to cube shape", deserializeCellShape(cubeJson) === "cube");

  const defaultJson = serializeVoxelGrid(grid); // no shape argument
  check("default serialization is cube (byte-compatible)", defaultJson === cubeJson);
  check("malformed payload defaults to cube", deserializeCellShape("not json") === "cube");
}

console.log(`hexelPipeline: ${passed}/${passed} checks passed`);

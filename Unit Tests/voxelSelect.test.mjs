/**
 * Unit tests for voxelSelect (packages/editor/src/model/voxelSelect.ts): the
 * colour-matching flood fill shared by the Voxel editor's Magic Wand (selects a
 * run of voxels) and Paint Bucket (recolours it), plus the flat-index → (x,y,z)
 * decoder both tools use.
 *
 * Assertions are derived from grids the test builds and from the traversal's
 * defining properties (connectivity, colour matching, tolerance, symmetry with
 * the grid's own indexing), never from hard-coded index lists, so they hold for
 * any grid the helpers are given.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelSelect.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const selectMod = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/voxelSelect.ts")).href
);
const gridMod = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/VoxelGrid.ts")).href
);
const { floodRegion, cellCoords } = selectMod;
const { VoxelGrid } = gridMod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** The set of (x,y,z) coordinate keys a region of flat indices covers. */
const regionCoordKeys = (grid, region) =>
  new Set(region.map((i) => cellCoords(grid, i).join(",")));

// 1. An empty seed cell yields an empty region — nothing to flood.
{
  const grid = new VoxelGrid(4, 4, 4);
  check("empty seed → empty region", floodRegion(grid, 1, 1, 1).length === 0);
  check("out-of-bounds seed → empty region", floodRegion(grid, -1, 0, 0).length === 0);
}

// 2. A single isolated voxel floods to exactly itself.
{
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(2, 1, 3, 200, 40, 40);
  const region = floodRegion(grid, 2, 1, 3);
  check("isolated voxel → region of one", region.length === 1);
  check("isolated voxel region is the seed cell", region[0] === grid.index(2, 1, 3));
}

// 3. A connected same-colour run is selected whole; a differently coloured
//    neighbour blocks the flood (exact-match default tolerance).
{
  const grid = new VoxelGrid(6, 6, 6);
  // A straight line of red voxels along X, plus a blue voxel touching one end.
  const red = [50, 200, 80];
  for (let x = 0; x < 4; x += 1) grid.set(x, 2, 2, red[0], red[1], red[2]);
  grid.set(4, 2, 2, 30, 60, 220); // blue cap — different colour, should block

  const region = floodRegion(grid, 0, 2, 2);
  check("same-colour run selected whole", region.length === 4);
  const keys = regionCoordKeys(grid, region);
  check("run covers the four red cells", [0, 1, 2, 3].every((x) => keys.has(`${x},2,2`)));
  check("blue neighbour excluded at exact tolerance", !keys.has("4,2,2"));
}

// 4. Connectivity is 6-connected (faces), not diagonal: a face-diagonal voxel of
//    the same colour is NOT reached unless a face path exists.
{
  const grid = new VoxelGrid(4, 4, 4);
  const c = [120, 120, 250];
  grid.set(1, 1, 1, c[0], c[1], c[2]);
  grid.set(2, 2, 1, c[0], c[1], c[2]); // diagonal in the z=1 plane, no shared face
  const region = floodRegion(grid, 1, 1, 1);
  check("face-diagonal same-colour cell is not reached", region.length === 1);

  // Add the face-adjacent bridge cell; now all three connect.
  grid.set(2, 1, 1, c[0], c[1], c[2]);
  const bridged = floodRegion(grid, 1, 1, 1);
  check("a face bridge connects the diagonal cell", bridged.length === 3);
}

// 5. Tolerance widens the match: near-but-not-equal colours join only once the
//    tolerance covers their distance; tolerance 1 grabs every connected cell.
{
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(0, 0, 0, 100, 100, 100);
  grid.set(1, 0, 0, 110, 100, 100); // distance² = 100 from the seed
  grid.set(2, 0, 0, 0, 0, 0); // far colour, distance² = 3*100²

  const exact = floodRegion(grid, 0, 0, 0, { tolerance: 0 });
  check("exact tolerance stops at the seed", exact.length === 1);

  // A tolerance whose threshold just exceeds distance² = 100 grabs the near cell
  // but not the far one. threshold = tolerance * 3*255²; solve for 100 < thr.
  const smallTolerance = 200 / (3 * 255 * 255);
  const near = floodRegion(grid, 0, 0, 0, { tolerance: smallTolerance });
  check("small tolerance grabs the near colour only", near.length === 2);

  const all = floodRegion(grid, 0, 0, 0, { tolerance: 1 });
  check("tolerance 1 grabs the whole connected run", all.length === 3);
}

// 6. cellCoords is the exact inverse of the grid's own index() for every cell —
//    the property the tools rely on to map a picked voxel back to coordinates.
{
  const grid = new VoxelGrid(5, 3, 4);
  let roundTrips = true;
  for (let z = 0; z < grid.sizeZ; z += 1) {
    for (let y = 0; y < grid.sizeY; y += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        const [rx, ry, rz] = cellCoords(grid, grid.index(x, y, z));
        if (rx !== x || ry !== y || rz !== z) roundTrips = false;
      }
    }
  }
  check("cellCoords inverts index() for every cell", roundTrips);
}

// 7. The region is a valid recolour set for the Paint Bucket: recolouring every
//    returned cell and re-flooding from the same seed returns the same region
//    (idempotent under a uniform recolour — the property the bucket depends on).
{
  const grid = new VoxelGrid(5, 5, 5);
  const src = [200, 30, 30];
  for (let x = 0; x < 3; x += 1) for (let y = 0; y < 3; y += 1) grid.set(x, y, 2, src[0], src[1], src[2]);
  const before = floodRegion(grid, 0, 0, 2);
  for (const i of before) {
    const [x, y, z] = cellCoords(grid, i);
    grid.set(x, y, z, 40, 80, 220); // the bucket's new colour
  }
  const after = floodRegion(grid, 0, 0, 2);
  const sameSet =
    before.length === after.length &&
    [...regionCoordKeys(grid, before)].every((k) => regionCoordKeys(grid, after).has(k));
  check("recolouring the region leaves the same connected run", sameSet);
}

console.log(`voxelSelect.test.mjs: ${passed} checks passed`);

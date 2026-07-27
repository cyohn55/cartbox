/**
 * Unit tests for the 3D generators (packages/editor/src/procgen/generators.ts),
 * run against a real VoxelGrid so the VoxelSink interface is proven to fit the
 * class the Voxel tab actually passes it.
 *
 * The properties checked are the ones the editor depends on: a run replaces the
 * sculpt rather than adding to it, hexel runs place cells only on the FCC
 * lattice, terrain columns are solid from the floor up, and identical settings
 * rebuild an identical volume.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelGenerators.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { VoxelGrid } = await load("../packages/editor/src/model/VoxelGrid.ts");
const { VOXEL_GENERATORS, defaultValues, findGenerator } = await load(
  "../packages/editor/src/procgen/generators.ts",
);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const CUBES = { evenParity: false };
const HEXELS = { evenParity: true };

/** Run a generator into a fresh grid and hand back the grid. */
function run(id, size, lattice, overrides = {}) {
  const generator = findGenerator(VOXEL_GENERATORS, id);
  const grid = new VoxelGrid(size, size, size);
  generator.generate(grid, lattice, { ...defaultValues(generator.params), ...overrides });
  return grid;
}

/** Every filled cell of a grid, as [x, y, z] triples. */
function filledCells(grid) {
  const cells = [];
  grid.forEachFilled((x, y, z) => cells.push([x, y, z]));
  return cells;
}

test("every registered 3D generator is described well enough to render controls", () => {
  assert.ok(VOXEL_GENERATORS.length >= 3, `registry holds ${VOXEL_GENERATORS.length} generators`);
  const ids = new Set();
  for (const generator of VOXEL_GENERATORS) {
    assert.ok(!ids.has(generator.id), `${generator.id} is unique`);
    ids.add(generator.id);
    assert.ok(generator.description.length > 0, `${generator.id} describes itself`);
    assert.ok(
      generator.params.some((spec) => spec.key === "seed"),
      `${generator.id} is seeded`,
    );
    for (const spec of generator.params) {
      assert.ok(spec.max > spec.min, `${generator.id}.${spec.key} has a usable range`);
      assert.ok(spec.value >= spec.min && spec.value <= spec.max, `${generator.id}.${spec.key} default in range`);
    }
  }
});

test("every generator fills a grid and stays inside its bounds", () => {
  for (const generator of VOXEL_GENERATORS) {
    const grid = run(generator.id, 20, CUBES);
    assert.ok(grid.filledCount > 0, `${generator.id} produced cells`);
    for (const [x, y, z] of filledCells(grid)) {
      assert.ok(grid.inBounds(x, y, z), `${generator.id} stayed in bounds at ${x},${y},${z}`);
    }
  }
});

test("a run replaces whatever was in the grid rather than adding to it", () => {
  for (const generator of VOXEL_GENERATORS) {
    const grid = new VoxelGrid(16, 16, 16);
    // Fill a corner the generators have no reason to reproduce exactly.
    for (let y = 0; y < 16; y += 1) grid.set(15, y, 15, 1, 2, 3);
    const before = grid.filledCount;
    generator.generate(grid, CUBES, defaultValues(generator.params));

    const untouchedColumn = [...Array(16).keys()].every((y) => {
      const cell = grid.get(15, y, 15);
      return cell !== null && cell.r === 1 && cell.g === 2 && cell.b === 3;
    });
    assert.ok(!untouchedColumn, `${generator.id} cleared the previous sculpt`);
    assert.ok(before > 0, "the seed column really was there");
  }
});

test("identical settings rebuild an identical volume", () => {
  for (const generator of VOXEL_GENERATORS) {
    const first = run(generator.id, 16, CUBES, { seed: 12 });
    const second = run(generator.id, 16, CUBES, { seed: 12 });
    assert.deepEqual([...second.colors], [...first.colors], `${generator.id} is deterministic`);

    const other = run(generator.id, 16, CUBES, { seed: 13 });
    assert.notDeepEqual([...other.colors], [...first.colors], `${generator.id} responds to the seed`);
  }
});

test("a hexel run places cells only on the even-parity lattice", () => {
  for (const generator of VOXEL_GENERATORS) {
    const grid = run(generator.id, 20, HEXELS);
    assert.ok(grid.filledCount > 0, `${generator.id} produced hexels`);
    for (const [x, y, z] of filledCells(grid)) {
      assert.equal((x + y + z) % 2, 0, `${generator.id} placed ${x},${y},${z} off the FCC lattice`);
    }
    // The same generator on cubes fills every valid site, so it must place more.
    assert.ok(
      run(generator.id, 20, CUBES).filledCount > grid.filledCount,
      `${generator.id} places fewer hexels than cubes`,
    );
  }
});

test("terrain builds solid columns from the floor up", () => {
  const grid = run("terrain", 24, CUBES, { island: 0 });
  let columns = 0;
  for (let z = 0; z < grid.sizeZ; z += 1) {
    for (let x = 0; x < grid.sizeX; x += 1) {
      // Find the column's top, then require everything below it to be solid —
      // terrain must never leave a floating cap over empty space.
      let top = -1;
      for (let y = grid.sizeY - 1; y >= 0; y -= 1) {
        if (grid.isFilled(x, y, z)) {
          top = y;
          break;
        }
      }
      if (top < 0) continue;
      columns += 1;
      for (let y = 0; y <= top; y += 1) {
        assert.ok(grid.isFilled(x, y, z), `column ${x},${z} is solid at height ${y}`);
      }
    }
  }
  assert.ok(columns > 0, "terrain raised some columns");
});

test("raising the terrain water level floods more of the volume", () => {
  const waterColor = (grid) => {
    // Water is the only material the generator paints above the ground line, so
    // counting cells whose blue channel dominates tracks how much flooded.
    let count = 0;
    grid.forEachFilled((_x, _y, _z, cell) => {
      if (cell.b > cell.r + 40 && cell.b > cell.g + 40) count += 1;
    });
    return count;
  };
  const dry = run("terrain", 24, CUBES, { water: 0.15, island: 0.3 });
  const flooded = run("terrain", 24, CUBES, { water: 0.75, island: 0.3 });
  assert.ok(waterColor(flooded) > waterColor(dry), "a higher water level places more water");
});

test("the maze generator lays a floor and stands walls on it", () => {
  const wallHeight = 5;
  const grid = run("maze", 21, CUBES, { wallHeight, braid: 0 });

  let floorCells = 0;
  let tallest = 0;
  for (let z = 0; z < grid.sizeZ; z += 1) {
    for (let x = 0; x < grid.sizeX; x += 1) {
      if (grid.isFilled(x, 0, z)) floorCells += 1;
      for (let y = grid.sizeY - 1; y > 0; y -= 1) {
        if (grid.isFilled(x, y, z)) {
          if (y > tallest) tallest = y;
          break;
        }
      }
    }
  }
  assert.equal(floorCells, grid.sizeX * grid.sizeZ, "the floor slab covers the whole footprint");
  assert.equal(tallest, wallHeight, "walls stand exactly as tall as asked");

  // Corridors must be open above the floor, or there is no maze to walk.
  let openColumns = 0;
  for (let z = 0; z < grid.sizeZ; z += 1) {
    for (let x = 0; x < grid.sizeX; x += 1) if (!grid.isFilled(x, 1, z)) openColumns += 1;
  }
  assert.ok(openColumns > 0, "some columns are open corridor");
});

test("the wall height is capped by the grid rather than overflowing it", () => {
  const grid = run("maze", 8, CUBES, { wallHeight: 32 });
  for (const [, y] of filledCells(grid)) {
    assert.ok(y < grid.sizeY, `wall cell at height ${y} fits the grid`);
  }
});

test("caves leave both rock and open space in the volume", () => {
  const grid = run("caves", 20, CUBES, { steps: 3 });
  const volume = grid.sizeX * grid.sizeY * grid.sizeZ;
  assert.ok(grid.filledCount > 0, "rock survives");
  assert.ok(grid.filledCount < volume, "space is carved");
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);

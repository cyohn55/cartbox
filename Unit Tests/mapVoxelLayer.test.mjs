/**
 * Unit tests for the map's column layer (packages/editor/src/model/MapVoxelLayer.ts):
 * the raise/paint/erase operations, the clamping rules, the sparse serialization
 * round trip, and rebuilding the layer as a real VoxelGrid — including the
 * even-parity constraint a hexel layer must satisfy to tile.
 *
 * Values are always read back from the layer that was written, and the parity
 * check is derived from the FCC rule rather than from a recorded cell list.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/mapVoxelLayer.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const {
  MapVoxelLayer,
  COLUMN_MATERIAL_NONE,
  mapLayerToVoxelGrid,
  serializeMapVoxelLayer,
  deserializeMapVoxelLayer,
  MAX_MAP_COLUMN_HEIGHT,
  MAP_VOXEL_LAYER_VERSION,
} = await load("../packages/editor/src/model/MapVoxelLayer.ts");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** A layer with a reproducible spread of columns, without using randomness. */
function seededLayer(width = 24, height = 18, shape = "cube") {
  const layer = new MapVoxelLayer(width, height, shape);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // A simple deterministic pattern that leaves plenty of empty cells.
      if ((x * 3 + y * 5) % 7 !== 0) continue;
      layer.setColumn(x, y, 1 + ((x + y) % 9), (x * 2 + y) % 16);
    }
  }
  return layer;
}

test("a new layer is empty and matches the requested dimensions", () => {
  const layer = new MapVoxelLayer(30, 17);
  assert.equal(layer.width, 30);
  assert.equal(layer.height, 17);
  assert.equal(layer.shape, "cube");
  assert.ok(layer.isEmpty);
  assert.equal(layer.columnCount, 0);
  assert.equal(layer.peakHeight, 0);
  assert.equal(layer.columnAt(0, 0), null);
});

test("invalid dimensions are rejected rather than silently accepted", () => {
  for (const [width, height] of [
    [0, 4],
    [4, 0],
    [-3, 4],
    [4.5, 4],
  ]) {
    assert.throws(() => new MapVoxelLayer(width, height), RangeError, `${width}x${height} is rejected`);
  }
});

test("a column round-trips through the layer", () => {
  const layer = new MapVoxelLayer(8, 8);
  layer.setColumn(3, 4, 5, 11);
  assert.deepEqual(layer.columnAt(3, 4), { height: 5, colorIndex: 11, material: COLUMN_MATERIAL_NONE });
  assert.equal(layer.heightAt(3, 4), 5);
  assert.equal(layer.columnCount, 1);
  assert.equal(layer.peakHeight, 5);
  assert.ok(!layer.isEmpty);
});

test("heights are clamped and a zero height clears the cell", () => {
  const layer = new MapVoxelLayer(8, 8);
  layer.setColumn(1, 1, MAX_MAP_COLUMN_HEIGHT + 50, 3);
  assert.equal(layer.heightAt(1, 1), MAX_MAP_COLUMN_HEIGHT);

  layer.setColumn(1, 1, 0, 3);
  assert.equal(layer.columnAt(1, 1), null);
  layer.setColumn(2, 2, -4, 3);
  assert.equal(layer.columnAt(2, 2), null);
});

test("out-of-bounds writes and reads are ignored, not thrown", () => {
  const layer = new MapVoxelLayer(6, 6);
  layer.setColumn(-1, 0, 4, 1);
  layer.setColumn(0, 99, 4, 1);
  layer.raise(-5, -5, 3, 1);
  layer.paint(99, 99, 2);
  layer.clear(-1, -1);
  assert.equal(layer.columnCount, 0);
  assert.equal(layer.heightAt(-1, -1), 0);
  assert.equal(layer.columnAt(99, 99), null);
});

test("raise steps a column up and down, bottoming out at empty", () => {
  const layer = new MapVoxelLayer(8, 8);
  assert.equal(layer.raise(2, 2, 3, 7), 3);
  assert.equal(layer.columnAt(2, 2).colorIndex, 7, "a new column takes the active colour");

  assert.equal(layer.raise(2, 2, 2, 9), 5);
  assert.equal(layer.columnAt(2, 2).colorIndex, 7, "an existing column keeps its own colour");

  assert.equal(layer.raise(2, 2, -10, 7), 0, "lowering past zero stops at zero");
  assert.equal(layer.columnAt(2, 2), null, "and the cell is cleared");
  assert.equal(layer.raise(2, 2, MAX_MAP_COLUMN_HEIGHT * 2, 7), MAX_MAP_COLUMN_HEIGHT, "raising is capped");
});

test("paint only recolours a column that exists", () => {
  const layer = new MapVoxelLayer(8, 8);
  layer.paint(4, 4, 12);
  assert.equal(layer.columnAt(4, 4), null, "painting empty ground creates nothing");

  layer.setColumn(4, 4, 2, 1);
  layer.paint(4, 4, 12);
  assert.deepEqual(layer.columnAt(4, 4), { height: 2, colorIndex: 12, material: COLUMN_MATERIAL_NONE });
});

test("forEachColumn visits every raised cell exactly once", () => {
  const layer = seededLayer();
  const visited = new Set();
  let count = 0;
  layer.forEachColumn((x, y, column) => {
    const key = `${x},${y}`;
    assert.ok(!visited.has(key), `${key} visited once`);
    visited.add(key);
    count += 1;
    assert.deepEqual(column, layer.columnAt(x, y));
  });
  assert.equal(count, layer.columnCount);
});

test("clone copies the columns and can re-shape the lattice", () => {
  const layer = seededLayer();
  const copy = layer.clone();
  assert.equal(copy.shape, layer.shape);
  assert.equal(copy.columnCount, layer.columnCount);
  // Mutating the copy must leave the original alone — pick a cell the seed
  // pattern actually filled, so the edit is guaranteed to be a change.
  let sample = null;
  layer.forEachColumn((x, y) => {
    if (sample === null) sample = [x, y];
  });
  copy.clear(sample[0], sample[1]);
  assert.equal(copy.columnAt(sample[0], sample[1]), null, "the copy lost the column");
  assert.notEqual(layer.columnAt(sample[0], sample[1]), null, "the original kept it");
  assert.equal(copy.columnCount, layer.columnCount - 1, "the copy is independent");

  const hexels = layer.clone("hexel");
  assert.equal(hexels.shape, "hexel");
  assert.equal(hexels.columnCount, layer.columnCount, "re-shaping keeps every column");
});

test("clearAll empties the layer but keeps its shape and size", () => {
  const layer = seededLayer(20, 20, "hexel");
  layer.clearAll();
  assert.ok(layer.isEmpty);
  assert.equal(layer.shape, "hexel");
  assert.equal(layer.width, 20);
});

test("serialization round-trips every column, sparsely", () => {
  for (const shape of ["cube", "hexel"]) {
    const layer = seededLayer(24, 18, shape);
    const restored = deserializeMapVoxelLayer(serializeMapVoxelLayer(layer));
    assert.equal(restored.width, layer.width);
    assert.equal(restored.height, layer.height);
    assert.equal(restored.shape, shape);
    assert.equal(restored.columnCount, layer.columnCount);
    layer.forEachColumn((x, y, column) => {
      assert.deepEqual(restored.columnAt(x, y), column, `column ${x},${y} survived (${shape})`);
    });
  }
});

test("the payload declares its version and tracks the columns, not the area", () => {
  const small = new MapVoxelLayer(240, 136);
  small.setColumn(1, 1, 4, 2);
  const dense = seededLayer(240, 136);

  const parsed = JSON.parse(serializeMapVoxelLayer(small));
  // Untextured layers stay on version 1 so pre-material carts are byte-identical;
  // the version bump is covered separately.
  assert.equal(parsed.version, 1);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.shape, undefined, "cube is the default and is omitted");

  assert.ok(
    serializeMapVoxelLayer(small).length < serializeMapVoxelLayer(dense).length / 10,
    "one column costs far less than thousands on the same footprint",
  );
});

test("an empty layer serializes and restores as empty", () => {
  const restored = deserializeMapVoxelLayer(serializeMapVoxelLayer(new MapVoxelLayer(40, 30)));
  assert.ok(restored.isEmpty);
  assert.equal(restored.width, 40);
});

test("a malformed or hostile payload is rejected rather than trusted", () => {
  const layer = seededLayer(12, 12);
  const good = JSON.parse(serializeMapVoxelLayer(layer));

  assert.throws(() => deserializeMapVoxelLayer("not json"));
  assert.throws(() => deserializeMapVoxelLayer(JSON.stringify({ ...good, version: 99 })));
  // A count larger than the footprint can hold.
  assert.throws(() => deserializeMapVoxelLayer(JSON.stringify({ ...good, count: 12 * 12 + 1 })));
  // A count that disagrees with the payload lengths.
  assert.throws(() => deserializeMapVoxelLayer(JSON.stringify({ ...good, count: good.count + 1 })));
  // A stray cell index pointing outside the declared footprint.
  assert.throws(() =>
    deserializeMapVoxelLayer(JSON.stringify({ ...good, width: 2, height: 2, count: good.count })),
  );
});

test("rebuilding as a voxel grid stacks each column to its height", () => {
  const layer = new MapVoxelLayer(6, 5);
  layer.setColumn(1, 2, 4, 3);
  layer.setColumn(4, 0, 2, 5);
  const palette = (index) => [index * 10, index, 255 - index];
  const grid = mapLayerToVoxelGrid(layer, palette);

  assert.equal(grid.sizeX, layer.width);
  assert.equal(grid.sizeZ, layer.height);
  assert.equal(grid.sizeY, layer.peakHeight);
  // The map's y axis becomes the grid's z, and column height becomes grid y.
  for (let y = 0; y < 4; y += 1) assert.ok(grid.isFilled(1, y, 2), `column cell at height ${y}`);
  assert.ok(!grid.isFilled(1, 4, 2), "nothing above the column's top");
  assert.deepEqual(
    [grid.get(1, 0, 2).r, grid.get(1, 0, 2).g, grid.get(1, 0, 2).b],
    palette(3),
    "the column takes its palette colour",
  );
  assert.equal(grid.filledCount, 4 + 2, "only the authored columns are built");
});

test("a hexel layer only builds cells on the even-parity lattice", () => {
  const layer = seededLayer(20, 16, "hexel");
  const grid = mapLayerToVoxelGrid(layer, () => [200, 200, 200]);
  let filled = 0;
  for (let z = 0; z < grid.sizeZ; z += 1) {
    for (let y = 0; y < grid.sizeY; y += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        if (!grid.isFilled(x, y, z)) continue;
        filled += 1;
        assert.equal((x + y + z) % 2, 0, `hexel site ${x},${y},${z} has even parity`);
      }
    }
  }
  assert.ok(filled > 0, "the hexel layer still builds cells");

  // The same columns as cubes fill every site, so the hexel build is a strict
  // subset — roughly half — of the cube build.
  const cubes = mapLayerToVoxelGrid(layer.clone("cube"), () => [200, 200, 200]);
  assert.ok(filled < cubes.filledCount, "hexels place fewer cells than cubes for the same columns");
});

test("an oversized map is downsampled to fit the grid's footprint limit", () => {
  const layer = seededLayer(240, 136);
  const grid = mapLayerToVoxelGrid(layer, () => [100, 100, 100], { maxFootprint: 64 });
  assert.ok(grid.sizeX <= 64, `grid width ${grid.sizeX} fits the limit`);
  assert.ok(grid.sizeZ <= 64, `grid depth ${grid.sizeZ} fits the limit`);
  assert.ok(grid.filledCount > 0, "the downsample still carries content");
});

test("a column's material round-trips and only exists where a column does", () => {
  const layer = new MapVoxelLayer(8, 8);
  assert.ok(!layer.hasMaterials(), "a new layer is untextured");

  layer.setColumn(2, 2, 4, 6, 3);
  assert.equal(layer.materialAt(2, 2), 3);
  assert.deepEqual(layer.columnAt(2, 2), { height: 4, colorIndex: 6, material: 3 });
  assert.ok(layer.hasMaterials());

  // A material needs a column to sit on.
  layer.setMaterial(5, 5, 2);
  assert.equal(layer.materialAt(5, 5), COLUMN_MATERIAL_NONE, "an empty cell takes no material");

  // Clearing the column clears its material with it.
  layer.clear(2, 2);
  assert.equal(layer.materialAt(2, 2), COLUMN_MATERIAL_NONE);
});

test("recolouring a column keeps its material unless a new one is given", () => {
  const layer = new MapVoxelLayer(8, 8);
  layer.setColumn(1, 1, 3, 5, 7);

  layer.paint(1, 1, 9);
  assert.deepEqual(layer.columnAt(1, 1), { height: 3, colorIndex: 9, material: 7 }, "the skin survived");

  layer.paint(1, 1, 9, 2);
  assert.equal(layer.materialAt(1, 1), 2, "an explicit material replaces it");

  layer.paint(1, 1, 9, COLUMN_MATERIAL_NONE);
  assert.equal(layer.materialAt(1, 1), COLUMN_MATERIAL_NONE, "and flat is reachable");
});

test("raising an existing column keeps its skin; a new one takes the armed material", () => {
  const layer = new MapVoxelLayer(8, 8);
  layer.setColumn(3, 3, 2, 4, 8);

  layer.raise(3, 3, 3, 1, 5);
  assert.deepEqual(layer.columnAt(3, 3), { height: 5, colorIndex: 4, material: 8 }, "existing ground is untouched");

  layer.raise(6, 6, 2, 1, 5);
  assert.deepEqual(layer.columnAt(6, 6), { height: 2, colorIndex: 1, material: 5 }, "new ground takes both");
});

test("materials survive serialization and cloning", () => {
  for (const shape of ["cube", "hexel"]) {
    const layer = seededLayer(20, 16, shape);
    layer.forEachColumn((x, y) => layer.setMaterial(x, y, (x + y) % 6));

    const restored = deserializeMapVoxelLayer(serializeMapVoxelLayer(layer));
    assert.ok(restored.hasMaterials(), `${shape}: the payload carried materials`);
    layer.forEachColumn((x, y, column) => {
      assert.deepEqual(restored.columnAt(x, y), column, `${shape}: column ${x},${y} survived intact`);
    });

    const copy = layer.clone(shape === "cube" ? "hexel" : "cube");
    layer.forEachColumn((x, y, column) => {
      assert.equal(copy.materialAt(x, y), column.material, `${shape}: re-shaping kept the skin`);
    });
  }
});

test("an untextured layer still serializes as the original version-1 payload", () => {
  const layer = seededLayer(24, 18);
  const parsed = JSON.parse(serializeMapVoxelLayer(layer));
  assert.equal(parsed.version, 1, "no materials means no version bump");
  assert.equal(parsed.materials, undefined, "and no materials payload");

  layer.setMaterial(...(() => {
    let first = null;
    layer.forEachColumn((x, y) => {
      if (first === null) first = [x, y];
    });
    return [first[0], first[1], 2];
  })());
  const textured = JSON.parse(serializeMapVoxelLayer(layer));
  assert.equal(textured.version, MAP_VOXEL_LAYER_VERSION, "one material bumps the version");
  assert.ok(typeof textured.materials === "string", "and adds the payload");
});

test("a version-1 payload still loads, as untextured columns", () => {
  const layer = seededLayer(12, 12);
  const legacy = JSON.parse(serializeMapVoxelLayer(layer));
  assert.equal(legacy.version, 1);
  const restored = deserializeMapVoxelLayer(JSON.stringify(legacy));
  assert.equal(restored.columnCount, layer.columnCount);
  assert.ok(!restored.hasMaterials());
});

test("rebuilding as voxels carries the column material onto every cell", () => {
  const layer = new MapVoxelLayer(6, 5);
  layer.setColumn(1, 2, 4, 3, 6);
  layer.setColumn(4, 0, 2, 5); // deliberately flat
  const grid = mapLayerToVoxelGrid(layer, (index) => [index * 10, index, 255 - index]);

  for (let y = 0; y < 4; y += 1) {
    assert.equal(grid.materialAt(1, y, 2), 6, `skinned column cell at height ${y}`);
  }
  // A skinned column is built white so its art reads true; a flat one keeps its
  // palette colour.
  const skinned = grid.get(1, 0, 2);
  assert.deepEqual([skinned.r, skinned.g, skinned.b], [255, 255, 255]);
  const flat = grid.get(4, 0, 0);
  assert.equal(grid.materialAt(4, 0, 0), -1);
  assert.deepEqual([flat.r, flat.g, flat.b], [50, 5, 250]);
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

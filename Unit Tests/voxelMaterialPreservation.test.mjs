/**
 * Unit tests for materials surviving the operations that used to destroy them
 * (packages/editor/src/model/VoxelGrid.ts).
 *
 * `set` defaults its material parameter to "none", so every caller that used it
 * merely to recolour a voxel silently stripped that voxel's skin — the Paint
 * Bucket, the Paint brush, the Shape stamp, painting a selection, resizing the
 * grid, and scaling an axis. `recolor` exists so a recolour means a recolour,
 * and the copy paths now carry the material across.
 *
 * These lock the behaviour down at the model level, where every one of those
 * tools eventually lands.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelMaterialPreservation.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { VoxelGrid, scaleGridAxis, voxelGridToModel, MATERIAL_NONE } = await load(
  "../packages/editor/src/model/VoxelGrid.ts",
);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** A grid whose every filled voxel wears a material, for loss detection. */
function texturedGrid(size = 6, material = 4) {
  const grid = new VoxelGrid(size, size, size);
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) grid.set(x, y, z, 200, 180, 160, 0, material);
    }
  }
  return grid;
}

/** How many filled cells still carry a material. */
function texturedCount(grid) {
  let count = 0;
  grid.forEachFilled((x, y, z) => {
    if (grid.materialAt(x, y, z) >= 0) count += 1;
  });
  return count;
}

test("recolour keeps the voxel's material and emissive", () => {
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(1, 1, 1, 200, 100, 50, 120, 7);

  grid.recolor(1, 1, 1, 10, 20, 30);
  const cell = grid.get(1, 1, 1);
  assert.deepEqual([cell.r, cell.g, cell.b], [10, 20, 30], "the colour changed");
  assert.equal(cell.tile, 7, "the material survived");
  assert.equal(cell.emissive, 120, "the emissive survived");
});

test("recolour never conjures a voxel out of empty space", () => {
  const grid = new VoxelGrid(4, 4, 4);
  grid.recolor(2, 2, 2, 255, 0, 0);
  assert.equal(grid.get(2, 2, 2), null, "an empty cell stays empty");
  assert.equal(grid.filledCount, 0);

  grid.recolor(-1, 0, 0, 255, 0, 0); // out of bounds is a no-op, not a throw
  assert.equal(grid.filledCount, 0);
});

test("set with an explicit material still replaces the old one", () => {
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(1, 1, 1, 200, 100, 50, 0, 7);
  grid.set(1, 1, 1, 200, 100, 50, 0, 3);
  assert.equal(grid.materialAt(1, 1, 1), 3, "an armed material lands");

  // And a negative index is still the way to deliberately strip one.
  grid.set(1, 1, 1, 200, 100, 50, 0, MATERIAL_NONE);
  assert.equal(grid.materialAt(1, 1, 1), MATERIAL_NONE, "flat is still reachable");
});

test("scaling an axis carries every material across", () => {
  for (const axis of [0, 1, 2]) {
    const grid = texturedGrid();
    const before = texturedCount(grid);

    const grown = scaleGridAxis(grid, axis, 1.5);
    assert.ok(grown.filledCount > 0, `axis ${axis} produced a sculpt`);
    assert.equal(
      texturedCount(grown),
      grown.filledCount,
      `axis ${axis}: every voxel of the scaled sculpt kept a material`,
    );
    assert.ok(before > 0, "the source really was textured");

    const squashed = scaleGridAxis(grid, axis, 0.5);
    assert.equal(texturedCount(squashed), squashed.filledCount, `axis ${axis}: squashing kept materials too`);
  }
});

test("scaling keeps the exact material each voxel wore, not just some material", () => {
  const size = 6;
  const grid = new VoxelGrid(size, size, size);
  // Two distinct materials in separate halves, so a mix-up is detectable.
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) grid.set(x, y, z, 200, 180, 160, 0, x < size / 2 ? 2 : 5);
    }
  }
  const scaled = scaleGridAxis(grid, 1, 1.5); // scale on Y; the split is on X
  scaled.forEachFilled((x, y, z) => {
    assert.equal(scaled.materialAt(x, y, z), x < size / 2 ? 2 : 5, `voxel ${x},${y},${z} kept its own material`);
  });
});

test("a grid clone carries materials, so undo snapshots keep the skin", () => {
  const grid = texturedGrid();
  const copy = grid.clone();
  assert.equal(texturedCount(copy), texturedCount(grid));
  copy.set(0, 0, 0, 1, 2, 3, 0, MATERIAL_NONE);
  assert.equal(grid.materialAt(0, 0, 0), 4, "the original is untouched");
});

test("a textured grid still builds a model carrying per-voxel tiles", () => {
  const grid = texturedGrid();
  const model = voxelGridToModel(grid);
  assert.ok(model.tile, "the model carries a tile array");
  assert.equal(model.tile.length, model.count);
  for (let v = 0; v < model.count; v += 1) {
    assert.equal(model.tile[v], 4, `rendered voxel ${v} kept its material`);
  }

  // And the same sculpt after a scale must still render textured — the property
  // that was broken before copyGridLayer carried materials.
  const scaled = voxelGridToModel(scaleGridAxis(grid, 0, 1.5));
  assert.ok(scaled.tile, "the scaled model still carries tiles");
  for (let v = 0; v < scaled.count; v += 1) {
    assert.ok(scaled.tile[v] >= 0, `scaled voxel ${v} is still textured`);
  }
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

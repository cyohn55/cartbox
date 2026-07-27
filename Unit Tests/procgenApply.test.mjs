/**
 * Unit tests for applying a generated field to the three things the editor
 * authors (packages/editor/src/procgen/apply.ts), driven through the *real*
 * models — a TileMap and SpriteSheet over a StubCartEngine, and a real
 * MapVoxelLayer — rather than stand-ins, so the structural interfaces are proven
 * to actually fit the classes they were written for.
 *
 * Expected values are read back from the same field that was applied, so the
 * assertions hold for any generator and any mapping.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/procgenApply.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { StubCartEngine } = await load("../packages/editor/src/engine/StubCartEngine.ts");
const { TileMap } = await load("../packages/editor/src/model/TileMap.ts");
const { SpriteSheet } = await load("../packages/editor/src/model/SpriteSheet.ts");
const { MapVoxelLayer, MAX_MAP_COLUMN_HEIGHT } = await load("../packages/editor/src/model/MapVoxelLayer.ts");
const { classAt } = await load("../packages/editor/src/procgen/classField.ts");
const { applyFieldToTiles, applyFieldToPixels, applyFieldToColumns, defaultClassMapping } = await load(
  "../packages/editor/src/procgen/apply.ts",
);
const { MAP_GENERATORS, defaultValues, findGenerator, paramValue } = await load(
  "../packages/editor/src/procgen/generators.ts",
);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** A fresh map, sheet and column layer over one stub cart. */
function makeCart() {
  const engine = new StubCartEngine();
  const map = new TileMap(engine);
  const sheet = new SpriteSheet(engine);
  const columns = new MapVoxelLayer(map.width, map.height);
  return { engine, map, sheet, columns };
}

/** Generate a field from a registered generator at a given size. */
function fieldFrom(id, width, height, overrides = {}) {
  const generator = findGenerator(MAP_GENERATORS, id);
  return generator.generate(width, height, { ...defaultValues(generator.params), ...overrides });
}

test("every registered generator declares usable parameters and a legend", () => {
  assert.ok(MAP_GENERATORS.length >= 4, `registry holds ${MAP_GENERATORS.length} generators`);
  const ids = new Set();
  for (const generator of MAP_GENERATORS) {
    assert.ok(!ids.has(generator.id), `generator id ${generator.id} is unique`);
    ids.add(generator.id);
    assert.ok(generator.legend.length > 0, `${generator.id} names its classes`);
    assert.ok(generator.description.length > 0, `${generator.id} describes itself`);
    for (const spec of generator.params) {
      assert.ok(spec.max > spec.min, `${generator.id}.${spec.key} has a usable range`);
      assert.ok(spec.value >= spec.min && spec.value <= spec.max, `${generator.id}.${spec.key} default is in range`);
      assert.ok(spec.step > 0, `${generator.id}.${spec.key} steps`);
      assert.ok(spec.hint.length > 0, `${generator.id}.${spec.key} is explained`);
    }
    assert.ok(
      generator.params.some((spec) => spec.key === "seed"),
      `${generator.id} is seeded`,
    );
  }
});

test("generated fields fit the requested size and stay inside their legend", () => {
  for (const generator of MAP_GENERATORS) {
    const field = generator.generate(37, 23, defaultValues(generator.params));
    assert.equal(field.width, 37, `${generator.id} width`);
    assert.equal(field.height, 23, `${generator.id} height`);
    assert.equal(field.classes.length, 37 * 23, `${generator.id} cell count`);
    for (const value of field.classes) {
      assert.ok(value < generator.legend.length, `${generator.id} emitted class ${value} inside its legend`);
    }
  }
});

test("parameter values are clamped to the spec's range", () => {
  const generator = findGenerator(MAP_GENERATORS, "terrain");
  const spec = generator.params.find((entry) => entry.key === "hills");
  assert.equal(paramValue(generator.params, { hills: spec.max + 100 }, "hills"), spec.max);
  assert.equal(paramValue(generator.params, { hills: spec.min - 100 }, "hills"), spec.min);
  // Missing and unusable values fall back to the declared default.
  assert.equal(paramValue(generator.params, {}, "hills"), spec.value);
  assert.equal(paramValue(generator.params, { hills: Number.NaN }, "hills"), spec.value);
});

test("applying a field to the tile map stamps the mapped tile in every cell", () => {
  const { map } = makeCart();
  const field = fieldFrom("terrain", map.width, map.height);
  const mapping = defaultClassMapping(findGenerator(MAP_GENERATORS, "terrain").legend);

  const written = applyFieldToTiles(map, field, mapping);
  assert.equal(written, map.width * map.height, "every cell was written");
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      assert.equal(map.getCell(x, y), mapping[classAt(field, x, y)].tile, `cell ${x},${y} matches its class`);
    }
  }
});

test("a field smaller than the map only touches the region it covers", () => {
  const { map } = makeCart();
  const marker = 9;
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) map.setCell(x, y, marker);
  }

  const field = fieldFrom("maze", 21, 15);
  const mapping = defaultClassMapping(findGenerator(MAP_GENERATORS, "maze").legend);
  const origin = { originX: 4, originY: 6 };
  const written = applyFieldToTiles(map, field, mapping, origin);

  assert.equal(written, field.width * field.height);
  assert.equal(map.getCell(0, 0), marker, "outside the region is untouched");
  assert.equal(map.getCell(origin.originX + field.width, origin.originY), marker, "just past the region too");
  assert.equal(
    map.getCell(origin.originX, origin.originY),
    mapping[classAt(field, 0, 0)].tile,
    "the region's corner took the field's corner class",
  );
});

test("writing past the map's edge is clipped rather than wrapped", () => {
  const { map } = makeCart();
  const field = fieldFrom("caves", 20, 20);
  const mapping = defaultClassMapping(findGenerator(MAP_GENERATORS, "caves").legend);
  const written = applyFieldToTiles(map, field, mapping, {
    originX: map.width - 5,
    originY: map.height - 5,
  });
  assert.equal(written, 25, "only the five-by-five overlap was written");
  assert.equal(map.getCell(0, 0), 0, "nothing wrapped around to the origin");
});

test("applying a field as pixels paints the sprite sheet through nearest sampling", () => {
  const { sheet } = makeCart();
  const region = { x: 0, y: 0, width: sheet.sheetSize, height: sheet.sheetSize };
  const field = fieldFrom("dungeon", 40, 40);
  const mapping = defaultClassMapping(findGenerator(MAP_GENERATORS, "dungeon").legend);

  const surface = {
    width: sheet.sheetSize,
    height: sheet.sheetSize,
    setPixel: (x, y, colorIndex) => {
      const tile = Math.floor(y / sheet.tileSize) * sheet.sheetCols + Math.floor(x / sheet.tileSize);
      sheet.setPixel(0, tile, x % sheet.tileSize, y % sheet.tileSize, colorIndex);
    },
  };
  const written = applyFieldToPixels(surface, field, mapping, region);
  assert.equal(written, region.width * region.height, "the whole region was painted");

  // Spot-check the sampling: each painted pixel must carry the colour of the
  // field cell that covers it, computed the same way the applier does.
  for (const [px, py] of [
    [0, 0],
    [region.width - 1, region.height - 1],
    [Math.floor(region.width / 3), Math.floor(region.height / 2)],
  ]) {
    const fx = Math.min(field.width - 1, Math.floor((px / region.width) * field.width));
    const fy = Math.min(field.height - 1, Math.floor((py / region.height) * field.height));
    const tile = Math.floor(py / sheet.tileSize) * sheet.sheetCols + Math.floor(px / sheet.tileSize);
    assert.equal(
      sheet.getPixel(0, tile, px % sheet.tileSize, py % sheet.tileSize),
      mapping[classAt(field, fx, fy)].colorIndex,
      `pixel ${px},${py} sampled its covering class`,
    );
  }
});

test("applying a field as columns raises exactly the classes with height", () => {
  const { map, columns } = makeCart();
  const field = fieldFrom("terrain", map.width, map.height);
  const generator = findGenerator(MAP_GENERATORS, "terrain");
  const mapping = defaultClassMapping(generator.legend);

  const raised = applyFieldToColumns(columns, field, mapping);
  let expected = 0;
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const entry = mapping[classAt(field, x, y)];
      assert.equal(columns.heightAt(x, y), entry.columnHeight, `column ${x},${y} matches its class`);
      if (entry.columnHeight > 0) expected += 1;
    }
  }
  assert.equal(raised, expected, "the reported count matches what was raised");
  assert.equal(columns.columnCount, expected);
});

test("a palette lookup snaps each class to the nearest colour the cart holds", () => {
  const { sheet } = makeCart();
  const generator = findGenerator(MAP_GENERATORS, "terrain");
  const mapping = defaultClassMapping(generator.legend, {
    nearestColor: ([r, g, b]) => sheet.nearestColorIndex(r, g, b),
  });
  for (let i = 0; i < generator.legend.length; i += 1) {
    const [r, g, b] = generator.legend[i].color;
    assert.equal(mapping[i].colorIndex, sheet.nearestColorIndex(r, g, b), `class ${i} took its nearest colour`);
  }
  // Without a lookup the mapping falls back to consecutive palette slots.
  const plain = defaultClassMapping(generator.legend);
  assert.deepEqual(
    plain.map((entry) => entry.colorIndex),
    generator.legend.map((_entry, index) => 1 + index),
  );
});

test("the default mapping terraces a legend from its low ground upward", () => {
  for (const generator of MAP_GENERATORS) {
    const mapping = defaultClassMapping(generator.legend);
    assert.equal(mapping.length, generator.legend.length);
    assert.equal(mapping[0].columnHeight, 0, `${generator.id}'s lowest class stays flat`);
    for (let i = 1; i < mapping.length; i += 1) {
      assert.ok(mapping[i].columnHeight >= mapping[i - 1].columnHeight, `${generator.id} heights ascend`);
      assert.ok(mapping[i].columnHeight <= MAX_MAP_COLUMN_HEIGHT, `${generator.id} heights stay in range`);
      assert.notEqual(mapping[i].tile, mapping[i - 1].tile, `${generator.id} classes get distinct tiles`);
    }
  }
});

test("editing the mapping changes the result without regenerating the field", () => {
  const { map } = makeCart();
  const field = fieldFrom("caves", map.width, map.height);
  const generator = findGenerator(MAP_GENERATORS, "caves");
  const mapping = defaultClassMapping(generator.legend);
  applyFieldToTiles(map, field, mapping);
  const before = map.getCell(0, 0);

  const retuned = mapping.map((entry) => ({ ...entry, tile: entry.tile + 100 }));
  applyFieldToTiles(map, field, retuned);
  assert.equal(map.getCell(0, 0), before + 100, "the same field produced a different stamp");
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

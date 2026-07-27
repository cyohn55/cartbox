/**
 * Unit tests for procedural generation producing *materials*, not just colours
 * (packages/editor/src/procgen/).
 *
 * Generators stay pure and atlas-agnostic: they say what a cell is — grass,
 * bedrock, brick — and a caller-supplied {@link MaterialResolver} turns that into
 * an index in whatever atlas the editor uses. These cover both halves: that the
 * generators emit sensible surfaces, and that a caller without a resolver still
 * gets exactly the flat output it used to.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/procgenMaterials.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { VoxelGrid, MATERIAL_NONE } = await load("../packages/editor/src/model/VoxelGrid.ts");
const { MapVoxelLayer, COLUMN_MATERIAL_NONE } = await load("../packages/editor/src/model/MapVoxelLayer.ts");
const { SURFACE_IDS, NO_MATERIAL, resolveMaterial } = await load("../packages/editor/src/procgen/surfaces.ts");
const { strataSurfaceAt, terrainSurfaceOf, TERRAIN_CLASS, TERRAIN_LEGEND } = await load(
  "../packages/editor/src/procgen/terrain.ts",
);
const { VOXEL_GENERATORS, defaultValues, findGenerator } = await load(
  "../packages/editor/src/procgen/generators.ts",
);
const { defaultClassMapping, applyFieldToColumns, surfaceForClassId } = await load(
  "../packages/editor/src/procgen/apply.ts",
);
const { MAP_GENERATORS } = await load("../packages/editor/src/procgen/generators.ts");
const { classAt } = await load("../packages/editor/src/procgen/classField.ts");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/**
 * A stand-in atlas: each surface gets its own index, so a generated cell's
 * material can be traced back to the surface that produced it.
 */
const SURFACE_INDEX = new Map(SURFACE_IDS.map((surface, index) => [surface, index]));
const testResolver = (surface) => SURFACE_INDEX.get(surface) ?? NO_MATERIAL;
/** An atlas missing a surface, to prove unmapped surfaces stay flat. */
const partialResolver = (surface) => (surface === "snow" ? NO_MATERIAL : (SURFACE_INDEX.get(surface) ?? NO_MATERIAL));

/** Run a 3D generator into a fresh grid. */
function run(id, size, lattice, overrides = {}) {
  const generator = findGenerator(VOXEL_GENERATORS, id);
  const grid = new VoxelGrid(size, size, size);
  generator.generate(grid, lattice, { ...defaultValues(generator.params), ...overrides });
  return grid;
}

/** The distinct materials a grid's filled cells wear. */
function materialsUsed(grid) {
  const seen = new Set();
  grid.forEachFilled((x, y, z) => seen.add(grid.materialAt(x, y, z)));
  return seen;
}

// --- The resolver contract -------------------------------------------------

test("resolveMaterial tolerates a missing resolver and a nonsense answer", () => {
  assert.equal(resolveMaterial(undefined, "grass"), NO_MATERIAL);
  assert.equal(resolveMaterial(() => -5, "grass"), NO_MATERIAL);
  assert.equal(resolveMaterial(() => Number.NaN, "grass"), NO_MATERIAL);
  assert.equal(resolveMaterial(() => 1.5, "grass"), NO_MATERIAL, "a non-integer index is not a material");
  assert.equal(resolveMaterial(() => 0, "grass"), 0, "index zero is a real material, not falsy");
  assert.equal(resolveMaterial(testResolver, "rock"), SURFACE_INDEX.get("rock"));
});

test("every terrain class and stratum names a surface the vocabulary knows", () => {
  for (let value = 0; value < TERRAIN_LEGEND.length; value += 1) {
    assert.ok(SURFACE_IDS.includes(terrainSurfaceOf(value)), `class ${value} names a known surface`);
  }
  for (let below = 0; below < 24; below += 1) {
    const surface = strataSurfaceAt(TERRAIN_CLASS.grass, below, 24);
    assert.ok(SURFACE_IDS.includes(surface), `depth ${below} names a known surface`);
  }
  // The surface stratum is the class's own; below it is soil, then rock.
  assert.equal(strataSurfaceAt(TERRAIN_CLASS.grass, 0, 24), "grass");
  assert.equal(strataSurfaceAt(TERRAIN_CLASS.grass, 1, 24), "dirt");
  assert.equal(strataSurfaceAt(TERRAIN_CLASS.grass, 23, 24), "rock");
});

test("every legend class of every generator maps to a known surface", () => {
  for (const generator of MAP_GENERATORS) {
    for (const info of generator.legend) {
      assert.ok(
        SURFACE_IDS.includes(surfaceForClassId(info.id)),
        `${generator.id}/${info.id} names a known surface`,
      );
    }
  }
});

// --- 3D generation ---------------------------------------------------------

test("without a resolver, generation is exactly as flat as it always was", () => {
  for (const generator of VOXEL_GENERATORS) {
    const grid = run(generator.id, 16, { evenParity: false });
    assert.ok(grid.filledCount > 0, `${generator.id} produced cells`);
    assert.ok(!grid.hasMaterials(), `${generator.id} left every cell flat`);
  }
});

test("with a resolver, every generator skins what it builds", () => {
  for (const generator of VOXEL_GENERATORS) {
    const grid = run(generator.id, 20, { evenParity: false, materialFor: testResolver });
    assert.ok(grid.hasMaterials(), `${generator.id} applied materials`);

    const used = materialsUsed(grid);
    used.delete(MATERIAL_NONE);
    assert.ok(used.size >= 2, `${generator.id} used ${used.size} materials, expected variety`);
    for (const material of used) {
      assert.ok(
        [...SURFACE_INDEX.values()].includes(material),
        `${generator.id} used material ${material}, which no surface produces`,
      );
    }
  }
});

test("terrain lays its strata as distinct materials, surface over soil over rock", () => {
  const grid = run("terrain", 24, { evenParity: false, materialFor: testResolver }, { island: 0, relief: 1.5 });
  const rock = SURFACE_INDEX.get("rock");
  const dirt = SURFACE_INDEX.get("dirt");

  // Find a tall column and walk it: the deepest cell must be rock, and the
  // material must never revert to one already left behind on the way down.
  let tallest = null;
  for (let z = 0; z < grid.sizeZ && !tallest; z += 1) {
    for (let x = 0; x < grid.sizeX; x += 1) {
      let top = -1;
      for (let y = grid.sizeY - 1; y >= 0; y -= 1) {
        if (grid.isFilled(x, y, z)) {
          top = y;
          break;
        }
      }
      if (top >= 6) {
        tallest = [x, top, z];
        break;
      }
    }
  }
  assert.ok(tallest, "terrain raised a column tall enough to show strata");
  const [cx, top, cz] = tallest;
  assert.equal(grid.materialAt(cx, 0, cz), rock, "the column bottoms out in rock");
  assert.ok(
    [dirt, rock].includes(grid.materialAt(cx, top - 1, cz)),
    "the cell under the surface is soil or rock, never the surface material again",
  );
});

test("a surface the atlas lacks stays flat and keeps its own colour", () => {
  // Snow is unmapped in the partial resolver, so snowy peaks must stay flat —
  // wearing the wrong tile would be worse than wearing none.
  const grid = run("terrain", 28, { evenParity: false, materialFor: partialResolver }, { relief: 2, island: 0 });
  const snowColor = TERRAIN_LEGEND[TERRAIN_CLASS.snow].color;
  let flatCells = 0;
  grid.forEachFilled((x, y, z, cell) => {
    if (grid.materialAt(x, y, z) !== MATERIAL_NONE) return;
    flatCells += 1;
    // A flat cell keeps the generator's colour rather than the textured white.
    assert.ok(
      !(cell.r === 255 && cell.g === 255 && cell.b === 255) || snowColor[0] === 255,
      "an unskinned cell is not painted the textured-albedo white",
    );
  });
  assert.ok(flatCells > 0, "the unmapped surface produced flat cells");
});

test("a skinned cell is painted white so its tile art reads true", () => {
  const grid = run("maze", 21, { evenParity: false, materialFor: testResolver });
  grid.forEachFilled((x, y, z, cell) => {
    if (grid.materialAt(x, y, z) < 0) return;
    assert.deepEqual([cell.r, cell.g, cell.b], [255, 255, 255], `skinned cell ${x},${y},${z} is white`);
  });
});

test("materials respect the hexel lattice like everything else", () => {
  for (const generator of VOXEL_GENERATORS) {
    const grid = run(generator.id, 20, { evenParity: true, materialFor: testResolver });
    grid.forEachFilled((x, y, z) => {
      assert.equal((x + y + z) % 2, 0, `${generator.id} placed a skinned cell off the FCC lattice`);
    });
    assert.ok(grid.hasMaterials(), `${generator.id} skinned its hexels`);
  }
});

// --- 2D generation onto columns --------------------------------------------

test("the default class mapping resolves a material per class when asked", () => {
  const generator = findGenerator(MAP_GENERATORS, "terrain");
  const plain = defaultClassMapping(generator.legend);
  for (const entry of plain) {
    assert.equal(entry.material, NO_MATERIAL, "no resolver means no material");
  }

  const skinned = defaultClassMapping(generator.legend, { materialFor: testResolver });
  for (let i = 0; i < generator.legend.length; i += 1) {
    assert.equal(
      skinned[i].material,
      testResolver(surfaceForClassId(generator.legend[i].id)),
      `class ${generator.legend[i].id} took its surface's material`,
    );
  }
});

test("generating columns skins them, and the material follows the class", () => {
  const generator = findGenerator(MAP_GENERATORS, "terrain");
  const field = generator.generate(48, 32, defaultValues(generator.params));
  const mapping = defaultClassMapping(generator.legend, { materialFor: testResolver });
  const layer = new MapVoxelLayer(48, 32);

  applyFieldToColumns(layer, field, mapping);
  assert.ok(layer.hasMaterials(), "the generated landscape is skinned");

  layer.forEachColumn((x, y, column) => {
    assert.equal(column.material, mapping[classAt(field, x, y)].material, `column ${x},${y} matches its class`);
  });
});

test("a mapping with no materials leaves the columns flat", () => {
  const generator = findGenerator(MAP_GENERATORS, "caves");
  const field = generator.generate(40, 30, defaultValues(generator.params));
  const layer = new MapVoxelLayer(40, 30);
  applyFieldToColumns(layer, field, defaultClassMapping(generator.legend));
  assert.ok(!layer.hasMaterials(), "nothing was skinned");
  layer.forEachColumn((_x, _y, column) => {
    assert.equal(column.material, COLUMN_MATERIAL_NONE);
  });
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

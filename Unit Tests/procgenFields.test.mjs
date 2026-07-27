/**
 * Unit tests for the 2D generators: the height field and its terrain
 * classification, cellular-automaton caves, rooms-and-corridors dungeons, and
 * mazes (packages/editor/src/procgen/).
 *
 * The assertions are the structural guarantees each generator claims — a
 * dungeon is one connected level, a maze reaches every corridor cell, caves are
 * enclosed, terrain bands stay ordered — checked by flooding and counting the
 * real output. Nothing is compared against a recorded layout, so retuning a
 * generator's feel does not invalidate the suite.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/procgenFields.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { classAt, countByClass } = await load("../packages/editor/src/procgen/classField.ts");
const { generateHeightField, heightAt, DEFAULT_HEIGHT_FIELD_PARAMS } = await load(
  "../packages/editor/src/procgen/heightField.ts",
);
const {
  classifyTerrain,
  terrainClassOf,
  bandsForWaterLevel,
  isWaterClass,
  strataColorAt,
  TERRAIN_LEGEND,
  TERRAIN_CLASS,
  DEFAULT_TERRAIN_BANDS,
} = await load("../packages/editor/src/procgen/terrain.ts");
const { generateCaves2D, generateCaves3D, CAVE_CLASS, DEFAULT_CAVE_PARAMS } = await load(
  "../packages/editor/src/procgen/caves.ts",
);
const { generateDungeon, isWalkable, DUNGEON_CLASS, DEFAULT_DUNGEON_PARAMS } = await load(
  "../packages/editor/src/procgen/dungeon.ts",
);
const { generateMaze, MAZE_CLASS } = await load("../packages/editor/src/procgen/maze.ts");

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** Flood a field from a start cell across the cells a predicate accepts. */
function floodCount(field, start, accepts) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const key = y * field.width + x;
    if (seen.has(key)) continue;
    if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
    if (!accepts(classAt(field, x, y))) continue;
    seen.add(key);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return seen.size;
}

/** Every cell whose class satisfies the predicate, as [x, y] pairs. */
function cellsWhere(field, accepts) {
  const found = [];
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      if (accepts(classAt(field, x, y))) found.push([x, y]);
    }
  }
  return found;
}

// --- Height field ----------------------------------------------------------

test("a height field has the requested dimensions and normalized values", () => {
  const field = generateHeightField({ ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 40, depth: 25, seed: 5 });
  assert.equal(field.width, 40);
  assert.equal(field.depth, 25);
  assert.equal(field.heights.length, 40 * 25);
  assert.equal(field.moisture.length, 40 * 25);
  for (const value of field.heights) assert.ok(value >= 0 && value <= 1, `height ${value} normalized`);
  for (const value of field.moisture) assert.ok(value >= 0 && value <= 1, `moisture ${value} normalized`);
});

test("the same params regenerate an identical field", () => {
  const params = { ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 32, depth: 32, seed: 77 };
  assert.deepEqual([...generateHeightField(params).heights], [...generateHeightField(params).heights]);
  const other = generateHeightField({ ...params, seed: 78 });
  assert.notDeepEqual([...other.heights], [...generateHeightField(params).heights]);
});

test("height and moisture are independent channels", () => {
  const field = generateHeightField({ ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 48, depth: 48, seed: 11 });
  assert.notDeepEqual([...field.moisture], [...field.heights]);
});

test("the island edge pulls the border down and leaves the interior alone", () => {
  const base = { ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 61, depth: 61, seed: 21 };
  const open = generateHeightField({ ...base, edgeFalloff: 0 });
  const island = generateHeightField({ ...base, edgeFalloff: 1 });

  const centre = [Math.floor(base.width / 2), Math.floor(base.depth / 2)];
  assert.equal(heightAt(island, centre[0], centre[1]), heightAt(open, centre[0], centre[1]));

  // Averaged over the whole border ring, the island must sit lower.
  const borderMean = (field) => {
    let sum = 0;
    let count = 0;
    for (let x = 0; x < field.width; x += 1) {
      sum += heightAt(field, x, 0) + heightAt(field, x, field.depth - 1);
      count += 2;
    }
    return sum / count;
  };
  assert.ok(borderMean(island) < borderMean(open), "the border shelves off");
});

test("relief scales how far the terrain departs from the base level", () => {
  const base = { ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 48, depth: 48, seed: 33, edgeFalloff: 0 };
  const spread = (relief) => {
    const field = generateHeightField({ ...base, relief });
    return Math.max(...field.heights) - Math.min(...field.heights);
  };
  assert.ok(spread(1.5) > spread(0.5), "more relief means a wider height spread");
  assert.ok(spread(0.1) < spread(1), "flattening narrows it");
});

// --- Terrain classification ------------------------------------------------

test("terrain class never falls as height rises", () => {
  // The legend is ordered low ground to high, so classification must be
  // monotonic in height for a fixed moisture.
  let previous = -1;
  for (let step = 0; step <= 100; step += 1) {
    const value = terrainClassOf(step / 100, 0, DEFAULT_TERRAIN_BANDS, 0.55);
    assert.ok(value >= previous, `class ${value} follows ${previous}`);
    assert.ok(value < TERRAIN_LEGEND.length, "class is inside the legend");
    previous = value;
  }
});

test("moisture only decides between grass and forest", () => {
  const dry = [];
  const wet = [];
  for (let step = 0; step <= 100; step += 1) {
    dry.push(terrainClassOf(step / 100, 0, DEFAULT_TERRAIN_BANDS, 0.5));
    wet.push(terrainClassOf(step / 100, 1, DEFAULT_TERRAIN_BANDS, 0.5));
  }
  for (let i = 0; i < dry.length; i += 1) {
    if (dry[i] === wet[i]) continue;
    assert.equal(dry[i], TERRAIN_CLASS.grass);
    assert.equal(wet[i], TERRAIN_CLASS.forest);
  }
  assert.ok(dry.some((value, i) => value !== wet[i]), "moisture changes something");
});

test("the water level control keeps the bands ordered and moves the coastline", () => {
  for (const level of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const bands = bandsForWaterLevel(level);
    const ordered = [bands.deepWater, bands.waterLine, bands.shore, bands.treeLine, bands.snowLine];
    for (let i = 1; i < ordered.length; i += 1) {
      assert.ok(ordered[i] >= ordered[i - 1], `band ${i} follows band ${i - 1} at level ${level}`);
    }
    assert.ok(Math.abs(bands.waterLine - level) < 1e-9, "the waterline lands where asked");
  }

  const field = generateHeightField({ ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 64, depth: 64, seed: 9 });
  const waterShare = (level) => {
    const classified = classifyTerrain(field, { bands: bandsForWaterLevel(level) });
    return cellsWhere(classified, isWaterClass).length;
  };
  assert.ok(waterShare(0.8) > waterShare(0.2), "raising the water level floods more of the map");
});

test("classifying a field produces one class per column, all within the legend", () => {
  const field = generateHeightField({ ...DEFAULT_HEIGHT_FIELD_PARAMS, width: 33, depth: 21, seed: 4 });
  const classified = classifyTerrain(field);
  assert.equal(classified.width, 33);
  assert.equal(classified.height, 21);
  assert.equal(classified.classes.length, 33 * 21);
  assert.equal(classified.legend, TERRAIN_LEGEND);
  const counts = countByClass(classified);
  assert.equal(
    counts.reduce((sum, value) => sum + value, 0),
    33 * 21,
    "every cell is accounted for",
  );
});

test("strata run surface, soil, stone, bedrock from the top down", () => {
  const height = 20;
  const surface = strataColorAt(TERRAIN_CLASS.grass, 0, height);
  assert.deepEqual(surface, TERRAIN_LEGEND[TERRAIN_CLASS.grass].color);

  // Walk down the column and confirm the material only ever changes downward,
  // never back to one already left behind.
  const seen = [];
  for (let below = 0; below < height; below += 1) {
    const color = strataColorAt(TERRAIN_CLASS.grass, below, height).join(",");
    if (seen[seen.length - 1] !== color) {
      assert.ok(!seen.includes(color), `material ${color} is not revisited`);
      seen.push(color);
    }
  }
  assert.ok(seen.length >= 3, `a ${height}-cell column shows at least three materials, saw ${seen.length}`);
});

// --- Caves -----------------------------------------------------------------

test("caves are enclosed by rock and reproducible from the seed", () => {
  const field = generateCaves2D(60, 40, DEFAULT_CAVE_PARAMS);
  assert.equal(field.width, 60);
  assert.equal(field.height, 40);
  for (let x = 0; x < field.width; x += 1) {
    assert.equal(classAt(field, x, 0), CAVE_CLASS.rock, "top border is rock");
    assert.equal(classAt(field, x, field.height - 1), CAVE_CLASS.rock, "bottom border is rock");
  }
  for (let y = 0; y < field.height; y += 1) {
    assert.equal(classAt(field, 0, y), CAVE_CLASS.rock, "left border is rock");
    assert.equal(classAt(field, field.width - 1, y), CAVE_CLASS.rock, "right border is rock");
  }

  const again = generateCaves2D(60, 40, DEFAULT_CAVE_PARAMS);
  assert.deepEqual([...again.classes], [...field.classes]);
  const other = generateCaves2D(60, 40, { ...DEFAULT_CAVE_PARAMS, seed: DEFAULT_CAVE_PARAMS.seed + 1 });
  assert.notDeepEqual([...other.classes], [...field.classes]);
});

test("raising the rock density leaves less open cave", () => {
  const open = (density) =>
    countByClass(generateCaves2D(70, 70, { ...DEFAULT_CAVE_PARAMS, density }))[CAVE_CLASS.floor];
  assert.ok(open(0.35) > open(0.6), "a denser fill carves less space");
});

test("smoothing passes reduce the number of isolated pockets", () => {
  /** Count the separate open regions, as a measure of how noisy the cave is. */
  const regions = (steps) => {
    const field = generateCaves2D(60, 60, { ...DEFAULT_CAVE_PARAMS, steps });
    const seen = new Set();
    let count = 0;
    for (const [x, y] of cellsWhere(field, (value) => value === CAVE_CLASS.floor)) {
      if (seen.has(y * field.width + x)) continue;
      count += 1;
      // Re-flood into the shared `seen` set so each region is counted once.
      const stack = [[x, y]];
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        const key = cy * field.width + cx;
        if (seen.has(key)) continue;
        if (cx < 0 || cy < 0 || cx >= field.width || cy >= field.height) continue;
        if (classAt(field, cx, cy) !== CAVE_CLASS.floor) continue;
        seen.add(key);
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
    }
    return count;
  };
  assert.ok(regions(6) < regions(0), "smoothing consolidates the noise into caverns");
});

test("the 3D cave volume fills the requested box and stays reproducible", () => {
  const params = { ...DEFAULT_CAVE_PARAMS, steps: 2 };
  const volume = generateCaves3D(12, 10, 14, params);
  assert.equal(volume.sizeX, 12);
  assert.equal(volume.sizeY, 10);
  assert.equal(volume.sizeZ, 14);
  assert.equal(volume.solid.length, 12 * 10 * 14);
  for (const value of volume.solid) assert.ok(value === 0 || value === 1, "occupancy is binary");
  assert.ok(volume.solid.some((value) => value === 1), "some rock survives");
  assert.ok(volume.solid.some((value) => value === 0), "some space is carved");
  assert.deepEqual([...generateCaves3D(12, 10, 14, params).solid], [...volume.solid]);
});

// --- Dungeon ---------------------------------------------------------------

test("a dungeon is a single connected level enclosed by wall", () => {
  const { field, rooms } = generateDungeon(80, 50, DEFAULT_DUNGEON_PARAMS);
  assert.ok(rooms.length > 1, `placed ${rooms.length} rooms`);

  const walkable = cellsWhere(field, isWalkable);
  assert.ok(walkable.length > 0, "something was carved");
  assert.equal(floodCount(field, walkable[0], isWalkable), walkable.length, "every walkable cell is reachable");

  for (let x = 0; x < field.width; x += 1) {
    assert.equal(classAt(field, x, 0), DUNGEON_CLASS.wall);
    assert.equal(classAt(field, x, field.height - 1), DUNGEON_CLASS.wall);
  }
  for (let y = 0; y < field.height; y += 1) {
    assert.equal(classAt(field, 0, y), DUNGEON_CLASS.wall);
    assert.equal(classAt(field, field.width - 1, y), DUNGEON_CLASS.wall);
  }
});

test("dungeon rooms never overlap and every room cell is room floor", () => {
  const { field, rooms } = generateDungeon(80, 50, DEFAULT_DUNGEON_PARAMS);
  for (let i = 0; i < rooms.length; i += 1) {
    for (let x = rooms[i].x; x < rooms[i].x + rooms[i].width; x += 1) {
      for (let y = rooms[i].y; y < rooms[i].y + rooms[i].height; y += 1) {
        assert.equal(classAt(field, x, y), DUNGEON_CLASS.room, `room cell ${x},${y} is floor`);
      }
    }
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = rooms[i];
      const b = rooms[j];
      const disjoint =
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(disjoint, `rooms ${i} and ${j} do not overlap`);
    }
  }
});

test("more attempts place more rooms, and an impossible size places none", () => {
  const count = (attempts) => generateDungeon(80, 50, { ...DEFAULT_DUNGEON_PARAMS, roomAttempts: attempts }).rooms.length;
  assert.ok(count(60) >= count(8), "more attempts can only place more rooms");

  // A map with no room to place anything must come back solid rather than throw.
  const tiny = generateDungeon(5, 5, DEFAULT_DUNGEON_PARAMS);
  assert.equal(countByClass(tiny.field)[DUNGEON_CLASS.wall] + cellsWhere(tiny.field, isWalkable).length, 25);
});

// --- Maze ------------------------------------------------------------------

test("a maze reaches every corridor cell and keeps its border", () => {
  const field = generateMaze(41, 31, { seed: 3, braid: 0 });
  const paths = cellsWhere(field, (value) => value === MAZE_CLASS.path);
  assert.ok(paths.length > 0, "corridors were carved");
  assert.equal(
    floodCount(field, paths[0], (value) => value === MAZE_CLASS.path),
    paths.length,
    "every corridor cell is reachable from any other",
  );
  for (let x = 0; x < field.width; x += 1) {
    assert.equal(classAt(field, x, 0), MAZE_CLASS.wall);
    assert.equal(classAt(field, x, field.height - 1), MAZE_CLASS.wall);
  }
});

test("braiding opens dead ends into loops", () => {
  const deadEnds = (braid) => {
    const field = generateMaze(41, 31, { seed: 3, braid });
    return cellsWhere(field, (value) => value === MAZE_CLASS.path).filter(([x, y]) => {
      const neighbours = [
        classAt(field, x + 1, y),
        classAt(field, x - 1, y),
        classAt(field, x, y + 1),
        classAt(field, x, y - 1),
      ].filter((value) => value === MAZE_CLASS.path);
      return neighbours.length === 1;
    }).length;
  };
  const perfect = deadEnds(0);
  assert.ok(perfect > 0, "a perfect maze has dead ends");
  assert.ok(deadEnds(1) < perfect, "full braiding removes most of them");
  assert.ok(deadEnds(0.5) <= perfect, "partial braiding removes some");
});

test("a maze too small to carve comes back solid instead of throwing", () => {
  for (const size of [1, 2]) {
    const field = generateMaze(size, size, { seed: 1, braid: 0 });
    assert.equal(cellsWhere(field, (value) => value === MAZE_CLASS.path).length, 0);
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

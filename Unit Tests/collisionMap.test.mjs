/**
 * Unit tests for the per-cell collision layer
 * (packages/editor/src/model/CollisionMap.ts).
 *
 * Assertions come from the model's contract — solidity round-trips through
 * set/toggle/fill, bounds are respected, solidCount/isEmpty reflect the grid,
 * and serialize→deserialize reproduces the layer (including remapping onto a
 * different-sized map) — all derived from inputs and outputs, never from a
 * hard-coded byte layout.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/collisionMap.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { CollisionMap, isCollisionData, COLLISION_MAP_VERSION } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/CollisionMap.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

// 1. A fresh layer is the right size, empty, and reads false everywhere.
{
  const map = new CollisionMap(10, 6);
  check("dims stored", map.width === 10 && map.height === 6);
  check("starts empty", map.isEmpty && map.solidCount === 0);
  check("unset cell reads false", map.isSolid(3, 3) === false);
}

// 2. set/toggle round-trip a single cell and keep solidCount honest.
{
  const map = new CollisionMap(8, 8);
  map.setSolid(2, 5, true);
  check("cell set solid", map.isSolid(2, 5) === true);
  check("solidCount is 1", map.solidCount === 1 && !map.isEmpty);
  map.setSolid(2, 5, false);
  check("cell cleared", map.isSolid(2, 5) === false && map.solidCount === 0);
  map.toggle(4, 4);
  check("toggle sets", map.isSolid(4, 4) === true);
  map.toggle(4, 4);
  check("toggle clears", map.isSolid(4, 4) === false);
}

// 3. Out-of-bounds reads and writes are safe no-ops.
{
  const map = new CollisionMap(4, 4);
  map.setSolid(-1, 0, true);
  map.setSolid(4, 0, true);
  map.setSolid(0, 9, true);
  check("oob writes ignored", map.solidCount === 0);
  check("oob read false", map.isSolid(-1, -1) === false && map.isSolid(99, 99) === false);
}

// 4. Fill floods only the contiguous run of matching cells.
{
  const map = new CollisionMap(5, 1);
  // Row: [empty empty | solid | empty empty] — a wall splits the row in two.
  map.setSolid(2, 0, true);
  map.fill(0, 0, true); // fill the left empty run
  check("fill left run solidified", map.isSolid(0, 0) && map.isSolid(1, 0));
  check("wall unchanged", map.isSolid(2, 0));
  check("right run untouched by fill", !map.isSolid(3, 0) && !map.isSolid(4, 0));
}

// 5. Fill is a no-op when the start already matches the target.
{
  const map = new CollisionMap(3, 3);
  map.setSolid(1, 1, true);
  map.fill(1, 1, true); // already solid
  check("fill same value no-op", map.solidCount === 1);
}

// 6. clear resets every cell.
{
  const map = new CollisionMap(6, 6);
  map.setSolid(0, 0, true);
  map.setSolid(5, 5, true);
  map.clear();
  check("clear empties layer", map.isEmpty);
}

// 7. serialize → deserialize reproduces the layer exactly at the same size.
{
  const map = new CollisionMap(12, 9);
  const cells = [
    [0, 0],
    [11, 8],
    [5, 4],
    [7, 2],
  ];
  for (const [x, y] of cells) map.setSolid(x, y, true);
  const data = map.serialize();
  check("payload is versioned", data.version === COLLISION_MAP_VERSION && isCollisionData(data));
  const restored = CollisionMap.deserialize(data, 12, 9);
  check("solidCount preserved", restored.solidCount === cells.length);
  check(
    "every solid cell round-trips",
    cells.every(([x, y]) => restored.isSolid(x, y)),
  );
  // A cell that was clear stays clear.
  check("clear cell stays clear", restored.isSolid(1, 1) === false);
}

// 8. deserialize onto a SMALLER map copies only the overlapping region.
{
  const wide = new CollisionMap(10, 10);
  wide.setSolid(1, 1, true); // inside the crop
  wide.setSolid(9, 9, true); // outside a 4x4 crop
  const cropped = CollisionMap.deserialize(wide.serialize(), 4, 4);
  check("in-range cell survives crop", cropped.isSolid(1, 1) === true);
  check("out-of-range cell dropped", cropped.isSolid(9, 9) === false && cropped.solidCount === 1);
}

// 9. deserialize onto a LARGER map preserves cells and leaves the new area clear.
{
  const small = new CollisionMap(3, 3);
  small.setSolid(2, 2, true);
  const grown = CollisionMap.deserialize(small.serialize(), 6, 6);
  check("cell preserved when growing", grown.isSolid(2, 2) === true);
  check("new area is clear", grown.isSolid(5, 5) === false && grown.solidCount === 1);
}

// 10. Malformed / missing payloads yield an empty layer rather than throwing.
{
  check("null payload", CollisionMap.deserialize(null, 4, 4).isEmpty);
  check("garbage payload", CollisionMap.deserialize({ version: 99 }, 4, 4).isEmpty);
  check("wrong types", CollisionMap.deserialize({ version: 1, width: "x", height: 4, bits: "" }, 4, 4).isEmpty);
  check("isCollisionData rejects non-object", !isCollisionData(42) && !isCollisionData(null));
}

console.log(`collisionMap: ${passed}/${passed} checks passed`);

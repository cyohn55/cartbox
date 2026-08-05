/**
 * Tests the Platformer starter (packages/editor/src/model/platformerSeed.ts +
 * starters.ts): the starter must exist with a valid, non-empty collision layer,
 * and its code must actually drive physics through cartbox.solid — otherwise the
 * "worked example" ships broken or bakes in its walls.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/platformerStarter.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { CART_STARTERS, resolveStarter } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/starters.ts")).href
);
const { PLATFORMER_CODE, PLATFORMER_COLLISION } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/platformerSeed.ts")).href
);
const { isCollisionData, CollisionMap } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/CollisionMap.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

// 1. The starter is registered and carries its collision layer.
{
  const starter = resolveStarter("platformer");
  check("platformer starter registered", starter.id === "platformer");
  check("starter carries a collision layer", starter.collision === PLATFORMER_COLLISION);
  check("appears in CART_STARTERS", CART_STARTERS.some((s) => s.id === "platformer"));
}

// 2. The collision layer is a valid, non-empty CollisionData that round-trips.
{
  check("valid CollisionData payload", isCollisionData(PLATFORMER_COLLISION));
  const map = CollisionMap.deserialize(PLATFORMER_COLLISION, PLATFORMER_COLLISION.width, PLATFORMER_COLLISION.height);
  check("has solid cells (a floor + platforms)", map.solidCount > 0 && !map.isEmpty);
  // There should be ground along the bottom row.
  check("ground spans the bottom row", map.isSolid(0, PLATFORMER_COLLISION.height - 1) && map.isSolid(PLATFORMER_COLLISION.width - 1, PLATFORMER_COLLISION.height - 1));
}

// 3. The code drives its physics through the SDK, not baked-in walls.
{
  check("uses cartbox.solid for collision", PLATFORMER_CODE.includes("cartbox.solid"));
  check("reads the grid size via cartbox.mapsize", PLATFORMER_CODE.includes("cartbox.mapsize"));
  check("defines TIC()", /function\s+TIC\s*\(\)/.test(PLATFORMER_CODE));
}

console.log(`platformerStarter: ${passed}/${passed} checks passed`);

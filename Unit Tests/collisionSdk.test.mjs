/**
 * Unit tests for the cart-facing collision accessor generator
 * (packages/player/src/collisionSdk.ts).
 *
 * The generator is pure and import-free, so it is tested directly: an empty
 * layer injects nothing; a real layer emits Lua carrying the true dimensions and
 * the exact bit payload the model serialised. Correctness of the accessor is
 * checked by decoding the embedded payload with the *same* row-major, LSB-first
 * bit math the Lua implements and asserting it reproduces CollisionMap.isSolid
 * for every cell — so the data and the indexing the Lua encodes are both proven
 * against the model, without needing to execute Lua.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/collisionSdk.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { collisionSdkLua, parseCollisionField } = await import(
  pathToFileURL(path.resolve(here, "../packages/player/src/collisionSdk.ts")).href
);
const { CollisionMap } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/CollisionMap.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** Reproduce the accessor's lookup: decode the base64 payload, then bit-index it. */
function luaSolid(field, x, y) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || x >= field.width || y < 0 || y >= field.height) return false;
  const bytes = Buffer.from(field.bits, "base64");
  const cell = y * field.width + x;
  const byte = bytes[cell >> 3] ?? 0;
  return (byte & (1 << (cell & 7))) !== 0;
}

// 1. No usable layer injects nothing.
{
  check("null → empty", collisionSdkLua(null) === "");
  check("undefined → empty", collisionSdkLua(undefined) === "");
  check("empty bits → empty", collisionSdkLua({ width: 4, height: 4, bits: "" }) === "");
  check("zero size → empty", collisionSdkLua({ width: 0, height: 4, bits: "AAAA" }) === "");
}

// 2. A real layer emits the accessor with the true dimensions and payload.
{
  const map = new CollisionMap(20, 12);
  for (const [x, y] of [[0, 0], [19, 11], [7, 5], [3, 9]]) map.setSolid(x, y, true);
  const field = map.serialize();
  const lua = collisionSdkLua(field);
  check("defines cartbox.solid", lua.includes("cartbox.solid = function"));
  check("defines cartbox.mapsize", lua.includes("cartbox.mapsize = function"));
  check("carries the true dimensions", lua.includes(`_cw, _ch = ${field.width}, ${field.height}`));
  check("embeds the exact bit payload", lua.includes(`_b64("${field.bits}")`));
  // Every bitwise operand is guarded to an integer, so no float reaches `<<`/`>>`/`&`.
  check("floors coordinates before indexing", lua.includes("math.floor(x or 0)"));
}

// 3. The emitted payload + the accessor's bit math reproduce the model exactly.
{
  const map = new CollisionMap(23, 17); // non-byte-aligned width, to exercise packing
  const solids = [
    [0, 0],
    [22, 16],
    [8, 8],
    [1, 15],
    [22, 0],
    [0, 16],
  ];
  for (const [x, y] of solids) map.setSolid(x, y, true);
  const field = parseCollisionField(map.serialize());
  check("parseCollisionField accepts a serialized layer", field !== null);

  let mismatches = 0;
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (luaSolid(field, x, y) !== map.isSolid(x, y)) mismatches += 1;
    }
  }
  check("accessor matches model for every cell", mismatches === 0);

  // Out-of-bounds reads are false, exactly as the Lua guard returns.
  check("oob negative false", luaSolid(field, -1, 0) === false);
  check("oob beyond width false", luaSolid(field, 23, 0) === false);
  check("oob beyond height false", luaSolid(field, 0, 17) === false);

  // Float coordinates floor before indexing (a cart passing sub-cell positions).
  check("float coord floors to solid cell", luaSolid(field, 8.9, 8.2) === map.isSolid(8, 8));
}

// 4. parseCollisionField rejects malformed values.
{
  check("rejects null", parseCollisionField(null) === null);
  check("rejects missing bits", parseCollisionField({ width: 4, height: 4 }) === null);
  check("rejects non-number dims", parseCollisionField({ width: "x", height: 4, bits: "" }) === null);
  check("rejects non-positive dims", parseCollisionField({ width: 0, height: 4, bits: "AA" }) === null);
}

console.log(`collisionSdk: ${passed}/${passed} checks passed`);

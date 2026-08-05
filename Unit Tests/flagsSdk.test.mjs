/**
 * Unit tests for the cart-facing tile-flags accessor generator
 * (packages/player/src/flagsSdk.ts).
 *
 * As with collisionSdk, the generator is pure and import-free. An empty layer
 * injects nothing; a real layer emits Lua carrying the true dimensions and the
 * exact byte payload. Correctness is checked by decoding the embedded payload with
 * the SAME row-major, per-cell-byte, bit-n math the Lua implements and asserting
 * it reproduces TileFlags.get for every cell and flag — proving data + indexing
 * against the model without executing Lua.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/flagsSdk.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { flagsSdkLua, parseFlagsField } = await import(
  pathToFileURL(path.resolve(here, "../packages/player/src/flagsSdk.ts")).href
);
const { TileFlags, FLAG_COUNT } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/TileFlags.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** Reproduce the accessor's lookup: decode the base64 byte grid, then read bit n. */
function luaFlag(field, x, y, n) {
  x = Math.floor(x);
  y = Math.floor(y);
  n = Math.floor(n);
  if (x < 0 || x >= field.width || y < 0 || y >= field.height || n < 0 || n > 7) return false;
  const bytes = Buffer.from(field.bytes, "base64");
  const byte = bytes[y * field.width + x] ?? 0;
  return ((byte >> n) & 1) !== 0;
}

// 1. No usable layer injects nothing.
{
  check("null → empty", flagsSdkLua(null) === "");
  check("undefined → empty", flagsSdkLua(undefined) === "");
  check("empty bytes → empty", flagsSdkLua({ width: 4, height: 4, bytes: "" }) === "");
  check("zero size → empty", flagsSdkLua({ width: 0, height: 4, bytes: "AAAA" }) === "");
}

// 2. A real layer emits the accessor with the true dimensions and payload.
{
  const f = new TileFlags(20, 12);
  f.set(0, 0, 0, true);
  f.set(19, 11, 7, true);
  const field = f.serialize();
  const lua = flagsSdkLua(field);
  check("defines cartbox.flag", lua.includes("cartbox.flag = function"));
  check("carries the true dimensions", lua.includes(`_fw, _fh = ${field.width}, ${field.height}`));
  check("embeds the exact byte payload", lua.includes(`_b64("${field.bytes}")`));
  check("floors coordinates + flag index", lua.includes("n = math.floor(n or 0)"));
}

// 3. The emitted payload + the accessor's bit math reproduce the model exactly,
//    across every cell AND every flag.
{
  const f = new TileFlags(23, 17); // non-byte-aligned width
  f.set(0, 0, 0, true);
  f.set(22, 16, 7, true);
  f.set(8, 8, 2, true);
  f.set(8, 8, 5, true); // two flags on one cell
  f.set(1, 15, 4, true);
  const field = parseFlagsField(f.serialize());
  check("parseFlagsField accepts a serialized layer", field !== null);

  let mismatches = 0;
  for (let y = 0; y < f.height; y += 1) {
    for (let x = 0; x < f.width; x += 1) {
      for (let n = 0; n < FLAG_COUNT; n += 1) {
        if (luaFlag(field, x, y, n) !== f.get(x, y, n)) mismatches += 1;
      }
    }
  }
  check("accessor matches model for every cell + flag", mismatches === 0);

  // Bounds and flag-range guards.
  check("oob false", luaFlag(field, -1, 0, 0) === false && luaFlag(field, 23, 0, 0) === false);
  check("flag out of range false", luaFlag(field, 8, 8, 8) === false && luaFlag(field, 8, 8, -1) === false);
  // Float coord floors before indexing.
  check("float coord floors", luaFlag(field, 8.9, 8.1, 2) === f.get(8, 8, 2));
}

// 4. parseFlagsField rejects malformed values.
{
  check("rejects null", parseFlagsField(null) === null);
  check("rejects missing bytes", parseFlagsField({ width: 4, height: 4 }) === null);
  check("rejects non-positive dims", parseFlagsField({ width: 0, height: 4, bytes: "AA" }) === null);
}

console.log(`flagsSdk: ${passed}/${passed} checks passed`);

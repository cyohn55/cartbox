/**
 * Unit tests for the per-cell gameplay-flags layer
 * (packages/editor/src/model/TileFlags.ts).
 *
 * Assertions come from the model's contract — eight independent flags per cell
 * round-trip through set/toggle/fill, flags don't bleed into each other, bounds
 * and bit range are respected, counts reflect the grid, and serialize→deserialize
 * reproduces the layer (including remapping onto a different-sized map) — all
 * derived from inputs and outputs, never from a hard-coded byte layout.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/tileFlags.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { TileFlags, isFlagData, FLAG_COUNT, FLAG_LABELS, TILE_FLAGS_VERSION } = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/model/TileFlags.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

// 1. Constants are coherent: eight flags, eight labels.
check("eight flags", FLAG_COUNT === 8);
check("eight labels, none 'solid'", FLAG_LABELS.length === 8 && !FLAG_LABELS.includes("solid"));

// 2. A fresh layer is empty and reads false for every flag.
{
  const f = new TileFlags(10, 6);
  check("dims stored", f.width === 10 && f.height === 6);
  check("starts empty", f.isEmpty);
  check("unset flag false", f.get(3, 3, 0) === false && f.get(3, 3, 7) === false);
}

// 3. Flags are independent: setting one leaves the others untouched.
{
  const f = new TileFlags(8, 8);
  f.set(2, 2, 1, true); // ladder
  check("set flag reads back", f.get(2, 2, 1) === true);
  check("other flags on the same cell stay false", f.get(2, 2, 0) === false && f.get(2, 2, 2) === false);
  check("byteAt reflects only bit 1", f.byteAt(2, 2) === 0b10);
  f.set(2, 2, 3, true); // + water
  check("two flags coexist", f.get(2, 2, 1) && f.get(2, 2, 3) && f.byteAt(2, 2) === 0b1010);
  f.set(2, 2, 1, false);
  check("clearing one keeps the other", !f.get(2, 2, 1) && f.get(2, 2, 3));
}

// 4. toggle flips a single flag.
{
  const f = new TileFlags(4, 4);
  f.toggle(1, 1, 4);
  check("toggle sets", f.get(1, 1, 4));
  f.toggle(1, 1, 4);
  check("toggle clears", !f.get(1, 1, 4));
}

// 5. Bounds and invalid bit indices are safe no-ops.
{
  const f = new TileFlags(4, 4);
  f.set(-1, 0, 0, true);
  f.set(4, 0, 0, true);
  f.set(0, 0, 8, true); // out of flag range
  f.set(0, 0, -1, true);
  check("oob / bad-bit writes ignored", f.isEmpty);
  check("oob / bad-bit reads false", f.get(9, 9, 0) === false && f.get(0, 0, 8) === false);
}

// 6. Fill floods only the matching run for the chosen flag.
{
  const f = new TileFlags(5, 1);
  f.set(2, 0, 2, true); // a platform "wall" splits the row for flag 2
  f.fill(0, 0, 2, true); // fill the left run with flag 2
  check("left run filled for flag 2", f.get(0, 0, 2) && f.get(1, 0, 2));
  check("divider stays", f.get(2, 0, 2));
  check("right run untouched", !f.get(3, 0, 2) && !f.get(4, 0, 2));
  // Filling flag 2 must not have touched any other flag.
  check("fill did not set other flags", f.byteAt(0, 0) === 0b100);
}

// 7. clearBit clears one flag everywhere; clearAll clears the lot.
{
  const f = new TileFlags(6, 6);
  f.set(0, 0, 0, true);
  f.set(0, 0, 1, true);
  f.set(5, 5, 0, true);
  check("countBit before", f.countBit(0) === 2 && f.countBit(1) === 1);
  f.clearBit(0);
  check("clearBit removed only flag 0", f.countBit(0) === 0 && f.countBit(1) === 1);
  f.clearAll();
  check("clearAll empties", f.isEmpty);
}

// 8. serialize → deserialize reproduces the whole byte grid.
{
  const f = new TileFlags(12, 9);
  f.set(0, 0, 0, true);
  f.set(11, 8, 7, true);
  f.set(5, 4, 2, true);
  f.set(5, 4, 5, true);
  const data = f.serialize();
  check("payload versioned + valid", data.version === TILE_FLAGS_VERSION && isFlagData(data));
  const restored = TileFlags.deserialize(data, 12, 9);
  check("corner flags round-trip", restored.get(0, 0, 0) && restored.get(11, 8, 7));
  check("multi-flag cell round-trips", restored.byteAt(5, 4) === ((1 << 2) | (1 << 5)));
}

// 9. deserialize remaps onto a different-sized map (crop / grow).
{
  const wide = new TileFlags(10, 10);
  wide.set(1, 1, 3, true);
  wide.set(9, 9, 3, true);
  const cropped = TileFlags.deserialize(wide.serialize(), 4, 4);
  check("in-range survives crop", cropped.get(1, 1, 3));
  check("out-of-range dropped", !cropped.get(9, 9, 3) && cropped.countBit(3) === 1);

  const grown = TileFlags.deserialize(new TileFlags(3, 3).serialize(), 6, 6);
  check("grow gives empty new area", grown.isEmpty);
}

// 10. Malformed payloads yield an empty layer rather than throwing.
{
  check("null payload", TileFlags.deserialize(null, 4, 4).isEmpty);
  check("garbage payload", TileFlags.deserialize({ version: 9 }, 4, 4).isEmpty);
  check("isFlagData rejects junk", !isFlagData(7) && !isFlagData(null));
}

console.log(`tileFlags: ${passed}/${passed} checks passed`);

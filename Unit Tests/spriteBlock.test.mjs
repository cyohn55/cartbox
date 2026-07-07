/**
 * Unit tests for the shared sprite-block geometry helpers (spriteBlock.ts) used
 * by the paint surface, tile picker, and lit preview. Expectations are derived
 * from the inputs (base tile, sheet columns) rather than hardcoded.
 *
 * Run:  node --experimental-transform-types "Unit Tests/spriteBlock.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../apps/web/src/app/edit/[cartId]/spriteBlock.ts");
const { blockTileIndex, blockTileIndices } = await import(pathToFileURL(modulePath).href);

let passed = 0;

// 1. blockTileIndex advances by columns within a row and by sheetCols per row.
for (const sheetCols of [8, 16, 48]) {
  const baseTile = 20;
  assert.equal(blockTileIndex(baseTile, 0, 0, sheetCols), baseTile);
  assert.equal(blockTileIndex(baseTile, 0, 3, sheetCols), baseTile + 3);
  assert.equal(blockTileIndex(baseTile, 2, 0, sheetCols), baseTile + 2 * sheetCols);
  assert.equal(blockTileIndex(baseTile, 2, 3, sheetCols), baseTile + 2 * sheetCols + 3);
  passed += 1;
}

// 2. blockTileIndices enumerates exactly tilesPerSide² unique tiles, row-major.
for (const tilesPerSide of [1, 2, 4]) {
  const baseTile = 7;
  const sheetCols = 16;
  const indices = blockTileIndices(baseTile, tilesPerSide, sheetCols);
  assert.equal(indices.length, tilesPerSide * tilesPerSide, `count for ${tilesPerSide}×`);
  assert.equal(new Set(indices).size, indices.length, `all distinct for ${tilesPerSide}×`);
  // Every enumerated index matches the single-tile formula for its row/column.
  let cursor = 0;
  for (let row = 0; row < tilesPerSide; row += 1) {
    for (let column = 0; column < tilesPerSide; column += 1) {
      assert.equal(indices[cursor], blockTileIndex(baseTile, row, column, sheetCols));
      cursor += 1;
    }
  }
  passed += 1;
}

// 3. A single-tile block is just the base tile.
assert.deepEqual(blockTileIndices(42, 1, 16), [42]);
passed += 1;

console.log(`PASS — spriteBlock: ${passed} checks green.`);

/**
 * Unit tests for the map editor's multi-tile brush geometry (mapBrush.ts).
 * Expectations are derived from tile positions on a sheetCols-wide sheet, in
 * every drag direction, rather than from hardcoded indices.
 *
 * Run:  node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/mapBrush.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../apps/web/src/app/edit/[cartId]/mapBrush.ts");
const { singleTileBrush, tilePosition, brushFromCorners, brushTileIndices } = await import(
  pathToFileURL(modulePath).href
);

let passed = 0;

// 1. tilePosition inverts row-major indexing for any sheet width.
for (const sheetCols of [8, 16, 32]) {
  for (const tile of [0, sheetCols - 1, sheetCols, 3 * sheetCols + 5]) {
    const { row, column } = tilePosition(tile, sheetCols);
    assert.equal(row * sheetCols + column, tile);
    assert.ok(column >= 0 && column < sheetCols);
  }
  passed += 1;
}

// 2. A single-tile brush is 1×1 anchored at the tile.
{
  const brush = singleTileBrush(42);
  assert.deepEqual(brush, { tile: 42, width: 1, height: 1 });
  passed += 1;
}

// 3. brushFromCorners normalises all four drag directions to the same block.
{
  const sheetCols = 16;
  const topLeft = 2 * sheetCols + 3; // row 2, col 3
  const bottomRight = 5 * sheetCols + 7; // row 5, col 7
  const topRight = 2 * sheetCols + 7;
  const bottomLeft = 5 * sheetCols + 3;
  const expected = { tile: topLeft, width: 5, height: 4 };
  assert.deepEqual(brushFromCorners(topLeft, bottomRight, sheetCols), expected);
  assert.deepEqual(brushFromCorners(bottomRight, topLeft, sheetCols), expected);
  assert.deepEqual(brushFromCorners(topRight, bottomLeft, sheetCols), expected);
  assert.deepEqual(brushFromCorners(bottomLeft, topRight, sheetCols), expected);
  passed += 1;
}

// 4. A zero-length drag yields the single-tile brush.
{
  const sheetCols = 16;
  assert.deepEqual(brushFromCorners(37, 37, sheetCols), singleTileBrush(37));
  passed += 1;
}

// 5. brushTileIndices enumerates width×height tiles row-major, each at its
//    expected sheet position relative to the anchor.
{
  const sheetCols = 16;
  const brush = brushFromCorners(1 * sheetCols + 2, 3 * sheetCols + 4, sheetCols);
  const indices = brushTileIndices(brush, sheetCols);
  assert.equal(indices.length, brush.width * brush.height);
  assert.equal(new Set(indices).size, indices.length, "duplicate tile in brush");
  const anchor = tilePosition(brush.tile, sheetCols);
  indices.forEach((tile, ordinal) => {
    const position = tilePosition(tile, sheetCols);
    assert.equal(position.row, anchor.row + Math.floor(ordinal / brush.width));
    assert.equal(position.column, anchor.column + (ordinal % brush.width));
  });
  passed += 1;
}

console.log(`mapBrush: ${passed} checks passed`);

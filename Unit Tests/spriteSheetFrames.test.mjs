/**
 * Unit tests for SpriteSheet.importFrames — the multi-frame animation layout
 * that lays a run of same-size frames onto a page as consecutive tile blocks.
 *
 * Drives a real SpriteSheet over a StubCartEngine (no DOM). Each test frame is
 * filled with the exact RGB of a chosen palette index, so nearest-colour
 * snapping resolves deterministically back to that index and pixel read-backs
 * prove where each frame landed. No colour values are hard-coded — they are read
 * from the sheet's own palette.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/spriteSheetFrames.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);
const { StubCartEngine } = await load("../packages/editor/src/engine/StubCartEngine.ts");
const { SpriteSheet } = await load("../packages/editor/src/model/SpriteSheet.ts");

let passed = 0;

/** Build a solid RGBA frame filled with the palette colour at `index`. */
function solidFrame(sheet, index, sizePx) {
  const css = sheet.cssColor(index); // e.g. "#ffcd75"
  const red = parseInt(css.slice(1, 3), 16);
  const green = parseInt(css.slice(3, 5), 16);
  const blue = parseInt(css.slice(5, 7), 16);
  const data = new Uint8ClampedArray(sizePx * sizePx * 4);
  for (let i = 0; i < sizePx * sizePx; i += 1) {
    data[i * 4] = red;
    data[i * 4 + 1] = green;
    data[i * 4 + 2] = blue;
    data[i * 4 + 3] = 255;
  }
  return { data, width: sizePx, height: sizePx };
}

// 1. Frames flow left-to-right into consecutive tile blocks.
{
  const sheet = new SpriteSheet(new StubCartEngine());
  const size = sheet.tileSize * 2; // 16x16 => 2x2 tile blocks
  const index = 5;
  const frames = [0, 1, 2].map(() => solidFrame(sheet, index, size));

  const result = sheet.importFrames(frames, 0);
  assert.equal(result.placed, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.tilesWide, 2);
  assert.equal(result.tilesHigh, 2);

  // Frame i's top-left tile is at column i*tilesWide on row 0.
  for (let i = 0; i < 3; i += 1) {
    const tile = i * result.tilesWide; // row 0, so index == column
    assert.equal(sheet.getPixel(0, tile, 0, 0), index, `frame ${i} origin pixel`);
    // The whole block is filled, so its far corner tile also carries the colour.
    const farTile = tile + (result.tilesHigh - 1) * sheet.sheetCols + (result.tilesWide - 1);
    assert.equal(sheet.getPixel(0, farTile, sheet.tileSize - 1, sheet.tileSize - 1), index, `frame ${i} far pixel`);
  }
  passed += 1;
}

// 2. Frames wrap to the next block row when a row of blocks fills up.
{
  const sheet = new SpriteSheet(new StubCartEngine());
  const size = sheet.tileSize * 2;
  const index = 7;
  const blocksPerRow = Math.floor(sheet.sheetCols / 2);
  const count = blocksPerRow + 1; // one past the first block row
  const frames = Array.from({ length: count }, () => solidFrame(sheet, index, size));

  const result = sheet.importFrames(frames, 0);
  assert.equal(result.placed, count);
  // The wrapped frame sits at block row 1, column 0 => tile row 2, tile 0-based
  // index = tilesHigh * sheetCols.
  const wrappedTile = result.tilesHigh * sheet.sheetCols;
  assert.equal(sheet.getPixel(0, wrappedTile, 0, 0), index, "wrapped frame origin pixel");
  passed += 1;
}

// 3. Frames that no longer fit the page are reported as skipped.
{
  const sheet = new SpriteSheet(new StubCartEngine());
  const size = sheet.tileSize * 2;
  const tileRows = Math.floor(sheet.tilesPerPage / sheet.sheetCols);
  const capacity = Math.floor(sheet.sheetCols / 2) * Math.floor(tileRows / 2);
  const frames = Array.from({ length: capacity + 3 }, () => solidFrame(sheet, 3, size));

  const result = sheet.importFrames(frames, 0);
  assert.equal(result.placed, capacity, "places exactly the page capacity");
  assert.equal(result.skipped, 3, "reports the overflow as skipped");
  passed += 1;
}

// 4. A single frame behaves like a plain top-left import.
{
  const sheet = new SpriteSheet(new StubCartEngine());
  const index = 4;
  const result = sheet.importFrames([solidFrame(sheet, index, sheet.tileSize)], 0);
  assert.deepEqual([result.placed, result.skipped, result.tilesWide, result.tilesHigh], [1, 0, 1, 1]);
  assert.equal(sheet.getPixel(0, 0, 0, 0), index, "single frame lands at tile 0");
  passed += 1;
}

// 5. An empty frame list is a no-op with zeroed layout.
{
  const sheet = new SpriteSheet(new StubCartEngine());
  assert.deepEqual(sheet.importFrames([], 0), {
    placed: 0,
    skipped: 0,
    tilesWide: 0,
    tilesHigh: 0,
    cropped: false,
  });
  passed += 1;
}

// 6. A frame larger than the whole sheet still imports its top-left region
//    (cropped) rather than being dropped for not fitting.
{
  const sheet = new SpriteSheet(new StubCartEngine());
  const index = 6;
  const oversized = solidFrame(sheet, index, sheet.sheetSize * 2); // twice the sheet each side
  const result = sheet.importFrames([oversized], 0);
  assert.equal(result.placed, 1, "oversized frame is placed, not skipped");
  assert.equal(result.skipped, 0);
  assert.equal(result.cropped, true, "reports that it was cropped");
  // The whole sheet is covered by the crop: origin and far corners carry the colour.
  assert.equal(sheet.getPixel(0, 0, 0, 0), index, "top-left pixel filled");
  const lastTile = sheet.tilesPerPage - 1;
  assert.equal(sheet.getPixel(0, lastTile, sheet.tileSize - 1, sheet.tileSize - 1), index, "bottom-right pixel filled");
  passed += 1;
}

console.log(`PASS — spriteSheet frames: ${passed} checks green.`);

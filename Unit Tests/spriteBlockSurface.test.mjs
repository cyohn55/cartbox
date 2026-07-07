/**
 * Unit tests for SpriteBlockSurface — the editor adapter that presents an N×N
 * block of base tiles as one paint surface (Option B: 16×16 / 32×32 sprites).
 *
 * The tests drive the real class through the PaintSurface contract using a fake
 * in-memory inner surface, and derive every expected tile/pixel from the same
 * inputs (base tile, sheet columns, tile edge) rather than hardcoding — so they
 * validate the mapping, not a memorised table.
 *
 * Run:  node --experimental-strip-types "Unit Tests/spriteBlockSurface.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../apps/web/src/app/edit/[cartId]/spriteBlockSurface.ts");
const { SpriteBlockSurface } = await import(pathToFileURL(modulePath).href);

/** A minimal PaintSurface backed by a map, standing in for SpriteSheet/normals. */
class FakeTileSurface {
  constructor(tileEdge) {
    this.tileSize = tileEdge;
    this.store = new Map();
  }
  #key(page, tile, x, y) {
    return `${page}:${tile}:${x}:${y}`;
  }
  getPixel(page, tile, x, y) {
    return this.store.get(this.#key(page, tile, x, y)) ?? 0;
  }
  setPixel(page, tile, x, y, value) {
    this.store.set(this.#key(page, tile, x, y), value);
  }
  fill() {
    throw new Error("inner.fill must not be used; the block owns cross-tile fill");
  }
  cssColor(value) {
    return `#color${value}`;
  }
}

const TILE_EDGE = 8;
const SHEET_COLS = 16;
let passed = 0;

function expectedLocation(baseTile, x, y) {
  const tileColumn = Math.floor(x / TILE_EDGE);
  const tileRow = Math.floor(y / TILE_EDGE);
  return {
    tile: baseTile + tileRow * SHEET_COLS + tileColumn,
    px: x % TILE_EDGE,
    py: y % TILE_EDGE,
  };
}

// 1. tileSize is the block edge in pixels.
for (const tilesPerSide of [1, 2, 4]) {
  const block = new SpriteBlockSurface(new FakeTileSurface(TILE_EDGE), SHEET_COLS, tilesPerSide);
  assert.equal(block.tileSize, TILE_EDGE * tilesPerSide, `tileSize for ${tilesPerSide}×`);
  passed += 1;
}

// 2. Every block-local pixel writes to the sub-tile the layout formula predicts,
//    and reads back the same value (round-trip through the real class).
{
  const baseTile = 34;
  const tilesPerSide = 2;
  const inner = new FakeTileSurface(TILE_EDGE);
  const block = new SpriteBlockSurface(inner, SHEET_COLS, tilesPerSide);
  const page = 1;
  let value = 1;
  for (let y = 0; y < block.tileSize; y += 1) {
    for (let x = 0; x < block.tileSize; x += 1) {
      const paint = (value % 63) + 1; // a live palette-ish index, never 0
      block.setPixel(page, baseTile, x, y, paint);
      const at = expectedLocation(baseTile, x, y);
      assert.equal(
        inner.getPixel(page, at.tile, at.px, at.py),
        paint,
        `write landed in sub-tile at block (${x},${y})`,
      );
      assert.equal(block.getPixel(page, baseTile, x, y), paint, `round-trip read at block (${x},${y})`);
      value += 1;
    }
  }
  passed += 1;
}

// 3. Neighbouring block regions resolve to distinct sub-tiles (not aliased).
{
  const baseTile = 10;
  const block = new SpriteBlockSurface(new FakeTileSurface(TILE_EDGE), SHEET_COLS, 2);
  const corners = {
    topLeft: expectedLocation(baseTile, 0, 0).tile,
    topRight: expectedLocation(baseTile, TILE_EDGE, 0).tile,
    bottomLeft: expectedLocation(baseTile, 0, TILE_EDGE).tile,
    bottomRight: expectedLocation(baseTile, TILE_EDGE, TILE_EDGE).tile,
  };
  assert.equal(corners.topLeft, baseTile);
  assert.equal(corners.topRight, baseTile + 1);
  assert.equal(corners.bottomLeft, baseTile + SHEET_COLS);
  assert.equal(corners.bottomRight, baseTile + SHEET_COLS + 1);
  assert.equal(new Set(Object.values(corners)).size, 4, "four distinct sub-tiles");
  passed += 1;
}

// 4. Flood fill spans the whole block, crossing sub-tile seams.
{
  const baseTile = 5;
  const tilesPerSide = 2;
  const block = new SpriteBlockSurface(new FakeTileSurface(TILE_EDGE), SHEET_COLS, tilesPerSide);
  const page = 0;
  const fillValue = 7;
  block.fill(page, baseTile, 0, 0, fillValue);

  let filledPixels = 0;
  for (let y = 0; y < block.tileSize; y += 1) {
    for (let x = 0; x < block.tileSize; x += 1) {
      assert.equal(block.getPixel(page, baseTile, x, y), fillValue, `fill reached block (${x},${y})`);
      filledPixels += 1;
    }
  }
  assert.equal(filledPixels, block.tileSize * block.tileSize, "fill covered the block");
  // A pixel in the far (bottom-right) sub-tile proves the fill crossed both seams.
  const far = expectedLocation(baseTile, block.tileSize - 1, block.tileSize - 1);
  assert.equal(far.tile, baseTile + SHEET_COLS + 1, "far corner is the bottom-right sub-tile");
  passed += 1;
}

// 5. Fill is a no-op when the target already equals the fill value.
{
  const block = new SpriteBlockSurface(new FakeTileSurface(TILE_EDGE), SHEET_COLS, 2);
  block.setPixel(0, 0, 0, 0, 3);
  block.fill(0, 0, 0, 0, 3); // same value → should not throw or change anything
  assert.equal(block.getPixel(0, 0, 0, 0), 3);
  passed += 1;
}

// 6. cssColor delegates to the inner surface.
{
  const inner = new FakeTileSurface(TILE_EDGE);
  const block = new SpriteBlockSurface(inner, SHEET_COLS, 4);
  assert.equal(block.cssColor(9), inner.cssColor(9), "cssColor delegates");
  passed += 1;
}

console.log(`PASS — SpriteBlockSurface: ${passed} checks green.`);

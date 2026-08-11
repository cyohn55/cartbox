/**
 * Unit tests for library sprite placement (`blockSizeForImage`,
 * `findFreeSpriteBlock`). The behaviour that matters is non-destructive
 * placement: an inserted sprite must land only on empty tiles, snap to a
 * block-aligned grid so blocks never overlap, and decline (return null) when no
 * empty block of the needed size exists rather than overwrite the creator's art.
 *
 * Emptiness is injected as a predicate over a plain occupancy set, so the scan is
 * tested against explicit data with no engine or DOM.
 */

import { describe, expect, it } from "vitest";

import { blockSizeForImage, findFreeSpriteBlock, type SheetGeometry } from "@/lib/spriteInsert";

const TILE = 8;
const GEOMETRY: SheetGeometry = { sheetCols: 16, pageCount: 2 };

/** An emptiness predicate where every listed `page:tile` is occupied. */
function occupancy(occupied: Iterable<string>): (page: number, tile: number) => boolean {
  const set = new Set(occupied);
  return (page, tile) => !set.has(`${page}:${tile}`);
}

describe("blockSizeForImage", () => {
  it("picks the smallest block that fits the image's longest side", () => {
    expect(blockSizeForImage(8, 8, TILE)).toBe(1); // exactly one tile
    expect(blockSizeForImage(8, 5, TILE)).toBe(1);
    expect(blockSizeForImage(16, 16, TILE)).toBe(2); // two tiles per side
    expect(blockSizeForImage(9, 16, TILE)).toBe(2); // taller than a tile → 2
    expect(blockSizeForImage(32, 32, TILE)).toBe(4);
  });

  it("clamps oversized images to the largest block rather than refusing them", () => {
    expect(blockSizeForImage(1000, 1000, TILE)).toBe(4);
  });
});

describe("findFreeSpriteBlock", () => {
  it("places a 1-tile block at the very first tile when the sheet is empty", () => {
    const spot = findFreeSpriteBlock(GEOMETRY, 1, occupancy([]));
    expect(spot).toEqual({ page: 0, tile: 0 });
  });

  it("skips occupied tiles to the next free one", () => {
    // Tiles 0 and 1 of page 0 taken → next free single tile is index 2.
    const spot = findFreeSpriteBlock(GEOMETRY, 1, occupancy(["0:0", "0:1"]));
    expect(spot).toEqual({ page: 0, tile: 2 });
  });

  it("aligns larger blocks to a grid so they never straddle occupied tiles", () => {
    // Occupy the top-left tile: a 2×2 block cannot use the (0,0) slot, so it must
    // jump a whole block to column 2 (tile index 2), not merely shift by one tile.
    const spot = findFreeSpriteBlock(GEOMETRY, 2, occupancy(["0:0"]));
    expect(spot).toEqual({ page: 0, tile: 2 });
  });

  it("checks every tile in a candidate block, not just its corner", () => {
    // The first 2×2 block covers tiles {0, 1, 16, 17}. Occupy tile 1 — free at the
    // corner (0) but not throughout — so the block is rejected and the scan moves
    // a whole block right to the next aligned slot (tile 2).
    const spot = findFreeSpriteBlock(GEOMETRY, 2, occupancy(["0:1"]));
    expect(spot).toEqual({ page: 0, tile: 2 });
  });

  it("spills onto the next page when the first is full for this block size", () => {
    // Mark all of page 0 occupied; the block must land on page 1, tile 0.
    const pageZeroFull = (page: number) => page !== 0;
    const spot = findFreeSpriteBlock(GEOMETRY, 1, pageZeroFull);
    expect(spot).toEqual({ page: 1, tile: 0 });
  });

  it("returns null when no empty block of the size exists (declines the insert)", () => {
    const spot = findFreeSpriteBlock(GEOMETRY, 1, () => false);
    expect(spot).toBeNull();
  });

  it("returns null when the block is larger than a page", () => {
    const tiny: SheetGeometry = { sheetCols: 2, pageCount: 2 };
    expect(findFreeSpriteBlock(tiny, 4, occupancy([]))).toBeNull();
  });
});

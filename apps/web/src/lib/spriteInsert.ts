/**
 * Placement logic for dropping a library sprite/tile onto the shared sprite
 * sheet without overwriting the creator's existing art.
 *
 * A sprite asset names a *region* of the sheet, so inserting one means writing
 * its pixels somewhere and then naming that spot. With only a couple of pages to
 * work with, "somewhere" must be an actually-empty block — silently landing on
 * occupied tiles would destroy pixels the creator drew. This module answers two
 * pure questions: how many tiles per side a given image needs, and where the
 * first free block of that size sits. The sheet I/O (reading emptiness, writing
 * pixels) stays with the caller, injected as a predicate, so this is exercised
 * against plain data in tests rather than a live engine.
 */

import { SPRITE_BLOCK_SIZES } from "./cartAssets";

/**
 * The page count of a sprite bank. Fixed by the engine's `SpritePage` union
 * (`0 | 1`); named here so the scan has no bare literal and one place to change
 * if the console model ever grows more pages.
 */
export const SPRITE_PAGE_COUNT = 2;

/** The tile geometry a placement scan needs, read off the live `SpriteSheet`. */
export interface SheetGeometry {
  /** Tiles per side of one page (a page is `sheetCols` × `sheetCols` tiles). */
  readonly sheetCols: number;
  /** Number of pages available to place into. */
  readonly pageCount: number;
}

/** A block's home: which page, and the tile index of its top-left corner. */
export interface SpriteBlockLocation {
  readonly page: number;
  readonly tile: number;
}

/**
 * The smallest allowed block (in tiles per side) that fits an image, clamped to
 * the largest block when the image is bigger than any of them — the sheet then
 * crops the overflow, which beats refusing an otherwise-usable asset.
 */
export function blockSizeForImage(
  width: number,
  height: number,
  tileSize: number,
  sizes: readonly number[] = SPRITE_BLOCK_SIZES,
): number {
  const longestTiles = Math.ceil(Math.max(width, height) / tileSize);
  for (const size of sizes) {
    if (size >= longestTiles) return size;
  }
  return sizes[sizes.length - 1]!;
}

/** Whether every tile of a block anchored at `topLeft` reports empty. */
function blockIsEmpty(
  topLeft: number,
  tilesPerSide: number,
  sheetCols: number,
  isTileEmpty: (tile: number) => boolean,
): boolean {
  for (let dy = 0; dy < tilesPerSide; dy += 1) {
    for (let dx = 0; dx < tilesPerSide; dx += 1) {
      if (!isTileEmpty(topLeft + dy * sheetCols + dx)) return false;
    }
  }
  return true;
}

/**
 * Find the first free block of `tilesPerSide` tiles, scanning pages in order,
 * then top-to-bottom, then left-to-right, on a grid aligned to the block size so
 * placements never overlap. `isTileEmpty(page, tile)` reports whether one tile
 * holds only the transparent colour. Returns null when nothing fits, which the
 * caller turns into a declined insert rather than an overwrite.
 */
export function findFreeSpriteBlock(
  geometry: SheetGeometry,
  tilesPerSide: number,
  isTileEmpty: (page: number, tile: number) => boolean,
): SpriteBlockLocation | null {
  const { sheetCols, pageCount } = geometry;
  if (tilesPerSide > sheetCols) return null; // cannot fit in a page at all
  for (let page = 0; page < pageCount; page += 1) {
    for (let row = 0; row + tilesPerSide <= sheetCols; row += tilesPerSide) {
      for (let col = 0; col + tilesPerSide <= sheetCols; col += tilesPerSide) {
        const topLeft = row * sheetCols + col;
        if (blockIsEmpty(topLeft, tilesPerSide, sheetCols, (tile) => isTileEmpty(page, tile))) {
          return { page, tile: topLeft };
        }
      }
    }
  }
  return null;
}

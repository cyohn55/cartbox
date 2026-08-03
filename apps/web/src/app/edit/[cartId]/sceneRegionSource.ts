/**
 * A SpriteRegionSource backed by the editor's live sprite sheet.
 *
 * The Scene tab's preview renders the very same resolve→compose path the player
 * runs, so it needs to read arbitrary tile regions of the cart's current art as
 * straight-alpha RGBA — exactly what the runtime's cart-backed source does, but
 * reading the in-editor SpriteSheet instead of a loaded .tic. Palette index 0 is
 * transparent (matching the runtime's cartSpriteSource), so background pixels let
 * farther layers and the sky show through.
 */

import type { SpriteSheet } from "@cartbox/editor";
import type { RegionImage, SpriteRegionSource } from "@cartbox/player";

import { blockTileIndex } from "./spriteBlock";

const MAX_TILE = 255;

/**
 * Build a region source over `sheet`. It reads the sheet lazily on each
 * `readRegion`, so a source captured once still reflects later sprite edits when
 * the caller re-reads (the Scene preview re-resolves when the art or spec change).
 */
export function createEditorRegionSource(sheet: SpriteSheet): SpriteRegionSource {
  const edge = sheet.tileSize;
  return {
    readRegion(page: 0 | 1, tile: number, tilesW: number, tilesH: number): RegionImage {
      const width = edge * tilesW;
      const height = edge * tilesH;
      const pixels = new Uint8ClampedArray(width * height * 4);

      for (let tileRow = 0; tileRow < tilesH; tileRow += 1) {
        for (let tileColumn = 0; tileColumn < tilesW; tileColumn += 1) {
          const subTile = blockTileIndex(tile, tileRow, tileColumn, sheet.sheetCols);
          if (subTile > MAX_TILE) continue; // off the page → left transparent
          const rgba = sheet.renderTileRgba(page, subTile);
          for (let y = 0; y < edge; y += 1) {
            for (let x = 0; x < edge; x += 1) {
              const source = (y * edge + x) * 4;
              const target = ((tileRow * edge + y) * width + (tileColumn * edge + x)) * 4;
              pixels[target] = rgba[source] ?? 0;
              pixels[target + 1] = rgba[source + 1] ?? 0;
              pixels[target + 2] = rgba[source + 2] ?? 0;
              // Index 0 is the transparent background, so the layer keys out there.
              pixels[target + 3] = sheet.getPixel(page, subTile, x, y) === 0 ? 0 : 255;
            }
          }
        }
      }
      return { pixels, width, height };
    },
  };
}

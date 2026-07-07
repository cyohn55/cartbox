/**
 * SpriteBlockSurface — presents an N×N block of adjacent base tiles as one square
 * paint surface, so the editor can draw 16×16 (2×2) or 32×32 (4×4) sprites on a
 * single canvas. Multi-tile sprites are how these consoles draw anything bigger
 * than a base tile (spr() steps across width×height tiles), so this is an editor
 * convenience over the existing tile memory — no engine or cart-format change.
 *
 * It wraps any PaintSurface (albedo SpriteSheet or NormalSurface) and maps a
 * block-local pixel to the sub-tile that owns it and that tile's local pixel. The
 * selected tile is the block's top-left; sub-tiles advance along the sheet row
 * (sheetCols wide) then wrap to the next row — the same layout spr() reads.
 */

import type { SpritePage } from "@cartbox/editor";
import type { PaintSurface } from "./paintSurface";
import { blockTileIndex } from "./spriteBlock";

export class SpriteBlockSurface implements PaintSurface {
  /** Block edge in pixels: the base tile edge times the tiles-per-side. */
  readonly tileSize: number;

  constructor(
    private readonly inner: PaintSurface,
    private readonly sheetCols: number,
    private readonly tilesPerSide: number,
  ) {
    this.tileSize = inner.tileSize * tilesPerSide;
  }

  /** Resolve a block-local pixel to its owning sub-tile and pixel within it. */
  private locate(baseTile: number, x: number, y: number): { tile: number; px: number; py: number } {
    const edge = this.inner.tileSize;
    const tileColumn = Math.floor(x / edge);
    const tileRow = Math.floor(y / edge);
    return {
      tile: blockTileIndex(baseTile, tileRow, tileColumn, this.sheetCols),
      px: x % edge,
      py: y % edge,
    };
  }

  getPixel(page: SpritePage, baseTile: number, x: number, y: number): number {
    const { tile, px, py } = this.locate(baseTile, x, y);
    return this.inner.getPixel(page, tile, px, py);
  }

  setPixel(page: SpritePage, baseTile: number, x: number, y: number, value: number): void {
    const { tile, px, py } = this.locate(baseTile, x, y);
    this.inner.setPixel(page, tile, px, py, value);
  }

  /** Flood fill across the whole block, crossing sub-tile seams. */
  fill(page: SpritePage, baseTile: number, x: number, y: number, value: number): void {
    const target = this.getPixel(page, baseTile, x, y);
    if (target === value) return;

    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length > 0) {
      const [currentX, currentY] = stack.pop()!;
      if (currentX < 0 || currentX >= this.tileSize || currentY < 0 || currentY >= this.tileSize) continue;
      if (this.getPixel(page, baseTile, currentX, currentY) !== target) continue;
      this.setPixel(page, baseTile, currentX, currentY, value);
      stack.push([currentX + 1, currentY], [currentX - 1, currentY], [currentX, currentY + 1], [currentX, currentY - 1]);
    }
  }

  cssColor(value: number): string {
    return this.inner.cssColor(value);
  }
}

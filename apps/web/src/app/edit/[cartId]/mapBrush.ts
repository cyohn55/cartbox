/**
 * Geometry for the map editor's multi-tile brush. A brush is a rectangular
 * block of tiles anchored at its top-left tile index; dragging across the tile
 * picker selects the rectangle spanned by the two corner tiles. Pure (no DOM)
 * so the picker, the map canvas, and the tests all derive the same block.
 */

import { blockTileIndex } from "./spriteBlock";

export interface MapBrush {
  /** Top-left tile index of the block on the tiles page. */
  tile: number;
  /** Block width, in tiles. */
  width: number;
  /** Block height, in tiles. */
  height: number;
}

/** The default one-tile brush around a picker click. */
export function singleTileBrush(tile: number): MapBrush {
  return { tile, width: 1, height: 1 };
}

/** Row/column of a tile index on a sheet laid out sheetCols wide. */
export function tilePosition(tile: number, sheetCols: number): { row: number; column: number } {
  return { row: Math.floor(tile / sheetCols), column: tile % sheetCols };
}

/**
 * The rectangular brush spanned by two corner tiles of the picker grid, in
 * either drag direction. The anchor may sit at any corner of the rectangle.
 */
export function brushFromCorners(cornerA: number, cornerB: number, sheetCols: number): MapBrush {
  const a = tilePosition(cornerA, sheetCols);
  const b = tilePosition(cornerB, sheetCols);
  const top = Math.min(a.row, b.row);
  const left = Math.min(a.column, b.column);
  return {
    tile: top * sheetCols + left,
    width: Math.abs(a.column - b.column) + 1,
    height: Math.abs(a.row - b.row) + 1,
  };
}

/** All tile indices covered by a brush, row-major from its top-left tile. */
export function brushTileIndices(brush: MapBrush, sheetCols: number): number[] {
  const indices: number[] = [];
  for (let row = 0; row < brush.height; row += 1) {
    for (let column = 0; column < brush.width; column += 1) {
      indices.push(blockTileIndex(brush.tile, row, column, sheetCols));
    }
  }
  return indices;
}

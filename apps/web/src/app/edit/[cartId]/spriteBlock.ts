/**
 * Geometry for multi-tile sprite blocks. A sprite of N tiles per side is a block
 * of N×N adjacent base tiles whose indices advance across the sheet row
 * (sheetCols wide) then wrap to the next row — the same layout the draw call
 * reads. Centralised here so the paint surface, tile picker, and lit preview all
 * compute block membership the same way.
 */

/** Index of the sub-tile at (tileRow, tileColumn) within a block whose top-left is baseTile. */
export function blockTileIndex(baseTile: number, tileRow: number, tileColumn: number, sheetCols: number): number {
  return baseTile + tileRow * sheetCols + tileColumn;
}

/** All sub-tile indices of a tilesPerSide × tilesPerSide block, row-major from baseTile. */
export function blockTileIndices(baseTile: number, tilesPerSide: number, sheetCols: number): number[] {
  const indices: number[] = [];
  for (let tileRow = 0; tileRow < tilesPerSide; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < tilesPerSide; tileColumn += 1) {
      indices.push(blockTileIndex(baseTile, tileRow, tileColumn, sheetCols));
    }
  }
  return indices;
}

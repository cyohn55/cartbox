/**
 * Composites the current sprite (a single tile, or an N×N block of base tiles)
 * into the flat RGBA buffers the lighting renderers consume: albedo, an encoded
 * normal map, and the packed material channel. Shared by the flat lit preview
 * (LitPreview) and the voxel preview (VoxelPreview) so both read the sprite the
 * same way — the editing canvas, the flat preview, and the voxel preview all
 * agree by construction.
 */

import { MATERIAL_LEVELS, type SpriteSheet, type NormalMap, type MaterialMap, type SpritePage } from "@cartbox/editor";

import { blockTileIndex } from "./spriteBlock";

/** Level (0..15) → byte (0..255) for packing a material channel into a texture. */
const LEVEL_TO_BYTE = 255 / (MATERIAL_LEVELS - 1);

/** Composite an N×N tile block's albedo into one square RGBA buffer (dim×dim). */
export function readBlockAlbedo(
  sheet: SpriteSheet,
  page: SpritePage,
  baseTile: number,
  blockTiles: number,
): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const out = new Uint8ClampedArray(dim * dim * 4);
  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = blockTileIndex(baseTile, tileRow, tileColumn, sheet.sheetCols);
      const rgba = sheet.renderTileRgba(page, subTile);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const source = (y * edge + x) * 4;
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          out[target] = rgba[source] ?? 0;
          out[target + 1] = rgba[source + 1] ?? 0;
          out[target + 2] = rgba[source + 2] ?? 0;
          out[target + 3] = rgba[source + 3] ?? 255;
        }
      }
    }
  }
  return out;
}

/** Composite the block's normal vectors into one square RGBA normal buffer. */
export function readBlockNormal(
  normals: NormalMap,
  sheet: SpriteSheet,
  page: SpritePage,
  baseTile: number,
  blockTiles: number,
): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const out = new Uint8ClampedArray(dim * dim * 4);
  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = blockTileIndex(baseTile, tileRow, tileColumn, sheet.sheetCols);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const [nx, ny, nz] = normals.vector(page, subTile, x, y);
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          out[target] = Math.round((nx * 0.5 + 0.5) * 255);
          out[target + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          out[target + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          out[target + 3] = 255;
        }
      }
    }
  }
  return out;
}

/**
 * Composite the block's material into one RGBA buffer: R=height, G=specular,
 * B=roughness, A=emissive (each level scaled to a byte).
 */
export function readBlockMaterial(
  heightMap: MaterialMap,
  specularMap: MaterialMap,
  roughnessMap: MaterialMap,
  emissiveMap: MaterialMap,
  sheet: SpriteSheet,
  page: SpritePage,
  baseTile: number,
  blockTiles: number,
): Uint8ClampedArray {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const out = new Uint8ClampedArray(dim * dim * 4);
  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = blockTileIndex(baseTile, tileRow, tileColumn, sheet.sheetCols);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          out[target] = heightMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
          out[target + 1] = specularMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
          out[target + 2] = roughnessMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
          out[target + 3] = emissiveMap.getValue(page, subTile, x, y) * LEVEL_TO_BYTE;
        }
      }
    }
  }
  return out;
}

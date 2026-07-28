/**
 * The texture atlas the map's 3D view samples.
 *
 * Two kinds of surface skin a map cell, and this is what puts them in one address
 * space so the renderer needs to know about neither:
 *
 * - the **world materials** (grass, rock, brick…), fixed art shared with the
 *   sculpt tools, keeping the indices they already have so every column skinned
 *   before this existed still renders as it did;
 * - every **sprite on the map's tiles page**, appended after them, so any art
 *   drawn in the editor can be stood up as a block face or a plane and then
 *   painted on in place.
 *
 * The sprite half is what makes "paint pixels in 3D" possible at all: a cell
 * skinned with tile *n* is showing tile *n*'s pixels, so a click on one of its
 * faces resolves to a texel of a sprite the editor can already edit.
 *
 * Rebuilt whenever the sheet's art changes — a repaint of the tile must show on
 * the cells wearing it — which is cheap: a page of 8x8 sprites is a few tens of
 * kilobytes of texels.
 */

import type { TextureAtlas } from "@cartbox/editor";

import { buildWorldAtlas } from "./faceTextures";
import {
  buildSpriteMaterialAtlas,
  firstSpriteMaterialIndex,
  uniformSpriteMaterial,
  type SpriteMaterial,
  type SpritePixelSource,
} from "./spriteTiles";

/**
 * The part of a sprite sheet this module needs: how to read a sprite's pixels,
 * and how many there are. The real `SpriteSheet` satisfies it structurally, so
 * building an atlas needs no engine — which is what lets the tests drive this
 * with art they author outright.
 */
export type MapSpriteSource = SpritePixelSource & { readonly tilesPerPage: number };

/** The sprite page the map stamps from; the map can only reference page 0. */
export const MAP_SPRITE_PAGE = 0;

/** The world's authored materials — fixed art, so built once at module load. */
const WORLD_ATLAS = buildWorldAtlas();

/**
 * The material index the first sprite-backed material occupies. Sprite tile *n*
 * therefore skins with material `MAP_SPRITE_MATERIAL_BASE + n`.
 */
export const MAP_SPRITE_MATERIAL_BASE = firstSpriteMaterialIndex(WORLD_ATLAS);

/** The material index that skins a cell with sprite `tile` from the tiles page. */
export function spriteTileMaterial(tile: number): number {
  return MAP_SPRITE_MATERIAL_BASE + tile;
}

/**
 * The sprite a material shows, or null when it is one of the world's own
 * materials (whose art is not authored in this cart and so cannot be painted).
 * This is the test the pixel tools gate on.
 */
export function materialSpriteTile(material: number, tilesPerPage: number): number | null {
  const tile = material - MAP_SPRITE_MATERIAL_BASE;
  return tile >= 0 && tile < tilesPerPage ? tile : null;
}

/**
 * Build the map's atlas for a sheet: the world materials, then one uniform
 * material per sprite on the tiles page, in tile order — the ordering
 * {@link spriteTileMaterial} depends on.
 */
export function buildMapAtlas(sheet: MapSpriteSource): TextureAtlas {
  const sprites: SpriteMaterial[] = [];
  for (let tile = 0; tile < sheet.tilesPerPage; tile += 1) {
    sprites.push(uniformSpriteMaterial(`Tile ${tile}`, { page: MAP_SPRITE_PAGE, tile }));
  }
  return buildSpriteMaterialAtlas(WORLD_ATLAS, sprites, sheet);
}

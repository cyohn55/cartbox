/**
 * The map's texture atlas: world materials and cart sprites in one address space.
 *
 * The 3D map tools lean on this arithmetic in two directions — arming a sprite as
 * a skin, and reading a cell's skin back to find the sprite whose pixels a click
 * should paint — so the two have to be exact inverses, and a world material must
 * never be mistaken for a paintable sprite.
 */

import { describe, expect, it } from "vitest";

import { faceTile } from "@cartbox/editor";
import { BUILD_MATERIALS } from "../apps/web/src/lib/faceTextures";
import {
  MAP_SPRITE_MATERIAL_BASE,
  buildMapAtlas,
  materialSpriteTile,
  spriteTileMaterial,
  type MapSpriteSource,
} from "../apps/web/src/lib/mapAtlas";

const TILE_SIZE = 2;
const TILES_PER_PAGE = 4;

/**
 * A sprite page where each tile is a solid block of its own palette colour, so a
 * tile can be identified from the texels the atlas produced for it.
 */
function pageOfSolidTiles(): MapSpriteSource {
  return {
    tileSize: TILE_SIZE,
    tilesPerPage: TILES_PER_PAGE,
    getPixel: (_page, tile) => tile + 1, // index 0 is transparent, so start at 1
    paletteRgb: () => [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
      [30, 0, 0],
      [40, 0, 0],
    ],
  };
}

describe("map atlas — addressing a sprite as a material", () => {
  it("round-trips a tile through its material index", () => {
    const source = pageOfSolidTiles();

    for (let tile = 0; tile < source.tilesPerPage; tile += 1) {
      expect(materialSpriteTile(spriteTileMaterial(tile), source.tilesPerPage)).toBe(tile);
    }
  });

  it("does not mistake a world material for a paintable sprite", () => {
    const source = pageOfSolidTiles();

    for (const entry of BUILD_MATERIALS) {
      expect(materialSpriteTile(entry.material, source.tilesPerPage)).toBeNull();
    }
    expect(materialSpriteTile(-1, source.tilesPerPage)).toBeNull();
  });

  it("leaves the world's own material indices where they were", () => {
    // Columns skinned before sprites could skin anything still carry these
    // indices, so the sprite half has to start past them.
    for (const entry of BUILD_MATERIALS) {
      expect(entry.material).toBeLessThan(MAP_SPRITE_MATERIAL_BASE);
    }
  });
});

describe("map atlas — what a face actually samples", () => {
  it("skins a face with the sprite its material names", () => {
    const source = pageOfSolidTiles();
    const atlas = buildMapAtlas(source);
    const paletteRgb = source.paletteRgb();

    for (let tile = 0; tile < source.tilesPerPage; tile += 1) {
      const texture = faceTile(atlas, spriteTileMaterial(tile), 0);
      expect(texture).toBeDefined();
      const expected = paletteRgb[tile + 1]!;
      expect([texture!.data[0], texture!.data[1], texture!.data[2]]).toEqual([...expected]);
    }
  });

  it("shows the same sprite on every face, so a plane reads the same from any side", () => {
    const atlas = buildMapAtlas(pageOfSolidTiles());
    const material = spriteTileMaterial(2);

    const [top, side, bottom] = [1, 0, -1].map((normalY) => faceTile(atlas, material, normalY));
    expect(top).toBe(side);
    expect(side).toBe(bottom);
  });

  it("still serves the world materials it was built on top of", () => {
    const atlas = buildMapAtlas(pageOfSolidTiles());

    for (const entry of BUILD_MATERIALS) {
      expect(faceTile(atlas, entry.material, 1)).toBeDefined();
    }
  });

  it("offers one material per sprite on the page", () => {
    const source = pageOfSolidTiles();
    const atlas = buildMapAtlas(source);

    expect(atlas.materials).toHaveLength(MAP_SPRITE_MATERIAL_BASE + source.tilesPerPage);
  });
});

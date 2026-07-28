/**
 * Packing an atlas for the GPU.
 *
 * Two decisions in this module are the difference between world art that reads
 * cleanly and world art that looks broken, and neither is visible from the code
 * alone — so both are asserted here against real atlases:
 *
 * - **Every tile upscales by a whole number.** The atlas mixes 8- and 12-texel
 *   tiles; if the common layer size were merely the largest of them, some texels
 *   would be one pixel wide and others two, which is exactly the unevenness that
 *   makes pixel art look wrong.
 * - **The mip chain is alpha-weighted.** Sprites are drawn with holes, and the
 *   RGB under a hole is meaningless; averaging it in darkens every silhouette as
 *   it recedes.
 *
 * The face table is checked against {@link faceTile}, the CPU's own answer, so
 * the two renderers cannot disagree about which tile skins which face.
 */

import { describe, expect, it } from "vitest";

import {
  buildFaceLayers,
  commonTileSize,
  faceGroupOf,
  faceTile,
  packAtlasTexture,
  type FaceTexture,
  type TextureAtlas,
} from "@cartbox/editor";

/** A tile whose every texel is identifiable by its position. */
function identifiableTile(size: number, tint: number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const base = (y * size + x) * 4;
      data[base] = x * 8 + 3;
      data[base + 1] = y * 8 + 3;
      data[base + 2] = tint;
      data[base + 3] = 255;
    }
  }
  return { size, data };
}

/** A tile that is opaque white on its left half and a hole on its right. */
function holedTile(size: number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size / 2; x += 1) {
      const base = (y * size + x) * 4;
      data[base] = 255;
      data[base + 1] = 255;
      data[base + 2] = 255;
      data[base + 3] = 255;
    }
  }
  return { size, data };
}

/** The RGBA of a texel of one layer at one mip level. */
function texel(
  data: Uint8Array,
  size: number,
  layer: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const base = (layer * size * size + y * size + x) * 4;
  return [data[base]!, data[base + 1]!, data[base + 2]!, data[base + 3]!];
}

describe("choosing a layer size", () => {
  it("finds a size every tile divides into a whole number of times", () => {
    // 8 and 12 both land exactly on 24: three texels each and two texels each.
    expect(commonTileSize([8, 12])).toBe(24);
    expect(24 % 8).toBe(0);
    expect(24 % 12).toBe(0);
  });

  it("leaves a single size alone", () => {
    expect(commonTileSize([16, 16, 16])).toBe(16);
  });

  it("gives up on a common multiple rather than allocating absurdly", () => {
    // 7, 11 and 13 multiply to a thousand texels a side. Uneven texels on the odd
    // tiles cost less than that does.
    expect(commonTileSize([7, 11, 13])).toBe(13);
  });

  it("survives an empty atlas", () => {
    expect(commonTileSize([])).toBe(1);
  });
});

describe("packing the layers", () => {
  const atlas: TextureAtlas = {
    tiles: [identifiableTile(8, 40), identifiableTile(12, 90)],
    materials: [
      { top: 0, side: 1, bottom: 0 },
      { top: 1, side: 1, bottom: 1 },
    ],
  };

  it("reproduces each tile's texels exactly, with square texels", () => {
    const packed = packAtlasTexture(atlas);
    expect(packed.size).toBe(24);

    // Every output texel must equal the source texel it upscaled from, for both
    // tiles — which can only hold if each scaled by a whole number.
    for (const [layer, tile] of atlas.tiles.entries()) {
      const factor = packed.size / tile.size;
      expect(Number.isInteger(factor)).toBe(true);
      for (let y = 0; y < packed.size; y += 1) {
        for (let x = 0; x < packed.size; x += 1) {
          const source = (Math.floor(y / factor) * tile.size + Math.floor(x / factor)) * 4;
          expect(texel(packed.levels[0]!.albedo, packed.size, layer, x, y)).toEqual([
            tile.data[source],
            tile.data[source + 1],
            tile.data[source + 2],
            tile.data[source + 3],
          ]);
        }
      }
    }
  });

  it("builds a mip chain down to a single texel", () => {
    const packed = packAtlasTexture(atlas);
    const sizes = packed.levels.map((level) => level.size);

    expect(sizes[0]).toBe(packed.size);
    expect(sizes[sizes.length - 1]).toBe(1);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBe(Math.max(1, sizes[i - 1]! >> 1));
    }
    // The layer count is what a GPU will demand for a texture of this size.
    expect(sizes).toHaveLength(Math.floor(Math.log2(packed.size)) + 1);
  });

  it("does not let a hole darken the colour it sits beside", () => {
    // Averaging the black under a transparent texel would drag a white sprite
    // grey as it recedes; weighting by coverage keeps it white and halves alpha.
    const packed = packAtlasTexture({ tiles: [holedTile(8)] });
    const smallest = packed.levels[packed.levels.length - 1]!;
    const [r, g, b, a] = texel(smallest.albedo, smallest.size, 0, 0, 0);

    expect([r, g, b]).toEqual([255, 255, 255]);
    expect(a).toBeGreaterThan(100);
    expect(a).toBeLessThan(160);
  });

  it("writes each channel into the slot the shader reads it from", () => {
    const built = packAtlasTexture(atlas, {
      finishFor: () => ({ specular: 1, roughness: 0, relief: 0 }),
    });
    const finish = built.levels[0]!;

    // r = specular, g = roughness — a fully glossy, perfectly smooth finish.
    expect(texel(finish.finish, built.size, 0, 3, 3)[0]).toBe(255);
    expect(texel(finish.finish, built.size, 0, 3, 3)[1]).toBe(0);
    // With no relief the normal stays the flat (0, 0, 1) that encodes as blue.
    expect(texel(finish.surface, built.size, 0, 3, 3).slice(0, 3)).toEqual([128, 128, 255]);
  });
});

describe("the material to layer table", () => {
  const atlas: TextureAtlas = {
    tiles: [identifiableTile(8, 10), identifiableTile(8, 20), identifiableTile(8, 30)],
    materials: [
      { top: 0, side: 1, bottom: 2 },
      { top: 2, side: 2, bottom: -1 },
    ],
  };

  it("agrees with the CPU's own choice of tile, face for face", () => {
    const table = buildFaceLayers(atlas);
    // Normals spanning straight up, level, and straight down.
    for (const normalY of [1, 0.7, 0.2, 0, -0.4, -0.9, -1]) {
      for (let material = 0; material < atlas.materials!.length; material += 1) {
        const layer = table[material * 3 + faceGroupOf(normalY)]!;
        const cpu = faceTile(atlas, material, normalY);
        expect(layer >= 0 ? atlas.tiles[layer] : undefined).toBe(cpu);
      }
    }
  });

  it("marks a face with no tile as flat rather than as layer zero", () => {
    const table = buildFaceLayers(atlas);
    expect(table[1 * 3 + faceGroupOf(-1)]).toBe(-1);
  });

  it("gives an atlas without materials one tile on every face", () => {
    const plain: TextureAtlas = { tiles: atlas.tiles };
    const table = buildFaceLayers(plain);

    expect([table[0], table[1], table[2]]).toEqual([0, 0, 0]);
    expect([table[3], table[4], table[5]]).toEqual([1, 1, 1]);
  });
});

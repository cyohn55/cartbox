/**
 * The demo world's texture atlas — procedural pixel-art tiles that skin the voxel
 * and hexel faces (grass, dirt, rock, crystal, metal, screen, monolith).
 *
 * These stand in for sprites authored in the editor: a {@link FaceTexture} is the
 * same straight-alpha RGBA format the sprite tools produce, so a real drawn tile
 * would drop into the same atlas slot with no renderer change. Generation is
 * deterministic per seed, so the world textures the same way every load, and the
 * unit tests can assert on the produced texels.
 */

import type { FaceTexture, TextureAtlas } from "@cartbox/editor";
import type { TerrainMaterial } from "./hexelTerrainSpecs";

/** Atlas slot indices; the order the tiles are built in {@link buildWorldAtlas}. */
export const TILE = {
  grass: 0,
  dirt: 1,
  rock: 2,
  crystal: 3,
  metal: 4,
  screen: 5,
  monolith: 6,
} as const;

/** Tile a terrain material samples from. */
export function terrainTile(material: TerrainMaterial): number {
  return TILE[material];
}

/** Edge length of every tile, in texels. Chosen to out-resolve a face's pixels. */
const TILE_SIZE = 12;

/** A per-texel RGBA (+ optional emissive 0..255) the tile painter returns. */
interface Texel {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Alpha 0..255; 0 leaves a hole the face shows through. Default 255. */
  readonly a?: number;
  /** Self-emissive 0..255. Default 0. */
  readonly e?: number;
}

/** A small, fast, seedable PRNG so each tile is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build one square tile by calling `paint` for each texel. */
function makeTile(seed: number, paint: (x: number, y: number, random: () => number) => Texel): FaceTexture {
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
  const emissive = new Uint8Array(TILE_SIZE * TILE_SIZE);
  let anyEmissive = false;
  const random = mulberry32(seed);
  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const texel = paint(x, y, random);
      const i = y * TILE_SIZE + x;
      data[i * 4] = texel.r;
      data[i * 4 + 1] = texel.g;
      data[i * 4 + 2] = texel.b;
      data[i * 4 + 3] = texel.a ?? 255;
      emissive[i] = texel.e ?? 0;
      if (emissive[i]! > 0) anyEmissive = true;
    }
  }
  return anyEmissive ? { size: TILE_SIZE, data, emissive } : { size: TILE_SIZE, data };
}

/**
 * A greyscale texel: the tiles carry *luminance and detail*, and the renderer
 * tints them by each voxel's colour (see fillTexturedQuad). So one grass tile
 * greened by the grass cell, one metal tile reddened by a handheld body, and one
 * screen tile hued by each screen all come from neutral art — the tile supplies
 * the grain, the voxel supplies the colour.
 */
function grey(luminance: number, emissive = 0, alpha = 255): Texel {
  return { r: luminance, g: luminance, b: luminance, a: alpha, e: emissive };
}

/**
 * Build the demo atlas. Tile order matches {@link TILE}. Tiles are greyscale
 * detail (tinted at render time by the voxel colour); the ones that should glow
 * carry emissive. Deterministic per seed so the same world always textures
 * identically.
 */
export function buildWorldAtlas(seed = 20260722): TextureAtlas {
  const tiles: FaceTexture[] = [
    // grass: bright grain with a few darker blades (greened by the grass cell).
    makeTile(seed + TILE.grass, (_x, y, random) => {
      const blade = random() > 0.86;
      const jitter = Math.round((random() - 0.5) * 26);
      if (blade) return grey(150 + jitter);
      return grey(228 + jitter - Math.round((y / TILE_SIZE) * 10));
    }),
    // dirt: grainy with scattered darker pebbles (browned by the dirt cell).
    makeTile(seed + TILE.dirt, (_x, _y, random) => {
      if (random() > 0.9) return grey(150);
      return grey(224 + Math.round((random() - 0.5) * 28));
    }),
    // rock: speckle broken by darker cracks (greyed by the rock cell).
    makeTile(seed + TILE.rock, (x, y, random) => {
      const crack = (x + y) % 5 === 0 && random() > 0.5;
      if (crack) return grey(150);
      return grey(230 + Math.round((random() - 0.5) * 24));
    }),
    // crystal: bright facets that glow (cyaned by the crystal cell).
    makeTile(seed + TILE.crystal, (x, y, random) => {
      const facet = ((x >> 1) + (y >> 1)) % 2 === 0;
      const base = facet ? 245 : 200;
      return grey(base, (facet ? 170 : 110) + Math.round(random() * 30));
    }),
    // metal: brushed sheen with a lighter horizontal band (hued by the body).
    makeTile(seed + TILE.metal, (_x, y, random) => {
      const band = y === 3 || y === 4;
      return grey((band ? 245 : 205) + Math.round((random() - 0.5) * 12));
    }),
    // screen: scanlines with a bright corner glint, all emissive (hued by the
    // screen cell so each handheld's display glows in its own colour).
    makeTile(seed + TILE.screen, (x, y, random) => {
      const glint = x >= TILE_SIZE - 3 && y <= 2;
      if (glint) return grey(245, 235);
      const scan = y % 2 === 0;
      return grey(scan ? 200 : 120, (scan ? 150 : 80) + Math.round(random() * 20));
    }),
    // monolith: stone with glowing runes (purpled by the monolith cell).
    makeTile(seed + TILE.monolith, (x, y, random) => {
      const rune = (x === 5 || x === 6) && y >= 2 && y <= TILE_SIZE - 3 && random() > 0.4;
      if (rune) return grey(245, 220);
      return grey(200 + Math.round((random() - 0.5) * 18), 40);
    }),
  ];
  return { tiles };
}

/**
 * Shared plumbing for an era scene whose texture is an editable cart asset.
 *
 * An era demo's texture is defined here as palette-indexed pixels (a small CLUT
 * plus one index per texel). From that single source, a seed derives four things
 * that must agree, which is exactly why they live together:
 *
 * 1. the palette entries the texture's CLUT occupies (reserved high indices, so
 *    the low ones stay free for the 2D frame);
 * 2. the pixels painted into the cart's sprite sheet — what the Assets tab edits;
 * 3. the mesh material's baked `baseColorImage` — what renders before the first
 *    rebake and in the Mesh preview;
 * 4. the `SpriteTextureRef` linking the mesh back to that sprite region, so the
 *    editor rebakes the mesh from the sheet on Run/Save.
 *
 * The sprite sheet's tile geometry (8px tiles, 16 tiles per page) is the TIC-80
 * standard every era model shares; it is asserted against the region rather than
 * read from the engine because the seed has only the raw engine handle.
 */

import type { CartEngine, SpritePage } from "../engine/CartEngine";
import type { EncodedImage, SpriteTextureRef } from "./MeshAsset";
import { encodeRgbaPng } from "./png";

/** The TIC-80 sprite geometry the era models use. */
const TILE_SIZE = 8;
const SHEET_COLS = 16;

/**
 * Palette index where an era texture's CLUT begins. High enough to leave the low
 * indices for the cart's 2D frame (sky, horizon, ink) and the default palette.
 * The 256-colour era models have ample room above it for a ≤64-entry CLUT.
 */
export const TEXTURE_CLUT_BASE = 160;

/** A palette-indexed square texture: `size`×`size` indices into `clut`. */
export interface IndexedTexture {
  /** Width and height in pixels; a multiple of the 8px tile, ≤128 (one page). */
  readonly size: number;
  /** One CLUT index per texel, row-major, length `size*size`. */
  readonly indices: Uint8Array;
  /** The colour lookup table the indices address, as RGB triplets. */
  readonly clut: ReadonlyArray<readonly [number, number, number]>;
}

/** The whole texture as straight RGBA, for baking and for tests. */
export function indexedTextureRgba(texture: IndexedTexture): Uint8ClampedArray {
  const { size, indices, clut } = texture;
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const colour = clut[indices[i]!] ?? [0, 0, 0];
    rgba[i * 4] = colour[0]!;
    rgba[i * 4 + 1] = colour[1]!;
    rgba[i * 4 + 2] = colour[2]!;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/**
 * Paint the texture into `page` at the sprite sheet's origin, and load its CLUT
 * into the palette at {@link TEXTURE_CLUT_BASE}. After this, the pixels are an
 * ordinary, editable region of the sheet whose indices point at the CLUT.
 */
export function paintIndexedTexture(engine: CartEngine, texture: IndexedTexture, page: SpritePage): void {
  const { size, indices, clut } = texture;
  clut.forEach(([r, g, b], i) => engine.setPaletteColor(TEXTURE_CLUT_BASE + i, r, g, b));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tile = Math.floor(y / TILE_SIZE) * SHEET_COLS + Math.floor(x / TILE_SIZE);
      engine.setPixel(page, tile, x % TILE_SIZE, y % TILE_SIZE, TEXTURE_CLUT_BASE + indices[y * size + x]!);
    }
  }
}

/** Bake the texture to a PNG {@link EncodedImage} for a mesh material's initial image. */
export function bakeIndexedTextureImage(texture: IndexedTexture): EncodedImage {
  return { mime: "image/png", bytes: encodeRgbaPng(indexedTextureRgba(texture), texture.size, texture.size) };
}

/** The sprite region a mesh material references so the editor can rebake it. */
export function indexedTextureSpriteRef(size: number, page: SpritePage): SpriteTextureRef {
  return { page, x: 0, y: 0, width: size, height: size };
}

/**
 * The cart's assets sidecar carrying one named, editable sprite-block asset over
 * the texture's region — the "PS1 plate" / "N64 grass" chip a creator sees in the
 * Assets tab.
 *
 * Emitted as the voxel sidecar's v2 JSON directly (the editor package cannot
 * import the web app's `voxelSidecar`/`cartAssets`); the shape MUST match
 * `apps/web/src/lib/voxelSidecar.ts` (kind "cartbox.voxel", version 2) and
 * `cartAssets.ts` (kind "spriteBlock"). A round-trip test guards the agreement.
 */
export function assetsSidecarForTexture(id: string, name: string, size: number, page: SpritePage): string {
  return JSON.stringify({
    kind: "cartbox.voxel",
    version: 2,
    assets: [
      {
        kind: "spriteBlock",
        id,
        name,
        bank: 0,
        page,
        tile: 0,
        tilesPerSide: size / TILE_SIZE,
      },
    ],
  });
}

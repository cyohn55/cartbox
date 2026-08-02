/**
 * A {@link SpriteRegionSource} that reads a loaded cart's sprite sheet at runtime.
 *
 * The scene backdrop's layers reference regions of the cart's OWN sprite art; to
 * render them the player reads those tiles out of a cart object created from the
 * same .tic bytes (the `cbx_cart_*` authoring API the engine exposes), resolves
 * each pixel through the cart palette, and returns straight-alpha RGBA — palette
 * index 0 (the sheet's transparent colour) becomes a hole so sky shows through.
 *
 * Bit depth is derived from the model's palette size (Classic packs 4bpp, Pro and
 * the rest are 8bpp), mirroring the editor's tile codec, so no engine change is
 * needed. Pure apart from the WASM reads; the module handle is loosely typed
 * because the engine glue is (matching engine.ts).
 */

import type { Rgb } from "./parallaxScene.js";
import type { RegionImage, SpriteRegionSource } from "./sceneRender.js";

/** A region source plus the cart palette lookup + teardown the player needs. */
export interface CartSpriteSource {
  source: SpriteRegionSource;
  /** The RGB of a cart palette index (e.g. the scene's background keyColor). */
  paletteRgb(index: number): Rgb;
  /** Free the cart object. */
  dispose(): void;
}

const TILE_SIZE = 8;
const PIXELS_PER_TILE = TILE_SIZE * TILE_SIZE;
/** Tiles per sheet row — both cores lay the sheet out 16 wide. */
const SHEET_COLS = 16;

/* eslint-disable @typescript-eslint/no-explicit-any */
type EngineModule = any;

/** Read a tile's pixel index at the given bit depth (4bpp packs two per byte). */
function readPixel(heap: Uint8Array, tileBase: number, pixelIndex: number, bits: number): number {
  if (bits === 8) return heap[tileBase + pixelIndex] ?? 0;
  const byte = heap[tileBase + (pixelIndex >> 1)] ?? 0;
  return pixelIndex & 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
}

/**
 * Build a region source over a cart's bytes. Returns the source plus a `dispose`
 * that frees the cart object; call it when the player tears down. Returns null if
 * the engine lacks the cart API or the cart fails to load, so the caller can skip
 * the backdrop rather than crash.
 */
export function createCartSpriteSource(
  module: EngineModule,
  bytes: Uint8Array,
  paletteSize: number,
): CartSpriteSource | null {
  if (typeof module._cbx_cart_create !== "function") return null;
  const cart = module._cbx_cart_create();
  if (!cart) return null;

  const ptr = module._malloc(bytes.byteLength);
  module.HEAPU8.set(bytes, ptr);
  module._cbx_cart_load(cart, ptr, bytes.byteLength); // returns void
  module._free(ptr);

  const bits = paletteSize <= 16 ? 4 : 8;
  const bytesPerTile = bits === 8 ? PIXELS_PER_TILE : PIXELS_PER_TILE / 2;
  const bank = 0;
  const tilesPtr = module._cbx_cart_tiles_ptr(cart, bank);
  const spritesPtr = module._cbx_cart_sprites_ptr(cart, bank);
  const palettePtr = module._cbx_cart_palette_ptr(cart, bank);

  const source: SpriteRegionSource = {
    readRegion(page, baseTile, tilesW, tilesH): RegionImage {
      const width = tilesW * TILE_SIZE;
      const height = tilesH * TILE_SIZE;
      const pixels = new Uint8ClampedArray(width * height * 4);
      // Re-read the heap view each call: WASM memory can grow and detach the buffer.
      const heap = module.HEAPU8 as Uint8Array;
      const sheetBase = page === 0 ? tilesPtr : spritesPtr;
      for (let ty = 0; ty < tilesH; ty += 1) {
        for (let tx = 0; tx < tilesW; tx += 1) {
          const subTile = baseTile + ty * SHEET_COLS + tx;
          const tileBase = sheetBase + subTile * bytesPerTile;
          for (let y = 0; y < TILE_SIZE; y += 1) {
            for (let x = 0; x < TILE_SIZE; x += 1) {
              const idx = readPixel(heap, tileBase, y * TILE_SIZE + x, bits);
              if (idx === 0) continue; // transparent
              const o = ((ty * TILE_SIZE + y) * width + (tx * TILE_SIZE + x)) * 4;
              const p = palettePtr + idx * 3;
              pixels[o] = heap[p] ?? 0;
              pixels[o + 1] = heap[p + 1] ?? 0;
              pixels[o + 2] = heap[p + 2] ?? 0;
              pixels[o + 3] = 255;
            }
          }
        }
      }
      return { pixels, width, height };
    },
  };

  const paletteRgb = (index: number): Rgb => {
    const heap = module.HEAPU8 as Uint8Array;
    const p = palettePtr + index * 3;
    return [heap[p] ?? 0, heap[p + 1] ?? 0, heap[p + 2] ?? 0];
  };

  return { source, paletteRgb, dispose: () => module._cbx_cart_delete(cart) };
}

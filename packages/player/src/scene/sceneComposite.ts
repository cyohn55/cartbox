/**
 * Gap #3 part 3 — composite a cart's live frame over the parallax backdrop.
 *
 * A TIC-80 cart draws an opaque, full-screen framebuffer, so a backdrop can only
 * show if the cart LEAVES it room: the runtime treats every pixel the cart drew
 * in its background "key" colour as transparent and shows the backdrop there,
 * keeping the rest as the cart's foreground. This is chroma-keying on the cart's
 * own palette background (index 0 by convention; configurable via the scene's
 * keyColor) — the standard, zero-cost way to layer a backdrop behind sprite art.
 *
 * It runs on the RAW cart frame, before lighting + post-FX, so the composited
 * image (backdrop + foreground) is what those later passes finish together.
 *
 * Pure and DOM-free (RGBA in / RGBA out). Intended app home:
 * packages/player/src/scene/.
 */

import type { Rgb } from "./parallaxScene.js";

/** Whether an RGB pixel matches the key colour within a per-channel tolerance. */
function matchesKey(r: number, g: number, b: number, key: Rgb, tolerance: number): boolean {
  return (
    Math.abs(r - key[0]) <= tolerance &&
    Math.abs(g - key[1]) <= tolerance &&
    Math.abs(b - key[2]) <= tolerance
  );
}

/**
 * Composite `cartFrame` over `backdrop`: where the cart pixel matches `keyRgb`
 * (its background colour, resolved from the cart palette), show the backdrop;
 * everywhere else keep the cart's own pixel.
 *
 * @param cartFrame The cart's raw RGBA framebuffer (width*height*4).
 * @param backdrop  The rendered scene backdrop, same dimensions.
 * @param width     Framebuffer width.
 * @param height    Framebuffer height.
 * @param keyRgb    The background colour to key out (the cart palette's keyColor).
 * @param tolerance Per-channel match tolerance (0 = exact). Default 0.
 * @param out       Optional target buffer; defaults to a fresh one.
 * @returns The composited RGBA (the same array as `out` when supplied).
 */
export function compositeOverBackdrop(
  cartFrame: Uint8ClampedArray,
  backdrop: Uint8ClampedArray,
  width: number,
  height: number,
  keyRgb: Rgb,
  tolerance = 0,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const target = out ?? new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = cartFrame[o]!, g = cartFrame[o + 1]!, b = cartFrame[o + 2]!;
    if (matchesKey(r, g, b, keyRgb, tolerance)) {
      target[o] = backdrop[o]!;
      target[o + 1] = backdrop[o + 1]!;
      target[o + 2] = backdrop[o + 2]!;
      target[o + 3] = 255;
    } else {
      target[o] = r;
      target[o + 1] = g;
      target[o + 2] = b;
      target[o + 3] = 255;
    }
  }
  return target;
}

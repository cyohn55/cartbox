/**
 * PNG encode/decode. Thin wrapper over pngjs (pure JS, no native deps) so the
 * render worker runs anywhere Node runs. The decode side exists mainly so tests
 * can round-trip an encoded thumbnail back to pixels and assert on it.
 *
 * pngjs stores pixels as RGBA, which matches the engine's framebuffer byte
 * order, so no channel swizzle is needed.
 */

import { PNG } from "pngjs";

/** Encodes an RGBA buffer as a PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const expectedLength = width * height * 4;
  if (rgba.length !== expectedLength) {
    throw new RangeError(`rgba length ${rgba.length} does not match ${expectedLength}`);
  }
  const png = new PNG({ width, height });
  png.data.set(rgba);
  return PNG.sync.write(png);
}

/** Decoded PNG pixels and dimensions. */
export interface DecodedPng {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decodes a PNG buffer back to RGBA pixels. */
export function decodePng(buffer: Buffer): DecodedPng {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

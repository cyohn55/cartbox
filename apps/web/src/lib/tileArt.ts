/**
 * A tiny authoring format for hand-drawn face tiles: a tile is written as rows of
 * single-character keys plus a palette mapping each key to a colour (and optional
 * glow). It exists so the world's textures are *authored* pixel art — legible and
 * editable in source — rather than procedural noise, while still producing exactly
 * the {@link FaceTexture} the renderer samples.
 *
 * The art is funnelled through {@link spriteToFaceTexture}, the same adapter that
 * accepts sprite-editor output, so a tile drawn here and a tile drawn in the
 * editor reach the atlas by the identical path. Pure and DOM-free.
 */

import { spriteToFaceTexture, type FaceTexture } from "@cartbox/editor";

/** A painted texel: colour, optional alpha (default opaque) and glow (default 0). */
export interface ArtColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Straight alpha 0..255; 0 leaves a hole the face shows through. Default 255. */
  readonly a?: number;
  /** Self-emissive 0..255, so a texel can glow in shadow. Default 0. */
  readonly e?: number;
}

/** Maps each character used in the art rows to the colour it paints. */
export type ArtPalette = Readonly<Record<string, ArtColor>>;

/**
 * Build a square {@link FaceTexture} from character-art `rows` and a `palette`.
 * The tile's size is the number of rows; every row must be exactly that many
 * characters (a square tile), and every character must exist in the palette —
 * both are thrown on, so a mis-typed tile fails loudly at build time rather than
 * rendering a silent gap.
 */
export function tileFromArt(rows: readonly string[], palette: ArtPalette): FaceTexture {
  const size = rows.length;
  const data = new Uint8ClampedArray(size * size * 4);
  const emissive = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const row = rows[y]!;
    if (row.length !== size) {
      throw new Error(`tile row ${y} is "${row}" (${row.length} chars); expected ${size} for a square tile`);
    }
    for (let x = 0; x < size; x += 1) {
      const key = row[x]!;
      const color = palette[key];
      if (!color) throw new Error(`tile art uses "${key}" at (${x},${y}) but the palette has no such key`);
      const i = y * size + x;
      data[i * 4] = color.r;
      data[i * 4 + 1] = color.g;
      data[i * 4 + 2] = color.b;
      data[i * 4 + 3] = color.a ?? 255;
      emissive[i] = color.e ?? 0;
    }
  }
  return spriteToFaceTexture(data, size, size, emissive);
}

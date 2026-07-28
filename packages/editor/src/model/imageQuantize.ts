/**
 * Turning an arbitrary image into pixel art.
 *
 * {@link SpriteSheet.importImage} snaps each source pixel to its nearest palette
 * colour, one for one. That is exactly right for art that is already pixel art
 * at the cart's own scale, and it is the wrong tool for everything else: a photo
 * or a rendered frame imported that way arrives at full resolution, gets cropped
 * to the top-left corner of the page, and has its gradients flattened into bands
 * because nothing spreads the quantisation error anywhere.
 *
 * The missing front half is here — reduce the image to the size it will actually
 * occupy, then quantise it to the cart palette with a dither that trades spatial
 * resolution for colour resolution. Ordered (Bayer) dithering is what gives the
 * result its deliberate, repeating pixel-art texture; error diffusion is the
 * better choice for photographic sources, where the texture should disappear.
 *
 * Pure and DOM-free: the caller decodes the file (the browser's `drawImage` and
 * `getImageData` do that) and hands over RGBA bytes.
 */

import type { Rgb } from "./paletteImport";
import type { IndexedImage, SheetImage } from "./SpriteSheet";

/**
 * How quantisation error is disguised.
 *
 * The Bayer sizes differ in the scale of their texture, not their quality: a 2x2
 * matrix produces a coarse chequer that reads as deliberate shading on a large
 * sprite, an 8x8 an almost smooth gradient. `noise` breaks up banding without any
 * repeating pattern, at the cost of looking grainy. `floyd` diffuses the error
 * into neighbouring pixels instead of perturbing the threshold, which is what
 * you want when the source is photographic and the dither should be invisible.
 */
export type DitherMode = "none" | "bayer2" | "bayer4" | "bayer8" | "noise" | "floyd";

/** The dither modes in menu order, with the labels the UI shows. */
export const DITHER_MODES: readonly { readonly id: DitherMode; readonly label: string; readonly hint: string }[] = [
  { id: "none", label: "None", hint: "Snap each pixel to its nearest palette colour." },
  { id: "bayer2", label: "Bayer 2", hint: "Coarse ordered chequer — reads as deliberate shading." },
  { id: "bayer4", label: "Bayer 4", hint: "Medium ordered pattern; the usual pixel-art choice." },
  { id: "bayer8", label: "Bayer 8", hint: "Fine ordered pattern, closest to a smooth gradient." },
  { id: "noise", label: "Noise", hint: "Random threshold — breaks banding with no repeating pattern." },
  { id: "floyd", label: "Diffusion", hint: "Floyd–Steinberg error diffusion; best for photos." },
];

/**
 * The classic ordered-dither threshold matrices, as their raw ranks. Stored as
 * ranks rather than pre-divided fractions so one helper can normalise any size.
 */
const BAYER_MATRICES: Readonly<Record<"bayer2" | "bayer4" | "bayer8", { size: number; ranks: readonly number[] }>> = {
  bayer2: { size: 2, ranks: [0, 2, 3, 1] },
  bayer4: {
    size: 4,
    ranks: [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5],
  },
  bayer8: {
    size: 8,
    // prettier-ignore
    ranks: [
       0, 32,  8, 40,  2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44,  4, 36, 14, 46,  6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
       3, 35, 11, 43,  1, 33,  9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47,  7, 39, 13, 45,  5, 37,
      63, 31, 55, 23, 61, 29, 53, 21,
    ],
  },
};

/**
 * The dither offset at a pixel, in -0.5..0.5 of a full step. Ordered modes read
 * their matrix; `noise` hashes the coordinate so the result is still
 * reproducible, which matters because re-importing the same file must produce
 * the same sprite.
 */
export function ditherOffset(mode: DitherMode, x: number, y: number): number {
  if (mode === "noise") {
    // A cheap positional hash, deterministic in the coordinate alone.
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296 - 0.5;
  }
  const matrix = BAYER_MATRICES[mode as "bayer2" | "bayer4" | "bayer8"];
  if (!matrix) return 0;
  const { size, ranks } = matrix;
  const rank = ranks[(((y % size) + size) % size) * size + (((x % size) + size) % size)] ?? 0;
  return rank / (size * size) - 0.5;
}

/**
 * Box-filter downscale.
 *
 * Averaging every source pixel that lands in a destination pixel — rather than
 * point-sampling one of them — is what stops a downscaled image from
 * disintegrating: at a 10:1 reduction, nearest-neighbour throws away 99 of every
 * 100 pixels and keeps whichever one happened to be sampled.
 *
 * Colour is averaged weighted by alpha, so a sprite's transparent margin does
 * not drag its edge pixels toward black.
 */
export function downscaleImage(image: SheetImage, width: number, height: number): SheetImage {
  const targetWidth = Math.max(1, Math.round(width));
  const targetHeight = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const scaleX = image.width / targetWidth;
  const scaleY = image.height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    // Always cover at least one source row, even when scaling up.
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let weight = 0;
      let samples = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const base = (sy * image.width + sx) * 4;
          const a = image.data[base + 3] ?? 0;
          red += (image.data[base] ?? 0) * a;
          green += (image.data[base + 1] ?? 0) * a;
          blue += (image.data[base + 2] ?? 0) * a;
          alpha += a;
          weight += a;
          samples += 1;
        }
      }

      const target = (y * targetWidth + x) * 4;
      if (weight > 0) {
        data[target] = red / weight;
        data[target + 1] = green / weight;
        data[target + 2] = blue / weight;
      }
      data[target + 3] = samples > 0 ? alpha / samples : 0;
    }
  }
  return { data, width: targetWidth, height: targetHeight };
}

/** Squared RGB distance — the same metric the sheet's own nearest-colour match uses. */
function colorDistance(palette: readonly Rgb[], index: number, red: number, green: number, blue: number): number {
  const entry = palette[index];
  if (!entry) return Infinity;
  const dr = red - entry[0];
  const dg = green - entry[1];
  const db = blue - entry[2];
  return dr * dr + dg * dg + db * db;
}

/** The palette index closest to an RGB triplet, restricted to `usable` entries. */
function nearestIndex(palette: readonly Rgb[], usable: number, red: number, green: number, blue: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < usable; index += 1) {
    const distance = colorDistance(palette, index, red, green, blue);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

export interface QuantizeOptions {
  readonly dither: DitherMode;
  /**
   * Dither strength, 0..1. Scales the threshold perturbation (or the diffused
   * error), so the same mode can range from a hint of texture to full strength.
   */
  readonly strength: number;
  /**
   * Alpha below which a pixel is treated as a hole and written as colour index
   * 0, matching the sheet's existing import.
   */
  readonly alphaThreshold: number;
  /**
   * How many palette entries the result may use, counted from index 0. Lets an
   * import stay inside a reserved sub-range of a larger palette.
   */
  readonly colors: number;
}

export const DEFAULT_QUANTIZE_OPTIONS: QuantizeOptions = {
  dither: "bayer4",
  strength: 1,
  alphaThreshold: 128,
  colors: 0,
};

/**
 * The perturbation one full dither step is worth, in 0..255 channel units.
 *
 * Ordered dithering works by offsetting a pixel's value by up to half the gap to
 * the next available colour, so that pixels straddling the boundary alternate
 * and average out to the true value. The right gap depends on the palette; this
 * estimates it as the mean nearest-neighbour distance between palette entries,
 * which adapts a 4-colour Game Boy ramp and a 64-colour Pro palette without a
 * magic number for either.
 */
function ditherScale(palette: readonly Rgb[], usable: number): number {
  if (usable < 2) return 0;
  let total = 0;
  for (let index = 0; index < usable; index += 1) {
    let nearest = Infinity;
    const entry = palette[index];
    if (!entry) continue;
    for (let other = 0; other < usable; other += 1) {
      if (other === index) continue;
      const distance = colorDistance(palette, other, entry[0], entry[1], entry[2]);
      if (distance < nearest) nearest = distance;
    }
    if (Number.isFinite(nearest)) total += Math.sqrt(nearest);
  }
  return total / usable;
}

/**
 * Quantise an RGBA image to palette indices.
 *
 * Ordered modes perturb each pixel's colour by the matrix before matching;
 * `floyd` instead pushes the residual error into the pixels ahead, which is why
 * it runs over a mutable float copy of the image rather than reading the source
 * directly.
 */
export function quantizeToPalette(
  image: SheetImage,
  palette: readonly Rgb[],
  options: QuantizeOptions = DEFAULT_QUANTIZE_OPTIONS,
): IndexedImage {
  const usable = options.colors > 0 ? Math.min(options.colors, palette.length) : palette.length;
  const { width, height } = image;
  const indices = new Uint8Array(width * height);
  if (usable === 0) return { indices, width, height };

  const strength = Math.max(0, Math.min(1, options.strength));
  const scale = ditherScale(palette, usable) * strength;

  // Floyd–Steinberg needs somewhere to accumulate error, so it works on a float
  // copy; the ordered modes read the source and need no buffer.
  const working = options.dither === "floyd" ? Float32Array.from(image.data) : null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const base = index * 4;
      if ((image.data[base + 3] ?? 0) < options.alphaThreshold) continue;

      let red: number;
      let green: number;
      let blue: number;
      if (working) {
        red = working[base] ?? 0;
        green = working[base + 1] ?? 0;
        blue = working[base + 2] ?? 0;
      } else {
        const offset = ditherOffset(options.dither, x, y) * scale;
        red = (image.data[base] ?? 0) + offset;
        green = (image.data[base + 1] ?? 0) + offset;
        blue = (image.data[base + 2] ?? 0) + offset;
      }

      const chosen = nearestIndex(palette, usable, red, green, blue);
      indices[index] = chosen;

      if (!working) continue;
      const entry = palette[chosen];
      if (!entry) continue;
      const errorRed = (red - entry[0]) * strength;
      const errorGreen = (green - entry[1]) * strength;
      const errorBlue = (blue - entry[2]) * strength;
      // The standard Floyd–Steinberg kernel: 7/16 right, then 3/16, 5/16, 1/16
      // across the row below.
      diffuse(working, image, x + 1, y, 7 / 16, errorRed, errorGreen, errorBlue);
      diffuse(working, image, x - 1, y + 1, 3 / 16, errorRed, errorGreen, errorBlue);
      diffuse(working, image, x, y + 1, 5 / 16, errorRed, errorGreen, errorBlue);
      diffuse(working, image, x + 1, y + 1, 1 / 16, errorRed, errorGreen, errorBlue);
    }
  }
  return { indices, width, height };
}

/** Add a weighted share of the quantisation error to one neighbour, if it exists. */
function diffuse(
  working: Float32Array,
  image: SheetImage,
  x: number,
  y: number,
  weight: number,
  red: number,
  green: number,
  blue: number,
): void {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  const base = (y * image.width + x) * 4;
  working[base] = (working[base] ?? 0) + red * weight;
  working[base + 1] = (working[base + 1] ?? 0) + green * weight;
  working[base + 2] = (working[base + 2] ?? 0) + blue * weight;
}

export interface PixelateOptions extends QuantizeOptions {
  /** Target width in cart pixels. Height follows from the source aspect ratio. */
  readonly width: number;
  /** Target height in cart pixels; 0 keeps the source aspect ratio. */
  readonly height: number;
}

export const DEFAULT_PIXELATE_OPTIONS: PixelateOptions = {
  ...DEFAULT_QUANTIZE_OPTIONS,
  width: 64,
  height: 0,
};

/**
 * The full import path: reduce to the target size, then dither and quantise.
 *
 * Downscaling first is not an optimisation — it is the reason the result reads
 * as pixel art. Quantising at source resolution and shrinking afterwards would
 * average the dithered pixels back into the intermediate colours the dither
 * existed to fake.
 */
export function pixelateImage(
  image: SheetImage,
  palette: readonly Rgb[],
  options: PixelateOptions = DEFAULT_PIXELATE_OPTIONS,
): IndexedImage {
  const width = Math.max(1, Math.round(options.width));
  const height =
    options.height > 0
      ? Math.round(options.height)
      : Math.max(1, Math.round((width * image.height) / Math.max(1, image.width)));
  return quantizeToPalette(downscaleImage(image, width, height), palette, options);
}

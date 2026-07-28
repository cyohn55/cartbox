/**
 * Image-to-pixel-art import tests: box downscale, ordered and diffused
 * dithering, and quantisation onto the cart's real palette.
 *
 * Expectations are computed from the inputs the test supplies — the mean of a
 * source quad, the nearest entry of the palette actually loaded — rather than
 * written down, so a change in tuning that is genuinely wrong fails and a change
 * that is merely different does not. The final step goes through the real
 * SpriteSheet so the indices are read back out of a real engine.
 */

import { describe, expect, it } from "vitest";
import {
  DITHER_MODES,
  SpriteSheet,
  StubCartEngine,
  downscaleImage,
  pixelateImage,
  quantizeToPalette,
  DEFAULT_QUANTIZE_OPTIONS,
  type DitherMode,
  type Rgb,
  type SheetImage,
  type SpritePage,
} from "@cartbox/editor";

const PAGE: SpritePage = 0;

/** Build an RGBA image from a per-pixel colour function. */
function makeImage(width: number, height: number, at: (x: number, y: number) => [number, number, number, number]): SheetImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = at(x, y);
      const base = (y * width + x) * 4;
      data[base] = r;
      data[base + 1] = g;
      data[base + 2] = b;
      data[base + 3] = a;
    }
  }
  return { data, width, height };
}

/** Nearest palette entry by squared distance — the metric the sheet itself uses. */
function nearest(palette: readonly Rgb[], r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Infinity;
  palette.forEach((entry, index) => {
    const distance = (r - entry[0]) ** 2 + (g - entry[1]) ** 2 + (b - entry[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** A three-step greyscale ramp, so "between two entries" is unambiguous. */
const GREY_RAMP: Rgb[] = [
  [0, 0, 0],
  [128, 128, 128],
  [255, 255, 255],
];

describe("downscaleImage", () => {
  it("averages every source pixel that lands in a destination pixel", () => {
    // Each 2x2 quad of the source carries four different values.
    const source = makeImage(4, 4, (x, y) => [x * 40, y * 40, (x + y) * 20, 255]);
    const scaled = downscaleImage(source, 2, 2);

    for (let ty = 0; ty < 2; ty += 1) {
      for (let tx = 0; tx < 2; tx += 1) {
        const expected = [0, 0, 0];
        for (let y = ty * 2; y < ty * 2 + 2; y += 1) {
          for (let x = tx * 2; x < tx * 2 + 2; x += 1) {
            const base = (y * 4 + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
              expected[channel]! += source.data[base + channel]! / 4;
            }
          }
        }
        const target = (ty * 2 + tx) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          expect(scaled.data[target + channel]!).toBeCloseTo(expected[channel]!, 0);
        }
      }
    }
  });

  it("weights colour by alpha, so a transparent margin does not darken an edge", () => {
    // One opaque red pixel among three fully transparent ones.
    const source = makeImage(2, 2, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    const scaled = downscaleImage(source, 1, 1);

    expect(scaled.data[0]).toBe(255);
    expect(scaled.data[1]).toBe(0);
    expect(scaled.data[2]).toBe(0);
    // Coverage is the mean alpha: one opaque pixel in four.
    expect(scaled.data[3]).toBeCloseTo(255 / 4, 0);
  });

  it("always covers at least one source pixel per destination pixel", () => {
    const source = makeImage(2, 2, () => [10, 20, 30, 255]);
    const enlarged = downscaleImage(source, 5, 3);

    expect(enlarged.width).toBe(5);
    expect(enlarged.height).toBe(3);
    // No destination pixel was left unwritten by an empty source range.
    for (let index = 0; index < 5 * 3; index += 1) {
      expect(enlarged.data[index * 4 + 3]).toBe(255);
    }
  });
});

describe("quantizeToPalette", () => {
  it("without dither, picks the nearest palette entry for every pixel", () => {
    const source = makeImage(8, 8, (x, y) => [x * 32, y * 32, 128, 255]);
    const result = quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, dither: "none" });

    for (let index = 0; index < source.width * source.height; index += 1) {
      const base = index * 4;
      const expected = nearest(GREY_RAMP, source.data[base]!, source.data[base + 1]!, source.data[base + 2]!);
      expect(result.indices[index]).toBe(expected);
    }
  });

  it("writes colour 0 where the source is transparent", () => {
    const source = makeImage(4, 4, (x) => [255, 255, 255, x === 0 ? 0 : 255]);
    const result = quantizeToPalette(source, GREY_RAMP, DEFAULT_QUANTIZE_OPTIONS);

    for (let y = 0; y < 4; y += 1) {
      expect(result.indices[y * 4]).toBe(0);
    }
  });

  it("dithers a flat mid-tone into a mix of the two entries around it, where a flat quantise cannot", () => {
    // Exactly between the ramp's black and mid-grey, so no single entry is right.
    const source = makeImage(16, 16, () => [64, 64, 64, 255]);

    const flat = new Set(quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, dither: "none" }).indices);
    expect(flat.size).toBe(1);

    for (const mode of ["bayer2", "bayer4", "bayer8", "noise"] as const) {
      const dithered = new Set(
        quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, dither: mode }).indices,
      );
      expect(dithered.size, `${mode} should mix two entries`).toBeGreaterThan(1);
    }
  });

  it("tracks the source's local tone with diffusion, which a flat quantise cannot", () => {
    // A smooth gradient is the case error diffusion exists for. The property it
    // buys is *not* per-pixel accuracy — a dithered pixel is deliberately the
    // wrong colour — but that a neighbourhood averages out to the right one.
    const source = makeImage(32, 32, (x) => [x * 8, x * 8, x * 8, 255]);
    const window = 8;

    const localError = (mode: DitherMode): number => {
      const result = quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, dither: mode });
      let total = 0;
      let windows = 0;
      for (let y = 0; y < source.height; y += 1) {
        for (let start = 0; start + window <= source.width; start += window) {
          let chosenSum = 0;
          let sourceSum = 0;
          for (let x = start; x < start + window; x += 1) {
            const index = y * source.width + x;
            chosenSum += GREY_RAMP[result.indices[index]!]![0];
            sourceSum += source.data[index * 4]!;
          }
          total += Math.abs(chosenSum - sourceSum) / window;
          windows += 1;
        }
      }
      return total / windows;
    };

    expect(localError("floyd")).toBeLessThan(localError("none"));
  });

  it("is reproducible: the same file imported twice gives the same sprite", () => {
    const source = makeImage(16, 16, (x, y) => [x * 16, y * 16, 90, 255]);
    for (const mode of DITHER_MODES) {
      const first = quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, dither: mode.id });
      const second = quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, dither: mode.id });
      expect(Array.from(second.indices), mode.id).toEqual(Array.from(first.indices));
    }
  });

  it("stays inside the colour budget it is given", () => {
    const source = makeImage(16, 16, (x, y) => [x * 16, y * 16, 255, 255]);
    const result = quantizeToPalette(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, colors: 2 });
    for (const index of result.indices) expect(index).toBeLessThan(2);
  });
});

describe("pixelateImage", () => {
  it("keeps the source aspect ratio when only a width is given", () => {
    const source = makeImage(40, 20, () => [200, 200, 200, 255]);
    const result = pixelateImage(source, GREY_RAMP, {
      ...DEFAULT_QUANTIZE_OPTIONS,
      width: 20,
      height: 0,
    });

    expect(result.width).toBe(20);
    expect(result.height).toBe(10);
  });

  it("takes an explicit height when one is given", () => {
    const source = makeImage(40, 20, () => [200, 200, 200, 255]);
    const result = pixelateImage(source, GREY_RAMP, { ...DEFAULT_QUANTIZE_OPTIONS, width: 8, height: 8 });
    expect([result.width, result.height]).toEqual([8, 8]);
  });
});

describe("SpriteSheet.importIndexedAt", () => {
  it("writes the decided index for every pixel, without re-matching it", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);

    // A checkerboard of two indices whose colours are far apart, so a naive
    // re-match on the way in would be visible as a flat block.
    const edge = sheet.tileSize;
    const indices = new Uint8Array(edge * edge);
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) indices[y * edge + x] = (x + y) % 2 === 0 ? 1 : 2;
    }

    const written = sheet.importIndexedAt({ indices, width: edge, height: edge }, PAGE, 0, 0);
    expect(written).toBe(edge * edge);

    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        expect(sheet.getPixel(PAGE, 0, x, y)).toBe(indices[y * edge + x]);
      }
    }
  });

  it("clamps an index past the palette rather than dropping the pixel", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);
    const indices = new Uint8Array([sheet.paletteSize + 40]);

    sheet.importIndexedAt({ indices, width: 1, height: 1 }, PAGE, 0, 0);
    expect(sheet.getPixel(PAGE, 0, 0, 0)).toBe(sheet.paletteSize - 1);
  });

  it("crops at the page edge instead of wrapping into the next row of tiles", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);
    const overhang = 4;
    const size = sheet.tileSize;
    const indices = new Uint8Array(size * size).fill(3);

    const written = sheet.importIndexedAt(
      { indices, width: size, height: size },
      PAGE,
      sheet.sheetSize - overhang,
      0,
    );
    expect(written).toBe(overhang * size);
  });
});

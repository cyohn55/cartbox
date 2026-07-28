/**
 * Cube LUTs — a colour grade as a lookup table.
 *
 * A `.cube` file is the interchange format colourists actually work in: a grid
 * of output colours sampled over the RGB cube, produced by DaVinci Resolve,
 * Photoshop, or any of the film-emulation packs. It carries a whole grade — the
 * crushed blacks, the split tone, the channel crosstalk — as data, in a form no
 * stack of brightness/contrast/saturation sliders can reproduce.
 *
 * Two things in the editor want that. The FX tab wants it as a grading stage.
 * More interestingly, the *palette* wants it: running the cart's existing
 * palette through a LUT re-grades all sixteen (or sixty-four) colours at once
 * while keeping their relationships, which turns a film look into something a
 * cart can genuinely render — the console has no per-frame colour pipeline, but
 * it does have a palette, and that is where a grade has to live.
 *
 * Pure and DOM-free. Parsing is strict about structure and lenient about
 * whitespace and comments, because these files are hand-edited constantly.
 */

import type { Rgb } from "./paletteImport";

/**
 * A parsed lookup table.
 *
 * `table` holds `size ** dimensions` entries of three floats. For a 3D LUT the
 * red index varies fastest, then green, then blue — the order the format
 * specifies, and the order the trilinear lookup assumes.
 */
export interface CubeLut {
  readonly title: string;
  /** 1 for a per-channel curve, 3 for a full colour cube. */
  readonly dimensions: 1 | 3;
  /** Samples per axis. */
  readonly size: number;
  readonly table: Float32Array;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
}

/** Raised when a file is not a usable `.cube`; the message is shown to the user. */
export class CubeLutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CubeLutError";
  }
}

// The format's own limits. A 2-sample cube is degenerate but legal; the upper
// bound is what the specification allows and also what keeps a hostile file from
// asking for a 64 GB allocation.
const MIN_SIZE = 2;
const MAX_3D_SIZE = 256;
const MAX_1D_SIZE = 65536;

/** Read three whitespace-separated floats, or null when the line is not a triplet. */
function parseTriplet(parts: readonly string[]): [number, number, number] | null {
  if (parts.length < 3) return null;
  const values: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const value = Number(parts[index]);
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  return [values[0]!, values[1]!, values[2]!];
}

/**
 * Parse a `.cube` file.
 *
 * Keywords may appear in any order and may be interleaved with data in the wild,
 * so the size is not required to precede the samples — the rows are collected
 * first and validated against the declared size at the end. That also produces a
 * far more useful error than failing on the first unexpected row.
 */
export function parseCubeLut(text: string): CubeLut {
  let title = "";
  let dimensions: 1 | 3 | null = null;
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const rows: Array<[number, number, number]> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    const keyword = (parts[0] ?? "").toUpperCase();

    switch (keyword) {
      case "TITLE":
        title = line.slice(parts[0]!.length).trim().replace(/^"|"$/g, "");
        continue;
      case "LUT_3D_SIZE":
      case "LUT_1D_SIZE": {
        const declared = Number(parts[1]);
        if (!Number.isInteger(declared)) {
          throw new CubeLutError(`${keyword} is not a whole number.`);
        }
        dimensions = keyword === "LUT_3D_SIZE" ? 3 : 1;
        const limit = dimensions === 3 ? MAX_3D_SIZE : MAX_1D_SIZE;
        if (declared < MIN_SIZE || declared > limit) {
          throw new CubeLutError(`${keyword} must be between ${MIN_SIZE} and ${limit}; got ${declared}.`);
        }
        size = declared;
        continue;
      }
      case "DOMAIN_MIN":
      case "DOMAIN_MAX": {
        const triplet = parseTriplet(parts.slice(1));
        if (!triplet) throw new CubeLutError(`${keyword} needs three numbers.`);
        if (keyword === "DOMAIN_MIN") domainMin = triplet;
        else domainMax = triplet;
        continue;
      }
      default:
        break;
    }

    const sample = parseTriplet(parts);
    if (!sample) throw new CubeLutError(`Could not read "${line}" as a colour or a keyword.`);
    rows.push(sample);
  }

  if (dimensions === null || size === 0) {
    throw new CubeLutError("No LUT_3D_SIZE or LUT_1D_SIZE line — this is not a .cube LUT.");
  }
  const expected = dimensions === 3 ? size * size * size : size;
  if (rows.length !== expected) {
    throw new CubeLutError(`Expected ${expected} colour rows for a ${size}-point ${dimensions}D LUT, found ${rows.length}.`);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (domainMax[axis]! <= domainMin[axis]!) {
      throw new CubeLutError("DOMAIN_MAX must be greater than DOMAIN_MIN on every channel.");
    }
  }

  const table = new Float32Array(expected * 3);
  for (let index = 0; index < expected; index += 1) {
    const row = rows[index]!;
    table[index * 3] = row[0];
    table[index * 3 + 1] = row[1];
    table[index * 3 + 2] = row[2];
  }
  return { title, dimensions, size, table, domainMin, domainMax };
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** One table entry as a triplet, by flat sample index. */
function entryAt(lut: CubeLut, index: number): [number, number, number] {
  const base = index * 3;
  return [lut.table[base] ?? 0, lut.table[base + 1] ?? 0, lut.table[base + 2] ?? 0];
}

/** Normalise an input channel into 0..1 across the LUT's declared domain. */
function toDomain(lut: CubeLut, value01: number, axis: number): number {
  const min = lut.domainMin[axis] ?? 0;
  const max = lut.domainMax[axis] ?? 1;
  return clamp01((value01 - min) / (max - min));
}

/**
 * Look one colour up, in 0..1 in and out.
 *
 * A 3D LUT is interpolated trilinearly between the eight surrounding samples;
 * without interpolation a typical 33-point cube would posterise everything it
 * touched into 33 levels per channel, which is the opposite of what a grade is
 * for. A 1D LUT is a per-channel curve and interpolates linearly.
 */
export function applyLut01(lut: CubeLut, red: number, green: number, blue: number): [number, number, number] {
  const last = lut.size - 1;

  if (lut.dimensions === 1) {
    const channel = (value: number, axis: number): number => {
      const position = toDomain(lut, value, axis) * last;
      const low = Math.floor(position);
      const high = Math.min(last, low + 1);
      const t = position - low;
      const a = entryAt(lut, low)[axis] ?? 0;
      const b = entryAt(lut, high)[axis] ?? 0;
      return a + (b - a) * t;
    };
    return [channel(red, 0), channel(green, 1), channel(blue, 2)];
  }

  const positions = [toDomain(lut, red, 0) * last, toDomain(lut, green, 1) * last, toDomain(lut, blue, 2) * last];
  const low = positions.map((position) => Math.floor(position));
  const frac = positions.map((position, axis) => position - low[axis]!);
  const high = low.map((value) => Math.min(last, value + 1));

  // Red varies fastest in the file's sample order, so it is the innermost stride.
  const sampleAt = (r: number, g: number, b: number): [number, number, number] =>
    entryAt(lut, r + g * lut.size + b * lut.size * lut.size);

  const out: [number, number, number] = [0, 0, 0];
  for (let corner = 0; corner < 8; corner += 1) {
    const useHighRed = (corner & 1) !== 0;
    const useHighGreen = (corner & 2) !== 0;
    const useHighBlue = (corner & 4) !== 0;
    const weight =
      (useHighRed ? frac[0]! : 1 - frac[0]!) *
      (useHighGreen ? frac[1]! : 1 - frac[1]!) *
      (useHighBlue ? frac[2]! : 1 - frac[2]!);
    if (weight === 0) continue;
    const sample = sampleAt(
      useHighRed ? high[0]! : low[0]!,
      useHighGreen ? high[1]! : low[1]!,
      useHighBlue ? high[2]! : low[2]!,
    );
    out[0] += sample[0] * weight;
    out[1] += sample[1] * weight;
    out[2] += sample[2] * weight;
  }
  return out;
}

/** Look one 0..255 colour up, rounded back to 0..255. */
export function applyLutRgb(lut: CubeLut, color: Rgb): Rgb {
  const [red, green, blue] = applyLut01(lut, color[0] / 255, color[1] / 255, color[2] / 255);
  return [
    Math.round(clamp01(red) * 255),
    Math.round(clamp01(green) * 255),
    Math.round(clamp01(blue) * 255),
  ];
}

/**
 * Re-grade a palette through a LUT.
 *
 * This is the form a grade can actually take on a fantasy console: the cart has
 * no post-processing budget for a per-pixel LUT at runtime, but every colour it
 * can draw comes from the palette, so grading the palette grades the game. The
 * `amount` blend exists because film LUTs are routinely far too strong at full
 * strength on a sixteen-colour ramp, where they can collapse two entries onto
 * the same colour and cost the artist a shade.
 */
export function gradePalette(lut: CubeLut, palette: readonly Rgb[], amount = 1): Rgb[] {
  const mix = clamp01(amount);
  return palette.map((color) => {
    const graded = applyLutRgb(lut, color);
    return [
      Math.round(color[0] + (graded[0] - color[0]) * mix),
      Math.round(color[1] + (graded[1] - color[1]) * mix),
      Math.round(color[2] + (graded[2] - color[2]) * mix),
    ] as Rgb;
  });
}

/**
 * Sample a LUT into the flat RGB grid a shader uploads as a texture: `size`
 * cells along each axis, red fastest, three bytes per cell. Kept here rather
 * than in the renderer so the CPU grade and the GPU grade read the same table.
 */
export function lutToBytes(lut: CubeLut): { readonly size: number; readonly data: Uint8Array } {
  if (lut.dimensions === 3) {
    const data = new Uint8Array(lut.size * lut.size * lut.size * 3);
    for (let index = 0; index < lut.size ** 3; index += 1) {
      const [red, green, blue] = entryAt(lut, index);
      data[index * 3] = Math.round(clamp01(red) * 255);
      data[index * 3 + 1] = Math.round(clamp01(green) * 255);
      data[index * 3 + 2] = Math.round(clamp01(blue) * 255);
    }
    return { size: lut.size, data };
  }

  // A 1D curve is expanded into a cube so the consumer has one shape to handle.
  const size = Math.min(MAX_3D_SIZE, lut.size);
  const data = new Uint8Array(size * size * size * 3);
  const last = size - 1;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const graded = applyLut01(lut, red / last, green / last, blue / last);
        const base = (red + green * size + blue * size * size) * 3;
        data[base] = Math.round(clamp01(graded[0]) * 255);
        data[base + 1] = Math.round(clamp01(graded[1]) * 255);
        data[base + 2] = Math.round(clamp01(graded[2]) * 255);
      }
    }
  }
  return { size, data };
}

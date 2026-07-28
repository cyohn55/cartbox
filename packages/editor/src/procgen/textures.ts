/**
 * Procedural *textures* — the surface-scale half of procgen.
 *
 * The generators in {@link MAP_GENERATORS} and {@link VOXEL_GENERATORS} lay out
 * a level: where the rock is, where the rooms are, where the water stops. None
 * of them draws anything. What a cart also needs, constantly, is the other
 * scale — a brick wall, a wood plank, a noise field to break up a flat floor —
 * and that has been hand-pixelled every time.
 *
 * These follow exactly the pattern the level generators established, for exactly
 * the same reason: each is described as data (a label, a list of
 * {@link ParamSpec}, one pure `generate`), so the Generate panel renders the
 * controls itself and adding a texture here makes it appear with working sliders
 * and no UI change.
 *
 * Where they differ is in what they produce. A level generator emits a
 * {@link ClassField} — named classes that a mapping turns into tiles. A texture
 * emits a scalar field in 0..1, and {@link textureToIndices} ramps that across a
 * run of palette entries. Splitting it that way is what lets one marble
 * generator produce grey stone or green malachite depending only on the ramp it
 * is handed, and lets the ramp be dithered so a four-colour palette can still
 * show a gradient.
 *
 * The patterned generators tile seamlessly, which is not a nicety: these produce
 * *tiles*, laid edge to edge across a map, and a texture with a visible seam at
 * its border draws a grid over the entire world. Two exceptions are inherent
 * rather than oversights — a linear gradient has two different ends and a radial
 * one has a centre, so neither can join up with itself. They are here because a
 * ramp is genuinely useful as a single tile (a sky, a shading base), and their
 * descriptions say so.
 *
 * Pure and DOM-free.
 */

import { hashCoords2, smoothstep } from "./noise";
import { ditherOffset, type DitherMode } from "../model/imageQuantize";
import type { GeneratorValues, ParamSpec } from "./generators";
import type { IndexedImage } from "../model/SpriteSheet";

/** A generated texture: one 0..1 sample per pixel, row-major. */
export interface TextureField {
  readonly width: number;
  readonly height: number;
  readonly values: Float32Array;
}

/** A texture generator, described declaratively like every other generator. */
export interface TextureGenerator {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly params: readonly ParamSpec[];
  /**
   * Whether the result joins up with itself at the tile border. False only for
   * the ramps, which cannot: it is what a caller checks before laying the result
   * across a map rather than using it as a single tile.
   */
  readonly tiles: boolean;
  generate(width: number, height: number, values: GeneratorValues): TextureField;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Read a parameter, clamped to its declared range, defaulting to the spec value. */
function read(params: readonly ParamSpec[], values: GeneratorValues, key: string): number {
  const spec = params.find((param) => param.key === key);
  const raw = values[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return spec ? Math.min(spec.max, Math.max(spec.min, raw)) : raw;
  }
  return spec?.value ?? 0;
}

const SEED: ParamSpec = {
  key: "seed",
  label: "Seed",
  min: 1,
  max: 9999,
  step: 1,
  value: 1,
  format: "integer",
  hint: "The same seed and settings always regenerate the same texture.",
};

const CONTRAST: ParamSpec = {
  key: "contrast",
  label: "Contrast",
  min: 0.25,
  max: 4,
  step: 0.05,
  value: 1,
  format: "decimal",
  hint: "Spreads the pattern away from mid-grey before it is ramped.",
};

/** Push a 0..1 value away from (or toward) the midpoint. */
function applyContrast(value: number, contrast: number): number {
  return clamp01(0.5 + (value - 0.5) * contrast);
}

// --- Tileable noise ---------------------------------------------------------
//
// `noise.ts` deliberately carries a byte-identical twin in apps/web, so it is
// left alone; these are the texture-specific variants. The difference from
// plain value noise is only that lattice coordinates wrap at a period, which is
// what makes the result join up with itself at the tile border.

function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}

/** Value noise whose lattice repeats every `period` units on each axis. */
function tiledValueNoise(x: number, y: number, periodX: number, periodY: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const corner = (cx: number, cy: number): number =>
    hashCoords2(wrap(cx, periodX), wrap(cy, periodY), seed);
  const c00 = corner(x0, y0);
  const c10 = corner(x0 + 1, y0);
  const c01 = corner(x0, y0 + 1);
  const c11 = corner(x0 + 1, y0 + 1);
  const top = c00 + (c10 - c00) * tx;
  const bottom = c01 + (c11 - c01) * tx;
  return top + (bottom - top) * ty;
}

const OCTAVE_SEED_STRIDE = 1013;

/**
 * Multi-octave tileable noise. Each octave doubles both the frequency and the
 * wrap period, so every octave tiles at the same texture size and the sum does
 * too — halving one without the other is the usual way a "tileable" fractal
 * noise turns out to have seams.
 */
function tiledFractalNoise(
  x: number,
  y: number,
  periodX: number,
  periodY: number,
  seed: number,
  octaves: number,
): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < Math.max(1, Math.round(octaves)); octave += 1) {
    sum +=
      tiledValueNoise(
        x * frequency,
        y * frequency,
        Math.max(1, periodX * frequency),
        Math.max(1, periodY * frequency),
        seed + octave * OCTAVE_SEED_STRIDE,
      ) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/** Allocate a field and fill it from a per-pixel function. */
function fieldFrom(width: number, height: number, sample: (x: number, y: number) => number): TextureField {
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[y * width + x] = clamp01(sample(x, y));
    }
  }
  return { width, height, values };
}

// --- The generators ---------------------------------------------------------

const NOISE_PARAMS: readonly ParamSpec[] = [
  { key: "scale", label: "Scale", min: 1, max: 16, step: 1, value: 4, format: "integer", hint: "Noise cells across the tile — higher is finer." },
  { key: "octaves", label: "Detail", min: 1, max: 6, step: 1, value: 4, format: "integer", hint: "Layers of finer noise added on top." },
  CONTRAST,
  SEED,
];

const CHECKER_PARAMS: readonly ParamSpec[] = [
  { key: "cells", label: "Squares", min: 2, max: 32, step: 2, value: 4, format: "integer", hint: "Squares across the tile; even values keep it seamless." },
  { key: "softness", label: "Softness", min: 0, max: 1, step: 0.05, value: 0, format: "percent", hint: "Blurs the edges between squares." },
];

const GRADIENT_PARAMS: readonly ParamSpec[] = [
  { key: "angle", label: "Angle", min: 0, max: 360, step: 15, value: 90, format: "integer", hint: "Direction of a linear ramp, in degrees." },
  { key: "radial", label: "Radial", min: 0, max: 1, step: 1, value: 0, format: "integer", hint: "Ramp outward from the centre instead of across." },
  { key: "bias", label: "Bias", min: 0.25, max: 4, step: 0.05, value: 1, format: "decimal", hint: "Bends the ramp toward one end." },
];

const BRICK_PARAMS: readonly ParamSpec[] = [
  { key: "columns", label: "Bricks across", min: 1, max: 16, step: 1, value: 2, format: "integer", hint: "Whole bricks across the tile." },
  { key: "rows", label: "Courses", min: 1, max: 16, step: 1, value: 4, format: "integer", hint: "Rows of bricks down the tile." },
  { key: "mortar", label: "Mortar", min: 0.02, max: 0.4, step: 0.01, value: 0.12, format: "percent", hint: "Width of the gap between bricks." },
  { key: "offset", label: "Stagger", min: 0, max: 1, step: 0.05, value: 0.5, format: "percent", hint: "How far alternate courses shift sideways." },
  { key: "variation", label: "Variation", min: 0, max: 1, step: 0.05, value: 0.3, format: "percent", hint: "How much individual bricks differ in tone." },
  SEED,
];

const MARBLE_PARAMS: readonly ParamSpec[] = [
  { key: "veins", label: "Veins", min: 1, max: 12, step: 1, value: 3, format: "integer", hint: "Bands of vein across the tile." },
  { key: "turbulence", label: "Turbulence", min: 0, max: 3, step: 0.05, value: 1, format: "decimal", hint: "How far the veins wander from straight." },
  { key: "scale", label: "Scale", min: 1, max: 12, step: 1, value: 3, format: "integer", hint: "Size of the turbulence that bends the veins." },
  CONTRAST,
  SEED,
];

const WOOD_PARAMS: readonly ParamSpec[] = [
  { key: "rings", label: "Rings", min: 1, max: 24, step: 1, value: 6, format: "integer", hint: "Growth rings from the centre outward." },
  { key: "turbulence", label: "Turbulence", min: 0, max: 2, step: 0.05, value: 0.5, format: "decimal", hint: "How irregular the rings are." },
  { key: "grain", label: "Grain", min: 0, max: 1, step: 0.05, value: 0.35, format: "percent", hint: "Fine streaking along the grain." },
  SEED,
];

const VORONOI_PARAMS: readonly ParamSpec[] = [
  { key: "cells", label: "Cells", min: 2, max: 16, step: 1, value: 4, format: "integer", hint: "Cells across the tile." },
  { key: "jitter", label: "Irregularity", min: 0, max: 1, step: 0.05, value: 0.8, format: "percent", hint: "How far cell centres wander from a grid." },
  { key: "edges", label: "Edges", min: 0, max: 1, step: 1, value: 0, format: "integer", hint: "Draw the borders between cells instead of filling them." },
  SEED,
];

const STRIPE_PARAMS: readonly ParamSpec[] = [
  { key: "count", label: "Stripes", min: 1, max: 32, step: 1, value: 4, format: "integer", hint: "Stripes across the tile." },
  { key: "angle", label: "Angle", min: 0, max: 180, step: 15, value: 0, format: "integer", hint: "Stripe direction; 0 and 90 always tile cleanly." },
  { key: "duty", label: "Width", min: 0.05, max: 0.95, step: 0.05, value: 0.5, format: "percent", hint: "Share of each stripe that is filled." },
  { key: "softness", label: "Softness", min: 0, max: 1, step: 0.05, value: 0, format: "percent", hint: "Blurs the stripe edges." },
];

/**
 * A soft-edged step: a hard boundary at `softness` 0, a smooth ramp above it.
 * Shared by every generator that draws an edge, so mortar lines, stripe borders
 * and cell walls all soften the same way.
 */
function edge(distance: number, softness: number): number {
  if (softness <= 0) return distance > 0 ? 1 : 0;
  return smoothstep(clamp01(distance / softness + 0.5));
}

export const TEXTURE_GENERATORS: readonly TextureGenerator[] = [
  {
    id: "noise",
    label: "Noise",
    description: "Layered value noise — the base for stone, dirt, and rust.",
    params: NOISE_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const scale = read(NOISE_PARAMS, values, "scale");
      const octaves = read(NOISE_PARAMS, values, "octaves");
      const contrast = read(NOISE_PARAMS, values, "contrast");
      const seed = read(NOISE_PARAMS, values, "seed");
      return fieldFrom(width, height, (x, y) =>
        applyContrast(
          tiledFractalNoise((x / width) * scale, (y / height) * scale, scale, scale, seed, octaves),
          contrast,
        ),
      );
    },
  },
  {
    id: "checker",
    label: "Checker",
    description: "Alternating squares — floors, test grids, tablecloth.",
    params: CHECKER_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const cells = read(CHECKER_PARAMS, values, "cells");
      const softness = read(CHECKER_PARAMS, values, "softness");
      return fieldFrom(width, height, (x, y) => {
        const u = ((x + 0.5) / width) * cells;
        const v = ((y + 0.5) / height) * cells;
        // Distance to the nearest square boundary, so softness blurs symmetrically.
        const du = Math.abs(u - Math.floor(u) - 0.5);
        const dv = Math.abs(v - Math.floor(v) - 0.5);
        const parity = (Math.floor(u) + Math.floor(v)) % 2 === 0 ? 1 : 0;
        const nearness = 0.5 - Math.max(du, dv);
        return parity === 1 ? edge(nearness, softness) : 1 - edge(nearness, softness);
      });
    },
  },
  {
    id: "gradient",
    label: "Gradient",
    description: "A linear or radial ramp — skies, glows, and shading bases.",
    params: GRADIENT_PARAMS,
    tiles: false,
    generate(width, height, values) {
      const angle = (read(GRADIENT_PARAMS, values, "angle") * Math.PI) / 180;
      const radial = read(GRADIENT_PARAMS, values, "radial") >= 0.5;
      const bias = read(GRADIENT_PARAMS, values, "bias");
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      return fieldFrom(width, height, (x, y) => {
        const u = (x + 0.5) / width - 0.5;
        const v = (y + 0.5) / height - 0.5;
        // Both forms are normalised to 0..1 so `bias` behaves identically.
        const raw = radial
          ? clamp01(1 - Math.hypot(u, v) * 2)
          : clamp01((u * dirX + v * dirY) / (Math.abs(dirX) + Math.abs(dirY)) + 0.5);
        return Math.pow(raw, bias);
      });
    },
  },
  {
    id: "brick",
    label: "Brick",
    description: "Staggered courses with mortar lines and per-brick tone.",
    params: BRICK_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const columns = read(BRICK_PARAMS, values, "columns");
      const rows = read(BRICK_PARAMS, values, "rows");
      const mortar = read(BRICK_PARAMS, values, "mortar");
      const offset = read(BRICK_PARAMS, values, "offset");
      const variation = read(BRICK_PARAMS, values, "variation");
      const seed = read(BRICK_PARAMS, values, "seed");
      return fieldFrom(width, height, (x, y) => {
        const v = ((y + 0.5) / height) * rows;
        const row = Math.floor(v);
        // Alternate courses shift, which is what makes it a wall and not a grid.
        const u = ((x + 0.5) / width) * columns + (row % 2 === 0 ? 0 : offset);
        const column = Math.floor(u);
        const withinU = u - column;
        const withinV = v - row;
        const half = mortar / 2;
        const inMortar =
          withinU < half || withinU > 1 - half || withinV < half * (columns / rows) || withinV > 1 - half * (columns / rows);
        if (inMortar) return 0;
        // Wrap the brick's identity so the tone repeats with the tile.
        const tone = hashCoords2(wrap(column, columns), wrap(row, rows), seed);
        return 1 - tone * variation;
      });
    },
  },
  {
    id: "marble",
    label: "Marble",
    description: "Turbulent veins through stone.",
    params: MARBLE_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const veins = read(MARBLE_PARAMS, values, "veins");
      const turbulence = read(MARBLE_PARAMS, values, "turbulence");
      const scale = read(MARBLE_PARAMS, values, "scale");
      const contrast = read(MARBLE_PARAMS, values, "contrast");
      const seed = read(MARBLE_PARAMS, values, "seed");
      return fieldFrom(width, height, (x, y) => {
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        const turb = tiledFractalNoise(u * scale, v * scale, scale, scale, seed, 4) - 0.5;
        // A sine of the coordinate plus noise: the sine gives banding, the noise
        // bends the bands into veins.
        const wave = Math.sin((u + turb * turbulence) * veins * Math.PI * 2);
        return applyContrast(wave * 0.5 + 0.5, contrast);
      });
    },
  },
  {
    id: "wood",
    label: "Wood grain",
    description: "Growth rings with streaked grain — planks and crates.",
    params: WOOD_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const rings = read(WOOD_PARAMS, values, "rings");
      const turbulence = read(WOOD_PARAMS, values, "turbulence");
      const grain = read(WOOD_PARAMS, values, "grain");
      const seed = read(WOOD_PARAMS, values, "seed");
      return fieldFrom(width, height, (x, y) => {
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        // Rings run along x and wrap in it, so planks butt together seamlessly.
        const turb = tiledFractalNoise(u * 4, v * 4, 4, 4, seed, 3) - 0.5;
        const ring = Math.sin((u + turb * turbulence) * rings * Math.PI * 2) * 0.5 + 0.5;
        const streak = (tiledFractalNoise(u * 2, v * 16, 2, 16, seed + 77, 2) - 0.5) * grain;
        return ring + streak;
      });
    },
  },
  {
    id: "voronoi",
    label: "Voronoi",
    description: "Scattered cells — cobblestone, cracked earth, scales.",
    params: VORONOI_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const cells = read(VORONOI_PARAMS, values, "cells");
      const jitter = read(VORONOI_PARAMS, values, "jitter");
      const drawEdges = read(VORONOI_PARAMS, values, "edges") >= 0.5;
      const seed = read(VORONOI_PARAMS, values, "seed");
      return fieldFrom(width, height, (x, y) => {
        const u = ((x + 0.5) / width) * cells;
        const v = ((y + 0.5) / height) * cells;
        const cellX = Math.floor(u);
        const cellY = Math.floor(v);

        let nearest = Infinity;
        let second = Infinity;
        let nearestId = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            // Wrapping the *identity* while keeping the unwrapped position is
            // what makes the pattern continue across the tile edge instead of
            // restarting there.
            const gx = cellX + dx;
            const gy = cellY + dy;
            const wx = wrap(gx, cells);
            const wy = wrap(gy, cells);
            const jitterX = (hashCoords2(wx, wy, seed) - 0.5) * jitter;
            const jitterY = (hashCoords2(wx, wy, seed + 991) - 0.5) * jitter;
            const distance = Math.hypot(u - (gx + 0.5 + jitterX), v - (gy + 0.5 + jitterY));
            if (distance < nearest) {
              second = nearest;
              nearest = distance;
              nearestId = wy * cells + wx;
            } else if (distance < second) {
              second = distance;
            }
          }
        }

        if (drawEdges) {
          // The gap between the two closest centres is near zero exactly on a
          // border, which draws the wall rather than the cell.
          return clamp01((second - nearest) * cells * 0.5);
        }
        return hashCoords2(nearestId % cells, Math.floor(nearestId / cells), seed + 313);
      });
    },
  },
  {
    id: "stripes",
    label: "Stripes",
    description: "Parallel bands at any angle — awnings, hazard tape, cloth.",
    params: STRIPE_PARAMS,
    tiles: true,
    generate(width, height, values) {
      const count = read(STRIPE_PARAMS, values, "count");
      const angle = (read(STRIPE_PARAMS, values, "angle") * Math.PI) / 180;
      const duty = read(STRIPE_PARAMS, values, "duty");
      const softness = read(STRIPE_PARAMS, values, "softness");
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      return fieldFrom(width, height, (x, y) => {
        const u = (x + 0.5) / width;
        const v = (y + 0.5) / height;
        const projected = (u * dirX + v * dirY) * count;
        const within = projected - Math.floor(projected);
        // Distance into the filled part of the stripe, signed at both borders.
        const distance = Math.min(within, duty - within);
        return edge(distance, softness * (duty / 2));
      });
    },
  },
];

/** Look a texture generator up by id, falling back to the first. */
export function findTextureGenerator(id: string): TextureGenerator {
  return TEXTURE_GENERATORS.find((generator) => generator.id === id) ?? TEXTURE_GENERATORS[0]!;
}

export interface RampOptions {
  /**
   * Palette indices from darkest to lightest. Explicit rather than derived
   * because the artist's idea of a ramp rarely matches sorting the palette by
   * luminance — a "ramp" is a set of shades chosen to sit together.
   */
  readonly ramp: readonly number[];
  readonly dither: DitherMode;
  /** Dither strength, 0..1. */
  readonly strength: number;
}

export const DEFAULT_RAMP_OPTIONS: RampOptions = { ramp: [], dither: "bayer4", strength: 1 };

/**
 * Ramp a texture field across a run of palette entries.
 *
 * The dither matters more here than in an image import. A ramp is typically
 * three or four shades, and a smooth field quantised onto four levels bands
 * severely; perturbing the threshold by the ordered matrix converts that banding
 * into the stippled shading pixel artists draw by hand anyway.
 *
 * `floyd` is accepted and treated as ordered noise: error diffusion needs a
 * colour error to propagate, and a scalar ramp has no colour to be wrong about.
 */
export function textureToIndices(field: TextureField, options: RampOptions = DEFAULT_RAMP_OPTIONS): IndexedImage {
  const { ramp } = options;
  const indices = new Uint8Array(field.width * field.height);
  if (ramp.length === 0) return { indices, width: field.width, height: field.height };

  const steps = ramp.length - 1;
  const strength = Math.max(0, Math.min(1, options.strength));
  const mode: DitherMode = options.dither === "floyd" ? "noise" : options.dither;

  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      const index = y * field.width + x;
      const offset = steps > 0 ? (ditherOffset(mode, x, y) * strength) / steps : 0;
      const level = Math.round(clamp01((field.values[index] ?? 0) + offset) * steps);
      indices[index] = ramp[Math.max(0, Math.min(steps, level))] ?? 0;
    }
  }
  return { indices, width: field.width, height: field.height };
}

/**
 * Terrain as a height field — the shared surface behind both the Map tab's
 * top-down terrain and the Voxel tab's extruded landscape.
 *
 * Generating the landscape once, as normalized height plus moisture, and then
 * *interpreting* it separately (into tile classes, into voxel columns) is what
 * keeps the two tabs consistent: the same seed and the same parameters describe
 * the same island whether you are painting tiles or sculpting cubes.
 *
 * Pure and DOM-free.
 */

import { fractalNoise2D } from "./noise";
import { smoothstep } from "./noise";

/** Seed offset for the moisture channel, so it varies independently of height. */
const MOISTURE_SEED_OFFSET = 0x5f3a91;

/** How much of the field's half-width the edge ramp spans at full falloff. */
const MAX_EDGE_RAMP = 0.9;

export interface HeightFieldParams {
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  /**
   * Roughly how many hills span the field's longest edge. Deriving frequency
   * from this (rather than taking a raw frequency) keeps the landscape's shape
   * stable when the field is resized — a bigger map gets more resolution, not
   * more hills.
   */
  readonly hills: number;
  /** Peak-to-trough spread of the result, 0..1. Below 1 the terrain flattens. */
  readonly relief: number;
  /** The normalized height the noise centres on, 0..1 — the "sea level" of the raw field. */
  readonly baseLevel: number;
  /**
   * How strongly heights are pulled down at the border, 0..1. At 0 the field is
   * an open landscape; at 1 it shelves off on every side into an island.
   */
  readonly edgeFalloff: number;
}

/** Sensible defaults, also the starting values the editor's controls open on. */
export const DEFAULT_HEIGHT_FIELD_PARAMS: HeightFieldParams = {
  width: 64,
  depth: 64,
  seed: 1,
  hills: 4,
  relief: 1,
  baseLevel: 0.45,
  edgeFalloff: 0.6,
};

/** A generated landscape: normalized height and moisture per column. */
export interface HeightField {
  readonly width: number;
  readonly depth: number;
  /** Normalized surface height per column, 0..1, row-major. */
  readonly heights: Float32Array;
  /** Normalized moisture per column, 0..1, row-major — drives biome choice. */
  readonly moisture: Float32Array;
}

/** Height at a column, clamped to the field's edges for out-of-bounds reads. */
export function heightAt(field: HeightField, x: number, z: number): number {
  const cx = Math.min(field.width - 1, Math.max(0, x));
  const cz = Math.min(field.depth - 1, Math.max(0, z));
  return field.heights[cz * field.width + cx]!;
}

/** Moisture at a column, clamped like {@link heightAt}. */
export function moistureAt(field: HeightField, x: number, z: number): number {
  const cx = Math.min(field.width - 1, Math.max(0, x));
  const cz = Math.min(field.depth - 1, Math.max(0, z));
  return field.moisture[cz * field.width + cx]!;
}

/**
 * An edge weight of 1 across the interior, ramping to 0 over the outer margin.
 * `falloff` of 0 disables the ramp entirely (weight 1 everywhere), so an open
 * landscape and an island come from the same code path.
 */
function edgeWeight(x: number, z: number, width: number, depth: number, falloff: number): number {
  if (falloff <= 0) return 1;
  const nx = width > 1 ? Math.abs((x / (width - 1)) * 2 - 1) : 0;
  const nz = depth > 1 ? Math.abs((z / (depth - 1)) * 2 - 1) : 0;
  const edge = Math.max(nx, nz); // 0 at the centre, 1 at the border
  const plateau = 1 - Math.min(1, falloff) * MAX_EDGE_RAMP;
  if (edge <= plateau) return 1;
  return smoothstep(Math.max(0, (1 - edge) / (1 - plateau)));
}

/**
 * Generate the landscape. Pure and deterministic: identical params always yield
 * an identical field, which is what makes a seed worth showing to the user.
 */
export function generateHeightField(params: HeightFieldParams = DEFAULT_HEIGHT_FIELD_PARAMS): HeightField {
  const { width, depth, seed, hills, relief, baseLevel, edgeFalloff } = params;
  if (!Number.isInteger(width) || !Number.isInteger(depth) || width < 1 || depth < 1) {
    throw new RangeError(`Height field dimensions must be positive integers, received ${width}x${depth}`);
  }

  // Frequency comes from the footprint so the same number of hills spans the
  // field at any resolution — raising detail refines the surface, not the shape.
  const span = Math.max(width, depth);
  const noiseScale = hills / span;

  const heights = new Float32Array(width * depth);
  const moisture = new Float32Array(width * depth);
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = z * width + x;
      const elevation = fractalNoise2D(x * noiseScale, z * noiseScale, seed);
      // Centre the noise on baseLevel so valleys dip below it into water and
      // hills rise above it…
      const surface = baseLevel + (elevation - 0.5) * relief;
      // …then scale the whole surface toward zero at the border, which is what
      // turns an open landscape into an island ringed by deep water rather than
      // one that merely flattens out at the edge.
      heights[i] = Math.min(1, Math.max(0, surface * edgeWeight(x, z, width, depth, edgeFalloff)));
      moisture[i] = fractalNoise2D(
        x * noiseScale * 1.7,
        z * noiseScale * 1.7,
        seed + MOISTURE_SEED_OFFSET,
      );
    }
  }
  return { width, depth, heights, moisture };
}

/**
 * Landscape tools (EDITOR_PRO_ROADMAP.md P2a), after Unity's Terrain Tools and
 * Unreal's Landscape mode: the passes that make sculpted ground read as
 * weathered rock rather than clay.
 *
 * - **Hydraulic erosion**: rain droplets run downhill, picking up sediment
 *   where they speed up and dropping it where they slow, carving gullies and
 *   laying fans of silt at the foot of slopes.
 * - **Thermal erosion**: where a slope is steeper than the material's angle
 *   of repose (talus), the excess slumps onto the lower neighbours, leaving
 *   scree aprons under cliffs.
 * - **Stamps**: rolling hills, sharp ridges and terraced strata pressed in
 *   under a brush.
 * - **Ramps**: a smooth incline between two points, for paths and approaches.
 * - **Heightmaps**: 16-bit greyscale PNG out and in, for World Machine,
 *   Gaea, or a DEM.
 *
 * Both erosions move ground and never make or lose it (over the whole
 * terrain), and both are deterministic: the same seed gives the same valley.
 * Every tool returns a new terrain and leaves the old one be, so each pass is
 * an undo step. Pure and DOM-free.
 */

import { brushFalloff, type TerrainBrush } from "./terrainBrush";
import { terrainHeight, type Terrain } from "./terrain";
import { decodePngSamples, encodeGray16Png } from "./png";

// --- Shared ------------------------------------------------------------------------------

/** A small, fast seeded PRNG (mulberry32): the same seed, the same sequence, everywhere. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The grid spacing along X and Z. */
const spacing = (t: Terrain): [number, number] => [t.size[0] / (t.samples - 1), t.size[1] / (t.samples - 1)];

/**
 * A brush's weight at every sample (null: the whole terrain at full weight),
 * for blending a whole-terrain pass back into just the brushed patch.
 */
function regionMask(t: Terrain, region: TerrainBrush | undefined): Float32Array | null {
  if (!region) return null;
  const n = t.samples;
  const [dx, dz] = spacing(t);
  const mask = new Float32Array(n * n);
  const strength = Math.max(0, Math.min(1, region.strength));
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) mask[j * n + i] = brushFalloff(Math.hypot(i * dx - region.x, j * dz - region.z), region.radius) * strength;
  return mask;
}

/** The result heights, blended back into the source by a region's mask. */
function finish(t: Terrain, work: Float64Array, mask: Float32Array | null): Terrain {
  const heights = new Float32Array(work.length);
  for (let k = 0; k < work.length; k += 1) heights[k] = mask ? t.heights[k]! + (work[k]! - t.heights[k]!) * mask[k]! : work[k]!;
  return { ...t, heights };
}

// --- Hydraulic erosion -------------------------------------------------------------------

export interface HydraulicErosion {
  /** Rain droplets to run (each a few dozen steps); 0..200 000. */
  readonly droplets: number;
  readonly seed: number;
  /** How much a droplet keeps its heading rather than turning downhill, 0..1 (default 0.05). */
  readonly inertia?: number;
  /** Sediment a droplet can carry per unit of speed, water and drop (default 4). */
  readonly capacity?: number;
  /** Share of spare capacity taken from the ground per step, 0..1 (default 0.3). */
  readonly erode?: number;
  /** Share of excess sediment dropped per step, 0..1 (default 0.3). */
  readonly deposit?: number;
  /** Share of water evaporating per step, 0..1 (default 0.01). */
  readonly evaporate?: number;
  /** Steps a droplet lives (default 40). */
  readonly lifetime?: number;
}

export const MAX_EROSION_DROPLETS = 200_000;

/** Height (cell units) and its gradient at a point inside the grid, bilinear. */
function sampleGrid(h: Float64Array, n: number, x: number, z: number): [number, number, number] {
  const i = Math.min(n - 2, Math.floor(x));
  const j = Math.min(n - 2, Math.floor(z));
  const u = x - i;
  const v = z - j;
  const k = j * n + i;
  const a = h[k]!, b = h[k + 1]!, c = h[k + n]!, d = h[k + n + 1]!;
  return [a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v, (b - a) * (1 - v) + (d - c) * v, (c - a) * (1 - u) + (d - b) * u];
}

/** Add `amount` (cell units, negative to take) to the four samples round a point, bilinearly. */
function spread(h: Float64Array, n: number, x: number, z: number, amount: number): void {
  const i = Math.min(n - 2, Math.floor(x));
  const j = Math.min(n - 2, Math.floor(z));
  const u = x - i;
  const v = z - j;
  const k = j * n + i;
  h[k] = h[k]! + amount * (1 - u) * (1 - v);
  h[k + 1] = h[k + 1]! + amount * u * (1 - v);
  h[k + n] = h[k + n]! + amount * (1 - u) * v;
  h[k + n + 1] = h[k + n + 1]! + amount * u * v;
}

/**
 * Rain on the terrain (Hans Beyer's droplet model, as in Sebastian Lague's
 * erosion): each droplet starts somewhere at random, runs downhill with a
 * little inertia, takes sediment while it can carry more and drops it once
 * it can't (filling any pit it runs into), and drops whatever it still
 * carries where it stops. With `region`, only the brushed patch changes.
 */
export function hydraulicErosion(t: Terrain, options: HydraulicErosion, region?: TerrainBrush): Terrain {
  const n = t.samples;
  if (n < 3) return t;
  const [dx] = spacing(t);
  const droplets = Math.max(0, Math.min(MAX_EROSION_DROPLETS, Math.floor(options.droplets)));
  const inertia = clamp01(options.inertia ?? 0.05);
  const capacity = Math.max(0, options.capacity ?? 4);
  const erode = clamp01(options.erode ?? 0.3);
  const deposit = clamp01(options.deposit ?? 0.3);
  const evaporate = clamp01(options.evaporate ?? 0.01);
  const lifetime = Math.max(1, Math.min(200, Math.floor(options.lifetime ?? 40)));
  const gravity = 4;
  const minCapacity = 0.01;
  // Work in cell units (a height of 1 is one cell's width), so the droplets
  // behave the same at every resolution and size.
  const h = new Float64Array(n * n);
  for (let k = 0; k < h.length; k += 1) h[k] = t.heights[k]! / dx;
  const rand = random(options.seed);
  // In a region, the droplets fall inside the brush.
  const [cx, cz, reach] = region ? [region.x / dx, region.z / dx, region.radius / dx] : [0, 0, 0];
  const max = n - 1 - 1e-6;
  for (let d = 0; d < droplets; d += 1) {
    let x: number, z: number;
    if (region) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * reach;
      x = Math.max(0, Math.min(max, cx + Math.cos(a) * r));
      z = Math.max(0, Math.min(max, cz + Math.sin(a) * r));
    } else {
      x = rand() * max;
      z = rand() * max;
    }
    let dirX = 0, dirZ = 0, speed = 1, water = 1, sediment = 0;
    for (let step = 0; step < lifetime; step += 1) {
      const [height, gx, gz] = sampleGrid(h, n, x, z);
      dirX = dirX * inertia - gx * (1 - inertia);
      dirZ = dirZ * inertia - gz * (1 - inertia);
      const len = Math.hypot(dirX, dirZ);
      if (len < 1e-12) break; // a flat spot: the droplet soaks in
      dirX /= len;
      dirZ /= len;
      const nx = x + dirX;
      const nz = z + dirZ;
      if (nx < 0 || nz < 0 || nx > max || nz > max) break; // running off the edge
      const drop = sampleGrid(h, n, nx, nz)[0] - height;
      const carry = Math.max(-drop * speed * water * capacity, minCapacity);
      if (sediment > carry || drop > 0) {
        // Uphill, fill the pit behind (no more than the rise); else drop some of the excess.
        const amount = drop > 0 ? Math.min(drop, sediment) : (sediment - carry) * deposit;
        sediment -= amount;
        spread(h, n, x, z, amount);
      } else {
        // Never dig deeper than the drop, or the droplet carves a hole it then fills.
        const amount = Math.min((carry - sediment) * erode, -drop);
        sediment += amount;
        spread(h, n, x, z, -amount);
      }
      speed = Math.sqrt(Math.max(0, speed * speed + drop * gravity));
      water *= 1 - evaporate;
      x = nx;
      z = nz;
    }
    // What it still carries settles where it stopped: nothing is lost.
    if (sediment > 0) spread(h, n, x, z, sediment);
  }
  for (let k = 0; k < h.length; k += 1) h[k] = h[k]! * dx;
  return finish(t, h, regionMask(t, region));
}

// --- Thermal erosion ---------------------------------------------------------------------

export interface ThermalErosion {
  /** Passes over the whole grid (1..500). */
  readonly iterations: number;
  /** The steepest slope that stands, degrees (the angle of repose; 20..60 for scree to rock). */
  readonly talus: number;
  /** Share of the excess moved per pass, 0..1 (default 0.5). */
  readonly rate?: number;
}

const NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

/**
 * Let over-steep ground slump: in each pass every sample whose drop to a
 * neighbour exceeds the talus slope sheds part of the excess onto its lower
 * neighbours, in proportion to how far each is over. Every pass reads the
 * heights as they were before it, so the result doesn't depend on order.
 */
export function thermalErosion(t: Terrain, options: ThermalErosion, region?: TerrainBrush): Terrain {
  const n = t.samples;
  if (n < 2) return t;
  const [dx, dz] = spacing(t);
  const iterations = Math.max(0, Math.min(500, Math.floor(options.iterations)));
  const tan = Math.tan((Math.max(0, Math.min(89, options.talus)) * Math.PI) / 180);
  const rate = clamp01(options.rate ?? 0.5);
  const limit = NEIGHBOURS.map(([a, b]) => tan * Math.hypot(a * dx, b * dz));
  let h: Float64Array = Float64Array.from(t.heights);
  let next: Float64Array = new Float64Array(n * n);
  const over = new Float64Array(8);
  for (let pass = 0; pass < iterations; pass += 1) {
    next.set(h);
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const k = j * n + i;
        const here = h[k]!;
        let total = 0;
        let most = 0;
        for (let q = 0; q < 8; q += 1) {
          const [a, b] = NEIGHBOURS[q]!;
          const ii = i + a, jj = j + b;
          over[q] = 0;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const excess = here - h[jj * n + ii]! - limit[q]!;
          if (excess <= 0) continue;
          over[q] = excess;
          total += excess;
          if (excess > most) most = excess;
        }
        if (total <= 0) continue;
        // Half the worst excess levels that pair; share it out by excess.
        const moved = rate * most * 0.5;
        next[k] = next[k]! - moved;
        for (let q = 0; q < 8; q += 1) {
          if (over[q]! <= 0) continue;
          const [a, b] = NEIGHBOURS[q]!;
          const kk = (j + b) * n + (i + a);
          next[kk] = next[kk]! + (moved * over[q]!) / total;
        }
      }
    }
    [h, next] = [next, h];
  }
  return finish(t, h, regionMask(t, region));
}

// --- Stamps ------------------------------------------------------------------------------

export type StampKind = "hills" | "ridges" | "terraces";

export interface Stamp {
  readonly kind: StampKind;
  /** Hills and ridges: features about this wide (world units). Default: a third of the brush. */
  readonly scale?: number;
  /** Terraces: the height of each step (world units, default 2). */
  readonly step?: number;
  /** Fixes the pattern (repeated dabs grow the same hills). */
  readonly seed?: number;
}

function cellHash(i: number, j: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, z: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(z);
  const u = x - i, v = z - j;
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = cellHash(i, j, seed), b = cellHash(i + 1, j, seed), c = cellHash(i, j + 1, seed), d = cellHash(i + 1, j + 1, seed);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

/** Fractal noise in 0..1; `ridged` folds each octave into sharp crests (1 − |2n − 1|). */
function fractal(x: number, z: number, seed: number, ridged: boolean): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < 4; o += 1) {
    const n = valueNoise(x * f, z * f, seed + o * 17);
    sum += (ridged ? (1 - Math.abs(n * 2 - 1)) ** 2 : n) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Where a height lands on a stair of `step`-high terraces: flat treads, steep risers. */
export function terraceHeight(h: number, step: number): number {
  if (!(step > 0)) return h;
  const k = Math.floor(h / step);
  const f = h / step - k;
  // The riser takes the top fifth of each step, eased; the rest is tread.
  const rise = f < 0.8 ? 0 : ((f - 0.8) / 0.2) ** 2 * (3 - 2 * ((f - 0.8) / 0.2));
  return (k + rise) * step;
}

/** How far one full-strength dab lifts hills and ridges: a fifth of the brush's radius (as sculpting does). */
const STAMP_LIFT = 0.2;

/** Press a stamp into the ground under a brush dab. */
export function stampTerrain(t: Terrain, stamp: Stamp, brush: TerrainBrush): Terrain {
  const n = t.samples;
  const [dx, dz] = spacing(t);
  const strength = clamp01(brush.strength);
  const scale = Math.max(dx * 2, stamp.scale ?? brush.radius / 3);
  const seed = stamp.seed ?? 1;
  const heights = Float32Array.from(t.heights);
  const i0 = Math.max(0, Math.floor((brush.x - brush.radius) / dx)), i1 = Math.min(n - 1, Math.ceil((brush.x + brush.radius) / dx));
  const j0 = Math.max(0, Math.floor((brush.z - brush.radius) / dz)), j1 = Math.min(n - 1, Math.ceil((brush.z + brush.radius) / dz));
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const f = brushFalloff(Math.hypot(i * dx - brush.x, j * dz - brush.z), brush.radius) * strength;
      if (f <= 0) continue;
      const k = j * n + i;
      const h = t.heights[k]!;
      if (stamp.kind === "terraces") heights[k] = h + (terraceHeight(h, stamp.step ?? 2) - h) * f;
      else heights[k] = h + fractal((i * dx) / scale, (j * dz) / scale, seed, stamp.kind === "ridges") * f * brush.radius * STAMP_LIFT;
    }
  }
  return { ...t, heights };
}

// --- Ramps -------------------------------------------------------------------------------

/**
 * A straight incline from `from` to `to` (terrain-space x and z), `width`
 * wide with soft shoulders `edge` wide either side, rising from the ground's
 * height at one end to its height at the other (or the given `heights`).
 * Rounded at both ends, so a ramp meets the ground it starts from.
 */
export function rampTerrain(
  t: Terrain,
  from: readonly [number, number],
  to: readonly [number, number],
  width: number,
  options: { readonly edge?: number; readonly strength?: number; readonly heights?: readonly [number, number] } = {},
): Terrain {
  const n = t.samples;
  const [dx, dz] = spacing(t);
  const flat = { ...t, origin: [0, 0, 0] as const, holes: undefined };
  const ha = options.heights?.[0] ?? terrainHeight(flat, from[0], from[1]) ?? 0;
  const hb = options.heights?.[1] ?? terrainHeight(flat, to[0], to[1]) ?? 0;
  const half = Math.max(0, width) / 2;
  const edge = Math.max(1e-6, options.edge ?? half);
  const strength = clamp01(options.strength ?? 1);
  const ax = to[0] - from[0], az = to[1] - from[1];
  const len2 = ax * ax + az * az;
  const heights = Float32Array.from(t.heights);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const px = i * dx - from[0], pz = j * dz - from[1];
      const s = len2 > 0 ? Math.max(0, Math.min(1, (px * ax + pz * az) / len2)) : 0;
      const d = Math.hypot(px - ax * s, pz - az * s);
      if (d >= half + edge) continue;
      const w = (d <= half ? 1 : smoothstep(1 - (d - half) / edge)) * strength;
      const k = j * n + i;
      heights[k] = t.heights[k]! + (ha + (hb - ha) * s - t.heights[k]!) * w;
    }
  }
  return { ...t, heights };
}

// --- Heightmaps --------------------------------------------------------------------------

/** The text key a Cartbox heightmap stores its height range under (so it reads back to the same heights). */
export const HEIGHTMAP_RANGE_KEY = "cartbox:height-range";

/** The terrain's heights as a 16-bit greyscale PNG over their own range, which the file also carries. */
export function exportHeightmap(t: Terrain): { readonly png: Uint8Array; readonly min: number; readonly max: number } {
  let min = Infinity, max = -Infinity;
  for (const h of t.heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  if (!(max > min)) max = min + 1;
  const n = t.samples;
  const values = new Uint16Array(n * n);
  for (let k = 0; k < values.length; k += 1) values[k] = Math.round(((t.heights[k]! - min) / (max - min)) * 65535);
  return { png: encodeGray16Png(values, n, n, { [HEIGHTMAP_RANGE_KEY]: `${min},${max}` }), min, max };
}

/**
 * Heights from a heightmap PNG (8 or 16 bits, grey or colour, taking the
 * first channel), resampled to the terrain's grid. Black is `range[0]` and
 * white `range[1]` — the file's own range when it is one of ours, else the
 * given one. Throws on a file that isn't a PNG it can read.
 */
export async function importHeightmap(t: Terrain, bytes: Uint8Array, range: readonly [number, number]): Promise<Terrain> {
  const image = await decodePngSamples(bytes);
  const stored = image.text[HEIGHTMAP_RANGE_KEY]?.split(",").map(Number);
  const [lo, hi] = stored && stored.length === 2 && stored.every(Number.isFinite) ? (stored as [number, number]) : range;
  const n = t.samples;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      // Corner to corner: the file's first and last pixels sit on the grid's edges.
      const x = n > 1 ? (i / (n - 1)) * (image.width - 1) : 0;
      const z = n > 1 ? (j / (n - 1)) * (image.height - 1) : 0;
      const x0 = Math.floor(x), z0 = Math.floor(z);
      const x1 = Math.min(image.width - 1, x0 + 1), z1 = Math.min(image.height - 1, z0 + 1);
      const u = x - x0, v = z - z0;
      const at = (a: number, b: number) => image.values[b * image.width + a]!;
      const g = at(x0, z0) * (1 - u) * (1 - v) + at(x1, z0) * u * (1 - v) + at(x0, z1) * (1 - u) * v + at(x1, z1) * u * v;
      heights[j * n + i] = lo + g * (hi - lo);
    }
  }
  return { ...t, heights };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

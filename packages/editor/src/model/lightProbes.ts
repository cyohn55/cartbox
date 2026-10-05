/**
 * Light probes (ENGINE_PARITY_ROADMAP.md EP9): a baked grid over the scene, so
 * things that move — characters, physics bodies, anything without its own
 * light map — pick up the baked bounce light and shade as they pass into a
 * dark corridor or beside a sunlit wall. The web-sized answer to Lumen.
 *
 * Each probe is an ambient cube: what a light map texel facing each of the
 * six axis directions (±X, ±Y, ±Z) would hold at that point — sky visibility
 * and one bounce of sun, in the same units (see lightmap.ts), so it scales the
 * ambient and sky fill exactly as a light map does. A surface blends the three
 * faces its normal leans toward, weighted by the normal's squared components,
 * and between probes trilinearly. The software rasteriser and both GPU
 * shaders sample it the same way, from the same numbers.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";

/** The light map's range: a stored value of 1 (byte 255) means this much of the ambient. Mirrors LIGHTMAP_RANGE. */
const RANGE = 1.5;

/** A baked probe grid, decoded: `counts` probes per axis spanning `min`–`max`, 18 numbers each (6 faces × RGB). */
export interface LightProbeGrid {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly counts: readonly [number, number, number];
  /** Probe (x, y, z) face f channel c at `((((z · ny) + y) · nx + x) · 6 + f) · 3 + c`; faces +X −X +Y −Y +Z −Z. */
  readonly values: Float32Array;
}

/** A grid as stored with the scene's lighting: its extent and counts, and the values as bytes (base64). */
export interface StoredLightProbes {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly counts: readonly [number, number, number];
  readonly data: string;
}

/** The most probes a grid holds (the spacing widens to stay under it). */
export const MAX_LIGHT_PROBES = 4096;
/** The ambient-cube face directions, in storage order. */
export const PROBE_FACES: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Probes per axis for a box at roughly `spacing` apart (at least 2 per axis, at most MAX_LIGHT_PROBES in all). */
export function planProbeGrid(min: readonly [number, number, number], max: readonly [number, number, number], spacing = 2.5): [number, number, number] {
  let s = Math.max(0.25, spacing);
  for (;;) {
    const counts = [0, 1, 2].map((a) => Math.max(2, Math.ceil((max[a]! - min[a]!) / s) + 1)) as [number, number, number];
    if (counts[0] * counts[1] * counts[2] <= MAX_LIGHT_PROBES) return counts;
    s *= 1.15;
  }
}

/** A probe's world position. */
export function probePosition(grid: Pick<LightProbeGrid, "min" | "max" | "counts">, x: number, y: number, z: number): [number, number, number] {
  const at = (a: number, i: number) => grid.min[a]! + ((grid.max[a]! - grid.min[a]!) * i) / Math.max(1, grid.counts[a]! - 1);
  return [at(0, x), at(1, y), at(2, z)];
}

/** Quantise a grid's values to what storage keeps (bytes over the light-map range), so a baked grid and a loaded one agree exactly. */
export function quantizeLightProbes(values: Float32Array): Float32Array {
  return Float32Array.from(values, (v) => (Math.min(255, Math.max(0, Math.round((v / RANGE) * 255))) / 255) * RANGE);
}

export function encodeLightProbes(grid: LightProbeGrid): StoredLightProbes {
  const bytes = Uint8Array.from(grid.values, (v) => Math.min(255, Math.max(0, Math.round((v / RANGE) * 255))));
  return { min: [...grid.min], max: [...grid.max], counts: [...grid.counts], data: bytesToBase64(bytes) };
}

const finite3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Decode a stored grid, or null when it's malformed (wrong counts for its data, bad numbers). */
export function decodeLightProbes(stored: unknown): LightProbeGrid | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Partial<StoredLightProbes>;
  if (!finite3(s.min) || !finite3(s.max) || !finite3(s.counts) || typeof s.data !== "string") return null;
  const counts = s.counts.map((c) => Math.round(c)) as [number, number, number];
  if (counts.some((c) => c < 2) || counts[0] * counts[1] * counts[2] > MAX_LIGHT_PROBES) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(s.data);
  } catch {
    return null;
  }
  if (bytes.length !== counts[0] * counts[1] * counts[2] * 18) return null;
  return { min: s.min, max: s.max, counts, values: Float32Array.from(bytes, (b) => (b / 255) * RANGE) };
}

/**
 * The ambient scale at a world point for a surface facing (nx, ny, nz):
 * the grid's trilinear blend (clamped to its box) of the three ambient-cube
 * faces the normal leans toward, each weighted by that normal component squared.
 */
export function sampleLightProbes(grid: LightProbeGrid, px: number, py: number, pz: number, nx: number, ny: number, nz: number): [number, number, number] {
  const [cx, cy, cz] = grid.counts;
  const cell = (a: number, p: number, n: number) => {
    const g = Math.min(n - 1, Math.max(0, ((p - grid.min[a]!) / (grid.max[a]! - grid.min[a]! || 1)) * (n - 1)));
    const i = Math.min(n - 2, Math.floor(g));
    return [i, g - i] as const;
  };
  const [ix, fx] = cell(0, px, cx);
  const [iy, fy] = cell(1, py, cy);
  const [iz, fz] = cell(2, pz, cz);
  const len = Math.hypot(nx, ny, nz) || 1;
  const n = [nx / len, ny / len, nz / len];
  const faces = [n[0]! >= 0 ? 0 : 1, n[1]! >= 0 ? 2 : 3, n[2]! >= 0 ? 4 : 5];
  const out: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const w = n[axis]! * n[axis]!;
    if (w === 0) continue;
    const face = faces[axis]!;
    for (let c = 0; c < 3; c += 1) {
      const v = (x: number, y: number, z: number) => grid.values[((((iz + z) * cy + (iy + y)) * cx + (ix + x)) * 6 + face) * 3 + c]!;
      const x00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * fx;
      const x10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * fx;
      const x01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * fx;
      const x11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * fx;
      const y0 = x00 + (x10 - x00) * fy;
      const y1 = x01 + (x11 - x01) * fy;
      out[c] = out[c]! + w * (y0 + (y1 - y0) * fz);
    }
  }
  return out;
}

/**
 * The grid as a 3D texture's texels (RGBA floats): width 6 · nx (face f's
 * probes in columns f · nx … f · nx + nx − 1), height ny, depth nz.
 */
export function lightProbeTexels(grid: LightProbeGrid): Float32Array {
  const [cx, cy, cz] = grid.counts;
  const out = new Float32Array(6 * cx * cy * cz * 4);
  for (let z = 0; z < cz; z += 1) {
    for (let y = 0; y < cy; y += 1) {
      for (let x = 0; x < cx; x += 1) {
        for (let f = 0; f < 6; f += 1) {
          const src = ((((z * cy + y) * cx + x) * 6 + f) * 3);
          const dst = ((z * cy + y) * (6 * cx) + f * cx + x) * 4;
          out[dst] = grid.values[src]!;
          out[dst + 1] = grid.values[src + 1]!;
          out[dst + 2] = grid.values[src + 2]!;
          out[dst + 3] = 1;
        }
      }
    }
  }
  return out;
}

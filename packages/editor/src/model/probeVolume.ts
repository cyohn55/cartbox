/**
 * Baked probe volumes (AAA_FIDELITY_ROADMAP.md F3d-3): what the GPU
 * lightmapper bakes for things that move, in place of the ambient cubes of
 * lightProbes.ts (which every other tier keeps reading, and which are derived
 * from the same bake).
 *
 * Each probe holds:
 * - **its irradiance** as L2 spherical harmonics, nine RGB coefficients
 *   already convolved with the clamped cosine and over π (as the sky's are,
 *   ibl.ts), in linear light: sky, bounced sun and sky, and emissive surfaces,
 *   over the whole sphere;
 * - **the sky's visibility**, the share of the sky's light that reaches it;
 * - **whether it is valid**: one inside geometry (most of its rays meet the
 *   backs of surfaces) is skipped;
 * - **what it can see** (DDGI's visibility, Majercik et al. 2019): the mean
 *   distance its rays travelled, and the mean of its square, in each of 8 × 8
 *   octahedral directions. A point the probe can't see (behind a wall from it)
 *   takes little of its light, by Chebyshev's inequality, so light doesn't
 *   leak through walls between probes.
 *
 * A surface blends the eight probes round it, each weighed trilinearly, by
 * whether it faces the probe, and by that visibility. Stored as half floats.
 * Pure and DOM-free.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";
import { MAX_LIGHT_PROBES, type LightProbeGrid } from "./lightProbes";

/** SH coefficients per probe, octahedral depth texels per side, and the volume texture's texels per probe (9 SH, 32 depth pairs). */
export const PROBE_SH = 9;
export const PROBE_DEPTH_SIDE = 8;
export const PROBE_VOLUME_SLOTS = PROBE_SH + (PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE) / 2;
/** Probes per axis at most: a 3D texture's width (2048) over its slots. */
export const MAX_PROBE_VOLUME_AXIS = Math.floor(2048 / PROBE_VOLUME_SLOTS);
/** Halves per probe as stored: 27 SH, visibility, validity, 128 depth moments. */
const STORED_HALVES = PROBE_SH * 3 + 2 + PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE * 2;

export interface ProbeVolume {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly counts: readonly [number, number, number];
  /** Per probe (x fastest, then y, then z): 9 coefficients × RGB. */
  readonly sh: Float32Array;
  /** Per probe: the sky's visibility, 0..1. */
  readonly visibility: Float32Array;
  /** Per probe: 1 valid, 0 inside geometry. */
  readonly valid: Uint8Array;
  /** Per probe, per octahedral texel (row by row): the mean distance and the mean squared distance. */
  readonly depth: Float32Array;
}

export interface StoredProbeVolume {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly counts: readonly [number, number, number];
  /** Base64 of every probe's halves in turn (see {@link encodeProbeVolume}). */
  readonly data: string;
}

/** Probes per axis for a box at roughly `spacing` apart: at least 2, at most {@link MAX_PROBE_VOLUME_AXIS} per axis and MAX_LIGHT_PROBES in all. */
export function planProbeVolume(min: readonly [number, number, number], max: readonly [number, number, number], spacing = 2.5): [number, number, number] {
  let s = Math.max(0.25, spacing);
  for (;;) {
    const counts = [0, 1, 2].map((a) => Math.max(2, Math.ceil((max[a]! - min[a]!) / s) + 1)) as [number, number, number];
    if (counts[0] * counts[1] * counts[2] <= MAX_LIGHT_PROBES && counts.every((c) => c <= MAX_PROBE_VOLUME_AXIS)) return counts;
    s *= 1.15;
  }
}

/** The nine real SH basis functions at a unit direction (ibl.ts's order). */
export function shBasis(x: number, y: number, z: number): number[] {
  return [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
}

/** A probe's SH irradiance (over π) along a unit normal, clamped at 0. */
export function probeIrradiance(volume: ProbeVolume, probe: number, n: readonly [number, number, number]): [number, number, number] {
  const basis = shBasis(n[0], n[1], n[2]);
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < PROBE_SH; k += 1) for (let c = 0; c < 3; c += 1) out[c] = out[c]! + volume.sh[(probe * PROBE_SH + k) * 3 + c]! * basis[k]!;
  return [Math.max(0, out[0]), Math.max(0, out[1]), Math.max(0, out[2])];
}

/** A unit direction's octahedral coordinates, 0..1 each (the shader's `octEncode`). */
export function octEncode(d: readonly [number, number, number]): [number, number] {
  const l1 = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) || 1;
  let u = d[0] / l1, v = d[2] / l1;
  if (d[1] < 0) {
    const pu = u;
    u = (1 - Math.abs(v)) * (pu >= 0 ? 1 : -1);
    v = (1 - Math.abs(pu)) * (v >= 0 ? 1 : -1);
  }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}

/** The octahedral depth texel a direction falls in. */
export function octTexel(d: readonly [number, number, number]): number {
  const [u, v] = octEncode(d);
  const x = Math.min(PROBE_DEPTH_SIDE - 1, Math.floor(u * PROBE_DEPTH_SIDE));
  const y = Math.min(PROBE_DEPTH_SIDE - 1, Math.floor(v * PROBE_DEPTH_SIDE));
  return y * PROBE_DEPTH_SIDE + x;
}

/** The floor of a depth texel's variance (m²), and the share of the probe spacing a shaded point is pushed out along its normal. */
const VARIANCE_FLOOR = 1e-4;
export const PROBE_NORMAL_BIAS = 0.3;

/**
 * The irradiance (over π) and sky visibility the volume gives a point with
 * normal `n`: the eight probes round it (the point pushed out along its
 * normal a little first), each weighed trilinearly, by a wrapped cosine
 * toward it, and by Chebyshev's bound on the probe seeing the point. Null
 * when none of them is valid or can see it. The AAA shader's `probeVolumeAt`
 * mirrors it.
 */
export function sampleProbeVolume(volume: ProbeVolume, p: readonly [number, number, number], n: readonly [number, number, number]): [number, number, number, number] | null {
  const [cx, cy, cz] = volume.counts;
  const spacing = [0, 1, 2].map((a) => (volume.max[a]! - volume.min[a]!) / Math.max(1, volume.counts[a]! - 1) || 1);
  const bias = PROBE_NORMAL_BIAS * Math.min(...spacing);
  const pb = [p[0] + n[0] * bias, p[1] + n[1] * bias, p[2] + n[2] * bias];
  const cell = (a: number, c: number) => {
    const g = Math.min(c - 1, Math.max(0, (pb[a]! - volume.min[a]!) / spacing[a]!));
    const i = Math.min(c - 2, Math.floor(g));
    return [i, g - i] as const;
  };
  const [ix, fx] = cell(0, cx);
  const [iy, fy] = cell(1, cy);
  const [iz, fz] = cell(2, cz);
  let r = 0, g = 0, b = 0, vis = 0, sum = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const ox = corner & 1, oy = (corner >> 1) & 1, oz = (corner >> 2) & 1;
    const probe = ((iz + oz) * cy + (iy + oy)) * cx + (ix + ox);
    if (!volume.valid[probe]) continue;
    const trilinear = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
    const at = [volume.min[0] + (ix + ox) * spacing[0]!, volume.min[1] + (iy + oy) * spacing[1]!, volume.min[2] + (iz + oz) * spacing[2]!];
    const to = [at[0]! - p[0], at[1]! - p[1], at[2]! - p[2]];
    const tl = Math.hypot(to[0]!, to[1]!, to[2]!) || 1;
    const wrap = ((to[0]! * n[0] + to[1]! * n[1] + to[2]! * n[2]) / tl + 1) * 0.5;
    let w = wrap * wrap + 0.2;
    const off: [number, number, number] = [pb[0]! - at[0]!, pb[1]! - at[1]!, pb[2]! - at[2]!];
    const dist = Math.hypot(...off);
    if (dist > 1e-4) {
      const k = octTexel([off[0] / dist, off[1] / dist, off[2] / dist]);
      const mean = volume.depth[(probe * PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE + k) * 2]!;
      const sq = volume.depth[(probe * PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE + k) * 2 + 1]!;
      if (dist > mean) {
        const variance = Math.max(sq - mean * mean, VARIANCE_FLOOR);
        const cheb = variance / (variance + (dist - mean) ** 2);
        w *= cheb * cheb * cheb;
      }
    }
    w *= trilinear;
    if (w <= 1e-6) continue;
    const e = probeIrradiance(volume, probe, n);
    r += e[0] * w;
    g += e[1] * w;
    b += e[2] * w;
    vis += volume.visibility[probe]! * w;
    sum += w;
  }
  return sum > 1e-6 ? [r / sum, g / sum, b / sum, vis / sum] : null;
}

/**
 * The volume as its 3D texture's texels (RGBA floats): width
 * {@link PROBE_VOLUME_SLOTS} · nx (slot s's probes in columns s · nx …), height
 * ny, depth nz. Slots 0–8 are the SH coefficients (slot 0's alpha the
 * validity, slot 1's the visibility); slots 9–40 two depth texels each.
 */
export function probeVolumeTexels(volume: ProbeVolume): Float32Array {
  const [cx, cy, cz] = volume.counts;
  const width = PROBE_VOLUME_SLOTS * cx;
  const out = new Float32Array(width * cy * cz * 4);
  const depthTexels = PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE;
  for (let z = 0; z < cz; z += 1) {
    for (let y = 0; y < cy; y += 1) {
      for (let x = 0; x < cx; x += 1) {
        const probe = (z * cy + y) * cx + x;
        const at = (slot: number) => ((z * cy + y) * width + slot * cx + x) * 4;
        for (let k = 0; k < PROBE_SH; k += 1) {
          out.set(volume.sh.subarray((probe * PROBE_SH + k) * 3, (probe * PROBE_SH + k) * 3 + 3), at(k));
          out[at(k) + 3] = k === 0 ? volume.valid[probe]! : k === 1 ? volume.visibility[probe]! : 0;
        }
        for (let t = 0; t < depthTexels / 2; t += 1) out.set(volume.depth.subarray((probe * depthTexels + t * 2) * 2, (probe * depthTexels + t * 2) * 2 + 4), at(PROBE_SH + t));
      }
    }
  }
  return out;
}

/**
 * The ambient cubes every other tier reads (lightProbes.ts), from the same
 * bake: each face the probe's irradiance along it over the open sky's
 * (`sky`, the environment's SH irradiance), per channel, as a light map's
 * ambient scale is. An invalid probe takes its valid neighbours' mean.
 */
export function ambientCubesFromVolume(volume: ProbeVolume, sky: (n: readonly [number, number, number]) => readonly [number, number, number], range: number): LightProbeGrid {
  const [cx, cy, cz] = volume.counts;
  const count = cx * cy * cz;
  const faces: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const open = faces.map((f) => sky(f));
  const values = new Float32Array(count * 18);
  const filled = new Uint8Array(count);
  for (let probe = 0; probe < count; probe += 1) {
    if (!volume.valid[probe]) continue;
    filled[probe] = 1;
    faces.forEach((f, i) => {
      const e = probeIrradiance(volume, probe, f);
      for (let c = 0; c < 3; c += 1) values[(probe * 6 + i) * 3 + c] = open[i]![c]! > 1e-6 ? Math.min(range, e[c]! / open[i]![c]!) : 1;
    });
  }
  // Invalid probes from their valid neighbours, outward until all are filled (all open sky if none is valid).
  if (!filled.some(Boolean)) values.fill(1);
  for (let pass = 0; pass < cx + cy + cz && filled.some((f) => !f) && filled.some(Boolean); pass += 1) {
    const next = filled.slice();
    for (let z = 0; z < cz; z += 1) for (let y = 0; y < cy; y += 1) for (let x = 0; x < cx; x += 1) {
      const probe = (z * cy + y) * cx + x;
      if (filled[probe]) continue;
      const near = [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]]
        .filter(([a, b, c]) => a! >= 0 && b! >= 0 && c! >= 0 && a! < cx && b! < cy && c! < cz)
        .map(([a, b, c]) => (c! * cy + b!) * cx + a!)
        .filter((q) => filled[q]);
      if (near.length === 0) continue;
      for (let k = 0; k < 18; k += 1) values[probe * 18 + k] = near.reduce((s, q) => s + values[q * 18 + k]!, 0) / near.length;
      next[probe] = 1;
    }
    filled.set(next);
  }
  return { min: volume.min, max: volume.max, counts: volume.counts, values };
}

// --- Storage ------------------------------------------------------------------

function toHalf(value: number): number {
  const f = new Float32Array([value]);
  const bits = new Uint32Array(f.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7bff;
  // Rounded to nearest, so a stored value is within half a step.
  const rounded = (exponent << 10) | (mantissa >>> 13);
  return sign | Math.min(0x7bff, rounded + ((mantissa >>> 12) & 1));
}
function fromHalf(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

/** Store a volume as half floats: per probe its 27 SH values, visibility, validity and 128 depth moments. */
export function encodeProbeVolume(volume: ProbeVolume): StoredProbeVolume {
  const [cx, cy, cz] = volume.counts;
  const count = cx * cy * cz;
  const halves = new Uint16Array(count * STORED_HALVES);
  const depthFloats = PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE * 2;
  for (let p = 0; p < count; p += 1) {
    const o = p * STORED_HALVES;
    for (let k = 0; k < PROBE_SH * 3; k += 1) halves[o + k] = toHalf(volume.sh[p * PROBE_SH * 3 + k]!);
    halves[o + 27] = toHalf(volume.visibility[p]!);
    halves[o + 28] = toHalf(volume.valid[p]!);
    for (let k = 0; k < depthFloats; k += 1) halves[o + 29 + k] = toHalf(volume.depth[p * depthFloats + k]!);
  }
  return { min: [...volume.min], max: [...volume.max], counts: [...volume.counts], data: bytesToBase64(new Uint8Array(halves.buffer)) };
}

const finite3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Decode a stored volume, or null when it's malformed. */
export function decodeProbeVolume(stored: unknown): ProbeVolume | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Partial<StoredProbeVolume>;
  if (!finite3(s.min) || !finite3(s.max) || !finite3(s.counts) || typeof s.data !== "string") return null;
  const counts = s.counts.map((c) => Math.round(c)) as [number, number, number];
  if (counts.some((c) => c < 2 || c > MAX_PROBE_VOLUME_AXIS) || counts[0] * counts[1] * counts[2] > MAX_LIGHT_PROBES) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(s.data);
  } catch {
    return null;
  }
  const count = counts[0] * counts[1] * counts[2];
  if (bytes.length !== count * STORED_HALVES * 2) return null;
  const halves = new Uint16Array(bytes.slice().buffer);
  const depthFloats = PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE * 2;
  const sh = new Float32Array(count * PROBE_SH * 3);
  const visibility = new Float32Array(count);
  const valid = new Uint8Array(count);
  const depth = new Float32Array(count * depthFloats);
  for (let p = 0; p < count; p += 1) {
    const o = p * STORED_HALVES;
    for (let k = 0; k < PROBE_SH * 3; k += 1) sh[p * PROBE_SH * 3 + k] = fromHalf(halves[o + k]!);
    visibility[p] = fromHalf(halves[o + 27]!);
    valid[p] = fromHalf(halves[o + 28]!) > 0.5 ? 1 : 0;
    for (let k = 0; k < depthFloats; k += 1) depth[p * depthFloats + k] = fromHalf(halves[o + 29 + k]!);
  }
  return { min: s.min, max: s.max, counts, sh, visibility, valid, depth };
}

/**
 * A volume of probes that have seen nothing yet (F3e): no light, valid, open
 * to the sky, and seeing as far as `reach` every way. A live volume starts
 * from it where the rig has no bake to start from.
 */
export function emptyProbeVolume(min: readonly [number, number, number], max: readonly [number, number, number], counts: readonly [number, number, number], reach: number): ProbeVolume {
  const count = counts[0] * counts[1] * counts[2];
  const depthTexels = PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE;
  const depth = new Float32Array(count * depthTexels * 2);
  for (let i = 0; i < count * depthTexels; i += 1) depth.set([reach, reach * reach], i * 2);
  return { min, max, counts, sh: new Float32Array(count * PROBE_SH * 3), visibility: new Float32Array(count).fill(1), valid: new Uint8Array(count).fill(1), depth };
}

/**
 * Deterministic noise and pseudo-randomness — the numeric floor every procedural
 * generator stands on.
 *
 * Everything here is a pure function of its arguments and a seed: no global
 * state, no `Math.random`, no call-order dependence. That is what lets a
 * generated map be reproduced exactly from the seed shown in the editor, lets a
 * generator sample terrain height, moisture and scatter independently, and lets
 * the unit tests assert determinism rather than eyeball output.
 *
 * Pure and DOM-free, like the rest of the model layer.
 *
 * Note: apps/web's voxelWorldSpecs.ts carries its own copy of the 2D hash and
 * fractal noise. That is deliberate, not drift — it is kept free of this package
 * so it loads under the bare node TS hook without pulling in the WASM engine
 * barrel. The two implementations are identical and must stay that way.
 */

/** Octave count every fractal helper defaults to: enough for hills-with-bumps. */
export const DEFAULT_OCTAVES = 4;

/** Per-octave seed stride, so successive octaves sample independent lattices. */
const OCTAVE_SEED_STRIDE = 1013;

/**
 * A stable hash of two integer lattice coordinates to a float in [0, 1). Because
 * it depends only on position and the seed, every sample is reproducible and
 * independent of the order callers ask for them in.
 */
export function hashCoords2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The three-dimensional counterpart of {@link hashCoords2}. */
export function hashCoords3(x: number, y: number, z: number, seed: number): number {
  const mixed = Math.imul(z | 0, 0x68bc21eb) ^ (seed | 0);
  return hashCoords2(x, y, mixed);
}

/** Smoothstep easing, so interpolated noise has no lattice-aligned creases. */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1): a smoothly interpolated lattice of {@link hashCoords2}. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const c00 = hashCoords2(x0, y0, seed);
  const c10 = hashCoords2(x0 + 1, y0, seed);
  const c01 = hashCoords2(x0, y0 + 1, seed);
  const c11 = hashCoords2(x0 + 1, y0 + 1, seed);
  const top = c00 + (c10 - c00) * tx;
  const bottom = c01 + (c11 - c01) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Fractal (multi-octave) value noise in [0, 1]: successively finer, weaker
 * octaves add hills-with-bumps detail rather than a single smooth swell.
 */
export function fractalNoise2D(x: number, y: number, seed: number, octaves = DEFAULT_OCTAVES): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise2D(x * frequency, y * frequency, seed + octave * OCTAVE_SEED_STRIDE) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/** Trilinearly interpolated value noise in [0, 1) — the 3D form used by cave fields. */
export function valueNoise3D(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const tz = smoothstep(z - z0);

  // Interpolate the two z-planes with the same bilinear weights, then blend.
  const plane = (zc: number): number => {
    const c00 = hashCoords3(x0, y0, zc, seed);
    const c10 = hashCoords3(x0 + 1, y0, zc, seed);
    const c01 = hashCoords3(x0, y0 + 1, zc, seed);
    const c11 = hashCoords3(x0 + 1, y0 + 1, zc, seed);
    const top = c00 + (c10 - c00) * tx;
    const bottom = c01 + (c11 - c01) * tx;
    return top + (bottom - top) * ty;
  };
  const near = plane(z0);
  const far = plane(z0 + 1);
  return near + (far - near) * tz;
}

/** Fractal 3D value noise in [0, 1], the volumetric analogue of {@link fractalNoise2D}. */
export function fractalNoise3D(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves = DEFAULT_OCTAVES,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum +=
      valueNoise3D(x * frequency, y * frequency, z * frequency, seed + octave * OCTAVE_SEED_STRIDE) *
      amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/** A seeded pseudo-random source: successive calls return floats in [0, 1). */
export type RandomSource = () => number;

/**
 * A small, fast, well-distributed seeded generator (mulberry32). Sequential
 * generators — maze carving, room placement, scatter — need a *stream* rather
 * than positional noise, and this gives them one that replays identically for a
 * given seed on every platform.
 */
export function createRandom(seed: number): RandomSource {
  let state = (seed | 0) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random integer in `[min, max]`, inclusive of both ends. */
export function randomInt(random: RandomSource, min: number, max: number): number {
  if (max < min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

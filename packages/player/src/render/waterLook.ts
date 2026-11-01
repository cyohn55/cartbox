/**
 * Water on the AAA tier (AAA_FIDELITY_ROADMAP.md F5d): the frame's water body
 * and its grids, packed into the frame's uniforms, and the WGSL the
 * linear-light scene shader reads them with, mirroring water.ts in
 * @cartbox/editor.
 *
 * The scene shader already binds every sampled texture a stage gets, so the
 * FFT ocean's slopes (64², two halves a point) and the ripples' heights (64²)
 * ride in the frame's uniform buffer as half floats, filtered by hand, as the
 * aerial perspective's froxels do (F5a-2).
 */

import { OCEAN_PATCH, OCEAN_SIZE, RIPPLE_CELL, RIPPLE_SIZE } from "@cartbox/editor";

/** The water body a frame lights by (its first water surface's), or none. */
export interface WaterFrame {
  /** Its surface's height, and its extent in x and z (min x, min z, max x, max z). */
  readonly plane: number;
  readonly bounds: readonly [number, number, number, number];
  /** Its absorption and scattering per metre. */
  readonly absorption: readonly [number, number, number];
  readonly scattering: readonly [number, number, number];
  /** The light that reaches into it (sun and sky), for its in-scattering and its fog under water. */
  readonly light: readonly [number, number, number];
  /** Whether the eye is under it. */
  readonly underwater: boolean;
  /** The FFT ocean's slopes ({@link Ocean.slopes}), or null without an ocean surface. */
  readonly ocean: Float32Array | null;
  /** The ripples' heights and their grid's corner cell, or null while the water is still. */
  readonly ripples: { readonly heights: Float32Array; readonly origin: readonly [number, number] } | null;
  readonly time: number;
}

/** vec4s of the water's terms ahead of its grids. */
const TERMS = 6;
/** The grids: the ocean's slopes (two halves a point), then the ripples' heights. */
export const OCEAN_WORDS = OCEAN_SIZE * OCEAN_SIZE; // u32s: one point's two slopes each
export const RIPPLE_WORDS = (RIPPLE_SIZE * RIPPLE_SIZE) / 2;
/** The water's floats in the frame's uniforms (terms, then the grids as u32 words). */
export const WATER_FRAME_FLOATS = TERMS * 4 + OCEAN_WORDS + RIPPLE_WORDS;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** A number as a half float's bits (round to nearest, saturating). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7bff;
  const half = sign | (e << 10) | (m >>> 13);
  return (m & 0x1000) !== 0 ? half + 1 : half;
}

/** The water's terms and grids, packed (the frame's uniforms take them as floats, the grids' words bit for bit). */
export function packWaterFrame(water: WaterFrame | null, out = new Float32Array(WATER_FRAME_FLOATS)): Float32Array {
  out.fill(0);
  if (!water) return out;
  const words = new Uint32Array(out.buffer, out.byteOffset, out.length);
  out.set([water.plane, water.underwater ? 1 : 0, water.time % 600, 1], 0);
  out.set(water.bounds, 4);
  out.set([...water.absorption, water.ocean ? 1 : 0], 8);
  out.set([...water.scattering, water.ripples ? 1 : 0], 12);
  out.set([...water.light, OCEAN_PATCH], 16);
  out.set([water.ripples ? water.ripples.origin[0] : 0, water.ripples ? water.ripples.origin[1] : 0, RIPPLE_CELL, 0], 20);
  const base = TERMS * 4;
  if (water.ocean) {
    for (let p = 0; p < OCEAN_SIZE * OCEAN_SIZE; p += 1) words[base + p] = (toHalf(water.ocean[p * 2]!) | (toHalf(water.ocean[p * 2 + 1]!) << 16)) >>> 0;
  }
  if (water.ripples) {
    const h = water.ripples.heights;
    for (let p = 0; p < RIPPLE_WORDS; p += 1) words[base + OCEAN_WORDS + p] = (toHalf(h[p * 2]!) | (toHalf(h[p * 2 + 1]!) << 16)) >>> 0;
  }
  return out;
}

/** The WGSL struct fields the frame gains (after the weather's). */
export const WATER_FRAME_WGSL_FIELDS = /* wgsl */ `
  water0: vec4<f32>,          // F5d: the water plane's height, 1 under water, the seconds, 1 with a water body
  waterBounds: vec4<f32>,     // F5d: its extent: min x, min z, max x, max z
  water1: vec4<f32>,          // F5d: absorption per metre, w = 1 with an ocean
  water2: vec4<f32>,          // F5d: scattering per metre, w = 1 with ripples
  water3: vec4<f32>,          // F5d: the light reaching into it, w = the ocean's patch (m)
  water4: vec4<f32>,          // F5d: the ripples' corner cell (x, z), the cell (m)
  waterGrid: array<vec4<u32>, ${(OCEAN_WORDS + RIPPLE_WORDS) / 4}>, // F5d: the ocean's slopes, then the ripples' heights, half floats`;

/** The WGSL that reads them (after the frame's declaration). */
export const WATER_WGSL = /* wgsl */ `
fn waterWord(i: u32) -> u32 { return frame.waterGrid[i / 4u][i % 4u]; }
fn oceanAt(i: i32, j: i32) -> vec2<f32> {
  let n = ${OCEAN_SIZE};
  let ii = ((i % n) + n) % n;
  let jj = ((j % n) + n) % n;
  return unpack2x16float(waterWord(u32(jj * n + ii)));
}
// The FFT ocean's slope at world (x, z), bilinear and tiled (mirrors sampleSlopes).
fn oceanSlope(x: f32, z: f32) -> vec2<f32> {
  let gx = x / frame.water3.w * ${OCEAN_SIZE}.0 - 0.5;
  let gz = z / frame.water3.w * ${OCEAN_SIZE}.0 - 0.5;
  let ix = i32(floor(gx));
  let iz = i32(floor(gz));
  let fx = gx - floor(gx);
  let fz = gz - floor(gz);
  return mix(mix(oceanAt(ix, iz), oceanAt(ix + 1, iz), fx), mix(oceanAt(ix, iz + 1), oceanAt(ix + 1, iz + 1), fx), fz);
}
fn rippleAt(i: i32, j: i32) -> f32 {
  if (i < 0 || j < 0 || i >= ${RIPPLE_SIZE} || j >= ${RIPPLE_SIZE}) { return 0.0; }
  let k = u32(j * ${RIPPLE_SIZE} + i);
  let w = unpack2x16float(waterWord(${OCEAN_WORDS}u + k / 2u));
  return select(w.x, w.y, (k & 1u) == 1u);
}
fn rippleCellSlope(i: i32, j: i32) -> vec2<f32> {
  let c = frame.water4.z;
  return vec2<f32>((rippleAt(i + 1, j) - rippleAt(i - 1, j)) / (2.0 * c), (rippleAt(i, j + 1) - rippleAt(i, j - 1)) / (2.0 * c));
}
// The ripples' slope at world (x, z) (mirrors RippleField.slope); flat outside the grid.
fn rippleSlope(x: f32, z: f32) -> vec2<f32> {
  if (frame.water2.w < 0.5) { return vec2<f32>(0.0); }
  let gx = x / frame.water4.z - frame.water4.x - 0.5;
  let gz = z / frame.water4.z - frame.water4.y - 0.5;
  let ix = i32(floor(gx));
  let iz = i32(floor(gz));
  let fx = gx - floor(gx);
  let fz = gz - floor(gz);
  return mix(mix(rippleCellSlope(ix, iz), rippleCellSlope(ix + 1, iz), fx), mix(rippleCellSlope(ix, iz + 1), rippleCellSlope(ix + 1, iz + 1), fx), fz);
}
// The four Gerstner waves along the flow (mirrors gerstnerSlope).
fn gerstnerSlope(x: f32, z: f32, time: f32, height: f32, flow: f32) -> vec2<f32> {
  if (height <= 0.0) { return vec2<f32>(0.0); }
  var s = vec2<f32>(0.0);
  let waves = array<vec3<f32>, 4>(vec3<f32>(0.45, 6.0, 0.0), vec3<f32>(0.25, 3.1, 0.6), vec3<f32>(0.18, 1.7, -0.9), vec3<f32>(0.12, 0.9, 1.7));
  for (var i = 0; i < 4; i = i + 1) {
    let w = waves[i];
    let k = 6.28318531 / w.y;
    let omega = sqrt(9.81 * k);
    let d = vec2<f32>(cos(flow + w.z), sin(flow + w.z));
    let a = height * w.x / 2.0;
    let phase = k * (d.x * x + d.y * z) - omega * time;
    s = s + a * k * cos(phase) * d;
  }
  return s;
}
fn waterHash(x: f32, y: f32) -> f32 {
  var h = (bitcast<u32>(i32(x)) * 0x8da6b343u) ^ (bitcast<u32>(i32(y)) * 0xd8163841u) ^ 0x5bd1e995u;
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}
fn waterNoise(x: f32, y: f32) -> f32 {
  let ix = floor(x);
  let iy = floor(y);
  let fx = x - ix;
  let fy = y - iy;
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  return mix(mix(waterHash(ix, iy), waterHash(ix + 1.0, iy), sx), mix(waterHash(ix, iy + 1.0), waterHash(ix + 1.0, iy + 1.0), sx), sy);
}
// Foam over this much water (mirrors shoreFoam).
fn shoreFoam(metres: f32, x: f32, z: f32, time: f32, foam: f32) -> f32 {
  if (foam <= 0.0) { return 0.0; }
  let edge = 1.0 - smoothstep(0.0, 0.5 * foam + 0.05, metres);
  if (edge <= 0.0) { return 0.0; }
  let n = waterNoise(x * 3.0 + time * 0.3, z * 3.0 - time * 0.2) * 0.6 + waterNoise(x * 7.0 - time * 0.5, z * 7.0) * 0.4;
  return clamp(edge * smoothstep(0.35, 0.65, n + edge * 0.4) * foam, 0.0, 1.0);
}
// What is seen through this much water (mirrors throughWater).
fn throughWater(behind: vec3<f32>, metres: f32) -> vec3<f32> {
  let ext = max(frame.water1.rgb + frame.water2.rgb, vec3<f32>(1e-6));
  let t = exp(-ext * max(0.0, metres));
  return behind * t + frame.water2.rgb / ext * (vec3<f32>(1.0) - t) * frame.water3.rgb;
}
// The sun focused through the waves onto a point this deep (mirrors caustics).
fn caustics(x: f32, z: f32, time: f32, depth: f32) -> f32 {
  if (depth <= 0.0) { return 1.0; }
  let a = 1.0 - abs(waterNoise(x * 1.7 + time * 0.35, z * 1.7 - time * 0.35 * 0.7) * 2.0 - 1.0);
  let b = 1.0 - abs(waterNoise(x * 2.3 + 5.3 - time * 0.28, z * 2.3 + 1.9 + time * 0.28 * 0.7) * 2.0 - 1.0);
  let sharp = pow(a * b, 4.0) * 4.5;
  return 1.0 + (sharp - 0.55) * exp(-depth * 0.35);
}
// Whether world point p lies in the water body's extent, and how deep under its plane (0 above it).
fn underPlane(p: vec3<f32>) -> f32 {
  if (frame.water0.w < 0.5) { return 0.0; }
  let b = frame.waterBounds;
  if (p.x < b.x || p.z < b.y || p.x > b.z || p.z > b.w) { return 0.0; }
  return max(0.0, frame.water0.x - p.y);
}
`;

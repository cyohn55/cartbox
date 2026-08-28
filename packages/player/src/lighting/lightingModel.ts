/**
 * The Cartbox lighting model, in pure TypeScript — DOM-free and side-effect
 * free so it can be unit-tested and reused on the server. It is the exact model
 * the editor authors against (packages/editor/src/model/normals.ts and
 * lighting.ts): a per-pixel normal chosen from 16 directions, shaded by Lambert
 * diffuse lifted over an ambient floor. The runtime {@link LightingLayer} runs
 * the same maths in a shader; keeping this here lets both agree by construction.
 */

import type { Light, LightKind } from "./types.js";

/** A 3-component vector. */
export type Vec3 = readonly [number, number, number];

/** An RGB colour, each channel 0..255. */
export type Rgb = readonly [number, number, number];

/** A pixel stores one of this many normal-direction indices (4 bits). */
export const NORMAL_DIRECTION_COUNT = 16;

/** How far the eight compass directions tilt away from facing the camera. */
const COMPASS_TILT = 0.55;

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/**
 * The 16 unit normals. Index 0 faces the camera; indices 1..8 are the eight
 * compass directions tilted outward; 9..15 are spare and fall back to flat.
 * Screen space has y pointing down, matching the framebuffer.
 */
function buildNormalVectors(): Vec3[] {
  const compassOffsets: ReadonlyArray<readonly [number, number]> = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  const directions: Vec3[] = [[0, 0, 1]];
  for (const [offsetX, offsetY] of compassOffsets) {
    const x = offsetX * COMPASS_TILT;
    const y = offsetY * COMPASS_TILT;
    const z = Math.sqrt(Math.max(0.0001, 1 - x * x - y * y));
    directions.push(normalize([x, y, z]));
  }
  while (directions.length < NORMAL_DIRECTION_COUNT) directions.push([0, 0, 1]);
  return directions;
}

export const NORMAL_VECTORS: readonly Vec3[] = buildNormalVectors();

/** The unit surface normal for a direction index (flat when out of range). */
export function normalVector(direction: number): Vec3 {
  return NORMAL_VECTORS[direction] ?? NORMAL_VECTORS[0]!;
}

/** The direction index whose stored normal is closest to an arbitrary vector. */
export function nearestDirection(vector: Vec3): number {
  const target = normalize(vector);
  let best = 0;
  let bestDot = -Infinity;
  for (let index = 0; index < NORMAL_VECTORS.length; index += 1) {
    const [nx, ny, nz] = NORMAL_VECTORS[index]!;
    const dot = nx * target[0] + ny * target[1] + nz * target[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  }
  return best;
}

/**
 * Bilinearly blend four corner normals — decoded unit *vectors*, never the
 * direction indices — by fractional weights and renormalise. Interpolating the
 * vectors is the whole point: the 16 stored directions are an unordered palette,
 * so blending their indices would be meaningless, but blending the vectors they
 * decode to turns the quantised, facet-banded field into a smooth one. This is
 * cinematic gap #2 — the fix for the Mach banding that betrays the 16-direction
 * normals on any curved surface. The shaders (WebGL + WebGPU) run this exact
 * blend per fragment from four material-texel lookups; keeping it here lets a
 * test pin the behaviour the GLSL only shows on a GPU.
 *
 * @param corner00 Normal at the top-left texel.
 * @param corner10 Normal at the top-right texel.
 * @param corner01 Normal at the bottom-left texel.
 * @param corner11 Normal at the bottom-right texel.
 * @param fractionX Horizontal blend weight, 0 (left) .. 1 (right).
 * @param fractionY Vertical blend weight, 0 (top) .. 1 (bottom).
 */
export function interpolateNormal(
  corner00: Vec3,
  corner10: Vec3,
  corner01: Vec3,
  corner11: Vec3,
  fractionX: number,
  fractionY: number,
): Vec3 {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const top: Vec3 = [
    lerp(corner00[0], corner10[0], fractionX),
    lerp(corner00[1], corner10[1], fractionX),
    lerp(corner00[2], corner10[2], fractionX),
  ];
  const bottom: Vec3 = [
    lerp(corner01[0], corner11[0], fractionX),
    lerp(corner01[1], corner11[1], fractionX),
    lerp(corner01[2], corner11[2], fractionX),
  ];
  return normalize([
    lerp(top[0], bottom[0], fractionY),
    lerp(top[1], bottom[1], fractionY),
    lerp(top[2], bottom[2], fractionY),
  ]);
}

/**
 * The smoothed surface normal at a continuous pixel position, bilinearly blended
 * from the four surrounding material texels' normals. `indexAt(x, y)` returns the
 * stored direction index for an integer pixel (implementations clamp to the
 * material's bounds); this decodes the four corners around `(sampleX, sampleY)`
 * to vectors and hands them to {@link interpolateNormal}. A region of uniform
 * index returns exactly that index's normal, so flat and unmapped surfaces are
 * untouched — only genuinely varying normals get de-banded.
 *
 * @param indexAt  Reads the stored normal index at an integer pixel.
 * @param sampleX  Continuous column (pixel centres at integer coordinates).
 * @param sampleY  Continuous row.
 */
export function sampleNormalBilinear(
  indexAt: (x: number, y: number) => number,
  sampleX: number,
  sampleY: number,
): Vec3 {
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const fractionX = sampleX - x0;
  const fractionY = sampleY - y0;
  return interpolateNormal(
    normalVector(indexAt(x0, y0)),
    normalVector(indexAt(x0 + 1, y0)),
    normalVector(indexAt(x0, y0 + 1)),
    normalVector(indexAt(x0 + 1, y0 + 1)),
    fractionX,
    fractionY,
  );
}

/**
 * A material ramp channel (height, specular, or roughness) bilinearly sampled at
 * a continuous pixel position, the scalar twin of {@link sampleNormalBilinear}.
 * `valueAt(x, y)` returns the stored 0..1 level at an integer texel (clamped by
 * the implementation); this blends the four texels around `(sampleX, sampleY)`.
 *
 * The ramp channels are 4-bit (16 levels), so a smooth gradient painted across a
 * surface reads back as visible steps. Blending them here — exactly as the normal
 * field is blended — dissolves that banding without touching the stored art. The
 * normal channel cannot use the GPU's linear filter (its bytes are an unordered
 * direction index), so the shaders keep the material texture NEAREST and blend
 * both the normals and these ramps by hand; this is the reference for the ramp
 * half of that, and the shaders must match it per channel.
 *
 * A uniform region returns its constant exactly, so flat materials are untouched.
 *
 * @param valueAt  Reads the stored 0..1 ramp value at an integer texel.
 * @param sampleX  Continuous column (texel centres at integer coordinates).
 * @param sampleY  Continuous row.
 */
export function sampleScalarBilinear(
  valueAt: (x: number, y: number) => number,
  sampleX: number,
  sampleY: number,
): number {
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const fractionX = sampleX - x0;
  const fractionY = sampleY - y0;
  const top = valueAt(x0, y0) + (valueAt(x0 + 1, y0) - valueAt(x0, y0)) * fractionX;
  const bottom = valueAt(x0, y0 + 1) + (valueAt(x0 + 1, y0 + 1) - valueAt(x0, y0 + 1)) * fractionX;
  return top + (bottom - top) * fractionY;
}

/** Feathering applied just below a spot's inner cone, in cosine units. */
export const SPOT_CONE_SOFTNESS = 0.15;

/** Numeric light-kind codes the shaders branch on (both backends must agree). */
export const LIGHT_KIND_CODE: Record<LightKind, number> = { point: 0, directional: 1, spot: 2 };

/** Direction a light faces when it omits one (straight at the camera). */
export const DEFAULT_LIGHT_DIRECTION: Vec3 = [0, 0, 1];

/** A spot's inner-cone cosine (~25° half-angle) when it omits one. */
export const DEFAULT_SPOT_CONE_COS = 0.9;

/** The unit direction toward a light, and its scalar attenuation at a pixel. */
export interface LightSample {
  /** Unit vector from the surface point toward the light. */
  toLight: Vec3;
  /** Scalar 0..1 combining distance falloff and (for spots) the cone gate. */
  attenuation: number;
}

/**
 * The per-pixel geometry of a light — the part that differs by {@link LightKind}
 * — resolved to a direction-to-light and a scalar attenuation. The runtime
 * shaders (WebGL + WebGPU) run this exact logic per fragment; keeping it here in
 * pure form lets tests pin the behaviour that separates the three light types:
 * a point falls off with distance, a directional is uniform everywhere, and a
 * spot is a point light gated by a cone.
 *
 * @param light          The light to sample.
 * @param x              Pixel column.
 * @param y              Pixel row.
 * @param surfaceHeight  Height of the surface at the pixel (from the material).
 */
export function sampleLight(light: Light, x: number, y: number, surfaceHeight: number): LightSample {
  const kind: LightKind = light.kind ?? "point";
  if (kind === "directional") {
    // A distant key: parallel rays, no position, no falloff. `direction` points
    // toward the light, so it is the to-light vector directly.
    return { toLight: normalize(light.direction ?? [0, 0, 1]), attenuation: 1 };
  }

  const toLightVec: Vec3 = [light.x - x, light.y - y, light.z - surfaceHeight];
  const planarDistance = Math.hypot(toLightVec[0], toLightVec[1]);
  const reach = light.radius || 1;
  const falloff = Math.max(0, Math.min(1, 1 - planarDistance / reach));
  let attenuation = falloff * falloff;
  const toLight = normalize(toLightVec);

  if (kind === "spot") {
    const axis = normalize(light.direction ?? [0, 0, 1]);
    // The beam direction from the apex toward this pixel (opposite of to-light).
    const beam = normalize([x - light.x, y - light.y, surfaceHeight - light.z]);
    const alignment = beam[0] * axis[0] + beam[1] * axis[1] + beam[2] * axis[2];
    const inner = light.coneCos ?? 0.9;
    const outer = inner - SPOT_CONE_SOFTNESS;
    const cone = Math.max(0, Math.min(1, (alignment - outer) / Math.max(1e-3, inner - outer)));
    attenuation *= cone;
  }

  return { toLight, attenuation };
}

/**
 * Shade an albedo colour by a surface normal and a direction toward the light:
 * Lambert diffuse lifted by an ambient floor, so a surface never drops below
 * `ambient` of its base colour. Each channel is clamped to 0..255.
 */
export function shade(albedo: Rgb, normal: Vec3, toLight: Vec3, ambient: number): Rgb {
  const n = normalize(normal);
  const l = normalize(toLight);
  const diffuse = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  const intensity = ambient + (1 - ambient) * diffuse;
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value * intensity)));
  return [clamp(albedo[0]), clamp(albedo[1]), clamp(albedo[2])];
}

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

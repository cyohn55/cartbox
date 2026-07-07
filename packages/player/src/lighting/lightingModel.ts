/**
 * The Cartbox lighting model, in pure TypeScript — DOM-free and side-effect
 * free so it can be unit-tested and reused on the server. It is the exact model
 * the editor authors against (packages/editor/src/model/normals.ts and
 * lighting.ts): a per-pixel normal chosen from 16 directions, shaded by Lambert
 * diffuse lifted over an ambient floor. The runtime {@link LightingLayer} runs
 * the same maths in a shader; keeping this here lets both agree by construction.
 */

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

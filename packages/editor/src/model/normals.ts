/**
 * Normal directions for pixel-art normal maps. A pixel stores one of 16
 * direction indices; index 0 is flat (facing the camera), 1..8 are the eight
 * compass directions tilted outward, and 9..15 are spare (flat). Pure math,
 * shared by the lighting preview and the (coming) WebGPU renderer.
 */

export type Vec3 = readonly [number, number, number];

export const NORMAL_DIRECTION_COUNT = 16;

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function build(): Vec3[] {
  const tilt = 0.55;
  // Compass offsets in screen space (y points down): N, NE, E, SE, S, SW, W, NW.
  const offsets: Array<[number, number]> = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  const directions: Vec3[] = [[0, 0, 1]];
  for (const [ox, oy] of offsets) {
    const x = ox * tilt;
    const y = oy * tilt;
    const z = Math.sqrt(Math.max(0.0001, 1 - x * x - y * y));
    directions.push(normalize([x, y, z]));
  }
  while (directions.length < NORMAL_DIRECTION_COUNT) directions.push([0, 0, 1]);
  return directions;
}

export const NORMAL_VECTORS: readonly Vec3[] = build();

/** The unit normal for a direction index (flat for out-of-range). */
export function normalVector(direction: number): Vec3 {
  return NORMAL_VECTORS[direction] ?? NORMAL_VECTORS[0]!;
}

/** The direction index whose vector is closest to `vec` (largest dot product). */
export function nearestDirection(vec: Vec3): number {
  const target = normalize(vec);
  let best = 0;
  let bestDot = -Infinity;
  NORMAL_VECTORS.forEach((direction, index) => {
    const dot = direction[0] * target[0] + direction[1] * target[1] + direction[2] * target[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  });
  return best;
}

/** Tangent-space normal-map colour for a direction, for authoring swatches. */
export function normalColorHex(direction: number): string {
  const [x, y, z] = normalVector(direction);
  const channel = (value: number) =>
    Math.round((value * 0.5 + 0.5) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(x)}${channel(y)}${channel(z)}`;
}

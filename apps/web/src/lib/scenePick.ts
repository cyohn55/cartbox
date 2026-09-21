/**
 * Pure ray-picking for the 3D scene editor: turn a click in the viewport into a
 * world-space ray, and find the nearest instance whose world AABB it hits. Kept
 * DOM-free and matrix-inverse-free — the ray is built straight from the orbit
 * camera's basis (eye, forward, right, up), which the viewport already knows —
 * so selection is unit-testable without a canvas or a GPU.
 */

export type Vec3 = readonly [number, number, number];

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * The camera's orthonormal basis for a look-at: forward (toward the target),
 * right, and the re-orthogonalised up. Shared by the ray builder and the
 * viewport's screen-space gizmo so both agree on which way "right" and "up" are.
 */
export function cameraBasis(eye: Vec3, target: Vec3, worldUp: Vec3 = [0, 1, 0]): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = normalize(sub(target, eye));
  const right = normalize(cross(forward, worldUp));
  const up = cross(right, forward); // already unit-length (both inputs unit & orthogonal)
  return { forward, right, up };
}

/**
 * Build the world-space ray through a normalised device coordinate (`ndcX`,
 * `ndcY` in [-1, 1], +Y up) for a perspective orbit camera. The direction points
 * from the eye into the scene; the origin is the eye.
 */
export function cameraRay(
  eye: Vec3,
  target: Vec3,
  fovY: number,
  aspect: number,
  ndcX: number,
  ndcY: number,
  worldUp: Vec3 = [0, 1, 0],
): Ray {
  const { forward, right, up } = cameraBasis(eye, target, worldUp);
  const th = Math.tan(fovY / 2);
  const dir = normalize([
    forward[0] + ndcX * th * aspect * right[0] + ndcY * th * up[0],
    forward[1] + ndcX * th * aspect * right[1] + ndcY * th * up[1],
    forward[2] + ndcX * th * aspect * right[2] + ndcY * th * up[2],
  ]);
  return { origin: eye, dir };
}

/**
 * Nearest positive hit distance of a ray against an axis-aligned box (the slab
 * method), or null when it misses or the box is entirely behind the ray. Returns
 * 0 when the origin is inside the box.
 */
export function rayAabbT(ray: Ray, min: Vec3, max: Vec3): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const o = ray.origin[i]!;
    const d = ray.dir[i]!;
    const lo = min[i]!;
    const hi = max[i]!;
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null; // parallel and outside the slab
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null; // box entirely behind the ray
  return tmin >= 0 ? tmin : 0; // inside the box → 0
}

/** A world AABB paired with whatever key the caller wants back on a hit. */
export interface PickBox<K> {
  readonly key: K;
  readonly min: Vec3;
  readonly max: Vec3;
}

/** The key of the nearest box the ray hits, or null when it hits nothing. */
export function pickBoxes<K>(boxes: readonly PickBox<K>[], ray: Ray): K | null {
  let best: number = Infinity;
  let hit: K | null = null;
  for (const box of boxes) {
    const t = rayAabbT(ray, box.min, box.max);
    if (t !== null && t < best) {
      best = t;
      hit = box.key;
    }
  }
  return hit;
}

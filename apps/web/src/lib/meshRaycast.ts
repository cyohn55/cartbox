/**
 * Ray casts against placed meshes' triangles, for the scene viewport (EP2):
 * picking the object actually under the cursor rather than the nearest bounding
 * box (a level's box contains everything standing in it), and "drop to
 * surface". Each instance's box is tested first, so only meshes the ray can
 * reach have their triangles walked.
 */

import { worldAabb, type Mat4, type MeshAsset } from "@cartbox/editor";

import { rayAabbT, type Ray, type Vec3 } from "./scenePick";

export interface RaycastTarget {
  readonly key: string;
  readonly mesh: MeshAsset;
  readonly model: Mat4;
}

export interface RaycastHit {
  readonly key: string;
  /** Distance along the ray (in units of its direction's length). */
  readonly t: number;
  readonly point: Vec3;
}

/** Möller–Trumbore: the distance to a triangle along a ray (either facing), or null. */
export function rayTriangle(ray: Ray, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const [dx, dy, dz] = ray.dir;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = ray.origin[0] - a[0], ty = ray.origin[1] - a[1], tz = ray.origin[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-6 ? t : null;
}

/** The nearest triangle a ray hits among `targets` (skipping `ignore`), or null. */
export function raycastMeshes(ray: Ray, targets: readonly RaycastTarget[], ignore: ReadonlySet<string> = new Set()): RaycastHit | null {
  // Nearest boxes first, so a hit closer than the next box ends the search.
  const candidates: { target: RaycastTarget; t: number }[] = [];
  for (const target of targets) {
    if (ignore.has(target.key)) continue;
    const box = worldAabb(target.mesh, target.model);
    if (!box) continue;
    const t = rayAabbT(ray, box.min as Vec3, box.max as Vec3);
    if (t !== null) candidates.push({ target, t });
  }
  candidates.sort((x, y) => x.t - y.t);
  let best: RaycastHit | null = null;
  for (const { target, t: boxT } of candidates) {
    if (best && boxT > best.t) break;
    const m = target.model;
    for (const primitive of target.mesh.primitives) {
      const p = primitive.positions;
      const world = new Float64Array(p.length);
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
        world[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        world[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        world[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      }
      const idx = primitive.indices;
      const at = (k: number): Vec3 => [world[k * 3]!, world[k * 3 + 1]!, world[k * 3 + 2]!];
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const t = rayTriangle(ray, at(idx[i]!), at(idx[i + 1]!), at(idx[i + 2]!));
        if (t !== null && (!best || t < best.t)) {
          best = { key: target.key, t, point: [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t] };
        }
      }
    }
  }
  return best;
}

/**
 * How far an object must move down (negative) or up to rest on the surface
 * beneath it: a ray straight down from just above the bottom centre of its box
 * onto the other meshes, and onto the ground (y = 0, or `ground(x, z)` when a
 * terrain is there). Null when there's nothing below.
 */
export function dropDistance(box: { readonly min: Vec3; readonly max: Vec3 }, others: readonly RaycastTarget[], ignore: ReadonlySet<string>, ground?: (x: number, z: number) => number | null): number | null {
  const cx = (box.min[0] + box.max[0]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;
  const lift = Math.max(1e-3, (box.max[1] - box.min[1]) * 0.01);
  const ray: Ray = { origin: [cx, box.min[1] + lift, cz], dir: [0, -1, 0] };
  const hit = raycastMeshes(ray, others, ignore);
  let surface = hit ? hit.point[1] : null;
  const g = ground ? ground(cx, cz) : 0;
  if (g !== null && g <= box.min[1] + lift && (surface === null || g > surface)) surface = g;
  return surface === null ? null : surface - box.min[1];
}

/**
 * Frustum culling (Phase 5): skip whole instances the camera cannot see.
 *
 * A correct frustum cull is *output-identical* — it only removes geometry that
 * would rasterise to nothing — so it is a pure win the runtime can always apply,
 * and it is fully verifiable without a GPU. The planes come straight from the
 * combined view-projection (Gribb–Hartmann), so they are in world space and an
 * instance's world-space AABB tests against them directly.
 *
 * Pure and DOM-free.
 */

import { meshBounds, type MeshAsset } from "../model/MeshAsset";
import type { Mat4 } from "./meshRasterizer";
import { multiplyMat4 } from "./meshRasterizer";
import type { MeshSceneInstance } from "./meshRasterizer";

/** A plane `a·x + b·y + c·z + d ≥ 0` for points inside the frustum. */
export type FrustumPlane = readonly [number, number, number, number];

/**
 * The six world-space frustum planes of a column-major view-projection matrix
 * (left, right, bottom, top, near, far), each oriented so an inside point yields
 * a non-negative dot with `(x, y, z, 1)`. Not normalised — only the sign matters
 * for containment, so the extra sqrt is skipped.
 */
export function frustumPlanes(viewProj: Mat4): FrustumPlane[] {
  const m = viewProj;
  // Rows of the matrix (column-major storage: element [col*4 + row]).
  const r0 = [m[0]!, m[4]!, m[8]!, m[12]!]; // x row
  const r1 = [m[1]!, m[5]!, m[9]!, m[13]!]; // y row
  const r2 = [m[2]!, m[6]!, m[10]!, m[14]!]; // z row
  const r3 = [m[3]!, m[7]!, m[11]!, m[15]!]; // w row
  const add = (a: number[], b: number[]): FrustumPlane => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!, a[3]! + b[3]!];
  const sub = (a: number[], b: number[]): FrustumPlane => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!, a[3]! - b[3]!];
  return [
    add(r3, r0), // left:   w + x ≥ 0
    sub(r3, r0), // right:  w − x ≥ 0
    add(r3, r1), // bottom: w + y ≥ 0
    sub(r3, r1), // top:    w − y ≥ 0
    add(r3, r2), // near:   w + z ≥ 0
    sub(r3, r2), // far:    w − z ≥ 0
  ];
}

/**
 * Whether a world-space AABB is entirely outside the frustum (so it may be
 * dropped). Uses the "positive vertex" test: for each plane, the AABB corner
 * furthest in the plane's normal direction; if even that corner is behind the
 * plane, the whole box is. Conservative — a box straddling a plane is kept.
 */
export function aabbOutsideFrustum(
  planes: readonly FrustumPlane[],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  for (const [a, b, c, d] of planes) {
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) return true; // fully behind this plane
  }
  return false;
}

/** The world-space AABB of a mesh under a model matrix (its 8 corners transformed). */
export function worldAabb(mesh: MeshAsset, model: Mat4): { min: [number, number, number]; max: [number, number, number] } | null {
  const local = meshBounds(mesh);
  if (!local) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i += 1) {
    const x = i & 1 ? local.max[0] : local.min[0];
    const y = i & 2 ? local.max[1] : local.min[1];
    const z = i & 4 ? local.max[2] : local.min[2];
    const wx = model[0]! * x + model[4]! * y + model[8]! * z + model[12]!;
    const wy = model[1]! * x + model[5]! * y + model[9]! * z + model[13]!;
    const wz = model[2]! * x + model[6]! * y + model[10]! * z + model[14]!;
    if (wx < min[0]) min[0] = wx;
    if (wy < min[1]) min[1] = wy;
    if (wz < min[2]) min[2] = wz;
    if (wx > max[0]) max[0] = wx;
    if (wy > max[1]) max[1] = wy;
    if (wz > max[2]) max[2] = wz;
  }
  return { min, max };
}

/**
 * Return only the instances whose world AABB is inside (or straddling) the
 * frustum. Instances with no computable bounds are always kept (never wrongly
 * dropped). Returns the original array when nothing is culled, so an all-visible
 * scene allocates nothing.
 */
export function cullInstances(
  instances: readonly MeshSceneInstance[],
  view: Mat4,
  projection: Mat4,
): readonly MeshSceneInstance[] {
  if (instances.length === 0) return instances;
  const planes = frustumPlanes(multiplyMat4(projection, view));
  let anyCulled = false;
  const kept: MeshSceneInstance[] = [];
  for (const instance of instances) {
    const box = worldAabb(instance.mesh, instance.model);
    if (box && aabbOutsideFrustum(planes, box.min, box.max)) {
      anyCulled = true;
      continue;
    }
    kept.push(instance);
  }
  return anyCulled ? kept : instances;
}

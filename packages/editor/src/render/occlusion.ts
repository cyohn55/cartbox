/**
 * Occlusion culling (Phase 5): drop instances hidden behind nearer geometry.
 *
 * Given a depth pre-pass (view-space eye distance per pixel, +Infinity where
 * nothing drew — exactly what {@link renderGeometryBuffers} produces), an instance
 * is occluded when, across its whole screen footprint, every stored surface is
 * *nearer* than the instance's closest point. The test is conservative: if any
 * pixel in the footprint is background or at/behind the instance, it is kept, so
 * nothing visible is ever culled. Pure and DOM-free.
 */

import { multiplyMat4, type Mat4, type MeshSceneInstance } from "./meshRasterizer";
import { worldAabb } from "./frustum";

export interface OcclusionInput {
  readonly view: Mat4;
  readonly projection: Mat4;
  /** View-space eye distance per pixel (+Infinity = background), `width×height`. */
  readonly depth: Float32Array;
  readonly width: number;
  readonly height: number;
  /** Depth slack so a surface does not occlude itself (view units, default 0.05). */
  readonly bias?: number;
}

/**
 * Whether an instance's world AABB is fully hidden by the depth pre-pass. Projects
 * the 8 corners to screen for the footprint rect + the AABB's nearest eye
 * distance, then scans that rect: occluded only if every covered pixel holds a
 * finite depth nearer than the instance. A box crossing the near plane, off
 * screen, or over any background pixel is never reported occluded.
 */
export function aabbOccluded(instance: MeshSceneInstance, input: OcclusionInput): boolean {
  const box = worldAabb(instance.mesh, instance.model);
  if (!box) return false;
  const { view, projection, depth, width, height } = input;
  const bias = input.bias ?? 0.05;
  const viewProj = multiplyMat4(projection, view);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let nearDist = Infinity;
  for (let i = 0; i < 8; i += 1) {
    const x = i & 1 ? box.max[0] : box.min[0];
    const y = i & 2 ? box.max[1] : box.min[1];
    const z = i & 4 ? box.max[2] : box.min[2];
    const cw = viewProj[3]! * x + viewProj[7]! * y + viewProj[11]! * z + viewProj[15]!;
    if (cw <= 1e-6) return false; // a corner behind the camera: don't risk culling
    const cx = viewProj[0]! * x + viewProj[4]! * y + viewProj[8]! * z + viewProj[12]!;
    const cy = viewProj[1]! * x + viewProj[5]! * y + viewProj[9]! * z + viewProj[13]!;
    const sx = (cx / cw * 0.5 + 0.5) * width;
    const sy = (1 - (cy / cw * 0.5 + 0.5)) * height;
    if (sx < minX) minX = sx;
    if (sy < minY) minY = sy;
    if (sx > maxX) maxX = sx;
    if (sy > maxY) maxY = sy;
    // Eye distance (view looks down −z), so distance is −viewZ.
    const viewZ = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!;
    const dist = -viewZ;
    if (dist < nearDist) nearDist = dist;
  }

  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(width - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(height - 1, Math.ceil(maxY));
  if (x0 > x1 || y0 > y1) return false; // footprint off screen — leave to the frustum cull

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const stored = depth[y * width + x]!;
      // Background, or a surface at/behind the instance → it may be visible here.
      if (!Number.isFinite(stored) || stored >= nearDist - bias) return false;
    }
  }
  return true; // every covered pixel is a nearer occluder
}

/**
 * Return only the instances not fully occluded by the depth pre-pass. Returns the
 * original array when nothing is culled, so an unoccluded scene allocates nothing.
 */
export function occlusionCull(
  instances: readonly MeshSceneInstance[],
  input: OcclusionInput,
): readonly MeshSceneInstance[] {
  if (instances.length === 0) return instances;
  let anyCulled = false;
  const kept: MeshSceneInstance[] = [];
  for (const instance of instances) {
    if (aabbOccluded(instance, input)) {
      anyCulled = true;
      continue;
    }
    kept.push(instance);
  }
  return anyCulled ? kept : instances;
}

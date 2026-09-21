/**
 * Level-of-detail selection (Phase 5): draw cheaper meshes for distant instances.
 *
 * Like frustum culling, this is a scene-level pass the renderer applies before
 * drawing: for each instance carrying a {@link LodChain}, it measures the camera
 * distance to the instance's origin and swaps in the appropriate mesh. Pure and
 * DOM-free, so the selection is verifiable without a GPU.
 */

import type { Mat4, MeshSceneInstance } from "./meshRasterizer";
import type { MeshAsset } from "../model/MeshAsset";

/**
 * The LOD level for a distance: the first level whose switch point the distance
 * has not yet reached, or the coarsest level past the last switch point.
 * `distances` is ascending with length `levelCount − 1`.
 */
export function selectLodIndex(distances: readonly number[], distance: number): number {
  for (let i = 0; i < distances.length; i += 1) {
    if (distance < distances[i]!) return i;
  }
  return distances.length;
}

/**
 * The world-space camera position from a column-major look-at view matrix:
 * `eye = -Rᵀ · t`, where R is the view's rotation and t its translation column.
 */
export function cameraPositionFromView(view: Mat4): [number, number, number] {
  const tx = view[12]!;
  const ty = view[13]!;
  const tz = view[14]!;
  // Rᵀ · t (R is orthonormal, so its inverse is its transpose; rows of R are the
  // view's columns 0..2).
  return [
    -(view[0]! * tx + view[1]! * ty + view[2]! * tz),
    -(view[4]! * tx + view[5]! * ty + view[6]! * tz),
    -(view[8]! * tx + view[9]! * ty + view[10]! * tz),
  ];
}

/** The mesh an instance should draw at a given camera distance (its LOD, or its base mesh). */
export function resolveLodMesh(instance: MeshSceneInstance, distance: number): MeshAsset {
  const lod = instance.lod;
  if (!lod || lod.meshes.length === 0) return instance.mesh;
  const index = Math.min(lod.meshes.length - 1, selectLodIndex(lod.distances, distance));
  return lod.meshes[index] ?? instance.mesh;
}

/**
 * Swap each LOD-carrying instance's `mesh` for the level its camera distance
 * selects (measured to the instance's origin — its model translation). Instances
 * with no LOD chain pass through untouched; returns the original array when
 * nothing changed, so a scene with no LODs allocates nothing.
 */
export function applyLods(
  instances: readonly MeshSceneInstance[],
  cameraX: number,
  cameraY: number,
  cameraZ: number,
): readonly MeshSceneInstance[] {
  let changed = false;
  const result = instances.map((instance) => {
    if (!instance.lod || instance.lod.meshes.length === 0) return instance;
    const dx = instance.model[12]! - cameraX;
    const dy = instance.model[13]! - cameraY;
    const dz = instance.model[14]! - cameraZ;
    const distance = Math.hypot(dx, dy, dz);
    const mesh = resolveLodMesh(instance, distance);
    if (mesh === instance.mesh) return instance;
    changed = true;
    return { ...instance, mesh };
  });
  return changed ? result : instances;
}

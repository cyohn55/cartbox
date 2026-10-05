/**
 * LODs on scene objects (ENGINE_PARITY_ROADMAP.md EP9b): generate a model's
 * lighter levels (see meshSimplify.ts in @cartbox/editor), store them with the
 * object, clear them, and say what an object's levels are. A model placed
 * several times gets its levels on every copy at once (the sidecar's library
 * stores them once), and an import big enough to need them gets them unasked.
 */

import { decodeLods, encodeLods, generateLods, triangleCountOf } from "@cartbox/editor";

import { readMeshEntry, type MeshSidecar, type MeshSidecarEntry } from "./meshSidecar";

/** An import with at least this many triangles gets LODs on the way in. */
export const AUTO_LOD_TRIANGLES = 2000;

/** What an object's LODs are: each level's triangles (the full mesh first) and where each takes over; `stale` when the mesh changed since. */
export interface LodSummary {
  readonly triangles: readonly number[];
  readonly distances: readonly number[];
  readonly stale: boolean;
}

export function lodSummary(entry: MeshSidecarEntry): LodSummary | null {
  if (!entry.lods) return null;
  let mesh;
  try {
    mesh = readMeshEntry(entry);
  } catch {
    return null;
  }
  const chain = decodeLods(mesh, entry.lods);
  // Levels that no longer fit (made from the mesh before an edit) are skipped by the renderer.
  if (!chain) return { triangles: [triangleCountOf(mesh)], distances: entry.lods.distances, stale: true };
  return { triangles: [mesh, ...chain.meshes].map(triangleCountOf), distances: chain.distances, stale: false };
}

/** The entries that place the same model as `id` (itself included). */
function copiesOf(sidecar: MeshSidecar, id: string): Set<string> {
  const mesh = sidecar.meshes.find((m) => m.id === id)?.mesh;
  return new Set(sidecar.meshes.filter((m) => m.mesh === mesh).map((m) => m.id));
}

/**
 * Generate LODs for `id`'s model and store them on it and every other copy of
 * it. `made` is false (and the sidecar unchanged) when the model is too small
 * or too plain for a level to save anything.
 */
export function generateEntryLods(sidecar: MeshSidecar, id: string): { sidecar: MeshSidecar; made: boolean } {
  const entry = sidecar.meshes.find((m) => m.id === id);
  if (!entry) return { sidecar, made: false };
  let mesh;
  try {
    mesh = readMeshEntry(entry);
  } catch {
    return { sidecar, made: false };
  }
  const chain = generateLods(mesh);
  if (!chain) return { sidecar, made: false };
  const lods = encodeLods(mesh, chain);
  const copies = copiesOf(sidecar, id);
  return { sidecar: { ...sidecar, meshes: sidecar.meshes.map((m) => (copies.has(m.id) ? { ...m, lods } : m)) }, made: true };
}

/** Remove the LODs from `id`'s model (every copy of it). */
export function clearEntryLods(sidecar: MeshSidecar, id: string): MeshSidecar {
  const copies = copiesOf(sidecar, id);
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => {
      if (!copies.has(m.id) || !m.lods) return m;
      const { lods: _lods, ...rest } = m;
      void _lods;
      return rest;
    }),
  };
}

/** On import: give `id` LODs when its model is big enough to want them. */
export function withAutoLods(sidecar: MeshSidecar, id: string): MeshSidecar {
  const entry = sidecar.meshes.find((m) => m.id === id);
  if (!entry) return sidecar;
  try {
    if (triangleCountOf(readMeshEntry(entry)) < AUTO_LOD_TRIANGLES) return sidecar;
  } catch {
    return sidecar;
  }
  return generateEntryLods(sidecar, id).sidecar;
}

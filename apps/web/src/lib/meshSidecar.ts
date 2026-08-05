/**
 * The cart's mesh sidecar — the named triangle-mesh assets a cart carries, each
 * with a placement transform, stored in the cart row's `mesh` column (a JSON
 * string) and handed to the runtime the same way the voxel, anim, and particle
 * sidecars are.
 *
 * A mesh is stored as its {@link serializeMeshAsset} envelope (base64 geometry +
 * embedded textures) alongside a transform the editor edits and the runtime
 * applies as each instance's model matrix. Decoding is defensive throughout: the
 * payload comes back from storage or the API, so a malformed entry is dropped
 * rather than thrown into the editor's mount path.
 *
 * This is the browser/runtime-facing shape; the pure geometry lives in
 * `@cartbox/editor`. Kept separate from the voxel sidecar deliberately — meshes
 * and voxels are different asset kinds with different storage costs, and folding
 * them together would couple two unrelated schemas.
 */

import { deserializeMeshAsset, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";

/** The envelope version; bumped on any schema change. */
export const MESH_SIDECAR_VERSION = 1;

/** Placement of a mesh instance: translation, Euler rotation (degrees), scale. */
export interface MeshTransform {
  readonly position: readonly [number, number, number];
  /** Euler angles in degrees, applied X→Y→Z. */
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

/** One placed mesh: its identity, geometry payload, and transform. */
export interface MeshSidecarEntry {
  readonly id: string;
  readonly name: string;
  /** The mesh geometry as a {@link serializeMeshAsset} string. */
  readonly mesh: string;
  readonly transform: MeshTransform;
}

/** The whole mesh sidecar: every placed mesh on the cart. */
export interface MeshSidecar {
  readonly version: number;
  readonly meshes: readonly MeshSidecarEntry[];
}

/** The identity transform a freshly imported mesh gets. */
export function defaultMeshTransform(): MeshTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/** An empty sidecar — a cart with no meshes. */
export function emptyMeshSidecar(): MeshSidecar {
  return { version: MESH_SIDECAR_VERSION, meshes: [] };
}

/** A stable-ish unique id for a new mesh entry. */
function newMeshId(): string {
  return `mesh-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
}

/** Serialize the sidecar for storage. Returns null when there are no meshes, so an empty cart stores nothing. */
export function encodeMeshSidecar(sidecar: MeshSidecar): string | null {
  if (sidecar.meshes.length === 0) return null;
  return JSON.stringify({ version: MESH_SIDECAR_VERSION, meshes: sidecar.meshes });
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Read a transform defensively, filling any missing/invalid field from the identity. */
function readTransform(value: unknown): MeshTransform {
  const raw = (value ?? {}) as Partial<Record<keyof MeshTransform, unknown>>;
  const base = defaultMeshTransform();
  return {
    position: isFiniteTriple(raw.position) ? raw.position : base.position,
    rotation: isFiniteTriple(raw.rotation) ? raw.rotation : base.rotation,
    scale: isFiniteTriple(raw.scale) ? raw.scale : base.scale,
  };
}

/**
 * Parse a stored sidecar, dropping any entry that is malformed or whose mesh
 * geometry fails to validate — a corrupt asset must not blank the editor. A null
 * or unparseable payload yields an empty sidecar.
 */
export function decodeMeshSidecar(raw: string | null | undefined): MeshSidecar {
  if (!raw) return emptyMeshSidecar();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMeshSidecar();
  }
  const entries = (parsed as { meshes?: unknown }).meshes;
  if (!Array.isArray(entries)) return emptyMeshSidecar();

  const meshes: MeshSidecarEntry[] = [];
  for (const entry of entries) {
    const record = entry as Partial<MeshSidecarEntry>;
    if (typeof record.mesh !== "string") continue;
    try {
      deserializeMeshAsset(record.mesh); // validate the geometry; drop the entry if it throws
    } catch {
      continue;
    }
    meshes.push({
      id: typeof record.id === "string" ? record.id : newMeshId(),
      name: typeof record.name === "string" ? record.name : "Mesh",
      mesh: record.mesh,
      transform: readTransform(record.transform),
    });
  }
  return { version: MESH_SIDECAR_VERSION, meshes };
}

// --- Immutable list operations (the editor edits through these) ------------

/** Append an imported mesh with a default transform, returning the new sidecar. */
export function addMesh(sidecar: MeshSidecar, mesh: MeshAsset, name: string): { sidecar: MeshSidecar; id: string } {
  const id = newMeshId();
  const entry: MeshSidecarEntry = {
    id,
    name: name || mesh.name || "Mesh",
    mesh: serializeMeshAsset(mesh),
    transform: defaultMeshTransform(),
  };
  return { sidecar: { version: MESH_SIDECAR_VERSION, meshes: [...sidecar.meshes, entry] }, id };
}

/** Replace one entry's transform. */
export function setMeshTransform(sidecar: MeshSidecar, id: string, transform: MeshTransform): MeshSidecar {
  return {
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => (entry.id === id ? { ...entry, transform } : entry)),
  };
}

/** Rename one entry. */
export function renameMesh(sidecar: MeshSidecar, id: string, name: string): MeshSidecar {
  return {
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
  };
}

/** Drop one entry. */
export function removeMesh(sidecar: MeshSidecar, id: string): MeshSidecar {
  return { version: MESH_SIDECAR_VERSION, meshes: sidecar.meshes.filter((entry) => entry.id !== id) };
}

/** Decode one entry's geometry back into a {@link MeshAsset}. */
export function readMeshEntry(entry: MeshSidecarEntry): MeshAsset {
  return deserializeMeshAsset(entry.mesh);
}

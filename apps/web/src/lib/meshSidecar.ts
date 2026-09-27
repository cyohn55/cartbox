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

import {
  deserializeMeshAsset,
  isSceneKey,
  packMeshLibrary,
  parentIndices,
  parseSceneLighting,
  readMeshLibrary,
  readSceneProps,
  readSceneTags,
  SCENE_PROP_MAX,
  SCENE_STRING_MAX,
  SCENE_TAG_MAX,
  resolveMeshFrames,
  resolveMeshRef,
  serializeMeshAsset,
  type MeshAsset,
  type SceneLighting,
  type ScenePropValue,
} from "@cartbox/editor";

/** The envelope version; bumped on any schema change (2 added the lighting rig). */
export const MESH_SIDECAR_VERSION = 2;

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
  /**
   * Optional animation frames: alternate meshes (serialized) a cart can switch
   * this instance to per frame through `cartbox.meshpose(..., frame)`.
   */
  readonly frames?: readonly string[];
  /**
   * Scene objects (ENGINE_ROADMAP.md, Phase 1), all optional. `parent` is another
   * entry's id: this entry's transform is then relative to it. `tags` group
   * objects (`cartbox.tagged`) and `props` hold data the cart reads
   * (`cartbox.prop`).
   */
  readonly parent?: string;
  readonly tags?: readonly string[];
  readonly props?: Readonly<Record<string, ScenePropValue>>;
}

/** The whole mesh sidecar: every placed mesh on the cart, plus its lighting rig. */
export interface MeshSidecar {
  readonly version: number;
  readonly meshes: readonly MeshSidecarEntry[];
  /**
   * The authored Modern-tier lighting rig for the 3D scene, or null when the
   * creator has set none. Absent on every cart until they opt in, so a scene
   * without a rig renders exactly as before. See {@link SceneLighting}.
   */
  readonly lighting: SceneLighting | null;
}

/** The identity transform a freshly imported mesh gets. */
export function defaultMeshTransform(): MeshTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

/** An empty sidecar — a cart with no meshes and no lighting rig. */
export function emptyMeshSidecar(): MeshSidecar {
  return { version: MESH_SIDECAR_VERSION, meshes: [], lighting: null };
}

/** A stable-ish unique id for a new mesh entry. */
function newMeshId(): string {
  return `mesh-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
}

/**
 * Serialize the sidecar for storage. Returns null when there is nothing to keep —
 * no meshes and no lighting rig — so an empty cart stores nothing. A lighting rig
 * alone (meshes removed but the scene still lit) is kept.
 */
export function encodeMeshSidecar(sidecar: MeshSidecar): string | null {
  if (sidecar.meshes.length === 0 && !sidecar.lighting) return null;
  // Repeated meshes (and animation frames) are stored once in a shared library.
  const { entries, library } = packMeshLibrary(sidecar.meshes);
  return JSON.stringify({
    version: MESH_SIDECAR_VERSION,
    meshes: entries,
    ...(Object.keys(library).length > 0 ? { library } : {}),
    lighting: sidecar.lighting ?? null,
  });
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

  const library = readMeshLibrary((parsed as { library?: unknown }).library);
  // Each distinct mesh string is validated once, however many entries share it.
  const valid = new Map<string, boolean>();
  const isValid = (mesh: string): boolean => {
    let ok = valid.get(mesh);
    if (ok === undefined) {
      try {
        deserializeMeshAsset(mesh);
        ok = true;
      } catch {
        ok = false;
      }
      valid.set(mesh, ok);
    }
    return ok;
  };
  const meshes: MeshSidecarEntry[] = [];
  for (const entry of entries) {
    const record = entry as Partial<MeshSidecarEntry> & { frames?: unknown };
    if (typeof record.mesh !== "string") continue;
    const mesh = resolveMeshRef(record.mesh, library);
    if (!mesh || !isValid(mesh)) continue; // drop an entry whose geometry is missing or invalid
    const frames = resolveMeshFrames(record.frames, library).filter(isValid);
    const tags = readSceneTags(record.tags);
    const props = readSceneProps(record.props);
    meshes.push({
      id: typeof record.id === "string" ? record.id : newMeshId(),
      name: typeof record.name === "string" ? record.name : "Mesh",
      mesh,
      transform: readTransform(record.transform),
      ...(frames.length > 0 ? { frames } : {}),
      ...(typeof record.parent === "string" && record.parent ? { parent: record.parent } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(Object.keys(props).length > 0 ? { props } : {}),
    });
  }
  const lighting = parseSceneLighting((parsed as { lighting?: unknown }).lighting);
  return { version: MESH_SIDECAR_VERSION, meshes, lighting };
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
  return { sidecar: { ...sidecar, version: MESH_SIDECAR_VERSION, meshes: [...sidecar.meshes, entry] }, id };
}

/** Replace one entry's transform. */
export function setMeshTransform(sidecar: MeshSidecar, id: string, transform: MeshTransform): MeshSidecar {
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => (entry.id === id ? { ...entry, transform } : entry)),
  };
}

/** Replace the scene's lighting rig (null clears it). */
export function setMeshLighting(sidecar: MeshSidecar, lighting: SceneLighting | null): MeshSidecar {
  return { ...sidecar, version: MESH_SIDECAR_VERSION, lighting };
}

/**
 * Replace one entry's geometry, re-serializing an edited {@link MeshAsset} back
 * into its envelope — the persistence half of the material editor (Phase 6).
 * Leaves the entry's id, name, and transform untouched; only the mesh payload
 * changes. An unknown id returns the sidecar unchanged.
 */
export function setMeshAsset(sidecar: MeshSidecar, id: string, mesh: MeshAsset): MeshSidecar {
  const serialized = serializeMeshAsset(mesh);
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => (entry.id === id ? { ...entry, mesh: serialized } : entry)),
  };
}

/** Rename one entry. */
export function renameMesh(sidecar: MeshSidecar, id: string, name: string): MeshSidecar {
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
  };
}

/**
 * Drop one entry. Its children move up to its own parent (or become roots),
 * keeping their local transforms, so removing a group never removes its contents.
 */
export function removeMesh(sidecar: MeshSidecar, id: string): MeshSidecar {
  const removed = sidecar.meshes.find((entry) => entry.id === id);
  const meshes = sidecar.meshes
    .filter((entry) => entry.id !== id)
    .map((entry) => (entry.parent === id ? withParent(entry, removed?.parent ?? null) : entry));
  return { ...sidecar, version: MESH_SIDECAR_VERSION, meshes };
}

// --- Scene objects: hierarchy, tags, properties ------------------------------

function withParent(entry: MeshSidecarEntry, parent: string | null): MeshSidecarEntry {
  const { parent: _drop, ...rest } = entry;
  return parent ? { ...rest, parent } : rest;
}

/** The ids `id` may be parented to: every entry except itself and its descendants. */
export function parentCandidates(sidecar: MeshSidecar, id: string): MeshSidecarEntry[] {
  const parents = parentIndices(sidecar.meshes);
  const self = sidecar.meshes.findIndex((entry) => entry.id === id);
  return sidecar.meshes.filter((_, i) => {
    for (let at = i; at >= 0; at = parents[at] ?? -1) if (at === self) return false;
    return true;
  });
}

/**
 * Parent `id` to `parentId` (null makes it a root). Its transform is kept as its
 * local transform, now relative to the new parent. A parent that would create a
 * cycle (itself or one of its descendants) or doesn't exist is refused: the
 * sidecar comes back unchanged.
 */
export function setMeshParent(sidecar: MeshSidecar, id: string, parentId: string | null): MeshSidecar {
  if (parentId !== null && !parentCandidates(sidecar, id).some((entry) => entry.id === parentId)) return sidecar;
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => (entry.id === id ? withParent(entry, parentId) : entry)),
  };
}

/** Replace one entry's tags (invalid names and duplicates dropped, capped at 16). */
export function setMeshTags(sidecar: MeshSidecar, id: string, tags: readonly string[]): MeshSidecar {
  const clean = readSceneTags(tags).slice(0, SCENE_TAG_MAX);
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => {
      if (entry.id !== id) return entry;
      const { tags: _drop, ...rest } = entry;
      return clean.length > 0 ? { ...rest, tags: clean } : rest;
    }),
  };
}

/**
 * Set (or with `value` null, remove) one custom property. An invalid key, a
 * non-finite number, or a new key past the 32-property cap is refused.
 */
export function setMeshProp(sidecar: MeshSidecar, id: string, key: string, value: ScenePropValue | null): MeshSidecar {
  if (!isSceneKey(key)) return sidecar;
  if (typeof value === "number" && !Number.isFinite(value)) return sidecar;
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => {
      if (entry.id !== id) return entry;
      const props: Record<string, ScenePropValue> = { ...(entry.props ?? {}) };
      if (value === null) delete props[key];
      else {
        if (!(key in props) && Object.keys(props).length >= SCENE_PROP_MAX) return entry;
        props[key] = typeof value === "string" ? value.slice(0, SCENE_STRING_MAX) : value;
      }
      const { props: _drop, ...rest } = entry;
      return Object.keys(props).length > 0 ? { ...rest, props } : rest;
    }),
  };
}

/** Decode one entry's geometry back into a {@link MeshAsset}. */
export function readMeshEntry(entry: MeshSidecarEntry): MeshAsset {
  return deserializeMeshAsset(entry.mesh);
}

/** One row of the Hierarchy panel: an entry and how deep it sits. */
export interface HierarchyRow {
  readonly entry: MeshSidecarEntry;
  readonly depth: number;
  readonly hasChildren: boolean;
}

/**
 * The entries in Hierarchy order: each root followed by its children (depth-first,
 * keeping sidecar order among siblings). Entries whose parent is missing or loops
 * show as roots, matching how the runtime places them.
 */
export function hierarchyRows(sidecar: MeshSidecar): HierarchyRow[] {
  const parents = parentIndices(sidecar.meshes);
  const children = sidecar.meshes.map(() => [] as number[]);
  parents.forEach((p, i) => {
    if (p >= 0) children[p]!.push(i);
  });
  const rows: HierarchyRow[] = [];
  const visit = (i: number, depth: number) => {
    rows.push({ entry: sidecar.meshes[i]!, depth, hasChildren: children[i]!.length > 0 });
    for (const c of children[i]!) visit(c, depth + 1);
  };
  parents.forEach((p, i) => {
    if (p < 0) visit(i, 0);
  });
  return rows;
}

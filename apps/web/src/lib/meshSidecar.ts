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
  composeModelMatrix,
  decomposeModelMatrix,
  deserializeMeshAsset,
  invertAffine,
  multiplyMat4,
  isSceneKey,
  packMeshLibrary,
  parentIndices,
  parseSceneLighting,
  readMeshLibrary,
  readAnimatorSpec,
  readPhysicsSpec,
  readPhysicsWorld,
  readSceneProps,
  readTimelines,
  readLevels,
  readNavMesh,
  readTerrain,
  readStreaming,
  parseParticleEffects,
  type ParticleEffect,
  parseDecalDefs,
  parseDecalMarks,
  parseRagdollColliders,
  parseDebrisDefs,
  type DebrisDef,
  type RagdollBox,
  type DecalDef,
  type DecalMark,
  type SceneStreaming,
  type SerializedTerrain,
  type SerializedNavMesh,
  MAX_LEVELS,
  readSceneTags,
  SCENE_PROP_MAX,
  SCENE_STRING_MAX,
  SCENE_TAG_MAX,
  resolveMeshFrames,
  readStoredLods,
  readFoliage,
  serializeFoliage,
  parseSceneAudio,
  type SceneAudio,
  type SerializedFoliage,
  type StoredLods,
  resolveMeshRef,
  serializeMeshAsset,
  worldMatrices,
  type MeshAsset,
  type AnimatorSpec,
  type PhysicsSpec,
  type PhysicsWorldSettings,
  type SceneLighting,
  type SceneTimeline,
  type SceneLevel,
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
  /** Level-of-detail chain (EP9b): lighter versions of `mesh` swapped in by camera distance (see meshSimplify.ts). */
  readonly lods?: StoredLods;
  /**
   * Scene objects (ENGINE_ROADMAP.md, Phase 1), all optional. `parent` is another
   * entry's id: this entry's transform is then relative to it. `tags` group
   * objects (`cartbox.tagged`) and `props` hold data the cart reads
   * (`cartbox.prop`).
   */
  readonly parent?: string;
  readonly tags?: readonly string[];
  readonly props?: Readonly<Record<string, ScenePropValue>>;
  /** Set when this entry is part of a placed prefab (see meshPrefabs.ts). */
  readonly prefab?: PrefabLink;
  /** Physics body (ENGINE_ROADMAP.md, Phase 2); absent = not simulated. */
  readonly physics?: PhysicsSpec;
  /** Animation state machine for a skinned mesh (ENGINE_ROADMAP.md, Phase 3); absent = plays its first clip. */
  readonly animator?: AnimatorSpec;
  /** The level this object belongs to (a level id); absent = always loaded (see levels.ts in @cartbox/editor). */
  readonly level?: string;
  /** Kept loaded whatever the distance when the scene streams (see streaming.ts in @cartbox/editor). */
  readonly alwaysLoaded?: true;
}

/**
 * An entry's link to the prefab it was placed from: which prefab, which of its
 * nodes this entry is, and which placed copy (the id of that copy's root entry).
 */
export interface PrefabLink {
  readonly id: string;
  readonly node: string;
  readonly instance: string;
}

/** One object inside a prefab: an entry's content, keyed within the prefab. */
export interface PrefabNode {
  readonly key: string;
  readonly name: string;
  readonly mesh: string;
  readonly frames?: readonly string[];
  readonly lods?: StoredLods;
  /** Relative to the parent node; ignored for the root (each copy has its own placement). */
  readonly transform: MeshTransform;
  /** The parent node's key; absent for the root (exactly one node). */
  readonly parent?: string;
  readonly tags?: readonly string[];
  readonly props?: Readonly<Record<string, ScenePropValue>>;
  readonly physics?: PhysicsSpec;
  readonly animator?: AnimatorSpec;
}

/** A reusable group of objects: a root node and everything under it. */
export interface MeshPrefab {
  readonly id: string;
  readonly name: string;
  readonly nodes: readonly PrefabNode[];
  /** Copies held in reserve for cartbox.spawn at run time (0..32; absent = 8). */
  readonly pool?: number;
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
  /** Reusable object groups the creator saved (absent or empty when there are none). */
  readonly prefabs?: readonly MeshPrefab[];
  /** Scene-wide physics settings (absent = the defaults). */
  readonly physicsWorld?: PhysicsWorldSettings;
  /** Cutscenes and scripted camera moves (ENGINE_ROADMAP.md, Phase 3); absent or empty = none. */
  readonly timelines?: readonly SceneTimeline[];
  /** Named levels, one loaded at a time (the first at start); see levels.ts in @cartbox/editor. */
  readonly levels?: readonly SceneLevel[];
  /** The baked walkable surface agents find paths over (see navmesh.ts in @cartbox/editor), as stored. */
  readonly navmesh?: SerializedNavMesh;
  /** Heightfield landscapes (see terrain.ts in @cartbox/editor), as stored; absent or empty = none. */
  readonly terrains?: readonly SerializedTerrain[];
  /** Spatial loading: objects load by distance (see streaming.ts in @cartbox/editor); absent = off. */
  readonly streaming?: SceneStreaming;
  /** 3D particle effects the cart fires with cartbox.burst (see particleEffects.ts in @cartbox/editor). */
  readonly effects?: readonly ParticleEffect[];
  /** Decals the cart lays with cartbox.decal, and permanent marks placed here (see decals.ts in @cartbox/editor). */
  readonly decals?: readonly DecalDef[];
  readonly decalMarks?: readonly DecalMark[];
  /** Boxes ragdolls land on, besides static bodies (see ragdoll.ts in @cartbox/editor). */
  readonly ragdollColliders?: readonly RagdollBox[];
  /** Cosmetic debris the cart throws with cartbox.debris (see debris.ts in @cartbox/editor). */
  readonly debris?: readonly DebrisDef[];
  /** Meshes scattered over the terrains (see foliage.ts in @cartbox/editor), each layer's mesh stored whole. */
  readonly foliage?: readonly SerializedFoliage[];
  /** The scene's sounds, mixer buses and emitters (see sound.ts in @cartbox/editor). */
  readonly audio?: SceneAudio;
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
export function newMeshId(): string {
  return `mesh-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
}

/**
 * Serialize the sidecar for storage. Returns null when there is nothing to keep —
 * no meshes, lighting rig or terrain — so an empty cart stores nothing. A lighting rig
 * alone (meshes removed but the scene still lit) is kept.
 */
export function encodeMeshSidecar(sidecar: MeshSidecar): string | null {
  const prefabs = sidecar.prefabs ?? [];
  if (sidecar.meshes.length === 0 && !sidecar.lighting && prefabs.length === 0 && (sidecar.timelines?.length ?? 0) === 0 && (sidecar.levels?.length ?? 0) === 0 && (sidecar.terrains?.length ?? 0) === 0 && (sidecar.audio?.sounds.length ?? 0) === 0) return null;
  // Repeated meshes (and animation frames) are stored once in a shared library,
  // shared between placed entries and prefab nodes (a prefab's copies repeat its meshes).
  const nodes = prefabs.flatMap((prefab) => prefab.nodes);
  const foliage = sidecar.foliage ?? [];
  const { entries, library } = packMeshLibrary<MeshSidecarEntry | PrefabNode | SerializedFoliage>([...sidecar.meshes, ...nodes, ...foliage]);
  const packedNodes = entries.slice(sidecar.meshes.length, sidecar.meshes.length + nodes.length) as PrefabNode[];
  const packedFoliage = entries.slice(sidecar.meshes.length + nodes.length) as SerializedFoliage[];
  let at = 0;
  const packedPrefabs = prefabs.map((prefab) => {
    const out = { ...prefab, nodes: packedNodes.slice(at, at + prefab.nodes.length) };
    at += prefab.nodes.length;
    return out;
  });
  return JSON.stringify({
    version: MESH_SIDECAR_VERSION,
    meshes: entries.slice(0, sidecar.meshes.length),
    ...(Object.keys(library).length > 0 ? { library } : {}),
    lighting: sidecar.lighting ?? null,
    ...(packedPrefabs.length > 0 ? { prefabs: packedPrefabs } : {}),
    ...(sidecar.physicsWorld?.deterministic ? { physicsWorld: sidecar.physicsWorld } : {}),
    ...(sidecar.timelines && sidecar.timelines.length > 0 ? { timelines: sidecar.timelines } : {}),
    ...(sidecar.levels && sidecar.levels.length > 0 ? { levels: sidecar.levels } : {}),
    ...(sidecar.navmesh ? { navmesh: sidecar.navmesh } : {}),
    ...(sidecar.terrains && sidecar.terrains.length > 0 ? { terrains: sidecar.terrains } : {}),
    ...(sidecar.streaming ? { streaming: sidecar.streaming } : {}),
    ...(sidecar.effects && sidecar.effects.length > 0 ? { effects: sidecar.effects } : {}),
    ...(sidecar.decals && sidecar.decals.length > 0 ? { decals: sidecar.decals } : {}),
    ...(sidecar.decalMarks && sidecar.decalMarks.length > 0 ? { decalMarks: sidecar.decalMarks } : {}),
    ...(sidecar.ragdollColliders && sidecar.ragdollColliders.length > 0 ? { ragdollColliders: sidecar.ragdollColliders } : {}),
    ...(sidecar.debris && sidecar.debris.length > 0 ? { debris: sidecar.debris } : {}),
    ...(packedFoliage.length > 0 ? { foliage: packedFoliage } : {}),
    ...(sidecar.audio && sidecar.audio.sounds.length > 0 ? { audio: sidecar.audio } : {}),
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
    const lods = readStoredLods(record.lods, (level) => resolveMeshRef(level, library));
    const tags = readSceneTags(record.tags);
    const props = readSceneProps(record.props);
    meshes.push({
      id: typeof record.id === "string" ? record.id : newMeshId(),
      name: typeof record.name === "string" ? record.name : "Mesh",
      mesh,
      transform: readTransform(record.transform),
      ...(frames.length > 0 ? { frames } : {}),
      ...(lods ? { lods } : {}),
      ...(typeof record.parent === "string" && record.parent ? { parent: record.parent } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(Object.keys(props).length > 0 ? { props } : {}),
      ...(readPrefabLink(record.prefab) ? { prefab: readPrefabLink(record.prefab)! } : {}),
      ...(readPhysicsSpec(record.physics) ? { physics: readPhysicsSpec(record.physics)! } : {}),
      ...(readAnimatorSpec(record.animator) ? { animator: readAnimatorSpec(record.animator)! } : {}),
      ...(typeof record.level === "string" && record.level ? { level: record.level } : {}),
      ...(record.alwaysLoaded === true ? { alwaysLoaded: true as const } : {}),
    });
  }
  const lighting = parseSceneLighting((parsed as { lighting?: unknown }).lighting);
  const prefabs = readPrefabs((parsed as { prefabs?: unknown }).prefabs, library, isValid);
  // A link to a prefab (or node) that didn't survive decoding is dropped.
  const known = new Map(prefabs.map((p) => [p.id, new Set(p.nodes.map((n) => n.key))]));
  const linked = meshes.map((entry) =>
    entry.prefab && !known.get(entry.prefab.id)?.has(entry.prefab.node) ? withoutLink(entry) : entry,
  );
  const physicsWorld = readPhysicsWorld((parsed as { physicsWorld?: unknown }).physicsWorld);
  const timelines = readTimelines((parsed as { timelines?: unknown }).timelines);
  // An object in a level that no longer exists is always loaded.
  const levels = readLevels((parsed as { levels?: unknown }).levels);
  // Terrains are kept as stored, each once it reads back as a valid heightfield.
  const storedTerrains = (parsed as { terrains?: unknown }).terrains;
  const terrains = Array.isArray(storedTerrains) ? (storedTerrains.filter((t) => readTerrain(t) !== null) as SerializedTerrain[]) : [];
  const levelIds = new Set(levels.map((l) => l.id));
  const effects = parseParticleEffects((parsed as { effects?: unknown }).effects);
  const decals = parseDecalDefs((parsed as { decals?: unknown }).decals);
  const decalMarks = parseDecalMarks((parsed as { decalMarks?: unknown }).decalMarks, decals);
  const ragdollColliders = parseRagdollColliders((parsed as { ragdollColliders?: unknown }).ragdollColliders);
  const debris = parseDebrisDefs((parsed as { debris?: unknown }).debris);
  const foliage = readFoliageLayers((parsed as { foliage?: unknown }).foliage, terrains, library, isValid);
  const audio = parseSceneAudio((parsed as { audio?: unknown }).audio);
  const placed = linked.map((entry) => (entry.level && !levelIds.has(entry.level) ? withoutLevel(entry) : entry));
  return {
    version: MESH_SIDECAR_VERSION,
    meshes: placed,
    lighting,
    ...(prefabs.length > 0 ? { prefabs } : {}),
    ...(physicsWorld ? { physicsWorld } : {}),
    ...(timelines.length > 0 ? { timelines } : {}),
    ...(levels.length > 0 ? { levels } : {}),
    // Kept as stored, once it reads back as a valid surface.
    ...(readNavMesh((parsed as { navmesh?: unknown }).navmesh) ? { navmesh: (parsed as { navmesh: SerializedNavMesh }).navmesh } : {}),
    ...(terrains.length > 0 ? { terrains } : {}),
    ...(readStreaming((parsed as { streaming?: unknown }).streaming) ? { streaming: readStreaming((parsed as { streaming?: unknown }).streaming)! } : {}),
    ...(effects.length > 0 ? { effects } : {}),
    ...(decals.length > 0 ? { decals } : {}),
    ...(decalMarks.length > 0 ? { decalMarks } : {}),
    ...(ragdollColliders.length > 0 ? { ragdollColliders } : {}),
    ...(debris.length > 0 ? { debris } : {}),
    ...(foliage.length > 0 ? { foliage } : {}),
    ...(audio ? { audio } : {}),
  };
}

/** Replace the scene's audio (no sounds removes it). */
export function setMeshAudio(sidecar: MeshSidecar, audio: SceneAudio | null): MeshSidecar {
  const { audio: _drop, ...rest } = sidecar;
  void _drop;
  return audio && audio.sounds.length > 0 ? { ...rest, audio } : rest;
}

/** Read stored foliage layers: each must sit on a terrain the sidecar has and carry a mesh that decodes; its mesh is resolved from the library. */
function readFoliageLayers(value: unknown, terrains: readonly SerializedTerrain[], library: ReturnType<typeof readMeshLibrary>, isValid: (mesh: string) => boolean): SerializedFoliage[] {
  if (!Array.isArray(value)) return [];
  const sizes = terrains.map((t) => ({ id: t.id, size: t.size }));
  const out: SerializedFoliage[] = [];
  for (const raw of value) {
    const read = readFoliage(raw, sizes);
    const mesh = read ? resolveMeshRef(read.mesh, library) : null;
    if (!read || !mesh || !isValid(mesh)) continue;
    const t = sizes.find((x) => x.id === read.layer.terrain)!;
    out.push(serializeFoliage(t, read.layer, mesh));
  }
  return out;
}

/** Replace the scene's foliage layers (an empty list removes them). */
export function setMeshFoliage(sidecar: MeshSidecar, foliage: readonly SerializedFoliage[]): MeshSidecar {
  const { foliage: _drop, ...rest } = sidecar;
  void _drop;
  return foliage.length > 0 ? { ...rest, foliage } : rest;
}

/**
 * Replace the scene's decals and permanent marks (marks naming a decal that's
 * gone are dropped; empty lists remove the fields).
 */
export function setMeshDecals(sidecar: MeshSidecar, decals: readonly DecalDef[], marks: readonly DecalMark[] = sidecar.decalMarks ?? []): MeshSidecar {
  const { decals: _d, decalMarks: _m, ...rest } = sidecar;
  const defs = parseDecalDefs(decals);
  const kept = parseDecalMarks(marks, defs);
  return { ...rest, ...(defs.length > 0 ? { decals: defs } : {}), ...(kept.length > 0 ? { decalMarks: kept } : {}) };
}

/** Replace the scene's particle effects (an empty list removes them). */
export function setMeshEffects(sidecar: MeshSidecar, effects: readonly ParticleEffect[]): MeshSidecar {
  const { effects: _drop, ...rest } = sidecar;
  const clean = parseParticleEffects(effects);
  return clean.length > 0 ? { ...rest, effects: clean } : rest;
}

/** Set (or with null, clear) the scene's baked walkable surface. */
export function setMeshNavMesh(sidecar: MeshSidecar, navmesh: SerializedNavMesh | null): MeshSidecar {
  const { navmesh: _drop, ...rest } = sidecar;
  return navmesh ? { ...rest, navmesh } : rest;
}

function withoutLevel(entry: MeshSidecarEntry): MeshSidecarEntry {
  const { level: _drop, ...rest } = entry;
  return rest;
}

function withoutLink(entry: MeshSidecarEntry): MeshSidecarEntry {
  const { prefab: _drop, ...rest } = entry;
  return rest;
}

function readPrefabLink(value: unknown): PrefabLink | null {
  const raw = value as Partial<PrefabLink> | null | undefined;
  if (!raw || typeof raw.id !== "string" || typeof raw.node !== "string" || typeof raw.instance !== "string") return null;
  return { id: raw.id, node: raw.node, instance: raw.instance };
}

/** Read stored prefabs, dropping invalid nodes and any prefab left without exactly one root. */
function readPrefabs(value: unknown, library: ReturnType<typeof readMeshLibrary>, isValid: (mesh: string) => boolean): MeshPrefab[] {
  if (!Array.isArray(value)) return [];
  const out: MeshPrefab[] = [];
  for (const item of value) {
    const raw = item as { id?: unknown; name?: unknown; nodes?: unknown };
    if (typeof raw.id !== "string" || !Array.isArray(raw.nodes)) continue;
    const nodes: PrefabNode[] = [];
    for (const n of raw.nodes) {
      const node = n as Partial<PrefabNode> & { frames?: unknown; tags?: unknown; props?: unknown };
      if (typeof node.key !== "string" || typeof node.mesh !== "string") continue;
      const mesh = resolveMeshRef(node.mesh, library);
      if (!mesh || !isValid(mesh)) continue;
      const frames = resolveMeshFrames(node.frames, library).filter(isValid);
      const lods = readStoredLods(node.lods, (level) => resolveMeshRef(level, library));
      const tags = readSceneTags(node.tags);
      const props = readSceneProps(node.props);
      nodes.push({
        key: node.key,
        name: typeof node.name === "string" ? node.name : "Mesh",
        mesh,
        transform: readTransform(node.transform),
        ...(frames.length > 0 ? { frames } : {}),
        ...(lods ? { lods } : {}),
        ...(typeof node.parent === "string" && node.parent ? { parent: node.parent } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(Object.keys(props).length > 0 ? { props } : {}),
        ...(readPhysicsSpec(node.physics) ? { physics: readPhysicsSpec(node.physics)! } : {}),
        ...(readAnimatorSpec(node.animator) ? { animator: readAnimatorSpec(node.animator)! } : {}),
      });
    }
    const keys = new Set(nodes.map((n) => n.key));
    // Orphaned nodes (parent missing) are dropped; the prefab needs exactly one root.
    const kept = nodes.filter((n) => !n.parent || keys.has(n.parent));
    if (kept.filter((n) => !n.parent).length !== 1) continue;
    const poolRaw = (item as { pool?: unknown }).pool;
    const pool = typeof poolRaw === "number" && Number.isFinite(poolRaw) ? Math.max(0, Math.min(32, Math.floor(poolRaw))) : undefined;
    out.push({ id: raw.id, name: typeof raw.name === "string" ? raw.name : "Prefab", nodes: kept, ...(pool !== undefined ? { pool } : {}) });
  }
  return out;
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

/** Replace the scene's timelines (validated; an empty list removes them). */
export function setMeshTimelines(sidecar: MeshSidecar, timelines: readonly SceneTimeline[]): MeshSidecar {
  const { timelines: _drop, ...rest } = sidecar;
  const next = readTimelines(timelines);
  return next.length > 0 ? { ...rest, timelines: next } : rest;
}

/** Set the scene-wide physics settings (null restores the defaults). */
/** Add a level (named "Level n" unless given a name); returns the sidecar and the new level's id. */
export function addLevel(sidecar: MeshSidecar, name?: string): { sidecar: MeshSidecar; id: string } {
  const levels = sidecar.levels ?? [];
  if (levels.length >= MAX_LEVELS) return { sidecar, id: levels[levels.length - 1]!.id };
  const id = `level-${Math.random().toString(36).slice(2, 10)}`;
  return { sidecar: { ...sidecar, levels: [...levels, { id, name: name?.trim().slice(0, 40) || `Level ${levels.length + 1}` }] }, id };
}

export function renameLevel(sidecar: MeshSidecar, id: string, name: string): MeshSidecar {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return sidecar;
  return { ...sidecar, levels: (sidecar.levels ?? []).map((l) => (l.id === id ? { ...l, name: trimmed } : l)) };
}

/** Remove a level; its objects become always loaded. */
export function removeLevel(sidecar: MeshSidecar, id: string): MeshSidecar {
  const levels = (sidecar.levels ?? []).filter((l) => l.id !== id);
  const meshes = sidecar.meshes.map((m) => (m.level === id ? withoutLevel(m) : m));
  const { levels: _old, ...rest } = sidecar;
  return { ...rest, meshes, ...(levels.length > 0 ? { levels } : {}) };
}

/** Make a level the one the cart starts in (the first). */
export function setStartLevel(sidecar: MeshSidecar, id: string): MeshSidecar {
  const levels = sidecar.levels ?? [];
  const level = levels.find((l) => l.id === id);
  return level ? { ...sidecar, levels: [level, ...levels.filter((l) => l.id !== id)] } : sidecar;
}

/** Put an object in a level, or (null) make it always loaded. */
export function setMeshLevel(sidecar: MeshSidecar, id: string, level: string | null): MeshSidecar {
  if (level !== null && !(sidecar.levels ?? []).some((l) => l.id === level)) return sidecar;
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => (m.id !== id ? m : level ? { ...m, level } : withoutLevel(m))),
  };
}

/** Turn spatial loading on (with its range) or, with null, off. */
export function setMeshStreaming(sidecar: MeshSidecar, streaming: SceneStreaming | null): MeshSidecar {
  const { streaming: _drop, ...rest } = sidecar;
  return streaming ? { ...rest, streaming: readStreaming(streaming)! } : rest;
}

/** Keep an object loaded whatever the distance (or let it load by distance again). */
export function setMeshAlwaysLoaded(sidecar: MeshSidecar, id: string, always: boolean): MeshSidecar {
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => {
      if (m.id !== id) return m;
      const { alwaysLoaded: _drop, ...rest } = m;
      return always ? { ...rest, alwaysLoaded: true as const } : rest;
    }),
  };
}

export function setMeshPhysicsWorld(sidecar: MeshSidecar, world: PhysicsWorldSettings | null): MeshSidecar {
  const { physicsWorld: _drop, ...rest } = sidecar;
  const next = world ? readPhysicsWorld(world) : null;
  return next ? { ...rest, physicsWorld: next } : rest;
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

/** Set (or with null, remove) one entry's animation state machine. */
export function setMeshAnimator(sidecar: MeshSidecar, id: string, animator: AnimatorSpec | null): MeshSidecar {
  const spec = animator ? readAnimatorSpec(animator) : null;
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((entry) => {
      if (entry.id !== id) return entry;
      const { animator: _drop, ...rest } = entry;
      return spec ? { ...rest, animator: spec } : rest;
    }),
  };
}

/** Set (or with null, remove) one entry's physics body. */
export function setMeshPhysics(sidecar: MeshSidecar, id: string, physics: PhysicsSpec | null): MeshSidecar {
  const spec = physics ? readPhysicsSpec(physics) : null;
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => {
      if (entry.id !== id) return entry;
      const { physics: _drop, ...rest } = entry;
      return spec ? { ...rest, physics: spec } : rest;
    }),
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

/** Every entry's world matrix, index-aligned with `sidecar.meshes`. */
export function meshWorldMatrices(sidecar: MeshSidecar) {
  return worldMatrices(
    sidecar.meshes.map(({ transform: t }) => composeModelMatrix(t.position, t.rotation, t.scale)),
    parentIndices(sidecar.meshes),
  );
}

/**
 * Parent `id` to `parentId` (null makes it a root). By default the object stays
 * where it is in the world: its transform is rewritten relative to the new parent.
 * With `keepWorld` false the transform is kept as-is, so the object moves to sit
 * under its new parent. A parent that would create a cycle (itself or one of its
 * descendants) or doesn't exist is refused: the sidecar comes back unchanged.
 */
export function setMeshParent(
  sidecar: MeshSidecar,
  id: string,
  parentId: string | null,
  { keepWorld = true }: { keepWorld?: boolean } = {},
): MeshSidecar {
  if (parentId !== null && !parentCandidates(sidecar, id).some((entry) => entry.id === parentId)) return sidecar;
  let transform: MeshTransform | null = null;
  if (keepWorld) {
    const world = meshWorldMatrices(sidecar);
    const self = sidecar.meshes.findIndex((entry) => entry.id === id);
    const parent = parentId === null ? -1 : sidecar.meshes.findIndex((entry) => entry.id === parentId);
    if (self >= 0) {
      const inverse = parent >= 0 ? invertAffine(world[parent]!) : null;
      if (parent < 0 || inverse) transform = decomposeModelMatrix(inverse ? multiplyMat4(inverse, world[self]!) : world[self]!);
    }
  }
  return {
    ...sidecar,
    version: MESH_SIDECAR_VERSION,
    meshes: sidecar.meshes.map((entry) => {
      if (entry.id !== id) return entry;
      const next = withParent(entry, parentId);
      return transform ? { ...next, transform } : next;
    }),
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

/** Replace the scene's debris definitions (an empty list removes them). */
export function setMeshDebris(sidecar: MeshSidecar, debris: readonly DebrisDef[]): MeshSidecar {
  const { debris: _old, ...rest } = sidecar;
  const defs = parseDebrisDefs(debris);
  return defs.length > 0 ? { ...rest, debris: defs } : rest;
}

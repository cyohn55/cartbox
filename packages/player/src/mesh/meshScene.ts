/**
 * The runtime mesh scene: the cart's mesh sidecar resolved into placed instances
 * the software rasteriser can draw. This is the player-side counterpart to the
 * editor's `MeshSidecar` — it decodes the same stored JSON but yields ready-to-
 * render geometry (a decoded {@link MeshAsset} plus a baked model matrix) rather
 * than the editable envelope.
 *
 * Kept pure and DOM-free so the parse + camera maths are unit-testable: texture
 * decoding (which needs the browser) is the surface's job, not this module's. A
 * malformed sidecar never throws into the run loop — bad entries are dropped, and
 * an empty or unparseable payload yields null (the cart plays without meshes).
 */

import {
  composeModelMatrix,
  deserializeMeshAsset,
  meshBounds,
  parentIndices,
  parseSceneLighting,
  projectionMatrix,
  readMeshLibrary,
  readPhysicsSpec,
  readSceneProps,
  readSceneTags,
  worldMatrices,
  resolveMeshFrames,
  resolveMeshRef,
  viewMatrix,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
  type PhysicsSpec,
  type SceneLighting,
  type ScenePropValue,
} from "@cartbox/editor";

/** One placed mesh ready to rasterise: decoded geometry + its baked world matrix. */
export interface MeshInstance extends MeshSceneInstance {
  readonly mesh: MeshAsset;
  readonly model: Mat4;
  /**
   * Optional animation frames: alternate meshes a cart selects per frame through
   * a pose's `frame` (1 = frames[0], …; 0 keeps the base mesh). Instances that
   * share frames share the MeshAsset objects.
   */
  readonly frames?: readonly MeshAsset[];
  /**
   * Scene-object data (ENGINE_ROADMAP.md, Phase 1). `model` is the world matrix;
   * `local` is the authored transform relative to `parent` (an index into the
   * scene's instances, -1 for a root). For a root, `local === model`.
   */
  readonly local: Mat4;
  readonly parent: number;
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly props: Readonly<Record<string, ScenePropValue>>;
  /** The object's physics body, or null (ENGINE_ROADMAP.md, Phase 2). */
  readonly physics: PhysicsSpec | null;
  /**
   * Set on the objects of a prefab copy held in reserve for `cartbox.spawn`: which
   * prefab, which copy, and the copy's root index. Hidden until spawned.
   */
  readonly pooled?: { readonly prefab: string; readonly copy: number; readonly root: number };
}

/** A prefab's reserve of spawnable copies: each copy's root object index. */
export interface PrefabPool {
  readonly prefab: string;
  readonly roots: readonly number[];
}

/** Copies of each prefab held in reserve for cartbox.spawn when the sidecar doesn't say. */
export const DEFAULT_PREFAB_POOL = 8;
export const MAX_PREFAB_POOL = 32;

/** A world-space axis-aligned bounding box with a framing centre + radius. */
export interface SceneBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  /** Half the bounding sphere's diameter — the radius the camera frames. */
  readonly radius: number;
}

/** The parsed runtime scene: every placed mesh, their shared world bounds, and the lighting rig. */
export interface MeshScene {
  readonly instances: readonly MeshInstance[];
  /** Prefabs code can spawn copies of (their copies are hidden instances at the end). */
  readonly pools?: readonly PrefabPool[];
  readonly bounds: SceneBounds;
  /** The authored Modern-tier lighting rig, or null when the cart set none. */
  readonly lighting: SceneLighting | null;
}

/** A view + projection pair ready to hand to `renderMeshScene`. */
export interface SceneCamera {
  readonly view: Mat4;
  readonly projection: Mat4;
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** Read one placement transform, falling back to the identity for any bad field. */
function readTransform(value: unknown): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    position: isFiniteTriple(raw.position) ? raw.position : [0, 0, 0],
    rotation: isFiniteTriple(raw.rotation) ? raw.rotation : [0, 0, 0],
    scale: isFiniteTriple(raw.scale) ? raw.scale : [1, 1, 1],
  };
}

/** Transform an object-space point by a column-major model matrix. */
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Union the world-space bounds of every instance into one framing box. */
function sceneBounds(instances: readonly MeshInstance[]): SceneBounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const instance of instances) {
    const local = meshBounds(instance.mesh);
    if (!local) continue;
    // Transform all eight corners: a rotated box's extent isn't its rotated min/max.
    for (let corner = 0; corner < 8; corner += 1) {
      const cx = corner & 1 ? local.max[0] : local.min[0];
      const cy = corner & 2 ? local.max[1] : local.min[1];
      const cz = corner & 4 ? local.max[2] : local.min[2];
      const [wx, wy, wz] = transformPoint(instance.model, cx, cy, cz);
      minX = Math.min(minX, wx);
      minY = Math.min(minY, wy);
      minZ = Math.min(minZ, wz);
      maxX = Math.max(maxX, wx);
      maxY = Math.max(maxY, wy);
      maxZ = Math.max(maxZ, wz);
    }
  }

  if (!Number.isFinite(minX)) {
    // No geometry contributed bounds — a degenerate unit box keeps the camera sane.
    return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], center: [0, 0, 0], radius: 1 };
  }
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(1e-3, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center, radius };
}

/**
 * Parse a cart's stored mesh sidecar into a runtime {@link MeshScene}. Returns
 * null when there is nothing to render (no payload, unparseable JSON, or every
 * entry dropped as malformed), so the player can skip the mesh surface entirely.
 */
export function parseMeshScene(raw: string | null | undefined): MeshScene | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = (parsed as { meshes?: unknown }).meshes;
  if (!Array.isArray(entries)) return null;

  const library = readMeshLibrary((parsed as { library?: unknown }).library);
  // Deserialize each distinct mesh string once: instances that share a model
  // share one MeshAsset (and so one texture decode and one GPU upload).
  const cache = new Map<string, MeshAsset | null>();
  const load = (serialized: string): MeshAsset | null => {
    if (!cache.has(serialized)) {
      try {
        cache.set(serialized, deserializeMeshAsset(serialized));
      } catch {
        cache.set(serialized, null); // invalid geometry drops the entry
      }
    }
    return cache.get(serialized) ?? null;
  };
  type Parsed = Omit<MeshInstance, "model" | "parent" | "pooled"> & {
    parentId: string | null;
    pool?: { prefab: string; copy: number; rootId: string };
  };
  type Record_ = { mesh?: unknown; transform?: unknown; frames?: unknown; id?: unknown; name?: unknown; parent?: unknown; tags?: unknown; props?: unknown; physics?: unknown };
  const readEntry = (record: Record_, id: string, parentId: string | null, identity = false): Parsed | null => {
    if (typeof record.mesh !== "string") return null;
    const resolved = resolveMeshRef(record.mesh, library);
    const mesh = resolved ? load(resolved) : null;
    if (!mesh) return null;
    const frames = resolveMeshFrames(record.frames, library)
      .map(load)
      .filter((frame): frame is MeshAsset => frame !== null);
    const t = identity ? { position: [0, 0, 0] as const, rotation: [0, 0, 0] as const, scale: [1, 1, 1] as const } : readTransform(record.transform);
    return {
      mesh,
      local: composeModelMatrix(t.position, t.rotation, t.scale),
      ...(frames.length > 0 ? { frames } : {}),
      id,
      name: typeof record.name === "string" ? record.name : "Mesh",
      tags: readSceneTags(record.tags),
      props: readSceneProps(record.props),
      physics: readPhysicsSpec(record.physics),
      parentId,
    };
  };
  const parsedInstances: Parsed[] = [];
  for (const entry of entries) {
    const record = entry as Record_;
    const parsedEntry = readEntry(
      record,
      typeof record.id === "string" ? record.id : `mesh-${parsedInstances.length}`,
      typeof record.parent === "string" && record.parent ? record.parent : null,
    );
    if (parsedEntry) parsedInstances.push(parsedEntry);
  }
  // Prefabs: a reserve of hidden copies per prefab, which cartbox.spawn brings
  // into the world. Each copy's root sits at the origin until spawned.
  const poolRoots = new Map<string, string[]>();
  const prefabs = (parsed as { prefabs?: unknown }).prefabs;
  if (Array.isArray(prefabs)) {
    for (const item of prefabs) {
      const prefab = item as { id?: unknown; name?: unknown; pool?: unknown; nodes?: unknown };
      if (typeof prefab.id !== "string" || !Array.isArray(prefab.nodes)) continue;
      const name = typeof prefab.name === "string" ? prefab.name : "Prefab";
      const size =
        typeof prefab.pool === "number" && Number.isFinite(prefab.pool)
          ? Math.max(0, Math.min(MAX_PREFAB_POOL, Math.floor(prefab.pool)))
          : DEFAULT_PREFAB_POOL;
      const nodes = (prefab.nodes as (Record_ & { key?: unknown })[]).filter((n) => typeof n.key === "string");
      const root = nodes.find((n) => typeof n.parent !== "string" || !n.parent);
      if (!root || size === 0) continue;
      for (let copy = 0; copy < size; copy += 1) {
        const idOf = (key: unknown) => `${prefab.id}#${copy}:${String(key)}`;
        const rootId = idOf(root.key);
        const made: Parsed[] = [];
        for (const node of nodes) {
          const isRoot = node === root;
          const entry = readEntry(node, idOf(node.key), isRoot ? null : idOf(node.parent), isRoot);
          if (!entry) continue;
          made.push({ ...entry, ...(isRoot ? { name: `${name} ${copy + 1}` } : {}), pool: { prefab: name, copy, rootId } });
        }
        if (!made.some((m) => m.id === rootId)) continue; // the root's mesh didn't load
        parsedInstances.push(...made);
        poolRoots.set(name, [...(poolRoots.get(name) ?? []), rootId]);
      }
    }
  }
  // Children sit relative to their parent: world = parent world · local. A parent
  // that was dropped (or never existed, or loops) leaves the child a root.
  const parents = parentIndices(parsedInstances.map((p) => ({ id: p.id, parent: p.parentId })));
  const world = worldMatrices(
    parsedInstances.map((p) => p.local),
    parents,
  );
  const indexOf = new Map(parsedInstances.map((p, i) => [p.id, i]));
  const instances: MeshInstance[] = parsedInstances.map(({ parentId: _parentId, pool, ...rest }, i) => ({
    ...rest,
    model: world[i]!,
    parent: parents[i]!,
    ...(pool ? { pooled: { prefab: pool.prefab, copy: pool.copy, root: indexOf.get(pool.rootId)! } } : {}),
  }));

  if (instances.length === 0) return null;
  const lighting = parseSceneLighting((parsed as { lighting?: unknown }).lighting);
  const pools: PrefabPool[] = [...poolRoots.entries()].map(([prefab, ids]) => ({ prefab, roots: ids.map((id) => indexOf.get(id)!) }));
  // Reserve copies sit hidden at the origin: they don't count toward the framing bounds.
  const placed = instances.filter((instance) => !instance.pooled);
  return { instances, bounds: sceneBounds(placed.length > 0 ? placed : instances), lighting, ...(pools.length > 0 ? { pools } : {}) };
}

/** Optional overrides a cart supplies via `cartbox.meshcam(...)` (see the mailbox). */
export interface OrbitCameraOptions {
  /** Vertical field of view, radians; defaults to ~50°. */
  readonly fov?: number;
  /** Explicit distance from the target, world units; omitted/≤0 auto-fits the scene. */
  readonly distance?: number | null;
  /** Offset added to the scene centre to aim the camera, world units. */
  readonly targetOffset?: readonly [number, number, number];
  /**
   * Near clip distance, world units; omitted scales it with the scene (5% of the
   * radius — right for an orbit framing the whole scene, but a first-person eye
   * inside the scene would clip everything within a metre, its own weapon and
   * any wall it stands beside included).
   */
  readonly near?: number;
}

/**
 * Build an orbit camera that frames the scene bounds from `yaw`/`pitch`, fitting
 * the whole scene into the vertical field of view. `aspect` is the framebuffer's
 * width/height, so the projection is undistorted on the runtime's non-square
 * screen. With no options this auto-fits the scene (the player's gentle P2
 * auto-orbit); a cart drives it explicitly through `options` via the mesh camera.
 */
export function buildOrbitCamera(
  bounds: SceneBounds,
  yaw: number,
  pitch: number,
  aspect: number,
  options: OrbitCameraOptions = {},
): SceneCamera {
  const { radius } = bounds;
  const fovY = options.fov && options.fov > 0 ? options.fov : (50 * Math.PI) / 180;
  const target: [number, number, number] = [
    bounds.center[0] + (options.targetOffset?.[0] ?? 0),
    bounds.center[1] + (options.targetOffset?.[1] ?? 0),
    bounds.center[2] + (options.targetOffset?.[2] ?? 0),
  ];
  // Auto-fit: the distance that frames the bounding sphere in the vertical FOV,
  // plus its radius so the near face never clips the frame edge. A cart can
  // override it (e.g. to push in or pull back) via options.distance.
  const distance = options.distance && options.distance > 0 ? options.distance : radius / Math.sin(fovY / 2) + radius;
  const cosPitch = Math.cos(pitch);
  const eye: [number, number, number] = [
    target[0] + distance * cosPitch * Math.sin(yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * cosPitch * Math.cos(yaw),
  ];
  return {
    view: viewMatrix(eye, target),
    projection: projectionMatrix(
      fovY,
      aspect,
      options.near && options.near > 0 ? options.near : Math.max(0.01, radius * 0.05),
      distance + radius * 4,
    ),
  };
}

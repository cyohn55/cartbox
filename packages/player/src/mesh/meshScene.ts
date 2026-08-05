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
  projectionMatrix,
  viewMatrix,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";

/** One placed mesh ready to rasterise: decoded geometry + its baked world matrix. */
export interface MeshInstance extends MeshSceneInstance {
  readonly mesh: MeshAsset;
  readonly model: Mat4;
}

/** A world-space axis-aligned bounding box with a framing centre + radius. */
export interface SceneBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  /** Half the bounding sphere's diameter — the radius the camera frames. */
  readonly radius: number;
}

/** The parsed runtime scene: every placed mesh and their shared world bounds. */
export interface MeshScene {
  readonly instances: readonly MeshInstance[];
  readonly bounds: SceneBounds;
}

/** A view + projection pair ready to hand to `renderMeshScene`. */
export interface SceneCamera {
  readonly view: Mat4;
  readonly projection: Mat4;
}

const DEFAULT_TRIPLE: readonly [number, number, number] = [0, 0, 0];

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

  const instances: MeshInstance[] = [];
  for (const entry of entries) {
    const record = entry as { mesh?: unknown; transform?: unknown };
    if (typeof record.mesh !== "string") continue;
    let mesh: MeshAsset;
    try {
      mesh = deserializeMeshAsset(record.mesh); // drops the entry if geometry is invalid
    } catch {
      continue;
    }
    const t = readTransform(record.transform);
    instances.push({ mesh, model: composeModelMatrix(t.position, t.rotation, t.scale) });
  }

  if (instances.length === 0) return null;
  return { instances, bounds: sceneBounds(instances) };
}

/** Optional overrides a cart supplies via `cartbox.meshcam(...)` (see the mailbox). */
export interface OrbitCameraOptions {
  /** Vertical field of view, radians; defaults to ~50°. */
  readonly fov?: number;
  /** Explicit distance from the target, world units; omitted/≤0 auto-fits the scene. */
  readonly distance?: number | null;
  /** Offset added to the scene centre to aim the camera, world units. */
  readonly targetOffset?: readonly [number, number, number];
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
    projection: projectionMatrix(fovY, aspect, Math.max(0.01, radius * 0.05), distance + radius * 4),
  };
}

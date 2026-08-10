/**
 * The HD-2D "world" model: a height-mapped tile grid drawn as real 3D geometry,
 * with 2D character sprites composited into it as camera-facing billboards. This
 * is the piece that makes "the world is 3D, the characters are 2D" expressible in
 * a shipped cart — the gap the first Octopath pass had to fake in Lua.
 *
 * The trick is to lean entirely on the existing z-buffered software rasteriser
 * ({@link renderMeshScene}): terrain cells become textured quads, and each
 * character becomes a textured quad turned to face the camera. Because both flow
 * through one shared depth buffer, a billboard standing behind a raised tile is
 * occluded by it and one standing in front draws over it — correct HD-2D
 * occlusion, for free, with no new rasteriser. Textures come from the cart's own
 * sprite sheet (palette index 0 → transparent), so a character's silhouette is a
 * true alpha cutout.
 *
 * This module is pure geometry: it takes a parsed {@link WorldScene} and a
 * texture lookup and returns {@link MeshSceneInstance}s plus a camera. All WASM
 * reads and frame compositing live in {@link WorldOverlaySurface}. DOM-free and
 * unit-testable.
 */

import {
  type DecodedTexture,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
  projectionMatrix,
  viewMatrix,
} from "@cartbox/editor";

/** One terrain cell: a stack height (in height units) and the tile sprite on top. */
export interface WorldTileCell {
  /** Height of the cell's top face, in height units (0 = floor). */
  readonly h: number;
  /** Sprite id of the tile block drawn on the cell's top (and walls). */
  readonly sprite: number;
}

/** A declarative billboard slot: the sprite art a character instance draws with.
 *  Its position is supplied per-frame by the cart (see WorldOverlaySurface). */
export interface WorldBillboard {
  /** Sprite id of the block used as the billboard's texture. */
  readonly sprite: number;
  /** Width in world units (the quad spans this across the camera's right axis). */
  readonly width: number;
  /** Height in world units (the quad rises this along the camera's up axis). */
  readonly height: number;
}

/** A cart's authored 3D world: a tile grid + the billboard slots that live in it. */
export interface WorldScene {
  readonly cols: number;
  readonly rows: number;
  /** Sprite block size in 8px tiles per side (4 → a 32×32 sprite per cell). */
  readonly tilesPerSide: number;
  /** cols×rows cells, row-major (`cells[j * cols + i]`). */
  readonly cells: readonly WorldTileCell[];
  /** Declarative billboard slots the cart moves each frame by index. */
  readonly billboards: readonly WorldBillboard[];
  /** Default camera framing when the cart drives none. */
  readonly camera?: WorldCameraSpec;
}

export interface WorldCameraSpec {
  /** Orbit yaw around the world centre, radians. */
  readonly yaw: number;
  /** Orbit pitch (downward tilt), radians. */
  readonly pitch: number;
  /** Distance from the framed centre; 0 → auto-fit. */
  readonly distance: number;
  /** Vertical field of view, radians; 0 → default. */
  readonly fov: number;
}

/** One world cell spans a unit square in XZ; one height unit raises it this much. */
export const CELL_WORLD = 1;
export const HEIGHT_WORLD = 0.6;
const DEFAULT_FOV = (42 * Math.PI) / 180;
const DEFAULT_YAW = Math.PI / 4; // classic 45° isometric-ish framing
const DEFAULT_PITCH = 0.62; // look down onto the terrain

/** Look up a decoded texture for a sprite id (cached by the surface). */
export type TextureLookup = (sprite: number) => DecodedTexture | null;

/**
 * Parse the stored world sidecar (opaque JSON string) into a {@link WorldScene},
 * or null when absent/invalid — mirroring the other sidecars' defensive parse so
 * a malformed payload makes the cart play without a world rather than crash.
 */
export function parseWorldScene(raw: string | null | undefined): WorldScene | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const cols = asInt(record.cols);
  const rows = asInt(record.rows);
  const tilesPerSide = asInt(record.tilesPerSide);
  if (cols <= 0 || rows <= 0 || tilesPerSide <= 0) return null;
  const rawCells = Array.isArray(record.cells) ? record.cells : [];
  if (rawCells.length !== cols * rows) return null;
  const cells: WorldTileCell[] = rawCells.map((cell) => {
    const c = (cell ?? {}) as Record<string, unknown>;
    return { h: Math.max(0, asInt(c.h)), sprite: Math.max(0, asInt(c.sprite)) };
  });
  const rawBillboards = Array.isArray(record.billboards) ? record.billboards : [];
  const billboards: WorldBillboard[] = rawBillboards.map((bb) => {
    const b = (bb ?? {}) as Record<string, unknown>;
    return {
      sprite: Math.max(0, asInt(b.sprite)),
      width: asFloat(b.width, 1),
      height: asFloat(b.height, 1),
    };
  });
  const camera = parseCamera(record.camera);
  return { cols, rows, tilesPerSide, cells, billboards, camera };
}

function parseCamera(value: unknown): WorldCameraSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const c = value as Record<string, unknown>;
  return {
    yaw: asFloat(c.yaw, DEFAULT_YAW),
    pitch: asFloat(c.pitch, DEFAULT_PITCH),
    distance: asFloat(c.distance, 0),
    fov: asFloat(c.fov, 0),
  };
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function asFloat(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a cell, clamping out-of-bounds to a floor cell so edge walls close. */
export function cellAt(scene: WorldScene, i: number, j: number): WorldTileCell {
  if (i < 0 || j < 0 || i >= scene.cols || j >= scene.rows) return { h: -1, sprite: 0 };
  return scene.cells[j * scene.cols + i] ?? { h: 0, sprite: 0 };
}

// --- Terrain geometry --------------------------------------------------------

interface PrimitiveBuild {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function newPrimitive(): PrimitiveBuild {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/** Append a quad (two triangles) with a shared normal and 0..1 UVs. */
function pushQuad(
  b: PrimitiveBuild,
  p0: readonly [number, number, number],
  p1: readonly [number, number, number],
  p2: readonly [number, number, number],
  p3: readonly [number, number, number],
  normal: readonly [number, number, number],
  // UVs per corner, matching p0..p3 winding.
  uv: readonly [number, number, number, number, number, number, number, number],
): void {
  const base = b.positions.length / 3;
  for (const p of [p0, p1, p2, p3]) b.positions.push(p[0], p[1], p[2]);
  for (let k = 0; k < 4; k += 1) b.normals.push(normal[0], normal[1], normal[2]);
  b.uvs.push(uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], uv[6], uv[7]);
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Build the terrain as one {@link MeshSceneInstance} per distinct tile sprite
 * (each carrying that sprite's texture). Each cell contributes a top quad at its
 * height and vertical wall quads on any side that drops to a lower neighbour, so a
 * raised cell reads as a solid 3D block, not a floating tile.
 */
export function buildTerrainInstances(scene: WorldScene, textureFor: TextureLookup): MeshSceneInstance[] {
  const builders = new Map<number, PrimitiveBuild>();
  const builderFor = (sprite: number): PrimitiveBuild => {
    let b = builders.get(sprite);
    if (!b) {
      b = newPrimitive();
      builders.set(sprite, b);
    }
    return b;
  };

  for (let j = 0; j < scene.rows; j += 1) {
    for (let i = 0; i < scene.cols; i += 1) {
      const cell = cellAt(scene, i, j);
      const b = builderFor(cell.sprite);
      const x0 = i * CELL_WORLD;
      const x1 = x0 + CELL_WORLD;
      const z0 = j * CELL_WORLD;
      const z1 = z0 + CELL_WORLD;
      const top = cell.h * HEIGHT_WORLD;

      // Top face (facing +Y). UV maps the whole tile across the cell.
      pushQuad(
        b,
        [x0, top, z0],
        [x0, top, z1],
        [x1, top, z1],
        [x1, top, z0],
        [0, 1, 0],
        [0, 0, 0, 1, 1, 1, 1, 0],
      );

      // Walls: for each of the four neighbours, if it is lower, close the gap
      // with a vertical quad from this top down to the neighbour's top.
      const sides: Array<{ di: number; dj: number }> = [
        { di: 1, dj: 0 },
        { di: -1, dj: 0 },
        { di: 0, dj: 1 },
        { di: 0, dj: -1 },
      ];
      for (const { di, dj } of sides) {
        const neighbour = cellAt(scene, i + di, j + dj);
        const bottomH = Math.max(0, neighbour.h); // floor at 0 for edges (h = -1)
        if (bottomH >= cell.h) continue;
        const bottom = bottomH * HEIGHT_WORLD;
        // The shared edge between this cell and the neighbour, as two XZ points.
        let e0: [number, number], e1: [number, number], nrm: [number, number, number];
        if (di === 1) {
          e0 = [x1, z0];
          e1 = [x1, z1];
          nrm = [1, 0, 0];
        } else if (di === -1) {
          e0 = [x0, z1];
          e1 = [x0, z0];
          nrm = [-1, 0, 0];
        } else if (dj === 1) {
          e0 = [x1, z1];
          e1 = [x0, z1];
          nrm = [0, 0, 1];
        } else {
          e0 = [x0, z0];
          e1 = [x1, z0];
          nrm = [0, 0, -1];
        }
        pushQuad(
          b,
          [e0[0], top, e0[1]],
          [e0[0], bottom, e0[1]],
          [e1[0], bottom, e1[1]],
          [e1[0], top, e1[1]],
          nrm,
          [0, 0, 0, 1, 1, 1, 1, 0],
        );
      }
    }
  }

  const instances: MeshSceneInstance[] = [];
  for (const [sprite, b] of builders) {
    if (b.indices.length === 0) continue;
    const mesh = primitiveToMesh(`terrain-${sprite}`, b);
    instances.push({ mesh, model: identityMat4(), textures: [textureFor(sprite)] });
  }
  return instances;
}

function primitiveToMesh(name: string, b: PrimitiveBuild): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from(b.positions),
        normals: Float32Array.from(b.normals),
        uvs: Float32Array.from(b.uvs),
        indices: Uint32Array.from(b.indices),
        material: { name: "tile", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

// --- Billboards --------------------------------------------------------------

/**
 * A camera-facing quad standing at `foot` (its bottom-centre), spanning `width`
 * across the camera's right axis and rising `height` along its up axis. Because
 * it is built from the live camera basis each frame it always squarely faces the
 * viewer, and it shares the scene depth buffer so terrain occludes it correctly.
 * The sprite's palette-0 pixels are transparent, so what draws is the silhouette.
 */
export function buildBillboardInstance(
  foot: readonly [number, number, number],
  width: number,
  height: number,
  camRight: readonly [number, number, number],
  camUp: readonly [number, number, number],
  texture: DecodedTexture | null,
): MeshSceneInstance {
  const hw = width / 2;
  const rx = camRight[0] * hw;
  const ry = camRight[1] * hw;
  const rz = camRight[2] * hw;
  const ux = camUp[0] * height;
  const uy = camUp[1] * height;
  const uz = camUp[2] * height;
  const [fx, fy, fz] = foot;
  // Bottom-left, top-left, top-right, bottom-right (CCW as seen by the camera).
  const bl: [number, number, number] = [fx - rx, fy - ry, fz - rz];
  const tl: [number, number, number] = [fx - rx + ux, fy - ry + uy, fz - rz + uz];
  const tr: [number, number, number] = [fx + rx + ux, fy + ry + uy, fz + rz + uz];
  const br: [number, number, number] = [fx + rx, fy + ry, fz + rz];
  // Normal faces the camera (-forward = right × up), so Lambert keeps it bright.
  const nrm: [number, number, number] = [
    camRight[1] * camUp[2] - camRight[2] * camUp[1],
    camRight[2] * camUp[0] - camRight[0] * camUp[2],
    camRight[0] * camUp[1] - camRight[1] * camUp[0],
  ];
  const b = newPrimitive();
  // V origin is top-left (the rasteriser flips V), so top corners are v=0.
  pushQuad(b, bl, tl, tr, br, nrm, [0, 1, 0, 0, 1, 0, 1, 1]);
  return { mesh: primitiveToMesh("billboard", b), model: identityMat4(), textures: [texture] };
}

// --- Camera ------------------------------------------------------------------

export interface WorldCamera {
  readonly view: Mat4;
  readonly projection: Mat4;
  /** World-space right axis of the camera (for billboard orientation). */
  readonly right: readonly [number, number, number];
  /** World-space up axis of the camera. */
  readonly up: readonly [number, number, number];
}

/** The XZ/height centre and radius the camera frames. */
export function worldCenter(scene: WorldScene): { center: [number, number, number]; radius: number } {
  let maxH = 0;
  for (const c of scene.cells) maxH = Math.max(maxH, c.h);
  const cx = (scene.cols * CELL_WORLD) / 2;
  const cz = (scene.rows * CELL_WORLD) / 2;
  const cy = (maxH * HEIGHT_WORLD) / 2;
  const radius = Math.max(
    1e-3,
    0.5 * Math.hypot(scene.cols * CELL_WORLD, maxH * HEIGHT_WORLD, scene.rows * CELL_WORLD),
  );
  return { center: [cx, cy, cz], radius };
}

/**
 * Build the world camera from an orbit spec, framing the terrain. `aspect` is the
 * framebuffer's width/height so the projection is undistorted; `distance`/`fov`
 * of 0 mean auto-fit / default. Returns the matrices plus the camera basis a
 * billboard needs to face the viewer.
 */
export function buildWorldCamera(scene: WorldScene, spec: WorldCameraSpec, aspect: number): WorldCamera {
  const { center, radius } = worldCenter(scene);
  const fov = spec.fov > 0 ? spec.fov : DEFAULT_FOV;
  const distance = spec.distance > 0 ? spec.distance : radius / Math.sin(fov / 2) + radius;
  const cosPitch = Math.cos(spec.pitch);
  const eye: [number, number, number] = [
    center[0] + distance * cosPitch * Math.sin(spec.yaw),
    center[1] + distance * Math.sin(spec.pitch),
    center[2] + distance * cosPitch * Math.cos(spec.yaw),
  ];
  const view = viewMatrix(eye, center, [0, 1, 0]);
  const projection = projectionMatrix(fov, aspect, 0.05, distance + radius * 6);
  // The view matrix's rows are the camera basis in world space (column-major
  // storage: right = elements 0,4,8; up = 1,5,9).
  const right: [number, number, number] = [view[0]!, view[4]!, view[8]!];
  const up: [number, number, number] = [view[1]!, view[5]!, view[9]!];
  return { view, projection, right, up };
}

/** The default camera spec, filling in a scene's own when it declared none. */
export function defaultCameraSpec(scene: WorldScene): WorldCameraSpec {
  return scene.camera ?? { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, distance: 0, fov: 0 };
}

function identityMat4(): Mat4 {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4;
}

/**
 * In-world block editing for the explorable world (/world).
 *
 * The world is drawn by a CPU rasterizer (sceneRenderer) that, alongside the
 * colour and depth buffers, can emit two pick buffers: `pickInstance` (which
 * placed model won each pixel) and `pickFace` (which cell-face of that model).
 * That is enough to turn a click into an edit *without* ray-marching:
 *
 *   1. The clicked pixel's depth is the camera-space Z of the surface under the
 *      cursor. {@link unprojectScreen} inverts the exact orthographic transform
 *      the renderer used (yaw → pitch → scale) to recover the world point there.
 *   2. `pickFace` names the face; its outward normal (world-axis-aligned, since
 *      models are not rotated — only the camera is) says which side was hit.
 *   3. Nudging the hit point half a cell along that normal lands in the empty
 *      neighbour cell (to place) or the solid cell itself (to remove).
 *
 * The editable geometry is a cube {@link BuildLayer} on a fixed integer world
 * lattice, kept separate from the read-only hexel terrain and props: the player
 * builds cubes on top of the generated world rather than resculpting it. The
 * layer rebuilds its render model only on edit, never per frame.
 *
 * Pure and DOM-free (no canvas, no React), so the unit tests drive the real
 * projection round-trip and lattice mapping and assert on actual coordinates.
 */

import {
  VoxelGrid,
  voxelGridToModel,
  serializeVoxelGrid,
  deserializeVoxelGrid,
  CUBE_GEOMETRY,
  MATERIAL_NONE,
} from "@cartbox/editor";
import type { PlacedModel, TextureAtlas } from "@cartbox/editor";

/** A colour a placed block is painted with. Channels 0..255. */
export interface BlockColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Self-emissive strength 0..255 (a glowing block). Default 0. */
  readonly emissive?: number;
}

/**
 * The resolved camera for a rendered frame — the same yaw/pitch/cell/centre/origin
 * the scene renderer projected with. {@link unprojectScreen} needs every term to
 * invert the transform exactly, so the world point it returns lands on the surface
 * the player actually clicked.
 */
export interface WorldCamera {
  readonly yaw: number;
  readonly pitch: number;
  /** Output pixels per world unit (zoom). */
  readonly cell: number;
  /** Screen-space point the world origin projects to (usually size / 2). */
  readonly centre: number;
  /** The world point drawn at the screen centre (the camera look-at). */
  readonly origin: readonly [number, number, number];
}

/** A world position. */
export type WorldPoint = readonly [number, number, number];
/** An integer grid cell. */
export type Cell = readonly [number, number, number];

/**
 * Map a DOM pointer offset (CSS pixels within the canvas element) to an integer
 * pixel in the render buffer, which is drawn at `size×size` and upscaled by CSS.
 * Returns `null` when the pointer is outside the buffer, so a stray click at the
 * edge cannot index out of bounds.
 */
export function screenToBuffer(
  offsetX: number,
  offsetY: number,
  rectWidth: number,
  rectHeight: number,
  size: number,
): { readonly px: number; readonly py: number } | null {
  if (rectWidth <= 0 || rectHeight <= 0) return null;
  const px = Math.floor((offsetX / rectWidth) * size);
  const py = Math.floor((offsetY / rectHeight) * size);
  if (px < 0 || px >= size || py < 0 || py >= size) return null;
  return { px, py };
}

/**
 * Invert the scene renderer's orthographic projection. Given a screen pixel
 * (`sx`, `sy`) and the camera-space depth `camZ` stored for it, recover the world
 * point that projected there. This is the exact algebraic inverse of the forward
 * transform in voxelModelRenderer's `project` (yaw about the vertical axis, then a
 * pitch tip toward the viewer, then a uniform scale about the screen centre).
 */
export function unprojectScreen(
  sx: number,
  sy: number,
  camZ: number,
  camera: WorldCamera,
): WorldPoint {
  const { cell, centre, yaw, pitch } = camera;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);

  // Undo the screen scale/offset: forward was sx = centre + yawX*cell,
  // sy = centre - camY*cell.
  const yawX = (sx - centre) / cell;
  const camY = (centre - sy) / cell;

  // Undo the pitch (a 2D rotation of (Y, yawZ) → (camY, camZ)).
  const y = camY * cosPitch + camZ * sinPitch;
  const yawZ = -camY * sinPitch + camZ * cosPitch;

  // Undo the yaw (a 2D rotation of (X, Z) → (yawX, yawZ)).
  const x = yawX * cosYaw - yawZ * sinYaw;
  const z = yawX * sinYaw + yawZ * cosYaw;

  // The forward transform worked in camera-relative coordinates (world − origin),
  // so add the origin back to return a true world point.
  return [x + camera.origin[0], y + camera.origin[1], z + camera.origin[2]];
}

/**
 * Project a world point to screen with the scene renderer's exact forward
 * transform (yaw about the vertical axis, then a pitch tip toward the viewer,
 * then a uniform scale about the screen centre). The inverse of
 * {@link unprojectScreen}; used to draw an overlay — like the build cursor — that
 * lines up with the rasterized scene.
 */
export function projectWorld(point: WorldPoint, camera: WorldCamera): { sx: number; sy: number; camZ: number } {
  const { cell, centre, yaw, pitch, origin } = camera;
  const x = point[0] - origin[0];
  const y = point[1] - origin[1];
  const z = point[2] - origin[2];
  const yawX = x * Math.cos(yaw) + z * Math.sin(yaw);
  const yawZ = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const camY = y * Math.cos(pitch) - yawZ * Math.sin(pitch);
  const camZ = y * Math.sin(pitch) + yawZ * Math.cos(pitch);
  return { sx: centre + yawX * cell, sy: centre - camY * cell, camZ };
}

/** The eight corner offsets of a unit cube centred on the origin. */
const CUBE_CORNERS: readonly WorldPoint[] = [
  [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
];
/** The twelve edges of a cube, as index pairs into {@link CUBE_CORNERS}. */
const CUBE_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // back face
  [4, 5], [5, 6], [6, 7], [7, 4], // front face
  [0, 4], [1, 5], [2, 6], [3, 7], // connectors
];

/**
 * The twelve edges of the unit cube centred at world point `center`, each
 * projected to a pair of screen points — the wireframe a hover cursor strokes to
 * show which cell an edit will land on.
 */
export function cubeEdgesScreen(
  center: WorldPoint,
  camera: WorldCamera,
): Array<readonly [readonly [number, number], readonly [number, number]]> {
  const projected = CUBE_CORNERS.map((corner) =>
    projectWorld([center[0] + corner[0], center[1] + corner[1], center[2] + corner[2]], camera),
  );
  return CUBE_EDGES.map(([a, b]) => [
    [projected[a]!.sx, projected[a]!.sy],
    [projected[b]!.sx, projected[b]!.sy],
  ]);
}

/**
 * The buffers a picked frame leaves behind: per pixel, which placed model won it,
 * which of that model's faces, and how far away the surface was. The scene renderer
 * fills all three in one pass, so a pick needs no ray-march.
 */
export interface PickBuffers {
  /** Index into the rendered model list, or negative where nothing was drawn. */
  readonly instance: Int32Array;
  /** Index into the winning model's geometry faces, or negative for none. */
  readonly face: Int8Array;
  /** Camera-space depth of the winning surface. */
  readonly depth: Float32Array;
  /** Edge length of the square render buffer the three share. */
  readonly size: number;
}

/** A resolved pick: the world point under a pixel and the outward face normal there. */
export interface SurfaceHit {
  /** Index of the model that owns the surface, so callers can tell build from world. */
  readonly instance: number;
  readonly point: WorldPoint;
  readonly normal: WorldPoint;
}

/**
 * Resolve the surface under buffer pixel (`px`, `py`) for the frame those buffers
 * were drawn with: name the model and face from the pick buffers, then unproject
 * the stored depth to a world point. Returns `null` for open sky, an out-of-range
 * pixel, or a pick that names no drawn face — the cases where there is nothing to
 * build against. Both the edit and the hover cursor go through this, so what the
 * cursor previews is exactly what a tap would do.
 */
export function pickSurface(
  px: number,
  py: number,
  buffers: PickBuffers,
  models: readonly PlacedModel[],
  camera: WorldCamera,
): SurfaceHit | null {
  const { instance: instances, face: faces, depth, size } = buffers;
  if (px < 0 || px >= size || py < 0 || py >= size) return null;
  const pixel = py * size + px;
  const instance = instances[pixel];
  if (instance === undefined || instance < 0) return null; // open sky
  const faceIndex = faces[pixel];
  if (faceIndex === undefined || faceIndex < 0) return null;
  const placed = models[instance];
  if (!placed) return null;
  const face = (placed.model.geometry ?? CUBE_GEOMETRY).faces[faceIndex];
  if (!face) return null;

  return {
    instance,
    point: unprojectScreen(px + 0.5, py + 0.5, depth[pixel] ?? 0, camera),
    normal: face.normal,
  };
}

/**
 * A cube build layer on a fixed integer world lattice. Cells map to world space
 * by a stable centring (`world = cell − half`), so a placed block's world
 * position never shifts as the layer fills — the property that lets a click's
 * world point round to a consistent cell. Read-only terrain and props are edited
 * against, never mutated: the player builds cubes on top of the world.
 */
export class BuildLayer {
  private readonly grid: VoxelGrid;
  private readonly half: readonly [number, number, number];
  private readonly atlas?: TextureAtlas;

  /**
   * @param dimX Lattice width in cells. Made odd so the centre lands on an
   *   integer world coordinate, keeping every cell on an integer lattice.
   * @param atlas Texture atlas the placed blocks' materials sample from; without
   *   it, blocks can still be placed but render flat (their colour only).
   */
  constructor(dimX: number, dimY: number, dimZ: number, atlas?: TextureAtlas) {
    const ox = oddAtLeast(dimX);
    const oy = oddAtLeast(dimY);
    const oz = oddAtLeast(dimZ);
    this.grid = new VoxelGrid(ox, oy, oz);
    this.half = [(ox - 1) / 2, (oy - 1) / 2, (oz - 1) / 2];
    this.atlas = atlas;
  }

  /** Number of blocks currently placed. */
  get count(): number {
    return this.grid.filledCount;
  }

  /** The world point at the centre of grid cell `(x, y, z)`. */
  cellToWorld(x: number, y: number, z: number): WorldPoint {
    return [x - this.half[0], y - this.half[1], z - this.half[2]];
  }

  /** The grid cell containing world point `p` (nearest cell centre). */
  worldToCell(p: WorldPoint): Cell {
    return [
      Math.round(p[0] + this.half[0]),
      Math.round(p[1] + this.half[1]),
      Math.round(p[2] + this.half[2]),
    ];
  }

  /** Whether cell `(x, y, z)` holds a block. */
  isFilled(x: number, y: number, z: number): boolean {
    return this.grid.isFilled(x, y, z);
  }

  /**
   * The cell {@link place} would fill for a pick at `hit` on a face with the given
   * outward `normal`: the empty neighbour just outside that face. Returns `null`
   * when it falls off the lattice or is already occupied — i.e. exactly when a
   * place would fail — so a hover cursor only shows a legal target.
   */
  placementCell(hit: WorldPoint, normal: WorldPoint): Cell | null {
    const target = this.worldToCell(offsetPoint(hit, normal, 0.5));
    if (!this.grid.inBounds(target[0], target[1], target[2])) return null;
    if (this.grid.isFilled(target[0], target[1], target[2])) return null;
    return target;
  }

  /**
   * Place a block against the surface at `hit`, whose outward `normal` was the
   * picked face's normal. The block fills the empty cell just outside that face.
   * Returns the cell filled, or `null` if it fell outside the lattice or was
   * already occupied.
   */
  place(hit: WorldPoint, normal: WorldPoint, color: BlockColor, material = MATERIAL_NONE): Cell | null {
    const target = this.worldToCell(offsetPoint(hit, normal, 0.5));
    if (!this.grid.inBounds(target[0], target[1], target[2])) return null;
    if (this.grid.isFilled(target[0], target[1], target[2])) return null;
    if (material >= 0) {
      // A textured block: paint the voxel white so the authored material tile
      // shows as drawn (the renderer tints a tile by the voxel colour).
      this.grid.set(target[0], target[1], target[2], 255, 255, 255, 0, material);
    } else {
      this.grid.set(target[0], target[1], target[2], color.r, color.g, color.b, color.emissive ?? 0);
    }
    return target;
  }

  /**
   * Remove the block whose face (`normal`) was picked at `hit`. Steps half a cell
   * *inward* to land on the solid cell. Returns the cleared cell, or `null` if
   * that cell held no block (e.g. the pick was terrain, not a placed block).
   */
  remove(hit: WorldPoint, normal: WorldPoint): Cell | null {
    const target = this.worldToCell(offsetPoint(hit, normal, -0.5));
    if (!this.grid.isFilled(target[0], target[1], target[2])) return null;
    this.grid.clear(target[0], target[1], target[2]);
    return target;
  }

  /**
   * The layer as a placed model on the world lattice, or `null` when empty (no
   * model to draw). Built with grid centring so the model's origin matches
   * {@link cellToWorld}; placed at the world origin, which the terrain shares.
   */
  toPlacedModel(): PlacedModel | null {
    if (this.grid.filledCount === 0) return null;
    return {
      model: voxelGridToModel(this.grid, { center: "grid" }),
      position: [0, 0, 0],
      ...(this.atlas ? { atlas: this.atlas } : {}),
    };
  }

  /**
   * The placed blocks as a portable payload, in the editor's own voxel-grid format
   * (so a build could later be loaded as a sculpt, or shipped as a cart sidecar).
   * Colours, emissive and per-block materials all survive the round trip.
   */
  serialize(): string {
    return serializeVoxelGrid(this.grid);
  }

  /**
   * Replace what is placed with a payload from {@link serialize}. Returns `false`,
   * leaving the layer untouched, when the payload is unreadable or was saved on a
   * differently sized lattice — a stale save from an older world is discarded
   * rather than dropping its blocks at shifted coordinates.
   */
  restore(payload: string): boolean {
    let saved: VoxelGrid;
    try {
      saved = deserializeVoxelGrid(payload);
    } catch {
      return false;
    }
    if (
      saved.sizeX !== this.grid.sizeX ||
      saved.sizeY !== this.grid.sizeY ||
      saved.sizeZ !== this.grid.sizeZ
    ) {
      return false;
    }

    this.clearAll();
    saved.forEachFilled((x, y, z, cell) => {
      this.grid.set(x, y, z, cell.r, cell.g, cell.b, cell.emissive, cell.tile ?? MATERIAL_NONE);
    });
    return true;
  }

  /** Empty the lattice. Collected first, since clearing mutates what is iterated. */
  private clearAll(): void {
    const filled: Cell[] = [];
    this.grid.forEachFilled((x, y, z) => filled.push([x, y, z]));
    for (const [x, y, z] of filled) this.grid.clear(x, y, z);
  }
}

/** The next odd integer ≥ `value` (and ≥ 1), so a lattice centre stays integral. */
function oddAtLeast(value: number): number {
  const floored = Math.max(1, Math.floor(value));
  return floored % 2 === 0 ? floored + 1 : floored;
}

/** Move `point` by `distance` along `direction`. */
function offsetPoint(point: WorldPoint, direction: WorldPoint, distance: number): WorldPoint {
  return [
    point[0] + direction[0] * distance,
    point[1] + direction[1] * distance,
    point[2] + direction[2] * distance,
  ];
}

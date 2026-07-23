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

import { VoxelGrid, voxelGridToModel } from "@cartbox/editor";
import type { PlacedModel } from "@cartbox/editor";

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
 * A cube build layer on a fixed integer world lattice. Cells map to world space
 * by a stable centring (`world = cell − half`), so a placed block's world
 * position never shifts as the layer fills — the property that lets a click's
 * world point round to a consistent cell. Read-only terrain and props are edited
 * against, never mutated: the player builds cubes on top of the world.
 */
export class BuildLayer {
  private readonly grid: VoxelGrid;
  private readonly half: readonly [number, number, number];

  /**
   * @param dimX Lattice width in cells. Made odd so the centre lands on an
   *   integer world coordinate, keeping every cell on an integer lattice.
   */
  constructor(dimX: number, dimY: number, dimZ: number) {
    const ox = oddAtLeast(dimX);
    const oy = oddAtLeast(dimY);
    const oz = oddAtLeast(dimZ);
    this.grid = new VoxelGrid(ox, oy, oz);
    this.half = [(ox - 1) / 2, (oy - 1) / 2, (oz - 1) / 2];
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
   * Place a block against the surface at `hit`, whose outward `normal` was the
   * picked face's normal. The block fills the empty cell just outside that face.
   * Returns the cell filled, or `null` if it fell outside the lattice or was
   * already occupied.
   */
  place(hit: WorldPoint, normal: WorldPoint, color: BlockColor): Cell | null {
    const target = this.worldToCell(offsetPoint(hit, normal, 0.5));
    if (!this.grid.inBounds(target[0], target[1], target[2])) return null;
    if (this.grid.isFilled(target[0], target[1], target[2])) return null;
    this.grid.set(target[0], target[1], target[2], color.r, color.g, color.b, color.emissive ?? 0);
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
    return { model: voxelGridToModel(this.grid, { center: "grid" }), position: [0, 0, 0] };
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

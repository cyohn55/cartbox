/**
 * A mutable dense 3D voxel grid — the authored data behind the true-3D voxel
 * editor, where each cube is placed independently. This is the counterpart to
 * {@link extrudeSprite}, which can only produce a flattened 2D sprite pushed to a
 * uniform depth; a VoxelGrid represents arbitrary occupancy, hollow shapes, and
 * per-cell colour.
 *
 * Each cell stores a straight-alpha RGBA colour (alpha 0 marks an empty cell) and
 * an emissive byte. {@link voxelGridToModel} turns a grid into the renderer's
 * read-only {@link VoxelModel}, computing each voxel's exposed-face mask from real
 * 3D neighbour occupancy so the existing per-face cube renderer draws it directly.
 *
 * Pure and DOM-free: the same grid feeds the editor UI, the renderer, and the
 * unit tests, and serializes to a compact JSON string for storage in a cart.
 */

import { CUBE_FACES, type VoxelModel } from "../render/voxelModel";

/** Largest grid edge, bounding storage and per-edit render cost. */
export const MAX_VOXEL_GRID_DIM = 32;

/** Format version of the serialized grid, bumped on any schema change. */
export const VOXEL_GRID_VERSION = 1;

/** A single cell's contents. */
export interface VoxelCell {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Self-emissive strength, 0..255. */
  readonly emissive: number;
}

function assertDim(dim: number, axis: string): void {
  if (!Number.isInteger(dim) || dim < 1 || dim > MAX_VOXEL_GRID_DIM) {
    throw new RangeError(`Voxel grid ${axis} must be an integer in 1..${MAX_VOXEL_GRID_DIM}, received ${dim}`);
  }
}

export class VoxelGrid {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** Straight-alpha RGBA per cell (`sizeX*sizeY*sizeZ*4`); alpha 0 = empty. */
  readonly colors: Uint8ClampedArray;
  /** Emissive per cell (`sizeX*sizeY*sizeZ`), 0..255. */
  readonly emissive: Uint8Array;

  constructor(sizeX: number, sizeY: number, sizeZ: number) {
    assertDim(sizeX, "sizeX");
    assertDim(sizeY, "sizeY");
    assertDim(sizeZ, "sizeZ");
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.sizeZ = sizeZ;
    const cells = sizeX * sizeY * sizeZ;
    this.colors = new Uint8ClampedArray(cells * 4);
    this.emissive = new Uint8Array(cells);
  }

  /** Flat cell index for `(x, y, z)`; assumes the coordinates are in bounds. */
  index(x: number, y: number, z: number): number {
    return (z * this.sizeY + y) * this.sizeX + x;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY && z >= 0 && z < this.sizeZ;
  }

  /** Whether a cell is occupied (in bounds and non-transparent). */
  isFilled(x: number, y: number, z: number): boolean {
    return this.inBounds(x, y, z) && this.colors[this.index(x, y, z) * 4 + 3]! > 0;
  }

  /** The cell's contents, or `null` if empty / out of bounds. */
  get(x: number, y: number, z: number): VoxelCell | null {
    if (!this.isFilled(x, y, z)) return null;
    const i = this.index(x, y, z);
    return { r: this.colors[i * 4]!, g: this.colors[i * 4 + 1]!, b: this.colors[i * 4 + 2]!, emissive: this.emissive[i]! };
  }

  /** Place (or recolour) a solid cell. No-op if out of bounds. */
  set(x: number, y: number, z: number, r: number, g: number, b: number, emissive = 0): void {
    if (!this.inBounds(x, y, z)) return;
    const i = this.index(x, y, z);
    this.colors[i * 4] = r;
    this.colors[i * 4 + 1] = g;
    this.colors[i * 4 + 2] = b;
    this.colors[i * 4 + 3] = 255;
    this.emissive[i] = emissive;
  }

  /** Empty a cell. No-op if out of bounds. */
  clear(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) return;
    const i = this.index(x, y, z);
    this.colors[i * 4] = 0;
    this.colors[i * 4 + 1] = 0;
    this.colors[i * 4 + 2] = 0;
    this.colors[i * 4 + 3] = 0;
    this.emissive[i] = 0;
  }

  /** Number of occupied cells. */
  get filledCount(): number {
    let n = 0;
    for (let i = 0; i < this.emissive.length; i += 1) if (this.colors[i * 4 + 3]! > 0) n += 1;
    return n;
  }

  /** Visit every occupied cell with its coordinates and contents. */
  forEachFilled(callback: (x: number, y: number, z: number, cell: VoxelCell) => void): void {
    for (let z = 0; z < this.sizeZ; z += 1) {
      for (let y = 0; y < this.sizeY; y += 1) {
        for (let x = 0; x < this.sizeX; x += 1) {
          const i = this.index(x, y, z);
          if (this.colors[i * 4 + 3]! === 0) continue;
          callback(x, y, z, {
            r: this.colors[i * 4]!,
            g: this.colors[i * 4 + 1]!,
            b: this.colors[i * 4 + 2]!,
            emissive: this.emissive[i]!,
          });
        }
      }
    }
  }

  /** A deep copy. */
  clone(): VoxelGrid {
    const copy = new VoxelGrid(this.sizeX, this.sizeY, this.sizeZ);
    copy.colors.set(this.colors);
    copy.emissive.set(this.emissive);
    return copy;
  }
}

/**
 * A {@link VoxelModel} plus a `gridIndex` mapping each rendered voxel back to its
 * source grid cell, so a pick (which returns a voxel index) resolves to `(x,y,z)`.
 */
export interface GridVoxelModel extends VoxelModel {
  /** For model voxel `v`, the flat grid cell index it came from. */
  readonly gridIndex: Int32Array;
}

/**
 * Build a renderable model from a grid. Only cells that expose at least one face
 * (a neighbour is empty or off-grid) are kept, and each face bit is set purely
 * from 3D occupancy — so hollow interiors cost nothing and shared faces between
 * touching cubes are hidden. Coordinates are centred on the grid so it rotates
 * about its middle, matching {@link extrudeSprite}'s convention (y up).
 */
export function voxelGridToModel(grid: VoxelGrid): GridVoxelModel {
  const halfX = (grid.sizeX - 1) / 2;
  const halfY = (grid.sizeY - 1) / 2;
  const halfZ = (grid.sizeZ - 1) / 2;

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const es: number[] = [];
  const nxs: number[] = [];
  const nys: number[] = [];
  const nzs: number[] = [];
  const faceMasks: number[] = [];
  const gridIndices: number[] = [];

  grid.forEachFilled((x, y, z, cell) => {
    let mask = 0;
    let vnx = 0;
    let vny = 0;
    let vnz = 0;
    for (const face of CUBE_FACES) {
      const [dx, dy, dz] = face.normal;
      if (!grid.isFilled(x + dx, y + dy, z + dz)) {
        mask |= face.bit;
        vnx += dx;
        vny += dy;
        vnz += dz;
      }
    }
    if (mask === 0) return; // fully enclosed — never visible

    const len = Math.hypot(vnx, vny, vnz) || 1;
    xs.push(x - halfX);
    ys.push(y - halfY);
    zs.push(z - halfZ);
    rs.push(cell.r);
    gs.push(cell.g);
    bs.push(cell.b);
    es.push(cell.emissive / 255);
    nxs.push(vnx / len);
    nys.push(vny / len);
    nzs.push(vnz / len);
    faceMasks.push(mask);
    gridIndices.push(grid.index(x, y, z));
  });

  return {
    sizeX: grid.sizeX,
    sizeY: grid.sizeY,
    sizeZ: grid.sizeZ,
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    z: Float32Array.from(zs),
    r: Uint8ClampedArray.from(rs),
    g: Uint8ClampedArray.from(gs),
    b: Uint8ClampedArray.from(bs),
    emissive: Float32Array.from(es),
    nx: Float32Array.from(nxs),
    ny: Float32Array.from(nys),
    nz: Float32Array.from(nzs),
    faces: Uint8Array.from(faceMasks),
    gridIndex: Int32Array.from(gridIndices),
  };
}

// --- Serialization (portable base64, no Buffer dependency) ---

function bytesToBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Serialize a grid to a compact JSON string for storage in a cart. */
export function serializeVoxelGrid(grid: VoxelGrid): string {
  return JSON.stringify({
    version: VOXEL_GRID_VERSION,
    sizeX: grid.sizeX,
    sizeY: grid.sizeY,
    sizeZ: grid.sizeZ,
    colors: bytesToBase64(grid.colors),
    emissive: bytesToBase64(grid.emissive),
  });
}

/**
 * Parse a serialized grid, rejecting anything malformed or oversized (untrusted
 * input: it may come from another user's cart). Throws on invalid input.
 */
export function deserializeVoxelGrid(json: string): VoxelGrid {
  const raw = JSON.parse(json) as {
    version?: number;
    sizeX?: number;
    sizeY?: number;
    sizeZ?: number;
    colors?: string;
    emissive?: string;
  };
  if (raw.version !== VOXEL_GRID_VERSION) {
    throw new Error(`Unsupported voxel grid version: ${String(raw.version)}`);
  }
  const grid = new VoxelGrid(raw.sizeX ?? 0, raw.sizeY ?? 0, raw.sizeZ ?? 0); // constructor bounds-checks dims
  const cells = grid.sizeX * grid.sizeY * grid.sizeZ;
  const colors = base64ToBytes(raw.colors ?? "");
  const emissive = base64ToBytes(raw.emissive ?? "");
  if (colors.length !== cells * 4 || emissive.length !== cells) {
    throw new Error("Voxel grid payload size does not match its dimensions");
  }
  grid.colors.set(colors);
  grid.emissive.set(emissive);
  return grid;
}

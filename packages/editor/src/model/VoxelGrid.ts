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
export const MAX_VOXEL_GRID_DIM = 256;

/**
 * Format version of the serialized grid, bumped on any schema change.
 *
 * v2 stores only occupied cells (sparse), so the payload — written on every edit
 * into the undo timeline and the saved cart — scales with the sculpt's voxel
 * count rather than the grid *volume*. That is what makes large grids (up to
 * {@link MAX_VOXEL_GRID_DIM}³) practical: a dense v1 encode of a 256³ grid was
 * ~85MB and took over a second per edit. v1 (dense) payloads still deserialize.
 */
export const VOXEL_GRID_VERSION = 2;

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

export interface GridToModelOptions {
  /**
   * What to centre and size the model on. `"grid"` (default) centres on the whole
   * grid and sizes to it — a stable coordinate system for the editor. `"content"`
   * centres on the filled cells' bounding box and sizes to that, so a small sculpt
   * in a large grid still renders centred and tight — what a placed prop wants.
   */
  readonly center?: "grid" | "content";
}

/**
 * Build a renderable model from a grid. Only cells that expose at least one face
 * (a neighbour is empty or off-grid) are kept, and each face bit is set purely
 * from 3D occupancy — so hollow interiors cost nothing and shared faces between
 * touching cubes are hidden. Coordinates are centred (see {@link GridToModelOptions})
 * so it rotates about its middle, matching {@link extrudeSprite}'s convention (y up).
 */
export function voxelGridToModel(grid: VoxelGrid, options: GridToModelOptions = {}): GridVoxelModel {
  // Filled bounding box, for content-centred sizing.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  grid.forEachFilled((x, y, z) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  });

  const content = options.center === "content" && maxX >= minX;
  const halfX = content ? (minX + maxX) / 2 : (grid.sizeX - 1) / 2;
  const halfY = content ? (minY + maxY) / 2 : (grid.sizeY - 1) / 2;
  const halfZ = content ? (minZ + maxZ) / 2 : (grid.sizeZ - 1) / 2;
  const modelSizeX = content ? maxX - minX + 1 : grid.sizeX;
  const modelSizeY = content ? maxY - minY + 1 : grid.sizeY;
  const modelSizeZ = content ? maxZ - minZ + 1 : grid.sizeZ;

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
    sizeX: modelSizeX,
    sizeY: modelSizeY,
    sizeZ: modelSizeZ,
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

const PAYLOAD_MISMATCH = "Voxel grid payload size does not match its dimensions";

/**
 * Serialize a grid to a compact JSON string for storage in a cart. Sparse: only
 * occupied cells are written (their flat index, RGB, and emissive), so the size
 * tracks the sculpt rather than the grid volume — the property that keeps large
 * grids editable (see {@link VOXEL_GRID_VERSION}). Cell indices are little-endian
 * u32, decoded the same way on load, so the payload is platform-independent.
 */
export function serializeVoxelGrid(grid: VoxelGrid): string {
  const count = grid.filledCount;
  const indexBytes = new Uint8Array(count * 4);
  const indexView = new DataView(indexBytes.buffer);
  const rgb = new Uint8Array(count * 3);
  const emissive = new Uint8Array(count);

  let written = 0;
  grid.forEachFilled((x, y, z, cell) => {
    indexView.setUint32(written * 4, grid.index(x, y, z), true);
    rgb[written * 3] = cell.r;
    rgb[written * 3 + 1] = cell.g;
    rgb[written * 3 + 2] = cell.b;
    emissive[written] = cell.emissive;
    written += 1;
  });

  return JSON.stringify({
    version: VOXEL_GRID_VERSION,
    sizeX: grid.sizeX,
    sizeY: grid.sizeY,
    sizeZ: grid.sizeZ,
    count,
    indices: bytesToBase64(indexBytes),
    rgb: bytesToBase64(rgb),
    emissive: bytesToBase64(emissive),
  });
}

/** Restore a legacy v1 dense payload (whole-volume RGBA + emissive base64). */
function deserializeDenseV1(
  grid: VoxelGrid,
  cells: number,
  colorsB64: string,
  emissiveB64: string,
): VoxelGrid {
  const colors = base64ToBytes(colorsB64);
  const emissive = base64ToBytes(emissiveB64);
  if (colors.length !== cells * 4 || emissive.length !== cells) {
    throw new Error(PAYLOAD_MISMATCH);
  }
  grid.colors.set(colors);
  grid.emissive.set(emissive);
  return grid;
}

/**
 * Parse a serialized grid, rejecting anything malformed or oversized (untrusted
 * input: it may come from another user's cart). Reads the current sparse format
 * (v2) and the legacy dense format (v1). Throws on invalid input.
 */
export function deserializeVoxelGrid(json: string): VoxelGrid {
  const raw = JSON.parse(json) as {
    version?: number;
    sizeX?: number;
    sizeY?: number;
    sizeZ?: number;
    count?: number;
    indices?: string;
    rgb?: string;
    emissive?: string;
    colors?: string; // v1 only
  };
  const grid = new VoxelGrid(raw.sizeX ?? 0, raw.sizeY ?? 0, raw.sizeZ ?? 0); // constructor bounds-checks dims
  const cells = grid.sizeX * grid.sizeY * grid.sizeZ;

  if (raw.version === 1) {
    return deserializeDenseV1(grid, cells, raw.colors ?? "", raw.emissive ?? "");
  }
  if (raw.version !== VOXEL_GRID_VERSION) {
    throw new Error(`Unsupported voxel grid version: ${String(raw.version)}`);
  }

  const count = raw.count ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > cells) {
    throw new Error(PAYLOAD_MISMATCH);
  }
  const indices = base64ToBytes(raw.indices ?? "");
  const rgb = base64ToBytes(raw.rgb ?? "");
  const emissive = base64ToBytes(raw.emissive ?? "");
  if (indices.length !== count * 4 || rgb.length !== count * 3 || emissive.length !== count) {
    throw new Error(PAYLOAD_MISMATCH);
  }
  const indexView = new DataView(indices.buffer, indices.byteOffset, indices.byteLength);
  for (let k = 0; k < count; k += 1) {
    const cellIndex = indexView.getUint32(k * 4, true);
    if (cellIndex >= cells) throw new Error(PAYLOAD_MISMATCH); // stray index → reject
    grid.colors[cellIndex * 4] = rgb[k * 3]!;
    grid.colors[cellIndex * 4 + 1] = rgb[k * 3 + 1]!;
    grid.colors[cellIndex * 4 + 2] = rgb[k * 3 + 2]!;
    grid.colors[cellIndex * 4 + 3] = 255;
    grid.emissive[cellIndex] = emissive[k]!;
  }
  return grid;
}

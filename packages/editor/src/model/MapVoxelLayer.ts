/**
 * MapVoxelLayer — the map's third dimension.
 *
 * The tile map says what the ground *looks* like from above; this layer says how
 * tall it *is*. Each map cell carries a column: a height in cells and a palette
 * colour, plus one cell shape for the whole layer (cubes or hexels, exactly as a
 * sculpt in the Voxel tab is one or the other). That is enough to author a
 * Minecraft-style landscape from the top-down map view and to rebuild it as a
 * real {@link VoxelGrid} for preview or for the world renderer.
 *
 * Storage is sparse — only raised columns are written — for the same reason
 * {@link VoxelGrid} is: the payload is re-serialized on every edit into the undo
 * timeline and the saved cart, so it must scale with the authored content rather
 * than with the map's area.
 *
 * Pure and DOM-free, like the rest of the model layer.
 */

import { type CellShape } from "../render/cellGeometry";
import { VoxelGrid, MAX_VOXEL_GRID_DIM } from "./VoxelGrid";

/** Tallest column a map cell can hold. Bounds both storage and preview cost. */
export const MAX_MAP_COLUMN_HEIGHT = 64;

/** Format version of the serialized layer, bumped on any schema change. */
export const MAP_VOXEL_LAYER_VERSION = 1;

/** A column's contents. */
export interface MapColumn {
  /** Cells tall, 1..{@link MAX_MAP_COLUMN_HEIGHT}. Zero means "no column". */
  readonly height: number;
  /** Palette index the column is painted with, so it follows the cart palette. */
  readonly colorIndex: number;
}

const PAYLOAD_MISMATCH = "Map voxel layer payload size does not match its dimensions";

function assertDim(dim: number, axis: string): void {
  if (!Number.isInteger(dim) || dim < 1) {
    throw new RangeError(`Map voxel layer ${axis} must be a positive integer, received ${dim}`);
  }
}

export class MapVoxelLayer {
  readonly width: number;
  readonly height: number;
  /** Column height per cell, row-major; 0 marks an empty cell. */
  private readonly heights: Uint8Array;
  /** Palette index per cell, row-major; meaningful only where height > 0. */
  private readonly colors: Uint8Array;

  constructor(
    width: number,
    height: number,
    /** Whether the columns are cubes or hexels. One shape per layer. */
    readonly shape: CellShape = "cube",
  ) {
    assertDim(width, "width");
    assertDim(height, "height");
    this.width = width;
    this.height = height;
    this.heights = new Uint8Array(width * height);
    this.colors = new Uint8Array(width * height);
  }

  private index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  /** The column at a cell, or null when the cell is empty or out of bounds. */
  columnAt(x: number, y: number): MapColumn | null {
    if (!this.inBounds(x, y)) return null;
    const i = this.index(x, y);
    const height = this.heights[i]!;
    return height > 0 ? { height, colorIndex: this.colors[i]! } : null;
  }

  /** A column's height, or 0 when there is none. */
  heightAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.heights[this.index(x, y)]! : 0;
  }

  /**
   * Set a column outright. A height of 0 or less clears the cell; taller values
   * are clamped to {@link MAX_MAP_COLUMN_HEIGHT}. Out-of-bounds writes are ignored.
   */
  setColumn(x: number, y: number, height: number, colorIndex: number): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    const clamped = Math.min(MAX_MAP_COLUMN_HEIGHT, Math.floor(height));
    if (clamped <= 0) {
      this.heights[i] = 0;
      this.colors[i] = 0;
      return;
    }
    this.heights[i] = clamped;
    this.colors[i] = Math.max(0, Math.min(255, Math.floor(colorIndex)));
  }

  /**
   * Raise (or, with a negative delta, lower) a column, painting it with
   * `colorIndex` if it is being created. Returns the resulting height, so a UI
   * can report what the edit did without reading back.
   */
  raise(x: number, y: number, delta: number, colorIndex: number): number {
    if (!this.inBounds(x, y)) return 0;
    const current = this.heightAt(x, y);
    const next = Math.max(0, Math.min(MAX_MAP_COLUMN_HEIGHT, current + Math.round(delta)));
    // A brand-new column takes the active colour; an existing one keeps its own.
    this.setColumn(x, y, next, current > 0 ? this.colors[this.index(x, y)]! : colorIndex);
    return next;
  }

  /** Recolour an existing column. No-op on an empty cell, so colour implies a column. */
  paint(x: number, y: number, colorIndex: number): void {
    if (this.heightAt(x, y) <= 0) return;
    this.colors[this.index(x, y)] = Math.max(0, Math.min(255, Math.floor(colorIndex)));
  }

  /** Remove a column. */
  clear(x: number, y: number): void {
    this.setColumn(x, y, 0, 0);
  }

  /** Remove every column, keeping the dimensions and shape. */
  clearAll(): void {
    this.heights.fill(0);
    this.colors.fill(0);
  }

  /** How many cells carry a column. */
  get columnCount(): number {
    let count = 0;
    for (let i = 0; i < this.heights.length; i += 1) if (this.heights[i]! > 0) count += 1;
    return count;
  }

  /** The tallest column present, or 0 when the layer is empty. */
  get peakHeight(): number {
    let peak = 0;
    for (let i = 0; i < this.heights.length; i += 1) if (this.heights[i]! > peak) peak = this.heights[i]!;
    return peak;
  }

  get isEmpty(): boolean {
    return this.columnCount === 0;
  }

  /** Visit every raised column with its cell coordinates. */
  forEachColumn(callback: (x: number, y: number, column: MapColumn) => void): void {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const i = this.index(x, y);
        if (this.heights[i]! === 0) continue;
        callback(x, y, { height: this.heights[i]!, colorIndex: this.colors[i]! });
      }
    }
  }

  /** A deep copy, optionally re-shaped (cubes ⇄ hexels keep the same columns). */
  clone(shape: CellShape = this.shape): MapVoxelLayer {
    const copy = new MapVoxelLayer(this.width, this.height, shape);
    copy.heights.set(this.heights);
    copy.colors.set(this.colors);
    return copy;
  }
}

// --- Serialization (portable base64, matching VoxelGrid's approach) ---------

function bytesToBase64(bytes: Uint8Array): string {
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

/**
 * Serialize the layer to a compact JSON string. Sparse: only raised columns are
 * written (their flat cell index, height and colour), so an empty or lightly
 * sculpted layer costs almost nothing per save. Indices are little-endian u32,
 * decoded the same way, so the payload is platform-independent.
 */
export function serializeMapVoxelLayer(layer: MapVoxelLayer): string {
  const count = layer.columnCount;
  const indexBytes = new Uint8Array(count * 4);
  const indexView = new DataView(indexBytes.buffer);
  const heights = new Uint8Array(count);
  const colors = new Uint8Array(count);

  let written = 0;
  layer.forEachColumn((x, y, column) => {
    indexView.setUint32(written * 4, y * layer.width + x, true);
    heights[written] = column.height;
    colors[written] = column.colorIndex;
    written += 1;
  });

  return JSON.stringify({
    version: MAP_VOXEL_LAYER_VERSION,
    width: layer.width,
    height: layer.height,
    // Cube is the default and is omitted, so a cube layer's payload stays minimal.
    ...(layer.shape === "cube" ? {} : { shape: layer.shape }),
    count,
    indices: bytesToBase64(indexBytes),
    heights: bytesToBase64(heights),
    colors: bytesToBase64(colors),
  });
}

/**
 * Parse a serialized layer, rejecting anything malformed or oversized — the
 * payload may arrive from another user's cart, so it is untrusted input. Throws
 * on invalid input; callers that mount the editor should catch and fall back to
 * an empty layer rather than failing the mount.
 */
export function deserializeMapVoxelLayer(json: string): MapVoxelLayer {
  const raw = JSON.parse(json) as {
    version?: number;
    width?: number;
    height?: number;
    shape?: unknown;
    count?: number;
    indices?: string;
    heights?: string;
    colors?: string;
  };
  if (raw.version !== MAP_VOXEL_LAYER_VERSION) {
    throw new Error(`Unsupported map voxel layer version: ${String(raw.version)}`);
  }
  const layer = new MapVoxelLayer(
    raw.width ?? 0,
    raw.height ?? 0,
    raw.shape === "hexel" ? "hexel" : "cube",
  );

  const cells = layer.width * layer.height;
  const count = raw.count ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > cells) throw new Error(PAYLOAD_MISMATCH);

  const indices = base64ToBytes(raw.indices ?? "");
  const heights = base64ToBytes(raw.heights ?? "");
  const colors = base64ToBytes(raw.colors ?? "");
  if (indices.length !== count * 4 || heights.length !== count || colors.length !== count) {
    throw new Error(PAYLOAD_MISMATCH);
  }

  const indexView = new DataView(indices.buffer, indices.byteOffset, indices.byteLength);
  for (let k = 0; k < count; k += 1) {
    const cellIndex = indexView.getUint32(k * 4, true);
    if (cellIndex >= cells) throw new Error(PAYLOAD_MISMATCH); // stray index → reject
    layer.setColumn(cellIndex % layer.width, Math.floor(cellIndex / layer.width), heights[k]!, colors[k]!);
  }
  return layer;
}

/** How the layer's palette indices become RGB when it is rebuilt as voxels. */
export type PaletteLookup = (colorIndex: number) => readonly [number, number, number];

export interface MapLayerGridOptions {
  /**
   * Largest grid edge to build on the map's two horizontal axes. A full-size map
   * is far wider than a {@link VoxelGrid} may be, so a preview downsamples by
   * taking every nth column; defaults to the grid's own maximum.
   */
  readonly maxFootprint?: number;
}

/**
 * Rebuild the layer as a {@link VoxelGrid}, ready for the voxel renderer. The
 * map's x axis becomes the grid's x, the map's y becomes the grid's z, and the
 * column height becomes y — the top-down map read as a landscape seen from above.
 *
 * Hexel layers place only even-parity sites, so the columns land on the FCC
 * lattice and the rhombic cells tile without overlapping.
 */
export function mapLayerToVoxelGrid(
  layer: MapVoxelLayer,
  palette: PaletteLookup,
  options: MapLayerGridOptions = {},
): VoxelGrid {
  const limit = Math.min(MAX_VOXEL_GRID_DIM, Math.max(1, options.maxFootprint ?? MAX_VOXEL_GRID_DIM));
  // Sample every nth cell so a 240x136 map fits the grid's footprint limit.
  const stride = Math.max(1, Math.ceil(Math.max(layer.width, layer.height) / limit));
  const sizeX = Math.max(1, Math.ceil(layer.width / stride));
  const sizeZ = Math.max(1, Math.ceil(layer.height / stride));
  const sizeY = Math.max(1, Math.min(MAX_VOXEL_GRID_DIM, layer.peakHeight));
  const grid = new VoxelGrid(sizeX, sizeY, sizeZ);

  const evenParity = layer.shape === "hexel";
  for (let z = 0; z < sizeZ; z += 1) {
    for (let x = 0; x < sizeX; x += 1) {
      const column = layer.columnAt(x * stride, z * stride);
      if (!column) continue;
      const [r, g, b] = palette(column.colorIndex);
      const top = Math.min(sizeY, column.height);
      for (let y = 0; y < top; y += 1) {
        if (evenParity && (((x + y + z) % 2) + 2) % 2 !== 0) continue;
        grid.set(x, y, z, r, g, b);
      }
    }
  }
  return grid;
}

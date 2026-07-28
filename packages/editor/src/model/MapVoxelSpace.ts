/**
 * MapVoxelSpace — the map's third dimension, as free-form 3D cells.
 *
 * {@link MapVoxelLayer} could only say how *tall* each map cell is: one column
 * per cell, solid from the ground up. That is enough for terrain seen from above
 * and nothing else — no overhang, no cave, no bridge, no floating island, and no
 * way to point at a single cell in space and remove it. This store addresses
 * every site independently, so the map is authored the way a sculpt is: place a
 * cell anywhere, carve one out from anywhere.
 *
 * Axes follow the convention {@link mapLayerToVoxelGrid} established, so the 3D
 * view and the top-down view agree without either having to transpose:
 *
 * - `x` — the map's column (0..`width`-1)
 * - `z` — the map's row    (0..`depth`-1)
 * - `y` — height above the ground (0..`maxHeight`-1)
 *
 * A cell is either a **solid** block or a **plane**: a flat quad standing in the
 * middle of its site, oriented by the axis its normal runs along. Planes are what
 * grass tufts, wires, ladders, banners and foliage are made of — art that lives on
 * a 2D surface inside 3D space, and would look absurd as a full cube. `cross`
 * places two perpendicular planes at one site, the classic foliage idiom.
 *
 * Storage is sparse for the same reason {@link VoxelGrid}'s is — the payload is
 * re-serialized into the undo timeline on every edit — but far more so here: a
 * Pro map is 640x360 cells, so a dense volume would be 14 million sites before a
 * single one is authored. Only occupied sites cost anything.
 *
 * Every column-shaped operation the top-down map editor already performed (raise,
 * lower, flatten, paint, erase) is kept, expressed over the cells, so the 2D view
 * and the procedural generators drive this store unchanged.
 *
 * Pure and DOM-free, like the rest of the model layer.
 */

import { geometryFor, isValidSite, type CellShape } from "../render/cellGeometry";
import type { ColumnTarget } from "../procgen/apply";
import {
  COLUMN_MATERIAL_NONE,
  MAX_MAP_COLUMN_HEIGHT,
  MapVoxelLayer,
  deserializeMapVoxelLayer,
  serializeMapVoxelLayer,
  type MapColumn,
} from "./MapVoxelLayer";

/**
 * Tallest a map cell may sit above the ground. Shared with the column layer so a
 * space and the payload it came from agree on the ceiling.
 */
export const MAX_MAP_VOXEL_HEIGHT = MAX_MAP_COLUMN_HEIGHT;

/**
 * Format version of the serialized space.
 *
 * v1 and v2 are {@link MapVoxelLayer}'s column payloads, which a space still both
 * reads and — when its cells happen to form plain columns — writes. v3 is this
 * module's sparse cell list, written only when the map actually holds something
 * a column payload could not express. See {@link serializeMapVoxelSpace}.
 */
export const MAP_VOXEL_SPACE_VERSION = 3;

/**
 * How a cell occupies its site. `solid` fills it as a block; the `plane*` kinds
 * stand a single flat quad in the middle of it, named for the axis its normal
 * runs along (`planeY` therefore lies flat, like a leaf on the ground); `cross`
 * stands two perpendicular quads, the shape foliage is drawn with.
 *
 * The order is the wire format — a kind serializes as its index here — so new
 * kinds append rather than insert.
 */
export const MAP_CELL_KINDS = ["solid", "planeX", "planeY", "planeZ", "cross"] as const;

export type MapCellKind = (typeof MAP_CELL_KINDS)[number];

/** Whether a kind stands flat art rather than filling its site as a block. */
export function isPlaneKind(kind: MapCellKind): boolean {
  return kind !== "solid";
}

/**
 * The axis a plane kind's normal runs along (0 = x, 1 = y, 2 = z), or -1 for a
 * kind with no single axis (a solid block, or the two-quad cross).
 */
export function planeAxisOf(kind: MapCellKind): number {
  return kind === "planeX" ? 0 : kind === "planeY" ? 1 : kind === "planeZ" ? 2 : -1;
}

/** A single occupied site. */
export interface MapVoxelCell {
  /** Palette index the cell is painted with, so it follows the cart palette. */
  readonly colorIndex: number;
  /**
   * Texture-material index skinning the cell, or {@link COLUMN_MATERIAL_NONE} for
   * flat colour. Plane cells are all but always skinned — a flat-coloured quad is
   * just a coloured rectangle — but nothing here requires it.
   */
  readonly material: number;
  readonly kind: MapCellKind;
}

// A cell packs into one safe integer so the sparse map stores numbers rather than
// objects: 8 bits of palette index, 4 of kind, then the material biased by one so
// "none" (-1) packs as zero.
const COLOR_MASK = 0xff;
const KIND_SHIFT = 8;
const KIND_MASK = 0xf;
const MATERIAL_SHIFT = 12;
const MATERIAL_MASK = 0xffff;
/** Largest material index a cell can carry, given the packed field's width. */
export const MAX_MAP_CELL_MATERIAL = MATERIAL_MASK - 1;

function packCell(cell: MapVoxelCell): number {
  const kind = Math.max(0, MAP_CELL_KINDS.indexOf(cell.kind));
  const material = Math.max(-1, Math.min(MAX_MAP_CELL_MATERIAL, Math.floor(cell.material))) + 1;
  return (
    (Math.max(0, Math.min(COLOR_MASK, Math.floor(cell.colorIndex))) & COLOR_MASK) |
    ((kind & KIND_MASK) << KIND_SHIFT) |
    ((material & MATERIAL_MASK) * (1 << MATERIAL_SHIFT))
  );
}

function unpackCell(packed: number): MapVoxelCell {
  return {
    colorIndex: packed & COLOR_MASK,
    kind: MAP_CELL_KINDS[(packed >> KIND_SHIFT) & KIND_MASK] ?? "solid",
    material: (Math.floor(packed / (1 << MATERIAL_SHIFT)) & MATERIAL_MASK) - 1,
  };
}

const PAYLOAD_MISMATCH = "Map voxel space payload size does not match its dimensions";

function assertDim(dim: number, axis: string): void {
  if (!Number.isInteger(dim) || dim < 1) {
    throw new RangeError(`Map voxel space ${axis} must be a positive integer, received ${dim}`);
  }
}

export class MapVoxelSpace {
  /** Map columns — the top-down x axis. */
  readonly width: number;
  /** Map rows — the top-down y axis, which is this store's z. */
  readonly depth: number;
  /** Sites above the ground a column may hold. */
  readonly maxHeight: number;
  /** Occupied sites, flat index → packed cell. Sparse: only what is authored. */
  private readonly cells = new Map<number, number>();
  /**
   * One past the topmost occupied site per map cell, row-major over the footprint.
   *
   * Derived state, kept in step with {@link cells} on every write. The top-down
   * canvas asks for a column's height once per drawn cell on every repaint, and
   * scanning the vertical axis for each would be tens of millions of lookups a
   * frame on a Pro-sized map; this makes it a single array read. Dense because the
   * footprint is small next to the volume — a quarter of a megabyte at the largest
   * console model, against fourteen million sites.
   */
  private readonly heights: Uint8Array;

  constructor(
    width: number,
    depth: number,
    /** Whether the cells are cubes or hexels. One shape per map, as before. */
    readonly shape: CellShape = "cube",
    maxHeight: number = MAX_MAP_VOXEL_HEIGHT,
  ) {
    assertDim(width, "width");
    assertDim(depth, "depth");
    assertDim(maxHeight, "maxHeight");
    this.width = width;
    this.depth = depth;
    this.maxHeight = Math.min(MAX_MAP_VOXEL_HEIGHT, maxHeight);
    this.heights = new Uint8Array(width * depth);
  }

  /** Flat index of a map cell within the footprint (the {@link heights} index). */
  private columnIndex(x: number, z: number): number {
    return z * this.width + x;
  }

  /** Flat index of a site; assumes the coordinates are in bounds. */
  index(x: number, y: number, z: number): number {
    return (z * this.maxHeight + y) * this.width + x;
  }

  /** The site a flat index addresses — the inverse of {@link index}. */
  coordsOf(index: number): [number, number, number] {
    const x = index % this.width;
    const rest = Math.floor(index / this.width);
    return [x, rest % this.maxHeight, Math.floor(rest / this.maxHeight)];
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.maxHeight && z >= 0 && z < this.depth;
  }

  /**
   * Whether a site may hold a cell at all: in bounds, and — for a hexel map — on
   * the FCC lattice. Hexels only tile on even-parity sites, so an edit that
   * ignored this would place overlapping, mis-rendered cells.
   */
  isValidSite(x: number, y: number, z: number): boolean {
    return this.inBounds(x, y, z) && isValidSite(geometryFor(this.shape), x, y, z);
  }

  isFilled(x: number, y: number, z: number): boolean {
    return this.inBounds(x, y, z) && this.cells.has(this.index(x, y, z));
  }

  /** The cell at a site, or null when it is empty or out of bounds. */
  cellAt(x: number, y: number, z: number): MapVoxelCell | null {
    if (!this.inBounds(x, y, z)) return null;
    const packed = this.cells.get(this.index(x, y, z));
    return packed === undefined ? null : unpackCell(packed);
  }

  /**
   * Place (or replace) a cell. Ignored on a site the shape cannot hold, so a
   * caller may sweep a whole box across a hexel map and let the lattice decide.
   * Returns whether the site now holds the cell.
   */
  set(x: number, y: number, z: number, cell: MapVoxelCell): boolean {
    if (!this.isValidSite(x, y, z)) return false;
    this.cells.set(this.index(x, y, z), packCell(cell));
    const column = this.columnIndex(x, z);
    if (y + 1 > this.heights[column]!) this.heights[column] = y + 1;
    return true;
  }

  /** Recolour (and optionally re-skin) a cell that already exists. */
  recolor(x: number, y: number, z: number, colorIndex: number, material?: number): void {
    const current = this.cellAt(x, y, z);
    if (!current) return;
    this.set(x, y, z, {
      ...current,
      colorIndex,
      material: material === undefined ? current.material : material,
    });
  }

  /** Empty a site. */
  clear(x: number, y: number, z: number): void {
    if (!this.inBounds(x, y, z)) return;
    if (!this.cells.delete(this.index(x, y, z))) return;
    // Only removing the *top* of a column can change its height, and the new top
    // is almost always the site just below, so the rescan is a step or two.
    const column = this.columnIndex(x, z);
    if (this.heights[column] !== y + 1) return;
    let top = 0;
    for (let below = y - 1; below >= 0; below -= 1) {
      if (this.cells.has(this.index(x, below, z))) {
        top = below + 1;
        break;
      }
    }
    this.heights[column] = top;
  }

  /** Empty every site, keeping the dimensions and shape. */
  clearAll(): void {
    this.cells.clear();
    this.heights.fill(0);
  }

  /** How many sites are occupied. */
  get cellCount(): number {
    return this.cells.size;
  }

  get isEmpty(): boolean {
    return this.cells.size === 0;
  }

  /** Visit every occupied site. Iteration order is insertion order, not spatial. */
  forEachCell(callback: (x: number, y: number, z: number, cell: MapVoxelCell) => void): void {
    for (const [index, packed] of this.cells) {
      const [x, y, z] = this.coordsOf(index);
      callback(x, y, z, unpackCell(packed));
    }
  }

  // --- The column view -------------------------------------------------------
  // What the top-down map editor and the procedural generators speak. A "column"
  // is now a derived reading of the cells above one map cell rather than the
  // stored truth, which is what lets both views drive one store.

  /** One past the topmost occupied site above a map cell, or 0 when there is none. */
  heightAt(x: number, z: number): number {
    if (x < 0 || x >= this.width || z < 0 || z >= this.depth) return 0;
    return this.heights[this.columnIndex(x, z)]!;
  }

  /** The topmost cell above a map cell, or null when the column is empty. */
  topCellAt(x: number, z: number): MapVoxelCell | null {
    const height = this.heightAt(x, z);
    return height === 0 ? null : this.cellAt(x, height - 1, z);
  }

  /**
   * The column above a map cell as the top-down view reads it: how tall it stands
   * and what its topmost cell looks like. Null when nothing is stacked there.
   */
  columnAt(x: number, z: number): MapColumn | null {
    const height = this.heightAt(x, z);
    if (height === 0) return null;
    const top = this.cellAt(x, height - 1, z);
    return {
      height,
      colorIndex: top?.colorIndex ?? 0,
      material: top?.material ?? COLUMN_MATERIAL_NONE,
    };
  }

  /**
   * Stack a solid column of `height` cells from the ground, clearing everything
   * above it. This is "flatten" and the generators' write path: it states what the
   * column *is*, so it must remove overhangs it is replacing rather than leave
   * them floating over new ground.
   *
   * On a hexel map only half the sites in the range are on the lattice, so a
   * column is built from those. A short column can name a range holding none at
   * all — a height of one over a site whose coordinates sum odd — and dropping it
   * would quietly delete a column its author placed and can see from above. It is
   * raised to the nearest real site instead, so the column exists, one level
   * taller than asked for, rather than not at all.
   */
  setColumn(x: number, z: number, height: number, colorIndex: number, material = COLUMN_MATERIAL_NONE): void {
    if (x < 0 || x >= this.width || z < 0 || z >= this.depth) return;
    const top = Math.max(0, Math.min(this.maxHeight, Math.floor(height)));
    const cell: MapVoxelCell = { colorIndex, material, kind: "solid" };

    let placed = 0;
    for (let y = 0; y < this.maxHeight; y += 1) {
      if (y < top && this.set(x, y, z, cell)) placed += 1;
      else this.clear(x, y, z);
    }
    if (top === 0 || placed > 0) return;
    for (let y = top; y < this.maxHeight; y += 1) {
      if (this.set(x, y, z, cell)) return;
    }
  }

  /**
   * Raise (or, with a negative delta, lower) the column above a map cell. New
   * cells inherit the look of the column's current top — raising ground must not
   * restyle what is already there — and only a brand-new column takes the armed
   * colour and material, exactly as the column layer behaved.
   *
   * Returns the resulting height, so the caller can report what the edit did.
   */
  raise(x: number, z: number, delta: number, colorIndex: number, material = COLUMN_MATERIAL_NONE): number {
    if (x < 0 || x >= this.width || z < 0 || z >= this.depth) return 0;
    const current = this.heightAt(x, z);
    const next = Math.max(0, Math.min(this.maxHeight, current + Math.round(delta)));
    const top = current > 0 ? this.cellAt(x, current - 1, z) : null;
    const style: MapVoxelCell = top
      ? { colorIndex: top.colorIndex, material: top.material, kind: "solid" }
      : { colorIndex, material, kind: "solid" };

    for (let y = current; y < next; y += 1) this.set(x, y, z, style);
    for (let y = next; y < current; y += 1) this.clear(x, y, z);
    return next;
  }

  /**
   * Recolour the whole column above a map cell — what Paint means from the
   * top-down view, where a column reads as one thing. No-op on an empty column,
   * so colour still implies something to colour.
   */
  paintColumn(x: number, z: number, colorIndex: number, material?: number): void {
    for (let y = 0; y < this.maxHeight; y += 1) {
      this.recolor(x, y, z, colorIndex, material);
    }
  }

  /** Remove everything stacked above a map cell. */
  clearColumn(x: number, z: number): void {
    for (let y = 0; y < this.maxHeight; y += 1) this.clear(x, y, z);
  }

  /** How many map cells carry at least one stacked cell. */
  get columnCount(): number {
    let count = 0;
    for (let i = 0; i < this.heights.length; i += 1) if (this.heights[i]! > 0) count += 1;
    return count;
  }

  /** The tallest column present, or 0 when the space is empty. */
  get peakHeight(): number {
    let peak = 0;
    for (let i = 0; i < this.heights.length; i += 1) if (this.heights[i]! > peak) peak = this.heights[i]!;
    return peak;
  }

  /**
   * Whether anything is built within `radius` map cells of a point, on either
   * horizontal axis — the same window the 3D view builds. Asked before dropping a
   * camera somewhere, so it never opens staring into empty air.
   */
  hasCellsNear(x: number, z: number, radius: number): boolean {
    const minX = Math.max(0, Math.floor(x) - radius);
    const maxX = Math.min(this.width - 1, Math.floor(x) + radius);
    const minZ = Math.max(0, Math.floor(z) - radius);
    const maxZ = Math.min(this.depth - 1, Math.floor(z) + radius);
    for (let cz = minZ; cz <= maxZ; cz += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        if (this.heights[this.columnIndex(cx, cz)]! > 0) return true;
      }
    }
    return false;
  }

  /**
   * The middle of everything built, as a point to stand at, or null when the map
   * is empty. Reads from the footprint rather than the cells so it costs the same
   * whether the map holds ten cells or a million.
   */
  contentCentre(): { x: number; y: number; z: number } | null {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let peak = 0;
    for (let z = 0; z < this.depth; z += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const height = this.heights[this.columnIndex(x, z)]!;
        if (height === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (height > peak) peak = height;
      }
    }
    if (maxX < minX) return null;
    // Standing at half the tallest column keeps both the ground and the skyline
    // of what is built in frame.
    return { x: (minX + maxX) / 2, y: Math.floor(peak / 2), z: (minZ + maxZ) / 2 };
  }

  /** Visit every map cell that carries a column, with its top-down reading. */
  forEachColumn(callback: (x: number, z: number, column: MapColumn) => void): void {
    for (let z = 0; z < this.depth; z += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (this.heights[this.columnIndex(x, z)] === 0) continue;
        const column = this.columnAt(x, z);
        if (column) callback(x, z, column);
      }
    }
  }

  /**
   * A deep copy, optionally re-shaped or re-sized. Cells that the new shape or
   * footprint cannot hold are dropped rather than clamped, since moving a cell
   * would silently change what was authored.
   */
  clone(
    options: { shape?: CellShape; width?: number; depth?: number } = {},
  ): MapVoxelSpace {
    const copy = new MapVoxelSpace(
      options.width ?? this.width,
      options.depth ?? this.depth,
      options.shape ?? this.shape,
      this.maxHeight,
    );
    this.forEachCell((x, y, z, cell) => {
      copy.set(x, y, z, cell);
    });
    return copy;
  }
}

/**
 * The space seen as the procedural generators' flat {@link ColumnTarget}: the
 * map's rows read as `height`, because a field is generated in map space and
 * knows nothing about the third dimension.
 *
 * An adapter rather than a shape the class itself implements: `height` would then
 * have to mean "map rows" on a type whose whole purpose is a vertical axis.
 */
export function mapColumnTarget(space: MapVoxelSpace): ColumnTarget {
  return {
    width: space.width,
    height: space.depth,
    setColumn: (x, y, height, colorIndex, material) =>
      space.setColumn(x, y, height, colorIndex, material),
  };
}

// --- Bridging to the column layer -----------------------------------------

/** Rebuild a space from a saved column layer — how every pre-3D map loads. */
export function mapSpaceFromColumns(layer: MapVoxelLayer, maxHeight = MAX_MAP_VOXEL_HEIGHT): MapVoxelSpace {
  const space = new MapVoxelSpace(layer.width, layer.height, layer.shape, maxHeight);
  layer.forEachColumn((x, z, column) => {
    space.setColumn(x, z, column.height, column.colorIndex, column.material);
  });
  return space;
}

/** What one map cell's stack looks like while {@link mapSpaceToColumns} tallies it. */
interface ColumnTally {
  cells: number;
  top: number;
  colorIndex: number;
  material: number;
  /** Set once anything disqualifies the stack from being a plain column. */
  broken: boolean;
}

/**
 * The number of sites a solid column of `height` occupies above `(x, z)`. Cubes
 * fill every site; hexels only the even-parity ones, so half of a hexel column's
 * sites are legitimately empty and a naive "is it contiguous?" test would call
 * every hexel map non-columnar.
 */
function columnSiteCount(shape: CellShape, x: number, z: number, height: number): number {
  if (shape !== "hexel") return height;
  let count = 0;
  for (let y = 0; y < height; y += 1) if ((((x + y + z) % 2) + 2) % 2 === 0) count += 1;
  return count;
}

/**
 * The column layer this space is exactly equivalent to, or null when it holds
 * something columns cannot express — an overhang, a cave, a plane, or a column
 * whose cells are not all one colour.
 *
 * Decided in a single pass over the authored cells: a stack is a column when every
 * cell in it is solid, they share a colour and material, and they fill exactly the
 * sites a column of that height would (which is what {@link columnSiteCount}
 * knows, parity and all). Sites are unique keys and can never be off-lattice, so
 * matching the count is enough to prove the set matches.
 */
export function mapSpaceToColumns(space: MapVoxelSpace): MapVoxelLayer | null {
  const tallies = new Map<number, ColumnTally>();

  let columnar = true;
  space.forEachCell((x, y, z, cell) => {
    if (!columnar) return;
    if (cell.kind !== "solid") {
      columnar = false;
      return;
    }
    const key = z * space.width + x;
    const tally = tallies.get(key);
    if (!tally) {
      tallies.set(key, {
        cells: 1,
        top: y + 1,
        colorIndex: cell.colorIndex,
        material: cell.material,
        broken: false,
      });
      return;
    }
    tally.cells += 1;
    if (y + 1 > tally.top) tally.top = y + 1;
    if (cell.colorIndex !== tally.colorIndex || cell.material !== tally.material) tally.broken = true;
  });
  if (!columnar) return null;

  const layer = new MapVoxelLayer(space.width, space.depth, space.shape);
  for (const [key, tally] of tallies) {
    const x = key % space.width;
    const z = Math.floor(key / space.width);
    if (tally.broken || tally.cells !== columnSiteCount(space.shape, x, z, tally.top)) return null;
    layer.setColumn(x, z, tally.top, tally.colorIndex, tally.material);
  }
  return layer;
}

// --- Serialization ---------------------------------------------------------

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
 * Serialize a space, in the oldest shape that can carry it.
 *
 * A map whose cells still form plain columns writes the column payload it always
 * did, byte for byte — which is the whole compatibility story: adding free-form 3D
 * rewrites nobody's saved cart, and a map only starts costing the newer format
 * once its author actually builds something the older one could not describe.
 */
export function serializeMapVoxelSpace(space: MapVoxelSpace): string {
  const columns = mapSpaceToColumns(space);
  if (columns) return serializeMapVoxelLayer(columns);

  const count = space.cellCount;
  const indexBytes = new Uint8Array(count * 4);
  const indexView = new DataView(indexBytes.buffer);
  const colors = new Uint8Array(count);
  const kinds = new Uint8Array(count);
  // Materials ride parallel to the cells, as signed 16-bit indices, and only when
  // the space uses any — the same economy the column payload makes.
  const materialBytes = new Uint8Array(count * 2);
  const materialView = new DataView(materialBytes.buffer);
  let textured = false;

  let written = 0;
  space.forEachCell((x, y, z, cell) => {
    indexView.setUint32(written * 4, space.index(x, y, z), true);
    colors[written] = cell.colorIndex;
    kinds[written] = Math.max(0, MAP_CELL_KINDS.indexOf(cell.kind));
    materialView.setInt16(written * 2, cell.material, true);
    if (cell.material >= 0) textured = true;
    written += 1;
  });

  return JSON.stringify({
    version: MAP_VOXEL_SPACE_VERSION,
    width: space.width,
    depth: space.depth,
    maxHeight: space.maxHeight,
    // Cube is the default and is omitted, so a cube map's payload stays minimal.
    ...(space.shape === "cube" ? {} : { shape: space.shape }),
    count,
    indices: bytesToBase64(indexBytes),
    colors: bytesToBase64(colors),
    kinds: bytesToBase64(kinds),
    ...(textured ? { materials: bytesToBase64(materialBytes) } : {}),
  });
}

/**
 * Parse a saved map payload of any era — the sparse v3 space, or the v1/v2 column
 * layers, which are upgraded on the way through. Rejects anything malformed or
 * oversized: the payload may arrive from another user's cart, so it is untrusted
 * input. Throws on invalid input; callers mounting the editor should catch and
 * fall back to an empty space rather than failing the mount.
 */
export function deserializeMapVoxelSpace(json: string): MapVoxelSpace {
  const raw = JSON.parse(json) as {
    version?: number;
    width?: number;
    depth?: number;
    maxHeight?: number;
    shape?: unknown;
    count?: number;
    indices?: string;
    colors?: string;
    kinds?: string;
    materials?: string;
  };

  // The column payloads are still first-class: they are what most carts hold.
  if (raw.version === 1 || raw.version === 2) return mapSpaceFromColumns(deserializeMapVoxelLayer(json));
  if (raw.version !== MAP_VOXEL_SPACE_VERSION) {
    throw new Error(`Unsupported map voxel space version: ${String(raw.version)}`);
  }

  const space = new MapVoxelSpace(
    raw.width ?? 0,
    raw.depth ?? 0,
    raw.shape === "hexel" ? "hexel" : "cube",
    raw.maxHeight ?? MAX_MAP_VOXEL_HEIGHT,
  );

  const sites = space.width * space.depth * space.maxHeight;
  const count = raw.count ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > sites) throw new Error(PAYLOAD_MISMATCH);

  const indices = base64ToBytes(raw.indices ?? "");
  const colors = base64ToBytes(raw.colors ?? "");
  const kinds = base64ToBytes(raw.kinds ?? "");
  if (indices.length !== count * 4 || colors.length !== count || kinds.length !== count) {
    throw new Error(PAYLOAD_MISMATCH);
  }
  const materials = raw.materials ? base64ToBytes(raw.materials) : null;
  if (materials && materials.length !== count * 2) throw new Error(PAYLOAD_MISMATCH);

  const indexView = new DataView(indices.buffer, indices.byteOffset, indices.byteLength);
  const materialView = materials
    ? new DataView(materials.buffer, materials.byteOffset, materials.byteLength)
    : null;

  for (let k = 0; k < count; k += 1) {
    const index = indexView.getUint32(k * 4, true);
    if (index >= sites) throw new Error(PAYLOAD_MISMATCH); // stray index → reject
    const [x, y, z] = space.coordsOf(index);
    space.set(x, y, z, {
      colorIndex: colors[k]!,
      kind: MAP_CELL_KINDS[kinds[k]!] ?? "solid",
      material: materialView ? materialView.getInt16(k * 2, true) : COLUMN_MATERIAL_NONE,
    });
  }
  return space;
}

/**
 * Restore a cart's saved map, or start an empty one, at the footprint the console
 * model currently declares.
 *
 * A payload whose footprint does not match (the cart was authored on another
 * console model) is *rebuilt* at the current size rather than discarded, so the
 * cells that still fit survive — losing the edge of a map is recoverable, losing
 * all of it is not. A corrupt payload must not break the editor's mount, so it
 * degrades to an empty space.
 */
export function loadMapVoxelSpace(payload: string | null, width: number, depth: number): MapVoxelSpace {
  if (!payload) return new MapVoxelSpace(width, depth);
  try {
    const saved = deserializeMapVoxelSpace(payload);
    if (saved.width === width && saved.depth === depth) return saved;
    return saved.clone({ width, depth });
  } catch {
    return new MapVoxelSpace(width, depth);
  }
}

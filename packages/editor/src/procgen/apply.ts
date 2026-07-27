/**
 * Applying a generated {@link ClassField} to the three things the editor can
 * author: map tiles, sprite pixels, and voxel/hexel columns.
 *
 * Generation and application are deliberately separate. A generator only decides
 * *what kind* of ground each cell is; the mapping from a class to a tile index, a
 * palette colour, or a column height is the user's, edited in the Generate panel
 * and re-applied without regenerating. That split is also why every generator
 * works on every layer — nothing here knows which generator produced the field.
 *
 * Each target is a structural interface rather than a concrete class, so this
 * module stays decoupled from `TileMap`, `SpriteSheet` and `MapVoxelLayer`, and
 * the tests can drive it with recording doubles as well as the real thing.
 *
 * Pure and DOM-free.
 */

import { classAt, type ClassField, type ClassInfo } from "./classField";
import type { Rgb } from "../model/lighting";
import { NO_MATERIAL, resolveMaterial, type MaterialResolver, type SurfaceId } from "./surfaces";

/** How a class maps onto each target: which tile, colour, height and material. */
export interface ClassMapping {
  /** Tile index stamped for this class on the tile layer. */
  readonly tile: number;
  /** Palette index painted for this class on the pixel and column layers. */
  readonly colorIndex: number;
  /** Column height for this class on the voxel/hexel layer; 0 leaves it empty. */
  readonly columnHeight: number;
  /**
   * Texture-material index the column layer skins this class with, or
   * {@link NO_MATERIAL} for a flat colour. Generated ground therefore comes out
   * wearing grass, sand and rock rather than untextured blocks.
   */
  readonly material: number;
}

/** A map whose cells can be stamped with tile indices. */
export interface TileTarget {
  readonly width: number;
  readonly height: number;
  setCell(x: number, y: number, tile: number): void;
}

/** A pixel surface addressed in map-pixel space. */
export interface PixelTarget {
  readonly width: number;
  readonly height: number;
  setPixel(x: number, y: number, colorIndex: number): void;
}

/** A column layer that can be raised, painted and skinned per cell. */
export interface ColumnTarget {
  readonly width: number;
  readonly height: number;
  setColumn(x: number, y: number, height: number, colorIndex: number, material?: number): void;
}

/** Where a field is written, when it is smaller than the target. */
export interface ApplyOptions {
  readonly originX?: number;
  readonly originY?: number;
}

export interface DefaultMappingOptions {
  /** Tile index the first class takes; the rest count up from it. */
  readonly firstTile?: number;
  /** Palette index the first class takes, when no `nearestColor` is supplied. */
  readonly firstColor?: number;
  /**
   * Resolve a class's representative colour to a palette index. Supplying the
   * cart's own nearest-colour lookup is what makes a generated landscape open in
   * plausible colours — green grass, blue water — instead of whatever happens to
   * sit at palette slots 1..7.
   */
  readonly nearestColor?: (color: Rgb) => number;
  /**
   * Resolve a class to a texture material, via the surface its legend id names.
   * Supplying it opens the mapping already skinned; omitting it leaves every
   * class flat.
   */
  readonly materialFor?: MaterialResolver;
}

/**
 * Default mappings for a legend: each class takes a distinct tile index, a
 * palette colour, and a column height that follows the legend's order — which is
 * why generator legends are written low-ground first. Terrain therefore terraces
 * sensibly out of the box, and a two-class generator gives flat floor and
 * standing wall.
 */
export function defaultClassMapping(
  legend: readonly ClassInfo[],
  options: DefaultMappingOptions = {},
): ClassMapping[] {
  const firstTile = options.firstTile ?? 1;
  const firstColor = options.firstColor ?? 1;
  const tallest = Math.max(1, legend.length - 1);
  return legend.map((entry, index) => ({
    tile: firstTile + index,
    colorIndex: options.nearestColor ? options.nearestColor(entry.color) : firstColor + index,
    // Spread the legend's classes over a modest height range so the shape of the
    // generated ground reads immediately without towering over the map.
    columnHeight: index === 0 ? 0 : Math.max(1, Math.round((index / tallest) * 8)),
    material: resolveMaterial(options.materialFor, surfaceForClassId(entry.id)),
  }));
}

/**
 * The surface a legend class presents. Legend ids are already surface-like
 * ("sand", "rock", "wall"), so most map straight through; the rest are named
 * here once rather than each generator having to declare a parallel table.
 */
const CLASS_ID_SURFACES: Readonly<Record<string, SurfaceId>> = {
  deepWater: "water",
  shallowWater: "water",
  sand: "sand",
  grass: "grass",
  forest: "forest",
  rock: "rock",
  snow: "snow",
  floor: "dirt",
  wall: "brick",
  path: "planks",
  room: "planks",
  corridor: "dirt",
};

/** The surface a legend class id names, defaulting to bare rock. */
export function surfaceForClassId(id: string): SurfaceId {
  return CLASS_ID_SURFACES[id] ?? "rock";
}

/** The mapping for a class, falling back to a benign entry for a stray index. */
function mappingFor(mapping: readonly ClassMapping[], value: number): ClassMapping {
  return mapping[value] ?? { tile: 0, colorIndex: 0, columnHeight: 0, material: NO_MATERIAL };
}

/**
 * Stamp a field onto a tile map. Returns how many cells were written, so the
 * editor can report the result rather than leaving the user guessing.
 */
export function applyFieldToTiles(
  target: TileTarget,
  field: ClassField,
  mapping: readonly ClassMapping[],
  options: ApplyOptions = {},
): number {
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;
  let written = 0;
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      const tx = originX + x;
      const ty = originY + y;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      target.setCell(tx, ty, mappingFor(mapping, classAt(field, x, y)).tile);
      written += 1;
    }
  }
  return written;
}

/**
 * Paint a field as pixels. The field is sampled with nearest-neighbour across
 * the target region, so a field generated at map-cell resolution can fill a
 * pixel-resolution area (each cell covering a tile's worth of pixels) without
 * the caller having to resample it first.
 */
export function applyFieldToPixels(
  target: PixelTarget,
  field: ClassField,
  mapping: readonly ClassMapping[],
  region: { x: number; y: number; width: number; height: number },
): number {
  let written = 0;
  for (let py = 0; py < region.height; py += 1) {
    for (let px = 0; px < region.width; px += 1) {
      const tx = region.x + px;
      const ty = region.y + py;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const fx = Math.min(field.width - 1, Math.floor((px / region.width) * field.width));
      const fy = Math.min(field.height - 1, Math.floor((py / region.height) * field.height));
      target.setPixel(tx, ty, mappingFor(mapping, classAt(field, fx, fy)).colorIndex);
      written += 1;
    }
  }
  return written;
}

/**
 * Raise a field into voxel or hexel columns. A class mapped to height 0 clears
 * its cells, so water and open floor stay flat instead of becoming a slab.
 */
export function applyFieldToColumns(
  target: ColumnTarget,
  field: ClassField,
  mapping: readonly ClassMapping[],
  options: ApplyOptions = {},
): number {
  const originX = options.originX ?? 0;
  const originY = options.originY ?? 0;
  let raised = 0;
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      const tx = originX + x;
      const ty = originY + y;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const entry = mappingFor(mapping, classAt(field, x, y));
      target.setColumn(tx, ty, entry.columnHeight, entry.colorIndex, entry.material);
      if (entry.columnHeight > 0) raised += 1;
    }
  }
  return raised;
}

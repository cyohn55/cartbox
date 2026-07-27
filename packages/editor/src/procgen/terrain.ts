/**
 * Turning a {@link HeightField} into terrain *classes* — deep water through to
 * snow — and the strata that sit under each surface.
 *
 * The bands are expressed as ascending cut points on normalized height, so the
 * classification is a single search rather than a ladder of hand-tuned
 * conditionals, and the tests can assert the ordering property (a taller column
 * never lands in a lower band) instead of hard-coded band boundaries.
 *
 * Pure and DOM-free.
 */

import { classAt, createClassField, type ClassField, type ClassInfo } from "./classField";
import type { Rgb } from "../model/lighting";
import type { SurfaceId } from "./surfaces";
import { heightAt, moistureAt, type HeightField } from "./heightField";

/**
 * Terrain classes, ordered from lowest to highest ground. The order is load
 * bearing: {@link classifyTerrain} picks a class by counting how many band cut
 * points a column clears, and the voxel extruder reads "is this below water"
 * as an index comparison against {@link TERRAIN_CLASS.shallowWater}.
 */
export const TERRAIN_LEGEND: readonly ClassInfo[] = [
  { id: "deepWater", label: "Deep water", color: [24, 52, 112] },
  { id: "shallowWater", label: "Shallow water", color: [42, 96, 168] },
  { id: "sand", label: "Sand", color: [214, 194, 130] },
  { id: "grass", label: "Grass", color: [86, 148, 62] },
  { id: "forest", label: "Forest", color: [46, 102, 52] },
  { id: "rock", label: "Rock", color: [126, 122, 118] },
  { id: "snow", label: "Snow", color: [232, 238, 246] },
];

/** Named indices into {@link TERRAIN_LEGEND}, so callers never count by hand. */
export const TERRAIN_CLASS = {
  deepWater: 0,
  shallowWater: 1,
  sand: 2,
  grass: 3,
  forest: 4,
  rock: 5,
  snow: 6,
} as const;

/** The strata a solid column is built from, below its surface class. */
export const SUBSURFACE_COLORS: { readonly soil: Rgb; readonly stone: Rgb; readonly bedrock: Rgb } = {
  soil: [122, 88, 56],
  stone: [104, 104, 110],
  bedrock: [58, 58, 66],
};

export interface TerrainBands {
  /** Normalized height below which a column is deep water. */
  readonly deepWater: number;
  /** …below which it is shallow water (the shoreline sits just above this). */
  readonly waterLine: number;
  /** …below which the shore is bare sand. */
  readonly shore: number;
  /** …below which vegetation grows (grass or forest, chosen by moisture). */
  readonly treeLine: number;
  /** …below which bare rock shows; above it, snow. */
  readonly snowLine: number;
}

export const DEFAULT_TERRAIN_BANDS: TerrainBands = {
  deepWater: 0.3,
  waterLine: 0.42,
  shore: 0.47,
  treeLine: 0.68,
  snowLine: 0.82,
};

/** Moisture above which vegetated ground reads as forest rather than open grass. */
export const DEFAULT_FOREST_MOISTURE = 0.55;

/**
 * The default bands rescaled so the waterline sits at `waterLevel`: the
 * submerged bands compress into everything below it and the dry bands stretch
 * across everything above. One "how much sea" control therefore moves the whole
 * ladder coherently, instead of exposing five thresholds the user must keep in
 * order themselves.
 */
export function bandsForWaterLevel(waterLevel: number): TerrainBands {
  const target = Math.min(0.95, Math.max(0.05, waterLevel));
  const pivot = DEFAULT_TERRAIN_BANDS.waterLine;
  const below = target / pivot;
  const above = (1 - target) / (1 - pivot);
  // Rescale each default band about the pivot, keeping the ascending order that
  // `terrainClassOf` relies on.
  const rescale = (band: number): number =>
    band <= pivot ? band * below : target + (band - pivot) * above;
  return {
    deepWater: rescale(DEFAULT_TERRAIN_BANDS.deepWater),
    waterLine: target,
    shore: rescale(DEFAULT_TERRAIN_BANDS.shore),
    treeLine: rescale(DEFAULT_TERRAIN_BANDS.treeLine),
    snowLine: rescale(DEFAULT_TERRAIN_BANDS.snowLine),
  };
}

export interface ClassifyTerrainOptions {
  readonly bands?: TerrainBands;
  readonly forestMoisture?: number;
}

/**
 * Derive the band cut points as an ascending array, so classification is "how
 * many cut points does this height clear" and the class order and the band order
 * are guaranteed to agree.
 */
function bandCutPoints(bands: TerrainBands): number[] {
  return [bands.deepWater, bands.waterLine, bands.shore, bands.treeLine, bands.snowLine];
}

/**
 * The surface class of a single normalized height. Vegetated ground splits into
 * grass or forest by moisture; every other band maps straight through.
 */
export function terrainClassOf(
  height: number,
  moisture: number,
  bands: TerrainBands = DEFAULT_TERRAIN_BANDS,
  forestMoisture: number = DEFAULT_FOREST_MOISTURE,
): number {
  const cuts = bandCutPoints(bands);
  let cleared = 0;
  while (cleared < cuts.length && height >= cuts[cleared]!) cleared += 1;

  // `cleared` indexes the low classes directly: 0 deep water, 1 shallow, 2 sand,
  // 3 vegetated, 4 rock, 5 snow — the vegetated band being the one that splits.
  switch (cleared) {
    case 0:
      return TERRAIN_CLASS.deepWater;
    case 1:
      return TERRAIN_CLASS.shallowWater;
    case 2:
      return TERRAIN_CLASS.sand;
    case 3:
      return moisture >= forestMoisture ? TERRAIN_CLASS.forest : TERRAIN_CLASS.grass;
    case 4:
      return TERRAIN_CLASS.rock;
    default:
      return TERRAIN_CLASS.snow;
  }
}

/** Classify a whole height field into a {@link ClassField} over {@link TERRAIN_LEGEND}. */
export function classifyTerrain(field: HeightField, options: ClassifyTerrainOptions = {}): ClassField {
  const bands = options.bands ?? DEFAULT_TERRAIN_BANDS;
  const forestMoisture = options.forestMoisture ?? DEFAULT_FOREST_MOISTURE;
  const out = createClassField(field.width, field.depth, TERRAIN_LEGEND);
  for (let z = 0; z < field.depth; z += 1) {
    for (let x = 0; x < field.width; x += 1) {
      out.classes[z * field.width + x] = terrainClassOf(
        heightAt(field, x, z),
        moistureAt(field, x, z),
        bands,
        forestMoisture,
      );
    }
  }
  return out;
}

/** Whether a terrain class is under water — the extruder floods those columns. */
export function isWaterClass(value: number): boolean {
  return value <= TERRAIN_CLASS.shallowWater;
}

/**
 * The colour of the block at depth `below` under a column's surface: the surface
 * class's own colour on top, then soil, then stone, then bedrock at the base.
 * Depth thresholds scale with the column so shallow and tall columns keep their
 * proportions.
 */
export function strataColorAt(surfaceClass: number, below: number, columnHeight: number): Rgb {
  if (below === 0) return TERRAIN_LEGEND[surfaceClass]?.color ?? SUBSURFACE_COLORS.stone;
  if (below <= soilDepthOf(columnHeight)) return SUBSURFACE_COLORS.soil;
  if (below <= stoneDepthOf(columnHeight)) return SUBSURFACE_COLORS.stone;
  return SUBSURFACE_COLORS.bedrock;
}

/** Where soil gives way to stone in a column of this height. */
function soilDepthOf(columnHeight: number): number {
  return Math.max(1, Math.round(columnHeight * 0.15));
}

/** Where stone gives way to bedrock. */
function stoneDepthOf(columnHeight: number): number {
  return Math.max(soilDepthOf(columnHeight) + 1, Math.round(columnHeight * 0.85));
}

/** The surface each terrain class presents, for callers that texture it. */
const CLASS_SURFACES: readonly SurfaceId[] = [
  "water", // deep water
  "water", // shallow water
  "sand",
  "grass",
  "forest",
  "rock",
  "snow",
];

/** The surface of a terrain class, for {@link MaterialResolver} lookups. */
export function terrainSurfaceOf(surfaceClass: number): SurfaceId {
  return CLASS_SURFACES[surfaceClass] ?? "rock";
}

/**
 * The surface of the block at depth `below` under a column's surface — the
 * texturing counterpart of {@link strataColorAt}, sharing its depth thresholds
 * so a column's colours and its materials always change at the same place.
 */
export function strataSurfaceAt(surfaceClass: number, below: number, columnHeight: number): SurfaceId {
  if (below === 0) return terrainSurfaceOf(surfaceClass);
  if (below <= soilDepthOf(columnHeight)) return "dirt";
  return "rock"; // stone and bedrock share the rock face; their colours differ
}

/**
 * Whether a cell sits on the boundary between its class and a different one —
 * the cheap edge test the tile mapper uses to pick shoreline and cliff tiles.
 */
export function isClassEdge(field: ClassField, x: number, y: number): boolean {
  const here = classAt(field, x, y);
  return (
    (x > 0 && classAt(field, x - 1, y) !== here) ||
    (y > 0 && classAt(field, x, y - 1) !== here) ||
    (x + 1 < field.width && classAt(field, x + 1, y) !== here) ||
    (y + 1 < field.height && classAt(field, x, y + 1) !== here)
  );
}

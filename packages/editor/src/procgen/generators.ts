/**
 * The generator registry: every procedural generator described as *data* — a
 * label, a list of parameters with their ranges, and one `generate` function.
 *
 * Describing generators declaratively is what keeps the editor's Generate panel
 * generic. The panel renders a slider per {@link ParamSpec} and knows nothing
 * about terrain or mazes, so adding a generator here makes it appear in both the
 * Map and Voxel tabs with working controls and no UI change at all.
 *
 * The 3D generators write through {@link VoxelSink} — a structural subset of
 * `VoxelGrid` — so this module stays independent of the voxel model and the
 * renderer, and the tests can drive it with a plain recording double.
 *
 * Pure and DOM-free.
 */

import { classAt, type ClassField } from "./classField";
import { generateCaves2D, generateCaves3D, CAVE_LEGEND, CAVE_CLASS, type CaveParams } from "./caves";
import { generateDungeon, DUNGEON_LEGEND } from "./dungeon";
import { generateHeightField, heightAt, moistureAt } from "./heightField";
import { generateMaze, MAZE_LEGEND, MAZE_CLASS } from "./maze";
import {
  bandsForWaterLevel,
  classifyTerrain,
  isWaterClass,
  strataColorAt,
  terrainClassOf,
  TERRAIN_CLASS,
  TERRAIN_LEGEND,
} from "./terrain";
import type { ClassInfo } from "./classField";
import type { Rgb } from "../model/lighting";

/** The values a generator is run with: one number per {@link ParamSpec.key}. */
export type GeneratorValues = Readonly<Record<string, number>>;

/** How a parameter's value should be presented by the UI. */
export type ParamFormat = "integer" | "decimal" | "percent";

/** One tunable input of a generator, with everything a control needs to render. */
export interface ParamSpec {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly format: ParamFormat;
  /** One-line explanation, shown as the control's tooltip. */
  readonly hint: string;
}

/** The seed control every generator carries, so reruns are reproducible. */
const SEED_PARAM: ParamSpec = {
  key: "seed",
  label: "Seed",
  min: 1,
  max: 9999,
  step: 1,
  value: 1,
  format: "integer",
  hint: "The same seed and settings always regenerate the same result.",
};

/** Read a value, falling back to the spec's default when it is missing or unusable. */
export function paramValue(params: readonly ParamSpec[], values: GeneratorValues, key: string): number {
  const spec = params.find((param) => param.key === key);
  const raw = values[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return spec ? Math.min(spec.max, Math.max(spec.min, raw)) : raw;
  }
  return spec?.value ?? 0;
}

/** The defaults for a generator's parameters, as the editor's opening state. */
export function defaultValues(params: readonly ParamSpec[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const param of params) values[param.key] = param.value;
  return values;
}

/** Look a generator up by id, falling back to the first so the UI always has one. */
export function findGenerator<T extends { readonly id: string }>(list: readonly T[], id: string): T {
  return list.find((generator) => generator.id === id) ?? list[0]!;
}

// --- 2D generators (the Map tab) -------------------------------------------

/** A generator that produces a 2D {@link ClassField}. */
export interface FieldGenerator {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The classes this generator can emit — what the class-to-tile mapping lists. */
  readonly legend: readonly ClassInfo[];
  readonly params: readonly ParamSpec[];
  generate(width: number, height: number, values: GeneratorValues): ClassField;
}

const TERRAIN_PARAMS: readonly ParamSpec[] = [
  SEED_PARAM,
  { key: "hills", label: "Hills", min: 1, max: 16, step: 1, value: 4, format: "integer", hint: "How many hills span the map." },
  { key: "relief", label: "Relief", min: 0.1, max: 2, step: 0.05, value: 1, format: "decimal", hint: "Height spread between valleys and peaks." },
  { key: "water", label: "Water level", min: 0.05, max: 0.9, step: 0.01, value: 0.42, format: "percent", hint: "How much of the map is under water." },
  { key: "island", label: "Island edge", min: 0, max: 1, step: 0.05, value: 0.6, format: "percent", hint: "How steeply the land shelves off at the border." },
  { key: "moisture", label: "Forest", min: 0, max: 1, step: 0.05, value: 0.55, format: "percent", hint: "How readily vegetated ground becomes forest." },
];

/** Build the height field a terrain generator run is based on. */
function terrainHeightField(width: number, height: number, values: GeneratorValues) {
  return generateHeightField({
    width,
    depth: height,
    seed: paramValue(TERRAIN_PARAMS, values, "seed"),
    hills: paramValue(TERRAIN_PARAMS, values, "hills"),
    relief: paramValue(TERRAIN_PARAMS, values, "relief"),
    baseLevel: paramValue(TERRAIN_PARAMS, values, "water") + 0.08,
    edgeFalloff: paramValue(TERRAIN_PARAMS, values, "island"),
  });
}

const CAVE_PARAMS: readonly ParamSpec[] = [
  SEED_PARAM,
  { key: "density", label: "Rock", min: 0.3, max: 0.7, step: 0.01, value: 0.46, format: "percent", hint: "Share of solid rock in the initial fill." },
  { key: "steps", label: "Smoothing", min: 0, max: 8, step: 1, value: 4, format: "integer", hint: "Smoothing passes — more gives rounder caverns." },
  { key: "birth", label: "Growth", min: 3, max: 7, step: 1, value: 5, format: "integer", hint: "Crowding at which open space fills back in." },
  { key: "survival", label: "Erosion", min: 2, max: 7, step: 1, value: 4, format: "integer", hint: "Support a rock cell needs to survive a pass." },
];

/** Assemble cave parameters from the panel's values. */
function caveParams(values: GeneratorValues): CaveParams {
  return {
    seed: paramValue(CAVE_PARAMS, values, "seed"),
    density: paramValue(CAVE_PARAMS, values, "density"),
    steps: paramValue(CAVE_PARAMS, values, "steps"),
    birthLimit: paramValue(CAVE_PARAMS, values, "birth"),
    survivalLimit: paramValue(CAVE_PARAMS, values, "survival"),
  };
}

const DUNGEON_PARAMS: readonly ParamSpec[] = [
  SEED_PARAM,
  { key: "attempts", label: "Rooms", min: 4, max: 120, step: 1, value: 40, format: "integer", hint: "Room placements to attempt; overlaps are dropped." },
  { key: "minRoom", label: "Min size", min: 2, max: 20, step: 1, value: 4, format: "integer", hint: "Smallest room edge, in cells." },
  { key: "maxRoom", label: "Max size", min: 3, max: 40, step: 1, value: 10, format: "integer", hint: "Largest room edge, in cells." },
];

const MAZE_PARAMS: readonly ParamSpec[] = [
  SEED_PARAM,
  { key: "braid", label: "Loops", min: 0, max: 1, step: 0.05, value: 0.25, format: "percent", hint: "Share of dead ends opened into loops." },
];

export const MAP_GENERATORS: readonly FieldGenerator[] = [
  {
    id: "terrain",
    label: "Terrain",
    description: "Noise-driven landscape: water, beaches, grass and forest, rising to rock and snow.",
    legend: TERRAIN_LEGEND,
    params: TERRAIN_PARAMS,
    generate: (width, height, values) =>
      classifyTerrain(terrainHeightField(width, height, values), {
        bands: bandsForWaterLevel(paramValue(TERRAIN_PARAMS, values, "water")),
        forestMoisture: paramValue(TERRAIN_PARAMS, values, "moisture"),
      }),
  },
  {
    id: "caves",
    label: "Caves",
    description: "Cellular-automaton caverns carved out of solid rock, enclosed by a wall.",
    legend: CAVE_LEGEND,
    params: CAVE_PARAMS,
    generate: (width, height, values) => generateCaves2D(width, height, caveParams(values)),
  },
  {
    id: "dungeon",
    label: "Dungeon",
    description: "Rectangular rooms joined by corridors — always one connected level.",
    legend: DUNGEON_LEGEND,
    params: DUNGEON_PARAMS,
    generate: (width, height, values) =>
      generateDungeon(width, height, {
        seed: paramValue(DUNGEON_PARAMS, values, "seed"),
        roomAttempts: paramValue(DUNGEON_PARAMS, values, "attempts"),
        minRoomSize: paramValue(DUNGEON_PARAMS, values, "minRoom"),
        maxRoomSize: paramValue(DUNGEON_PARAMS, values, "maxRoom"),
      }).field,
  },
  {
    id: "maze",
    label: "Maze",
    description: "Perfect maze carved by randomized depth-first search, optionally braided into loops.",
    legend: MAZE_LEGEND,
    params: MAZE_PARAMS,
    generate: (width, height, values) =>
      generateMaze(width, height, {
        seed: paramValue(MAZE_PARAMS, values, "seed"),
        braid: paramValue(MAZE_PARAMS, values, "braid"),
      }),
  },
];

// --- 3D generators (the Voxel tab) -----------------------------------------

/**
 * What a 3D generator writes into: the structural subset of `VoxelGrid` it
 * needs. Depending on the shape rather than the class keeps the generators
 * independent of the voxel model and trivially testable.
 */
export interface VoxelSink {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  set(x: number, y: number, z: number, r: number, g: number, b: number, emissive?: number): void;
  clear(x: number, y: number, z: number): void;
}

/** The lattice a generator must place cells on. */
export interface LatticeOptions {
  /**
   * True for hexels: only sites whose coordinates sum to an even number are
   * valid, so a generator must skip the rest rather than place cells that would
   * overlap on the FCC lattice.
   */
  readonly evenParity: boolean;
}

/** A generator that fills a 3D volume. */
export interface VolumeGenerator {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly params: readonly ParamSpec[];
  generate(sink: VoxelSink, lattice: LatticeOptions, values: GeneratorValues): void;
}

/** Whether a site is valid on the target lattice. */
function isValidSite(lattice: LatticeOptions, x: number, y: number, z: number): boolean {
  return !lattice.evenParity || (((x + y + z) % 2) + 2) % 2 === 0;
}

/** Empty every cell, so a generator run replaces the sculpt rather than adding to it. */
function clearAll(sink: VoxelSink): void {
  for (let z = 0; z < sink.sizeZ; z += 1) {
    for (let y = 0; y < sink.sizeY; y += 1) {
      for (let x = 0; x < sink.sizeX; x += 1) sink.clear(x, y, z);
    }
  }
}

/** Place a cell only where the lattice allows it. */
function place(sink: VoxelSink, lattice: LatticeOptions, x: number, y: number, z: number, color: Rgb, emissive = 0): void {
  if (!isValidSite(lattice, x, y, z)) return;
  sink.set(x, y, z, color[0], color[1], color[2], emissive);
}

const VOXEL_TERRAIN_PARAMS: readonly ParamSpec[] = [
  SEED_PARAM,
  { key: "hills", label: "Hills", min: 1, max: 12, step: 1, value: 3, format: "integer", hint: "How many hills span the volume." },
  { key: "relief", label: "Relief", min: 0.1, max: 2, step: 0.05, value: 1, format: "decimal", hint: "Height spread between valleys and peaks." },
  { key: "water", label: "Water level", min: 0.05, max: 0.9, step: 0.01, value: 0.42, format: "percent", hint: "How much of the volume floods." },
  { key: "island", label: "Island edge", min: 0, max: 1, step: 0.05, value: 0.7, format: "percent", hint: "How steeply the land shelves off at the border." },
  { key: "moisture", label: "Forest", min: 0, max: 1, step: 0.05, value: 0.55, format: "percent", hint: "How readily vegetated ground becomes forest." },
];

const VOXEL_CAVE_PARAMS: readonly ParamSpec[] = CAVE_PARAMS;

const VOXEL_MAZE_PARAMS: readonly ParamSpec[] = [
  ...MAZE_PARAMS,
  { key: "wallHeight", label: "Wall height", min: 1, max: 32, step: 1, value: 4, format: "integer", hint: "How tall the maze walls stand, in cells." },
];

export const VOXEL_GENERATORS: readonly VolumeGenerator[] = [
  {
    id: "terrain",
    label: "Terrain",
    description: "An island of layered strata — soil over stone over bedrock — flooded to the water level.",
    params: VOXEL_TERRAIN_PARAMS,
    generate(sink, lattice, values) {
      clearAll(sink);
      const waterLevel = paramValue(VOXEL_TERRAIN_PARAMS, values, "water");
      const bands = bandsForWaterLevel(waterLevel);
      const forestMoisture = paramValue(VOXEL_TERRAIN_PARAMS, values, "moisture");
      const field = generateHeightField({
        width: sink.sizeX,
        depth: sink.sizeZ,
        seed: paramValue(VOXEL_TERRAIN_PARAMS, values, "seed"),
        hills: paramValue(VOXEL_TERRAIN_PARAMS, values, "hills"),
        relief: paramValue(VOXEL_TERRAIN_PARAMS, values, "relief"),
        baseLevel: waterLevel + 0.08,
        edgeFalloff: paramValue(VOXEL_TERRAIN_PARAMS, values, "island"),
      });

      const top = sink.sizeY - 1;
      const waterTop = Math.round(waterLevel * top);
      for (let z = 0; z < sink.sizeZ; z += 1) {
        for (let x = 0; x < sink.sizeX; x += 1) {
          const normalized = heightAt(field, x, z);
          const surfaceClass = terrainClassOf(normalized, moistureAt(field, x, z), bands, forestMoisture);
          const columnTop = Math.max(0, Math.min(top, Math.round(normalized * top)));
          for (let y = 0; y <= columnTop; y += 1) {
            place(sink, lattice, x, y, z, strataColorAt(surfaceClass, columnTop - y, columnTop + 1));
          }
          // Flood everything below the water level that the ground did not reach.
          if (isWaterClass(surfaceClass)) {
            const waterColor = TERRAIN_LEGEND[TERRAIN_CLASS.shallowWater]!.color;
            for (let y = columnTop + 1; y <= waterTop; y += 1) {
              place(sink, lattice, x, y, z, waterColor);
            }
          }
        }
      }
    },
  },
  {
    id: "caves",
    label: "Caves",
    description: "A block of rock hollowed out by a 3D cellular automaton — tunnels and chambers.",
    params: VOXEL_CAVE_PARAMS,
    generate(sink, lattice, values) {
      clearAll(sink);
      const volume = generateCaves3D(sink.sizeX, sink.sizeY, sink.sizeZ, caveParams(values));
      const rock = CAVE_LEGEND[CAVE_CLASS.rock]!.color;
      const floor = CAVE_LEGEND[CAVE_CLASS.floor]!.color;
      for (let z = 0; z < sink.sizeZ; z += 1) {
        for (let y = 0; y < sink.sizeY; y += 1) {
          for (let x = 0; x < sink.sizeX; x += 1) {
            if (volume.solid[(z * sink.sizeY + y) * sink.sizeX + x] !== 1) continue;
            // Rock that is exposed downward reads as a cavern floor, which gives
            // the sculpt a lit surface to stand on instead of uniform dark rock.
            const below = y > 0 && volume.solid[((z * sink.sizeY + (y - 1)) * sink.sizeX) + x] === 1;
            place(sink, lattice, x, y, z, below ? rock : floor);
          }
        }
      }
    },
  },
  {
    id: "maze",
    label: "Maze",
    description: "A maze extruded into standing walls, with a floor slab beneath it.",
    params: VOXEL_MAZE_PARAMS,
    generate(sink, lattice, values) {
      clearAll(sink);
      const field = generateMaze(sink.sizeX, sink.sizeZ, {
        seed: paramValue(VOXEL_MAZE_PARAMS, values, "seed"),
        braid: paramValue(VOXEL_MAZE_PARAMS, values, "braid"),
      });
      const wallHeight = Math.min(
        sink.sizeY - 1,
        Math.max(1, paramValue(VOXEL_MAZE_PARAMS, values, "wallHeight")),
      );
      const wallColor = MAZE_LEGEND[MAZE_CLASS.wall]!.color;
      const pathColor = MAZE_LEGEND[MAZE_CLASS.path]!.color;
      for (let z = 0; z < sink.sizeZ; z += 1) {
        for (let x = 0; x < sink.sizeX; x += 1) {
          place(sink, lattice, x, 0, z, pathColor); // floor slab under the whole maze
          if (classAt(field, x, z) !== MAZE_CLASS.wall) continue;
          for (let y = 1; y <= wallHeight; y += 1) place(sink, lattice, x, y, z, wallColor);
        }
      }
    },
  },
];

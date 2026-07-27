/**
 * Cellular-automaton caves, in two and three dimensions.
 *
 * A random fill is smoothed by repeatedly asking each cell how many of its
 * neighbours are solid: crowded cells solidify, lonely ones hollow out. A few
 * passes turn noise into rounded caverns joined by passages. The 2D form feeds
 * the Map tab, the 3D form carves a voxel volume; they share the parameters and
 * the smoothing rule so the two read as the same generator.
 *
 * Pure and DOM-free.
 */

import { createClassField, type ClassField, type ClassInfo } from "./classField";
import { hashCoords2, hashCoords3 } from "./noise";

/** Cave classes: solid rock, and the space carved out of it. */
export const CAVE_LEGEND: readonly ClassInfo[] = [
  { id: "rock", label: "Rock", color: [58, 54, 66] },
  { id: "floor", label: "Floor", color: [176, 164, 140] },
];

export const CAVE_CLASS = { rock: 0, floor: 1 } as const;

export interface CaveParams {
  readonly seed: number;
  /** Share of cells solid in the initial random fill, 0..1. */
  readonly density: number;
  /** How many smoothing passes to run. More passes means rounder, larger caverns. */
  readonly steps: number;
  /**
   * Solid-neighbour count at or above which an open cell fills in. Lower values
   * grow rock aggressively; higher values leave the caverns open.
   */
  readonly birthLimit: number;
  /** Solid-neighbour count below which a solid cell is eroded away. */
  readonly survivalLimit: number;
}

export const DEFAULT_CAVE_PARAMS: CaveParams = {
  seed: 1,
  density: 0.46,
  steps: 4,
  birthLimit: 5,
  survivalLimit: 4,
};

/** Whether a flat index in a `width`-wide grid is solid. */
type SolidAt = (x: number, y: number) => boolean;

/** Count the solid cells among a cell's eight neighbours, treating off-grid as solid. */
function solidNeighbors2D(solid: SolidAt, x: number, y: number, width: number, height: number): number {
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      // Off-grid counts as rock, so caverns close at the border rather than
      // opening onto nothing.
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || solid(nx, ny)) count += 1;
    }
  }
  return count;
}

/**
 * Carve a 2D cave system. The border is always left solid so the cavern is
 * enclosed — a map whose caves run off the edge reads as unfinished.
 */
export function generateCaves2D(width: number, height: number, params: CaveParams = DEFAULT_CAVE_PARAMS): ClassField {
  const field = createClassField(width, height, CAVE_LEGEND);
  let solid = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      solid[y * width + x] = border || hashCoords2(x, y, params.seed) < params.density ? 1 : 0;
    }
  }

  const read: SolidAt = (x, y) => solid[y * width + x] === 1;
  for (let step = 0; step < params.steps; step += 1) {
    const next = new Uint8Array(solid.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        if (border) {
          next[y * width + x] = 1;
          continue;
        }
        const neighbors = solidNeighbors2D(read, x, y, width, height);
        const wasSolid = solid[y * width + x] === 1;
        next[y * width + x] = wasSolid
          ? neighbors >= params.survivalLimit
            ? 1
            : 0
          : neighbors >= params.birthLimit
            ? 1
            : 0;
      }
    }
    solid = next;
  }

  for (let i = 0; i < solid.length; i += 1) {
    field.classes[i] = solid[i] === 1 ? CAVE_CLASS.rock : CAVE_CLASS.floor;
  }
  return field;
}

/** A generated 3D occupancy volume: 1 where solid, 0 where open. */
export interface CaveVolume {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** Solid flags, indexed `(z * sizeY + y) * sizeX + x` — the VoxelGrid layout. */
  readonly solid: Uint8Array;
}

/** Solid-neighbour count over the 26 surrounding cells, off-grid counting as solid. */
function solidNeighbors3D(
  solid: Uint8Array,
  x: number,
  y: number,
  z: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): number {
  let count = 0;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx < 0 || nx >= sizeX || ny < 0 || ny >= sizeY || nz < 0 || nz >= sizeZ) {
          count += 1;
          continue;
        }
        if (solid[(nz * sizeY + ny) * sizeX + nx] === 1) count += 1;
      }
    }
  }
  return count;
}

/**
 * The 26-neighbourhood analogue of {@link generateCaves2D}. Its limits are
 * scaled from the 2D ones by the neighbourhood sizes (26 vs 8), so the same
 * `birthLimit` slider means the same thing — "how crowded before rock forms" —
 * in both dimensions instead of needing its own hand-tuned range.
 */
export function generateCaves3D(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  params: CaveParams = DEFAULT_CAVE_PARAMS,
): CaveVolume {
  const cells = sizeX * sizeY * sizeZ;
  let solid = new Uint8Array(cells);
  const scale = 26 / 8;
  const birth = Math.round(params.birthLimit * scale);
  const survival = Math.round(params.survivalLimit * scale);

  for (let z = 0; z < sizeZ; z += 1) {
    for (let y = 0; y < sizeY; y += 1) {
      for (let x = 0; x < sizeX; x += 1) {
        solid[(z * sizeY + y) * sizeX + x] = hashCoords3(x, y, z, params.seed) < params.density ? 1 : 0;
      }
    }
  }

  for (let step = 0; step < params.steps; step += 1) {
    const next = new Uint8Array(cells);
    for (let z = 0; z < sizeZ; z += 1) {
      for (let y = 0; y < sizeY; y += 1) {
        for (let x = 0; x < sizeX; x += 1) {
          const i = (z * sizeY + y) * sizeX + x;
          const neighbors = solidNeighbors3D(solid, x, y, z, sizeX, sizeY, sizeZ);
          next[i] = solid[i] === 1 ? (neighbors >= survival ? 1 : 0) : neighbors >= birth ? 1 : 0;
        }
      }
    }
    solid = next;
  }

  return { sizeX, sizeY, sizeZ, solid };
}

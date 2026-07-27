/**
 * The starting sculpt a new voxel asset opens with.
 *
 * A brand-new model needs *something* on screen: an empty grid gives the camera
 * nothing to orbit and no face to click, so the first cube would be unplaceable.
 * This lays a small slab at the middle of the grid — the floor you build up from.
 *
 * Shared rather than private to the sculptor because the asset browser also mints
 * models: creating one from the list has to produce exactly what opening a fresh
 * sculpt produces, or the two paths drift.
 */

import {
  VoxelGrid,
  geometryFor,
  isValidSite,
  serializeVoxelGrid,
  type CellShape,
} from "@cartbox/editor";

/** Grid size a new sculpt starts at, in cells per side. */
export const DEFAULT_GRID = 16;

/** The seed slab's colour — a neutral grey that reads under any lighting. */
export const SEED_COLOR: readonly [number, number, number] = [176, 182, 198];

/**
 * A grid holding the starting slab: a 3×3 patch at the centre of the floor.
 *
 * Hexels get two layers because the FCC lattice only allows every other site on a
 * given row — one layer of a rhombic pack leaves visible gaps, and the second
 * fills the alternating sites into a surface you can actually build on.
 */
export function seededGrid(size: number, shape: CellShape = "cube"): VoxelGrid {
  const grid = new VoxelGrid(size, size, size);
  const mid = Math.floor(size / 2);
  const geometry = geometryFor(shape);
  const topLayer = shape === "hexel" ? 1 : 0;
  for (let y = 0; y <= topLayer; y += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = mid + dx;
        const z = mid + dz;
        if (!isValidSite(geometry, x, y, z)) continue;
        grid.set(x, y, z, SEED_COLOR[0], SEED_COLOR[1], SEED_COLOR[2], 0);
      }
    }
  }
  return grid;
}

/** The serialized payload a new sculpt asset is created with. */
export function seededGridPayload(shape: CellShape): string {
  return serializeVoxelGrid(seededGrid(DEFAULT_GRID, shape), shape);
}

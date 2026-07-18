/**
 * Pure voxel selection helpers for the Voxel editor's Magic Wand and Paint
 * Bucket tools: a colour-matching flood fill over a {@link VoxelGrid}.
 *
 * Both tools share one traversal — starting from a seed cell, walk the run of
 * connected, filled voxels whose colour matches the seed within a tolerance —
 * and differ only in what they do with the result: the wand adds the run to the
 * selection, the bucket recolours it. Keeping the traversal here (query-only,
 * returning flat grid indices) lets both tools reuse it and lets the unit tests
 * assert on the region directly, with no DOM or renderer involved.
 *
 * DOM-free and side-effect-free, like the rest of the model layer, so the same
 * code drives the editor UI and the tests.
 */

import { VoxelGrid } from "./VoxelGrid";

/** The six axis-aligned neighbour offsets — face connectivity, no diagonals. */
const NEIGHBORS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** The largest possible squared RGB distance, so tolerance can be a 0..1 fraction. */
const MAX_COLOR_DISTANCE_SQ = 3 * 255 * 255;

/** Squared Euclidean distance between two straight-RGB colours (0..{@link MAX_COLOR_DISTANCE_SQ}). */
function colorDistanceSq(
  ar: number,
  ag: number,
  ab: number,
  br: number,
  bg: number,
  bb: number,
): number {
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return dr * dr + dg * dg + db * db;
}

export interface FloodOptions {
  /**
   * Colour tolerance as a 0..1 fraction of the maximum RGB distance. `0` matches
   * only cells identical to the seed; `1` matches every connected filled cell
   * regardless of colour. Values outside the range are clamped.
   */
  readonly tolerance?: number;
  /**
   * The neighbour offsets that define connectivity. Defaults to the six cube
   * faces; pass a hexel's twelve face offsets to flood over the rhombic lattice,
   * so the Wand and Bucket follow whichever cells actually touch.
   */
  readonly neighbors?: readonly (readonly [number, number, number])[];
}

/**
 * Flood-select the connected run of filled voxels reachable from the seed cell
 * whose colour is within `tolerance` of the seed's, using 6-connected (face)
 * neighbours. Returns the flat grid indices of every cell in the run (including
 * the seed), in no particular order; an empty array if the seed cell is empty or
 * out of bounds.
 *
 * This is the shared region for the Magic Wand (which selects the run) and the
 * Paint Bucket (which recolours it), so the two tools stay consistent.
 */
export function floodRegion(
  grid: VoxelGrid,
  x: number,
  y: number,
  z: number,
  options: FloodOptions = {},
): number[] {
  const seed = grid.get(x, y, z);
  if (!seed) return [];

  const tolerance = Math.max(0, Math.min(1, options.tolerance ?? 0));
  const threshold = tolerance * MAX_COLOR_DISTANCE_SQ;
  const neighbors = options.neighbors ?? NEIGHBORS;

  // Visited flags over the whole grid keep the traversal O(cells) and avoid
  // revisiting a cell reached by two paths.
  const visited = new Uint8Array(grid.sizeX * grid.sizeY * grid.sizeZ);
  const region: number[] = [];
  const stack: [number, number, number][] = [[x, y, z]];
  visited[grid.index(x, y, z)] = 1;

  while (stack.length > 0) {
    const [cx, cy, cz] = stack.pop()!;
    region.push(grid.index(cx, cy, cz));
    for (const [dx, dy, dz] of neighbors) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (!grid.inBounds(nx, ny, nz)) continue;
      const ni = grid.index(nx, ny, nz);
      if (visited[ni]) continue;
      const cell = grid.get(nx, ny, nz);
      if (!cell) continue;
      if (colorDistanceSq(seed.r, seed.g, seed.b, cell.r, cell.g, cell.b) > threshold) continue;
      visited[ni] = 1;
      stack.push([nx, ny, nz]);
    }
  }
  return region;
}

/** Decode a flat grid-cell index back to its `(x, y, z)` coordinates. */
export function cellCoords(grid: VoxelGrid, index: number): [number, number, number] {
  const layer = grid.sizeX * grid.sizeY;
  const z = Math.floor(index / layer);
  const rest = index - z * layer;
  return [rest % grid.sizeX, Math.floor(rest / grid.sizeX), z];
}

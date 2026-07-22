/**
 * Deterministic generator for a full-3D hexel terrain volume — the natural,
 * close-packed ground of the explorable world.
 *
 * Hexels tile the face-centred-cubic lattice (integer sites whose coordinates sum
 * to an even number) with twelve-faceted rhombic cells, so their slopes read far
 * rounder than a cube grid's stair-steps — the reason terrain is authored from
 * them rather than voxels. Because it is a true *volume* and not a heightfield,
 * the same generator that raises hills can also hollow **caves and overhangs**:
 * a cell is solid when it lies under the surface AND a separate 3D density field
 * has not carved it away, so tunnels and ledges fall out of the same pass.
 *
 * Pure and dependency-free (no editor, no DOM), mirroring voxelWorldSpecs.ts, so
 * the generation is node-testable on its own and the thin {@link hexelTerrain.ts}
 * adapter is the only part that needs the voxel core.
 */

/** The surface material of a terrain cell, used to pick its texture tile. */
export type TerrainMaterial = "grass" | "dirt" | "rock" | "crystal";

/** A single solid hexel: an FCC lattice site with a colour and emissive glow. */
export interface TerrainCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Self-emissive strength 0..1 (glowing cave crystals stay lit in shadow). */
  readonly emissive: number;
  /** Which material this cell is, so the renderer can texture it. */
  readonly material: TerrainMaterial;
}

export interface TerrainVolume {
  /** Lattice extent along each axis (sites 0..size-1). */
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly cells: readonly TerrainCell[];
}

export interface TerrainParams {
  /** Footprint of the terrain in lattice sites. */
  readonly sizeX: number;
  readonly sizeZ: number;
  /** Total vertical room; the surface sits within it and caves carve below. */
  readonly sizeY: number;
  /** Mean surface height in sites. */
  readonly baseHeight: number;
  /** Peak-to-valley swing of the surface, in sites. */
  readonly amplitude: number;
  /** Horizontal size of one hill, in sites (larger = smoother, broader hills). */
  readonly hillScale: number;
  /** Horizontal size of one cave pocket, in sites. */
  readonly caveScale: number;
  /**
   * Density above which a sub-surface cell is hollowed into cave. 0 carves
   * nothing; ~0.62 opens a connected network without collapsing the ground.
   */
  readonly caveThreshold: number;
  /** Sites of solid crust kept below the surface before caves may carve. */
  readonly crust: number;
  /** Seed for the deterministic noise. */
  readonly seed: number;
}

export const DEFAULT_TERRAIN_PARAMS: TerrainParams = {
  sizeX: 40,
  sizeZ: 40,
  sizeY: 28,
  baseHeight: 12,
  amplitude: 7,
  hillScale: 14,
  caveScale: 7,
  caveThreshold: 0.62,
  crust: 2,
  seed: 1337,
};

/** Whether `(x, y, z)` is a valid FCC (even-parity) hexel site. */
function isEvenParity(x: number, y: number, z: number): boolean {
  return (((x + y + z) % 2) + 2) % 2 === 0;
}

/** A deterministic hash of three integers and a seed, returned in [0, 1). */
function hashToUnit(x: number, y: number, z: number, seed: number): number {
  // A cheap integer avalanche (xorshift-style mix); order-sensitive so the three
  // axes contribute distinctly, then folded to the unit interval.
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 362437;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Smoothstep weight for lattice interpolation. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in 2D: bilinear-interpolated lattice hashes, in [0, 1]. */
function valueNoise2D(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const c00 = hashToUnit(x0, 0, z0, seed);
  const c10 = hashToUnit(x0 + 1, 0, z0, seed);
  const c01 = hashToUnit(x0, 0, z0 + 1, seed);
  const c11 = hashToUnit(x0 + 1, 0, z0 + 1, seed);
  const top = c00 + (c10 - c00) * tx;
  const bottom = c01 + (c11 - c01) * tx;
  return top + (bottom - top) * tz;
}

/** Value noise in 3D: trilinear-interpolated lattice hashes, in [0, 1]. */
function valueNoise3D(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const tz = smooth(z - z0);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const corner = (dx: number, dy: number, dz: number): number =>
    hashToUnit(x0 + dx, y0 + dy, z0 + dz, seed);
  const y0Plane = lerp(
    lerp(corner(0, 0, 0), corner(1, 0, 0), tx),
    lerp(corner(0, 0, 1), corner(1, 0, 1), tx),
    tz,
  );
  const y1Plane = lerp(
    lerp(corner(0, 1, 0), corner(1, 1, 0), tx),
    lerp(corner(0, 1, 1), corner(1, 1, 1), tx),
    tz,
  );
  return lerp(y0Plane, y1Plane, ty);
}

/** Surface height at column (x, z), in sites, as an integer within the volume. */
function surfaceHeight(x: number, z: number, params: TerrainParams): number {
  const noise = valueNoise2D(x / params.hillScale, z / params.hillScale, params.seed);
  const height = params.baseHeight + (noise - 0.5) * 2 * params.amplitude;
  return Math.max(1, Math.min(params.sizeY - 1, Math.round(height)));
}

/** The colour and material of a solid cell by its depth below the local surface. */
function shadeByDepth(depthBelowSurface: number, glow: number): Omit<TerrainCell, "x" | "y" | "z"> {
  if (glow > 0) {
    // A cave crystal: cyan, self-lit so it reads in the dark.
    return { r: 90, g: 220, b: 235, emissive: glow, material: "crystal" };
  }
  // The top two potential layers are grass: on the FCC lattice a column's
  // surface site may be off-parity, so its highest *filled* cell can sit one
  // below the nominal surface — keeping both grass makes the exposed top read as
  // grass rather than patchy dirt.
  if (depthBelowSurface <= 1) {
    return { r: 74, g: 150, b: 68, emissive: 0, material: "grass" }; // grassy top
  }
  if (depthBelowSurface <= 4) {
    return { r: 120, g: 86, b: 54, emissive: 0, material: "dirt" }; // soil
  }
  return { r: 96, g: 96, b: 104, emissive: 0, material: "rock" }; // rock
}

/**
 * Generate the terrain volume. For every valid FCC site under its column's
 * surface, the cell is solid unless the 3D density field carves it into cave —
 * except within the `crust` just under the surface, which is always kept so the
 * ground never opens from above. Cave walls that border open air get a chance of
 * a glowing crystal, so tunnels are legible when the player is inside them.
 */
export function generateTerrain(params: TerrainParams = DEFAULT_TERRAIN_PARAMS): TerrainVolume {
  const cells: TerrainCell[] = [];

  const isSolid = (x: number, y: number, z: number): boolean => {
    if (x < 0 || x >= params.sizeX || z < 0 || z >= params.sizeZ || y < 0) return false;
    if (!isEvenParity(x, y, z)) return false;
    const height = surfaceHeight(x, z, params);
    if (y > height) return false;
    const depthBelowSurface = height - y;
    if (depthBelowSurface < params.crust) return true; // protected crust
    const density = valueNoise3D(
      x / params.caveScale,
      y / params.caveScale,
      z / params.caveScale,
      params.seed ^ 0x5f3759df,
    );
    return density <= params.caveThreshold; // above the threshold = hollow cave
  };

  for (let z = 0; z < params.sizeZ; z += 1) {
    for (let x = 0; x < params.sizeX; x += 1) {
      const height = surfaceHeight(x, z, params);
      for (let y = 0; y <= height; y += 1) {
        if (!isSolid(x, y, z)) continue;

        // A crystal spawns where solid rock faces open cave (an empty neighbour
        // below the crust), keyed to a stable hash so it is deterministic.
        const bordersCave =
          !isSolid(x, y + 1, z) && height - y >= params.crust;
        const glow =
          bordersCave && hashToUnit(x, y, z, params.seed + 7) > 0.9
            ? 0.85
            : 0;

        cells.push({ x, y, z, ...shadeByDepth(height - y, glow) });
      }
    }
  }

  return { sizeX: params.sizeX, sizeY: params.sizeY, sizeZ: params.sizeZ, cells };
}

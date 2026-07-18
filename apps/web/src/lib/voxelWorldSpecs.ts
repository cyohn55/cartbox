/**
 * Pure, deterministic generator for the onboarding backdrop's Minecraft-style
 * voxel world: a small floating island of blocky terrain — grass, dirt and stone
 * strata, sand beaches, water ponds, trees, and the odd glowing lantern.
 *
 * Kept free of the editor's voxel core (which pulls the WASM engine barrel) so it
 * loads under the node TS hook and the same generator drives both the app and the
 * offline render checks. Turning the generated cells into a renderable voxel
 * model lives in voxelWorld.ts.
 *
 * The generator is a pure function of its {@link WorldGenParams}: the same seed
 * always yields the same island, so the backdrop is stable across renders and the
 * unit tests can assert on real output.
 */

/** One occupied block: its grid coordinate, colour, and self-emissive strength. */
export interface WorldCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Self-emissive strength, 0..255 (glowing blocks keep their colour in shadow). */
  readonly emissive: number;
}

/** The generated world: the grid it fits in, and every occupied block. */
export interface WorldData {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly cells: readonly WorldCell[];
}

export interface WorldGenParams {
  /** Any 32-bit integer; the same seed reproduces the same island. */
  readonly seed: number;
  /** Island footprint on the X (east-west) axis, in blocks. */
  readonly width: number;
  /** Island footprint on the Z (north-south) axis, in blocks. */
  readonly depth: number;
  /** Grid height in blocks — the tallest a terrain column may reach. */
  readonly height: number;
  /** The flat ground height the chunk's interior sits around, in blocks. */
  readonly groundLevel: number;
  /** Water fills land below this height (in blocks) with ponds and shorelines. */
  readonly seaLevel: number;
  /** Peak terrain relief above the ground, in blocks. */
  readonly relief: number;
  /** How densely trees are scattered over suitable grass, 0..1. */
  readonly treeDensity: number;
}

/**
 * A balanced default island: wide enough to read as a landscape, with gentle
 * hills, a pond or two, and scattered trees. Tuned to render smoothly at the
 * backdrop's frame rate (see voxelWorldRenderer.ts).
 */
export const DEFAULT_WORLD_PARAMS: WorldGenParams = {
  seed: 20260717,
  width: 60,
  depth: 46,
  height: 32,
  groundLevel: 8,
  seaLevel: 8,
  relief: 15,
  treeDensity: 0.022,
};

/** Straight RGB triple, 0..255. */
type Rgb = readonly [number, number, number];

/**
 * The block palette, in the muted-but-vivid register of a bright Minecraft day.
 * Each block jitters slightly per-cell (see {@link jitteredColor}) so large faces
 * read as textured voxels rather than flat colour.
 */
const BLOCKS = {
  grass: [96, 172, 74] as Rgb,
  dirt: [122, 88, 58] as Rgb,
  stone: [128, 128, 134] as Rgb,
  bedrock: [74, 74, 82] as Rgb,
  sand: [222, 208, 150] as Rgb,
  snow: [238, 244, 250] as Rgb,
  water: [58, 122, 208] as Rgb,
  trunk: [110, 78, 46] as Rgb,
  leaves: [42, 112, 52] as Rgb,
  lantern: [255, 176, 74] as Rgb,
} as const;

/** How many blocks of dirt sit under the grass before stone begins. */
const TOPSOIL_DEPTH = 3;
/** Terrain tops at or above this height wear snow instead of grass. */
const SNOW_LINE_FROM_TOP = 3;
/** Faint glow on water so ponds keep their colour rather than going dark. */
const WATER_EMISSIVE = 40;

/**
 * A fast, seedable PRNG (mulberry32). Returns a function yielding floats in
 * [0, 1). Used only where a stream of values is wanted; positional randomness
 * uses {@link hash} so it is independent of iteration order.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stable hash of integer lattice coordinates to a float in [0, 1). Because it
 * depends only on position and the seed (not on any call order), terrain height,
 * per-block colour jitter and tree placement are each reproducible and can be
 * sampled independently.
 */
function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smoothstep easing so interpolated noise has no lattice-aligned creases. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise: smoothly interpolated lattice of {@link hash} values. */
function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const c00 = hash(x0, z0, seed);
  const c10 = hash(x0 + 1, z0, seed);
  const c01 = hash(x0, z0 + 1, seed);
  const c11 = hash(x0 + 1, z0 + 1, seed);
  const top = c00 + (c10 - c00) * tx;
  const bottom = c01 + (c11 - c01) * tx;
  return top + (bottom - top) * tz;
}

/**
 * Fractal (multi-octave) value noise in [0, 1]: successively finer, weaker
 * octaves add hills-with-bumps detail rather than a single smooth swell.
 */
function fractalNoise(x: number, z: number, seed: number): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    sum += valueNoise(x * frequency, z * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/**
 * An edge plateau: full weight (1) across the chunk's interior, ramping down only
 * over the outer fifth so the landmass fills the footprint as a solid chunk with
 * rounded, shelving edges — cliffs and the odd beach — rather than a tiny island
 * marooned in a square of sea.
 */
function edgePlateau(x: number, z: number, width: number, depth: number): number {
  const nx = Math.abs((x / (width - 1)) * 2 - 1);
  const nz = Math.abs((z / (depth - 1)) * 2 - 1);
  const edge = Math.max(nx, nz); // 0 at centre, 1 at the border
  const PLATEAU = 0.8; // interior stays full out to here
  if (edge <= PLATEAU) return 1;
  return smooth(Math.max(0, (1 - edge) / (1 - PLATEAU)));
}

/** The terrain surface height (top solid block) at a column, in blocks. */
function terrainHeightAt(x: number, z: number, params: WorldGenParams): number {
  const NOISE_SCALE = 0.085;
  const elevation = fractalNoise(x * NOISE_SCALE, z * NOISE_SCALE, params.seed);
  // Centre the noise so valleys can dip below the ground into ponds and hills
  // rise above it, then shelve the result down at the very edges.
  const relief = (elevation - 0.35) * params.relief * edgePlateau(x, z, params.width, params.depth);
  const top = Math.round(params.groundLevel + relief);
  return Math.min(params.height - 1, Math.max(1, top));
}

/** Nudge each channel of a base colour by a per-cell amount for voxel texture. */
function jitteredColor(base: Rgb, x: number, y: number, z: number, seed: number): Rgb {
  // A single hash drives the whole cell's jitter so its channels shift together
  // (a lighter or darker block), which reads as texture rather than colour noise.
  const delta = Math.round((hash(x * 7 + z, y * 13 + 1, seed) - 0.5) * 22);
  return [
    Math.min(255, Math.max(0, base[0] + delta)),
    Math.min(255, Math.max(0, base[1] + delta)),
    Math.min(255, Math.max(0, base[2] + delta)),
  ];
}

/** Choose the surface block for a column's top, given how high and wet it is. */
function surfaceBlock(top: number, seaLevel: number, height: number): Rgb {
  if (top <= seaLevel) return BLOCKS.sand; // beaches and pond floors
  if (top >= height - SNOW_LINE_FROM_TOP) return BLOCKS.snow; // snowy peaks
  return BLOCKS.grass;
}

/**
 * Generate the full island as a list of occupied blocks plus the grid it fits in.
 * Pure and deterministic: identical params yield an identical world.
 */
export function generateWorld(params: WorldGenParams = DEFAULT_WORLD_PARAMS): WorldData {
  const { width, depth, height, seaLevel, seed } = params;
  const cells: WorldCell[] = [];
  const push = (x: number, y: number, z: number, color: Rgb, emissive = 0): void => {
    cells.push({ x, y, z, r: color[0], g: color[1], b: color[2], emissive });
  };

  const heightMap = new Int32Array(width * depth);

  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const top = terrainHeightAt(x, z, params);
      heightMap[z * width + x] = top;

      for (let y = 0; y <= top; y += 1) {
        const color =
          y === 0
            ? BLOCKS.bedrock
            : y === top
              ? surfaceBlock(top, seaLevel, height)
              : y >= top - TOPSOIL_DEPTH
                ? BLOCKS.dirt
                : BLOCKS.stone;
        push(x, y, z, jitteredColor(color, x, y, z, seed));
      }

      // Fill any land below the water line with water, forming ponds and moats.
      for (let y = top + 1; y <= seaLevel; y += 1) {
        push(x, y, z, jitteredColor(BLOCKS.water, x, y, z, seed), WATER_EMISSIVE);
      }
    }
  }

  addTrees(cells, heightMap, params, push);
  return { sizeX: width, sizeY: height, sizeZ: depth, cells };
}

/**
 * Scatter trees over grass that has headroom and dry ground, deterministically
 * from position, and hang the occasional glowing lantern beside a trunk so the
 * night-side of the island still has warm points of light.
 */
function addTrees(
  cells: WorldCell[],
  heightMap: Int32Array,
  params: WorldGenParams,
  push: (x: number, y: number, z: number, color: Rgb, emissive?: number) => void,
): void {
  const { width, depth, height, seaLevel, seed, treeDensity } = params;
  const treeSeed = seed ^ 0x9e3779b9;
  // Keep trees off the very edge so their canopies stay on the island.
  const margin = 3;

  for (let z = margin; z < depth - margin; z += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const top = heightMap[z * width + x]!;
      const surface = surfaceBlock(top, seaLevel, height);
      if (surface !== BLOCKS.grass) continue; // only on grass, not sand/snow
      if (hash(x, z, treeSeed) > treeDensity) continue;

      const trunkHeight = 4 + Math.floor(hash(x, z, treeSeed + 7) * 3); // 4..6
      if (top + trunkHeight + 2 >= height) continue; // no headroom for the canopy

      buildTree(x, top, z, trunkHeight, treeSeed, push);
    }
  }
}

/** Place one tree: a trunk, a rounded leaf canopy, and a chance of a lantern. */
function buildTree(
  x: number,
  groundTop: number,
  z: number,
  trunkHeight: number,
  treeSeed: number,
  push: (x: number, y: number, z: number, color: Rgb, emissive?: number) => void,
): void {
  const trunkTop = groundTop + trunkHeight;
  for (let y = groundTop + 1; y <= trunkTop; y += 1) {
    push(x, y, z, jitteredColor(BLOCKS.trunk, x, y, z, treeSeed));
  }

  // A blocky canopy: a fat lower ring tapering to a cap, corners trimmed so it
  // reads as a rounded crown rather than a cube.
  const canopy: ReadonlyArray<{ dy: number; radius: number }> = [
    { dy: -1, radius: 2 },
    { dy: 0, radius: 2 },
    { dy: 1, radius: 1 },
    { dy: 2, radius: 0 },
  ];
  for (const { dy, radius } of canopy) {
    const cy = trunkTop + dy;
    for (let lz = -radius; lz <= radius; lz += 1) {
      for (let lx = -radius; lx <= radius; lx += 1) {
        if (Math.abs(lx) === radius && Math.abs(lz) === radius) continue; // trim corners
        if (lx === 0 && lz === 0 && dy < 1) continue; // leave room for the trunk
        push(x + lx, cy, z + lz, jitteredColor(BLOCKS.leaves, x + lx, cy, z + lz, treeSeed));
      }
    }
  }

  // A lantern beside the trunk on some trees — warm emissive points of light.
  if (hash(x, z, treeSeed + 31) < 0.28) {
    push(x + 1, trunkTop, z, BLOCKS.lantern, 255);
  }
}

// --- Sky colours (kept here so they are pure and node-testable) ---

/** The two ends of the backdrop sky gradient, as `#rrggbb`. */
export interface SkyGradient {
  readonly top: string;
  readonly horizon: string;
}

/** A clear-day base sky, used when the chassis is too grey to tint toward. */
const DAY_SKY_HUE = 205;

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace(/^#/, ""), 16);
  if (Number.isNaN(value)) return [120, 170, 220];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to255 = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/** Interpolate between two hue angles along the shorter way around the wheel. */
function blendHue(from: number, to: number, amount: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  return (from + delta * amount + 360) % 360;
}

/**
 * A bright day-sky gradient nudged toward the selected chassis hue, so the world
 * behind a blue handheld reads a little bluer and a red one a little warmer while
 * still looking like open sky. A near-grey chassis keeps the plain clear-day blue.
 */
export function skyGradientFromChassis(hex: string): SkyGradient {
  const [chassisHue, chassisSat] = rgbToHsl(...hexToRgb(hex));
  const skyHue = blendHue(DAY_SKY_HUE, chassisHue, Math.min(0.45, chassisSat * 0.45));
  // A deep-but-bright day sky: rich enough at the zenith that light UI text over
  // it stays legible, softening to a hazy horizon behind the island.
  return {
    top: hslToHex(skyHue, 0.58, 0.6),
    horizon: hslToHex(skyHue, 0.42, 0.76),
  };
}

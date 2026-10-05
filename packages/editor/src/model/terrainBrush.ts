/**
 * Terrain tools (ENGINE_PARITY_ROADMAP.md EP10): make a terrain in the editor,
 * then shape it with brushes the way Unity's Terrain tools and Unreal's
 * Landscape mode do — raise, lower, smooth, flatten and noise the ground,
 * paint its material layers, and cut (or fill) holes.
 *
 * Every tool works in the terrain's own space (x and z from its grid's corner
 * at `origin`, heights above `origin[1]`) on a round brush with a soft edge,
 * and returns a new terrain; the old one is untouched, so each dab is an undo
 * step the editor can keep or drop. Pure and DOM-free.
 */

import type { MeshMaterial } from "./MeshAsset";
import { MAX_TERRAIN_SAMPLES, MIN_TERRAIN_SAMPLES, paintedWeights, terrainHeight, terrainLayerWeights, terrainHole, type Terrain } from "./terrain";

/** A dab of the brush: where (terrain space, x and z), how wide, and how hard (0..1). */
export interface TerrainBrush {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly strength: number;
}

export type SculptTool = "raise" | "lower" | "smooth" | "flatten" | "noise";

/** The brush's weight at distance `d` from its centre: 1 at the centre, easing to 0 at the rim. */
export function brushFalloff(d: number, radius: number): number {
  if (!(radius > 0) || d >= radius) return 0;
  const q = 1 - (d / radius) ** 2;
  return q * q;
}

/** The grid samples a brush reaches: the index window and each sample's terrain-space position. */
function reach(t: Terrain, brush: TerrainBrush): { i0: number; i1: number; j0: number; j1: number; dx: number; dz: number } {
  const n = t.samples;
  const dx = t.size[0] / (n - 1);
  const dz = t.size[1] / (n - 1);
  return {
    i0: Math.max(0, Math.floor((brush.x - brush.radius) / dx)),
    i1: Math.min(n - 1, Math.ceil((brush.x + brush.radius) / dx)),
    j0: Math.max(0, Math.floor((brush.z - brush.radius) / dz)),
    j1: Math.min(n - 1, Math.ceil((brush.z + brush.radius) / dz)),
    dx,
    dz,
  };
}

/** Value noise in −1..1, a couple of octaves, fixed by position (repeated dabs grow the same bumps). */
function bumps(x: number, z: number, scale: number): number {
  const cell = (i: number, j: number) => {
    let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) | 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967295;
  };
  const octave = (s: number) => {
    const gx = x / s, gz = z / s;
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const fx = gx - x0, fz = gz - z0;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const top = cell(x0, z0) + (cell(x0 + 1, z0) - cell(x0, z0)) * sx;
    const bottom = cell(x0, z0 + 1) + (cell(x0 + 1, z0 + 1) - cell(x0, z0 + 1)) * sx;
    return top + (bottom - top) * sz;
  };
  return (octave(scale) * 0.7 + octave(scale / 2.7) * 0.3) * 2 - 1;
}

/** How far one full-strength dab raises or lowers the centre: a fifth of the brush's radius. */
const LIFT = 0.2;

/**
 * Sculpt the ground under a brush dab:
 * - `raise` / `lower` lift or sink it, most at the centre;
 * - `smooth` eases each height toward its neighbours' average;
 * - `flatten` eases it toward `target` (a terrain-space height; the height under
 *   the brush's centre when absent — the editor samples it where a stroke starts);
 * - `noise` roughens it with bumps about a third of the brush across.
 */
export function sculptTerrain(t: Terrain, tool: SculptTool, brush: TerrainBrush, target?: number): Terrain {
  const n = t.samples;
  const { i0, i1, j0, j1, dx, dz } = reach(t, brush);
  if (i0 > i1 || j0 > j1) return t;
  const src = t.heights;
  const heights = Float32Array.from(src);
  const strength = Math.max(0, Math.min(1, brush.strength));
  const level = target ?? (terrainHeight({ ...t, origin: [0, 0, 0], holes: undefined }, brush.x, brush.z) ?? 0);
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const f = brushFalloff(Math.hypot(i * dx - brush.x, j * dz - brush.z), brush.radius) * strength;
      if (f <= 0) continue;
      const k = j * n + i;
      const h = src[k]!;
      switch (tool) {
        case "raise":
          heights[k] = h + f * brush.radius * LIFT;
          break;
        case "lower":
          heights[k] = h - f * brush.radius * LIFT;
          break;
        case "smooth": {
          let sum = 0, count = 0;
          for (let b = -1; b <= 1; b += 1) {
            for (let a = -1; a <= 1; a += 1) {
              const ii = i + a, jj = j + b;
              if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
              sum += src[jj * n + ii]!;
              count += 1;
            }
          }
          heights[k] = h + (sum / count - h) * f;
          break;
        }
        case "flatten":
          heights[k] = h + (level - h) * f;
          break;
        case "noise":
          heights[k] = h + bumps(i * dx, j * dz, Math.max(dx * 2, brush.radius / 3)) * f * brush.radius * LIFT * 0.5;
          break;
      }
    }
  }
  return { ...t, heights };
}

/** The splat map the layers' rules would give, so painting starts from what the terrain already shows. */
export function bakeTerrainPaint(t: Terrain): Uint8Array {
  const n = t.samples;
  const L = t.layers.length;
  const dx = t.size[0] / (n - 1);
  const dz = t.size[1] / (n - 1);
  const h = (i: number, j: number) => t.heights[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))]!;
  const out = new Uint8Array(n * n * L);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const nx = -(h(i + 1, j) - h(i - 1, j)) / (2 * dx);
      const nz = -(h(i, j + 1) - h(i, j - 1)) / (2 * dz);
      out.set(toBytes(terrainLayerWeights(t, 1 / Math.hypot(nx, 1, nz), t.origin[1] + h(i, j))), (j * n + i) * L);
    }
  }
  return out;
}

/** Weights (summing to 1) as bytes summing to 255: the rounding shortfall goes to the largest remainders. */
function toBytes(weights: readonly number[]): number[] {
  const raw = weights.map((w) => Math.max(0, w) * 255);
  const out = raw.map(Math.floor);
  let short = 255 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, k) => [v - Math.floor(v), k] as const).sort((a, b) => b[0] - a[0]);
  for (let q = 0; short > 0 && q < order.length; q += 1, short -= 1) out[order[q]![1]] = out[order[q]![1]]! + 1;
  return out;
}

/**
 * Paint layer `layer` under a brush dab: each sample's share of that layer
 * rises toward all of it (the others giving way in proportion). The first dab
 * on an unpainted terrain bakes its rules into the splat map first.
 */
export function paintTerrain(t: Terrain, layer: number, brush: TerrainBrush): Terrain {
  const L = t.layers.length;
  if (layer < 0 || layer >= L) return t;
  const n = t.samples;
  const paint = t.paint && t.paint.length === n * n * L ? Uint8Array.from(t.paint) : bakeTerrainPaint(t);
  const { i0, i1, j0, j1, dx, dz } = reach(t, brush);
  const strength = Math.max(0, Math.min(1, brush.strength));
  const held = { ...t, paint };
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const f = brushFalloff(Math.hypot(i * dx - brush.x, j * dz - brush.z), brush.radius) * strength;
      if (f <= 0) continue;
      const w = paintedWeights(held, i, j) ?? Array.from({ length: L }, (_, k) => (k === L - 1 ? 1 : 0));
      const target = w[layer]! + (1 - w[layer]!) * f;
      const rest = 1 - w[layer]!;
      const next = w.map((v, k) => (k === layer ? target : rest > 1e-6 ? (v / rest) * (1 - target) : 0));
      paint.set(toBytes(next), (j * n + i) * L);
    }
  }
  return { ...t, paint };
}

/** Cut the cells under a brush out of the ground (or, with `fill`, put them back). */
export function cutTerrainHoles(t: Terrain, brush: TerrainBrush, fill = false): Terrain {
  const n = t.samples;
  const cells = n - 1;
  const holes = t.holes && t.holes.length === cells * cells ? Uint8Array.from(t.holes) : new Uint8Array(cells * cells);
  const dx = t.size[0] / cells;
  const dz = t.size[1] / cells;
  let changed = false;
  for (let j = 0; j < cells; j += 1) {
    const cz = (j + 0.5) * dz;
    if (Math.abs(cz - brush.z) > brush.radius) continue;
    for (let i = 0; i < cells; i += 1) {
      const cx = (i + 0.5) * dx;
      if (Math.hypot(cx - brush.x, cz - brush.z) > brush.radius) continue;
      const v = fill ? 0 : 1;
      if (holes[j * cells + i] !== v) {
        holes[j * cells + i] = v;
        changed = true;
      }
    }
  }
  if (!changed) return t;
  if (!holes.some((v) => v !== 0)) {
    const { holes: _gone, ...rest } = t;
    void _gone;
    return rest;
  }
  return { ...t, holes };
}

/**
 * Where a ray (terrain space) first meets the ground: [x, y, z], or null. It
 * marches the ray across the grid a half cell at a time, then narrows down the
 * crossing; holes let it through.
 */
export function raycastTerrain(t: Terrain, origin: readonly [number, number, number], dir: readonly [number, number, number]): [number, number, number] | null {
  const local: Terrain = { ...t, origin: [0, 0, 0] };
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const d = [dir[0] / len, dir[1] / len, dir[2] / len] as const;
  // Clip the ray to the grid's box (heights included).
  let lo = Infinity, hi = -Infinity;
  for (const v of t.heights) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const min = [0, lo - 1e-3, 0], max = [t.size[0], hi + 1e-3, t.size[1]];
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a += 1) {
    if (Math.abs(d[a]!) < 1e-12) {
      if (origin[a]! < min[a]! || origin[a]! > max[a]!) return null;
      continue;
    }
    let ta = (min[a]! - origin[a]!) / d[a]!, tb = (max[a]! - origin[a]!) / d[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  }
  if (!(t0 <= t1)) return null;
  const step = Math.min(t.size[0], t.size[1]) / (t.samples - 1) / 2;
  const above = (s: number): number | null => {
    const x = origin[0] + d[0] * s, y = origin[1] + d[1] * s, z = origin[2] + d[2] * s;
    const g = terrainHeight(local, x, z);
    return g === null ? null : y - g;
  };
  let prevS = t0;
  let prev = above(t0);
  for (let s = t0 + step; s <= t1 + step; s += step) {
    const at = Math.min(s, t1);
    const cur = above(at);
    if (cur !== null && cur <= 0 && prev !== null && prev > 0) {
      let a = prevS, b = at;
      for (let k = 0; k < 24; k += 1) {
        const m = (a + b) / 2;
        const v = above(m);
        if (v !== null && v > 0) a = m;
        else b = m;
      }
      return [origin[0] + d[0] * b, origin[1] + d[1] * b, origin[2] + d[2] * b];
    }
    prevS = at;
    prev = cur;
    if (at === t1) break;
  }
  return null;
}

const material = (name: string, rgb: readonly [number, number, number], roughness: number): MeshMaterial => ({
  name,
  baseColorFactor: [rgb[0], rgb[1], rgb[2], 1],
  baseColorImage: null,
  roughnessFactor: roughness,
  metallicFactor: 0,
});

/** The layers a new terrain starts with: rock on the steep faces, snow up high, grass elsewhere — and dirt for painting paths. */
export function defaultTerrainLayers(): Terrain["layers"] {
  return [
    { material: material("rock", [0.42, 0.4, 0.38], 0.9), up: [0, 0.78] },
    { material: material("snow", [0.9, 0.92, 0.95], 0.7), height: [14, 10000] },
    { material: material("dirt", [0.45, 0.33, 0.22], 0.95), paintOnly: true },
    { material: material("grass", [0.3, 0.45, 0.2], 0.95) },
  ];
}

/** A new flat terrain `size` across with `samples` heights a side, centred on the origin. */
export function newTerrain(id: string, options: { name?: string; size?: number; samples?: number } = {}): Terrain {
  const size = Math.max(4, options.size ?? 64);
  const samples = Math.max(MIN_TERRAIN_SAMPLES, Math.min(MAX_TERRAIN_SAMPLES, Math.round(options.samples ?? 65)));
  return {
    id,
    name: options.name ?? "Terrain",
    origin: [-size / 2, 0, -size / 2],
    size: [size, size],
    samples,
    heights: new Float32Array(samples * samples),
    layers: defaultTerrainLayers(),
    blend: { up: 0.08, height: 2, noise: 0.4 },
    tile: 4,
  };
}

/** Whether a terrain-space point is over a hole. */
export function terrainHoleAt(t: Terrain, x: number, z: number): boolean {
  const cells = t.samples - 1;
  const i = Math.floor((x / t.size[0]) * cells), j = Math.floor((z / t.size[1]) * cells);
  return i >= 0 && j >= 0 && i < cells && j < cells && terrainHole(t, i, j);
}

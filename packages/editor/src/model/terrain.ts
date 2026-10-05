/**
 * Terrain (ENGINE_ROADMAP.md, Phase 7): a heightfield landscape — mountains,
 * valleys, cliffs round a chasm — stored as a grid of heights instead of
 * triangles, so a landscape hundreds of units across costs a few kilobytes on
 * the sidecar rather than megabytes of mesh.
 *
 * The grid is `samples` × `samples` heights spread evenly over `size` (world X
 * and Z) from `origin`. It becomes geometry when the scene loads: two triangles
 * per cell, smooth normals from the heightfield, world-planar UVs. Each triangle
 * takes the first **layer** whose rule it meets — how flat it is (its normal's
 * up component) and how high it sits — so snow settles on the gentle slopes and
 * high ground while rock shows through on the steep faces, with no painting.
 * Cells whose corners all lie below `floor` are left out (a bottomless chasm,
 * or ground nobody will ever see).
 *
 * Pure and DOM-free: the editor authors it, the player builds and draws it, the
 * tests check both.
 */

import { bytesToBase64, base64ToBytes } from "./base64";
import { deserializeMaterial, serializeMaterial, type MeshAsset, type MeshMaterial, type MeshPrimitive, type SerializedMaterial } from "./MeshAsset";

/** Which triangles a layer covers: a range of flatness and a range of height. */
export interface TerrainLayer {
  readonly material: MeshMaterial;
  /** Up component of the triangle's normal, [min, max] (1 = flat, 0 = vertical). Absent = any. */
  readonly up?: readonly [number, number];
  /** World height of the triangle's centre, [min, max]. Absent = any. */
  readonly height?: readonly [number, number];
  /** Shown only where painted (EP10): the rules never pick it (paths, scorch marks). */
  readonly paintOnly?: boolean;
}

export interface Terrain {
  readonly id: string;
  readonly name: string;
  /** World position of the grid's first corner (heights are added to its Y). */
  readonly origin: readonly [number, number, number];
  /** World extent along X and Z. */
  readonly size: readonly [number, number];
  /** Heights per side of the grid. */
  readonly samples: number;
  /** `samples`² heights, row by row along Z, each row along X. */
  readonly heights: Float32Array;
  /** First match wins; the last layer takes whatever the others don't. */
  readonly layers: readonly TerrainLayer[];
  /** Cells entirely below this world height are left out. Absent = none are. */
  readonly floor?: number;
  /** World units one texture repeat spans. */
  readonly tile?: number;
  /**
   * A scene object (by id) the terrain rides on: its heights are in that
   * object's space, and hiding or moving the object carries the terrain too.
   */
  readonly parent?: string;
  /**
   * Blend neighbouring layers smoothly (HALO2_STYLE_ROADMAP.md H4) instead of
   * giving each triangle one: across `up` (of the normal's up component) and
   * `height` (world units) either side of a layer's bounds the two mix per
   * vertex, and `noise` (0..1) wanders the edge so it reads as drifts and
   * scoured ridges rather than a contour line. Absent = hard edges.
   */
  readonly blend?: { readonly up: number; readonly height: number; readonly noise?: number };
  /** Let the terrain cast into the play space's shadow map (its cliffs shade the deck at a low sun). */
  readonly castShadows?: boolean;
  /**
   * Painted layer weights (EP10), a splat map: one byte per layer per height
   * sample (sample-major, `samples² × layers.length`). Where present it
   * replaces the layers' rules, and neighbouring layers blend per vertex.
   */
  readonly paint?: Uint8Array;
  /** Holes cut in the ground (EP10): one byte per cell (`(samples − 1)²`, row by row along Z), non-zero = no ground. */
  readonly holes?: Uint8Array;
}

export const MIN_TERRAIN_SAMPLES = 2;
export const MAX_TERRAIN_SAMPLES = 257;
export const MAX_TERRAIN_LAYERS = 4;
/** Heights are stored to this precision (world units). */
const HEIGHT_STEP = 0.05;
const DEFAULT_TILE = 8;

/** Whether cell (i, j) is cut out of the ground. */
export function terrainHole(t: Terrain, i: number, j: number): boolean {
  return Boolean(t.holes && t.holes[j * (t.samples - 1) + i]);
}

/** The terrain's world height at (x, z), bilinear between samples; null off the grid or over a hole. */
export function terrainHeight(t: Terrain, x: number, z: number): number | null {
  const n = t.samples;
  const gx = ((x - t.origin[0]) / t.size[0]) * (n - 1);
  const gz = ((z - t.origin[2]) / t.size[1]) * (n - 1);
  if (!(gx >= 0 && gz >= 0 && gx <= n - 1 && gz <= n - 1)) return null;
  const x0 = Math.min(n - 2, Math.floor(gx));
  const z0 = Math.min(n - 2, Math.floor(gz));
  if (terrainHole(t, x0, z0)) return null;
  const fx = gx - x0;
  const fz = gz - z0;
  const h = (i: number, j: number) => t.heights[j * n + i]!;
  const top = h(x0, z0) * (1 - fx) + h(x0 + 1, z0) * fx;
  const bottom = h(x0, z0 + 1) * (1 - fx) + h(x0 + 1, z0 + 1) * fx;
  return t.origin[1] + top * (1 - fz) + bottom * fz;
}

/** 0 → 1 across [edge − w/2, edge + w/2] (a hard step when w is 0). */
function ramp(v: number, edge: number, w: number): number {
  if (w <= 0) return v >= edge ? 1 : 0;
  const t = Math.max(0, Math.min(1, (v - edge + w / 2) / w));
  return t * t * (3 - 2 * t);
}

/**
 * How much a value lies within [lo, hi], softened by w either side (absent
 * range = fully). A bound at or past the value's natural limit (`limits`: an
 * up component can't pass 0 or 1) is a hard edge nothing crosses, so it isn't
 * softened — perfectly flat ground stays fully in a layer that reaches 1.
 */
function within(v: number, range: readonly [number, number] | undefined, w: number, limits: readonly [number, number] = [-Infinity, Infinity]): number {
  if (!range) return 1;
  const low = range[0] <= limits[0] ? 1 : ramp(v, range[0], w);
  const high = range[1] >= limits[1] ? 1 : 1 - ramp(v, range[1], w);
  return low * high;
}

/**
 * Each layer's weight at a point, first match winning softly: a layer takes
 * its membership of what the layers before it left, the last takes the rest.
 */
export function terrainLayerWeights(t: Terrain, up: number, height: number, jitter = 0): number[] {
  const b = t.blend;
  const wu = b ? Math.max(0, b.up) : 0;
  const wh = b ? Math.max(0, b.height) : 0;
  const u = up + jitter * wu;
  const h = height + jitter * wh;
  const out: number[] = [];
  let rest = 1;
  t.layers.forEach((l, i) => {
    if (i === t.layers.length - 1) {
      out.push(rest);
      return;
    }
    const w = l.paintOnly ? 0 : rest * within(u, l.up, wu, [0, 1]) * within(h, l.height, wh);
    out.push(w);
    rest -= w;
  });
  return out;
}

/** Smooth, tileable-enough value noise in −1..1 over world XZ (a few units per feature), for the blend edge. */
function edgeNoise(x: number, z: number): number {
  const cell = (i: number, j: number) => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const octave = (scale: number) => {
    const gx = x / scale;
    const gz = z / scale;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const top = cell(x0, z0) + (cell(x0 + 1, z0) - cell(x0, z0)) * sx;
    const bottom = cell(x0, z0 + 1) + (cell(x0 + 1, z0 + 1) - cell(x0, z0 + 1)) * sx;
    return top + (bottom - top) * sz;
  };
  return (octave(9) * 0.65 + octave(3.5) * 0.35) * 2 - 1;
}

/** A sample's painted layer weights (normalised), or null where nothing is painted (all zero). */
export function paintedWeights(t: Terrain, i: number, j: number): number[] | null {
  if (!t.paint) return null;
  const L = t.layers.length;
  const o = (j * t.samples + i) * L;
  let sum = 0;
  for (let k = 0; k < L; k += 1) sum += t.paint[o + k]!;
  if (sum === 0) return null;
  return Array.from({ length: L }, (_, k) => t.paint![o + k]! / sum);
}

function layerFor(layers: readonly TerrainLayer[], up: number, height: number): number {
  for (let i = 0; i < layers.length - 1; i += 1) {
    const l = layers[i]!;
    if (l.paintOnly) continue;
    if (l.up && (up < l.up[0] || up > l.up[1])) continue;
    if (l.height && (height < l.height[0] || height > l.height[1])) continue;
    return i;
  }
  return layers.length - 1;
}

/**
 * Build the terrain's geometry: one primitive per layer that any triangle uses.
 * `stride` samples every stride-th height (1 = full detail; 2, 4… for distance)
 * and `cells` limits it to a block of the grid, [x0, z0, x1, z1) in cells.
 * `skirt` hangs a strip that far down from the block's edges, so where a
 * neighbouring block is drawn at another detail the seam between them shows
 * ground, not a crack through to the sky.
 */
export function terrainMesh(t: Terrain, stride = 1, cells?: readonly [number, number, number, number], skirt = 0): MeshAsset {
  const n = t.samples;
  const s = Math.max(1, Math.floor(stride));
  const [cx0, cz0, cx1, cz1] = cells ?? [0, 0, n - 1, n - 1];
  const dx = t.size[0] / (n - 1);
  const dz = t.size[1] / (n - 1);
  const tile = t.tile && t.tile > 0 ? t.tile : DEFAULT_TILE;
  const h = (i: number, j: number) => t.heights[Math.min(n - 1, j) * n + Math.min(n - 1, i)]!;
  // One bucket per layer, plus one per pair of layers blended across their edge
  // (made as triangles need them): its vertices carry the second layer's weight.
  interface Bucket {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    map: Map<number, number>;
    material: MeshMaterial;
    blend?: number[];
    pair?: readonly [number, number];
  }
  const bucket = (material: MeshMaterial, pair?: readonly [number, number]): Bucket => ({
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    map: new Map(),
    material,
    ...(pair ? { blend: [], pair } : {}),
  });
  const out: Bucket[] = t.layers.map((l) => bucket(l.material));
  const pairs = new Map<string, number>();
  const pairBucket = (a: number, b: number): number => {
    const key = `${a},${b}`;
    let index = pairs.get(key);
    if (index === undefined) {
      const A = t.layers[a]!.material;
      const B = t.layers[b]!.material;
      index = out.length;
      out.push(
        bucket(
          {
            ...A,
            name: `${A.name}+${B.name}`,
            blendImage: B.baseColorImage ?? null,
            blendColor: [B.baseColorFactor[0], B.baseColorFactor[1], B.baseColorFactor[2]],
            blendRoughness: B.roughnessFactor ?? 1,
          },
          [a, b],
        ),
      );
      pairs.set(key, index);
    }
    return index;
  };
  // Per-vertex layer weights (blend mode only), cached by grid index.
  const weightCache = new Map<number, number[]>();
  const vertexNormalY = (i: number, j: number): number => {
    const l = h(Math.max(0, i - s), j);
    const r = h(Math.min(n - 1, i + s), j);
    const d = h(i, Math.max(0, j - s));
    const u = h(i, Math.min(n - 1, j + s));
    const nx = -(r - l) / ((Math.min(n - 1, i + s) - Math.max(0, i - s)) * dx);
    const nz = -(u - d) / ((Math.min(n - 1, j + s) - Math.max(0, j - s)) * dz);
    return 1 / Math.hypot(nx, 1, nz);
  };
  const weightsAt = (i: number, j: number): number[] => {
    const key = j * n + i;
    let w = weightCache.get(key);
    if (!w && t.paint) w = paintedWeights(t, i, j) ?? undefined;
    if (w) weightCache.set(key, w);
    if (!w) {
      const x = t.origin[0] + i * dx;
      const z = t.origin[2] + j * dz;
      w = terrainLayerWeights(t, vertexNormalY(i, j), t.origin[1] + h(i, j), (t.blend?.noise ?? 0) * edgeNoise(x, z));
      weightCache.set(key, w);
    }
    return w;
  };
  const vertex = (layer: number, i: number, j: number): number => {
    const o = out[layer]!;
    const key = j * n + i;
    const known = o.map.get(key);
    if (known !== undefined) return known;
    const x = t.origin[0] + i * dx;
    const z = t.origin[2] + j * dz;
    const y = t.origin[1] + h(i, j);
    // Smooth normal from the heightfield's slope at this detail.
    const l = h(Math.max(0, i - s), j);
    const r = h(Math.min(n - 1, i + s), j);
    const d = h(i, Math.max(0, j - s));
    const u = h(i, Math.min(n - 1, j + s));
    const spanX = (Math.min(n - 1, i + s) - Math.max(0, i - s)) * dx;
    const spanZ = (Math.min(n - 1, j + s) - Math.max(0, j - s)) * dz;
    const nx = -(r - l) / spanX;
    const nz = -(u - d) / spanZ;
    const len = Math.hypot(nx, 1, nz);
    const index = o.positions.length / 3;
    o.positions.push(x, y, z);
    o.normals.push(nx / len, 1 / len, nz / len);
    o.uvs.push(x / tile, z / tile);
    if (o.blend && o.pair) {
      const w = weightsAt(i, j);
      const wa = w[o.pair[0]]!;
      const wb = w[o.pair[1]]!;
      o.blend.push(wa + wb > 1e-6 ? wb / (wa + wb) : 0);
    }
    o.map.set(key, index);
    return index;
  };
  const floor = t.floor ?? -Infinity;
  // A coarse cell that covers any hole is left out, so a hole stays open at every detail.
  const holeWithin = (i0: number, j0: number, i1: number, j1: number): boolean => {
    for (let j = j0; j < j1; j += 1) for (let i = i0; i < i1; i += 1) if (terrainHole(t, i, j)) return true;
    return false;
  };
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    const pa = [a[0] * dx, h(a[0], a[1]), a[1] * dz];
    const pb = [b[0] * dx, h(b[0], b[1]), b[1] * dz];
    const pc = [c[0] * dx, h(c[0], c[1]), c[1] * dz];
    // Face normal (counter-clockwise seen from above is up).
    const ux = pb[0]! - pa[0]!, uy = pb[1]! - pa[1]!, uz = pb[2]! - pa[2]!;
    const vx = pc[0]! - pa[0]!, vy = pc[1]! - pa[1]!, vz = pc[2]! - pa[2]!;
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
    const layer = t.blend || t.paint ? blendBucket(a, b, c) : layerFor(t.layers, ny / len, t.origin[1] + (pa[1]! + pb[1]! + pc[1]!) / 3);
    out[layer]!.indices.push(vertex(layer, a[0], a[1]), vertex(layer, b[0], b[1]), vertex(layer, c[0], c[1]));
    if (skirt > 0) {
      for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]] as const) if (onEdge(p, q)) hang(layer, p, q, r);
    }
  };
  // Blend mode: the triangle goes to its dominant layer, or — where a second
  // layer shows at any corner — to that pair's blended bucket.
  const blendBucket = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number => {
    const ws = [weightsAt(a[0], a[1]), weightsAt(b[0], b[1]), weightsAt(c[0], c[1])];
    const sum = t.layers.map((_, k) => ws[0]![k]! + ws[1]![k]! + ws[2]![k]!);
    let first = 0;
    for (let k = 1; k < sum.length; k += 1) if (sum[k]! > sum[first]!) first = k;
    let second = -1;
    for (let k = 0; k < sum.length; k += 1) if (k !== first && (second < 0 || sum[k]! > sum[second]!)) second = k;
    if (second < 0 || Math.max(ws[0]![second]!, ws[1]![second]!, ws[2]![second]!) < 0.02) return first;
    return pairBucket(first, second);
  };
  // An edge of the block: both ends on the same side of it.
  const onEdge = (p: readonly [number, number], q: readonly [number, number]) =>
    (p[0] === q[0] && (p[0] === cx0 || p[0] === cx1)) || (p[1] === q[1] && (p[1] === cz0 || p[1] === cz1));
  /** A skirt below edge p–q, facing away from r (the triangle's far corner). */
  const hang = (layer: number, p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => {
    const o = out[layer]!;
    const top = [vertex(layer, p[0], p[1]), vertex(layer, q[0], q[1])];
    const base = o.positions.length / 3;
    for (const v of top) {
      o.positions.push(o.positions[v * 3]!, o.positions[v * 3 + 1]! - skirt, o.positions[v * 3 + 2]!);
      o.normals.push(o.normals[v * 3]!, o.normals[v * 3 + 1]!, o.normals[v * 3 + 2]!);
      o.uvs.push(o.uvs[v * 2]!, o.uvs[v * 2 + 1]! + skirt / tile);
      if (o.blend) o.blend.push(o.blend[v]!);
    }
    // Wind it to face outward: away from the triangle's far corner.
    const ex = (q[0] - p[0]) * dx, ez = (q[1] - p[1]) * dz;
    const outX = ((p[0] + q[0]) / 2 - r[0]) * dx, outZ = ((p[1] + q[1]) / 2 - r[1]) * dz;
    // Normal of (p, q, q-down) is along (−ez, 0, ex) · −1 for a downward second edge.
    const facing = ez * outX - ex * outZ;
    if (facing >= 0) o.indices.push(top[0]!, top[1]!, base + 1, top[0]!, base + 1, base);
    else o.indices.push(top[0]!, base + 1, top[1]!, top[0]!, base, base + 1);
  };
  for (let j = cz0; j < cz1; j += s) {
    for (let i = cx0; i < cx1; i += s) {
      const i1 = Math.min(cx1, i + s);
      const j1 = Math.min(cz1, j + s);
      const h00 = h(i, j), h10 = h(i1, j), h01 = h(i, j1), h11 = h(i1, j1);
      if (t.origin[1] + Math.max(h00, h10, h01, h11) < floor) continue;
      if (t.holes && holeWithin(i, j, i1, j1)) continue;
      // Split along the diagonal whose ends are closer in height, so ridges and
      // gullies follow the terrain rather than a fixed grain.
      if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
        tri([i, j], [i, j1], [i1, j1]);
        tri([i, j], [i1, j1], [i1, j]);
      } else {
        tri([i, j], [i, j1], [i1, j]);
        tri([i1, j], [i, j1], [i1, j1]);
      }
    }
  }
  const primitives: MeshPrimitive[] = [];
  for (const o of out) {
    if (o.indices.length === 0) continue;
    primitives.push({
      positions: new Float32Array(o.positions),
      normals: new Float32Array(o.normals),
      uvs: new Float32Array(o.uvs),
      indices: new Uint32Array(o.indices),
      material: o.material,
      ...(o.blend ? { blend: new Float32Array(o.blend) } : {}),
    });
  }
  return { name: t.name, primitives };
}

/** Cells per side of the blocks a terrain is drawn in (see {@link terrainChunks}). */
export const TERRAIN_CHUNK = 16;

/** One block of a terrain: its full-detail mesh and coarser ones for distance. */
export interface TerrainChunk {
  /** The block's cells, [x0, z0, x1, z1). */
  readonly cells: readonly [number, number, number, number];
  readonly mesh: MeshAsset;
  /** Half and quarter detail, in that order. */
  readonly lods: readonly MeshAsset[];
  /** How far from the block full detail holds (world units); half detail to twice that, quarter beyond. */
  readonly detail: number;
}

/**
 * The terrain cut into square blocks of `chunk` cells, each with coarser
 * versions for distance and skirts to hide the seams between detail levels —
 * so the ground near the camera is drawn in full and the far range in a
 * fraction of the triangles. Blocks with nothing to draw (all hole) are left out.
 */
export function terrainChunks(t: Terrain, chunk = TERRAIN_CHUNK): TerrainChunk[] {
  const cellsPerSide = t.samples - 1;
  const cell = Math.max(t.size[0], t.size[1]) / cellsPerSide;
  const skirt = cell * 4;
  const out: TerrainChunk[] = [];
  for (let z0 = 0; z0 < cellsPerSide; z0 += chunk) {
    for (let x0 = 0; x0 < cellsPerSide; x0 += chunk) {
      const cells = [x0, z0, Math.min(cellsPerSide, x0 + chunk), Math.min(cellsPerSide, z0 + chunk)] as const;
      const mesh = terrainMesh(t, 1, cells, skirt);
      if (mesh.primitives.length === 0) continue;
      const span = Math.min(cells[2] - x0, cells[3] - z0);
      const lods = [2, 4].filter((s) => span >= s * 2).map((s) => terrainMesh(t, s, cells, skirt));
      out.push({ cells, mesh, lods, detail: chunk * cell * 1.2 });
    }
  }
  return out;
}

/** The terrain as stored on the mesh sidecar. */
export interface SerializedTerrain {
  id: string;
  name: string;
  origin: [number, number, number];
  size: [number, number];
  samples: number;
  /** Heights as little-endian Int16 multiples of 0.05, base64. */
  heights: string;
  layers: { material: SerializedMaterial; up?: [number, number]; height?: [number, number]; paintOnly?: boolean }[];
  floor?: number;
  tile?: number;
  parent?: string;
  blend?: { up: number; height: number; noise?: number };
  castShadows?: boolean;
  /** The splat map's bytes, base64 (see {@link Terrain.paint}). */
  paint?: string;
  /** Holes as bits, one per cell (least significant first), base64. */
  holes?: string;
}

export function serializeTerrain(t: Terrain): SerializedTerrain {
  const q = new Int16Array(t.heights.length);
  for (let i = 0; i < q.length; i += 1) q[i] = Math.max(-32768, Math.min(32767, Math.round(t.heights[i]! / HEIGHT_STEP)));
  return {
    id: t.id,
    name: t.name,
    origin: [...t.origin],
    size: [...t.size],
    samples: t.samples,
    heights: bytesToBase64(new Uint8Array(q.buffer)),
    layers: t.layers.map((l) => ({ material: serializeMaterial(l.material), ...(l.up ? { up: [...l.up] } : {}), ...(l.height ? { height: [...l.height] } : {}), ...(l.paintOnly ? { paintOnly: true } : {}) })),
    ...(t.floor !== undefined ? { floor: t.floor } : {}),
    ...(t.tile !== undefined ? { tile: t.tile } : {}),
    ...(t.parent ? { parent: t.parent } : {}),
    ...(t.blend ? { blend: { up: t.blend.up, height: t.blend.height, ...(t.blend.noise !== undefined ? { noise: t.blend.noise } : {}) } } : {}),
    ...(t.castShadows ? { castShadows: true } : {}),
    ...(t.paint && t.paint.length === t.samples * t.samples * t.layers.length ? { paint: bytesToBase64(t.paint) } : {}),
    ...(t.holes && t.holes.some((v) => v !== 0) ? { holes: packBits(t.holes) } : {}),
  };
}

function packBits(cells: Uint8Array): string {
  const bits = new Uint8Array(Math.ceil(cells.length / 8));
  cells.forEach((v, i) => {
    if (v) bits[i >> 3]! |= 1 << (i & 7);
  });
  return bytesToBase64(bits);
}

function unpackBits(stored: string, count: number): Uint8Array | null {
  let bits: Uint8Array;
  try {
    bits = base64ToBytes(stored);
  } catch {
    return null;
  }
  if (bits.length !== Math.ceil(count / 8)) return null;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = (bits[i >> 3]! >> (i & 7)) & 1;
  return out;
}

function readPaint(value: unknown, length: number): { paint?: Uint8Array } {
  if (typeof value !== "string") return {};
  try {
    const bytes = base64ToBytes(value);
    return bytes.length === length ? { paint: bytes } : {};
  } catch {
    return {};
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pair = (v: unknown): [number, number] | undefined =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined;

/** Read one stored terrain defensively; null when it's malformed. */
export function readTerrain(value: unknown): Terrain | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<Record<keyof SerializedTerrain, unknown>>;
  const n = r.samples;
  if (!finite(n) || !Number.isInteger(n) || n < MIN_TERRAIN_SAMPLES || n > MAX_TERRAIN_SAMPLES) return null;
  if (!Array.isArray(r.origin) || r.origin.length !== 3 || !r.origin.every(finite)) return null;
  const size = pair(r.size);
  if (!size || size[0] <= 0 || size[1] <= 0) return null;
  if (typeof r.heights !== "string" || !Array.isArray(r.layers) || r.layers.length === 0) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(r.heights);
  } catch {
    return null;
  }
  if (bytes.length !== n * n * 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heights = new Float32Array(n * n);
  for (let i = 0; i < heights.length; i += 1) heights[i] = view.getInt16(i * 2, true) * HEIGHT_STEP;
  const layers: TerrainLayer[] = r.layers.slice(0, MAX_TERRAIN_LAYERS).map((raw) => {
    const l = (raw ?? {}) as { material?: unknown; up?: unknown; height?: unknown; paintOnly?: unknown };
    const up = pair(l.up);
    const height = pair(l.height);
    return { material: deserializeMaterial(l.material), ...(up ? { up } : {}), ...(height ? { height } : {}), ...(l.paintOnly === true ? { paintOnly: true } : {}) };
  });
  return {
    id: typeof r.id === "string" ? r.id : "terrain",
    name: typeof r.name === "string" ? r.name : "Terrain",
    origin: [r.origin[0] as number, r.origin[1] as number, r.origin[2] as number],
    size,
    samples: n,
    heights,
    layers,
    ...(finite(r.floor) ? { floor: r.floor } : {}),
    ...(finite(r.tile) && r.tile > 0 ? { tile: r.tile } : {}),
    ...(typeof r.parent === "string" && r.parent ? { parent: r.parent } : {}),
    ...readBlend(r.blend),
    ...(r.castShadows === true ? { castShadows: true } : {}),
    ...readPaint(r.paint, n * n * layers.length),
    ...(typeof r.holes === "string" && unpackBits(r.holes, (n - 1) * (n - 1)) ? { holes: unpackBits(r.holes, (n - 1) * (n - 1))! } : {}),
  };
}

function readBlend(value: unknown): { blend?: Terrain["blend"] } {
  if (!value || typeof value !== "object") return {};
  const b = value as Record<string, unknown>;
  if (!finite(b.up) || !finite(b.height)) return {};
  return {
    blend: {
      up: Math.max(0, Math.min(1, b.up)),
      height: Math.max(0, Math.min(100, b.height)),
      ...(finite(b.noise) ? { noise: Math.max(0, Math.min(1, b.noise)) } : {}),
    },
  };
}

/** Read a sidecar's terrain list, dropping malformed entries. */
export function readTerrains(value: unknown): Terrain[] {
  if (!Array.isArray(value)) return [];
  return value.map(readTerrain).filter((t): t is Terrain => t !== null);
}

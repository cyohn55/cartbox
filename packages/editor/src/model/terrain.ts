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
}

export const MIN_TERRAIN_SAMPLES = 2;
export const MAX_TERRAIN_SAMPLES = 257;
export const MAX_TERRAIN_LAYERS = 4;
/** Heights are stored to this precision (world units). */
const HEIGHT_STEP = 0.05;
const DEFAULT_TILE = 8;

/** The terrain's world height at (x, z), bilinear between samples; null off the grid. */
export function terrainHeight(t: Terrain, x: number, z: number): number | null {
  const n = t.samples;
  const gx = ((x - t.origin[0]) / t.size[0]) * (n - 1);
  const gz = ((z - t.origin[2]) / t.size[1]) * (n - 1);
  if (!(gx >= 0 && gz >= 0 && gx <= n - 1 && gz <= n - 1)) return null;
  const x0 = Math.min(n - 2, Math.floor(gx));
  const z0 = Math.min(n - 2, Math.floor(gz));
  const fx = gx - x0;
  const fz = gz - z0;
  const h = (i: number, j: number) => t.heights[j * n + i]!;
  const top = h(x0, z0) * (1 - fx) + h(x0 + 1, z0) * fx;
  const bottom = h(x0, z0 + 1) * (1 - fx) + h(x0 + 1, z0 + 1) * fx;
  return t.origin[1] + top * (1 - fz) + bottom * fz;
}

function layerFor(layers: readonly TerrainLayer[], up: number, height: number): number {
  for (let i = 0; i < layers.length - 1; i += 1) {
    const l = layers[i]!;
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
 */
export function terrainMesh(t: Terrain, stride = 1, cells?: readonly [number, number, number, number]): MeshAsset {
  const n = t.samples;
  const s = Math.max(1, Math.floor(stride));
  const [cx0, cz0, cx1, cz1] = cells ?? [0, 0, n - 1, n - 1];
  const dx = t.size[0] / (n - 1);
  const dz = t.size[1] / (n - 1);
  const tile = t.tile && t.tile > 0 ? t.tile : DEFAULT_TILE;
  const h = (i: number, j: number) => t.heights[Math.min(n - 1, j) * n + Math.min(n - 1, i)]!;
  const out = t.layers.map(() => ({ positions: [] as number[], normals: [] as number[], uvs: [] as number[], indices: [] as number[], map: new Map<number, number>() }));
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
    o.map.set(key, index);
    return index;
  };
  const floor = t.floor ?? -Infinity;
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    const pa = [a[0] * dx, h(a[0], a[1]), a[1] * dz];
    const pb = [b[0] * dx, h(b[0], b[1]), b[1] * dz];
    const pc = [c[0] * dx, h(c[0], c[1]), c[1] * dz];
    // Face normal (counter-clockwise seen from above is up).
    const ux = pb[0]! - pa[0]!, uy = pb[1]! - pa[1]!, uz = pb[2]! - pa[2]!;
    const vx = pc[0]! - pa[0]!, vy = pc[1]! - pa[1]!, vz = pc[2]! - pa[2]!;
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
    const layer = layerFor(t.layers, ny / len, t.origin[1] + (pa[1]! + pb[1]! + pc[1]!) / 3);
    out[layer]!.indices.push(vertex(layer, a[0], a[1]), vertex(layer, b[0], b[1]), vertex(layer, c[0], c[1]));
  };
  for (let j = cz0; j < cz1; j += s) {
    for (let i = cx0; i < cx1; i += s) {
      const i1 = Math.min(cx1, i + s);
      const j1 = Math.min(cz1, j + s);
      const h00 = h(i, j), h10 = h(i1, j), h01 = h(i, j1), h11 = h(i1, j1);
      if (t.origin[1] + Math.max(h00, h10, h01, h11) < floor) continue;
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
  out.forEach((o, i) => {
    if (o.indices.length === 0) return;
    primitives.push({
      positions: new Float32Array(o.positions),
      normals: new Float32Array(o.normals),
      uvs: new Float32Array(o.uvs),
      indices: new Uint32Array(o.indices),
      material: t.layers[i]!.material,
    });
  });
  return { name: t.name, primitives };
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
  layers: { material: SerializedMaterial; up?: [number, number]; height?: [number, number] }[];
  floor?: number;
  tile?: number;
  parent?: string;
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
    layers: t.layers.map((l) => ({ material: serializeMaterial(l.material), ...(l.up ? { up: [...l.up] } : {}), ...(l.height ? { height: [...l.height] } : {}) })),
    ...(t.floor !== undefined ? { floor: t.floor } : {}),
    ...(t.tile !== undefined ? { tile: t.tile } : {}),
    ...(t.parent ? { parent: t.parent } : {}),
  };
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
    const l = (raw ?? {}) as { material?: unknown; up?: unknown; height?: unknown };
    const up = pair(l.up);
    const height = pair(l.height);
    return { material: deserializeMaterial(l.material), ...(up ? { up } : {}), ...(height ? { height } : {}) };
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
  };
}

/** Read a sidecar's terrain list, dropping malformed entries. */
export function readTerrains(value: unknown): Terrain[] {
  if (!Array.isArray(value)) return [];
  return value.map(readTerrain).filter((t): t is Terrain => t !== null);
}

/**
 * Foliage (ENGINE_PARITY_ROADMAP.md EP11): meshes scattered over a terrain in
 * their thousands — grass, rocks, trees, snow drifts — painted with a brush or
 * filled across the ground by rules, each copy turned and sized at random and
 * tilted to the slope, and dropped past a distance.
 *
 * A layer stores its copies by where they stand on the terrain (x and z), not
 * their height: each is set on the ground when the scene loads, so sculpting
 * the terrain afterwards keeps everything standing on it. Painted copies cost
 * six bytes each; a **fill** costs nothing per copy — it's a seed and rules
 * (slope, height, an area to keep clear), scattered the same way on every load.
 *
 * To draw, the copies are merged into one mesh per block of ground, so a
 * thousand rocks are a few dozen draws, and a block past the layer's cull
 * distance isn't drawn at all. Pure and DOM-free.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";
import type { MeshAsset, MeshPrimitive } from "./MeshAsset";
import { terrainHeight, type Terrain } from "./terrain";

/** One copy, in its terrain's space: x and z from the grid's corner, a turn about up (radians), and a size. */
export interface FoliageCopy {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
}

/** Rules for filling a terrain with a layer: where copies may stand. */
export interface FoliageFill {
  readonly seed: number;
  /** Up component of the ground's normal, [min, max] (1 = flat). Absent = any. */
  readonly up?: readonly [number, number];
  /** World height of the ground, [min, max]. Absent = any. */
  readonly height?: readonly [number, number];
  /** Keep this circle clear (terrain space x, z and a radius): the play space, a path. */
  readonly clear?: readonly [number, number, number];
}

export interface FoliageLayer {
  readonly id: string;
  readonly name: string;
  /** The terrain (by id) the layer grows on. */
  readonly terrain: string;
  /** Copies per 100 m² where painted or filled. */
  readonly density: number;
  /** Random size range. */
  readonly scale: readonly [number, number];
  /** How far each copy tilts to the slope: 0 = stays upright (trees), 1 = lies along the ground (rocks, grass). */
  readonly align: number;
  /** Sink each copy this far into the ground (in its own units, before scaling), so rocks don't perch. */
  readonly sink: number;
  /** Past this distance from the camera a block of copies isn't drawn. */
  readonly cull: number;
  /** Painted copies. */
  readonly copies: readonly FoliageCopy[];
  /** Copies filled in by rules, on top of the painted ones. */
  readonly fill?: FoliageFill;
}

/** The most copies a layer holds (painted and filled together). */
export const MAX_FOLIAGE_COPIES = 20000;
/** Blocks of ground (world units) a layer's copies are merged into for drawing. */
export const FOLIAGE_BLOCK = 48;

/** A small deterministic random stream (mulberry32). */
export function foliageRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ground's height (terrain space) and normal at (x, z), or null off the grid or over a hole. */
export function groundAt(t: Terrain, x: number, z: number): { y: number; normal: [number, number, number] } | null {
  const local: Terrain = { ...t, origin: [0, 0, 0] };
  const y = terrainHeight(local, x, z);
  if (y === null) return null;
  const e = Math.min(t.size[0], t.size[1]) / (t.samples - 1);
  const flat: Terrain = { ...local, holes: undefined };
  const hx = (terrainHeight(flat, Math.min(t.size[0], x + e), z) ?? y) - (terrainHeight(flat, Math.max(0, x - e), z) ?? y);
  const hz = (terrainHeight(flat, x, Math.min(t.size[1], z + e)) ?? y) - (terrainHeight(flat, x, Math.max(0, z - e)) ?? y);
  const nx = -hx / (2 * e), nz = -hz / (2 * e);
  const len = Math.hypot(nx, 1, nz);
  return { y, normal: [nx / len, 1 / len, nz / len] };
}

/** Whether a fill's rules let a copy stand at (x, z). */
function allowed(t: Terrain, fill: FoliageFill, x: number, z: number): boolean {
  if (fill.clear && Math.hypot(x - fill.clear[0], z - fill.clear[1]) < fill.clear[2]) return false;
  const g = groundAt(t, x, z);
  if (!g) return false;
  if (t.floor !== undefined && t.origin[1] + g.y < t.floor) return false;
  if (fill.up && (g.normal[1] < fill.up[0] || g.normal[1] > fill.up[1])) return false;
  const h = t.origin[1] + g.y;
  if (fill.height && (h < fill.height[0] || h > fill.height[1])) return false;
  return true;
}

/**
 * The copies a fill scatters: jittered over a grid at the layer's density (one
 * candidate per cell, so they never clump), each kept where the rules allow.
 * The same seed always gives the same copies.
 */
export function fillCopies(t: Terrain, layer: Pick<FoliageLayer, "density" | "scale">, fill: FoliageFill, limit = MAX_FOLIAGE_COPIES): FoliageCopy[] {
  if (!(layer.density > 0)) return [];
  const spacing = Math.sqrt(100 / layer.density);
  const nx = Math.max(1, Math.floor(t.size[0] / spacing));
  const nz = Math.max(1, Math.floor(t.size[1] / spacing));
  const random = foliageRandom(fill.seed);
  const out: FoliageCopy[] = [];
  for (let j = 0; j < nz && out.length < limit; j += 1) {
    for (let i = 0; i < nx && out.length < limit; i += 1) {
      const x = (i + random()) * (t.size[0] / nx);
      const z = (j + random()) * (t.size[1] / nz);
      const yaw = random() * Math.PI * 2;
      const scale = layer.scale[0] + (layer.scale[1] - layer.scale[0]) * random();
      if (allowed(t, fill, x, z)) out.push({ x, z, yaw, scale });
    }
  }
  return out;
}

/** Every copy of a layer: painted, then filled, up to the cap. */
export function layerCopies(t: Terrain, layer: FoliageLayer): FoliageCopy[] {
  const painted = layer.copies.slice(0, MAX_FOLIAGE_COPIES);
  if (!layer.fill) return painted;
  return [...painted, ...fillCopies(t, layer, layer.fill, MAX_FOLIAGE_COPIES - painted.length)];
}

/**
 * Paint copies under a brush dab (terrain space): about `density × area ×
 * strength` new ones, each kept only where nothing already stands within the
 * layer's spacing (so repeated dabs fill in rather than pile up) and over ground.
 */
export function paintFoliage(t: Terrain, layer: FoliageLayer, brush: { x: number; z: number; radius: number; strength: number }, seed: number): FoliageLayer {
  const spacing = Math.sqrt(100 / Math.max(1e-3, layer.density));
  const area = Math.PI * brush.radius * brush.radius;
  const tries = Math.max(1, Math.round((layer.density / 100) * area * Math.max(0, Math.min(1, brush.strength)) * 2));
  const random = foliageRandom(seed);
  const near = (x: number, z: number, list: readonly FoliageCopy[]) => list.some((c) => Math.abs(c.x - x) < spacing * 0.7 && Math.abs(c.z - z) < spacing * 0.7 && Math.hypot(c.x - x, c.z - z) < spacing * 0.7);
  const copies = [...layer.copies];
  for (let k = 0; k < tries && copies.length < MAX_FOLIAGE_COPIES; k += 1) {
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * brush.radius;
    const x = brush.x + Math.cos(a) * r, z = brush.z + Math.sin(a) * r;
    const yaw = random() * Math.PI * 2;
    const scale = layer.scale[0] + (layer.scale[1] - layer.scale[0]) * random();
    if (x < 0 || z < 0 || x > t.size[0] || z > t.size[1] || !groundAt(t, x, z) || near(x, z, copies)) continue;
    copies.push({ x, z, yaw, scale });
  }
  return copies.length === layer.copies.length ? layer : { ...layer, copies };
}

/** Remove painted copies under a brush dab (a strength below 1 thins them instead, at random). */
export function eraseFoliage(layer: FoliageLayer, brush: { x: number; z: number; radius: number; strength: number }, seed: number): FoliageLayer {
  const random = foliageRandom(seed);
  const copies = layer.copies.filter((c) => Math.hypot(c.x - brush.x, c.z - brush.z) > brush.radius || random() > brush.strength);
  return copies.length === layer.copies.length ? layer : { ...layer, copies };
}

/** A copy's model matrix (column-major, terrain-local space with the terrain's origin applied), set on the ground. */
export function copyMatrix(t: Terrain, layer: Pick<FoliageLayer, "align" | "sink">, c: FoliageCopy): Float32Array | null {
  const g = groundAt(t, c.x, c.z);
  if (!g) return null;
  // Up: between straight up and the ground's normal, by `align`.
  const a = Math.max(0, Math.min(1, layer.align));
  let ux = g.normal[0] * a, uy = 1 - a + g.normal[1] * a, uz = g.normal[2] * a;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  // Forward: the yaw direction, made perpendicular to up.
  let fx = Math.sin(c.yaw), fy = 0, fz = Math.cos(c.yaw);
  const d = fx * ux + fy * uy + fz * uz;
  fx -= ux * d; fy -= uy * d; fz -= uz * d;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // Right = up × forward.
  const rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
  const s = c.scale;
  const sink = layer.sink * s;
  return Float32Array.from([
    rx * s, ry * s, rz * s, 0,
    ux * s, uy * s, uz * s, 0,
    fx * s, fy * s, fz * s, 0,
    t.origin[0] + c.x - ux * sink, t.origin[1] + g.y - uy * sink, t.origin[2] + c.z - uz * sink, 1,
  ]);
}

/** One block of merged copies, ready to draw: its mesh, and its centre and radius (terrain-local world space) for the cull. */
export interface FoliageBlock {
  readonly mesh: MeshAsset;
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly copies: number;
}

/**
 * Merge a layer's copies into one mesh per {@link FOLIAGE_BLOCK}-sized block
 * of ground (per primitive of the layer's mesh), each copy turned, sized,
 * tilted and set on the terrain.
 */
export function foliageBlocks(t: Terrain, layer: FoliageLayer, mesh: MeshAsset, copies: readonly FoliageCopy[] = layerCopies(t, layer)): FoliageBlock[] {
  const groups = new Map<string, Float32Array[]>();
  for (const c of copies) {
    const m = copyMatrix(t, layer, c);
    if (!m) continue;
    const key = `${Math.floor(c.x / FOLIAGE_BLOCK)},${Math.floor(c.z / FOLIAGE_BLOCK)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(m);
  }
  const out: FoliageBlock[] = [];
  for (const matrices of groups.values()) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const primitives: MeshPrimitive[] = mesh.primitives.map((p) => {
      const vertices = p.positions.length / 3;
      const positions = new Float32Array(vertices * 3 * matrices.length);
      const normals = p.normals ? new Float32Array(vertices * 3 * matrices.length) : null;
      const uvs = p.uvs ? new Float32Array(vertices * 2 * matrices.length) : null;
      const indices = new Uint32Array(p.indices.length * matrices.length);
      matrices.forEach((m, k) => {
        const base = k * vertices;
        for (let v = 0; v < vertices; v += 1) {
          const px = p.positions[v * 3]!, py = p.positions[v * 3 + 1]!, pz = p.positions[v * 3 + 2]!;
          const wx = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
          const wy = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
          const wz = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
          positions.set([wx, wy, wz], (base + v) * 3);
          x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, wy); y1 = Math.max(y1, wy); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
          if (normals && p.normals) {
            // Rotation and uniform scale only: the matrix's 3×3, renormalised.
            const nx = p.normals[v * 3]!, ny = p.normals[v * 3 + 1]!, nz = p.normals[v * 3 + 2]!;
            const tx = m[0]! * nx + m[4]! * ny + m[8]! * nz, ty = m[1]! * nx + m[5]! * ny + m[9]! * nz, tz = m[2]! * nx + m[6]! * ny + m[10]! * nz;
            const l = Math.hypot(tx, ty, tz) || 1;
            normals.set([tx / l, ty / l, tz / l], (base + v) * 3);
          }
        }
        if (uvs && p.uvs) uvs.set(p.uvs, base * 2);
        for (let i = 0; i < p.indices.length; i += 1) indices[k * p.indices.length + i] = p.indices[i]! + base;
      });
      return { positions, normals, uvs, indices, material: p.material };
    });
    out.push({
      mesh: { name: layer.name, primitives },
      center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2,
      copies: matrices.length,
    });
  }
  return out;
}

/** A layer as stored on the sidecar: its settings, its mesh (serialized), and its painted copies packed. */
export interface SerializedFoliage {
  id: string;
  name: string;
  terrain: string;
  mesh: string;
  density: number;
  scale: [number, number];
  align: number;
  sink: number;
  cull: number;
  /** Painted copies, six bytes each (base64): x and z as 16-bit fractions of the terrain, yaw and scale as bytes. */
  copies?: string;
  fill?: { seed: number; up?: [number, number]; height?: [number, number]; clear?: [number, number, number] };
}

/** Pack painted copies: x and z to 1/65535 of the terrain's size, yaw to 1/256 of a turn, scale within the layer's range to 1/255. */
export function packFoliageCopies(t: Pick<Terrain, "size">, layer: Pick<FoliageLayer, "scale" | "copies">): string {
  const bytes = new Uint8Array(layer.copies.length * 6);
  const view = new DataView(bytes.buffer);
  const [lo, hi] = layer.scale;
  layer.copies.forEach((c, k) => {
    view.setUint16(k * 6, Math.round(Math.max(0, Math.min(1, c.x / t.size[0])) * 65535), true);
    view.setUint16(k * 6 + 2, Math.round(Math.max(0, Math.min(1, c.z / t.size[1])) * 65535), true);
    view.setUint8(k * 6 + 4, Math.round((((c.yaw / (Math.PI * 2)) % 1) + 1) % 1 * 256) & 255);
    view.setUint8(k * 6 + 5, hi > lo ? Math.round(Math.max(0, Math.min(1, (c.scale - lo) / (hi - lo))) * 255) : 0);
  });
  return bytesToBase64(bytes);
}

export function unpackFoliageCopies(t: Pick<Terrain, "size">, scale: readonly [number, number], stored: string): FoliageCopy[] | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(stored);
  } catch {
    return null;
  }
  if (bytes.length % 6 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: FoliageCopy[] = [];
  for (let k = 0; k < bytes.length / 6 && k < MAX_FOLIAGE_COPIES; k += 1) {
    out.push({
      x: (view.getUint16(k * 6, true) / 65535) * t.size[0],
      z: (view.getUint16(k * 6 + 2, true) / 65535) * t.size[1],
      yaw: (view.getUint8(k * 6 + 4) / 256) * Math.PI * 2,
      scale: scale[0] + (scale[1] - scale[0]) * (view.getUint8(k * 6 + 5) / 255),
    });
  }
  return out;
}

export function serializeFoliage(t: Pick<Terrain, "size">, layer: FoliageLayer, mesh: string): SerializedFoliage {
  return {
    id: layer.id,
    name: layer.name,
    terrain: layer.terrain,
    mesh,
    density: layer.density,
    scale: [layer.scale[0], layer.scale[1]],
    align: layer.align,
    sink: layer.sink,
    cull: layer.cull,
    ...(layer.copies.length > 0 ? { copies: packFoliageCopies(t, layer) } : {}),
    ...(layer.fill
      ? {
          fill: {
            seed: layer.fill.seed,
            ...(layer.fill.up ? { up: [layer.fill.up[0], layer.fill.up[1]] as [number, number] } : {}),
            ...(layer.fill.height ? { height: [layer.fill.height[0], layer.fill.height[1]] as [number, number] } : {}),
            ...(layer.fill.clear ? { clear: [layer.fill.clear[0], layer.fill.clear[1], layer.fill.clear[2]] as [number, number, number] } : {}),
          },
        }
      : {}),
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined);

/**
 * Read a stored layer over its terrain (null when it's malformed): the layer,
 * and its mesh field as stored (the caller resolves and decodes it).
 */
export function readFoliage(value: unknown, terrains: readonly Pick<Terrain, "id" | "size">[]): { layer: FoliageLayer; mesh: string } | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<Record<keyof SerializedFoliage, unknown>>;
  if (typeof r.id !== "string" || typeof r.terrain !== "string" || typeof r.mesh !== "string") return null;
  const t = terrains.find((x) => x.id === r.terrain);
  if (!t) return null;
  const scale = pair(r.scale) ?? [1, 1];
  const lo = Math.max(0.01, Math.min(scale[0], scale[1])), hi = Math.max(lo, Math.max(scale[0], scale[1]));
  const copies = typeof r.copies === "string" ? (unpackFoliageCopies(t, [lo, hi], r.copies) ?? []) : [];
  let fill: FoliageFill | undefined;
  if (r.fill && typeof r.fill === "object") {
    const f = r.fill as Record<string, unknown>;
    const clear = Array.isArray(f.clear) && f.clear.length === 3 && f.clear.every(finite) ? ([f.clear[0], f.clear[1], f.clear[2]] as [number, number, number]) : undefined;
    if (finite(f.seed)) fill = { seed: Math.floor(f.seed), ...(pair(f.up) ? { up: pair(f.up)! } : {}), ...(pair(f.height) ? { height: pair(f.height)! } : {}), ...(clear ? { clear } : {}) };
  }
  return {
    mesh: r.mesh,
    layer: {
      id: r.id,
      name: typeof r.name === "string" ? r.name : "Foliage",
      terrain: r.terrain,
      density: finite(r.density) ? Math.max(0.01, Math.min(1000, r.density)) : 4,
      scale: [lo, hi],
      align: finite(r.align) ? Math.max(0, Math.min(1, r.align)) : 0.5,
      sink: finite(r.sink) ? Math.max(0, Math.min(10, r.sink)) : 0,
      cull: finite(r.cull) ? Math.max(1, Math.min(10000, r.cull)) : 120,
      copies,
      ...(fill ? { fill } : {}),
    },
  };
}

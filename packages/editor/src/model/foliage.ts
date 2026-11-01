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
import { terrainCurvature, terrainHeight, type Terrain } from "./terrain";
import { valueNoise } from "./materialGraph";
import { nearestOnSpline, sampleSpline, type Spline, type SplineSample } from "./splines";
import { foliageSway } from "./wind";

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
  // --- Placement rules (EDITOR_PRO_ROADMAP.md P4) ---
  /** More circles to keep clear (terrain space x, z, radius): bases, pads, lanes. */
  readonly keepOut?: readonly (readonly [number, number, number])[];
  /** The ground's curvature, [min, max] in metres (see terrainCurvature): hollows positive, crests negative. Absent = any. */
  readonly curvature?: readonly [number, number];
  /**
   * Grow in patches rather than evenly: broad noise `scale` world units across
   * decides where, `cover` (0..1) the share of the ground the patches cover,
   * their edges thinning out rather than stopping at a line.
   */
  readonly patches?: { readonly scale: number; readonly cover: number };
  /**
   * Stand only within a range of distance (world units) from the edge of these
   * splines (by id; see splines.ts): reeds within 3 m of a river's water, trees
   * kept 4 m off a path ([4, 1e9]). The splines come in the fill's context.
   */
  readonly near?: { readonly splines: readonly string[]; readonly within: readonly [number, number] };
}

/** What a fill may read beyond its terrain: the scene's splines, for its `near` rule. */
export interface FoliageContext {
  readonly splines?: readonly Spline[];
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
  /**
   * How freely the copies sway in the scene's wind (B6; see wind.ts), 0..4:
   * grass 3, reeds 4, a pine 0.5. Absent or 0 is stiff (rocks, drifts).
   */
  readonly wind?: number;
  /**
   * Impostors (EDITOR_PRO_ROADMAP.md P4; see render/impostor.ts): past
   * `distance` from the camera, a block of copies draws as cards carrying
   * pictures of the mesh (`mesh`, serialized, baked in the editor) instead of
   * the mesh itself — a forest edge for a few triangles a tree.
   */
  readonly impostor?: { readonly distance: number; readonly mesh: string };
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

/** How softly a patch's edge thins out, in the noise's own units. */
const PATCH_EDGE = 0.08;

/**
 * Whether a fill's rules let a copy stand at (x, z); `chance` (0..1, drawn by
 * the caller) decides where a patch's edge thins out. `near` is the sampled
 * splines of the fill's `near` rule (empty: the rule is ignored).
 */
function allowed(t: Terrain, fill: FoliageFill, x: number, z: number, chance: number, near: readonly (readonly SplineSample[])[]): boolean {
  if (fill.clear && Math.hypot(x - fill.clear[0], z - fill.clear[1]) < fill.clear[2]) return false;
  if (fill.keepOut?.some(([cx, cz, r]) => Math.hypot(x - cx, z - cz) < r)) return false;
  if (fill.patches) {
    const n = valueNoise((t.origin[0] + x) / fill.patches.scale, 0.5, (t.origin[2] + z) / fill.patches.scale, 3);
    // The noise sits mostly within 0.25..0.75: cover maps onto that band.
    const edge = 0.75 - 0.5 * Math.max(0, Math.min(1, fill.patches.cover));
    const keep = Math.max(0, Math.min(1, (n - edge) / PATCH_EDGE + 0.5));
    if (chance >= keep) return false;
  }
  const g = groundAt(t, x, z);
  if (!g) return false;
  if (t.floor !== undefined && t.origin[1] + g.y < t.floor) return false;
  if (fill.up && (g.normal[1] < fill.up[0] || g.normal[1] > fill.up[1])) return false;
  const h = t.origin[1] + g.y;
  if (fill.height && (h < fill.height[0] || h > fill.height[1])) return false;
  if (fill.curvature) {
    const c = terrainCurvature(t, Math.round((x / t.size[0]) * (t.samples - 1)), Math.round((z / t.size[1]) * (t.samples - 1)));
    if (c < fill.curvature[0] || c > fill.curvature[1]) return false;
  }
  if (fill.near && near.length > 0) {
    let best = Infinity;
    for (const samples of near) {
      const hit = nearestOnSpline(samples, t.origin[0] + x, t.origin[2] + z);
      if (hit) best = Math.min(best, Math.abs(hit.side) - hit.width / 2);
    }
    if (best < fill.near.within[0] || best > fill.near.within[1]) return false;
  }
  return true;
}

/**
 * The copies a fill scatters: jittered over a grid at the layer's density (one
 * candidate per cell, so they never clump), each kept where the rules allow.
 * The same seed always gives the same copies.
 */
export function fillCopies(t: Terrain, layer: Pick<FoliageLayer, "density" | "scale">, fill: FoliageFill, limit = MAX_FOLIAGE_COPIES, context: FoliageContext = {}): FoliageCopy[] {
  if (!(layer.density > 0)) return [];
  const near = fill.near ? (context.splines ?? []).filter((s) => fill.near!.splines.includes(s.id)).map((s) => sampleSpline(s, 1)) : [];
  // Patches thin out at their edges by a second stream, so the copies' places don't shift with them.
  const chance = foliageRandom(fill.seed ^ 0x5bd1e995);
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
      if (allowed(t, fill, x, z, chance(), near)) out.push({ x, z, yaw, scale });
    }
  }
  return out;
}

/** Every copy of a layer: painted, then filled, up to the cap. */
export function layerCopies(t: Terrain, layer: FoliageLayer, context: FoliageContext = {}): FoliageCopy[] {
  const painted = layer.copies.slice(0, MAX_FOLIAGE_COPIES);
  if (!layer.fill) return painted;
  return [...painted, ...fillCopies(t, layer, layer.fill, MAX_FOLIAGE_COPIES - painted.length, context)];
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
  /** Each copy's matrix (F6b: the AAA tier draws the layer's mesh once per copy, culled each on the GPU). */
  readonly matrices: readonly Float32Array[];
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
      // Wind (B6): each vertex bends by its height above its copy's root, at the copy's size.
      const flex = layer.wind && layer.wind > 0 ? layer.wind : 0;
      const sway = flex > 0 ? new Float32Array(vertices * matrices.length) : null;
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
        if (sway) {
          const size = Math.hypot(m[4]!, m[5]!, m[6]!);
          for (let v = 0; v < vertices; v += 1) sway[base + v] = foliageSway(p.positions[v * 3 + 1]! * size, flex);
        }
        if (uvs && p.uvs) uvs.set(p.uvs, base * 2);
        for (let i = 0; i < p.indices.length; i += 1) indices[k * p.indices.length + i] = p.indices[i]! + base;
      });
      return { positions, normals, uvs, indices, material: p.material, ...(sway ? { sway } : {}) };
    });
    out.push({
      mesh: { name: layer.name, primitives },
      center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
      radius: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2,
      copies: matrices.length,
      matrices,
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
  fill?: {
    seed: number;
    up?: [number, number];
    height?: [number, number];
    clear?: [number, number, number];
    keepOut?: [number, number, number][];
    curvature?: [number, number];
    patches?: { scale: number; cover: number };
    near?: { splines: string[]; within: [number, number] };
  };
  wind?: number;
  impostor?: { distance: number; mesh: string };
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
    ...(layer.wind && layer.wind > 0 ? { wind: layer.wind } : {}),
    ...(layer.impostor ? { impostor: { distance: layer.impostor.distance, mesh: layer.impostor.mesh } } : {}),
    ...(layer.fill
      ? {
          fill: {
            seed: layer.fill.seed,
            ...(layer.fill.up ? { up: [layer.fill.up[0], layer.fill.up[1]] as [number, number] } : {}),
            ...(layer.fill.height ? { height: [layer.fill.height[0], layer.fill.height[1]] as [number, number] } : {}),
            ...(layer.fill.clear ? { clear: [layer.fill.clear[0], layer.fill.clear[1], layer.fill.clear[2]] as [number, number, number] } : {}),
            ...(layer.fill.keepOut && layer.fill.keepOut.length > 0 ? { keepOut: layer.fill.keepOut.map((c) => [c[0], c[1], c[2]] as [number, number, number]) } : {}),
            ...(layer.fill.curvature ? { curvature: [layer.fill.curvature[0], layer.fill.curvature[1]] as [number, number] } : {}),
            ...(layer.fill.patches ? { patches: { scale: layer.fill.patches.scale, cover: layer.fill.patches.cover } } : {}),
            ...(layer.fill.near ? { near: { splines: [...layer.fill.near.splines], within: [layer.fill.near.within[0], layer.fill.near.within[1]] as [number, number] } } : {}),
          },
        }
      : {}),
  };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined);

/** A stored impostor: its switch distance and its mesh (kept as stored; the reader decodes it). */
function readImpostor(value: unknown): { distance: number; mesh: string } | null {
  const r = value as { distance?: unknown; mesh?: unknown } | null;
  if (!r || typeof r !== "object" || !finite(r.distance) || typeof r.mesh !== "string" || !r.mesh) return null;
  return { distance: Math.max(1, Math.min(10000, r.distance)), mesh: r.mesh };
}

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
    const keepOut = Array.isArray(f.keepOut)
      ? f.keepOut.slice(0, 64).filter((c): c is [number, number, number] => Array.isArray(c) && c.length === 3 && c.every(finite)).map((c) => [c[0], c[1], Math.max(0, c[2])] as [number, number, number])
      : [];
    const p = f.patches as Record<string, unknown> | undefined;
    const patches = p && typeof p === "object" && finite(p.scale) && finite(p.cover) ? { scale: Math.max(0.5, Math.min(10000, p.scale)), cover: Math.max(0, Math.min(1, p.cover)) } : undefined;
    const n = f.near as Record<string, unknown> | undefined;
    const near =
      n && typeof n === "object" && Array.isArray(n.splines) && pair(n.within)
        ? { splines: n.splines.filter((x): x is string => typeof x === "string").slice(0, 16), within: pair(n.within)! }
        : undefined;
    if (finite(f.seed))
      fill = {
        seed: Math.floor(f.seed),
        ...(pair(f.up) ? { up: pair(f.up)! } : {}),
        ...(pair(f.height) ? { height: pair(f.height)! } : {}),
        ...(clear ? { clear } : {}),
        ...(keepOut.length > 0 ? { keepOut } : {}),
        ...(pair(f.curvature) ? { curvature: pair(f.curvature)! } : {}),
        ...(patches ? { patches } : {}),
        ...(near && near.splines.length > 0 ? { near } : {}),
      };
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
      ...(finite(r.wind) && r.wind > 0 ? { wind: Math.min(4, r.wind) } : {}),
      ...(readImpostor(r.impostor) ? { impostor: readImpostor(r.impostor)! } : {}),
    },
  };
}

/** How much of the light on a leaf or a blade of grass passes through it to the other side (F6b; F1d's diffuse transmission). */
export const FOLIAGE_TRANSMISSION = 0.35;

/**
 * A layer's mesh as the AAA tier draws it, once per copy (F6b): its wind left
 * to the shader, which bends each vertex by its height above its copy's root
 * in the world (the sway each vertex stores is the layer's flexibility,
 * negated, telling it so), and its cut-out leaves and blades letting light
 * through (F1d's thin-surface transmission) unless their material already
 * says how much.
 */
export function foliageInstanceMesh(layer: Pick<FoliageLayer, "wind">, mesh: MeshAsset): MeshAsset {
  const flex = layer.wind && layer.wind > 0 ? layer.wind : 0;
  return {
    ...mesh,
    primitives: mesh.primitives.map((p) => {
      const leaf = p.material.alphaMode === "mask" && p.material.diffuseTransmission === undefined;
      return {
        ...p,
        ...(flex > 0 ? { sway: new Float32Array(p.positions.length / 3).fill(-flex) } : {}),
        ...(leaf ? { material: { ...p.material, diffuseTransmission: FOLIAGE_TRANSMISSION } } : {}),
      };
    }),
  };
}

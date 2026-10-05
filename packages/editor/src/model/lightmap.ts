/**
 * Baked lighting (HALO2_STYLE_ROADMAP.md, H1): light maps for a scene's still
 * objects — how much of the sky reaches each point of a surface (ambient
 * occlusion) plus one bounce of sunlight off nearby surfaces — so creases,
 * corners and overhangs darken and snow lifts the walls beside it, the soft
 * radiosity look of Halo-era maps.
 *
 * Two steps, split so a baked map can be shipped and reapplied cheaply:
 *
 * 1. {@link layoutLightmap} lays each mesh out in its own light-map atlas: its
 *    flat faces become charts (curved patches fall back to a chart per
 *    triangle), projected onto their plane at `density` texels per world unit,
 *    padded, and shelf-packed into a square power-of-two atlas. It returns the
 *    mesh with a second UV set ({@link MeshPrimitive.uvs2}) pointing into it.
 *    Deterministic: the same geometry always lays out the same way.
 * 2. {@link bakeLightmap} ray-traces the atlas against every occluder (a BVH
 *    over their triangles): per texel, cosine-weighted rays find the share of
 *    the sky that is open, and rays that hit a sunlit surface bring back its
 *    colour. The result is blurred within each chart (to hide the ray noise),
 *    padded past chart edges (so filtering never pulls in black), and stored
 *    as RGB × 1/{@link LIGHTMAP_RANGE}.
 *
 * Every renderer multiplies the ambient / image-based light by the map (the
 * sun's direct light is left to the live shadow map). Pure and DOM-free.
 */

import { PROBE_FACES, probePosition, quantizeLightProbes, type LightProbeGrid } from "./lightProbes";
import { encodeRgbaPng } from "./png";
import type { EncodedImage, MeshAsset, MeshPrimitive } from "./MeshAsset";

type Mat4 = ArrayLike<number>;
type V3 = [number, number, number];

/** A texel value of 255 scales the ambient light by this much (so bounce can brighten). */
export const LIGHTMAP_RANGE = 1.5;

export interface LightmapLayoutOptions {
  /** Texels per world unit (default 4). */
  readonly density?: number;
  /** Largest atlas edge; density is lowered until the charts fit (default 1024). */
  readonly maxSize?: number;
}

export interface LightmapLayout {
  /** The mesh with `uvs2` on every primitive (vertices shared by two charts are split). */
  readonly mesh: MeshAsset;
  /** Atlas edge, texels. */
  readonly size: number;
  /** Texels per world unit actually used. */
  readonly density: number;
  /** World transform the layout (and bake) assume. */
  readonly model: Mat4;
}

const PAD = 2;
const PLANAR_COS = 0.995;

function transform(m: Mat4, x: number, y: number, z: number): V3 {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

/** One chart: triangles (as index triples into the primitive) projected onto a plane. */
interface Chart {
  prim: number;
  tris: number[]; // triangle start offsets into primitive.indices
  /** Projected 2D position per original vertex index (world units). */
  proj: Map<number, [number, number]>;
  minS: number;
  minT: number;
  w: number; // texels, padding included
  h: number;
  x: number;
  y: number;
}

/** Lay a mesh out in a light-map atlas: see the module comment. */
export function layoutLightmap(mesh: MeshAsset, model: Mat4, options: LightmapLayoutOptions = {}): LightmapLayout {
  const maxSize = options.maxSize ?? 1024;
  // Charts in world units, found once; sizes depend on density.
  const raw: Omit<Chart, "w" | "h" | "x" | "y">[] = [];
  mesh.primitives.forEach((p, prim) => {
    const idx = p.indices;
    const n = p.positions.length / 3;
    const world: V3[] = [];
    for (let v = 0; v < n; v += 1) world.push(transform(model, p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!));
    // Components: triangles that share a vertex index.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
      return i;
    };
    for (let t = 0; t < idx.length; t += 3) {
      const a = find(idx[t]!), b = find(idx[t + 1]!), c = find(idx[t + 2]!);
      parent[b] = a;
      parent[find(c)] = a;
    }
    const groups = new Map<number, number[]>();
    const faceNormal = (t: number) => normalize(cross(sub(world[idx[t + 1]!]!, world[idx[t]!]!), sub(world[idx[t + 2]!]!, world[idx[t]!]!)));
    for (let t = 0; t < idx.length; t += 3) {
      const root = find(idx[t]!);
      let list = groups.get(root);
      if (!list) groups.set(root, (list = []));
      list.push(t);
    }
    const chartOf = (tris: number[], normal: V3) => {
      // A plane basis: u across, v up the face (or along Z for floors).
      const ref: V3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
      const u = normalize(cross(ref, normal));
      const v = cross(normal, u);
      const proj = new Map<number, [number, number]>();
      let minS = Infinity, minT = Infinity;
      for (const t of tris) {
        for (let k = 0; k < 3; k += 1) {
          const vi = idx[t + k]!;
          if (proj.has(vi)) continue;
          const w = world[vi]!;
          const st: [number, number] = [dot(w, u), dot(w, v)];
          proj.set(vi, st);
          minS = Math.min(minS, st[0]);
          minT = Math.min(minT, st[1]);
        }
      }
      raw.push({ prim, tris, proj, minS, minT });
    };
    for (const tris of groups.values()) {
      let avg: V3 = [0, 0, 0];
      const normals = tris.map(faceNormal);
      for (const nn of normals) avg = [avg[0] + nn[0], avg[1] + nn[1], avg[2] + nn[2]];
      avg = normalize(avg);
      if (normals.every((nn) => dot(nn, avg) > PLANAR_COS)) chartOf(tris, avg);
      else tris.forEach((t, i) => chartOf([t], normals[i]!));
    }
  });
  // Pack at the requested density, lowering it until everything fits.
  let density = options.density ?? 4;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const charts: Chart[] = raw.map((c) => {
      let maxS = -Infinity, maxT = -Infinity;
      for (const [s, t] of c.proj.values()) {
        maxS = Math.max(maxS, s);
        maxT = Math.max(maxT, t);
      }
      return { ...c, w: Math.max(1, Math.ceil((maxS - c.minS) * density)) + PAD * 2, h: Math.max(1, Math.ceil((maxT - c.minT) * density)) + PAD * 2, x: 0, y: 0 };
    });
    const area = charts.reduce((a, c) => a + c.w * c.h, 0);
    let size = 64;
    while (size * size < area * 1.15 && size < maxSize) size *= 2;
    for (; size <= maxSize; size *= 2) {
      if (pack(charts, size)) return finish(mesh, charts, size, density, model);
    }
    density *= 0.85;
  }
  throw new Error("Light map layout failed: too many charts to fit");
}

/** Shelf-pack charts (tallest first) into a size×size atlas; false if they don't fit. */
function pack(charts: Chart[], size: number): boolean {
  const order = charts.map((c, i) => i).sort((a, b) => charts[b]!.h - charts[a]!.h || charts[b]!.w - charts[a]!.w || a - b);
  let x = 0, y = 0, shelf = 0;
  for (const i of order) {
    const c = charts[i]!;
    if (c.w > size) return false;
    if (x + c.w > size) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    if (y + c.h > size) return false;
    c.x = x;
    c.y = y;
    x += c.w;
    shelf = Math.max(shelf, c.h);
  }
  return true;
}

/** Build the primitives with uvs2, splitting vertices shared between charts. */
function finish(mesh: MeshAsset, charts: Chart[], size: number, density: number, model: Mat4): LightmapLayout {
  const byPrim = mesh.primitives.map(() => [] as Chart[]);
  for (const c of charts) byPrim[c.prim]!.push(c);
  const primitives: MeshPrimitive[] = mesh.primitives.map((p, prim) => {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], uv2: number[] = [], indices: number[] = [];
    for (const c of byPrim[prim]!) {
      const remap = new Map<number, number>();
      for (const t of c.tris) {
        for (let k = 0; k < 3; k += 1) {
          const vi = p.indices[t + k]!;
          let out = remap.get(vi);
          if (out === undefined) {
            out = pos.length / 3;
            remap.set(vi, out);
            pos.push(p.positions[vi * 3]!, p.positions[vi * 3 + 1]!, p.positions[vi * 3 + 2]!);
            if (p.normals) nrm.push(p.normals[vi * 3]!, p.normals[vi * 3 + 1]!, p.normals[vi * 3 + 2]!);
            if (p.uvs) uv.push(p.uvs[vi * 2]!, p.uvs[vi * 2 + 1]!);
            const [s, tt] = c.proj.get(vi)!;
            const px = c.x + PAD + (s - c.minS) * density;
            const py = c.y + PAD + (tt - c.minT) * density;
            uv2.push(px / size, 1 - py / size);
          }
          indices.push(out);
        }
      }
    }
    return {
      positions: new Float32Array(pos),
      normals: p.normals ? new Float32Array(nrm) : null,
      uvs: p.uvs ? new Float32Array(uv) : null,
      indices: new Uint32Array(indices),
      material: p.material,
      uvs2: new Float32Array(uv2),
    };
  });
  return { mesh: { ...mesh, primitives }, size, density, model };
}

// --- Ray tracing ----------------------------------------------------------

/** Something that blocks light: a mesh placed in the world, with a colour per primitive. */
export interface Occluder {
  readonly mesh: MeshAsset;
  readonly model: Mat4;
  /** Diffuse colour per primitive (0..1) for bounce light; default its base colour. */
  readonly albedo?: readonly (readonly [number, number, number])[];
}

interface Bvh {
  tri: Float32Array; // 9 floats per triangle
  nrm: Float32Array; // face normal per triangle
  col: Float32Array; // albedo per triangle
  nodes: Float32Array; // min xyz, max xyz per node
  meta: Int32Array; // per node: left child (or -1 leaf), right/first, count
  order: Int32Array;
}

function buildBvh(occluders: readonly Occluder[]): Bvh {
  const tris: number[] = [], cols: number[] = [];
  for (const o of occluders) {
    o.mesh.primitives.forEach((p, pi) => {
      const f = p.material.baseColorFactor;
      const textured = p.material.baseColorImage ? 0.55 : 1;
      const col = o.albedo?.[pi] ?? [f[0] * textured, f[1] * textured, f[2] * textured];
      for (let t = 0; t < p.indices.length; t += 3) {
        for (let k = 0; k < 3; k += 1) {
          const v = p.indices[t + k]!;
          tris.push(...transform(o.model, p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!));
        }
        cols.push(col[0], col[1], col[2]);
      }
    });
  }
  const count = tris.length / 9;
  const tri = new Float32Array(tris);
  const nrm = new Float32Array(count * 3);
  const centre = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const o = i * 9;
    const n = normalize(cross([tri[o + 3]! - tri[o]!, tri[o + 4]! - tri[o + 1]!, tri[o + 5]! - tri[o + 2]!], [tri[o + 6]! - tri[o]!, tri[o + 7]! - tri[o + 1]!, tri[o + 8]! - tri[o + 2]!]));
    nrm.set(n, i * 3);
    for (let a = 0; a < 3; a += 1) centre[i * 3 + a] = (tri[o + a]! + tri[o + 3 + a]! + tri[o + 6 + a]!) / 3;
  }
  const order = new Int32Array(count).map((_, i) => i);
  const nodes: number[] = [];
  const meta: number[] = [];
  const build = (start: number, end: number): number => {
    const node = meta.length / 3;
    meta.push(-1, start, end - start);
    const mn: V3 = [Infinity, Infinity, Infinity];
    const mx: V3 = [-Infinity, -Infinity, -Infinity];
    const cmn: V3 = [Infinity, Infinity, Infinity];
    const cmx: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i += 1) {
      const t = order[i]!;
      for (let k = 0; k < 9; k += 1) {
        const a = k % 3;
        mn[a] = Math.min(mn[a]!, tri[t * 9 + k]!);
        mx[a] = Math.max(mx[a]!, tri[t * 9 + k]!);
      }
      for (let a = 0; a < 3; a += 1) {
        cmn[a] = Math.min(cmn[a]!, centre[t * 3 + a]!);
        cmx[a] = Math.max(cmx[a]!, centre[t * 3 + a]!);
      }
    }
    nodes.push(...mn, ...mx);
    if (end - start <= 4) return node;
    const extent = [cmx[0] - cmn[0], cmx[1] - cmn[1], cmx[2] - cmn[2]];
    const axis = extent[0]! >= extent[1]! && extent[0]! >= extent[2]! ? 0 : extent[1]! >= extent[2]! ? 1 : 2;
    if (extent[axis]! < 1e-9) return node;
    const split = (cmn[axis]! + cmx[axis]!) / 2;
    let mid = start;
    for (let i = start; i < end; i += 1) {
      if (centre[order[i]! * 3 + axis]! < split) {
        const tmp = order[i]!;
        order[i] = order[mid]!;
        order[mid] = tmp;
        mid += 1;
      }
    }
    if (mid === start || mid === end) mid = (start + end) >> 1;
    const left = build(start, mid);
    const right = build(mid, end);
    meta[node * 3] = left;
    meta[node * 3 + 1] = right;
    meta[node * 3 + 2] = 0;
    return node;
  };
  if (count > 0) build(0, count);
  return { tri, nrm, col: new Float32Array(cols), nodes: new Float32Array(nodes), meta: new Int32Array(meta), order };
}

/** Closest hit along a ray within tMax: the triangle index, or -1. `out[0]` = distance. */
function trace(b: Bvh, o: V3, d: V3, tMax: number, out: Float64Array, anyHit: boolean): number {
  if (b.meta.length === 0) return -1;
  const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]];
  const stack = new Int32Array(64);
  let sp = 0;
  stack[sp++] = 0;
  let best = -1;
  let tBest = tMax;
  while (sp > 0) {
    const n = stack[--sp]!;
    const bo = n * 6;
    // Slab test.
    let t0 = 0, t1 = tBest;
    for (let a = 0; a < 3; a += 1) {
      let ta = (b.nodes[bo + a]! - o[a]!) * inv[a]!;
      let tb = (b.nodes[bo + 3 + a]! - o[a]!) * inv[a]!;
      if (ta > tb) {
        const x = ta;
        ta = tb;
        tb = x;
      }
      t0 = ta > t0 ? ta : t0;
      t1 = tb < t1 ? tb : t1;
      if (t0 > t1) break;
    }
    if (t0 > t1) continue;
    const left = b.meta[n * 3]!;
    if (left >= 0) {
      stack[sp++] = left;
      stack[sp++] = b.meta[n * 3 + 1]!;
      continue;
    }
    const first = b.meta[n * 3 + 1]!, count = b.meta[n * 3 + 2]!;
    for (let i = first; i < first + count; i += 1) {
      const t = b.order[i]!;
      const k = t * 9;
      // Möller–Trumbore.
      const e1x = b.tri[k + 3]! - b.tri[k]!, e1y = b.tri[k + 4]! - b.tri[k + 1]!, e1z = b.tri[k + 5]! - b.tri[k + 2]!;
      const e2x = b.tri[k + 6]! - b.tri[k]!, e2y = b.tri[k + 7]! - b.tri[k + 1]!, e2z = b.tri[k + 8]! - b.tri[k + 2]!;
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-9 && det < 1e-9) continue;
      const id = 1 / det;
      const sx = o[0] - b.tri[k]!, sy = o[1] - b.tri[k + 1]!, sz = o[2] - b.tri[k + 2]!;
      const u = (sx * px + sy * py + sz * pz) * id;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * id;
      if (tt > 1e-4 && tt < tBest) {
        tBest = tt;
        best = t;
        if (anyHit) {
          out[0] = tt;
          return best;
        }
      }
    }
  }
  out[0] = tBest;
  return best;
}

export interface LightBakeOptions {
  /** Rays per texel (default 64). */
  readonly rays?: number;
  /** How far away something can be and still shade (world units, default 8). */
  readonly distance?: number;
  /** Direction toward the sun, for bounce light (none = sky only). */
  readonly sun?: readonly [number, number, number] | null;
  /** How strongly sunlit surfaces light their surroundings (default 0.9). */
  readonly bounce?: number;
  /** Darkens creases harder (>1) or softer (<1) (default 1.2). */
  readonly contrast?: number;
}

/** A pseudo-random 0..1 from an integer (deterministic bakes). */
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Bake a laid-out mesh's light map against `occluders` (which should include
 * the mesh itself). Returns the atlas as RGBA bytes (size × size). `progress`
 * is told the share done, row by row.
 */
export function bakeLightmap(layout: LightmapLayout, occluders: readonly Occluder[], options: LightBakeOptions = {}, progress?: (done: number) => void): Uint8ClampedArray {
  const rays = Math.max(4, options.rays ?? 64);
  const reach = options.distance ?? 8;
  const bounce = options.bounce ?? 0.9;
  const contrast = options.contrast ?? 1.2;
  const sun = options.sun ? normalize([...options.sun] as V3) : null;
  const bvh = buildBvh(occluders);
  const { size, model } = layout;
  const value = new Float32Array(size * size * 3);
  const chartId = new Int32Array(size * size).fill(-1);
  const hit = new Float64Array(2);
  const shade = new Float64Array(4);
  const sq = Math.ceil(Math.sqrt(rays));
  // Normal matrix ≈ the model's rotation (uniform scale assumed for baking).
  const rot = (x: number, y: number, z: number): V3 => normalize([model[0]! * x + model[4]! * y + model[8]! * z, model[1]! * x + model[5]! * y + model[9]! * z, model[2]! * x + model[6]! * y + model[10]! * z]);
  let chart = 0;
  const totalTris = layout.mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
  let doneTris = 0;
  for (const p of layout.mesh.primitives) {
    const uv2 = p.uvs2!;
    for (let t = 0; t < p.indices.length; t += 3) {
      chart += 1;
      doneTris += 1;
      const ia = p.indices[t]!, ib = p.indices[t + 1]!, ic = p.indices[t + 2]!;
      const P = [ia, ib, ic].map((i) => transform(model, p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!));
      const T = [ia, ib, ic].map((i) => [uv2[i * 2]! * size, (1 - uv2[i * 2 + 1]!) * size] as const);
      const face = normalize(cross(sub(P[1]!, P[0]!), sub(P[2]!, P[0]!)));
      const N = p.normals ? [ia, ib, ic].map((i) => rot(p.normals![i * 3]!, p.normals![i * 3 + 1]!, p.normals![i * 3 + 2]!)) : [face, face, face];
      const area = (T[1]![0] - T[0]![0]) * (T[2]![1] - T[0]![1]) - (T[2]![0] - T[0]![0]) * (T[1]![1] - T[0]![1]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(T[0]![0], T[1]![0], T[2]![0]) - 1));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(T[0]![0], T[1]![0], T[2]![0]) + 1));
      const y0 = Math.max(0, Math.floor(Math.min(T[0]![1], T[1]![1], T[2]![1]) - 1));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(T[0]![1], T[1]![1], T[2]![1]) + 1));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const px = x + 0.5, py = y + 0.5;
          let w0 = ((T[1]![0] - px) * (T[2]![1] - py) - (T[1]![1] - py) * (T[2]![0] - px)) / area;
          let w1 = ((T[2]![0] - px) * (T[0]![1] - py) - (T[2]![1] - py) * (T[0]![0] - px)) / area;
          let w2 = 1 - w0 - w1;
          // Conservative: take texel centres up to half a texel outside, clamped
          // onto the triangle, so edges have no gaps.
          const slack = -0.5 / Math.sqrt(Math.abs(area));
          if (w0 < slack || w1 < slack || w2 < slack) continue;
          const i = y * size + x;
          const inside = w0 >= 0 && w1 >= 0 && w2 >= 0;
          if (chartId[i]! >= 0 && !inside) continue; // an edge texel already owned
          w0 = Math.max(0, w0);
          w1 = Math.max(0, w1);
          w2 = Math.max(0, w2);
          const ws = w0 + w1 + w2;
          w0 /= ws;
          w1 /= ws;
          w2 /= ws;
          const pos: V3 = [0, 1, 2].map((a) => P[0]![a]! * w0 + P[1]![a]! * w1 + P[2]![a]! * w2) as V3;
          // Trust the authored normals (renderers draw both faces, so winding
          // says nothing about which way a surface faces).
          const n = normalize([0, 1, 2].map((a) => N[0]![a]! * w0 + N[1]![a]! * w1 + N[2]![a]! * w2) as V3);
          shadeTexel(bvh, pos, n, rays, sq, reach, sun, bounce, hit, i, shade);
          const vis = Math.pow(shade[0]!, contrast);
          value[i * 3] = vis + shade[1]!;
          value[i * 3 + 1] = vis + shade[2]!;
          value[i * 3 + 2] = vis + shade[3]!;
          chartId[i] = chart;
        }
      }
      if (progress && doneTris % 64 === 0) progress(doneTris / totalTris);
    }
  }
  // Two blur passes (a 5×5 footprint) within each chart: ray noise gone, edges kept.
  blurWithinCharts(value, chartId, size);
  blurWithinCharts(value, chartId, size);
  dilate(value, chartId, size, PAD + 1);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    // Quantised to steps of 2: invisible in soft lighting, and the PNG compresses far better.
    const q = (x: number) => Math.min(255, Math.round((x / LIGHTMAP_RANGE) * 127.5) * 2);
    out[i * 4] = q(value[i * 3]!);
    out[i * 4 + 1] = q(value[i * 3 + 1]!);
    out[i * 4 + 2] = q(value[i * 3 + 2]!);
    out[i * 4 + 3] = 255;
  }
  progress?.(1);
  return out;
}

/**
 * Sky visibility and bounced sunlight at one surface point, into `out`:
 * [visibility 0..1, bounce R, G, B].
 */
function shadeTexel(b: Bvh, pos: V3, n: V3, rays: number, sq: number, reach: number, sun: V3 | null, bounce: number, hit: Float64Array, seed: number, out: Float64Array): void {
  // Tangent frame about n.
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const tx = normalize(cross(ref, n));
  const ty = cross(n, tx);
  const origin: V3 = [pos[0] + n[0] * 0.01, pos[1] + n[1] * 0.01, pos[2] + n[2] * 0.01];
  let open = 0, br = 0, bg = 0, bb = 0;
  const jitter = hash01(seed);
  for (let r = 0; r < rays; r += 1) {
    // Stratified cosine-weighted hemisphere sample.
    const su = ((r % sq) + hash01(seed * 31 + r)) / sq;
    const sv = (Math.floor(r / sq) + ((hash01(seed * 17 + r * 7) + jitter) % 1)) / sq;
    const phi = 2 * Math.PI * su;
    const rad = Math.sqrt(Math.min(1, sv));
    const lx = Math.cos(phi) * rad, ly = Math.sin(phi) * rad, lz = Math.sqrt(Math.max(0, 1 - sv));
    const d: V3 = [tx[0] * lx + ty[0] * ly + n[0] * lz, tx[1] * lx + ty[1] * ly + n[1] * lz, tx[2] * lx + ty[2] * ly + n[2] * lz];
    const t = trace(b, origin, d, reach, hit, !sun);
    if (t < 0) {
      open += 1;
      continue;
    }
    // Occluded, but falloff with distance: far blockers shade less.
    open += Math.min(1, (hit[0]! / reach) ** 2) * 0.6;
    if (!sun || bounce <= 0) continue;
    const hn: V3 = [b.nrm[t * 3]!, b.nrm[t * 3 + 1]!, b.nrm[t * 3 + 2]!];
    const facing = dot(hn, d) < 0 ? hn : ([-hn[0], -hn[1], -hn[2]] as V3);
    const ndl = dot(facing, sun);
    if (ndl <= 0) continue;
    const hp: V3 = [origin[0] + d[0] * hit[0]! + facing[0] * 0.01, origin[1] + d[1] * hit[0]! + facing[1] * 0.01, origin[2] + d[2] * hit[0]! + facing[2] * 0.01];
    if (trace(b, hp, sun, 200, hit.subarray(1), true) >= 0) continue; // the bounce surface is in shadow
    const k = ndl * bounce;
    br += b.col[t * 3]! * k;
    bg += b.col[t * 3 + 1]! * k;
    bb += b.col[t * 3 + 2]! * k;
  }
  out[0] = Math.min(1, open / rays);
  out[1] = br / rays;
  out[2] = bg / rays;
  out[3] = bb / rays;
}

/**
 * Bake a light-probe grid (EP9; see lightProbes.ts): at each probe, what a
 * light map texel facing each axis direction would hold — sky visibility and
 * bounced sun — traced against `occluders`, quantised as storage keeps it.
 * `progress` hears the share done.
 */
export function bakeLightProbes(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  counts: readonly [number, number, number],
  occluders: readonly Occluder[],
  options: LightBakeOptions = {},
  progress?: (done: number) => void,
): LightProbeGrid {
  const rays = Math.max(4, options.rays ?? 64);
  const reach = options.distance ?? 8;
  const bounce = options.bounce ?? 0.9;
  const contrast = options.contrast ?? 1.2;
  const sun = options.sun ? normalize([...options.sun] as V3) : null;
  const bvh = buildBvh(occluders);
  const [cx, cy, cz] = counts;
  const values = new Float32Array(cx * cy * cz * 18);
  const hit = new Float64Array(2);
  const shade = new Float64Array(4);
  const sq = Math.ceil(Math.sqrt(rays));
  const grid = { min, max, counts };
  for (let z = 0; z < cz; z += 1) {
    for (let y = 0; y < cy; y += 1) {
      for (let x = 0; x < cx; x += 1) {
        const probe = (z * cy + y) * cx + x;
        const pos = probePosition(grid, x, y, z) as V3;
        PROBE_FACES.forEach((face, f) => {
          shadeTexel(bvh, pos, face as V3, rays, sq, reach, sun, bounce, hit, probe * 6 + f, shade);
          const vis = Math.pow(shade[0]!, contrast);
          const o = (probe * 6 + f) * 3;
          values[o] = Math.min(LIGHTMAP_RANGE, vis + shade[1]!);
          values[o + 1] = Math.min(LIGHTMAP_RANGE, vis + shade[2]!);
          values[o + 2] = Math.min(LIGHTMAP_RANGE, vis + shade[3]!);
        });
      }
    }
    progress?.((z + 1) / cz);
  }
  return { min: [...min], max: [...max], counts: [...counts], values: quantizeLightProbes(values) };
}

/** A 3×3 blur that only mixes texels of the same chart (hides ray noise, keeps edges). */
function blurWithinCharts(value: Float32Array, chartId: Int32Array, size: number): void {
  const src = value.slice();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const c = chartId[i]!;
      if (c < 0) continue;
      let r = 0, g = 0, bl = 0, w = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
          const j = yy * size + xx;
          if (chartId[j] !== c) continue;
          const k = dx === 0 && dy === 0 ? 2 : 1;
          r += src[j * 3]! * k;
          g += src[j * 3 + 1]! * k;
          bl += src[j * 3 + 2]! * k;
          w += k;
        }
      }
      value[i * 3] = r / w;
      value[i * 3 + 1] = g / w;
      value[i * 3 + 2] = bl / w;
    }
  }
}

/** Grow each chart's edge colours outward into empty texels, `steps` times. */
function dilate(value: Float32Array, chartId: Int32Array, size: number, steps: number): void {
  const filled = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i += 1) filled[i] = chartId[i]! >= 0 ? 1 : 0;
  for (let s = 0; s < steps; s += 1) {
    const next = filled.slice();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        if (filled[i]) continue;
        let r = 0, g = 0, bl = 0, w = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const j = yy * size + xx;
            if (!filled[j]) continue;
            r += value[j * 3]!;
            g += value[j * 3 + 1]!;
            bl += value[j * 3 + 2]!;
            w += 1;
          }
        }
        if (w === 0) continue;
        value[i * 3] = r / w;
        value[i * 3 + 1] = g / w;
        value[i * 3 + 2] = bl / w;
        next[i] = 1;
      }
    }
    filled.set(next);
  }
  // Anything never reached (unused atlas space) reads as open sky.
  for (let i = 0; i < size * size; i += 1) {
    if (filled[i]) continue;
    value[i * 3] = value[i * 3 + 1] = value[i * 3 + 2] = 1;
  }
}

/** The light map as a PNG, and the laid-out mesh with it on every material. */
export function withLightmap(layout: LightmapLayout, rgba: Uint8ClampedArray): MeshAsset {
  const image: EncodedImage = { mime: "image/png", bytes: encodeRgbaPng(rgba, layout.size, layout.size, { compress: true }) };
  return applyLightmapImage(layout.mesh, image);
}

/** Put an (already encoded) light map on every primitive of a laid-out mesh. */
export function applyLightmapImage(mesh: MeshAsset, image: EncodedImage): MeshAsset {
  return { ...mesh, primitives: mesh.primitives.map((p) => (p.uvs2 ? { ...p, material: { ...p.material, lightmapImage: image } } : p)) };
}

/** A stable fingerprint of a layout (geometry + light-map UVs), to tell when a stored bake is stale. */
export function layoutFingerprint(layout: LightmapLayout): string {
  let h = 0x811c9dc5;
  const mix = (f: Float32Array) => {
    const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    for (let i = 0; i < bytes.length; i += 1) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  };
  for (const p of layout.mesh.primitives) {
    mix(p.positions);
    if (p.uvs2) mix(p.uvs2);
  }
  return `${layout.size}:${(h >>> 0).toString(16)}`;
}

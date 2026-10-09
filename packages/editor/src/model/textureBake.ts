/**
 * Texture baking (HALO_INFINITE_STYLE_ROADMAP.md I15): ambient occlusion,
 * curvature and thickness baked from a mesh into its texture space, in the
 * editor, so the wear masks of I4 have real data to work from.
 *
 * - **Ambient occlusion** casts rays over the hemisphere above each texel's
 *   point (cosine-weighted), and darkens it by what they hit within reach,
 *   nearer hits darker. It goes to the material's occlusion map, which every
 *   renderer already applies to ambient light, and to the graph's Occlusion
 *   input (grime in the creases).
 * - **Curvature** comes from the mesh's edges: each edge between two faces
 *   adds its signed bend — convex positive, concave negative — to every point
 *   within `curvatureRadius` of it, fading with distance. So a chamfer's rims
 *   light up and a seam's floor darkens, at a width set in world units.
 * - **Thickness** casts rays into the surface (the hemisphere below it) and
 *   measures how far they travel before leaving: thin parts — fins, plates,
 *   edges — read thin. It feeds the graph's Thickness input.
 *
 * Curvature and thickness go into the relief map ({@link MeshMaterial.reliefImage}):
 * R = height (left flat, white), G = curvature around mid-grey, B = thinness
 * (0 = solid, as every relief map without a bake reads). Hits come from the
 * whole mesh, so one part shades another.
 *
 * A primitive with texture coordinates is baked in them, into maps of its
 * own. Those without are first given a unique layout — the light map's chart
 * packer, one atlas they all share — which replaces any light-map layout they
 * had (their light map no longer fits, so it is dropped). Pure and DOM-free;
 * deterministic.
 */

import type { EncodedImage, MeshAsset, MeshPrimitive } from "./MeshAsset";
import type { DecodedTexture } from "../render/meshRasterizer";
import { meshBounds } from "./MeshAsset";
import { buildBvh, hash01, layoutLightmap, trace, type Bvh } from "./lightmap";
import { encodeRgbaPng } from "./png";

type V3 = [number, number, number];

export interface SurfaceBakeOptions {
  /** Texels along each side of a map (default 256). */
  readonly size?: number;
  /** Rays per texel for occlusion (default 32) and thickness (half as many). */
  readonly rays?: number;
  /** How far occluders count, world units (default a quarter of the mesh's size). */
  readonly aoDistance?: number;
  /** How thick reads as solid, world units (default a fifth of the mesh's size). */
  readonly thicknessDistance?: number;
  /** How far an edge's curvature spreads, world units (default 1% of the mesh's size). */
  readonly curvatureRadius?: number;
}

/** One baked map pair and the primitives it belongs to. */
export interface BakedMaps {
  readonly primitives: readonly number[];
  /** R = G = B = ambient occlusion (white is open). */
  readonly occlusion: DecodedTexture;
  /** R = height (flat), G = curvature (mid-grey flat, lighter convex), B = thinness (black solid). */
  readonly relief: DecodedTexture;
}

export interface SurfaceBake {
  /** The mesh with its maps set (and, if it needed them, its new texture coordinates). */
  readonly mesh: MeshAsset;
  readonly maps: readonly BakedMaps[];
}

/** A bend of this many radians reads as full curvature (±1). */
export const CURVATURE_FULL_BEND = Math.PI / 3;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const vertex = (p: MeshPrimitive, i: number): V3 => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];

/** The mesh's edges between two faces, with their signed bend, bucketed in a grid for nearby lookup. */
class EdgeField {
  private readonly cells = new Map<string, number[]>();
  private readonly seg: number[] = [];
  private readonly bend: number[] = [];

  constructor(mesh: MeshAsset, private readonly radius: number) {
    const key = (v: V3) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
    // Faces by the (welded) edges they use: normal, and the vertex opposite the edge.
    const byEdge = new Map<string, { a: V3; b: V3; faces: { n: V3; opposite: V3 }[] }>();
    for (const p of mesh.primitives) {
      for (let t = 0; t < p.indices.length; t += 3) {
        const v = [0, 1, 2].map((k) => vertex(p, p.indices[t + k]!)) as [V3, V3, V3];
        let n = normalize(cross(sub(v[1], v[0]), sub(v[2], v[0])));
        // Trust authored normals over winding where they disagree.
        if (p.normals) {
          const i = p.indices[t]! * 3;
          if (dot(n, [p.normals[i]!, p.normals[i + 1]!, p.normals[i + 2]!]) < 0) n = [-n[0], -n[1], -n[2]];
        }
        for (let e = 0; e < 3; e += 1) {
          const a = v[e]!, b = v[(e + 1) % 3]!;
          const ka = key(a), kb = key(b);
          const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          let entry = byEdge.get(k);
          if (!entry) byEdge.set(k, (entry = { a, b, faces: [] }));
          entry.faces.push({ n, opposite: v[(e + 2) % 3]! });
        }
      }
    }
    for (const { a, b, faces } of byEdge.values()) {
      if (faces.length !== 2) continue;
      const [f, g] = faces as [{ n: V3; opposite: V3 }, { n: V3; opposite: V3 }];
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(f.n, g.n))));
      if (angle < 0.01) continue;
      // Convex when each face's far corner lies behind the other's plane.
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const convex = dot(f.n, sub(g.opposite, mid)) + dot(g.n, sub(f.opposite, mid)) < 0;
      const index = this.bend.length;
      this.seg.push(...a, ...b);
      this.bend.push(convex ? angle : -angle);
      // Into every cell the edge's reach overlaps.
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(a[k]!, b[k]!) - radius) / radius));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(a[k]!, b[k]!) + radius) / radius));
      const span = (hi[0]! - lo[0]! + 1) * (hi[1]! - lo[1]! + 1) * (hi[2]! - lo[2]! + 1);
      if (span > 4096) continue; // an edge vastly longer than the radius: skipped rather than flood the grid
      for (let x = lo[0]!; x <= hi[0]!; x += 1)
        for (let y = lo[1]!; y <= hi[1]!; y += 1)
          for (let z = lo[2]!; z <= hi[2]!; z += 1) {
            const c = `${x},${y},${z}`;
            const list = this.cells.get(c);
            if (list) list.push(index);
            else this.cells.set(c, [index]);
          }
    }
  }

  /** The summed bend of the edges near `p`, each fading to nothing at the radius (−1..1). */
  curvature(p: V3): number {
    const r = this.radius;
    const list = this.cells.get(`${Math.floor(p[0] / r)},${Math.floor(p[1] / r)},${Math.floor(p[2] / r)}`);
    if (!list) return 0;
    let sum = 0;
    for (const i of list) {
      const o = i * 6;
      const a: V3 = [this.seg[o]!, this.seg[o + 1]!, this.seg[o + 2]!];
      const d = sub([this.seg[o + 3]!, this.seg[o + 4]!, this.seg[o + 5]!], a);
      const len2 = dot(d, d);
      const t = len2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / len2)) : 0;
      const dist = Math.hypot(p[0] - (a[0] + d[0] * t), p[1] - (a[1] + d[1] * t), p[2] - (a[2] + d[2] * t));
      if (dist < r) sum += this.bend[i]! * (1 - dist / r);
    }
    return Math.max(-1, Math.min(1, sum / CURVATURE_FULL_BEND));
  }
}

/** `n` cosine-weighted hemisphere directions about `axis`, stratified, rotated per texel by `seed`. */
function hemisphere(axis: V3, n: number, seed: number, out: V3[]): void {
  const t = Math.abs(axis[0]) < 0.9 ? normalize(cross(axis, [1, 0, 0])) : normalize(cross(axis, [0, 1, 0]));
  const b = cross(axis, t);
  const sq = Math.max(1, Math.round(Math.sqrt(n)));
  const spin = hash01(seed) * Math.PI * 2;
  out.length = 0;
  for (let i = 0; i < sq; i += 1) {
    for (let j = 0; j < sq; j += 1) {
      const u1 = (i + hash01(seed * 31 + i * 7 + j)) / sq;
      const u2 = (j + hash01(seed * 17 + j * 13 + i)) / sq;
      const r = Math.sqrt(u1);
      const phi = u2 * Math.PI * 2 + spin;
      const x = r * Math.cos(phi), y = r * Math.sin(phi), z = Math.sqrt(Math.max(0, 1 - u1));
      out.push([t[0] * x + b[0] * y + axis[0] * z, t[1] * x + b[1] * y + axis[1] * z, t[2] * x + b[2] * y + axis[2] * z]);
    }
  }
}

/** Bake one set of primitives (their `uvs`) into one map pair of `size` texels. */
function bakePrimitives(prims: readonly MeshPrimitive[], size: number, bvh: Bvh, edges: EdgeField, o: Required<Omit<SurfaceBakeOptions, "size">>): { occlusion: DecodedTexture; relief: DecodedTexture } {
  const ao = new Float32Array(size * size).fill(1);
  const curv = new Float32Array(size * size);
  const thin = new Float32Array(size * size);
  const owner = new Int32Array(size * size).fill(-1);
  // Each texel's surface point and the world size of a texel there, so smoothing only mixes neighbours on the surface.
  const point = new Float32Array(size * size * 3);
  const spacing = new Float32Array(size * size);
  const hit = new Float64Array(2);
  const dirs: V3[] = [];
  const thicknessRays = Math.max(4, Math.round(o.rays / 2));
  const eps = 1e-3 * Math.max(o.aoDistance, o.thicknessDistance);
  let triangle = 0;
  for (const p of prims) {
    const uvs = p.uvs!;
    for (let t = 0; t < p.indices.length; t += 3, triangle += 1) {
      const ids = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
      const P = ids.map((i) => vertex(p, i));
      const T = ids.map((i) => [uvs[i * 2]! * size, (1 - uvs[i * 2 + 1]!) * size] as const);
      const face = normalize(cross(sub(P[1]!, P[0]!), sub(P[2]!, P[0]!)));
      const N = p.normals ? ids.map((i) => [p.normals![i * 3]!, p.normals![i * 3 + 1]!, p.normals![i * 3 + 2]!] as V3) : [face, face, face];
      const area = (T[1]![0] - T[0]![0]) * (T[2]![1] - T[0]![1]) - (T[2]![0] - T[0]![0]) * (T[1]![1] - T[0]![1]);
      if (Math.abs(area) < 1e-9) continue;
      const worldArea = Math.hypot(...cross(sub(P[1]!, P[0]!), sub(P[2]!, P[0]!)));
      const texel = Math.sqrt(worldArea / Math.abs(area));
      const x0 = Math.max(0, Math.floor(Math.min(T[0]![0], T[1]![0], T[2]![0]) - 1));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(T[0]![0], T[1]![0], T[2]![0]) + 1));
      const y0 = Math.max(0, Math.floor(Math.min(T[0]![1], T[1]![1], T[2]![1]) - 1));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(T[0]![1], T[1]![1], T[2]![1]) + 1));
      // Texel centres inside the triangle, and up to half a texel outside it (clamped on), so edges leave no gaps.
      const slack = -0.5 / Math.sqrt(Math.abs(area));
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const px = x + 0.5, py = y + 0.5;
          let w0 = ((T[1]![0] - px) * (T[2]![1] - py) - (T[1]![1] - py) * (T[2]![0] - px)) / area;
          let w1 = ((T[2]![0] - px) * (T[0]![1] - py) - (T[2]![1] - py) * (T[0]![0] - px)) / area;
          let w2 = 1 - w0 - w1;
          if (w0 < slack || w1 < slack || w2 < slack) continue;
          const i = y * size + x;
          const inside = w0 >= 0 && w1 >= 0 && w2 >= 0;
          if (owner[i]! >= 0 && !inside) continue;
          w0 = Math.max(0, w0);
          w1 = Math.max(0, w1);
          w2 = Math.max(0, w2);
          const ws = w0 + w1 + w2;
          w0 /= ws;
          w1 /= ws;
          w2 /= ws;
          const pos = [0, 1, 2].map((a) => P[0]![a]! * w0 + P[1]![a]! * w1 + P[2]![a]! * w2) as V3;
          const n = normalize([0, 1, 2].map((a) => N[0]![a]! * w0 + N[1]![a]! * w1 + N[2]![a]! * w2) as V3);
          owner[i] = triangle;
          point.set(pos, i * 3);
          spacing[i] = texel;
          // Occlusion: what the hemisphere above meets within reach, nearer darker.
          hemisphere(n, o.rays, i * 2 + 1, dirs);
          const above: V3 = [pos[0] + n[0] * eps, pos[1] + n[1] * eps, pos[2] + n[2] * eps];
          let occluded = 0;
          for (const d of dirs) if (trace(bvh, above, d, o.aoDistance, hit, false) >= 0) occluded += 1 - hit[0]! / o.aoDistance;
          ao[i] = 1 - occluded / dirs.length;
          // Thickness: how far rays into the surface travel before they leave it.
          const inward: V3 = [-n[0], -n[1], -n[2]];
          hemisphere(inward, thicknessRays, i * 2 + 2, dirs);
          const below: V3 = [pos[0] - n[0] * eps, pos[1] - n[1] * eps, pos[2] - n[2] * eps];
          let travelled = 0;
          for (const d of dirs) travelled += trace(bvh, below, d, o.thicknessDistance, hit, false) >= 0 ? hit[0]! : o.thicknessDistance;
          thin[i] = 1 - travelled / dirs.length / o.thicknessDistance;
          curv[i] = edges.curvature(pos);
        }
      }
    }
  }
  // Smooth the ray noise out of occlusion and thinness: a 3×3 average over the neighbours that are
  // neighbours on the surface too (within two texels' width of it), so charts never bleed into each other.
  for (const channel of [ao, thin]) {
    for (let pass = 0; pass < 2; pass += 1) {
      const src = Float32Array.from(channel);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const i = y * size + x;
          if (owner[i]! < 0) continue;
          const reach = 2 * spacing[i]!;
          let sum = 0, n = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
              const j = ny * size + nx;
              if (owner[j]! < 0) continue;
              const d = Math.hypot(point[j * 3]! - point[i * 3]!, point[j * 3 + 1]! - point[i * 3 + 1]!, point[j * 3 + 2]! - point[i * 3 + 2]!);
              if (d > reach) continue;
              sum += src[j]!;
              n += 1;
            }
          }
          channel[i] = sum / n;
        }
      }
    }
  }
  // Grow every chart a few texels into the empty space round it, so filtering never reads the background.
  for (let pass = 0; pass < 4; pass += 1) {
    const grown: number[] = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        if (owner[i]! >= 0) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (owner[j]! < 0) continue;
          grown.push(i, j);
          break;
        }
      }
    }
    for (let k = 0; k < grown.length; k += 2) {
      const i = grown[k]!, j = grown[k + 1]!;
      ao[i] = ao[j]!;
      curv[i] = curv[j]!;
      thin[i] = thin[j]!;
      owner[i] = owner[j]!;
    }
  }
  const occlusion = new Uint8ClampedArray(size * size * 4);
  const relief = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const a = Math.round(ao[i]! * 255);
    occlusion.set([a, a, a, 255], i * 4);
    relief.set([255, Math.round(127.5 + curv[i]! * 127.5), Math.round(Math.max(0, Math.min(1, thin[i]!)) * 255), 255], i * 4);
  }
  return { occlusion: { width: size, height: size, data: occlusion }, relief: { width: size, height: size, data: relief } };
}

/**
 * The texture layout a bake of `size` texels uses: a primitive's own
 * coordinates, or — for those without — one unique atlas laid out for them
 * all (the light map's chart packer), returned with its size. Cheap and
 * deterministic, so maps baked offline can be put back on the same layout.
 */
export function bakeLayout(mesh: MeshAsset, size: number): { mesh: MeshAsset; atlas: number } {
  const bare = mesh.primitives.flatMap((p, i) => (p.uvs ? [] : [i]));
  if (bare.length === 0) return { mesh, atlas: size };
  // Start at the density that would fill about half the atlas; the packer lowers it until the charts fit.
  let area = 0;
  for (const i of bare) {
    const p = mesh.primitives[i]!;
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vertex(p, p.indices[t + k]!)) as [V3, V3, V3];
      const n = cross(sub(b, a), sub(c, a));
      area += Math.hypot(n[0], n[1], n[2]) / 2;
    }
  }
  const density = Math.sqrt((0.5 * size * size) / Math.max(area, 1e-9));
  const layout = layoutLightmap({ ...mesh, primitives: bare.map((i) => mesh.primitives[i]!) }, IDENTITY, { density, maxSize: size });
  const placed = new Map(
    bare.map((i, k) => {
      const p = layout.mesh.primitives[k]!;
      // Its light map no longer fits the new layout.
      const { lightmapImage: _lightmap, ...material } = p.material;
      return [i, { ...p, uvs: p.uvs2!, uvs2: null, material }];
    }),
  );
  return { mesh: { ...mesh, primitives: mesh.primitives.map((p, i) => placed.get(i) ?? p) }, atlas: layout.size };
}

/** Bake a mesh's occlusion, curvature and thickness maps (see the module comment), and set them on its materials. */
export function bakeSurfaceMaps(mesh: MeshAsset, options: SurfaceBakeOptions = {}): SurfaceBake {
  const bounds = meshBounds(mesh);
  if (!bounds) return { mesh, maps: [] };
  const extent = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) || 1;
  const size = Math.max(8, Math.min(2048, Math.round(options.size ?? 256)));
  const o = {
    rays: Math.max(4, Math.round(options.rays ?? 32)),
    aoDistance: options.aoDistance ?? extent / 4,
    thicknessDistance: options.thicknessDistance ?? extent / 5,
    curvatureRadius: options.curvatureRadius ?? extent / 100,
  };
  const { mesh: laid, atlas } = bakeLayout(mesh, size);
  const bare = mesh.primitives.flatMap((p, i) => (p.uvs ? [] : [i]));
  const bvh = buildBvh([{ mesh: laid, model: IDENTITY }]);
  const edges = new EdgeField(laid, o.curvatureRadius);
  const groups: number[][] = [...mesh.primitives.flatMap((p, i) => (p.uvs ? [[i]] : [])), ...(bare.length > 0 ? [bare] : [])];
  const maps: BakedMaps[] = [];
  const images = new Map<number, { occlusionImage: EncodedImage; reliefImage: EncodedImage }>();
  for (const group of groups) {
    const baked = bakePrimitives(group.map((i) => laid.primitives[i]!), mesh.primitives[group[0]!]!.uvs ? size : atlas, bvh, edges, o);
    maps.push({ primitives: group, ...baked });
    const occlusionImage: EncodedImage = { mime: "image/png", bytes: encodeRgbaPng(baked.occlusion.data, baked.occlusion.width, baked.occlusion.height, { compress: true }) };
    const reliefImage: EncodedImage = { mime: "image/png", bytes: encodeRgbaPng(baked.relief.data, baked.relief.width, baked.relief.height, { compress: true }) };
    for (const i of group) images.set(i, { occlusionImage, reliefImage });
  }
  return {
    mesh: { ...laid, primitives: laid.primitives.map((p, i) => ({ ...p, material: { ...p.material, ...images.get(i)! } })) },
    maps,
  };
}

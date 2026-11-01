/**
 * High-to-low baking (AAA_FIDELITY_ROADMAP.md F9a): the Marmoset and Substance
 * baker workflow. A detailed (high-poly) mesh's surface is projected onto a
 * game (low-poly) mesh's texture space, so a few hundred triangles carry the
 * look of millions.
 *
 * - **Projection.** Each low texel's point (several, supersampled, so the maps
 *   are anti-aliased) casts a ray toward the high mesh: from a cage (a copy of
 *   the low mesh pushed out, with the same topology) toward the low surface,
 *   or without one from `front` above the low surface down to `back` below it,
 *   along its interpolated normal. The first hit along the ray is what the
 *   texel shows; a ray that finds nothing tries the other way, and failing
 *   that the texel keeps the low surface's own.
 * - **Synced to the renderer's tangents (F1c).** The low mesh's MikkTSpace
 *   tangents (made with `mikk` when it has none, or a per-vertex frame from its
 *   UVs) are what the AAA shader decodes a normal map with: the interpolated
 *   tangent t and normal n, and the bitangent w·(n × t). The baked normal is
 *   the solution of [t b n]·x = N_high, not its projection on an orthonormal
 *   frame, so it decodes to exactly the high mesh's normal; the tangents are
 *   written to the low mesh so every renderer decodes it in the same frame.
 * - **The maps.** A tangent-space normal map; ambient occlusion, curvature and
 *   thickness of the high mesh (textureBake.ts's estimators, at the hit); its
 *   position (normalised over its bounds); an ID map (a colour per high-mesh
 *   primitive, the masks smart materials pick from, F9b); and the height of
 *   the high surface over the low one (the relief map's R, beside curvature in
 *   G and thinness in B, as the same-mesh bake lays them).
 *
 * Pure and DOM-free; deterministic.
 */

import type { EncodedImage, MeshAsset, MeshPrimitive } from "./MeshAsset";
import type { DecodedTexture } from "../render/meshRasterizer";
import { meshBounds } from "./MeshAsset";
import { buildBvh, trace, type Bvh } from "./lightmap";
import { encodeRgbaPng } from "./png";
import { EdgeField, hemisphere } from "./textureBake";
import { withMeshTangents, type MikkTSpace } from "./tangents";

type V3 = [number, number, number];

export interface HighToLowOptions {
  /** Texels along each side of the maps (default 512). */
  readonly size?: number;
  /** Subsamples along each side of a texel (default 2: four a texel). */
  readonly supersample?: number;
  /** A cage: the low mesh's topology, pushed out round the high mesh; rays run from it to the low surface. */
  readonly cage?: MeshAsset | null;
  /** Without a cage: how far above the low surface a ray starts, world units (default 2% of the high mesh's size). */
  readonly front?: number;
  /** …and how far below it the ray reaches (default the same). */
  readonly back?: number;
  /** Rays a sample for occlusion (default 16) and thickness (half as many); 0 skips both. */
  readonly rays?: number;
  /** How far occluders count, world units (default a quarter of the high mesh's size). */
  readonly aoDistance?: number;
  /** How thick reads as solid (default a fifth of its size). */
  readonly thicknessDistance?: number;
  /** How far an edge's curvature spreads (default 1% of its size). */
  readonly curvatureRadius?: number;
  /** MikkTSpace, for a low mesh without tangents (the editor's WebAssembly build); else a frame from the UVs. */
  readonly mikk?: MikkTSpace | null;
}

/** The maps one group of low primitives (sharing texture space) bakes into. */
export interface HighToLowMaps {
  readonly primitives: readonly number[];
  /** Tangent space, 0.5 + 0.5·n per channel (OpenGL's +Y up). */
  readonly normal: DecodedTexture;
  /** White is open. */
  readonly occlusion: DecodedTexture;
  /** R = height of the high surface over the low (mid-grey on it), G = curvature (mid-grey flat), B = thinness. */
  readonly relief: DecodedTexture;
  /** The high surface's position over its bounds. */
  readonly position: DecodedTexture;
  /** A colour per high-mesh primitive (black where no ray found it). */
  readonly id: DecodedTexture;
  /** The share of the group's texels whose rays found the high mesh. */
  readonly coverage: number;
}

export interface HighToLowBake {
  /** The low mesh with its tangents and its normal, occlusion and relief maps set. */
  readonly mesh: MeshAsset;
  readonly maps: readonly HighToLowMaps[];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at3 = (a: ArrayLike<number>, i: number): V3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];

/** A colour for an ID, bright and well apart from its neighbours' (golden-ratio hues). */
export function idColour(id: number): [number, number, number] {
  const h = (id * 0.618033988749895 + 0.13) % 1;
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return Math.round(255 * (1 - 0.85 * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

/**
 * Per-vertex tangents from a primitive's UVs (Lengyel's accumulation), as
 * MikkTSpace's stand-in: w the bitangent's sign, the bitangent pointing up the
 * image (+V, as the engine samples at 1 − V).
 */
export function uvTangents(p: MeshPrimitive): Float32Array {
  const n = p.positions.length / 3;
  const tan = new Float64Array(n * 3);
  const bit = new Float64Array(n * 3);
  const uvs = p.uvs!;
  for (let t = 0; t < p.indices.length; t += 3) {
    const [i0, i1, i2] = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
    const e1 = sub(at3(p.positions, i1), at3(p.positions, i0));
    const e2 = sub(at3(p.positions, i2), at3(p.positions, i0));
    const du1 = uvs[i1 * 2]! - uvs[i0 * 2]!, dv1 = uvs[i1 * 2 + 1]! - uvs[i0 * 2 + 1]!;
    const du2 = uvs[i2 * 2]! - uvs[i0 * 2]!, dv2 = uvs[i2 * 2 + 1]! - uvs[i0 * 2 + 1]!;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-20) continue;
    const r = 1 / det;
    const T = [0, 1, 2].map((a) => (e1[a]! * dv2 - e2[a]! * dv1) * r);
    const B = [0, 1, 2].map((a) => (e2[a]! * du1 - e1[a]! * du2) * r);
    for (const i of [i0, i1, i2]) for (let a = 0; a < 3; a += 1) {
      tan[i * 3 + a] = tan[i * 3 + a]! + T[a]!;
      bit[i * 3 + a] = bit[i * 3 + a]! + B[a]!;
    }
  }
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    const nn: V3 = p.normals ? at3(p.normals, i) : [0, 1, 0];
    let t: V3 = [tan[i * 3]!, tan[i * 3 + 1]!, tan[i * 3 + 2]!];
    // Gram-Schmidt against the normal.
    t = normalize(sub(t, [nn[0] * dot(nn, t), nn[1] * dot(nn, t), nn[2] * dot(nn, t)]));
    const w = dot(cross(nn, t), [bit[i * 3]!, bit[i * 3 + 1]!, bit[i * 3 + 2]!]) < 0 ? -1 : 1;
    out.set([t[0], t[1], t[2], w], i * 4);
  }
  return out;
}

/** The high mesh as the projection reads it: its BVH, and per triangle its corners' normals and its primitive. */
interface HighMesh {
  readonly bvh: Bvh;
  readonly normals: Float32Array;
  readonly prim: Int32Array;
}

function highMesh(mesh: MeshAsset): HighMesh {
  const bvh = buildBvh([{ mesh, model: IDENTITY }]);
  const count = bvh.tri.length / 9;
  const normals = new Float32Array(count * 9);
  const prim = new Int32Array(count);
  let k = 0;
  mesh.primitives.forEach((p, pi) => {
    for (let t = 0; t < p.indices.length; t += 3, k += 1) {
      const ids = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
      const face = normalize(cross(sub(at3(p.positions, ids[1]!), at3(p.positions, ids[0]!)), sub(at3(p.positions, ids[2]!), at3(p.positions, ids[0]!))));
      ids.forEach((i, c) => normals.set(p.normals ? at3(p.normals, i) : face, k * 9 + c * 3));
      prim[k] = pi;
    }
  });
  return { bvh, normals, prim };
}

/** The high mesh's smooth normal at a point on triangle `t` (barycentric from its corners). */
function highNormal(h: HighMesh, t: number, p: V3): V3 {
  const k = t * 9;
  const a: V3 = [h.bvh.tri[k]!, h.bvh.tri[k + 1]!, h.bvh.tri[k + 2]!];
  const e1 = sub([h.bvh.tri[k + 3]!, h.bvh.tri[k + 4]!, h.bvh.tri[k + 5]!], a);
  const e2 = sub([h.bvh.tri[k + 6]!, h.bvh.tri[k + 7]!, h.bvh.tri[k + 8]!], a);
  const v = sub(p, a);
  const d00 = dot(e1, e1), d01 = dot(e1, e2), d11 = dot(e2, e2), d20 = dot(v, e1), d21 = dot(v, e2);
  const den = d00 * d11 - d01 * d01 || 1;
  const w1 = (d11 * d20 - d01 * d21) / den;
  const w2 = (d00 * d21 - d01 * d20) / den;
  const w0 = 1 - w1 - w2;
  return normalize([0, 1, 2].map((c) => h.normals[k + c]! * w0 + h.normals[k + 3 + c]! * w1 + h.normals[k + 6 + c]! * w2) as V3);
}

/** x with [t b n]·x = v (Cramer), the frame not orthonormal; null where it is degenerate. */
function solveFrame(t: V3, b: V3, n: V3, v: V3): V3 | null {
  const det = dot(t, cross(b, n));
  if (Math.abs(det) < 1e-12) return null;
  return [dot(v, cross(b, n)) / det, dot(t, cross(v, n)) / det, dot(t, cross(b, v)) / det];
}

/** Bake (see the module comment). */
export function bakeHighToLow(low: MeshAsset, high: MeshAsset, options: HighToLowOptions = {}): HighToLowBake {
  const hb = meshBounds(high);
  if (!hb) return { mesh: low, maps: [] };
  const extent = Math.hypot(hb.max[0] - hb.min[0], hb.max[1] - hb.min[1], hb.max[2] - hb.min[2]) || 1;
  const size = Math.max(8, Math.min(8192, Math.round(options.size ?? 512)));
  const ss = Math.max(1, Math.min(4, Math.round(options.supersample ?? 2)));
  const front = options.front ?? extent * 0.02;
  const back = options.back ?? front;
  const rays = Math.max(0, Math.round(options.rays ?? 16));
  const aoDistance = options.aoDistance ?? extent / 4;
  const thicknessDistance = options.thicknessDistance ?? extent / 5;
  const h = highMesh(high);
  const edges = new EdgeField(high, options.curvatureRadius ?? extent / 100);
  // The low mesh's tangent frame, as the renderer will decode with.
  const framed: MeshAsset = options.mikk
    ? withMeshTangents(low, options.mikk)
    : { ...low, primitives: low.primitives.map((p) => (p.uvs && p.normals && !p.tangents ? { ...p, tangents: uvTangents(p) } : p)) };
  const cage = options.cage && options.cage.primitives.length === low.primitives.length ? options.cage : null;
  // Primitives that share texture space bake into one set of maps (each its own, unless their UVs coincide).
  const groups = framed.primitives.flatMap((p, i) => (p.uvs && p.normals ? [[i]] : []));
  const maps: HighToLowMaps[] = [];
  const hit = new Float64Array(2);
  const dirs: V3[] = [];
  const eps = 1e-4 * extent;
  for (const group of groups) {
    const n = size * size;
    const acc = { normal: new Float32Array(n * 3), ao: new Float32Array(n), height: new Float32Array(n), curv: new Float32Array(n), thin: new Float32Array(n), pos: new Float32Array(n * 3), id: new Float32Array(n * 3), found: new Float32Array(n), weight: new Float32Array(n) };
    for (const pi of group) {
      const p = framed.primitives[pi]!;
      const cp = cage?.primitives[pi] ?? null;
      const uvs = p.uvs!;
      const tangents = p.tangents!;
      for (let tri = 0; tri < p.indices.length; tri += 3) {
        const ids = [p.indices[tri]!, p.indices[tri + 1]!, p.indices[tri + 2]!];
        const T = ids.map((i) => [uvs[i * 2]! * size, (1 - uvs[i * 2 + 1]!) * size] as const);
        const area = (T[1]![0] - T[0]![0]) * (T[2]![1] - T[0]![1]) - (T[2]![0] - T[0]![0]) * (T[1]![1] - T[0]![1]);
        if (Math.abs(area) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(T[0]![0], T[1]![0], T[2]![0])));
        const x1 = Math.min(size - 1, Math.ceil(Math.max(T[0]![0], T[1]![0], T[2]![0])));
        const y0 = Math.max(0, Math.floor(Math.min(T[0]![1], T[1]![1], T[2]![1])));
        const y1 = Math.min(size - 1, Math.ceil(Math.max(T[0]![1], T[1]![1], T[2]![1])));
        for (let y = y0; y <= y1; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            const texel = y * size + x;
            for (let sy = 0; sy < ss; sy += 1) {
              for (let sx = 0; sx < ss; sx += 1) {
                const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
                const w0 = ((T[1]![0] - px) * (T[2]![1] - py) - (T[1]![1] - py) * (T[2]![0] - px)) / area;
                const w1 = ((T[2]![0] - px) * (T[0]![1] - py) - (T[2]![1] - py) * (T[0]![0] - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const w = [w0, w1, w2];
                const lerp = (arr: ArrayLike<number>, stride: number, c: number) => ids.reduce((s, i, k) => s + arr[i * stride + c]! * w[k]!, 0);
                const P: V3 = [lerp(p.positions, 3, 0), lerp(p.positions, 3, 1), lerp(p.positions, 3, 2)];
                // The renderer's frame: interpolated unit normal and tangent (not renormalised), w·(n × t).
                const vn: V3 = [lerp(p.normals!, 3, 0), lerp(p.normals!, 3, 1), lerp(p.normals!, 3, 2)];
                const vt: V3 = [lerp(tangents, 4, 0), lerp(tangents, 4, 1), lerp(tangents, 4, 2)];
                const sign = tangents[ids[0]! * 4 + 3]! < 0 ? -1 : 1;
                const vb = cross(vn, vt).map((c) => c * sign) as V3;
                const N = normalize(vn);
                // The ray: from the cage to the low surface, or from `front` above it to `back` below.
                let origin: V3, dir: V3, reach: number;
                if (cp) {
                  const C: V3 = [0, 1, 2].map((c) => ids.reduce((s, i, k) => s + cp.positions[i * 3 + c]! * w[k]!, 0)) as V3;
                  const d = sub(P, C);
                  const len = Math.hypot(d[0], d[1], d[2]);
                  if (len < 1e-9) {
                    origin = [P[0] + N[0] * front, P[1] + N[1] * front, P[2] + N[2] * front];
                    dir = [-N[0], -N[1], -N[2]];
                    reach = front + back;
                  } else {
                    origin = C;
                    dir = [d[0] / len, d[1] / len, d[2] / len];
                    reach = len + back;
                  }
                } else {
                  origin = [P[0] + N[0] * front, P[1] + N[1] * front, P[2] + N[2] * front];
                  dir = [-N[0], -N[1], -N[2]];
                  reach = front + back;
                }
                let t = trace(h.bvh, origin, dir, reach, hit, false);
                if (t < 0) {
                  // A ray exactly along an edge of the high mesh can slip between its two triangles: nudge it.
                  const nudge = 1e-4 * extent;
                  const o2: V3 = [origin[0] + vt[0] * nudge + vb[0] * nudge * 0.7, origin[1] + vt[1] * nudge + vb[1] * nudge * 0.7, origin[2] + vt[2] * nudge + vb[2] * nudge * 0.7];
                  t = trace(h.bvh, o2, dir, reach, hit, false);
                  if (t >= 0) origin = o2;
                }
                if (t < 0) {
                  // Nothing that way: try outward from the low surface, past the front.
                  t = trace(h.bvh, P, N, front * 4, hit, false);
                  if (t >= 0) {
                    origin = P;
                    dir = N;
                  }
                }
                const along = hit[0]!;
                acc.weight[texel] = acc.weight[texel]! + 1;
                if (t < 0) {
                  // Not found: the low surface's own normal, open, flat.
                  acc.normal[texel * 3 + 2] = acc.normal[texel * 3 + 2]! + 1;
                  acc.ao[texel] = acc.ao[texel]! + 1;
                  acc.height[texel] = acc.height[texel]! + 0.5;
                  continue;
                }
                const Hp: V3 = [origin[0] + dir[0] * along, origin[1] + dir[1] * along, origin[2] + dir[2] * along];
                let Hn = highNormal(h, t, Hp);
                // Facing the low surface's side: a high surface met from behind shows its other face.
                if (dot(Hn, N) < 0 && dot(Hn, dir) > 0) Hn = [-Hn[0], -Hn[1], -Hn[2]];
                let x3 = solveFrame(vt, vb, vn, Hn) ?? [0, 0, 1];
                x3 = normalize(x3);
                if (x3[2] < 0) x3 = normalize([x3[0], x3[1], 0.001]);
                acc.normal[texel * 3] = acc.normal[texel * 3]! + x3[0];
                acc.normal[texel * 3 + 1] = acc.normal[texel * 3 + 1]! + x3[1];
                acc.normal[texel * 3 + 2] = acc.normal[texel * 3 + 2]! + x3[2];
                acc.found[texel] = acc.found[texel]! + 1;
                // The high surface's height over the low, along the low normal.
                acc.height[texel] = acc.height[texel]! + Math.max(0, Math.min(1, 0.5 + dot(sub(Hp, P), N) / (front + back)));
                for (let c = 0; c < 3; c += 1) acc.pos[texel * 3 + c] = acc.pos[texel * 3 + c]! + (Hp[c]! - hb.min[c]!) / Math.max(hb.max[c]! - hb.min[c]!, 1e-9);
                const col = idColour(h.prim[t]!);
                for (let c = 0; c < 3; c += 1) acc.id[texel * 3 + c] = acc.id[texel * 3 + c]! + col[c]!;
                acc.curv[texel] = acc.curv[texel]! + edges.curvature(Hp);
                if (rays > 0) {
                  const seed = texel * 16 + sy * 4 + sx;
                  hemisphere(Hn, rays, seed * 2 + 1, dirs);
                  const above: V3 = [Hp[0] + Hn[0] * eps, Hp[1] + Hn[1] * eps, Hp[2] + Hn[2] * eps];
                  let occluded = 0;
                  for (const d of dirs) if (trace(h.bvh, above, d, aoDistance, hit, false) >= 0) occluded += 1 - hit[0]! / aoDistance;
                  acc.ao[texel] = acc.ao[texel]! + 1 - occluded / dirs.length;
                  const inward: V3 = [-Hn[0], -Hn[1], -Hn[2]];
                  hemisphere(inward, Math.max(4, rays >> 1), seed * 2 + 2, dirs);
                  const below: V3 = [Hp[0] - Hn[0] * eps, Hp[1] - Hn[1] * eps, Hp[2] - Hn[2] * eps];
                  let travelled = 0;
                  for (const d of dirs) travelled += trace(h.bvh, below, d, thicknessDistance, hit, false) >= 0 ? hit[0]! : thicknessDistance;
                  acc.thin[texel] = acc.thin[texel]! + 1 - travelled / dirs.length / thicknessDistance;
                } else {
                  acc.ao[texel] = acc.ao[texel]! + 1;
                }
              }
            }
          }
        }
      }
    }
    maps.push({ primitives: group, ...finish(acc, size) });
  }
  // Each group's maps on its primitives' materials.
  const images = new Map<number, { normalImage: EncodedImage; occlusionImage: EncodedImage; reliefImage: EncodedImage }>();
  const png = (t: DecodedTexture): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(t.data, t.width, t.height, { compress: true }) });
  for (const m of maps) {
    const set = { normalImage: png(m.normal), occlusionImage: png(m.occlusion), reliefImage: png(m.relief) };
    for (const i of m.primitives) images.set(i, set);
  }
  return {
    mesh: { ...framed, primitives: framed.primitives.map((p, i) => (images.has(i) ? { ...p, material: { ...p.material, ...images.get(i)! } } : p)) },
    maps,
  };
}

/** Average the samples, grow each chart into the empty texels round it, and pack the maps. */
function finish(acc: { normal: Float32Array; ao: Float32Array; height: Float32Array; curv: Float32Array; thin: Float32Array; pos: Float32Array; id: Float32Array; found: Float32Array; weight: Float32Array }, size: number): Omit<HighToLowMaps, "primitives"> {
  const n = size * size;
  const owner = new Uint8Array(n);
  let covered = 0;
  let found = 0;
  for (let i = 0; i < n; i += 1) {
    const w = acc.weight[i]!;
    if (w === 0) continue;
    owner[i] = 1;
    covered += 1;
    if (acc.found[i]! > 0) found += 1;
    const v = normalize([acc.normal[i * 3]!, acc.normal[i * 3 + 1]!, acc.normal[i * 3 + 2]!]);
    acc.normal.set(v, i * 3);
    acc.ao[i] = acc.ao[i]! / w;
    acc.height[i] = acc.height[i]! / w;
    const f = acc.found[i]!;
    for (const arr of [acc.pos, acc.id]) for (let c = 0; c < 3; c += 1) arr[i * 3 + c] = f > 0 ? arr[i * 3 + c]! / f : 0;
    acc.curv[i] = f > 0 ? acc.curv[i]! / f : 0;
    acc.thin[i] = f > 0 ? acc.thin[i]! / f : 0;
  }
  // Grow the charts four texels into the gaps, so filtering and mips never read the background.
  for (let pass = 0; pass < 4; pass += 1) {
    const grown: number[] = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x;
        if (owner[i]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (!owner[j]) continue;
          grown.push(i, j);
          break;
        }
      }
    }
    for (let k = 0; k < grown.length; k += 2) {
      const i = grown[k]!, j = grown[k + 1]!;
      for (const arr of [acc.normal, acc.pos, acc.id]) for (let c = 0; c < 3; c += 1) arr[i * 3 + c] = arr[j * 3 + c]!;
      for (const arr of [acc.ao, acc.height, acc.curv, acc.thin]) arr[i] = arr[j]!;
      owner[i] = 1;
    }
  }
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const pack = (fn: (i: number) => [number, number, number]): DecodedTexture => {
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i += 1) {
      const [r, g, b] = owner[i] ? fn(i) : [0, 0, 0];
      data.set([r, g, b, 255], i * 4);
    }
    return { width: size, height: size, data };
  };
  return {
    normal: pack((i) => (owner[i] ? [byte(0.5 + 0.5 * acc.normal[i * 3]!), byte(0.5 + 0.5 * acc.normal[i * 3 + 1]!), byte(0.5 + 0.5 * acc.normal[i * 3 + 2]!)] : [128, 128, 255])),
    occlusion: pack((i) => [byte(acc.ao[i]!), byte(acc.ao[i]!), byte(acc.ao[i]!)]),
    relief: pack((i) => [byte(acc.height[i]!), byte(0.5 + 0.5 * acc.curv[i]!), byte(acc.thin[i]!)]),
    position: pack((i) => [byte(acc.pos[i * 3]!), byte(acc.pos[i * 3 + 1]!), byte(acc.pos[i * 3 + 2]!)]),
    id: pack((i) => [Math.round(acc.id[i * 3]!), Math.round(acc.id[i * 3 + 1]!), Math.round(acc.id[i * 3 + 2]!)]),
    coverage: covered > 0 ? found / covered : 0,
  };
}

/**
 * Destruction (AAA_FIDELITY_ROADMAP.md F8c): a mesh pre-fractured in the
 * editor into Voronoi pieces, which break apart at runtime as chunks thrown
 * by the hit, tumbling and settling on the scene's colliders.
 *
 * - **Voronoi cells.** Seeds are scattered in the mesh's bounds (denser near
 *   an expected impact, if given); each piece is the mesh clipped to one
 *   seed's cell (the half-spaces nearer that seed than any other).
 *   Triangles are clipped plane by plane (Sutherland–Hodgman, carrying
 *   normals and UVs). Each of the cell's planes is capped by the mesh's
 *   section there (where its edges cross the plane, ordered round their
 *   centre) clipped to the cell's other planes and fanned, with the plane's
 *   normal and a planar UV, in the piece's interior material. Exact for convex meshes
 *   (walls, pillars, crates, panels); a concave mesh's caps can span its
 *   hollows.
 * - **Chunks** are rigid: a position, an orientation, their velocities.
 *   Gravity, a bounding sphere against the scene's boxes (H9's colliders,
 *   with bounce and friction), damping, and sleep once settled — cosmetic and
 *   local, like debris (H10), so online play is unaffected.
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";
import { pushOutOfBoxes, type RagdollBox } from "./ragdoll";

type V3 = [number, number, number];
type Q = [number, number, number, number];

/** One piece: its geometry about its own centre, where that centre was in the mesh, its volume and its radius. */
export interface FracturePiece {
  readonly centre: V3;
  readonly volume: number;
  readonly radius: number;
  readonly primitives: readonly MeshPrimitive[];
  /** Each primitive's source in the mesh (its index), or −1 for the cap: the source's textures dress it. */
  readonly sources: readonly number[];
}

export const MAX_FRACTURE_PIECES = 64;

/** A seeded random stream (mulberry32). */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mesh's bounds over its primitives. */
export function meshBox(mesh: Pick<MeshAsset, "primitives">): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.primitives)
    for (let i = 0; i < p.positions.length; i += 3)
      for (let a = 0; a < 3; a += 1) {
        min[a] = Math.min(min[a]!, p.positions[i + a]!);
        max[a] = Math.max(max[a]!, p.positions[i + a]!);
      }
  return { min, max };
}

/**
 * `count` seeds in a box: uniform, or with `impact` given, half of them drawn
 * toward it (a hit shatters finer where it lands).
 */
export function voronoiSeeds(box: { min: readonly number[]; max: readonly number[] }, count: number, seed = 1, impact: readonly number[] | null = null): V3[] {
  const r = stream(seed);
  const n = Math.max(2, Math.min(MAX_FRACTURE_PIECES, Math.round(count)));
  return Array.from({ length: n }, (_, i) => {
    const p: V3 = [0, 1, 2].map((a) => box.min[a]! + (box.max[a]! - box.min[a]!) * r()) as V3;
    if (impact && i % 2 === 0) {
      const t = r() * r();
      return [p[0] + (impact[0]! - p[0]) * (1 - t), p[1] + (impact[1]! - p[1]) * (1 - t), p[2] + (impact[2]! - p[2]) * (1 - t)];
    }
    return p;
  });
}

/** A polygon's vertex while clipping: position, normal, UV. */
interface Vert {
  p: V3;
  n: V3;
  uv: [number, number];
}

const lerpV = (a: Vert, b: Vert, t: number): Vert => ({
  p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
  n: [a.n[0] + (b.n[0] - a.n[0]) * t, a.n[1] + (b.n[1] - a.n[1]) * t, a.n[2] + (b.n[2] - a.n[2]) * t],
  uv: [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t],
});

/** Clip a polygon to the half-space n·x ≤ d. */
function clipPolygon(poly: Vert[], n: V3, d: number): Vert[] {
  const out: Vert[] = [];
  const side = (v: Vert) => v.p[0] * n[0] + v.p[1] * n[1] + v.p[2] * n[2] - d;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
      out.push(lerpV(a, b, sa / (sa - sb)));
    }
  }
  return out;
}

/** The cap over a plane's cut points: ordered round their centre and fanned, facing out along `n`. */
function cap(points: V3[], n: V3): V3[][] {
  // Drop near-duplicates.
  const pts: V3[] = [];
  for (const p of points) if (!pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-6)) pts.push(p);
  if (pts.length < 3) return [];
  const c: V3 = [0, 0, 0];
  for (const p of pts) for (let a = 0; a < 3; a += 1) c[a] = c[a]! + p[a]! / pts.length;
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(helper, n));
  const v = cross(n, u);
  const angle = (p: V3) => Math.atan2(dot(sub(p, c), v), dot(sub(p, c), u));
  pts.sort((a, b) => angle(a) - angle(b));
  const tris: V3[][] = [];
  for (let i = 0; i < pts.length; i += 1) tris.push([c, pts[i]!, pts[(i + 1) % pts.length]!]);
  return tris;
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The mesh's section by the plane n·x = d (where its edges cross it, ordered round their centre: a convex
 * mesh's section is convex), clipped to the cell's other half-spaces: the cap's outline.
 */
function section(primitives: readonly MeshPrimitive[], n: V3, d: number, others: readonly { n: V3; d: number }[]): V3[] {
  const pts: V3[] = [];
  for (const prim of primitives)
    for (let t = 0; t + 2 < prim.indices.length; t += 3)
      for (let e = 0; e < 3; e += 1) {
        const a = prim.indices[t + e]! * 3;
        const b = prim.indices[t + ((e + 1) % 3)]! * 3;
        const pa: V3 = [prim.positions[a]!, prim.positions[a + 1]!, prim.positions[a + 2]!];
        const pb: V3 = [prim.positions[b]!, prim.positions[b + 1]!, prim.positions[b + 2]!];
        const sa = dot(n, pa) - d;
        const sb = dot(n, pb) - d;
        if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
          const f = sa / (sa - sb);
          pts.push([pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f]);
        }
      }
  const ring = cap(pts, n).map((tri) => tri[1]!);
  if (ring.length < 3) return [];
  let poly: Vert[] = ring.map((p) => ({ p, n, uv: [0, 0] }));
  for (const o of others) {
    if (poly.length < 3) return [];
    poly = clipPolygon(poly, o.n, o.d);
  }
  return poly.map((v) => v.p);
}

/** The material a piece's inside wears: the first primitive's, darker and rougher (broken stone, torn metal). */
export function interiorMaterial(material: MeshMaterial): MeshMaterial {
  const c = material.baseColorFactor;
  return { ...material, name: `${material.name}:interior`, baseColorFactor: [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, c[3]], baseColorImage: null, roughnessFactor: 1, metallicFactor: 0 };
}

/** A closed mesh's volume (the divergence theorem over its triangles). */
export function meshVolume(primitives: readonly Pick<MeshPrimitive, "positions" | "indices">[]): number {
  let v = 0;
  for (const p of primitives)
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const a = p.indices[t]! * 3, b = p.indices[t + 1]! * 3, c = p.indices[t + 2]! * 3;
      const pa = [p.positions[a]!, p.positions[a + 1]!, p.positions[a + 2]!];
      const pb = [p.positions[b]!, p.positions[b + 1]!, p.positions[b + 2]!];
      const pc = [p.positions[c]!, p.positions[c + 1]!, p.positions[c + 2]!];
      v += dot(pa, cross(pb, pc)) / 6;
    }
  return v;
}

/** Fracture a mesh into its seeds' Voronoi cells (see the module comment). Empty cells are dropped. */
export function fractureMesh(mesh: Pick<MeshAsset, "primitives">, seeds: readonly V3[]): FracturePiece[] {
  const inside = interiorMaterial(mesh.primitives[0]!.material);
  const box = meshBox(mesh);
  const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
  const pieces: FracturePiece[] = [];
  seeds.forEach((s, i) => {
    // The cell's planes: nearer s than each other seed.
    const planes: { n: V3; d: number }[] = [];
    seeds.forEach((o, j) => {
      if (j === i) return;
      const n = normalize(sub(o, s));
      const mid: V3 = [(o[0] + s[0]) / 2, (o[1] + s[1]) / 2, (o[2] + s[2]) / 2];
      planes.push({ n, d: dot(n, mid) });
    });
    const outer: MeshPrimitive[] = [];
    const sources: number[] = [];
    for (const [source, prim] of mesh.primitives.entries()) {
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      for (let t = 0; t + 2 < prim.indices.length; t += 3) {
        let poly: Vert[] = [0, 1, 2].map((k) => {
          const v = prim.indices[t + k]!;
          return {
            p: [prim.positions[v * 3]!, prim.positions[v * 3 + 1]!, prim.positions[v * 3 + 2]!] as V3,
            n: prim.normals ? ([prim.normals[v * 3]!, prim.normals[v * 3 + 1]!, prim.normals[v * 3 + 2]!] as V3) : ([0, 1, 0] as V3),
            uv: [prim.uvs?.[v * 2] ?? 0, prim.uvs?.[v * 2 + 1] ?? 0] as [number, number],
          };
        });
        for (const pl of planes) if (poly.length > 0) poly = clipPolygon(poly, pl.n, pl.d);
        if (poly.length < 3) continue;
        const base = positions.length / 3;
        for (const v of poly) {
          positions.push(...v.p);
          normals.push(...normalize(v.n));
          uvs.push(...v.uv);
        }
        for (let k = 1; k + 1 < poly.length; k += 1) indices.push(base, base + k, base + k + 1);
      }
      if (indices.length > 0) sources.push(source);
      if (indices.length > 0) outer.push({ ...prim, positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), tangents: undefined, uvs2: undefined, joints: undefined, weights: undefined, morphTargets: undefined } as MeshPrimitive);
    }
    if (outer.length === 0) return;
    // The caps, on every plane the cell's surface was cut by.
    const capP: number[] = [];
    const capN: number[] = [];
    const capUv: number[] = [];
    const capI: number[] = [];
    planes.forEach((pl, k) => {
      for (const tri of cap(section(mesh.primitives, pl.n, pl.d, planes.filter((_, j) => j !== k)), pl.n)) {
        const base = capP.length / 3;
        // Wound to face along the plane's normal (out of the cell).
        const ordered = dot(cross(sub(tri[1]!, tri[0]!), sub(tri[2]!, tri[0]!)), pl.n) >= 0 ? tri : [tri[0]!, tri[2]!, tri[1]!];
        const helper: V3 = Math.abs(pl.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const u = normalize(cross(helper, pl.n));
        const w = cross(pl.n, u);
        for (const p of ordered) {
          capP.push(...p);
          capN.push(...pl.n);
          capUv.push(dot(p, u) / span, dot(p, w) / span);
        }
        capI.push(base, base + 1, base + 2);
      }
    });
    const primitives = [...outer];
    if (capI.length > 0) primitives.push({ positions: Float32Array.from(capP), normals: Float32Array.from(capN), uvs: Float32Array.from(capUv), indices: Uint32Array.from(capI), material: inside } as MeshPrimitive);
    // About its centre (the mean of its vertices), so it turns about itself.
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (const p of primitives)
      for (let k = 0; k < p.positions.length; k += 3) {
        cx += p.positions[k]!;
        cy += p.positions[k + 1]!;
        cz += p.positions[k + 2]!;
        count += 1;
      }
    const centre: V3 = [cx / count, cy / count, cz / count];
    let radius = 0;
    const local = primitives.map((p) => {
      const positions = Float32Array.from(p.positions, (v, k) => v - centre[k % 3]!);
      for (let k = 0; k < positions.length; k += 3) radius = Math.max(radius, Math.hypot(positions[k]!, positions[k + 1]!, positions[k + 2]!));
      return { ...p, positions };
    });
    pieces.push({ centre, volume: meshVolume(local), radius, primitives: local, sources: capI.length > 0 ? [...sources, -1] : sources });
  });
  return pieces;
}

// --- Chunks -------------------------------------------------------------------

/** A chunk in flight: where (its centre), turned how, and its velocities. */
export interface Chunk {
  readonly piece: number;
  p: V3;
  q: Q;
  v: V3;
  w: V3;
  radius: number;
  asleep: boolean;
  quiet: number;
}

export const CHUNK_GRAVITY = 9.81;
const BOUNCE = 0.3;
const FRICTION = 0.5;

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** Turn a mesh-space point by a world matrix (column-major). */
function apply(m: ArrayLike<number>, p: readonly number[]): V3 {
  return [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!];
}

/**
 * Break a fractured mesh placed at `model` (rigid, uniform scale): each piece
 * a chunk at its place, thrown from the impact (world) by `impulse` (m/s at
 * the impact, falling off with distance), outward from it and spinning.
 */
export function breakApart(pieces: readonly FracturePiece[], model: ArrayLike<number>, impact: readonly number[], impulse: number, seed = 1): Chunk[] {
  const r = stream(seed);
  const scale = Math.hypot(model[0]!, model[1]!, model[2]!) || 1;
  // The model's rotation as a quaternion (its columns normalised).
  const m = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => model[i]! / scale);
  const tr = m[0]! + m[4]! + m[8]!;
  let q0: Q = [0, 0, 0, 1];
  if (tr > -0.999) {
    const s = Math.sqrt(1 + tr) * 2;
    q0 = [(m[5]! - m[7]!) / s, (m[6]! - m[2]!) / s, (m[1]! - m[3]!) / s, s / 4];
  }
  return pieces.map((piece, i) => {
    const p = apply(model, piece.centre);
    const away = sub(p, impact);
    const d = Math.hypot(...away) || 1e-3;
    const speed = impulse / (1 + d * d);
    const dir = normalize([away[0] + (r() - 0.5) * 0.3 * d, away[1] + (r() - 0.2) * 0.3 * d, away[2] + (r() - 0.5) * 0.3 * d]);
    return {
      piece: i,
      p,
      q: q0,
      v: [dir[0] * speed, dir[1] * speed, dir[2] * speed],
      w: [(r() - 0.5) * speed * 2, (r() - 0.5) * speed * 2, (r() - 0.5) * speed * 2],
      radius: piece.radius * scale,
      asleep: false,
      quiet: 0,
    };
  });
}

/** Step the chunks: gravity, their spin, the scene's boxes by their bounding spheres, and sleep once still. */
export function stepChunks(chunks: Chunk[], dt: number, colliders: readonly RagdollBox[], floor = -Infinity): void {
  for (const c of chunks) {
    if (c.asleep) continue;
    c.v[1] -= CHUNK_GRAVITY * dt;
    c.p = [c.p[0] + c.v[0] * dt, c.p[1] + c.v[1] * dt, c.p[2] + c.v[2] * dt];
    // The spin: q += ½ (ω, 0) q dt.
    const dq = qmul([c.w[0], c.w[1], c.w[2], 0], c.q);
    const q: Q = [c.q[0] + 0.5 * dq[0] * dt, c.q[1] + 0.5 * dq[1] * dt, c.q[2] + 0.5 * dq[2] * dt, c.q[3] + 0.5 * dq[3] * dt];
    const ql = Math.hypot(...q) || 1;
    c.q = [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql];
    let contact = false;
    const pos = Float64Array.from(c.p);
    const pushed = pushOutOfBoxes(pos, 0, c.radius * 0.6, colliders);
    let normal: V3 | null = pushed ? normalize(pushed as V3) : null;
    if (pushed) c.p = [pos[0]!, pos[1]!, pos[2]!];
    if (c.p[1] - c.radius * 0.6 < floor) {
      c.p[1] = floor + c.radius * 0.6;
      normal = [0, 1, 0];
    }
    if (normal) {
      contact = true;
      const vn = dot(c.v, normal);
      if (vn < 0) {
        const t: V3 = [c.v[0] - vn * normal[0], c.v[1] - vn * normal[1], c.v[2] - vn * normal[2]];
        c.v = [t[0] * (1 - FRICTION) - vn * BOUNCE * normal[0], t[1] * (1 - FRICTION) - vn * BOUNCE * normal[1], t[2] * (1 - FRICTION) - vn * BOUNCE * normal[2]];
      }
      c.w = [c.w[0] * 0.8, c.w[1] * 0.8, c.w[2] * 0.8];
    }
    const still = contact && Math.hypot(...c.v) < 0.15 && Math.hypot(...c.w) < 0.3;
    c.quiet = still ? c.quiet + 1 : 0;
    if (c.quiet > 20) c.asleep = true;
  }
}

/** A chunk's world matrix (column-major): its rotation and the model's scale, about its centre. */
export function chunkMatrix(c: Chunk, scale = 1): Float64Array {
  const [x, y, z, w] = c.q;
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * scale, 2 * (x * y + z * w) * scale, 2 * (x * z - y * w) * scale, 0,
    2 * (x * y - z * w) * scale, (1 - 2 * (x * x + z * z)) * scale, 2 * (y * z + x * w) * scale, 0,
    2 * (x * z + y * w) * scale, 2 * (y * z - x * w) * scale, (1 - 2 * (x * x + y * y)) * scale, 0,
    c.p[0], c.p[1], c.p[2], 1,
  ]);
}

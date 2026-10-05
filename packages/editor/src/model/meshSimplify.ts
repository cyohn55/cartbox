/**
 * LOD generation (ENGINE_PARITY_ROADMAP.md EP9b): simplify a mesh into
 * lighter levels by quadric-error edge collapse (Garland & Heckbert), the
 * web-sized answer to Nanite.
 *
 * Half-edge collapses only: a vertex is folded into a neighbour that stays
 * where it is, so a level keeps the original vertices and only rewrites the
 * triangle list. That means a level shares its base mesh's vertex arrays —
 * positions, normals, UVs, light-map UVs, skin weights — so it costs only its
 * indices to store, and a skinned mesh's level skins with the same matrices.
 *
 * Vertices on a border (an edge with one triangle) and on a seam (one point
 * stored as several vertices, for a UV or normal split) never move, so the
 * silhouette holds and no crack opens along a seam. A collapse that would flip
 * a triangle over is refused, and a part already as plain as a box is left whole.
 *
 * A mesh built from separate hard-edged parts — boxes, panels, the faceted
 * style Lockout's soldiers are made in — has nothing to collapse (every vertex
 * is on a seam), so its levels also drop the small parts instead: a part (the
 * triangles joined by shared points) smaller than a share of the whole mesh
 * goes, as a modeller would leave the buckles off a distant model.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";
import type { MeshAsset, MeshPrimitive } from "./MeshAsset";

/** A binary min-heap of (cost, u, v, stamp) candidate collapses. */
class Heap {
  private readonly items: { cost: number; u: number; v: number; stamp: number }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: { cost: number; u: number; v: number; stamp: number }): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.cost <= a[i]!.cost) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { cost: number; u: number; v: number; stamp: number } | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.cost < a[m]!.cost) m = l;
        if (r < a.length && a[r]!.cost < a[m]!.cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Simplify one primitive's triangle list to about `ratio` of its triangles
 * (vertices kept, indices new).
 *
 * With `faceted` — the primitive's normals (and, if skinned, its joints) — a
 * hard-edged mesh is simplified across its creases: its vertices are welded by
 * point (and first joint, so no corner changes bone), collapsed as one smooth
 * surface, and each surviving corner then takes the original vertex at its point
 * whose normal best matches the new triangle's face. For untextured meshes only:
 * a UV seam would tear.
 */
export function simplifyIndices(
  positions: Float32Array,
  indices: Uint32Array,
  ratio: number,
  faceted?: { readonly normals: Float32Array; readonly joints?: Uint16Array | null } | null,
  maxError = Infinity,
): Uint32Array {
  if (!faceted) return collapse(positions, indices, ratio, true, maxError);
  const { normals, joints } = faceted;
  const vertexCount = positions.length / 3;
  const rep = new Int32Array(vertexCount);
  const atPoint = new Map<number, number[]>();
  const keys = new Map<string, number>();
  for (let v = 0; v < vertexCount; v += 1) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]},${joints ? joints[v * 4] : 0}`;
    const r = keys.get(key) ?? v;
    keys.set(key, r);
    rep[v] = r;
    if (r === v) atPoint.set(v, [v]);
    else atPoint.get(r)!.push(v);
  }
  const welded = collapse(positions, Uint32Array.from(indices, (v) => rep[v]!), ratio, false, maxError);
  if (welded.length === indices.length) return indices; // nothing gave
  const out = new Uint32Array(welded.length);
  for (let t = 0; t < welded.length; t += 3) {
    const i0 = welded[t]! * 3, i1 = welded[t + 1]! * 3, i2 = welded[t + 2]! * 3;
    const ux = positions[i1]! - positions[i0]!, uy = positions[i1 + 1]! - positions[i0 + 1]!, uz = positions[i1 + 2]! - positions[i0 + 2]!;
    const vx = positions[i2]! - positions[i0]!, vy = positions[i2 + 1]! - positions[i0 + 1]!, vz = positions[i2 + 2]! - positions[i0 + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (let k = 0; k < 3; k += 1) {
      let best = welded[t + k]!;
      let score = -Infinity;
      for (const v of atPoint.get(best) ?? [best]) {
        const d = normals[v * 3]! * nx + normals[v * 3 + 1]! * ny + normals[v * 3 + 2]! * nz;
        if (d > score) {
          score = d;
          best = v;
        }
      }
      out[t + k] = best;
    }
  }
  return out;
}

/**
 * The collapse itself: to about `ratio` of the triangles, seams held still when
 * `lockSeams`, stopping early once the cheapest collapse would move the surface
 * by more than `maxError` (the summed squared distance from the planes it had).
 */
function collapse(positions: Float32Array, indices: Uint32Array, ratio: number, lockSeams: boolean, maxError: number): Uint32Array {
  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;
  const target = Math.max(1, Math.floor(triCount * Math.min(1, Math.max(0, ratio))));
  if (target >= triCount || triCount < 4) return indices;

  // Each vertex's point: vertices at the same position (a seam) share one.
  const pointOf = new Int32Array(vertexCount);
  const points = new Map<string, number>();
  for (let v = 0; v < vertexCount; v += 1) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    let p = points.get(key);
    if (p === undefined) {
      p = points.size;
      points.set(key, p);
    }
    pointOf[v] = p;
  }
  const pointVerts = new Int32Array(points.size);
  for (let v = 0; v < vertexCount; v += 1) pointVerts[pointOf[v]!]! += 1;

  // Triangles: live flags and current corners; and each vertex's triangles.
  const tri = Uint32Array.from(indices);
  const alive = new Uint8Array(triCount).fill(1);
  const around: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < triCount; t += 1) for (let k = 0; k < 3; k += 1) around[tri[t * 3 + k]!]!.push(t);

  // Quadrics per vertex (10 unique terms of the symmetric 4×4), from the planes of its triangles.
  const Q = new Float64Array(vertexCount * 10);
  const addPlane = (v: number, a: number, b: number, c: number, d: number, w: number) => {
    const terms = [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
    for (let k = 0; k < 10; k += 1) Q[v * 10 + k] = Q[v * 10 + k]! + w * terms[k]!;
  };
  const faceNormal = (t: number): [number, number, number, number] => {
    const i0 = tri[t * 3]! * 3, i1 = tri[t * 3 + 1]! * 3, i2 = tri[t * 3 + 2]! * 3;
    const ux = positions[i1]! - positions[i0]!, uy = positions[i1 + 1]! - positions[i0 + 1]!, uz = positions[i1 + 2]! - positions[i0 + 2]!;
    const vx = positions[i2]! - positions[i0]!, vy = positions[i2 + 1]! - positions[i0 + 1]!, vz = positions[i2 + 2]! - positions[i0 + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return [nx, ny, nz, Math.hypot(nx, ny, nz)];
  };
  for (let t = 0; t < triCount; t += 1) {
    const [nx, ny, nz, len] = faceNormal(t);
    if (len < 1e-20) continue;
    const a = nx / len, b = ny / len, c = nz / len;
    const i0 = tri[t * 3]! * 3;
    const d = -(a * positions[i0]! + b * positions[i0 + 1]! + c * positions[i0 + 2]!);
    for (let k = 0; k < 3; k += 1) addPlane(tri[t * 3 + k]!, a, b, c, d, 1);
  }

  // Locked: seam vertices, and vertices on a border edge (an edge with one triangle).
  const locked = new Uint8Array(vertexCount);
  const edgeUses = new Map<string, number>();
  const edgeKey = (a: number, b: number) => (pointOf[a]! < pointOf[b]! ? `${pointOf[a]},${pointOf[b]}` : `${pointOf[b]},${pointOf[a]}`);
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(tri[t * 3 + k]!, tri[t * 3 + ((k + 1) % 3)]!);
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = tri[t * 3 + k]!, b = tri[t * 3 + ((k + 1) % 3)]!;
      if (edgeUses.get(edgeKey(a, b)) !== 2) {
        locked[a] = 1;
        locked[b] = 1;
      }
    }
  }
  if (lockSeams) for (let v = 0; v < vertexCount; v += 1) if (pointVerts[pointOf[v]!]! > 1) locked[v] = 1;
  // A part already as plain as a box (12 triangles or fewer) has nothing to give: hold it whole.
  const up = Int32Array.from({ length: points.size }, (_, i) => i);
  const find = (i: number): number => {
    while (up[i] !== i) {
      up[i] = up[up[i]!]!;
      i = up[i]!;
    }
    return i;
  };
  for (let t = 0; t < triCount; t += 1) {
    const a = find(pointOf[tri[t * 3]!]!);
    for (let k = 1; k < 3; k += 1) {
      const b = find(pointOf[tri[t * 3 + k]!]!);
      if (a !== b) up[b] = a;
    }
  }
  const partTris = new Int32Array(points.size);
  for (let t = 0; t < triCount; t += 1) partTris[find(pointOf[tri[t * 3]!]!)]! += 1;
  for (let v = 0; v < vertexCount; v += 1) if (partTris[find(pointOf[v]!)]! <= 12) locked[v] = 1;

  const costAt = (u: number, v: number): number => {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!;
    let e = 0;
    for (const s of [u, v]) {
      const q = s * 10;
      e += Q[q]! * x * x + 2 * Q[q + 1]! * x * y + 2 * Q[q + 2]! * x * z + 2 * Q[q + 3]! * x
        + Q[q + 4]! * y * y + 2 * Q[q + 5]! * y * z + 2 * Q[q + 6]! * y
        + Q[q + 7]! * z * z + 2 * Q[q + 8]! * z + Q[q + 9]!;
    }
    return Math.max(0, e);
  };
  const stamp = new Uint32Array(vertexCount);
  const heap = new Heap();
  const pushAround = (u: number) => {
    if (locked[u]) return;
    const seen = new Set<number>();
    for (const t of around[u]!) {
      if (!alive[t]) continue;
      for (let k = 0; k < 3; k += 1) {
        const v = tri[t * 3 + k]!;
        if (v === u || seen.has(v)) continue;
        seen.add(v);
        heap.push({ cost: costAt(u, v), u, v, stamp: stamp[u]! });
      }
    }
  };
  for (let u = 0; u < vertexCount; u += 1) pushAround(u);

  let live = triCount;
  const removed = new Uint8Array(vertexCount);
  while (live > target && heap.size > 0) {
    const c = heap.pop()!;
    const { u, v } = c;
    if (removed[u] || removed[v] || c.stamp !== stamp[u]) continue;
    if (c.cost > maxError) break; // everything left would show
    // Still neighbours?
    const shared = around[u]!.filter((t) => alive[t] && (tri[t * 3] === v || tri[t * 3 + 1] === v || tri[t * 3 + 2] === v));
    if (shared.length === 0) continue;
    // Refuse a collapse that flips (or squashes flat) a triangle that keeps going.
    let ok = true;
    for (const t of around[u]!) {
      if (!alive[t] || shared.includes(t)) continue;
      const [ax, ay, az, al] = faceNormal(t);
      const save = [tri[t * 3]!, tri[t * 3 + 1]!, tri[t * 3 + 2]!];
      for (let k = 0; k < 3; k += 1) if (tri[t * 3 + k] === u) tri[t * 3 + k] = v;
      const [bx, by, bz, bl] = faceNormal(t);
      tri[t * 3] = save[0]!;
      tri[t * 3 + 1] = save[1]!;
      tri[t * 3 + 2] = save[2]!;
      if (bl < al * 1e-3 || ax * bx + ay * by + az * bz < 0.3 * al * bl) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Collapse: the shared triangles go, the rest move u's corner to v.
    for (const t of shared) {
      alive[t] = 0;
      live -= 1;
    }
    for (const t of around[u]!) {
      if (!alive[t]) continue;
      for (let k = 0; k < 3; k += 1) if (tri[t * 3 + k] === u) tri[t * 3 + k] = v;
      around[v]!.push(t);
    }
    around[u] = [];
    removed[u] = 1;
    for (let k = 0; k < 10; k += 1) Q[v * 10 + k] = Q[v * 10 + k]! + Q[u * 10 + k]!;
    // v's neighbourhood changed: refresh the candidates out of it and its neighbours.
    stamp[v] = stamp[v]! + 1;
    pushAround(v);
    const neighbours = new Set<number>();
    for (const t of around[v]!) if (alive[t]) for (let k = 0; k < 3; k += 1) neighbours.add(tri[t * 3 + k]!);
    for (const n of neighbours) {
      if (n === v || removed[n]) continue;
      stamp[n] = stamp[n]! + 1;
      pushAround(n);
    }
  }

  const out = new Uint32Array(live * 3);
  let o = 0;
  for (let t = 0; t < triCount; t += 1) {
    if (!alive[t]) continue;
    out[o++] = tri[t * 3]!;
    out[o++] = tri[t * 3 + 1]!;
    out[o++] = tri[t * 3 + 2]!;
  }
  return out;
}

/** Whether a primitive can be simplified across its creases (see {@link simplifyIndices}): it has normals and nothing a UV seam would tear. */
function canWeld(p: MeshPrimitive): boolean {
  if (!p.normals || p.uvs2 || p.blend) return false;
  return !Object.entries(p.material).some(([key, value]) => key.endsWith("Image") && value);
}

/**
 * A simplified copy of a mesh at about `ratio` of its triangles: the same vertex
 * arrays, new triangle lists. A primitive whose seams hold it still (a
 * hard-edged, faceted one) is simplified across its creases where it can be.
 */
export function simplifyMesh(mesh: MeshAsset, ratio: number, maxError = Infinity): MeshAsset {
  return {
    ...mesh,
    primitives: mesh.primitives.map((p) => {
      let indices = simplifyIndices(p.positions, p.indices, ratio, null, maxError);
      if (indices.length > p.indices.length * Math.min(1, ratio + 0.2) && canWeld(p)) {
        indices = simplifyIndices(p.positions, p.indices, ratio, { normals: p.normals!, joints: p.joints ?? null }, maxError);
      }
      return { ...p, indices };
    }),
  };
}

/**
 * A copy of a mesh without its small parts: each primitive's connected pieces
 * (triangles joined through shared points) whose box diagonal is under
 * `fraction` of the whole mesh's are left out. Vertex arrays are shared.
 */
export function pruneSmallParts(mesh: MeshAsset, fraction: number): MeshAsset {
  const limit = meshRadius(mesh) * 2 * fraction;
  if (!(limit > 0)) return mesh;
  return {
    ...mesh,
    primitives: mesh.primitives.map((p) => {
      const pos = p.positions;
      const vertices = pos.length / 3;
      // Weld by position, then join each triangle's corners.
      const weld = new Int32Array(vertices);
      const seen = new Map<string, number>();
      for (let v = 0; v < vertices; v += 1) {
        const key = `${pos[v * 3]},${pos[v * 3 + 1]},${pos[v * 3 + 2]}`;
        const at = seen.get(key);
        if (at === undefined) seen.set(key, v);
        weld[v] = at ?? v;
      }
      const up = Int32Array.from({ length: vertices }, (_, v) => v);
      const find = (v: number): number => {
        while (up[v] !== v) {
          up[v] = up[up[v]!]!;
          v = up[v]!;
        }
        return v;
      };
      const join = (a: number, b: number) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) up[ra] = rb;
      };
      const tri = p.indices;
      for (let t = 0; t < tri.length; t += 3) {
        join(weld[tri[t]!]!, weld[tri[t + 1]!]!);
        join(weld[tri[t]!]!, weld[tri[t + 2]!]!);
      }
      // Each piece's box.
      const box = new Map<number, number[]>();
      for (let k = 0; k < tri.length; k += 1) {
        const v = tri[k]!;
        const r = find(weld[v]!);
        let b = box.get(r);
        if (!b) box.set(r, (b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]));
        for (let a = 0; a < 3; a += 1) {
          b[a] = Math.min(b[a]!, pos[v * 3 + a]!);
          b[a + 3] = Math.max(b[a + 3]!, pos[v * 3 + a]!);
        }
      }
      const keep = new Set<number>();
      for (const [r, b] of box) if (Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) >= limit) keep.add(r);
      if (keep.size === box.size) return p;
      const out: number[] = [];
      for (let t = 0; t < tri.length; t += 3) if (keep.has(find(weld[tri[t]!]!))) out.push(tri[t]!, tri[t + 1]!, tri[t + 2]!);
      return { ...p, indices: Uint32Array.from(out) };
    }),
  };
}

/** The triangles in a mesh. */
export function triangleCountOf(mesh: MeshAsset): number {
  return mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
}

/** A mesh's radius about its bounding box's centre (the scale LOD distances are set from). */
function meshRadius(mesh: MeshAsset): number {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of mesh.primitives) {
    for (let i = 0; i < p.positions.length; i += 3) {
      x0 = Math.min(x0, p.positions[i]!); x1 = Math.max(x1, p.positions[i]!);
      y0 = Math.min(y0, p.positions[i + 1]!); y1 = Math.max(y1, p.positions[i + 1]!);
      z0 = Math.min(z0, p.positions[i + 2]!); z1 = Math.max(z1, p.positions[i + 2]!);
    }
  }
  return Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 : 1;
}

/**
 * A stored LOD chain: the switch distances, each level's triangle lists (see
 * {@link encodeLodLevel}), and a fingerprint of the mesh they were made from,
 * so levels left over from older geometry are refused rather than drawn wrong.
 */
export interface StoredLods {
  readonly distances: readonly number[];
  readonly levels: readonly string[];
  readonly base?: string;
}

/** A mesh's geometry fingerprint: FNV-1a over every primitive's positions and indices. */
export function meshFingerprint(mesh: MeshAsset): string {
  let h = 0x811c9dc5;
  const mix = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i += 1) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  };
  for (const p of mesh.primitives) {
    mix(new Uint8Array(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength));
    mix(new Uint8Array(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength));
  }
  return `${mesh.primitives.length}:${(h >>> 0).toString(16)}`;
}

/** Meshes smaller than this many triangles get no LODs (they're already cheap). */
export const LOD_MIN_TRIANGLES = 64;

/**
 * The default levels: the share of triangles each aims for, the most it may
 * move the surface (a share of the mesh's radius), the parts it drops (a share
 * of the mesh's size), and the switch distance in mesh radii.
 */
export const LOD_LEVELS: readonly { readonly ratio: number; readonly error: number; readonly prune: number; readonly radii: number }[] = [
  { ratio: 0.5, error: 0.035, prune: 0.06, radii: 12 },
  { ratio: 0.25, error: 0.09, prune: 0.1, radii: 30 },
];

/**
 * Generate a mesh's LOD chain: levels at about half and a quarter of its
 * triangles (simplified, small parts dropped), switched to at 12 and 30 times
 * its radius. Null when the mesh is small or no level saves enough to matter.
 */
export function generateLods(mesh: MeshAsset, levels = LOD_LEVELS): { meshes: MeshAsset[]; distances: number[] } | null {
  const tris = triangleCountOf(mesh);
  if (tris < LOD_MIN_TRIANGLES) return null;
  const radius = meshRadius(mesh);
  const meshes: MeshAsset[] = [];
  const distances: number[] = [];
  let last = tris;
  for (const { ratio, error, prune, radii } of levels) {
    // A vertex's quadric sums several planes: allow the error at about three of them.
    const level = pruneSmallParts(simplifyMesh(mesh, ratio, 3 * (error * radius) ** 2), prune);
    const n = triangleCountOf(level);
    if (n === 0 || n >= last * 0.9) break; // no real saving (or nothing left): stop here
    meshes.push(level);
    distances.push(radius * radii);
    last = n;
  }
  return meshes.length > 0 ? { meshes, distances } : null;
}

/** Set on a stored level's first word when its indices are 16-bit (every primitive under 65,536 vertices). */
const NARROW = 0x80000000;

/**
 * One level as stored: base64 of [primitive count, each primitive's index
 * count] as 32-bit words, then every index — 16-bit when every primitive has
 * under 65,536 vertices (flagged in the first word), else 32-bit.
 */
export function encodeLodLevel(level: MeshAsset): string {
  const total = level.primitives.reduce((n, p) => n + p.indices.length, 0);
  const narrow = level.primitives.every((p) => p.positions.length / 3 <= 0x10000);
  const head = 4 * (1 + level.primitives.length);
  const bytes = new Uint8Array(head + total * (narrow ? 2 : 4));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, (level.primitives.length | (narrow ? NARROW : 0)) >>> 0, true);
  let o = head;
  level.primitives.forEach((p, i) => {
    view.setUint32(4 + i * 4, p.indices.length, true);
    for (const index of p.indices) {
      if (narrow) view.setUint16(o, index, true);
      else view.setUint32(o, index, true);
      o += narrow ? 2 : 4;
    }
  });
  return bytesToBase64(bytes);
}

/**
 * A stored level over its base mesh: the base's primitives with the level's
 * triangle lists (vertex arrays shared). Null when it doesn't fit the base —
 * a different primitive count, or an index past a primitive's vertices.
 */
export function decodeLodLevel(base: MeshAsset, stored: string): MeshAsset | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(stored);
  } catch {
    return null;
  }
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = view.getUint32(0, true);
  const narrow = (first & NARROW) !== 0;
  const count = first & ~NARROW;
  if (count !== base.primitives.length) return null;
  const size = narrow ? 2 : 4;
  let o = 4 * (1 + count);
  if (o > bytes.length) return null;
  const primitives: MeshPrimitive[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = view.getUint32(4 + i * 4, true);
    if (n % 3 !== 0 || o + n * size > bytes.length) return null;
    const vertices = base.primitives[i]!.positions.length / 3;
    const indices = new Uint32Array(n);
    for (let k = 0; k < n; k += 1) {
      const index = narrow ? view.getUint16(o + k * 2, true) : view.getUint32(o + k * 4, true);
      if (index >= vertices) return null;
      indices[k] = index;
    }
    primitives.push({ ...base.primitives[i]!, indices });
    o += n * size;
  }
  return o === bytes.length ? { ...base, primitives } : null;
}

/** Store a chain generated from `base` (its levels only: `base` itself isn't stored again). */
export function encodeLods(base: MeshAsset, chain: { meshes: readonly MeshAsset[]; distances: readonly number[] }): StoredLods {
  return { distances: [...chain.distances], levels: chain.meshes.map(encodeLodLevel), base: meshFingerprint(base) };
}

/**
 * Read a stored chain's shape (ascending positive distances, one per level, each
 * level a string), resolving each level through `resolve` (a library lookup), or
 * null when it's malformed. Whether the levels fit a mesh is {@link decodeLods}'s job.
 */
export function readStoredLods(stored: unknown, resolve: (level: string) => string | null = (s) => s): StoredLods | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Partial<StoredLods>;
  if (!Array.isArray(s.distances) || !Array.isArray(s.levels) || s.levels.length === 0 || s.distances.length !== s.levels.length) return null;
  if (!s.distances.every((d, i) => typeof d === "number" && Number.isFinite(d) && d > 0 && (i === 0 || d > s.distances![i - 1]!))) return null;
  const levels: string[] = [];
  for (const level of s.levels) {
    const text = typeof level === "string" ? resolve(level) : null;
    if (!text) return null;
    levels.push(text);
  }
  return { distances: [...s.distances], levels, ...(typeof s.base === "string" ? { base: s.base } : {}) };
}

/** Read a stored chain over its base mesh, or null when it's malformed or doesn't fit. */
export function decodeLods(base: MeshAsset, stored: unknown, resolve: (level: string) => string | null = (s) => s): { meshes: MeshAsset[]; distances: number[] } | null {
  const read = readStoredLods(stored, resolve);
  if (!read || (read.base !== undefined && read.base !== meshFingerprint(base))) return null;
  const meshes: MeshAsset[] = [];
  for (const level of read.levels) {
    const mesh = decodeLodLevel(base, level);
    if (!mesh) return null;
    meshes.push(mesh);
  }
  return { meshes, distances: [...read.distances] };
}

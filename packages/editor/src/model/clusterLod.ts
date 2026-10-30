/**
 * Cluster LODs (AAA_FIDELITY_ROADMAP.md F6a): a dense mesh as a hierarchy of
 * 128-triangle clusters, coarser at each level, so the renderer draws each
 * part of it at the detail its size on screen needs, with no hand-made LODs
 * and no cracks between parts drawn at different levels.
 *
 * - **Level 0** is the mesh itself, clustered (buildClusters, F9c).
 * - **Each level above** groups the clusters below it by the edges they share,
 *   about four to a group. A group's triangles are simplified to half on their
 *   own, their outline held still (simplifyPatch), and split into new clusters.
 *   Since the outline holds, a group drawn coarse still meets its neighbours
 *   drawn fine.
 * - **Errors only grow upwards.** A group's error is how far its simplified
 *   surface strays from the original vertices it replaced, and at least its
 *   clusters' own. The sphere it is measured from holds its clusters' spheres.
 *   Its clusters record it as their parent's, the clusters made from it as
 *   their own.
 * - **Choosing a cut** ({@link clusterVisible}): a cluster is drawn when its
 *   own error is too small to see and its parent's is not. Every cluster of a
 *   group, and every cluster made from it, decides by the same numbers, so a
 *   group is either drawn whole or replaced whole.
 *
 * The levels share the mesh's vertices (the simplifier only collapses edges
 * onto vertices that stay), so a cluster mesh costs only its extra indices.
 */

import { buildClusters, CLUSTER_TRIANGLES } from "./scanImport";
import { simplifyPatch } from "./meshSimplify";
import type { MeshAsset, MeshPrimitive } from "./MeshAsset";

type V3 = [number, number, number];

/** One cluster of the hierarchy. */
export interface LodCluster {
  /** Its triangles: a run of {@link ClusterLod.indices}. */
  readonly firstTriangle: number;
  readonly triangles: number;
  /** Its triangles' bounding sphere and normal cone (for culling). */
  readonly center: V3;
  readonly radius: number;
  readonly axis: V3;
  readonly cutoff: number;
  /** The level it was made at (0: the mesh's own triangles). */
  readonly level: number;
  /** Its error and the sphere it is seen from: the group it was made from (0 and its own bounds at level 0). */
  readonly error: number;
  readonly lodCenter: V3;
  readonly lodRadius: number;
  /** Its parent's: the group it was simplified in (Infinity at the top). */
  readonly parentError: number;
  readonly parentCenter: V3;
  readonly parentRadius: number;
}

export interface ClusterLod {
  /** Every cluster's triangles, a run each, indexing the primitive's vertices. */
  readonly indices: Uint32Array;
  readonly clusters: readonly LodCluster[];
  readonly levels: number;
  /**
   * The mesh is closed (every edge has two triangles): its back faces are
   * always behind its front ones, so a cluster facing wholly away can be
   * dropped. The renderer draws both faces, so an open mesh keeps them.
   */
  readonly closed: boolean;
}

/** Clusters a group, at most. */
export const CLUSTER_GROUP = 8;
/** A group grows until it holds about this many triangles (four full clusters): small clusters group more to a group. */
const GROUP_TRIANGLES = 4 * CLUSTER_TRIANGLES;
/** A group that keeps more than this share of its triangles when simplified has nothing more to give: its clusters stay at the top. */
const STUCK = 0.85;
/** How much more an edge between clusters of different origins counts towards grouping them. */
const ACROSS = 8;

interface Working {
  tris: Uint32Array;
  /** The group it was made from (−1 at level 0): its siblings share it. */
  origin: number;
  center: V3;
  radius: number;
  axis: V3;
  cutoff: number;
  level: number;
  error: number;
  lodCenter: V3;
  lodRadius: number;
  parentError: number;
  parentCenter: V3;
  parentRadius: number;
}

/** Split `indices` into clusters of up to 128, each a working cluster at `level` seen from the given error and sphere (or its own bounds). */
function clustersOf(positions: Float32Array, indices: Uint32Array, level: number, error: number, lod: { center: V3; radius: number } | null, origin = -1): Working[] {
  const { indices: ordered, clusters } = buildClusters({ positions, indices }, CLUSTER_TRIANGLES);
  return clusters.map((c) => ({
    tris: ordered.slice(c.firstTriangle * 3, (c.firstTriangle + c.triangles) * 3),
    origin,
    center: [...c.center] as V3,
    radius: c.radius,
    axis: [...c.axis] as V3,
    cutoff: c.cutoff,
    level,
    error,
    lodCenter: lod ? lod.center : ([...c.center] as V3),
    lodRadius: lod ? lod.radius : c.radius,
    parentError: Infinity,
    parentCenter: [0, 0, 0],
    parentRadius: 0,
  }));
}

/**
 * Groups of up to {@link CLUSTER_GROUP} clusters, each grown from the first
 * ungrouped one by the neighbour sharing the most edges with it, an edge
 * between clusters made from different groups counting {@link ACROSS} times:
 * those edges are the last level's outlines, which stayed put, and inside a
 * group they can give at last. Grouped by plain adjacency, siblings would
 * group again and the outlines would never move.
 */
function groupClusters(clusters: readonly Working[]): number[][] {
  const owner = new Map<string, number[]>();
  clusters.forEach((c, k) => {
    for (let t = 0; t < c.tris.length; t += 3) {
      for (let e = 0; e < 3; e += 1) {
        const a = c.tris[t + e]!, b = c.tris[t + ((e + 1) % 3)]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const list = owner.get(key);
        if (!list) owner.set(key, [k]);
        else if (!list.includes(k)) list.push(k);
      }
    }
  });
  const shared = clusters.map(() => new Map<number, number>());
  for (const list of owner.values()) {
    for (const a of list)
      for (const b of list) {
        if (a === b) continue;
        const weight = clusters[a]!.origin !== clusters[b]!.origin || clusters[a]!.origin < 0 ? ACROSS : 1;
        shared[a]!.set(b, (shared[a]!.get(b) ?? 0) + weight);
      }
  }
  const grouped = new Int32Array(clusters.length).fill(-1);
  const groups: number[][] = [];
  const size = (group: readonly number[]) => group.reduce((n, k) => n + clusters[k]!.tris.length / 3, 0);
  for (let seed = 0; seed < clusters.length; seed += 1) {
    if (grouped[seed]! >= 0) continue;
    const group = [seed];
    grouped[seed] = groups.length;
    while (group.length < CLUSTER_GROUP && size(group) < GROUP_TRIANGLES) {
      let best = -1;
      let most = 0;
      for (const member of group) {
        for (const [n, count] of shared[member]!) {
          if (grouped[n]! >= 0) continue;
          if (count > most) {
            most = count;
            best = n;
          }
        }
      }
      if (best < 0) break;
      grouped[best] = groups.length;
      group.push(best);
    }
    groups.push(group);
  }
  // A lone cluster (its neighbours all taken) can't simplify on its own: it joins the neighbouring group it shares most with.
  groups.forEach((group, g) => {
    if (group.length !== 1) return;
    let best = -1;
    let most = 0;
    for (const [n, count] of shared[group[0]!]!) {
      const h = grouped[n]!;
      if (h === g || groups[h]!.length === 0 || groups[h]!.length >= CLUSTER_GROUP * 2) continue;
      if (count > most) {
        most = count;
        best = h;
      }
    }
    if (best < 0) return;
    groups[best]!.push(group[0]!);
    grouped[group[0]!] = best;
    group.length = 0;
  });
  return groups.filter((g) => g.length > 0);
}

/** The smallest-ish sphere holding the given spheres (Ritter's, from their extremes). */
function enclosing(spheres: readonly { center: V3; radius: number }[]): { center: V3; radius: number } {
  let c: V3 = [...spheres[0]!.center] as V3;
  let r = spheres[0]!.radius;
  for (const s of spheres.slice(1)) {
    const d = Math.hypot(s.center[0] - c[0], s.center[1] - c[1], s.center[2] - c[2]);
    if (d + s.radius <= r) continue;
    if (d + r <= s.radius) {
      c = [...s.center] as V3;
      r = s.radius;
      continue;
    }
    const nr = (d + r + s.radius) / 2;
    const t = (nr - r) / d;
    c = [c[0] + (s.center[0] - c[0]) * t, c[1] + (s.center[1] - c[1]) * t, c[2] + (s.center[2] - c[2]) * t];
    r = nr;
  }
  return { center: c, radius: r };
}

/** The distance from p to the triangle abc. */
function pointTriangle(p: V3, a: V3, b: V3, c: V3): number {
  const sub = (u: V3, v: V3): V3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** How far the simplified triangles stray from the vertices they replaced: the farthest of those from the nearest of them. */
function deviation(positions: Float32Array, original: Uint32Array, simplified: Uint32Array): number {
  const vertex = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const kept = new Set(simplified);
  const tris: [V3, V3, V3][] = [];
  for (let t = 0; t < simplified.length; t += 3) tris.push([vertex(simplified[t]!), vertex(simplified[t + 1]!), vertex(simplified[t + 2]!)]);
  let worst = 0;
  for (const v of new Set(original)) {
    if (kept.has(v)) continue;
    const p = vertex(v);
    let nearest = Infinity;
    for (const [a, b, c] of tris) nearest = Math.min(nearest, pointTriangle(p, a, b, c));
    worst = Math.max(worst, nearest);
  }
  return worst;
}

/** Build a primitive's cluster hierarchy (see the module's comment). */
export function buildClusterLod(primitive: Pick<MeshPrimitive, "positions" | "indices">, maxLevels = 16): ClusterLod {
  const positions = primitive.positions;
  const done: Working[] = [];
  let current = clustersOf(positions, primitive.indices, 0, 0, null);
  let level = 0;
  while (current.length > 1 && level < maxLevels) {
    const next: Working[] = [];
    let groupIndex = 0;
    for (const group of groupClusters(current)) {
      groupIndex += 1;
      const members = group.map((k) => current[k]!);
      const merged = new Uint32Array(members.reduce((n, c) => n + c.tris.length, 0));
      let o = 0;
      for (const c of members) {
        merged.set(c.tris, o);
        o += c.tris.length;
      }
      const simplified = members.length > 1 ? simplifyPatch(positions, merged, 0.5) : merged;
      if (simplified.length > merged.length * STUCK) continue; // nothing more to give: these stay at the top
      // Errors grow upwards, and the sphere they're seen from holds the ones below.
      const childWorst = Math.max(...members.map((c) => c.error));
      const error = Math.max(deviation(positions, merged, simplified), childWorst * (1 + 1e-6) + 1e-9);
      const sphere = enclosing(members.map((c) => ({ center: c.lodCenter, radius: c.lodRadius })));
      for (const c of members) {
        c.parentError = error;
        c.parentCenter = sphere.center;
        c.parentRadius = sphere.radius;
      }
      next.push(...clustersOf(positions, simplified, level + 1, error, sphere, groupIndex));
    }
    done.push(...current);
    if (next.length === 0) {
      current = [];
      break;
    }
    current = next;
    level += 1;
  }
  done.push(...current);
  const indices = new Uint32Array(done.reduce((n, c) => n + c.tris.length, 0));
  const clusters: LodCluster[] = [];
  let at = 0;
  for (const c of done) {
    indices.set(c.tris, at * 3);
    clusters.push({
      firstTriangle: at,
      triangles: c.tris.length / 3,
      center: c.center,
      radius: c.radius,
      axis: c.axis,
      cutoff: c.cutoff,
      level: c.level,
      error: c.error,
      lodCenter: c.lodCenter,
      lodRadius: c.lodRadius,
      parentError: c.parentError,
      parentCenter: c.parentCenter,
      parentRadius: c.parentRadius,
    });
    at += c.tris.length / 3;
  }
  return { indices, clusters, levels: Math.max(...clusters.map((c) => c.level)) + 1, closed: isClosed(primitive.indices) };
}

/** Whether every edge of the triangles is used by exactly two of them. */
function isClosed(indices: Uint32Array): boolean {
  const count = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e += 1) {
      const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  for (const n of count.values()) if (n !== 2) return false;
  return count.size > 0;
}

/**
 * An error as seen: its size in pixels from `eye`, for a sphere it is measured
 * from (the distance to the sphere's near side, never under `near`), with
 * `pixelsPerRadian` the projection's (its y scale × half the height in pixels).
 */
export function projectedError(error: number, center: readonly number[], radius: number, eye: readonly number[], pixelsPerRadian: number, near = 1e-3): number {
  if (!Number.isFinite(error)) return Infinity;
  const d = Math.hypot(center[0]! - eye[0]!, center[1]! - eye[1]!, center[2]! - eye[2]!) - radius;
  return (error * pixelsPerRadian) / Math.max(d, near);
}

/** Whether a cluster is in the cut for an eye: its own error too small to see (under `threshold` pixels), its parent's not. */
export function clusterVisible(c: LodCluster, eye: readonly number[], pixelsPerRadian: number, threshold = 1): boolean {
  return projectedError(c.error, c.lodCenter, c.lodRadius, eye, pixelsPerRadian) <= threshold && projectedError(c.parentError, c.parentCenter, c.parentRadius, eye, pixelsPerRadian) > threshold;
}

/** Floats a cluster takes on the GPU (see {@link packClusterLod}). */
export const LOD_CLUSTER_FLOATS = 20;

/**
 * The clusters as the GPU reads them, 20 floats (five vec4s) each: the first
 * triangle and count (as u32s), its error and its parent's; its bounds; its
 * cone; the sphere its error is seen from; its parent's.
 */
export function packClusterLod(lod: ClusterLod): ArrayBuffer {
  const out = new ArrayBuffer(lod.clusters.length * LOD_CLUSTER_FLOATS * 4);
  const f = new Float32Array(out);
  const u = new Uint32Array(out);
  lod.clusters.forEach((c, k) => {
    const o = k * LOD_CLUSTER_FLOATS;
    u[o] = c.firstTriangle;
    u[o + 1] = c.triangles;
    f[o + 2] = c.error;
    f[o + 3] = Number.isFinite(c.parentError) ? c.parentError : 3.4e38;
    f.set([...c.center, c.radius], o + 4);
    f.set([...c.axis, c.cutoff], o + 8);
    f.set([...c.lodCenter, c.lodRadius], o + 12);
    f.set([...c.parentCenter, c.parentRadius], o + 16);
  });
  return out;
}

/** Triangles a primitive needs before an import builds it a hierarchy: below this, its own LOD chain does as well. */
export const DENSE_TRIANGLES = 20_000;

/**
 * A mesh with a cluster hierarchy on every dense primitive whose vertices stay
 * where they are (not skinned, morphed or cloth): film-quality meshes are
 * placed as they come, with no hand-made LODs (F6a). The same mesh when none
 * qualifies.
 */
export function withClusterLods(mesh: MeshAsset): MeshAsset {
  let changed = false;
  const primitives = mesh.primitives.map((p) => {
    const moves = (p.joints && p.weights) || (p.morphTargets?.length ?? 0) > 0 || p.cloth !== undefined;
    if (p.clusterLod || moves || p.indices.length / 3 < DENSE_TRIANGLES) return p;
    changed = true;
    return { ...p, clusterLod: buildClusterLod(p) };
  });
  return changed ? { ...mesh, primitives } : mesh;
}

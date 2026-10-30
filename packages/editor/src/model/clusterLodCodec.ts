/**
 * A cluster hierarchy (clusterLod.ts, AAA_FIDELITY_ROADMAP.md F6a) as it is
 * stored with its mesh: its indices, and each cluster as the five vec4s the
 * GPU reads (packClusterLod), both base64. Kept apart from the builder so the
 * mesh format reads it without loading the simplifier.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";
import type { ClusterLod, LodCluster } from "./clusterLod";

/** Floats a stored cluster takes: as the GPU reads it. */
const FLOATS = 20;

export interface SerializedClusterLod {
  readonly indices: string;
  readonly clusters: string;
  readonly closed: boolean;
}

/** A hierarchy, stored. */
export function writeClusterLod(lod: ClusterLod): SerializedClusterLod {
  const packed = new ArrayBuffer(lod.clusters.length * FLOATS * 4);
  const f = new Float32Array(packed);
  const u = new Uint32Array(packed);
  lod.clusters.forEach((c, k) => {
    const o = k * FLOATS;
    u[o] = c.firstTriangle;
    u[o + 1] = c.triangles;
    f[o + 2] = c.error;
    f[o + 3] = Number.isFinite(c.parentError) ? c.parentError : Infinity;
    f.set([...c.center, c.radius], o + 4);
    f.set([...c.axis, c.cutoff], o + 8);
    f.set([...c.lodCenter, c.lodRadius], o + 12);
    f.set([...c.parentCenter, c.parentRadius], o + 16);
  });
  return { indices: bytesToBase64(new Uint8Array(lod.indices.buffer, lod.indices.byteOffset, lod.indices.byteLength)), clusters: bytesToBase64(new Uint8Array(packed)), closed: lod.closed };
}

/**
 * A stored hierarchy back, for a primitive of `vertexCount` vertices, or
 * undefined when absent or malformed (a mesh loads without it: it is drawn as
 * its own triangles).
 */
export function readClusterLod(raw: unknown, vertexCount: number): ClusterLod | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<SerializedClusterLod>;
  if (typeof r.indices !== "string" || typeof r.clusters !== "string") return undefined;
  const ib = base64ToBytes(r.indices);
  const cb = base64ToBytes(r.clusters);
  if (ib.length % 12 !== 0 || cb.length % (FLOATS * 4) !== 0 || cb.length === 0) return undefined;
  const indices = new Uint32Array(ib.slice().buffer);
  if (!indices.every((i) => i < vertexCount)) return undefined;
  const f = new Float32Array(cb.slice().buffer);
  const u = new Uint32Array(f.buffer);
  const triangles = indices.length / 3;
  const clusters: LodCluster[] = [];
  for (let k = 0; k < f.length / FLOATS; k += 1) {
    const o = k * FLOATS;
    const first = u[o]!, count = u[o + 1]!;
    if (count === 0 || count > 128 || first + count > triangles) return undefined;
    const v3 = (at: number): [number, number, number] => [f[o + at]!, f[o + at + 1]!, f[o + at + 2]!];
    clusters.push({
      firstTriangle: first,
      triangles: count,
      error: f[o + 2]!,
      parentError: f[o + 3]!,
      center: v3(4),
      radius: f[o + 7]!,
      axis: v3(8),
      cutoff: f[o + 11]!,
      lodCenter: v3(12),
      lodRadius: f[o + 15]!,
      parentCenter: v3(16),
      parentRadius: f[o + 19]!,
      level: 0,
    });
  }
  // The levels, found again: a cluster's level is one more than the deepest whose parent error is its own.
  const byError = new Map<number, number>();
  const sorted = [...clusters].sort((a, b) => a.error - b.error);
  for (const c of sorted) {
    const level = c.error === 0 ? 0 : (byError.get(c.error) ?? 0);
    (c as { level: number }).level = level;
    if (Number.isFinite(c.parentError)) byError.set(c.parentError, Math.max(byError.get(c.parentError) ?? 0, level + 1));
  }
  return { indices, clusters, levels: Math.max(...clusters.map((c) => c.level)) + 1, closed: r.closed === true };
}

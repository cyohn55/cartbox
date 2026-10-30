/**
 * Cluster LODs (AAA_FIDELITY_ROADMAP.md F6a): a dense mesh's cluster
 * hierarchy, and the cut an eye chooses through it. On a closed surface (an
 * icosphere), any cut must itself be closed: an edge left with one triangle
 * would be a crack.
 */

import { describe, expect, it } from "vitest";

import { buildClusterLod, clusterVisible, deserializeMeshAsset, packClusterLod, serializeMeshAsset, withClusterLods, DENSE_TRIANGLES, LOD_CLUSTER_FLOATS, type ClusterLod, type MeshAsset } from "@cartbox/editor";

/** An icosphere of radius 1, subdivided `n` times: closed, every vertex shared. */
function icosphere(n: number): { positions: Float32Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => {
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < n; s += 1) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const v = [0, 1, 2].map((k) => (verts[a]![k]! + verts[b]![k]!) / 2);
        const l = Math.hypot(...v);
        m = verts.length;
        verts.push(v.map((x) => x / l));
        cache.set(key, m);
      }
      return m;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a!, b!), bc = mid(b!, c!), ca = mid(c!, a!);
      return [[a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]];
    });
  }
  return { positions: Float32Array.from(verts.flat()), indices: Uint32Array.from(faces.flat()) };
}

/** The cut's triangles for an eye at `distance` on +z, `pixels` a radian. */
function cut(lod: ClusterLod, distance: number, pixels = 1000): number[][] {
  const out: number[][] = [];
  for (const c of lod.clusters) {
    if (!clusterVisible(c, [0, 0, distance], pixels)) continue;
    for (let t = c.firstTriangle; t < c.firstTriangle + c.triangles; t += 1) out.push([lod.indices[t * 3]!, lod.indices[t * 3 + 1]!, lod.indices[t * 3 + 2]!]);
  }
  return out;
}

/** Edges used by exactly one triangle (none, on a closed surface). */
function openEdges(tris: number[][]): number {
  const count = new Map<string, number>();
  for (const t of tris) for (let e = 0; e < 3; e += 1) {
    const a = t[e]!, b = t[(e + 1) % 3]!;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count.values()].filter((n) => n === 1).length;
}

describe("cluster LODs", { timeout: 120_000 }, () => {
  const sphere = icosphere(5); // 20 480 triangles
  const lod = buildClusterLod(sphere);

  it("builds levels of clusters of at most 128 triangles over the mesh's own vertices", () => {
    expect(lod.levels).toBeGreaterThan(3);
    expect(lod.clusters.every((c) => c.triangles > 0 && c.triangles <= 128)).toBe(true);
    const vertexCount = sphere.positions.length / 3;
    expect(lod.indices.every((i) => i < vertexCount)).toBe(true);
    // Level 0 is the mesh's triangles, each once.
    const level0 = lod.clusters.filter((c) => c.level === 0).reduce((n, c) => n + c.triangles, 0);
    expect(level0).toBe(sphere.indices.length / 3);
  });

  it("only grows its errors, and the spheres they're seen from, upwards", () => {
    for (const c of lod.clusters) {
      expect(c.parentError).toBeGreaterThan(c.error);
      if (!Number.isFinite(c.parentError)) continue;
      const d = Math.hypot(c.parentCenter[0] - c.lodCenter[0], c.parentCenter[1] - c.lodCenter[1], c.parentCenter[2] - c.lodCenter[2]);
      expect(d + c.lodRadius).toBeLessThanOrEqual(c.parentRadius + 1e-5);
    }
  });

  it("chooses closed cuts, coarser with distance", () => {
    let last = Infinity;
    for (const distance of [1.5, 3, 6, 12, 25, 50, 100, 400]) {
      const tris = cut(lod, distance);
      expect(tris.length).toBeGreaterThan(0);
      expect(openEdges(tris)).toBe(0);
      expect(tris.length).toBeLessThanOrEqual(last);
      last = tris.length;
    }
    // Close up, the near side is all there; the far side, farther off, may already be coarser.
    expect(cut(lod, 1.5).length).toBeGreaterThan((sphere.indices.length / 3) * 0.7);
    // Seen as finely as anything can be: every triangle.
    expect(cut(lod, 1.5, 1e9).length).toBe(sphere.indices.length / 3);
    // Far off: a small share of them.
    expect(cut(lod, 400).length).toBeLessThan(sphere.indices.length / 3 / 8);
  });

  it("rides with its mesh through the mesh format, choosing the same cuts", () => {
    const mesh = { name: "ball", primitives: [{ positions: sphere.positions, normals: null, uvs: null, indices: sphere.indices, material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null }, clusterLod: lod }] } as unknown as MeshAsset;
    const back = deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.clusterLod!;
    expect(back.closed).toBe(true);
    expect(back.levels).toBe(lod.levels);
    expect(new Uint8Array(packClusterLod(back))).toEqual(new Uint8Array(packClusterLod(lod)));
    for (const distance of [3, 25, 400]) expect(cut(back, distance)).toEqual(cut(lod, distance));
    // A mesh without one has none.
    expect(deserializeMeshAsset(serializeMeshAsset({ ...mesh, primitives: [{ ...mesh.primitives[0]!, clusterLod: undefined }] })).primitives[0]!.clusterLod).toBeUndefined();
  });

  it("is built on import for a dense primitive whose vertices stay put", () => {
    const material = { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null };
    const dense = { positions: sphere.positions, normals: null, uvs: null, indices: sphere.indices, material };
    const small = { ...dense, indices: sphere.indices.slice(0, (DENSE_TRIANGLES - 1) * 3) };
    const skinned = { ...dense, joints: new Uint16Array((sphere.positions.length / 3) * 4), weights: new Float32Array((sphere.positions.length / 3) * 4) };
    const mesh = withClusterLods({ name: "m", primitives: [dense, small, skinned] } as unknown as MeshAsset);
    expect(mesh.primitives.map((p) => p.clusterLod !== undefined)).toEqual([true, false, false]);
    // Nothing to build: the same mesh.
    const plain = { name: "m", primitives: [small] } as unknown as MeshAsset;
    expect(withClusterLods(plain)).toBe(plain);
  });

  it("packs five vec4s a cluster for the GPU", () => {
    const packed = packClusterLod(lod);
    expect(packed.byteLength).toBe(lod.clusters.length * LOD_CLUSTER_FLOATS * 4);
    const u = new Uint32Array(packed);
    const f = new Float32Array(packed);
    const c = lod.clusters[7]!;
    expect([u[7 * 20], u[7 * 20 + 1]]).toEqual([c.firstTriangle, c.triangles]);
    expect(f[7 * 20 + 7]).toBeCloseTo(c.radius, 5);
  });
});

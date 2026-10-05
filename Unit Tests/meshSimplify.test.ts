/**
 * LOD generation (ENGINE_PARITY_ROADMAP.md EP9b): quadric-error half-edge
 * collapse that keeps the original vertices (so a level shares its base's
 * vertex arrays), holds borders and seams still, never flips a triangle, and
 * stores a level as just its indices.
 */

import { describe, expect, it } from "vitest";

import { decodeLodLevel, decodeLods, encodeLodLevel, encodeLods, generateLods, pruneSmallParts, simplifyMesh, triangleCountOf, type MeshAsset, type MeshPrimitive } from "@cartbox/editor";

/** A UV sphere: a seam where u wraps (duplicated vertices), poles. */
function sphere(segments = 32, rings = 16): MeshAsset {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const v = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const u = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u));
      uvs.push(s / segments, r / rings);
    }
  }
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
    }
  }
  return { name: "sphere", primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
}

/** A flat n×n grid of quads (a border all round). */
function grid(n = 20): MeshAsset {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= n; y += 1) for (let x = 0; x <= n; x += 1) positions.push(x, 0, y);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const a = y * (n + 1) + x;
      indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  }
  return { name: "grid", primitives: [{ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
}

/** Hard-edged (flat-shaded) pieces: each face its own vertices and normal, as Lockout's parts are made. */
function faceted(faces: number[][][]): MeshPrimitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const [a, b, c] = face as [number[], number[], number[]];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(...n);
    const first = positions.length / 3;
    for (const p of face) {
      positions.push(...p);
      normals.push(n[0]! / len, n[1]! / len, n[2]! / len);
    }
    for (let k = 1; k + 1 < face.length; k += 1) indices.push(first, first + k, first + k + 1);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } };
}

/** A capped n-sided prism (radius r, height h, centred at x), flat-shaded. */
function prismFaces(n: number, r: number, h: number, x = 0): number[][][] {
  const ring = (y: number) => Array.from({ length: n }, (_, i) => [x + r * Math.cos((i / n) * Math.PI * 2), y, r * Math.sin((i / n) * Math.PI * 2)]);
  const lo = ring(0), hi = ring(h);
  const faces: number[][][] = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    faces.push([lo[i]!, hi[i]!, hi[j]!, lo[j]!]);
  }
  faces.push([...hi].reverse(), lo);
  return faces;
}

const normalOf = (p: Float32Array, a: number, b: number, c: number) => {
  const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
  const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx] as const;
};

describe("simplifying", () => {
  it("halves a sphere's triangles, keeping its vertex arrays and its shape", () => {
    const base = sphere();
    const half = simplifyMesh(base, 0.5);
    const tris = triangleCountOf(half);
    expect(tris).toBeLessThanOrEqual(triangleCountOf(base) * 0.55);
    expect(tris).toBeGreaterThan(triangleCountOf(base) * 0.3);
    const p = half.primitives[0]!;
    expect(p.positions).toBe(base.primitives[0]!.positions); // shared, not copied
    expect(p.uvs).toBe(base.primitives[0]!.uvs);
    // Every triangle still faces the same way (no flips) and none collapsed to
    // a sliver: the only zero-area ones are the base's own pole triangles
    // (whose top ring shares one position).
    const flat = (q: typeof p) => {
      let count = 0;
      for (let t = 0; t < q.indices.length; t += 3) if (Math.hypot(...normalOf(q.positions, q.indices[t]!, q.indices[t + 1]!, q.indices[t + 2]!)) < 1e-9) count += 1;
      return count;
    };
    expect(flat(p)).toBeLessThanOrEqual(flat(base.primitives[0]!));
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
      expect(new Set([a, b, c]).size).toBe(3);
      const n = normalOf(p.positions, a, b, c);
      if (Math.hypot(...n) < 1e-9) continue;
      const cx = (p.positions[a * 3]! + p.positions[b * 3]! + p.positions[c * 3]!) / 3;
      const cy = (p.positions[a * 3 + 1]! + p.positions[b * 3 + 1]! + p.positions[c * 3 + 1]!) / 3;
      const cz = (p.positions[a * 3 + 2]! + p.positions[b * 3 + 2]! + p.positions[c * 3 + 2]!) / 3;
      // The sphere's winding faces inward here; what matters is that every triangle agrees.
      expect(Math.sign(n[0] * cx + n[1] * cy + n[2] * cz)).toBe(-1);
    }
  });

  it("holds the seam still, so no crack opens where the UVs wrap", () => {
    const base = sphere();
    const used = new Set(simplifyMesh(base, 0.25).primitives[0]!.indices);
    // Seam vertices (s = 0 and s = segments, same positions) all survive.
    for (let r = 1; r < 16; r += 1) {
      expect(used.has(r * 33)).toBe(true);
      expect(used.has(r * 33 + 32)).toBe(true);
    }
  });

  it("keeps a flat grid's border and folds its flat inside away", () => {
    const base = grid(20);
    const low = simplifyMesh(base, 0.1);
    expect(triangleCountOf(low)).toBeLessThanOrEqual(80);
    const used = new Set(low.primitives[0]!.indices);
    for (let i = 0; i <= 20; i += 1) {
      expect(used.has(i)).toBe(true); // the first row: border
      expect(used.has(i * 21)).toBe(true); // the first column
    }
    // The area is unchanged (all of it still covered): 20 × 20.
    let area = 0;
    const p = low.primitives[0]!;
    for (let t = 0; t < p.indices.length; t += 3) {
      const n = normalOf(p.positions, p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!);
      area += Math.hypot(...n) / 2;
    }
    expect(area).toBeCloseTo(400, 3);
  });

  it("leaves a tiny mesh alone", () => {
    expect(generateLods(grid(2))).toBeNull();
  });
});

describe("hard-edged meshes", () => {
  it("simplifies across creases: a 32-sided prism loses sides, every corner keeping a normal that faces its triangle", () => {
    const prim = faceted(prismFaces(32, 1, 2));
    const mesh: MeshAsset = { name: "prism", primitives: [prim] };
    const low = simplifyMesh(mesh, 0.4);
    const p = low.primitives[0]!;
    expect(triangleCountOf(low)).toBeLessThan(triangleCountOf(mesh) * 0.6);
    expect(p.positions).toBe(prim.positions);
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
      const n = normalOf(p.positions, a, b, c);
      for (const v of [a, b, c]) expect(p.normals![v * 3]! * n[0] + p.normals![v * 3 + 1]! * n[1] + p.normals![v * 3 + 2]! * n[2]).toBeGreaterThan(0);
    }
  });

  it("stops where the shape would show: a tight error budget keeps far more than a loose one", () => {
    const mesh: MeshAsset = { name: "prism", primitives: [faceted(prismFaces(32, 1, 2))] };
    expect(triangleCountOf(simplifyMesh(mesh, 0.1, 1e-6))).toBeGreaterThan(triangleCountOf(simplifyMesh(mesh, 0.1)) * 2);
  });

  it("leaves a part already as plain as a box whole", () => {
    const box: MeshAsset = { name: "box", primitives: [faceted(prismFaces(4, 1, 1))] };
    expect(triangleCountOf(simplifyMesh(box, 0.1))).toBe(12);
  });

  it("drops the small parts: a bolt on a block goes, the block stays", () => {
    const block = faceted([...prismFaces(4, 2, 3), ...prismFaces(4, 0.05, 0.1, 3)]);
    const mesh: MeshAsset = { name: "block", primitives: [block] };
    const pruned = pruneSmallParts(mesh, 0.05);
    expect(triangleCountOf(pruned)).toBe(12);
    expect(pruned.primitives[0]!.positions).toBe(block.positions);
    expect(triangleCountOf(pruneSmallParts(mesh, 0.001))).toBe(24);
  });
});

describe("chains and storage", () => {
  it("makes levels at about a half and a quarter, switched to farther for each", () => {
    const chain = generateLods(sphere(48, 24))!;
    expect(chain.meshes).toHaveLength(2);
    expect(triangleCountOf(chain.meshes[1]!)).toBeLessThan(triangleCountOf(chain.meshes[0]!));
    expect(chain.distances[1]!).toBeGreaterThan(chain.distances[0]!);
  });

  it("stores a level as indices only and reads it back over its base", () => {
    const base = sphere();
    const level = simplifyMesh(base, 0.5);
    const back = decodeLodLevel(base, encodeLodLevel(level))!;
    expect(Array.from(back.primitives[0]!.indices)).toEqual(Array.from(level.primitives[0]!.indices));
    expect(back.primitives[0]!.positions).toBe(base.primitives[0]!.positions);
    // Past 65,536 vertices, indices are stored wide.
    const big: MeshAsset = { name: "big", primitives: [{ ...grid(2).primitives[0]!, positions: new Float32Array(70000 * 3), indices: Uint32Array.from([0, 1, 69999]) }] };
    expect(Array.from(decodeLodLevel(big, encodeLodLevel(big))!.primitives[0]!.indices)).toEqual([0, 1, 69999]);
    // A level that doesn't fit its base is refused.
    expect(decodeLodLevel(grid(2), encodeLodLevel(level))).toBeNull();
    const stored = JSON.parse(JSON.stringify(encodeLods(base, generateLods(base)!)));
    expect(decodeLods(base, stored)!.meshes).toHaveLength(2);
    expect(decodeLods(base, { ...stored, distances: [5, 1] })).toBeNull(); // not ascending
    // Levels made from other geometry (same counts, a vertex moved) are refused.
    const moved = sphere();
    moved.primitives[0]!.positions[40] = 0.5;
    expect(decodeLods(moved, stored)).toBeNull();
  });
});

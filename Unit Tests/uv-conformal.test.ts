/**
 * The angle-preserving unwrap (AAA_PRODUCTION_ROADMAP.md D2): least-squares
 * conformal maps over charts cut at seams and creases. Measured by angle
 * distortion (each triangle's angles in 3D against UV), against the box
 * projection it sits beside.
 */
import { describe, expect, it } from "vitest";
import { angleDistortion, unwrapConformal, unwrapPrimitive, type MeshPrimitive } from "@cartbox/editor";

const material = { name: "m", baseColorFactor: [1, 1, 1, 1] as [number, number, number, number], baseColorImage: null };
const prim = (positions: number[], indices: number[], extra: Partial<MeshPrimitive> = {}): MeshPrimitive =>
  ({ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material, ...extra }) as unknown as MeshPrimitive;

function grid(n: number): MeshPrimitive {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) pos.push(i / n, 0, j / n);
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const a = j * (n + 1) + i;
    idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  return prim(pos, idx);
}

/** An open tube of `seg` segments round and `rings` along, radius 1, height 2, its vertices shared all round. */
function tube(seg: number, rings: number): MeshPrimitive {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r += 1) for (let s = 0; s < seg; s += 1) {
    const a = (s / seg) * Math.PI * 2;
    pos.push(Math.cos(a), (r / rings) * 2, Math.sin(a));
  }
  for (let r = 0; r < rings; r += 1) for (let s = 0; s < seg; s += 1) {
    const a = r * seg + s, b = r * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
    idx.push(a, c, b, b, c, d);
  }
  return prim(pos, idx);
}

/** A unit cube, 24 vertices (split per face, as normals split them). */
function cube(): MeshPrimitive {
  const pos: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) pos.push(...[0, 1, 2].map((k) => 0.5 * (n[k]! + a * u[k]! + b * v[k]!)));
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return prim(pos, idx);
}

/** A closed UV sphere with its vertices shared (no seam in the mesh). */
function sphere(seg: number, rings: number): MeshPrimitive {
  const pos: number[] = [0, 1, 0];
  const idx: number[] = [];
  for (let r = 1; r < rings; r += 1) for (let s = 0; s < seg; s += 1) {
    const th = (r / rings) * Math.PI, ph = (s / seg) * Math.PI * 2;
    pos.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
  }
  pos.push(0, -1, 0);
  const south = pos.length / 3 - 1;
  const at = (r: number, s: number) => 1 + (r - 1) * seg + (s % seg);
  for (let s = 0; s < seg; s += 1) idx.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < rings - 1; r += 1) for (let s = 0; s < seg; s += 1) idx.push(at(r, s), at(r, s + 1), at(r + 1, s), at(r, s + 1), at(r + 1, s + 1), at(r + 1, s));
  for (let s = 0; s < seg; s += 1) idx.push(south, at(rings - 1, s), at(rings - 1, s + 1));
  return prim(pos, idx);
}

/** Each triangle's signed UV area (positive: wound as in 3D seen from outside, after a consistent unwrap). */
function signedAreas(p: MeshPrimitive): number[] {
  return Array.from({ length: p.indices.length / 3 }, (_, t) => {
    const [a, b, c] = [0, 1, 2].map((k) => p.indices[t * 3 + k]!);
    const u = (v: number, k: number) => p.uvs![v * 2 + k]!;
    return ((u(b!, 0) - u(a!, 0)) * (u(c!, 1) - u(a!, 1)) - (u(b!, 1) - u(a!, 1)) * (u(c!, 0) - u(a!, 0))) / 2;
  });
}
const inUnitSquare = (p: MeshPrimitive) => Array.from(p.uvs!).every((v) => Number.isFinite(v) && v >= -1e-9 && v <= 1 + 1e-9);

describe("the conformal unwrap (D2)", () => {
  it("lays a flat grid down as itself: one chart, no distortion", () => {
    const out = unwrapConformal(grid(8));
    expect(angleDistortion(out)).toBeLessThan(1e-4);
    expect(inUnitSquare(out)).toBe(true);
    expect(out.positions.length).toBe(grid(8).positions.length); // nothing split
  });

  it("unrolls a tube cut by a seam into one near-conformal chart, where the box projection distorts", () => {
    const t = tube(24, 6);
    // The seam: the line of edges between segment 0 and its neighbour up the tube.
    const seams: [number, number][] = Array.from({ length: 6 }, (_, r) => [r * 24, (r + 1) * 24]);
    const out = unwrapConformal(t, { seams });
    expect(angleDistortion(out)).toBeLessThan(0.02);
    expect(angleDistortion(out)).toBeLessThan(angleDistortion(unwrapPrimitive(t)) / 5);
    // The seam's vertices are split once each: 7 more than the tube had.
    expect(out.positions.length / 3).toBe(t.positions.length / 3 + 7);
    expect(signedAreas(out).every((a) => a > 0) || signedAreas(out).every((a) => a < 0)).toBe(true);
    expect(inUnitSquare(out)).toBe(true);
  });

  it("cuts a cube at its creases into six square charts that don't overlap", () => {
    const out = unwrapConformal(cube());
    expect(angleDistortion(out)).toBeLessThan(1e-4);
    // Six charts: four vertices each, every face's UV box apart from the others.
    const boxes = Array.from({ length: 6 }, (_, f) => {
      const us = [0, 1, 2, 3].map((k) => out.uvs![(f * 4 + k) * 2]!);
      const vs = [0, 1, 2, 3].map((k) => out.uvs![(f * 4 + k) * 2 + 1]!);
      return { x0: Math.min(...us), x1: Math.max(...us), y0: Math.min(...vs), y1: Math.max(...vs) };
    });
    for (const b of boxes) expect(b.x1 - b.x0).toBeCloseTo(b.y1 - b.y0, 6); // square
    for (let i = 0; i < 6; i += 1) for (let j = i + 1; j < 6; j += 1) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.x1 <= b.x0 + 1e-9 || b.x1 <= a.x0 + 1e-9 || a.y1 <= b.y0 + 1e-9 || b.y1 <= a.y0 + 1e-9).toBe(true);
    }
    expect(inUnitSquare(out)).toBe(true);
  });

  it("splits a closed smooth surface no seam opens, and still flattens it better than the box projection", () => {
    const s = sphere(24, 12);
    const out = unwrapConformal(s);
    expect(inUnitSquare(out)).toBe(true);
    expect(signedAreas(out).every((a) => a > -1e-12)).toBe(true); // nothing mirrored
    expect(angleDistortion(out)).toBeLessThan(angleDistortion(unwrapPrimitive(s)));
  });

  it("keeps each vertex's other attributes through the split", () => {
    const t = tube(8, 2);
    const n = t.positions.length / 3;
    const skinned = { ...t, joints: Uint16Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? Math.floor(i / 4) % 3 : 0)), weights: Float32Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)) } as MeshPrimitive;
    const out = unwrapConformal(skinned, { seams: [[0, 8], [8, 16]] });
    for (let v = 0; v < out.positions.length / 3; v += 1) {
      // Each output vertex carries the joint its source had: find its source by position.
      const at = [0, 1, 2].map((k) => out.positions[v * 3 + k]!);
      const src = Array.from({ length: n }, (_, i) => i).find((i) => [0, 1, 2].every((k) => Math.abs(t.positions[i * 3 + k]! - at[k]!) < 1e-6))!;
      expect(out.joints![v * 4]).toBe(skinned.joints![src * 4]);
    }
  });
});

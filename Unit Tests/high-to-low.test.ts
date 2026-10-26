/**
 * High-to-low baking (AAA_FIDELITY_ROADMAP.md F9a): a flat game quad baked
 * from a domed, finely tessellated high mesh. Its normal map, decoded as the
 * AAA shader decodes it (in the low mesh's stored tangent frame), gives back
 * the high mesh's normals; its height map rises over the dome; its ID map
 * tells the high mesh's two halves apart; its occlusion darkens a trench; a
 * cage bakes the same; and the low mesh comes back with its tangents and maps.
 */

import { describe, expect, it } from "vitest";

import { bakeHighToLow, idColour, uvTangents, type MeshAsset, type MeshPrimitive } from "@cartbox/editor";

const material = { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };

/** The low mesh: a 2×2 quad in XZ facing up, UV 0..1 over it (u along +x, v along −z). */
function lowQuad(y = 0): MeshAsset {
  return {
    name: "low",
    primitives: [
      {
        positions: Float32Array.from([-1, y, 1, 1, y, 1, 1, y, -1, -1, y, -1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      } as unknown as MeshPrimitive,
    ],
  } as unknown as MeshAsset;
}

/** The dome's height over the floor at (x, z), and its unit normal. */
const dome = (x: number, z: number) => 0.3 * Math.exp(-(x * x + z * z) / 0.1);
function domeNormal(x: number, z: number): [number, number, number] {
  const h = dome(x, z);
  const dx = h * (-2 * x / 0.1);
  const dz = h * (-2 * z / 0.1);
  const l = Math.hypot(dx, 1, dz);
  return [-dx / l, 1 / l, -dz / l];
}

/** The high mesh: the dome over the quad, a fine grid, its left (x < 0) and right halves separate primitives; with a trench along z at x = 0.6 when asked. */
function highDome(trench = false): MeshAsset {
  const n = 96;
  const height = (x: number, z: number) => dome(x, z) - (trench && Math.abs(x - 0.6) < 0.04 ? 0.15 : 0);
  const half = (x0: number, x1: number): MeshPrimitive => {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const cols = n / 2 + 1;
    for (let j = 0; j <= n; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const x = x0 + ((x1 - x0) * i) / (cols - 1);
        const z = -1 + (2 * j) / n;
        positions.push(x, height(x, z), z);
        normals.push(...domeNormal(x, z));
      }
    }
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < cols - 1; i += 1) {
        const a = j * cols + i;
        indices.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
    return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: null, indices: Uint32Array.from(indices), material } as unknown as MeshPrimitive;
  };
  return { name: "high", primitives: [half(-1.05, 0), half(0, 1.05)] } as unknown as MeshAsset;
}

const SIZE = 48;
/** A texel's world point on the low quad (texel centre). */
const texelPoint = (x: number, y: number): [number, number] => [-1 + ((x + 0.5) / SIZE) * 2, 1 - ((1 - (y + 0.5) / SIZE) * 2)];
const at = (t: { data: Uint8ClampedArray; width: number }, x: number, y: number, c: number) => t.data[(y * t.width + x) * 4 + c]!;

describe("high-to-low baking", () => {
  const baked = bakeHighToLow(lowQuad(), highDome(), { size: SIZE, supersample: 2, rays: 0, front: 0.5, back: 0.1 });
  const maps = baked.maps[0]!;

  it("decodes, in the low mesh's tangent frame, to the high mesh's normals", () => {
    const tangents = baked.mesh.primitives[0]!.tangents!;
    expect(tangents).toBeTruthy();
    const t: [number, number, number] = [tangents[0]!, tangents[1]!, tangents[2]!];
    const w = tangents[3]!;
    const n: [number, number, number] = [0, 1, 0];
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]].map((c) => c * w);
    let worst = 0;
    for (const [x, y] of [[24, 24], [20, 26], [28, 21], [16, 24], [24, 33], [5, 5], [40, 10]] as const) {
      const tn = [0, 1, 2].map((c) => at(maps.normal, x, y, c) / 255 * 2 - 1);
      // The AAA shader's decode: tn.x·t + tn.y·b + tn.z·n.
      const d = [0, 1, 2].map((c) => tn[0]! * t[c]! + tn[1]! * b[c]! + tn[2]! * n[c]!);
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      const [px, pz] = texelPoint(x, y);
      const want = domeNormal(px, pz);
      const cos = (d[0]! * want[0] + d[1]! * want[1] + d[2]! * want[2]) / l;
      worst = Math.max(worst, Math.acos(Math.min(1, cos)));
    }
    // Within 5° (8-bit encoding and a texel's averaging).
    expect(worst).toBeLessThan((5 * Math.PI) / 180);
    expect(maps.coverage).toBe(1);
  });

  it("records the dome's height over the quad, flat round it", () => {
    const top = at(maps.relief, 24, 24, 0);
    const flat = at(maps.relief, 3, 3, 0);
    // Height mid-grey on the quad, rising by 0.3 over (front + back) = 0.6 at the dome's top.
    expect(Math.abs(flat - 128)).toBeLessThanOrEqual(3);
    expect(Math.abs(top - Math.round((0.5 + 0.3 / 0.6) * 255))).toBeLessThanOrEqual(10);
  });

  it("tells the high mesh's two halves apart in the ID map", () => {
    const left = [0, 1, 2].map((c) => at(maps.id, 8, 24, c));
    const right = [0, 1, 2].map((c) => at(maps.id, 40, 24, c));
    expect(left).toEqual(idColour(0));
    expect(right).toEqual(idColour(1));
    expect(left).not.toEqual(right);
  });

  it("sets the maps and tangents on the low mesh", () => {
    const m = baked.mesh.primitives[0]!.material;
    expect(m.normalImage?.mime).toBe("image/png");
    expect(m.occlusionImage?.bytes.length).toBeGreaterThan(0);
    expect(m.reliefImage).toBeTruthy();
    // The stand-in frame: u along +x, the bitangent up the image (+v along −z).
    const t = uvTangents(lowQuad().primitives[0]!);
    expect(Array.from(t.slice(0, 4)).map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, 0, 1]);
  });

  it("bakes the same through a cage as by ray distances", () => {
    const cage = lowQuad(0.5);
    const caged = bakeHighToLow(lowQuad(), highDome(), { size: SIZE, supersample: 2, rays: 0, cage, back: 0.1 }).maps[0]!;
    let worst = 0;
    for (let i = 0; i < SIZE * SIZE * 4; i += 4) for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(caged.normal.data[i + c]! - maps.normal.data[i + c]!));
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("darkens a trench in the occlusion, and reads the open dome open", () => {
    const withTrench = bakeHighToLow(lowQuad(), highDome(true), { size: SIZE, supersample: 1, rays: 32, front: 0.5, back: 0.3 }).maps[0]!;
    // The trench runs along z at x = 0.6: texel column (0.6 + 1) / 2 · SIZE.
    const col = Math.floor(((0.6 + 1) / 2) * SIZE);
    expect(withTrench.coverage).toBe(1);
    const inTrench = at(withTrench.occlusion, col, 40, 0);
    const open = at(withTrench.occlusion, 4, 40, 0);
    expect(open).toBeGreaterThan(240);
    expect(inTrench).toBeLessThan(open - 40);
  });
});

/**
 * Scans and dense meshes (AAA_FIDELITY_ROADMAP.md F9c): PLY in (ASCII and
 * binary), delighting the captured colour, colours carried to a simplified
 * mesh and baked through its auto-UVs, 128-triangle clusters, and the whole
 * preparation: a game mesh under budget with its LODs and a collision proxy.
 */

import { describe, expect, it } from "vitest";

import { CLUSTER_TRIANGLES, bakeVertexColors, buildClusters, decodePngRgba, delightColors, parsePly, prepareScan, shBasis, transferColors, type MeshPrimitive } from "@cartbox/editor";

/** A UV sphere's vertices and quads (rings × segments), and its captured colour: albedo (red on +x, blue on −x) × a sun from +y. */
function sphere(rings: number, segments: number) {
  const positions: number[] = [];
  const albedo: number[] = [];
  const captured: number[] = [];
  for (let r = 0; r <= rings; r += 1)
    for (let s = 0; s <= segments; s += 1) {
      const th = (r / rings) * Math.PI;
      const ph = (s / segments) * Math.PI * 2;
      const p = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      positions.push(...p);
      const a = p[0]! >= 0 ? [0.7, 0.2, 0.1] : [0.1, 0.2, 0.7];
      albedo.push(...a);
      const light = 0.25 + 0.75 * Math.max(0, p[1]!);
      captured.push(...a.map((c) => c * light));
    }
  const quads: number[][] = [];
  for (let r = 0; r < rings; r += 1)
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      quads.push([a, a + segments + 1, a + segments + 2, a + 1]);
    }
  return { positions, albedo, captured, quads };
}

function asciiPly(s: ReturnType<typeof sphere>): Uint8Array {
  const n = s.positions.length / 3;
  const lines = ["ply", "format ascii 1.0", `element vertex ${n}`, "property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue", `element face ${s.quads.length}`, "property list uchar int vertex_indices", "end_header"];
  for (let v = 0; v < n; v += 1) lines.push(`${s.positions[v * 3]} ${s.positions[v * 3 + 1]} ${s.positions[v * 3 + 2]} ${[0, 1, 2].map((a) => Math.round(s.captured[v * 3 + a]! * 255)).join(" ")}`);
  for (const q of s.quads) lines.push(`4 ${q.join(" ")}`);
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function binaryPly(s: ReturnType<typeof sphere>, littleEndian: boolean): Uint8Array {
  const n = s.positions.length / 3;
  const header = ["ply", `format binary_${littleEndian ? "little" : "big"}_endian 1.0`, `element vertex ${n}`, "property float x", "property float y", "property float z", "property uchar red", "property uchar green", "property uchar blue", `element face ${s.quads.length}`, "property list uchar int vertex_indices", "end_header", ""].join("\n");
  const head = new TextEncoder().encode(header);
  const body = new DataView(new ArrayBuffer(n * 15 + s.quads.length * 17));
  let o = 0;
  for (let v = 0; v < n; v += 1) {
    for (let a = 0; a < 3; a += 1, o += 4) body.setFloat32(o, s.positions[v * 3 + a]!, littleEndian);
    for (let a = 0; a < 3; a += 1, o += 1) body.setUint8(o, Math.round(s.captured[v * 3 + a]! * 255));
  }
  for (const q of s.quads) {
    body.setUint8(o, 4);
    o += 1;
    for (const i of q) {
      body.setInt32(o, i, littleEndian);
      o += 4;
    }
  }
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head);
  out.set(new Uint8Array(body.buffer), head.length);
  return out;
}

describe("PLY", () => {
  it("reads ASCII and binary alike, fanning polygons into triangles", () => {
    const s = sphere(8, 12);
    const a = parsePly(asciiPly(s), "rock");
    const le = parsePly(binaryPly(s, true));
    const be = parsePly(binaryPly(s, false));
    const n = s.positions.length / 3;
    for (const scan of [a, le, be]) {
      expect(scan.mesh.primitives[0]!.positions.length).toBe(n * 3);
      expect(scan.mesh.primitives[0]!.indices.length).toBe(s.quads.length * 6);
      expect(scan.colors!.length).toBe(n * 3);
    }
    expect([...le.mesh.primitives[0]!.indices]).toEqual([...a.mesh.primitives[0]!.indices]);
    expect([...be.colors!]).toEqual([...a.colors!]);
    expect(le.mesh.primitives[0]!.positions[5]).toBeCloseTo(s.positions[5]!, 5);
    expect(a.mesh.name).toBe("rock");
    expect(() => parsePly(new TextEncoder().encode("nope"))).toThrow();
  });
});

describe("delighting", () => {
  it("takes the capture's light out, keeping the albedo", () => {
    const s = sphere(24, 48);
    const normals = Float32Array.from(s.positions);
    const captured = Float32Array.from(s.captured);
    const { colors, light } = delightColors(normals, captured);
    // The fitted light is brightest straight up.
    const at = (n: number[]) => shBasis(n[0]!, n[1]!, n[2]!).reduce((sum, b, i) => sum + b * light[i]!, 0);
    expect(at([0, 1, 0])).toBeGreaterThan(at([0, -1, 0]) * 2);
    // Over the red half, the red channel's spread (light to dark) shrinks by 40% and more: L2 can't hold the
    // clamped light's edge exactly, and the albedo's own split along x takes a share of the fit.
    const spread = (c: Float32Array) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < c.length / 3; v += 1) {
        if (s.positions[v * 3]! < 0.3) continue;
        lo = Math.min(lo, c[v * 3]!);
        hi = Math.max(hi, c[v * 3]!);
      }
      return hi / lo;
    };
    expect(spread(colors)).toBeLessThan(spread(captured) * 0.6);
    // Red stays red, blue blue.
    const v = s.positions.findIndex((_, i) => i % 3 === 0 && s.positions[i]! > 0.9) / 3;
    expect(colors[v * 3]!).toBeGreaterThan(colors[v * 3 + 2]! * 3);
  });
});

describe("transfer and bake", () => {
  it("gives each vertex its nearest dense vertex's colour", () => {
    const from = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const colors = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect([...transferColors(from, colors, Float32Array.from([0.9, 0.1, 0, 0.1, 0.8, 0]))]).toEqual([0, 1, 0, 0, 0, 1]);
  });

  it("bakes vertex colours through the UVs, filling past the edges", () => {
    const prim = {
      positions: new Float32Array(9),
      uvs: Float32Array.from([0.1, 0.1, 0.9, 0.1, 0.1, 0.9]),
      indices: Uint32Array.from([0, 1, 2]),
    } as unknown as MeshPrimitive;
    const rgba = bakeVertexColors(prim, Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0]), 32, 2);
    // Inside (UV 0.2, 0.2: texel x 6, row 25): red. Just outside the corner, dilated: red too.
    expect(rgba[(25 * 32 + 6) * 4]).toBe(255);
    expect(rgba[(29 * 32 + 6) * 4 + 3]).toBe(255);
    // Far outside: empty.
    expect(rgba[(2 * 32 + 30) * 4 + 3]).toBe(0);
  });
});

describe("clusters", () => {
  it("cuts the triangles into compact runs of 128, each bounded, with a normal cone", () => {
    const s = sphere(32, 64);
    const scan = parsePly(binaryPly(s, true));
    const prim = scan.mesh.primitives[0]!;
    const { indices, clusters } = buildClusters(prim);
    expect(indices.length).toBe(prim.indices.length);
    expect(clusters.every((c) => c.triangles <= CLUSTER_TRIANGLES)).toBe(true);
    expect(clusters.reduce((n, c) => n + c.triangles, 0)).toBe(prim.indices.length / 3);
    // Each cluster's sphere holds its vertices, and is small next to the whole (a compact run).
    for (const c of clusters) {
      expect(c.radius).toBeLessThan(0.9);
      for (let k = c.firstTriangle * 3; k < (c.firstTriangle + c.triangles) * 3; k += 1) {
        const i = indices[k]!;
        expect(Math.hypot(prim.positions[i * 3]! - c.center[0], prim.positions[i * 3 + 1]! - c.center[1], prim.positions[i * 3 + 2]! - c.center[2])).toBeLessThanOrEqual(c.radius + 1e-5);
      }
      expect(c.cutoff).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Every triangle once: the sorted runs hold the same triangles.
    const key = (ix: Uint32Array) => Array.from({ length: ix.length / 3 }, (_, t) => [...ix.subarray(t * 3, t * 3 + 3)].join(",")).sort().join(";");
    expect(key(indices)).toBe(key(prim.indices));
  });
});

describe("preparing a scan", () => {
  it("makes a textured game mesh under budget, with LODs, a collision proxy and clusters", async () => {
    const s = sphere(96, 192);
    const scan = parsePly(binaryPly(s, true), "boulder");
    const ready = prepareScan(scan, { triangles: 4000, proxyTriangles: 300, textureSize: 128 });
    // The poles' collapsed triangles (two corners welded together) are dropped.
    expect(ready.stats.denseTriangles).toBe(96 * 192 * 2 - 2 * 192);
    expect(ready.stats.triangles).toBeLessThanOrEqual(4400);
    expect(ready.stats.proxyTriangles).toBeLessThanOrEqual(330);
    expect(ready.lods?.meshes.length).toBeGreaterThan(0);
    expect(ready.clusters.length).toBeGreaterThanOrEqual(Math.ceil(ready.stats.triangles / CLUSTER_TRIANGLES));
    // And its cluster hierarchy (F6a): level 0 is the game mesh's own triangles, with coarser levels above.
    const lod = ready.mesh.primitives[0]!.clusterLod!;
    expect(lod.levels).toBeGreaterThan(1);
    expect(lod.clusters.filter((c) => c.error === 0).reduce((n, c) => n + c.triangles, 0)).toBe(ready.stats.triangles);
    expect(ready.clusters.reduce((n, c) => n + c.triangles, 0)).toBe(ready.stats.triangles);
    expect(ready.proxy.name).toBe("boulder:collision");
    // The baked texture: delit red and blue both there, at similar brightness wherever the sun stood.
    const image = ready.mesh.primitives[0]!.material.baseColorImage!;
    const tex = await decodePngRgba(image.bytes);
    let red = 0;
    let blue = 0;
    for (let i = 0; i < tex.width * tex.height; i += 1) {
      if (tex.data[i * 4 + 3] === 0) continue;
      if (tex.data[i * 4]! > tex.data[i * 4 + 2]! + 60) red += 1;
      if (tex.data[i * 4 + 2]! > tex.data[i * 4]! + 60) blue += 1;
    }
    expect(red).toBeGreaterThan(tex.width * tex.height * 0.05);
    expect(blue).toBeGreaterThan(tex.width * tex.height * 0.05);
  });
});

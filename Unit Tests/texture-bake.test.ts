/**
 * Texture baking (HALO_INFINITE_STYLE_ROADMAP.md I15): ambient occlusion,
 * curvature and thickness baked from a mesh into its texture space — darker in
 * a pit than on the open top, convex at the outer rim and concave at the pit's
 * floor, thin on a plate and solid in a block — and set on its materials.
 */

import { describe, expect, it } from "vitest";
import { bakeSurfaceMaps, editFace, faceAt, primitiveFaces, type DecodedTexture, type MeshAsset, type MeshPrimitive } from "@cartbox/editor";

/** A w × h × d box on the origin, wound outward, each face's corners its own. */
function block(w: number, h: number, d: number, at: [number, number, number] = [0, 0, 0], uvs = false): MeshPrimitive {
  const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
  const faces: [number[], number[], number[], number, number, number[]][] = [
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], w / 2, d / 2, [0, h, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1], w / 2, d / 2, [0, 0, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], d / 2, h / 2, [w / 2, h / 2, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0], d / 2, h / 2, [-w / 2, h / 2, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], w / 2, h / 2, [0, h / 2, d / 2]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0], w / 2, h / 2, [0, h / 2, -d / 2]],
  ];
  faces.forEach(([n, u, v, hu, hv, c], f) => {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(at[0] + c[0]! + u[0]! * su! * hu + v[0]! * sv! * hv, at[1] + c[1]! + u[1]! * su! * hu + v[1]! * sv! * hv, at[2] + c[2]! + u[2]! * su! * hu + v[2]! * sv! * hv);
      normals.push(...n);
      // Six cells of a 3 × 2 grid, one a face.
      uv.push(((f % 3) + (su! + 1) / 2 * 0.9 + 0.05) / 3, (Math.floor(f / 3) + (sv! + 1) / 2 * 0.9 + 0.05) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: uvs ? Float32Array.from(uv) : null,
    indices: Uint32Array.from(indices),
    material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
  };
}

/** A 2 × 1 × 2 block with a 1 × 0.5 × 1 pit cut into its top. */
function pitted(): MeshPrimitive {
  const b = block(2, 1, 2);
  const top = faceAt(b, 0).triangles;
  return editFace(editFace(b, top, { kind: "inset", amount: 0.5 }), top, { kind: "extrude", distance: -0.5 });
}

/** A map's value (one channel, 0..1) at a point of a triangle (barycentric weights), through the primitive's UVs. */
function sample(map: DecodedTexture, p: MeshPrimitive, triangle: number, w: readonly [number, number, number], channel: number): number {
  let u = 0, v = 0;
  for (let k = 0; k < 3; k += 1) {
    const i = p.indices[triangle * 3 + k]!;
    u += p.uvs![i * 2]! * w[k]!;
    v += p.uvs![i * 2 + 1]! * w[k]!;
  }
  const x = Math.min(map.width - 1, Math.floor(u * map.width));
  const y = Math.min(map.height - 1, Math.floor((1 - v) * map.height));
  return map.data[(y * map.width + x) * 4 + channel]! / 255;
}

/** The face whose normal is `n` and whose centroid has the largest (or smallest) y. */
function faceWhere(p: MeshPrimitive, n: [number, number, number], pick: (y: number) => number) {
  return primitiveFaces(p)
    .filter((f) => f.normal[0] * n[0] + f.normal[1] * n[1] + f.normal[2] * n[2] > 0.99)
    .sort((a, b) => pick(b.centroid[1]) - pick(a.centroid[1]))[0]!;
}

const CENTRE = [1 / 3, 1 / 3, 1 / 3] as const;

describe("baking a mesh's surface maps", () => {
  const mesh: MeshAsset = { name: "pit", primitives: [pitted()] };
  const baked = bakeSurfaceMaps(mesh, { size: 128, rays: 64, aoDistance: 1, thicknessDistance: 1, curvatureRadius: 0.1 });
  const p = baked.mesh.primitives[0]!;
  const { occlusion, relief } = baked.maps[0]!;

  it("lays out an untextured mesh uniquely, and sets both maps on its material", () => {
    expect(p.uvs).not.toBeNull();
    expect(p.material.occlusionImage!.mime).toBe("image/png");
    // A PNG of the baked size (its IHDR's width and height).
    const png = new DataView(p.material.reliefImage!.bytes.buffer, p.material.reliefImage!.bytes.byteOffset);
    expect([png.getUint32(16), png.getUint32(20)]).toEqual([relief.width, relief.height]);
  });

  it("darkens the pit's floor against the open top", () => {
    const floor = faceWhere(p, [0, 1, 0], (y) => -y);
    const rim = faceWhere(p, [0, 1, 0], (y) => y);
    const floorAo = sample(occlusion, p, floor.triangles[0]!, CENTRE, 0);
    const rimAo = sample(occlusion, p, rim.triangles[0]!, CENTRE, 0);
    // Half the floor's (cosine-weighted) sky is the pit's walls, about half a metre off: about 0.8.
    expect(floorAo).toBeLessThan(rimAo - 0.15);
    expect(floorAo).toBeGreaterThan(0.6);
    expect(rimAo).toBeGreaterThan(0.85);
  });

  it("reads the outer rim convex, the pit's floor corner concave, and flat ground flat", () => {
    // Points on the outer side wall right at its top edge, and on the pit floor right at its edge.
    const side = faceWhere(p, [1, 0, 0], (y) => y);
    const floor = faceWhere(p, [0, 1, 0], (y) => -y);
    const curvature = (f: { triangles: readonly number[] }, w: readonly [number, number, number]) => sample(relief, p, f.triangles[0]!, w, 1) * 2 - 1;
    // Sample many points of each face and look at the extremes.
    const extremes = (f: { triangles: readonly number[] }) => {
      const values: number[] = [];
      for (const t of f.triangles) for (const w of [[0.98, 0.01, 0.01], [0.01, 0.98, 0.01], [0.01, 0.01, 0.98], [0.49, 0.49, 0.02], [0.02, 0.49, 0.49], [0.49, 0.02, 0.49]] as const) values.push(curvature({ triangles: [t] }, w));
      return [Math.min(...values), Math.max(...values)];
    };
    expect(extremes(side)[1]).toBeGreaterThan(0.4);
    expect(extremes(floor)[0]).toBeLessThan(-0.4);
    expect(Math.abs(curvature(side, CENTRE))).toBeLessThan(0.05);
    // Height stays flat (white): a bake gives no parallax.
    expect(sample(relief, p, side.triangles[0]!, CENTRE, 0)).toBe(1);
  });

  it("reads a thin plate thin and a thick block solid", () => {
    const plates: MeshAsset = { name: "plates", primitives: [block(2, 0.05, 2, [0, 0, 0], true), block(2, 2, 2, [4, 0, 0], true)] };
    const out = bakeSurfaceMaps(plates, { size: 64, rays: 32, thicknessDistance: 1 });
    expect(out.maps).toHaveLength(2); // textured primitives: a map each, in their own UVs
    const thinness = (k: number) => sample(out.maps[k]!.relief, out.mesh.primitives[k]!, 0, CENTRE, 2);
    expect(thinness(0)).toBeGreaterThan(0.8);
    expect(thinness(1)).toBeLessThan(0.1);
    // Their own UVs were kept.
    expect(out.mesh.primitives[0]!.uvs).toEqual(plates.primitives[0]!.uvs);
  });

  it("shares one atlas between untextured primitives, drops their stale light map, and bakes the same twice", () => {
    const two: MeshAsset = {
      name: "two",
      primitives: [
        { ...block(1, 1, 1), material: { name: "a", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, lightmapImage: { mime: "image/png", bytes: new Uint8Array(4) } }, uvs2: new Float32Array(48) },
        block(1, 1, 1, [2, 0, 0]),
      ],
    };
    const out = bakeSurfaceMaps(two, { size: 64, rays: 8 });
    expect(out.maps).toHaveLength(1);
    expect(out.mesh.primitives[0]!.material.occlusionImage).toBe(out.mesh.primitives[1]!.material.occlusionImage);
    expect(out.mesh.primitives[0]!.material.lightmapImage).toBeUndefined();
    expect(out.mesh.primitives[0]!.uvs2 ?? null).toBeNull();
    const again = bakeSurfaceMaps(two, { size: 64, rays: 8 });
    expect(again.maps[0]!.relief.data).toEqual(out.maps[0]!.relief.data);
  });
});

describe("the material graph's baked inputs", () => {
  it("reads the occlusion map and the relief's thickness: grime where it's occluded, a glow where it's thin", async () => {
    const { renderMesh } = await import("@cartbox/editor");
    const { WORN_PAINT, reliefTexture } = await import("./helpers/layerScenes");
    const quad: MeshAsset = {
      name: "q",
      primitives: [
        {
          positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "worn", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, graph: WORN_PAINT },
        },
      ],
    };
    const flat = (v: number): DecodedTexture => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).map((_, i) => (i % 4 === 3 ? 255 : v)) });
    const relief = (thinness: number): DecodedTexture => {
      const t = reliefTexture();
      const data = new Uint8ClampedArray(t.data);
      for (let i = 2; i < data.length; i += 4) data[i] = thinness;
      return { ...t, data };
    };
    const mean = (occ: DecodedTexture, rel: DecodedTexture, channel: number) => {
      const size = 48;
      const out = new Uint8ClampedArray(size * size * 4);
      renderMesh(quad, { size, out, depth: new Float32Array(size * size), camera: { yaw: 0, pitch: 0 }, occlusionTextures: [occ], reliefTextures: [rel] } as never);
      let sum = 0;
      for (let i = 0; i < size * size; i += 1) sum += out[i * 4 + channel]!;
      return sum / (size * size);
    };
    // Occluded: darker.
    expect(mean(flat(60), relief(0), 0)).toBeLessThan(mean(flat(255), relief(0), 0) * 0.6);
    // Thin: a cyan glow lifts blue.
    expect(mean(flat(255), relief(255), 2)).toBeGreaterThan(mean(flat(255), relief(0), 2) + 10);
  });
});

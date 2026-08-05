/**
 * Unit tests for the mesh asset model and the OBJ / glTF-GLB codecs (Phase 0 of
 * true-mesh support). Nothing is stubbed: real {@link MeshAsset}s are built,
 * encoded, and parsed back, and hand-assembled documents drive the parsers
 * against inputs the encoders did not produce.
 *
 * Geometry is compared by *expanded triangles* — each triangle's three corners
 * resolved to positions — so a codec that legitimately re-indexes or reorders
 * vertices still compares equal, while a codec that drops a triangle, flips a
 * winding, or moves a vertex does not.
 */

import { describe, expect, it } from "vitest";

import {
  type MeshAsset,
  type MeshPrimitive,
  serializeMeshAsset,
  deserializeMeshAsset,
  computeSmoothNormals,
  meshBounds,
  meshTriangleCount,
  parseObj,
  encodeObj,
  parseGlb,
  parseGltf,
  encodeGlb,
} from "@cartbox/editor";

/** A single-triangle primitive in the XY plane, optionally textured. */
function trianglePrimitive(withImage = false): MeshPrimitive {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
    material: {
      name: "surface",
      baseColorFactor: [0.5, 0.25, 0.75, 1],
      baseColorImage: withImage ? { mime: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]) } : null,
    },
  };
}

/** Expand a mesh to sorted "x,y,z|x,y,z|x,y,z" triangle strings for order-independent compare. */
function triangleStrings(mesh: MeshAsset): string[] {
  const round = (n: number): string => n.toFixed(4);
  const tris: string[] = [];
  for (const primitive of mesh.primitives) {
    const { positions, indices } = primitive;
    for (let i = 0; i < indices.length; i += 3) {
      const corner = (k: number): string => {
        const base = indices[i + k]! * 3;
        return `${round(positions[base]!)},${round(positions[base + 1]!)},${round(positions[base + 2]!)}`;
      };
      tris.push(`${corner(0)}|${corner(1)}|${corner(2)}`);
    }
  }
  return tris.sort();
}

describe("MeshAsset serialization", () => {
  it("round-trips geometry, normals, uvs, material colour, and an embedded image", () => {
    const mesh: MeshAsset = { name: "tri", primitives: [trianglePrimitive(true)] };
    const restored = deserializeMeshAsset(serializeMeshAsset(mesh));

    expect(restored.name).toBe("tri");
    expect(Array.from(restored.primitives[0]!.positions)).toEqual(Array.from(mesh.primitives[0]!.positions));
    expect(Array.from(restored.primitives[0]!.normals!)).toEqual(Array.from(mesh.primitives[0]!.normals!));
    expect(Array.from(restored.primitives[0]!.uvs!)).toEqual(Array.from(mesh.primitives[0]!.uvs!));
    expect(Array.from(restored.primitives[0]!.indices)).toEqual([0, 1, 2]);
    expect(restored.primitives[0]!.material.baseColorFactor).toEqual([0.5, 0.25, 0.75, 1]);
    expect(restored.primitives[0]!.material.baseColorImage!.mime).toBe("image/png");
    expect(Array.from(restored.primitives[0]!.material.baseColorImage!.bytes)).toEqual([137, 80, 78, 71, 1, 2, 3, 4]);
  });

  it("rejects a payload whose normals do not match the vertex count", () => {
    const mesh: MeshAsset = { name: "bad", primitives: [trianglePrimitive()] };
    const json = JSON.parse(serializeMeshAsset(mesh));
    json.primitives[0].normals = json.primitives[0].uvs; // wrong length for a normal stream
    expect(() => deserializeMeshAsset(JSON.stringify(json))).toThrow();
  });

  it("rejects a triangle index that is out of range", () => {
    const mesh: MeshAsset = { name: "bad", primitives: [trianglePrimitive()] };
    const restored = deserializeMeshAsset(serializeMeshAsset(mesh));
    // Re-serialize with a corrupt index buffer (index 9 into a 3-vertex primitive).
    const corrupt = serializeMeshAsset({
      ...restored,
      primitives: [{ ...restored.primitives[0]!, indices: Uint32Array.from([0, 1, 9]) }],
    });
    expect(() => deserializeMeshAsset(corrupt)).toThrow();
  });

  it("rejects an unsupported version", () => {
    const json = JSON.parse(serializeMeshAsset({ name: "v", primitives: [trianglePrimitive()] }));
    json.version = 999;
    expect(() => deserializeMeshAsset(JSON.stringify(json))).toThrow(/version/i);
  });
});

describe("mesh geometry helpers", () => {
  it("derives a plane's normal from its winding", () => {
    // A CCW triangle in the XY plane faces +Z.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = computeSmoothNormals(positions, Uint32Array.from([0, 1, 2]));
    for (let i = 0; i < normals.length; i += 3) {
      expect(normals[i]).toBeCloseTo(0);
      expect(normals[i + 1]).toBeCloseTo(0);
      expect(normals[i + 2]).toBeCloseTo(1);
    }
  });

  it("computes the axis-aligned bounds of every vertex", () => {
    const mesh: MeshAsset = { name: "b", primitives: [trianglePrimitive()] };
    expect(meshBounds(mesh)).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
  });
});

describe("OBJ codec", () => {
  it("round-trips triangle geometry through encode → parse", () => {
    // Two triangles sharing an edge (a quad), so re-indexing is exercised.
    const mesh: MeshAsset = {
      name: "quad",
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
          normals: null,
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [0.2, 0.4, 0.6, 1], baseColorImage: null },
        },
      ],
    };
    const { obj, mtl } = encodeObj(mesh);
    const restored = parseObj(obj, { mtl });
    expect(meshTriangleCount(restored)).toBe(2);
    expect(triangleStrings(restored)).toEqual(triangleStrings(mesh));
    expect(restored.primitives[0]!.material.baseColorFactor).toEqual([0.2, 0.4, 0.6, 1]);
  });

  it("parses a hand-written quad and fan-triangulates it", () => {
    const obj = ["v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f 1 2 3 4"].join("\n");
    const mesh = parseObj(obj);
    expect(meshTriangleCount(mesh)).toBe(2); // one 4-gon → two triangles
    expect(mesh.primitives[0]!.positions.length / 3).toBe(4); // re-indexed, not expanded to 6
  });

  it("splits usemtl groups into separate primitives with their diffuse colours", () => {
    const obj = [
      "v 0 0 0", "v 1 0 0", "v 0 1 0", "v 2 0 0", "v 3 0 0", "v 2 1 0",
      "usemtl red", "f 1 2 3",
      "usemtl blue", "f 4 5 6",
    ].join("\n");
    const mtl = ["newmtl red", "Kd 1 0 0", "newmtl blue", "Kd 0 0 1"].join("\n");
    const mesh = parseObj(obj, { mtl });
    expect(mesh.primitives).toHaveLength(2);
    const byName = Object.fromEntries(mesh.primitives.map((p) => [p.material.name, p.material.baseColorFactor]));
    expect(byName.red).toEqual([1, 0, 0, 1]);
    expect(byName.blue).toEqual([0, 0, 1, 1]);
  });

  it("resolves negative (relative) face indices", () => {
    const obj = ["v 0 0 0", "v 1 0 0", "v 0 1 0", "f -3 -2 -1"].join("\n");
    const mesh = parseObj(obj);
    expect(meshTriangleCount(mesh)).toBe(1);
    expect(Array.from(mesh.primitives[0]!.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});

describe("glTF/GLB codec", () => {
  it("round-trips geometry, normals, uvs, colour, and an embedded texture through GLB", () => {
    const mesh: MeshAsset = { name: "tri", primitives: [trianglePrimitive(true)] };
    const restored = parseGlb(encodeGlb(mesh));

    expect(triangleStrings(restored)).toEqual(triangleStrings(mesh));
    expect(restored.primitives[0]!.uvs).not.toBeNull();
    expect(Array.from(restored.primitives[0]!.uvs!)).toEqual([0, 0, 1, 0, 0, 1]);
    for (let i = 0; i < 9; i += 3) expect(restored.primitives[0]!.normals![i + 2]).toBeCloseTo(1);
    expect(restored.primitives[0]!.material.baseColorFactor).toEqual([0.5, 0.25, 0.75, 1]);
    expect(restored.primitives[0]!.material.baseColorImage!.mime).toBe("image/png");
    expect(Array.from(restored.primitives[0]!.material.baseColorImage!.bytes)).toEqual([137, 80, 78, 71, 1, 2, 3, 4]);
  });

  it("bakes a node's translation into vertex positions (independent document)", () => {
    // Hand-assemble a glTF JSON + binary buffer: a triangle under a node
    // translated +10 on X. The parser must return the translated positions.
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = Uint32Array.from([0, 1, 2]);
    const bin = new Uint8Array(positions.byteLength + indices.byteLength);
    bin.set(new Uint8Array(positions.buffer), 0);
    bin.set(new Uint8Array(indices.buffer), positions.byteLength);

    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [10, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5125, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
      ],
      buffers: [{ byteLength: bin.byteLength }],
    };

    const mesh = parseGltf(json as never, [bin]);
    expect(Array.from(mesh.primitives[0]!.positions)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
  });

  it("throws on a .glb with bad magic bytes", () => {
    expect(() => parseGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(/magic/i);
  });

  it("produces a 4-byte-aligned, self-describing GLB header", () => {
    const glb = encodeGlb({ name: "tri", primitives: [trianglePrimitive()] });
    const dv = new DataView(glb.buffer);
    expect(dv.getUint32(0, true)).toBe(0x46546c67); // "glTF"
    expect(dv.getUint32(4, true)).toBe(2); // version 2
    expect(dv.getUint32(8, true)).toBe(glb.length); // total length matches
    expect(glb.length % 4).toBe(0);
  });
});

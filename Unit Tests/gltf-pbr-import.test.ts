/**
 * Phase 0 — glTF PBR passthrough on import.
 *
 * An imported glTF must keep the metallic-roughness material maps + factors it
 * declares (metallic-roughness, normal, occlusion, emissive), so a modern asset
 * arrives in Cartbox with its authored surface response intact. See
 * AAA_TIER_ROADMAP.md. The importer previously kept only base colour.
 */

import { describe, expect, it } from "vitest";

import { parseGltf } from "@cartbox/editor";

/** A one-triangle buffer: 3 VEC3 float positions then 3 uint16 indices. */
function geometryBuffer(): Uint8Array {
  const buf = new ArrayBuffer(9 * 4 + 3 * 2);
  const dv = new DataView(buf);
  const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  pos.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  [0, 1, 2].forEach((v, i) => dv.setUint16(36 + i * 2, v, true));
  return new Uint8Array(buf);
}

/** A `data:` PNG URI whose decoded bytes are `tag` — enough to identify the map
 *  (the codec stores bytes + mime; it does not decode the pixels). */
function pngUri(tag: number): string {
  return `data:image/png;base64,${Buffer.from([137, 80, 78, 71, tag]).toString("base64")}`;
}

function gltfWithPbrMaterial() {
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, type: "VEC3", count: 3 },
      { bufferView: 1, componentType: 5123, type: "SCALAR", count: 3 },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 42 }],
    materials: [
      {
        name: "steel",
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 1,
          roughnessFactor: 0.3,
          metallicRoughnessTexture: { index: 0 },
        },
        normalTexture: { index: 1 },
        emissiveTexture: { index: 2 },
        occlusionTexture: { index: 3 },
        emissiveFactor: [1, 0, 0],
      },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { source: 3 }],
    images: [{ uri: pngUri(10) }, { uri: pngUri(11) }, { uri: pngUri(12) }, { uri: pngUri(13) }],
  };
}

describe("glTF PBR import passthrough", () => {
  it("carries metallic-roughness, normal, occlusion, emissive maps + factors", () => {
    const mesh = parseGltf(gltfWithPbrMaterial() as never, [geometryBuffer()], "steel");
    const m = mesh.primitives[0]!.material;
    expect(Array.from(m.metallicRoughnessImage!.bytes)).toEqual([137, 80, 78, 71, 10]);
    expect(Array.from(m.normalImage!.bytes)).toEqual([137, 80, 78, 71, 11]);
    expect(Array.from(m.emissiveImage!.bytes)).toEqual([137, 80, 78, 71, 12]);
    expect(Array.from(m.occlusionImage!.bytes)).toEqual([137, 80, 78, 71, 13]);
    expect(m.metallicFactor).toBe(1);
    expect(m.roughnessFactor).toBe(0.3);
    expect(m.emissiveFactor).toEqual([1, 0, 0]);
  });

  it("leaves a plain (non-PBR) glTF material free of PBR fields", () => {
    const json = gltfWithPbrMaterial();
    json.materials[0] = { name: "flat", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } } as never;
    const m = parseGltf(json as never, [geometryBuffer()], "flat").primitives[0]!.material;
    expect(m.metallicRoughnessImage ?? null).toBeNull();
    expect(m.emissiveFactor ?? null).toBeNull();
  });
});

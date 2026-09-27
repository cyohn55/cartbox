/**
 * Compressed glTF geometry on import (ENGINE_ROADMAP.md, Phase 4): files encoded
 * here with the real meshoptimizer and Draco encoders import to the same
 * geometry as their uncompressed originals, using the same decoder glue the web
 * app loads — and fail clearly when the decoder isn't there.
 */

import { createRequire } from "node:module";

import { MeshoptDecoder } from "meshoptimizer/decoder";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import { describe, expect, it } from "vitest";

import { gltfCompression, parseGltf, type GltfDecoders, type MeshAsset } from "@cartbox/editor";
import { decodeDracoPrimitive } from "../apps/web/src/lib/gltfDecoders";

const require = createRequire(import.meta.url);
const draco3d = require("draco3d") as { createEncoderModule: (o?: object) => Promise<any>; createDecoderModule: (o?: object) => Promise<any> };

/** A small tetrahedron-ish mesh: 5 vertices, 4 triangles, with UVs. */
const POSITIONS = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
const UVS = Float32Array.from([0, 0, 1, 0, 0, 1, 0.5, 0.5, 1, 1]);
const INDICES = Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 4]);

/** Each triangle as its three corner positions (sorted), so vertex reordering doesn't matter. */
function triangles(mesh: MeshAsset): string[] {
  const out: string[] = [];
  for (const p of mesh.primitives) {
    for (let t = 0; t < p.indices.length; t += 3) {
      const corners = [0, 1, 2].map((k) => {
        const i = p.indices[t + k]!;
        return [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!].map((v) => v.toFixed(4)).join(",");
      });
      out.push(corners.sort().join("|"));
    }
  }
  return out.sort();
}

function plainMesh(): MeshAsset {
  const bytes = new Uint8Array(POSITIONS.byteLength + INDICES.byteLength);
  bytes.set(new Uint8Array(POSITIONS.buffer), 0);
  bytes.set(new Uint8Array(INDICES.buffer), POSITIONS.byteLength);
  return parseGltf(
    {
      buffers: [{ byteLength: bytes.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: POSITIONS.byteLength },
        { buffer: 0, byteOffset: POSITIONS.byteLength, byteLength: INDICES.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 5, type: "VEC3" },
        { bufferView: 1, componentType: 5125, count: 12, type: "SCALAR" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    },
    [bytes],
    "plain",
  );
}

async function meshoptFile() {
  await MeshoptEncoder.ready;
  const vertices = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(POSITIONS.buffer.slice(0)), 5, 12, "ATTRIBUTES");
  const indices = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(INDICES.buffer.slice(0)), 12, 4, "TRIANGLES");
  const compressed = new Uint8Array(vertices.length + indices.length + 8);
  compressed.set(vertices, 0);
  const indexOffset = vertices.length + ((4 - (vertices.length % 4)) % 4);
  compressed.set(indices, indexOffset);
  const json = {
    extensionsUsed: ["EXT_meshopt_compression"],
    extensionsRequired: ["EXT_meshopt_compression"],
    buffers: [{ byteLength: compressed.length }, { byteLength: POSITIONS.byteLength + INDICES.byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    bufferViews: [
      {
        buffer: 1,
        byteOffset: 0,
        byteLength: POSITIONS.byteLength,
        byteStride: 12,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: vertices.length, byteStride: 12, count: 5, mode: "ATTRIBUTES" as const } },
      },
      {
        buffer: 1,
        byteOffset: POSITIONS.byteLength,
        byteLength: INDICES.byteLength,
        extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: indexOffset, byteLength: indices.length, byteStride: 4, count: 12, mode: "TRIANGLES" as const } },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 5, type: "VEC3" },
      { bufferView: 1, componentType: 5125, count: 12, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  };
  return { json, buffers: [compressed, null] as (Uint8Array | null)[] };
}

async function dracoFile() {
  const encoderModule = await draco3d.createEncoderModule({});
  const encoder = new encoderModule.Encoder();
  const builder = new encoderModule.MeshBuilder();
  const mesh = new encoderModule.Mesh();
  builder.AddFacesToMesh(mesh, INDICES.length / 3, INDICES);
  const positionId = builder.AddFloatAttributeToMesh(mesh, encoderModule.POSITION, 5, 3, POSITIONS);
  const uvId = builder.AddFloatAttributeToMesh(mesh, encoderModule.TEX_COORD, 5, 2, UVS);
  const out = new encoderModule.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = out.GetValue(i);
  encoderModule.destroy(out);
  encoderModule.destroy(mesh);
  encoderModule.destroy(builder);
  encoderModule.destroy(encoder);
  const json = {
    extensionsUsed: ["KHR_draco_mesh_compression"],
    extensionsRequired: ["KHR_draco_mesh_compression"],
    buffers: [{ byteLength: bytes.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    accessors: [
      { componentType: 5126, count: 5, type: "VEC3" },
      { componentType: 5126, count: 5, type: "VEC2" },
      { componentType: 5125, count: 12, type: "SCALAR" },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, TEXCOORD_0: 1 },
            indices: 2,
            extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: positionId, TEXCOORD_0: uvId } } },
          },
        ],
      },
    ],
  };
  return { json, buffers: [bytes] as (Uint8Array | null)[] };
}

async function dracoDecoders(): Promise<GltfDecoders> {
  const module = await draco3d.createDecoderModule({});
  return { draco: (data, attributes) => decodeDracoPrimitive(module, data, attributes) };
}

describe("meshopt-compressed glTF", () => {
  it("imports to the same geometry as the uncompressed file", async () => {
    await MeshoptDecoder.ready;
    const { json, buffers } = await meshoptFile();
    expect(gltfCompression(json)).toEqual({ meshopt: true, draco: false, required: true });
    const mesh = parseGltf(json, buffers, "packed", { meshopt: MeshoptDecoder.decodeGltfBuffer });
    expect(Array.from(mesh.primitives[0]!.positions)).toEqual(Array.from(POSITIONS));
    // The index codec may rotate a triangle's corners (keeping its winding).
    expect(mesh.primitives[0]!.indices.length).toBe(INDICES.length);
    expect(triangles(mesh)).toEqual(triangles(plainMesh()));
  });

  it("says what's missing without the decoder", async () => {
    const { json, buffers } = await meshoptFile();
    expect(() => parseGltf(json, buffers, "packed")).toThrow(/meshopt compression/);
  });

  it("does not modify the document it was given", async () => {
    await MeshoptDecoder.ready;
    const { json, buffers } = await meshoptFile();
    const before = JSON.stringify(json);
    parseGltf(json, buffers, "packed", { meshopt: MeshoptDecoder.decodeGltfBuffer });
    expect(JSON.stringify(json)).toBe(before);
    expect(buffers).toHaveLength(2);
  });
});

describe("Draco-compressed glTF", () => {
  it("imports to the same triangles (and UVs) as the uncompressed file", async () => {
    const { json, buffers } = await dracoFile();
    expect(gltfCompression(json)).toMatchObject({ draco: true, meshopt: false });
    const mesh = parseGltf(json, buffers, "draco", await dracoDecoders());
    const primitive = mesh.primitives[0]!;
    expect(primitive.indices.length).toBe(12);
    expect(triangles(mesh)).toEqual(triangles(plainMesh()));
    // Each vertex keeps its own UV, wherever Draco moved it.
    for (let i = 0; i < primitive.positions.length / 3; i += 1) {
      const p = [primitive.positions[i * 3]!, primitive.positions[i * 3 + 1]!, primitive.positions[i * 3 + 2]!];
      const original = [0, 1, 2, 3, 4].find((k) => p.every((v, c) => Math.abs(v - POSITIONS[k * 3 + c]!) < 1e-4))!;
      expect(primitive.uvs![i * 2]).toBeCloseTo(UVS[original * 2]!, 4);
      expect(primitive.uvs![i * 2 + 1]).toBeCloseTo(UVS[original * 2 + 1]!, 4);
    }
  });

  it("says what's missing without the decoder", async () => {
    const { json, buffers } = await dracoFile();
    expect(() => parseGltf(json, buffers, "draco")).toThrow(/Draco compression/);
  });

  it("leaves uncompressed files alone", () => {
    expect(gltfCompression({ meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] })).toEqual({ meshopt: false, draco: false, required: false });
  });
});

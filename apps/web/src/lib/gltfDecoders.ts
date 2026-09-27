/**
 * The WebAssembly decoders for compressed glTF geometry (ENGINE_ROADMAP.md,
 * Phase 4): meshoptimizer for `EXT_meshopt_compression` and Draco for
 * `KHR_draco_mesh_compression`. Each is fetched only the first time a file
 * needs it (a dynamic import, so neither is in the editor's bundle otherwise),
 * then kept for later imports. See gltfCompression.ts in @cartbox/editor for how
 * the decoded buffers slot back into the file.
 */

import {
  gltfCompression,
  parseGlb,
  parseGltfText,
  readGlb,
  type DracoAttributeRequest,
  type DracoDecoded,
  type GltfDecoders,
  type MeshAsset,
} from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any */

let meshopt: Promise<NonNullable<GltfDecoders["meshopt"]>> | null = null;
let draco: Promise<NonNullable<GltfDecoders["draco"]>> | null = null;

function loadMeshopt(): Promise<NonNullable<GltfDecoders["meshopt"]>> {
  meshopt ??= (async () => {
    const { MeshoptDecoder } = await import("meshoptimizer/decoder");
    await MeshoptDecoder.ready;
    return (target, count, size, source, mode, filter) => MeshoptDecoder.decodeGltfBuffer(target, count, size, source, mode, filter);
  })();
  meshopt.catch(() => {
    meshopt = null; // let a later import try again
  });
  return meshopt;
}

function loadDraco(): Promise<NonNullable<GltfDecoders["draco"]>> {
  draco ??= (async () => {
    const [{ default: createDecoderModule }, wasm] = await Promise.all([
      import("draco3d/draco_decoder_nodejs.js"),
      fetch(new URL("draco3d/draco_decoder.wasm", import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`Draco decoder failed to load (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    const decoderModule = await createDecoderModule({ wasmBinary: wasm });
    return (data: Uint8Array, attributes: readonly DracoAttributeRequest[]) => decodeDracoPrimitive(decoderModule, data, attributes);
  })();
  draco.catch(() => {
    draco = null;
  });
  return draco;
}

/** The decoders a file needs (only those are loaded). */
export async function loadGltfDecoders(needs: { meshopt: boolean; draco: boolean }): Promise<GltfDecoders> {
  const [m, d] = await Promise.all([needs.meshopt ? loadMeshopt() : undefined, needs.draco ? loadDraco() : undefined]);
  return { ...(m ? { meshopt: m } : {}), ...(d ? { draco: d } : {}) };
}

/** Parse a `.glb`, loading whichever geometry decoders it needs first. */
export async function parseGlbDecoded(bytes: Uint8Array, name: string): Promise<MeshAsset> {
  const compression = gltfCompression(readGlb(bytes).json);
  const decoders = compression.meshopt || compression.draco ? await loadGltfDecoders(compression) : {};
  return parseGlb(bytes, name, decoders);
}

/** Parse a self-contained `.gltf`, loading whichever geometry decoders it needs first. */
export async function parseGltfTextDecoded(text: string, name: string): Promise<MeshAsset> {
  const compression = gltfCompression(JSON.parse(text) as Parameters<typeof gltfCompression>[0]);
  const decoders = compression.meshopt || compression.draco ? await loadGltfDecoders(compression) : {};
  return parseGltfText(text, name, decoders);
}

const DRACO_TYPES: Record<number, { key: string; array: any }> = {
  5120: { key: "DT_INT8", array: Int8Array },
  5121: { key: "DT_UINT8", array: Uint8Array },
  5122: { key: "DT_INT16", array: Int16Array },
  5123: { key: "DT_UINT16", array: Uint16Array },
  5125: { key: "DT_UINT32", array: Uint32Array },
  5126: { key: "DT_FLOAT32", array: Float32Array },
};

/** Decode one Draco triangle mesh with an initialised decoder module (browser or Node build). */
export function decodeDracoPrimitive(draco: any, data: Uint8Array, attributes: readonly DracoAttributeRequest[]): DracoDecoded {
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  try {
    const status = decoder.DecodeArrayToMesh(data, data.byteLength, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`Draco decoding failed: ${status.error_msg()}`);
    const vertexCount: number = mesh.num_points();
    const indexCount = mesh.num_faces() * 3;
    const indices = new Uint32Array(indexCount);
    if (indexCount > 0) {
      const ptr = draco._malloc(indexCount * 4);
      try {
        decoder.GetTrianglesUInt32Array(mesh, indexCount * 4, ptr);
        indices.set(new Uint32Array(draco.HEAPU8.buffer, ptr, indexCount));
      } finally {
        draco._free(ptr);
      }
    }
    const out: Record<string, DracoDecoded["attributes"][string]> = {};
    for (const request of attributes) {
      const type = DRACO_TYPES[request.componentType];
      const attribute = decoder.GetAttributeByUniqueId(mesh, request.id);
      if (!type || !attribute || attribute.ptr === 0) continue;
      const count = vertexCount * request.components;
      const bytes = count * type.array.BYTES_PER_ELEMENT;
      const ptr = draco._malloc(bytes);
      try {
        decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco[type.key], bytes, ptr);
        out[request.semantic] = new type.array(draco.HEAPU8.buffer, ptr, count).slice();
      } finally {
        draco._free(ptr);
      }
    }
    return { vertexCount, indices, attributes: out };
  } finally {
    draco.destroy(mesh);
    draco.destroy(decoder);
  }
}

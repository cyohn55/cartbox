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
  meshoptCalls,
  parseGltf,
  readGlb,
  readGltfText,
  replayMeshopt,
  type DracoAttributeRequest,
  type DracoDecoded,
  type GltfDecoders,
  type GltfJson,
  type MeshAsset,
  type MeshoptCall,
} from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** meshoptimizer's decoder: a buffer at a time, here or (where the browser has workers) on its own pool of them. */
interface Meshopt {
  readonly decode: NonNullable<GltfDecoders["meshopt"]>;
  readonly decodeOffThread: ((call: MeshoptCall) => Promise<Uint8Array>) | null;
}

let meshopt: Promise<Meshopt> | null = null;
let draco: Promise<NonNullable<GltfDecoders["draco"]>> | null = null;

function loadMeshopt(): Promise<Meshopt> {
  meshopt ??= (async () => {
    const { MeshoptDecoder } = await import("meshoptimizer/decoder");
    await MeshoptDecoder.ready;
    // Off the main thread (AAA_FIDELITY_ROADMAP.md F0e): the decoder's own workers, two of them, where there are workers.
    const workers = typeof Worker === "function";
    if (workers) MeshoptDecoder.useWorkers(2);
    return {
      decode: (target, count, size, source, mode, filter) => MeshoptDecoder.decodeGltfBuffer(target, count, size, source, mode, filter),
      decodeOffThread: workers ? (c) => MeshoptDecoder.decodeGltfBufferAsync(c.count, c.size, c.source, c.mode, c.filter) : null,
    };
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
  return { ...(m ? { meshopt: m.decode } : {}), ...(d ? { draco: d } : {}) };
}

/**
 * The decoders for one document: its meshopt buffers decoded first on the
 * decoder's workers where there are any (F0e), then handed back as the parse
 * asks for them.
 */
async function decodersFor(json: GltfJson, buffers: readonly (Uint8Array | null)[]): Promise<GltfDecoders> {
  const compression = gltfCompression(json);
  if (!compression.meshopt && !compression.draco) return {};
  const decoders = await loadGltfDecoders(compression);
  const offThread = compression.meshopt ? (await loadMeshopt()).decodeOffThread : null;
  if (!offThread) return decoders;
  const decoded = await Promise.all(meshoptCalls(json, buffers).map(offThread));
  return { ...decoders, meshopt: replayMeshopt(decoded) };
}

/** Parse a `.glb`, loading whichever geometry decoders it needs first. */
export async function parseGlbDecoded(bytes: Uint8Array, name: string): Promise<MeshAsset> {
  const { json, buffers } = readGlb(bytes);
  return parseGltf(json, buffers, name, await decodersFor(json, buffers));
}

/** Parse a self-contained `.gltf`, loading whichever geometry decoders it needs first. */
export async function parseGltfTextDecoded(text: string, name: string): Promise<MeshAsset> {
  const { json, buffers } = readGltfText(text);
  return parseGltf(json, buffers, name, await decodersFor(json, buffers));
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

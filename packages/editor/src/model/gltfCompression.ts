/**
 * Compressed glTF geometry on import (ENGINE_ROADMAP.md, Phase 4): files
 * squeezed with meshoptimizer (`EXT_meshopt_compression`) or Draco
 * (`KHR_draco_mesh_compression`) — what gltfpack, gltf-transform and most
 * exporters' "compress" option produce — are decoded here into the plain
 * buffers the rest of the codec reads, so they import like any other file.
 *
 * The decoders themselves are WebAssembly and live with the caller (the web app
 * loads them only when a file needs one), handed in as {@link GltfDecoders}. Once
 * loaded they decode synchronously, so parsing stays synchronous too. Without the
 * decoder a file needs, import fails with a message naming the compression —
 * unless the file carries an uncompressed fallback, which is then used.
 *
 * Pure: the JSON and buffers passed in are not modified.
 */

import type { GltfAccessor, GltfBufferView, GltfJson, GltfMesh, GltfPrimitive } from "./gltfCodec";

/** A bufferView's `EXT_meshopt_compression` block. */
export interface MeshoptViewExtension {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride: number;
  count: number;
  mode: "ATTRIBUTES" | "TRIANGLES" | "INDICES";
  filter?: "NONE" | "OCTAHEDRAL" | "QUATERNION" | "EXPONENTIAL";
}

/** One attribute a Draco primitive should decode, typed as its accessor declares. */
export interface DracoAttributeRequest {
  /** The glTF semantic (POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0…). */
  readonly semantic: string;
  /** The attribute's unique id inside the Draco stream. */
  readonly id: number;
  /** glTF component type the values should come out as (5126 float, 5121/5123/5125 unsigned, 5120/5122 signed). */
  readonly componentType: number;
  readonly components: number;
}

export interface DracoDecoded {
  readonly vertexCount: number;
  readonly indices: Uint32Array;
  /** Semantic → values, `vertexCount × components`, in the requested component type. */
  readonly attributes: Readonly<Record<string, Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array>>;
}

export interface GltfDecoders {
  /** meshoptimizer's `MeshoptDecoder.decodeGltfBuffer`, once `MeshoptDecoder.ready` has resolved. */
  readonly meshopt?: (target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string) => void;
  /** Decode one Draco-compressed primitive. */
  readonly draco?: (data: Uint8Array, attributes: readonly DracoAttributeRequest[]) => DracoDecoded;
}

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Which compression a glTF document's geometry uses (and whether it can't import without the decoder). */
export function gltfCompression(json: GltfJson): { meshopt: boolean; draco: boolean; required: boolean } {
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  const required = new Set(json.extensionsRequired ?? []);
  const meshopt = used.has("EXT_meshopt_compression") || (json.bufferViews ?? []).some((v) => v.extensions?.EXT_meshopt_compression);
  const draco =
    used.has("KHR_draco_mesh_compression") ||
    (json.meshes ?? []).some((m) => m.primitives.some((p) => p.extensions?.KHR_draco_mesh_compression));
  return { meshopt, draco, required: required.has("EXT_meshopt_compression") || required.has("KHR_draco_mesh_compression") };
}

/**
 * The document with every compressed bufferView and primitive decoded into new
 * plain buffers (appended after the originals). Returns the inputs unchanged
 * when nothing is compressed.
 */
export function decompressGltf(
  json: GltfJson,
  buffers: readonly (Uint8Array | null)[],
  decoders: GltfDecoders,
): { json: GltfJson; buffers: (Uint8Array | null)[] } {
  const { meshopt, draco } = gltfCompression(json);
  if (!meshopt && !draco) return { json, buffers: [...buffers] };
  const outBuffers = [...buffers];
  const bufferViews: GltfBufferView[] = [...(json.bufferViews ?? [])];
  const accessors: GltfAccessor[] = [...(json.accessors ?? [])];
  let meshes: GltfMesh[] | undefined = json.meshes;

  const addView = (bytes: Uint8Array, byteStride?: number): number => {
    outBuffers.push(bytes);
    bufferViews.push({ buffer: outBuffers.length - 1, byteOffset: 0, byteLength: bytes.byteLength, ...(byteStride ? { byteStride } : {}) });
    return bufferViews.length - 1;
  };

  if (meshopt) {
    bufferViews.forEach((view, index) => {
      const ext = view.extensions?.EXT_meshopt_compression;
      if (!ext) return;
      if (!decoders.meshopt) {
        // An uncompressed fallback (the view's own buffer holding real data) still works.
        if (buffers[view.buffer]) return;
        throw new Error("This model uses meshopt compression, and the meshopt decoder isn't loaded.");
      }
      const source = buffers[ext.buffer];
      if (!source) throw new Error("glTF meshopt data is missing its buffer");
      const start = ext.byteOffset ?? 0;
      const target = new Uint8Array(ext.count * ext.byteStride);
      decoders.meshopt(target, ext.count, ext.byteStride, source.subarray(start, start + ext.byteLength), ext.mode, ext.filter ?? "NONE");
      outBuffers.push(target);
      bufferViews[index] = { buffer: outBuffers.length - 1, byteOffset: 0, byteLength: target.byteLength, ...(view.byteStride ? { byteStride: view.byteStride } : {}) };
    });
  }

  if (draco) {
    meshes = (json.meshes ?? []).map((mesh) => {
      if (!mesh.primitives.some((p) => p.extensions?.KHR_draco_mesh_compression)) return mesh;
      return {
        ...mesh,
        primitives: mesh.primitives.map((primitive): GltfPrimitive => {
          const ext = primitive.extensions?.KHR_draco_mesh_compression;
          if (!ext) return primitive;
          if (!decoders.draco) throw new Error("This model uses Draco compression, and the Draco decoder isn't loaded.");
          const view = bufferViews[ext.bufferView];
          const source = view ? outBuffers[view.buffer] : null;
          if (!view || !source) throw new Error("glTF Draco data is missing its buffer");
          const start = view.byteOffset ?? 0;
          const requests: DracoAttributeRequest[] = [];
          for (const [semantic, id] of Object.entries(ext.attributes)) {
            const accessorIndex = (primitive.attributes as Record<string, number | undefined>)[semantic];
            const accessor = accessorIndex === undefined ? undefined : accessors[accessorIndex];
            if (!accessor) continue;
            requests.push({ semantic, id, componentType: accessor.componentType, components: TYPE_COMPONENTS[accessor.type] ?? 1 });
          }
          const decoded = decoders.draco(source.subarray(start, start + view.byteLength), requests);
          const attributes: Record<string, number> = { ...primitive.attributes };
          for (const request of requests) {
            const values = decoded.attributes[request.semantic];
            if (!values) continue;
            const original = accessors[attributes[request.semantic]!]!;
            accessors.push({
              ...original,
              bufferView: addView(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)),
              byteOffset: 0,
              count: decoded.vertexCount,
            });
            attributes[request.semantic] = accessors.length - 1;
          }
          accessors.push({
            bufferView: addView(new Uint8Array(decoded.indices.buffer, decoded.indices.byteOffset, decoded.indices.byteLength)),
            componentType: 5125,
            count: decoded.indices.length,
            type: "SCALAR",
          });
          const { extensions: _drop, ...rest } = primitive;
          void _drop;
          return { ...rest, attributes, indices: accessors.length - 1 };
        }),
      };
    });
  }

  return { json: { ...json, bufferViews, accessors, ...(meshes ? { meshes } : {}) }, buffers: outBuffers };
}

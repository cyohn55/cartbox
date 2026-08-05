/**
 * A triangle-mesh asset — the editor's first true polygon-geometry type, sitting
 * alongside the voxel {@link VoxelGrid} rather than replacing it. A mesh is
 * imported from OBJ or glTF/GLB (see the codecs), previewed and transformed in
 * the editor, rasterised at runtime by the player, and re-exported.
 *
 * The model is deliberately small and flat:
 *
 * - A mesh is a list of {@link MeshPrimitive}s, each a triangle list with its own
 *   material. glTF's node hierarchy is baked into world-space vertex positions at
 *   import (see {@link parseGlb}), so a primitive is a plain buffer of geometry in
 *   one object space — the runtime then applies a single model matrix per instance.
 * - Geometry is stored the way the GPU and the software rasteriser both want it:
 *   de-indexed attribute streams (`positions`, `normals`, `uvs`) plus a triangle
 *   `indices` buffer. Normals and UVs are optional; a mesh without normals can
 *   have smooth ones derived with {@link computeSmoothNormals}.
 * - A material carries a base-colour factor and, optionally, one embedded
 *   base-colour image kept as its original compressed bytes (see
 *   {@link EncodedImage}) — decoding is the browser's job, and storing the
 *   compressed form keeps the sidecar far smaller than raw RGBA would.
 *
 * Pure and DOM-free: the same types feed the editor UI, the runtime rasteriser,
 * and the unit tests, and serialise to a compact JSON string for a cart sidecar.
 */

import { bytesToBase64, base64ToBytes } from "./base64";

/** Serialized-format version, bumped on any schema change. */
export const MESH_ASSET_VERSION = 1;

// Defensive caps for untrusted input (a mesh can arrive from another user's cart
// or an arbitrary uploaded file): large enough for real props, small enough that
// a malformed header can't drive a multi-gigabyte allocation.
export const MAX_MESH_VERTICES = 4_000_000;
export const MAX_MESH_INDICES = 12_000_000;

/** A compressed image (PNG/JPEG) kept in its original bytes; decoded on demand. */
export interface EncodedImage {
  /** MIME type, e.g. `"image/png"` — governs how a consumer decodes `bytes`. */
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/** A primitive's surface appearance: a base colour, optionally textured. */
export interface MeshMaterial {
  readonly name: string;
  /** Straight-alpha RGBA multiplier in 0..1, glTF's `baseColorFactor`. */
  readonly baseColorFactor: readonly [number, number, number, number];
  /** The base-colour (albedo) texture, or null for a flat-coloured surface. */
  readonly baseColorImage: EncodedImage | null;
}

/** One triangle list with a single material. */
export interface MeshPrimitive {
  /** Interleave-free vertex positions, `x,y,z` per vertex. */
  readonly positions: Float32Array;
  /** Per-vertex normals (`x,y,z`), or null when the source had none. */
  readonly normals: Float32Array | null;
  /** Per-vertex texture coordinates (`u,v`), or null when untextured. */
  readonly uvs: Float32Array | null;
  /** Triangle vertex indices (three per triangle) into the attribute streams. */
  readonly indices: Uint32Array;
  readonly material: MeshMaterial;
}

/** A named mesh: one or more primitives in a shared object space. */
export interface MeshAsset {
  readonly name: string;
  readonly primitives: readonly MeshPrimitive[];
}

/** A neutral, fully-opaque white material — the default when a source names none. */
export function defaultMaterial(name = "default"): MeshMaterial {
  return { name, baseColorFactor: [1, 1, 1, 1], baseColorImage: null };
}

/** Total vertices across every primitive. */
export function meshVertexCount(mesh: MeshAsset): number {
  return mesh.primitives.reduce((sum, primitive) => sum + primitive.positions.length / 3, 0);
}

/** Total triangles across every primitive. */
export function meshTriangleCount(mesh: MeshAsset): number {
  return mesh.primitives.reduce((sum, primitive) => sum + primitive.indices.length / 3, 0);
}

/** The axis-aligned bounds of every vertex, or null for an empty mesh. */
export interface MeshBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Compute the mesh's world-space AABB — what the editor frames and the importer fits. */
export function meshBounds(mesh: MeshAsset): MeshBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const primitive of mesh.primitives) {
    const p = primitive.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const y = p[i + 1]!;
      const z = p[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (minX > maxX) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * Derive per-vertex normals by area-weighted averaging of the adjacent triangle
 * faces — the standard fallback for geometry that arrived without normals, so the
 * rasteriser and the preview always have a surface direction to light. Averaging
 * keeps the shared-vertex indexing intact (flat shading would require splitting
 * every vertex); the weighting falls out of using the un-normalised cross
 * product, whose length is twice the triangle area.
 */
export function computeSmoothNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]! * 3;
    const ib = indices[t + 1]! * 3;
    const ic = indices[t + 2]! * 3;
    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const ex1 = positions[ib]! - ax;
    const ey1 = positions[ib + 1]! - ay;
    const ez1 = positions[ib + 2]! - az;
    const ex2 = positions[ic]! - ax;
    const ey2 = positions[ic + 1]! - ay;
    const ez2 = positions[ic + 2]! - az;
    // Face normal (un-normalised): its magnitude weights by twice the face area.
    const nx = ey1 * ez2 - ez1 * ey2;
    const ny = ez1 * ex2 - ex1 * ez2;
    const nz = ex1 * ey2 - ey1 * ex2;
    for (const base of [ia, ib, ic]) {
      normals[base] = normals[base]! + nx;
      normals[base + 1] = normals[base + 1]! + ny;
      normals[base + 2] = normals[base + 2]! + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = normals[i]! / length;
    normals[i + 1] = normals[i + 1]! / length;
    normals[i + 2] = normals[i + 2]! / length;
  }
  return normals;
}

// --- Serialization --------------------------------------------------------

/** LE base64 of a Float32Array's exact bytes (all target platforms are little-endian). */
function f32ToBase64(array: Float32Array): string {
  return bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}
function base64ToF32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  // Copy into a fresh, 4-aligned buffer — a decoded byte array need not be aligned.
  return new Float32Array(bytes.slice().buffer);
}
function u32ToBase64(array: Uint32Array): string {
  return bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}
function base64ToU32(base64: string): Uint32Array {
  const bytes = base64ToBytes(base64);
  return new Uint32Array(bytes.slice().buffer);
}

interface SerializedMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  image: { mime: string; bytes: string } | null;
}
interface SerializedPrimitive {
  positions: string;
  normals: string | null;
  uvs: string | null;
  indices: string;
  material: SerializedMaterial;
}
interface SerializedMesh {
  version: number;
  name: string;
  primitives: SerializedPrimitive[];
}

/** Serialize a mesh to a compact JSON string for storage in a cart sidecar. */
export function serializeMeshAsset(mesh: MeshAsset): string {
  const payload: SerializedMesh = {
    version: MESH_ASSET_VERSION,
    name: mesh.name,
    primitives: mesh.primitives.map((primitive) => ({
      positions: f32ToBase64(primitive.positions),
      normals: primitive.normals ? f32ToBase64(primitive.normals) : null,
      uvs: primitive.uvs ? f32ToBase64(primitive.uvs) : null,
      indices: u32ToBase64(primitive.indices),
      material: {
        name: primitive.material.name,
        baseColorFactor: [...primitive.material.baseColorFactor],
        image: primitive.material.baseColorImage
          ? {
              mime: primitive.material.baseColorImage.mime,
              bytes: bytesToBase64(primitive.material.baseColorImage.bytes),
            }
          : null,
      },
    })),
  };
  return JSON.stringify(payload);
}

const MALFORMED = "Mesh asset payload is malformed";

function toColor(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number")) {
    return [value[0], value[1], value[2], value[3]] as [number, number, number, number];
  }
  return [1, 1, 1, 1];
}

/**
 * Parse a serialized mesh, rejecting anything malformed or oversized — the bytes
 * are untrusted (another user's cart, or an arbitrary file). Every attribute
 * stream is length-checked against the others so a consumer can index it without
 * its own bounds checks, and every triangle index is verified in range.
 */
export function deserializeMeshAsset(json: string): MeshAsset {
  const raw = JSON.parse(json) as Partial<SerializedMesh>;
  if (raw.version !== MESH_ASSET_VERSION) throw new Error(`Unsupported mesh asset version: ${String(raw.version)}`);
  if (!Array.isArray(raw.primitives)) throw new Error(MALFORMED);

  let totalVertices = 0;
  let totalIndices = 0;
  const primitives: MeshPrimitive[] = raw.primitives.map((entry) => {
    const positions = base64ToF32(entry.positions);
    if (positions.length === 0 || positions.length % 3 !== 0) throw new Error(MALFORMED);
    const vertexCount = positions.length / 3;

    const normals = entry.normals ? base64ToF32(entry.normals) : null;
    if (normals && normals.length !== vertexCount * 3) throw new Error(MALFORMED);
    const uvs = entry.uvs ? base64ToF32(entry.uvs) : null;
    if (uvs && uvs.length !== vertexCount * 2) throw new Error(MALFORMED);

    const indices = base64ToU32(entry.indices);
    if (indices.length === 0 || indices.length % 3 !== 0) throw new Error(MALFORMED);
    for (let i = 0; i < indices.length; i += 1) if (indices[i]! >= vertexCount) throw new Error(MALFORMED);

    totalVertices += vertexCount;
    totalIndices += indices.length;
    if (totalVertices > MAX_MESH_VERTICES || totalIndices > MAX_MESH_INDICES) throw new Error(MALFORMED);

    const material = entry.material ?? { name: "default", baseColorFactor: [1, 1, 1, 1], image: null };
    return {
      positions,
      normals,
      uvs,
      indices,
      material: {
        name: typeof material.name === "string" ? material.name : "default",
        baseColorFactor: toColor(material.baseColorFactor),
        baseColorImage: material.image
          ? { mime: String(material.image.mime), bytes: base64ToBytes(material.image.bytes) }
          : null,
      },
    };
  });

  if (primitives.length === 0) throw new Error(MALFORMED);
  return { name: typeof raw.name === "string" ? raw.name : "mesh", primitives };
}

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

/**
 * A rectangle of the cart's sprite sheet (page + pixel bounds) that a mesh
 * texture is authored in. When set, the editor treats the scene's texture as an
 * editable cart asset: it rebakes {@link MeshMaterial.baseColorImage} from these
 * sprite pixels (through the cart palette) whenever the cart is playtested or
 * saved, so editing the sprite in the Assets tab changes the 3D scene.
 *
 * It is purely an editor authoring link. The runtime never reads it — it samples
 * the already-baked `baseColorImage` — so a published cart renders identically
 * whether or not it carries this reference.
 */
export interface SpriteTextureRef {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A primitive's surface appearance: a base colour, optionally textured. */
export interface MeshMaterial {
  readonly name: string;
  /** Straight-alpha RGBA multiplier in 0..1, glTF's `baseColorFactor`. */
  readonly baseColorFactor: readonly [number, number, number, number];
  /** The base-colour (albedo) texture, or null for a flat-coloured surface. */
  readonly baseColorImage: EncodedImage | null;
  /**
   * A tangent-space normal map (RGB = normal·0.5+0.5), or null/absent for a
   * surface lit only by its geometry. Baked from the source sprite's Normal
   * layer alongside {@link baseColorImage}; the rasteriser perturbs the geometric
   * normal by it for per-pixel lighting (option 2). Optional so the many
   * materials without one need not spell it out.
   */
  readonly normalImage?: EncodedImage | null;
  /**
   * A packed surface-material map (RGBA: R = height, G = specular strength,
   * B = roughness, A = emissive; each 0..255), or null/absent for a plain
   * diffuse surface. Baked from the source sprite's Material layer alongside
   * {@link baseColorImage}; the rasteriser reads specular/roughness for a
   * view-dependent Blinn-Phong highlight and emissive for a self-illumination
   * floor (option 2, slice 5). Optional so the many materials without one — flat
   * primitives, imported meshes, world tiles — need not spell it out.
   */
  readonly materialImage?: EncodedImage | null;
  /**
   * --- PBR (metallic-roughness) channels, for the "Modern" render tier ---
   * These mirror glTF 2.0's metallic-roughness model so an imported asset keeps
   * its authored surface response. All optional and defaulting to a plain diffuse
   * surface, so a fantasy-console material that sets none renders exactly as
   * before — the AAA tier is purely additive (see AAA_TIER_ROADMAP.md).
   *
   * A packed metallic-roughness map, glTF's `metallicRoughnessTexture`
   * (G = roughness, B = metallic), or null/absent.
   */
  readonly metallicRoughnessImage?: EncodedImage | null;
  /** An ambient-occlusion map, glTF's `occlusionTexture` (R = AO), or null/absent. */
  readonly occlusionImage?: EncodedImage | null;
  /** An emissive map, glTF's `emissiveTexture` (RGB), or null/absent. */
  readonly emissiveImage?: EncodedImage | null;
  /** Scalar metalness multiplier, glTF's `metallicFactor` (default 1). */
  readonly metallicFactor?: number;
  /** Scalar roughness multiplier, glTF's `roughnessFactor` (default 1). */
  readonly roughnessFactor?: number;
  /** RGB emissive multiplier, glTF's `emissiveFactor` (default [0,0,0]). */
  readonly emissiveFactor?: readonly [number, number, number];
  /**
   * The sprite-sheet region this texture is authored from, or null/absent for a
   * texture that is not sprite-backed (an imported mesh, a flat colour). Optional
   * so the many materials that never carry one — codecs, world tiles, flat
   * primitives — need not spell it out. See {@link SpriteTextureRef}.
   */
  readonly textureSprite?: SpriteTextureRef | null;
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
  return { name, baseColorFactor: [1, 1, 1, 1], baseColorImage: null, textureSprite: null };
}

/**
 * Return a copy of `mesh` with one primitive's material patched — the pure edit
 * behind the material editor (Phase 6). Only the named fields change; the rest of
 * the material (its textures, sprite ref) and every other primitive are shared by
 * reference, so an edit allocates only the changed primitive. An out-of-range
 * index returns the mesh unchanged.
 */
export function updateMeshMaterial(
  mesh: MeshAsset,
  primitiveIndex: number,
  patch: Partial<MeshMaterial>,
): MeshAsset {
  if (primitiveIndex < 0 || primitiveIndex >= mesh.primitives.length) return mesh;
  return {
    ...mesh,
    primitives: mesh.primitives.map((primitive, i) =>
      i === primitiveIndex ? { ...primitive, material: { ...primitive.material, ...patch } } : primitive,
    ),
  };
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

interface SerializedImage {
  mime: string;
  bytes: string;
}
interface SerializedMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  image: SerializedImage | null;
  normalImage?: SerializedImage | null;
  materialImage?: SerializedImage | null;
  metallicRoughnessImage?: SerializedImage | null;
  occlusionImage?: SerializedImage | null;
  emissiveImage?: SerializedImage | null;
  metallicFactor?: number;
  roughnessFactor?: number;
  emissiveFactor?: [number, number, number];
  textureSprite?: SpriteTextureRef | null;
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
        normalImage: primitive.material.normalImage
          ? {
              mime: primitive.material.normalImage.mime,
              bytes: bytesToBase64(primitive.material.normalImage.bytes),
            }
          : null,
        materialImage: primitive.material.materialImage
          ? {
              mime: primitive.material.materialImage.mime,
              bytes: bytesToBase64(primitive.material.materialImage.bytes),
            }
          : null,
        metallicRoughnessImage: serializeImage(primitive.material.metallicRoughnessImage),
        occlusionImage: serializeImage(primitive.material.occlusionImage),
        emissiveImage: serializeImage(primitive.material.emissiveImage),
        metallicFactor: primitive.material.metallicFactor,
        roughnessFactor: primitive.material.roughnessFactor,
        emissiveFactor: primitive.material.emissiveFactor ? [...primitive.material.emissiveFactor] : undefined,
        textureSprite: primitive.material.textureSprite ?? null,
      },
    })),
  };
  return JSON.stringify(payload);
}

/** Encode an optional image to the serialized form (null when absent). */
function serializeImage(image: EncodedImage | null | undefined): SerializedImage | null {
  return image ? { mime: image.mime, bytes: bytesToBase64(image.bytes) } : null;
}
/** Decode an optional serialized image back to bytes (null when absent). */
function deserializeImage(image: SerializedImage | null | undefined): EncodedImage | null {
  return image ? { mime: String(image.mime), bytes: base64ToBytes(image.bytes) } : null;
}

const MALFORMED = "Mesh asset payload is malformed";

function toColor(value: unknown): [number, number, number, number] {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number")) {
    return [value[0], value[1], value[2], value[3]] as [number, number, number, number];
  }
  return [1, 1, 1, 1];
}

/** Validate an optional emissive factor triple, dropping anything malformed. */
function toEmissiveFactor(value: unknown): [number, number, number] | undefined {
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [value[0], value[1], value[2]] as [number, number, number];
  }
  return undefined;
}

/** Validate an untrusted sprite-texture reference, dropping anything malformed. */
function toTextureSprite(value: unknown): SpriteTextureRef | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  const nums = [ref.page, ref.x, ref.y, ref.width, ref.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  if ((ref.width as number) <= 0 || (ref.height as number) <= 0) return null;
  return {
    page: ref.page as number,
    x: ref.x as number,
    y: ref.y as number,
    width: ref.width as number,
    height: ref.height as number,
  };
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
        normalImage: material.normalImage
          ? { mime: String(material.normalImage.mime), bytes: base64ToBytes(material.normalImage.bytes) }
          : null,
        materialImage: material.materialImage
          ? { mime: String(material.materialImage.mime), bytes: base64ToBytes(material.materialImage.bytes) }
          : null,
        metallicRoughnessImage: deserializeImage(material.metallicRoughnessImage),
        occlusionImage: deserializeImage(material.occlusionImage),
        emissiveImage: deserializeImage(material.emissiveImage),
        metallicFactor: typeof material.metallicFactor === "number" ? material.metallicFactor : undefined,
        roughnessFactor: typeof material.roughnessFactor === "number" ? material.roughnessFactor : undefined,
        emissiveFactor: toEmissiveFactor(material.emissiveFactor),
        textureSprite: toTextureSprite(material.textureSprite),
      },
    };
  });

  if (primitives.length === 0) throw new Error(MALFORMED);
  return { name: typeof raw.name === "string" ? raw.name : "mesh", primitives };
}

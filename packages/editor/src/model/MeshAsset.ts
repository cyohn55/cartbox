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
import { readSurfaceEffects, writeSurfaceEffects } from "./materialEffects";
import {
  MAX_CLIP_KEYS,
  MAX_CLIPS,
  MAX_SKIN_JOINTS,
  type AnimationClip,
  type ClipChannel,
  type MeshSkin,
  type SkinJoint,
} from "./skeleton";

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
  /**
   * A streamed texture's placeholder: `bytes` is empty until the player is
   * handed the image for this ref (an asset-backed texture's content hash).
   */
  readonly ref?: string;
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
  /**
   * A baked light map (RGB), sampled with the primitive's second UV set
   * ({@link MeshPrimitive.uvs2}): how much sky and bounced light reaches each
   * point, multiplying the ambient / image-based light (see lightBake.ts).
   * Null/absent: lit only by the scene's live lighting.
   */
  readonly lightmapImage?: EncodedImage | null;
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
  /**
   * Whether a cart may recolour this material at runtime through a pose's tint
   * (`cartbox.meshpose(..., tint)`) — e.g. a character's armour paint, so one
   * mesh serves every team colour. Absent/false: tints never touch it.
   */
  readonly tintable?: boolean;
  // --- Surface effects (HALO2_STYLE_ROADMAP.md, H3; see materialEffects.ts) ---
  /**
   * A finely tiled detail map blended into the albedo up close (it fades out
   * with distance): mid-grey changes nothing, lighter brightens, darker grimes.
   */
  readonly detailImage?: EncodedImage | null;
  /** Detail tiles per base UV unit (default 8). */
  readonly detailScale?: number;
  /** How strongly the detail map shows, 0..1 (default 0.5). */
  readonly detailStrength?: number;
  /** Scroll the emissive map, UV units per second, so energy lines flow. */
  readonly emissiveScroll?: readonly [number, number];
  /** Pulse the emissive glow: `rate` cycles per second, dipping by `depth` (0..1) at the trough. */
  readonly emissivePulse?: { readonly rate: number; readonly depth: number };
  /** A fresnel rim: light of `color` × `strength` at grazing angles, tightening as `power` rises. */
  readonly rim?: { readonly color: readonly [number, number, number]; readonly power: number; readonly strength: number };
  /** Scales reflections of the sky and probes (default 1). */
  readonly reflectivity?: number;
  /** Mask reflections per texel by the metallic-roughness map's alpha (opaque = full). */
  readonly reflectionMask?: boolean;
  // --- A second surface blended in per vertex (HALO2_STYLE_ROADMAP.md H4) ---
  /**
   * Where a primitive carries per-vertex {@link MeshPrimitive.blend} weights,
   * its albedo and roughness mix toward this second surface by them — snow
   * drifting over rock without a hard edge between triangles. The image is
   * sampled with the same UVs; the colour multiplies it (or stands alone).
   */
  readonly blendImage?: EncodedImage | null;
  readonly blendColor?: readonly [number, number, number];
  readonly blendRoughness?: number;
}

/** One triangle list with a single material. */
export interface MeshPrimitive {
  /** Interleave-free vertex positions, `x,y,z` per vertex. */
  readonly positions: Float32Array;
  /** Per-vertex normals (`x,y,z`), or null when the source had none. */
  readonly normals: Float32Array | null;
  /** Per-vertex weight (0..1) of the material's blend surface ({@link MeshMaterial.blendImage}), or absent. */
  readonly blend?: Float32Array;
  /** Per-vertex texture coordinates (`u,v`), or null when untextured. */
  readonly uvs: Float32Array | null;
  /** Triangle vertex indices (three per triangle) into the attribute streams. */
  readonly indices: Uint32Array;
  readonly material: MeshMaterial;
  /**
   * A second set of texture coordinates, unique per surface point, that the
   * material's light map is sampled with (the first set tiles). Null/absent
   * without a light map.
   */
  readonly uvs2?: Float32Array | null;
  /**
   * Skinned meshes only (see skeleton.ts): four joint indices and four weights
   * per vertex, binding it to the mesh's {@link MeshAsset.skin}.
   */
  readonly joints?: Uint16Array | null;
  readonly weights?: Float32Array | null;
  /**
   * Set on a live skinned copy whose positions/normals are rewritten each frame:
   * renderers that cache uploaded geometry re-upload when `revision` changes.
   * Never serialized.
   */
  readonly dynamic?: { revision: number };
}

/** A named mesh: one or more primitives in a shared object space. */
export interface MeshAsset {
  readonly name: string;
  readonly primitives: readonly MeshPrimitive[];
  /** The skeleton skinned primitives are bound to (ENGINE_ROADMAP.md, Phase 3), if any. */
  readonly skin?: MeshSkin | null;
  /** Animation clips that move the skeleton. */
  readonly clips?: readonly AnimationClip[];
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
  bytes?: string;
  ref?: string;
  /**
   * The same image as an earlier slot of this mesh, named `<primitive>.<field>`
   * (`"0.lightmapImage"`), so it is stored once — a light map shared by every
   * primitive of a mesh, say.
   */
  same?: string;
  /** An asset-store reference (content hash) in place of `bytes` (see meshTextureAssets.ts in the web app). */
  asset?: string;
}
export interface SerializedMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  image: SerializedImage | null;
  normalImage?: SerializedImage | null;
  materialImage?: SerializedImage | null;
  metallicRoughnessImage?: SerializedImage | null;
  occlusionImage?: SerializedImage | null;
  emissiveImage?: SerializedImage | null;
  lightmapImage?: SerializedImage | null;
  metallicFactor?: number;
  roughnessFactor?: number;
  emissiveFactor?: [number, number, number];
  textureSprite?: SpriteTextureRef | null;
  tintable?: boolean;
  detailImage?: SerializedImage | null;
  detailScale?: number;
  detailStrength?: number;
  emissiveScroll?: [number, number];
  emissivePulse?: { rate: number; depth: number };
  rim?: { color: [number, number, number]; power: number; strength: number };
  reflectivity?: number;
  reflectionMask?: boolean;
  blendImage?: SerializedImage | null;
  blendColor?: [number, number, number];
  blendRoughness?: number;
}
interface SerializedPrimitive {
  positions: string;
  normals: string | null;
  uvs: string | null;
  uvs2?: string;
  blend?: string;
  indices: string;
  material: SerializedMaterial;
  joints?: string;
  weights?: string;
}
interface SerializedJoint {
  name: string;
  parent: number;
  t: number[];
  r: number[];
  s: number[];
  base?: number[];
}
interface SerializedClip {
  name: string;
  duration: number;
  channels: { joint: number; path: string; interp?: string; times: string; values: string }[];
}
interface SerializedMesh {
  version: number;
  name: string;
  primitives: SerializedPrimitive[];
  skin?: { joints: SerializedJoint[]; inverseBind: string };
  clips?: SerializedClip[];
}

function u16ToBase64(array: Uint16Array): string {
  return bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
}
function base64ToU16(base64: string): Uint16Array {
  const bytes = base64ToBytes(base64);
  if (bytes.length % 2 !== 0) throw new Error("Mesh asset payload is malformed");
  return new Uint16Array(bytes.slice().buffer);
}

function serializeSkin(skin: MeshSkin): NonNullable<SerializedMesh["skin"]> {
  return {
    joints: skin.joints.map((j) => ({
      name: j.name,
      parent: j.parent,
      t: [...j.translation],
      r: [...j.rotation],
      s: [...j.scale],
      ...(j.base ? { base: [...j.base] } : {}),
    })),
    inverseBind: f32ToBase64(skin.inverseBind),
  };
}

function serializeClip(clip: AnimationClip): SerializedClip {
  return {
    name: clip.name,
    duration: clip.duration,
    channels: clip.channels.map((c) => ({
      joint: c.joint,
      path: c.path,
      ...(c.interpolation === "step" ? { interp: "step" } : {}),
      times: f32ToBase64(c.times),
      values: f32ToBase64(c.values),
    })),
  };
}

const finiteList = (value: unknown, length: number): number[] | null =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as number[]) : null;

/** Validate an untrusted skeleton: parents in range and acyclic, one inverse bind per joint. */
function deserializeSkin(raw: unknown): MeshSkin | null {
  if (!raw || typeof raw !== "object") return null;
  const { joints, inverseBind } = raw as { joints?: unknown; inverseBind?: unknown };
  if (!Array.isArray(joints) || joints.length === 0 || joints.length > MAX_SKIN_JOINTS || typeof inverseBind !== "string") {
    throw new Error("Mesh asset payload is malformed");
  }
  const n = joints.length;
  const out: SkinJoint[] = joints.map((j: SerializedJoint) => {
    const t = finiteList(j?.t, 3);
    const r = finiteList(j?.r, 4);
    const sc = finiteList(j?.s, 3);
    const parent = typeof j?.parent === "number" && Number.isInteger(j.parent) && j.parent >= -1 && j.parent < n ? j.parent : null;
    if (!t || !r || !sc || parent === null) throw new Error("Mesh asset payload is malformed");
    const base = finiteList(j.base, 16);
    return {
      name: typeof j.name === "string" ? j.name.slice(0, 64) : "joint",
      parent,
      translation: [t[0]!, t[1]!, t[2]!],
      rotation: [r[0]!, r[1]!, r[2]!, r[3]!],
      scale: [sc[0]!, sc[1]!, sc[2]!],
      ...(base ? { base } : {}),
    };
  });
  // No cycles: every chain of parents reaches a root within n steps.
  out.forEach((_, start) => {
    let j = start;
    for (let steps = 0; j >= 0; steps += 1) {
      if (steps > n) throw new Error("Mesh asset payload is malformed");
      j = out[j]!.parent;
    }
  });
  const ibm = base64ToF32(inverseBind);
  if (ibm.length !== n * 16) throw new Error("Mesh asset payload is malformed");
  return { joints: out, inverseBind: ibm };
}

/** Validate untrusted clips against a skeleton of `jointCount` joints. */
function deserializeClips(raw: unknown, jointCount: number): AnimationClip[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_CLIPS) throw new Error("Mesh asset payload is malformed");
  let keys = 0;
  return raw.map((clip: SerializedClip) => {
    if (!clip || !Array.isArray(clip.channels)) throw new Error("Mesh asset payload is malformed");
    const channels: ClipChannel[] = clip.channels.map((c) => {
      const path = c?.path === "translation" || c?.path === "rotation" || c?.path === "scale" ? c.path : null;
      if (!path || !Number.isInteger(c.joint) || c.joint < 0 || c.joint >= jointCount) throw new Error("Mesh asset payload is malformed");
      const times = base64ToF32(c.times);
      const values = base64ToF32(c.values);
      const width = path === "rotation" ? 4 : 3;
      if (times.length === 0 || values.length !== times.length * width) throw new Error("Mesh asset payload is malformed");
      for (let i = 0; i < times.length; i += 1) {
        if (!Number.isFinite(times[i]!) || (i > 0 && times[i]! < times[i - 1]!)) throw new Error("Mesh asset payload is malformed");
      }
      if (!values.every(Number.isFinite)) throw new Error("Mesh asset payload is malformed");
      keys += times.length;
      if (keys > MAX_CLIP_KEYS) throw new Error("Mesh asset payload is malformed");
      return { joint: c.joint, path, interpolation: c.interp === "step" ? "step" : "linear", times, values };
    });
    const duration = typeof clip.duration === "number" && Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0;
    return { name: typeof clip.name === "string" ? clip.name.slice(0, 64) : "clip", duration, channels };
  });
}

/** Serialize a mesh to a compact JSON string for storage in a cart sidecar. */
export function serializeMeshAsset(mesh: MeshAsset): string {
  const images = newImageTable();
  const payload: SerializedMesh = {
    version: MESH_ASSET_VERSION,
    name: mesh.name,
    primitives: mesh.primitives.map((primitive, index) => ({
      positions: f32ToBase64(primitive.positions),
      normals: primitive.normals ? f32ToBase64(primitive.normals) : null,
      uvs: primitive.uvs ? f32ToBase64(primitive.uvs) : null,
      ...(primitive.uvs2 ? { uvs2: f32ToBase64(primitive.uvs2) } : {}),
      ...(primitive.blend ? { blend: f32ToBase64(primitive.blend) } : {}),
      indices: u32ToBase64(primitive.indices),
      material: serializeMaterial(primitive.material, Object.assign(images, { primitive: index })),
      ...(primitive.joints && primitive.weights && mesh.skin
        ? { joints: u16ToBase64(primitive.joints), weights: f32ToBase64(primitive.weights) }
        : {}),
    })),
    ...(mesh.skin ? { skin: serializeSkin(mesh.skin) } : {}),
    ...(mesh.skin && mesh.clips && mesh.clips.length > 0 ? { clips: mesh.clips.map(serializeClip) } : {}),
  };
  return JSON.stringify(payload);
}

/**
 * The images of one mesh as they are written (each distinct image object once,
 * under the slot it first fills) and read back (by slot), so an image several
 * primitives share is stored once and comes back as one shared object.
 */
interface ImageTable {
  readonly written: Map<EncodedImage, string>;
  readonly read: Map<string, EncodedImage>;
  /** The primitive whose material is being written or read. */
  primitive: number;
}
const newImageTable = (): ImageTable => ({ written: new Map(), read: new Map(), primitive: 0 });

/** Encode an optional image to the serialized form (null when absent). */
function serializeImage(image: EncodedImage | null | undefined, field: string, table?: ImageTable): SerializedImage | null {
  if (!image) return null;
  const same = table?.written.get(image);
  if (same !== undefined) return { mime: image.mime, same };
  table?.written.set(image, `${table.primitive}.${field}`);
  return { mime: image.mime, bytes: bytesToBase64(image.bytes), ...(image.ref ? { ref: image.ref } : {}) };
}
/** Decode an optional serialized image back to bytes (null when absent). */
function deserializeImage(image: SerializedImage | null | undefined, field: string, table?: ImageTable): EncodedImage | null {
  if (!image) return null;
  if (image.same !== undefined) return (typeof image.same === "string" && table?.read.get(image.same)) || null;
  const decoded = decodeImage(image);
  table?.read.set(`${table.primitive}.${field}`, decoded);
  return decoded;
}
function decodeImage(image: SerializedImage): EncodedImage {
  // A texture whose bytes live elsewhere — a streamed placeholder (`ref`) or an
  // asset-store reference (`asset`, its content hash) — decodes to a
  // placeholder the player fills in when the bytes arrive.
  const ref = typeof image.ref === "string" ? image.ref : typeof image.asset === "string" ? image.asset : undefined;
  return { mime: String(image.mime ?? "image/png"), bytes: base64ToBytes(image.bytes ?? ""), ...(ref ? { ref } : {}) };
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

/** Encode a material (with its images) to the stored form — shared with the terrain codec. */
export function serializeMaterial(material: MeshMaterial, table?: ImageTable): SerializedMaterial {
  return {
    name: material.name,
    baseColorFactor: [...material.baseColorFactor],
    image: serializeImage(material.baseColorImage, "image", table),
    normalImage: serializeImage(material.normalImage, "normalImage", table),
    materialImage: serializeImage(material.materialImage, "materialImage", table),
    metallicRoughnessImage: serializeImage(material.metallicRoughnessImage, "metallicRoughnessImage", table),
    occlusionImage: serializeImage(material.occlusionImage, "occlusionImage", table),
    emissiveImage: serializeImage(material.emissiveImage, "emissiveImage", table),
    ...(material.lightmapImage ? { lightmapImage: serializeImage(material.lightmapImage, "lightmapImage", table) } : {}),
    metallicFactor: material.metallicFactor,
    roughnessFactor: material.roughnessFactor,
    emissiveFactor: material.emissiveFactor ? [...material.emissiveFactor] : undefined,
    textureSprite: material.textureSprite ?? null,
    ...(material.tintable ? { tintable: true } : {}),
    ...(material.detailImage ? { detailImage: serializeImage(material.detailImage, "detailImage", table) } : {}),
    ...(material.blendImage ? { blendImage: serializeImage(material.blendImage, "blendImage", table) } : {}),
    ...writeSurfaceEffects(material),
  };
}

/** Decode a stored material defensively (anything missing falls back to the default). */
export function deserializeMaterial(value: unknown, table?: ImageTable): MeshMaterial {
  const material = (value && typeof value === "object" ? value : { name: "default", baseColorFactor: [1, 1, 1, 1], image: null }) as SerializedMaterial;
  return {
    name: typeof material.name === "string" ? material.name : "default",
    baseColorFactor: toColor(material.baseColorFactor),
    baseColorImage: deserializeImage(material.image, "image", table),
    normalImage: deserializeImage(material.normalImage, "normalImage", table),
    materialImage: deserializeImage(material.materialImage, "materialImage", table),
    metallicRoughnessImage: deserializeImage(material.metallicRoughnessImage, "metallicRoughnessImage", table),
    occlusionImage: deserializeImage(material.occlusionImage, "occlusionImage", table),
    emissiveImage: deserializeImage(material.emissiveImage, "emissiveImage", table),
    ...(material.lightmapImage ? { lightmapImage: deserializeImage(material.lightmapImage, "lightmapImage", table) } : {}),
    metallicFactor: typeof material.metallicFactor === "number" ? material.metallicFactor : undefined,
    roughnessFactor: typeof material.roughnessFactor === "number" ? material.roughnessFactor : undefined,
    emissiveFactor: toEmissiveFactor(material.emissiveFactor),
    textureSprite: toTextureSprite(material.textureSprite),
    ...(material.tintable === true ? { tintable: true } : {}),
    ...(material.detailImage ? { detailImage: deserializeImage(material.detailImage, "detailImage", table) } : {}),
    ...(material.blendImage ? { blendImage: deserializeImage(material.blendImage, "blendImage", table) } : {}),
    ...readSurfaceEffects(material),
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
  const images = newImageTable();
  const skin = raw.skin ? deserializeSkin(raw.skin) : null;
  const primitives: MeshPrimitive[] = raw.primitives.map((entry, index) => {
    const positions = base64ToF32(entry.positions);
    if (positions.length === 0 || positions.length % 3 !== 0) throw new Error(MALFORMED);
    const vertexCount = positions.length / 3;

    const normals = entry.normals ? base64ToF32(entry.normals) : null;
    if (normals && normals.length !== vertexCount * 3) throw new Error(MALFORMED);
    const uvs = entry.uvs ? base64ToF32(entry.uvs) : null;
    if (uvs && uvs.length !== vertexCount * 2) throw new Error(MALFORMED);
    const uvs2 = typeof entry.uvs2 === "string" ? base64ToF32(entry.uvs2) : null;
    if (uvs2 && uvs2.length !== vertexCount * 2) throw new Error(MALFORMED);
    const blend = typeof entry.blend === "string" ? base64ToF32(entry.blend) : null;
    if (blend && (blend.length !== vertexCount || !blend.every((w) => w >= 0 && w <= 1))) throw new Error(MALFORMED);

    const indices = base64ToU32(entry.indices);
    if (indices.length === 0 || indices.length % 3 !== 0) throw new Error(MALFORMED);
    for (let i = 0; i < indices.length; i += 1) if (indices[i]! >= vertexCount) throw new Error(MALFORMED);

    totalVertices += vertexCount;
    totalIndices += indices.length;
    if (totalVertices > MAX_MESH_VERTICES || totalIndices > MAX_MESH_INDICES) throw new Error(MALFORMED);

    // Skin bindings: four joints (each in range) and four weights per vertex.
    let joints: Uint16Array | null = null;
    let weights: Float32Array | null = null;
    if (skin && typeof entry.joints === "string" && typeof entry.weights === "string") {
      joints = base64ToU16(entry.joints);
      weights = base64ToF32(entry.weights);
      if (joints.length !== vertexCount * 4 || weights.length !== vertexCount * 4) throw new Error(MALFORMED);
      for (let i = 0; i < joints.length; i += 1) if (joints[i]! >= skin.joints.length) throw new Error(MALFORMED);
      if (!weights.every(Number.isFinite)) throw new Error(MALFORMED);
    }

    return {
      positions,
      normals,
      uvs,
      indices,
      material: deserializeMaterial(entry.material, Object.assign(images, { primitive: index })),
      ...(uvs2 ? { uvs2 } : {}),
      ...(blend ? { blend } : {}),
      ...(joints && weights ? { joints, weights } : {}),
    };
  });

  if (primitives.length === 0) throw new Error(MALFORMED);
  const clips = skin ? deserializeClips(raw.clips, skin.joints.length) : [];
  return {
    name: typeof raw.name === "string" ? raw.name : "mesh",
    primitives,
    ...(skin ? { skin } : {}),
    ...(clips.length > 0 ? { clips } : {}),
  };
}

/**
 * A reader and writer for glTF 2.0 — the modern, self-contained mesh format game
 * engines prefer, and the one that carries textures inside a single `.glb` file.
 * This is the textured-import path: geometry, per-vertex normals and UVs, PBR
 * base-colour factor, and an embedded base-colour image all survive the trip.
 *
 * glTF stores geometry in a binary blob addressed by *accessors* (typed views
 * with a component type, count, and stride) through *bufferViews*, and arranges
 * meshes under a *node* scene graph with per-node transforms. This codec:
 *
 * - Decodes accessors honouring `componentType`, `byteStride`, and normalisation
 *   (the read logic mirrors a proven reference implementation).
 * - Flattens the node graph, baking each node's world transform into its mesh's
 *   vertex positions (and the inverse-transpose into its normals), so an imported
 *   {@link MeshAsset} is a flat list of primitives in one object space — while
 *   keeping the geometry *indexed* (unlike a naive expander).
 * - Reads the base-colour factor and, when present, the base-colour texture's
 *   image, kept as its original compressed bytes.
 *
 * Handles `.glb` (binary container) and `.gltf` whose buffers/images are embedded
 * as `data:` URIs. glTF referencing *external* files is rejected with a clear
 * message — the browser importer resolves those and hands buffers in. Scope: a
 * single base-colour texture per material; no morph targets.
 *
 * Skins and animations (ENGINE_ROADMAP.md, Phase 3): the first skin a mesh node
 * uses becomes the asset's skeleton (see skeleton.ts), with JOINTS_0/WEIGHTS_0
 * per vertex, and every animation's translation/rotation/scale channels on its
 * joints become clips (cubic-spline keys are read as linear). Meshes parented
 * under a joint (a sword in a hand) are bound rigidly to it, so they move too.
 *
 * Export writes the rig back out (LOCKOUT_MULTIPLAYER_ROADMAP.md L14): the
 * joints as a node tree, the skin with its inverse binds, JOINTS_0/WEIGHTS_0
 * per vertex, every clip as an animation and the second UV set as TEXCOORD_1,
 * so a model leaves for Blender rigged and animated and comes back the same.
 * Pure and DOM-free.
 */

import {
  type MeshAsset,
  type MeshPrimitive,
  type MeshMaterial,
  type EncodedImage,
  type MeshVariant,
  MAX_MESH_VARIANTS,
  MAX_MESH_VERTICES,
  MAX_MESH_INDICES,
} from "./MeshAsset";
import { base64ToBytes } from "./base64";
import { decompressGltf, type GltfDecoders, type MeshoptViewExtension } from "./gltfCompression";
import { readMaterialLayers } from "./materialLayers";
import { MAX_CLIP_KEYS, MAX_CLIPS, MAX_SKIN_JOINTS, isSkinned, type AnimationClip, type ClipChannel, type MeshSkin, type SkinJoint } from "./skeleton";

// --- glTF JSON shape (only the fields this codec reads/writes) -------------

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}
export interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  extensions?: { EXT_meshopt_compression?: MeshoptViewExtension };
}
interface GltfImage {
  bufferView?: number;
  mimeType?: string;
  uri?: string;
}
interface GltfTexture {
  source?: number;
  /** A Basis Universal (KTX2) image, used in preference to `source` (which, if present, is a PNG/JPEG fallback). */
  extensions?: { KHR_texture_basisu?: { source?: number } };
}
interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: { index: number };
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: { index: number };
  };
  normalTexture?: { index: number };
  occlusionTexture?: { index: number };
  emissiveTexture?: { index: number };
  emissiveFactor?: number[];
  alphaMode?: "OPAQUE" | "MASK" | "BLEND";
  alphaCutoff?: number;
  extensions?: {
    KHR_materials_clearcoat?: { clearcoatFactor?: number; clearcoatRoughnessFactor?: number };
    KHR_materials_anisotropy?: { anisotropyStrength?: number; anisotropyRotation?: number };
  };
}
export interface GltfPrimitive {
  attributes: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number; TEXCOORD_1?: number; JOINTS_0?: number; WEIGHTS_0?: number };
  indices?: number;
  material?: number;
  extensions?: {
    KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> };
    /** Which material each material set (I13) puts on this primitive. */
    KHR_materials_variants?: { mappings?: { material: number; variants: number[] }[] };
  };
}
export interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}
interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfScene {
  nodes?: number[];
}
interface GltfSkin {
  name?: string;
  joints: number[];
  inverseBindMatrices?: number;
}
interface GltfAnimation {
  name?: string;
  channels: { sampler: number; target: { node?: number; path: string } }[];
  samplers: { input: number; output: number; interpolation?: string }[];
  /** `duration`: the clip's length in seconds where it is not just its last key's time (written by {@link encodeGlb}). */
  extras?: { duration?: unknown };
}
export interface GltfBuffer {
  uri?: string;
  byteLength: number;
}
export interface GltfJson {
  asset?: { version?: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scene?: number;
  scenes?: GltfScene[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: GltfBuffer[];
  materials?: GltfMaterial[];
  textures?: GltfTexture[];
  images?: GltfImage[];
  skins?: GltfSkin[];
  animations?: GltfAnimation[];
  extensions?: { KHR_materials_variants?: { variants?: { name?: string }[] } };
}

/** Component-type → (byte size, normalisation divisor). FLOAT needs no divisor. */
const COMPONENT_TYPES: Record<number, { size: number; divisor: number; float: boolean }> = {
  5120: { size: 1, divisor: 127, float: false }, // BYTE
  5121: { size: 1, divisor: 255, float: false }, // UNSIGNED_BYTE
  5122: { size: 2, divisor: 32767, float: false }, // SHORT
  5123: { size: 2, divisor: 65535, float: false }, // UNSIGNED_SHORT
  5125: { size: 4, divisor: 4294967295, float: false }, // UNSIGNED_INT
  5126: { size: 4, divisor: 1, float: true }, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// --- 4×4 column-major matrix helpers (glTF's convention) -------------------

type Mat4 = Float64Array; // 16 elements, column-major: element (row, col) at col*4 + row

const IDENTITY4 = (): Mat4 =>
  Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Column-major C = A · B. */
function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Rotation matrix (column-major) from a glTF quaternion `[x, y, z, w]`. */
function quaternionToMatrix(x: number, y: number, z: number, w: number): Mat4 {
  const m = IDENTITY4();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + w * z);
  m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y);
  m[9] = 2 * (y * z - w * x);
  m[10] = 1 - 2 * (x * x + y * y);
  return m;
}

/** A node's local transform: its explicit `matrix`, else composed from T·R·S. */
function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix && node.matrix.length === 16) return Float64Array.from(node.matrix); // already column-major
  let matrix = IDENTITY4();
  if (node.scale) {
    const s = IDENTITY4();
    s[0] = node.scale[0]!;
    s[5] = node.scale[1]!;
    s[10] = node.scale[2]!;
    matrix = s;
  }
  if (node.rotation) {
    matrix = multiply4(quaternionToMatrix(node.rotation[0]!, node.rotation[1]!, node.rotation[2]!, node.rotation[3]!), matrix);
  }
  if (node.translation) {
    const t = IDENTITY4();
    t[12] = node.translation[0]!;
    t[13] = node.translation[1]!;
    t[14] = node.translation[2]!;
    matrix = multiply4(t, matrix);
  }
  return matrix;
}

/** Whether a matrix is exactly the identity. */
const isIdentity4 = (m: Mat4): boolean => m.every((v, i) => v === (i % 5 === 0 ? 1 : 0));

/** Inverse of an affine column-major matrix (identity when singular). */
function invertAffine4(m: Mat4): Mat4 {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) return IDENTITY4();
  const k = 1 / det;
  const out = IDENTITY4();
  out[0] = (e * i - f * h) * k;
  out[4] = (c * h - b * i) * k;
  out[8] = (b * f - c * e) * k;
  out[1] = (f * g - d * i) * k;
  out[5] = (a * i - c * g) * k;
  out[9] = (c * d - a * f) * k;
  out[2] = (d * h - e * g) * k;
  out[6] = (b * g - a * h) * k;
  out[10] = (a * e - b * d) * k;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  out[12] = -(out[0]! * tx + out[4]! * ty + out[8]! * tz);
  out[13] = -(out[1]! * tx + out[5]! * ty + out[9]! * tz);
  out[14] = -(out[2]! * tx + out[6]! * ty + out[10]! * tz);
  return out;
}

/** A node's local transform as translation, rotation quaternion and scale. */
function nodeTRS(node: GltfNode): Pick<SkinJoint, "translation" | "rotation" | "scale"> {
  if (!(node.matrix && node.matrix.length === 16)) {
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const sc = node.scale ?? [1, 1, 1];
    return { translation: [t[0]!, t[1]!, t[2]!], rotation: [r[0]!, r[1]!, r[2]!, r[3]!], scale: [sc[0]!, sc[1]!, sc[2]!] };
  }
  const m = node.matrix;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
  const r00 = m[0]! / sx, r10 = m[1]! / sx, r20 = m[2]! / sx;
  const r01 = m[4]! / sy, r11 = m[5]! / sy, r21 = m[6]! / sy;
  const r02 = m[8]! / sz, r12 = m[9]! / sz, r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const q = Math.sqrt(trace + 1) * 2;
    w = q / 4; x = (r21 - r12) / q; y = (r02 - r20) / q; z = (r10 - r01) / q;
  } else if (r00 > r11 && r00 > r22) {
    const q = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / q; x = q / 4; y = (r01 + r10) / q; z = (r02 + r20) / q;
  } else if (r11 > r22) {
    const q = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / q; x = (r01 + r10) / q; y = q / 4; z = (r12 + r21) / q;
  } else {
    const q = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / q; x = (r02 + r20) / q; y = (r12 + r21) / q; z = q / 4;
  }
  return { translation: [m[12]!, m[13]!, m[14]!], rotation: [x, y, z, w], scale: [sx, sy, sz] };
}

/** Transform a point (w=1) by a column-major matrix. */
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/**
 * The normal matrix — the inverse-transpose of the transform's upper-left 3×3 —
 * so normals stay perpendicular to the surface under non-uniform scale. Falls
 * back to the plain 3×3 (as row-major rows for {@link transformDirection}) when
 * the matrix is singular.
 */
function normalMatrix(m: Mat4): [number, number, number, number, number, number, number, number, number] {
  // Upper-left 3×3, read from the column-major mat4.
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return [a, b, c, d, e, f, g, h, i];
  const inv = 1 / det;
  // inverse of the 3×3, then transpose → returned row-major.
  const i00 = (e * i - f * h) * inv;
  const i01 = (c * h - b * i) * inv;
  const i02 = (b * f - c * e) * inv;
  const i10 = (f * g - d * i) * inv;
  const i11 = (a * i - c * g) * inv;
  const i12 = (c * d - a * f) * inv;
  const i20 = (d * h - e * g) * inv;
  const i21 = (b * g - a * h) * inv;
  const i22 = (a * e - b * d) * inv;
  // transpose:
  return [i00, i10, i20, i01, i11, i21, i02, i12, i22];
}

function transformDirection(n: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const rx = n[0]! * x + n[1]! * y + n[2]! * z;
  const ry = n[3]! * x + n[4]! * y + n[5]! * z;
  const rz = n[6]! * x + n[7]! * y + n[8]! * z;
  const length = Math.hypot(rx, ry, rz) || 1;
  return [rx / length, ry / length, rz / length];
}

// --- Accessor decoding -----------------------------------------------------

function bufferViewOf(json: GltfJson, index: number): GltfBufferView {
  const view = json.bufferViews?.[index];
  if (!view) throw new Error("glTF references a missing bufferView");
  return view;
}

/** Read a numeric accessor into a flat Float32Array (`count × components`). */
function readAccessorFloats(json: GltfJson, buffers: (Uint8Array | null)[], accessorIndex: number): Float32Array {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || accessor.bufferView === undefined) throw new Error("glTF references a missing accessor");
  const components = TYPE_COMPONENTS[accessor.type];
  const comp = COMPONENT_TYPES[accessor.componentType];
  if (!components || !comp) throw new Error("Unsupported glTF accessor type");

  const view = bufferViewOf(json, accessor.bufferView);
  const buffer = buffers[view.buffer];
  if (!buffer) throw new Error("glTF buffer is unavailable");
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const elementSize = components * comp.size;
  const stride = view.byteStride && view.byteStride > elementSize ? view.byteStride : elementSize;

  const out = new Float32Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i += 1) {
    const elementOffset = base + i * stride;
    for (let c = 0; c < components; c += 1) {
      const at = elementOffset + c * comp.size;
      let value: number;
      switch (accessor.componentType) {
        case 5126: value = dv.getFloat32(at, true); break;
        case 5120: value = dv.getInt8(at); break;
        case 5121: value = dv.getUint8(at); break;
        case 5122: value = dv.getInt16(at, true); break;
        case 5123: value = dv.getUint16(at, true); break;
        case 5125: value = dv.getUint32(at, true); break;
        default: value = 0;
      }
      out[i * components + c] = comp.float ? value : accessor.normalized ? value / comp.divisor : value;
    }
  }
  return out;
}

/** Read an index accessor into a Uint32Array, or synthesise `0..count-1` when absent. */
function readIndices(json: GltfJson, buffers: (Uint8Array | null)[], accessorIndex: number | undefined, vertexCount: number): Uint32Array {
  if (accessorIndex === undefined) {
    const out = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) out[i] = i;
    return out;
  }
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || accessor.bufferView === undefined) throw new Error("glTF references a missing index accessor");
  const comp = COMPONENT_TYPES[accessor.componentType];
  if (!comp) throw new Error("Unsupported glTF index component type");
  const view = bufferViewOf(json, accessor.bufferView);
  const buffer = buffers[view.buffer];
  if (!buffer) throw new Error("glTF buffer is unavailable");
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride && view.byteStride > comp.size ? view.byteStride : comp.size;

  const out = new Uint32Array(accessor.count);
  for (let i = 0; i < accessor.count; i += 1) {
    const at = base + i * stride;
    out[i] = accessor.componentType === 5121 ? dv.getUint8(at) : accessor.componentType === 5123 ? dv.getUint16(at, true) : dv.getUint32(at, true);
  }
  return out;
}

// --- Node graph + materials -----------------------------------------------

/** Collect world transforms (and the node) per mesh index by walking the scene's node tree. */
function collectMeshInstances(json: GltfJson): Map<number, { world: Mat4; node: number }[]> {
  const instances = new Map<number, { world: Mat4; node: number }[]>();
  const walk = (nodeIndex: number, parent: Mat4): void => {
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const world = multiply4(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const list = instances.get(node.mesh) ?? [];
      list.push({ world, node: nodeIndex });
      instances.set(node.mesh, list);
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  const sceneIndex = json.scene ?? 0;
  const roots = json.scenes?.[sceneIndex]?.nodes ?? [];
  for (const root of roots) walk(root, IDENTITY4());
  // A file may define meshes but no scene graph; render each mesh once at identity.
  if (instances.size === 0 && json.meshes) {
    json.meshes.forEach((_mesh, index) => instances.set(index, [{ world: IDENTITY4(), node: -1 }]));
  }
  return instances;
}

/** A material's clearcoat and anisotropy as glTF extensions (I4), or nothing when it has neither. */
function materialLayerExtensions(material: MeshMaterial): Pick<GltfMaterial, "extensions"> {
  const extensions: NonNullable<GltfMaterial["extensions"]> = {};
  if ((material.clearcoat ?? 0) > 0) {
    extensions.KHR_materials_clearcoat = { clearcoatFactor: material.clearcoat, ...(material.clearcoatRoughness !== undefined ? { clearcoatRoughnessFactor: material.clearcoatRoughness } : {}) };
  }
  // glTF's strength is 0..1 along the tangent; a negative one runs along the bitangent, a quarter turn on.
  const aniso = material.anisotropy ?? 0;
  if (aniso !== 0) {
    extensions.KHR_materials_anisotropy = { anisotropyStrength: Math.abs(aniso), anisotropyRotation: (material.anisotropyRotation ?? 0) + (aniso < 0 ? Math.PI / 2 : 0) };
  }
  return Object.keys(extensions).length > 0 ? { extensions } : {};
}

/** The extensions a written file uses: basisu (required, when a texture is KTX2) and the material ones (optional). */
function extensionLists(basisu: boolean, materials: readonly GltfMaterial[]): Pick<GltfJson, "extensionsUsed" | "extensionsRequired"> {
  const used = new Set<string>(basisu ? ["KHR_texture_basisu"] : []);
  for (const m of materials) for (const name of Object.keys(m.extensions ?? {})) used.add(name);
  if (used.size === 0) return {};
  return { extensionsUsed: [...used], ...(basisu ? { extensionsRequired: ["KHR_texture_basisu"] } : {}) };
}

/**
 * Resolve a material's base-colour factor and, if any, its embedded texture image.
 * `images` holds the images read so far by glTF image index: an image several
 * slots or materials use — a packed occlusion/roughness/metal map in both of its
 * slots, a texture shared across materials — comes back as one shared object,
 * so it is stored once.
 */
function readMaterial(json: GltfJson, buffers: (Uint8Array | null)[], materialIndex: number | undefined, images: Map<number, EncodedImage | null> = new Map()): MeshMaterial {
  const material = materialIndex !== undefined ? json.materials?.[materialIndex] : undefined;
  const pbr = material?.pbrMetallicRoughness;
  const factor = pbr?.baseColorFactor;
  const baseColorFactor: [number, number, number, number] =
    factor && factor.length === 4 ? [factor[0]!, factor[1]!, factor[2]!, factor[3]!] : [1, 1, 1, 1];

  // Resolve a texture reference (by material-slot index) to its embedded image.
  const imageAt = (ref: { index: number } | undefined): EncodedImage | null => {
    if (ref?.index === undefined) return null;
    const texture = json.textures?.[ref.index];
    // KTX2 kept as-is (image/ktx2): whether it stays compressed or is converted
    // to PNG is the editor's call (see ktx2Policy.ts), made per scene.
    const source = texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source;
    if (source === undefined) return null;
    if (!images.has(source)) {
      const image = json.images?.[source];
      images.set(source, image ? readImage(json, buffers, image) : null);
    }
    return images.get(source) ?? null;
  };

  const baseColorImage = imageAt(pbr?.baseColorTexture);
  // PBR (metallic-roughness) passthrough for the Modern tier (Phase 0). These are
  // optional and left undefined when the source omits them, so a fantasy-console
  // material is unaffected. See AAA_TIER_ROADMAP.md.
  const emissive = material?.emissiveFactor;
  return {
    name: material?.name ?? `material_${materialIndex ?? 0}`,
    baseColorFactor,
    baseColorImage,
    normalImage: imageAt(material?.normalTexture),
    metallicRoughnessImage: imageAt(pbr?.metallicRoughnessTexture),
    occlusionImage: imageAt(material?.occlusionTexture),
    emissiveImage: imageAt(material?.emissiveTexture),
    metallicFactor: typeof pbr?.metallicFactor === "number" ? pbr.metallicFactor : undefined,
    roughnessFactor: typeof pbr?.roughnessFactor === "number" ? pbr.roughnessFactor : undefined,
    emissiveFactor:
      emissive && emissive.length === 3 ? [emissive[0]!, emissive[1]!, emissive[2]!] : undefined,
    // Transparency, as glTF states it (EP6).
    ...(material?.alphaMode === "MASK" ? { alphaMode: "mask" as const, alphaCutoff: typeof material.alphaCutoff === "number" ? Math.max(0, Math.min(1, material.alphaCutoff)) : 0.5 } : {}),
    ...(material?.alphaMode === "BLEND" ? { alphaMode: "blend" as const } : {}),
    // The clearcoat and anisotropy extensions' factors (I4); their textures are not read.
    ...readMaterialLayers({
      clearcoat: material?.extensions?.KHR_materials_clearcoat?.clearcoatFactor,
      clearcoatRoughness: material?.extensions?.KHR_materials_clearcoat?.clearcoatRoughnessFactor,
      anisotropy: material?.extensions?.KHR_materials_anisotropy?.anisotropyStrength,
      anisotropyRotation: material?.extensions?.KHR_materials_anisotropy?.anisotropyRotation,
    }),
  };
}

/** The KTX2 file identifier («KTX 20»\r\n\x1A\n). */
const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether bytes are a KTX2 container. */
export function isKtx2(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && KTX2_MAGIC.every((b, i) => bytes[i] === b);
}

/** Extract an image's compressed bytes — from an embedded bufferView or a data URI. */
function readImage(json: GltfJson, buffers: (Uint8Array | null)[], image: GltfImage): EncodedImage | null {
  if (image.bufferView !== undefined) {
    const view = bufferViewOf(json, image.bufferView);
    const buffer = buffers[view.buffer];
    if (!buffer) return null;
    const start = view.byteOffset ?? 0;
    const bytes = buffer.slice(start, start + view.byteLength);
    return { mime: image.mimeType ?? (isKtx2(bytes) ? "image/ktx2" : "image/png"), bytes };
  }
  if (image.uri && image.uri.startsWith("data:")) {
    const comma = image.uri.indexOf(",");
    const meta = image.uri.slice(5, comma); // e.g. "image/png;base64"
    const mime = meta.split(";")[0] || "image/png";
    return { mime, bytes: base64ToBytes(image.uri.slice(comma + 1)) };
  }
  return null; // external image file — the browser importer supplies these
}

// --- Public parse ----------------------------------------------------------

/** Decode `data:...;base64,` URIs used by embedded `.gltf` buffers. */
function decodeDataUri(uri: string): Uint8Array | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  return base64ToBytes(uri.slice(comma + 1));
}

/**
 * Build a {@link MeshAsset} from parsed glTF JSON and its resolved buffers.
 * `buffers[i]` is the bytes of `buffers[i]` in the JSON (buffer 0 is the GLB's
 * BIN chunk); a null entry means that buffer was external and unavailable.
 */
export function parseGltf(sourceJson: GltfJson, sourceBuffers: (Uint8Array | null)[], name = "mesh", decoders: GltfDecoders = {}): MeshAsset {
  // Meshopt- or Draco-compressed geometry is decoded up front into plain buffers.
  const { json, buffers } = decompressGltf(sourceJson, sourceBuffers, decoders);
  const instances = collectMeshInstances(json);
  const rig = readRig(json, buffers);
  const primitives: MeshPrimitive[] = [];
  // Images and materials read once each, by glTF index, and shared wherever they're used.
  const imageCache = new Map<number, EncodedImage | null>();
  const materialCache = new Map<number, MeshMaterial>();
  const materialAt = (index: number | undefined): MeshMaterial => {
    if (index === undefined) return readMaterial(json, buffers, index, imageCache);
    if (!materialCache.has(index)) materialCache.set(index, readMaterial(json, buffers, index, imageCache));
    return materialCache.get(index)!;
  };
  // Material sets (KHR_materials_variants): each set's material per emitted primitive.
  const variantNames = (json.extensions?.KHR_materials_variants?.variants ?? []).slice(0, MAX_MESH_VARIANTS).map((v, i) => (typeof v?.name === "string" && v.name ? v.name.slice(0, 64) : `variant_${i}`));
  const variantMaterials: (MeshMaterial | null)[][] = variantNames.map(() => []);
  let totalVertices = 0;
  let totalIndices = 0;

  (json.meshes ?? []).forEach((mesh, meshIndex) => {
    const worlds = instances.get(meshIndex) ?? [{ world: IDENTITY4(), node: -1 }];
    for (const primitive of mesh.primitives) {
      if (primitive.attributes.POSITION === undefined) continue;
      const rawPositions = readAccessorFloats(json, buffers, primitive.attributes.POSITION);
      const vertexCount = rawPositions.length / 3;
      const rawNormals =
        primitive.attributes.NORMAL !== undefined ? readAccessorFloats(json, buffers, primitive.attributes.NORMAL) : null;
      const uvs =
        primitive.attributes.TEXCOORD_0 !== undefined
          ? readAccessorFloats(json, buffers, primitive.attributes.TEXCOORD_0)
          : null;
      // The second UV set (the light map's), when it has one per vertex.
      const rawUvs2 = primitive.attributes.TEXCOORD_1 !== undefined ? readAccessorFloats(json, buffers, primitive.attributes.TEXCOORD_1) : null;
      const uvs2 = rawUvs2 && rawUvs2.length === vertexCount * 2 ? rawUvs2 : null;
      const indices = readIndices(json, buffers, primitive.indices, vertexCount);
      const material = materialAt(primitive.material);
      const mapped = variantNames.map((_, v) => {
        const mapping = primitive.extensions?.KHR_materials_variants?.mappings?.find((m) => Array.isArray(m?.variants) && m.variants.includes(v));
        return mapping && Number.isInteger(mapping.material) && json.materials?.[mapping.material] ? materialAt(mapping.material) : null;
      });

      // Emit one primitive per node instance of this mesh, baking that node's
      // world transform into the positions (and inverse-transpose into normals).
      // A skinned node is placed by its skeleton instead (glTF ignores a skinned
      // node's own transform); a node under a joint is bound rigidly to it.
      for (const { world: nodeWorld, node } of worlds) {
        const binding = rig ? rig.bindingFor(node, primitive, vertexCount) : null;
        const world = binding ? binding.place(nodeWorld) : nodeWorld;
        // Positions under no transform are copied as they are (even a zero's sign).
        const unmoved = isIdentity4(world);
        const positions = unmoved ? rawPositions.slice() : new Float32Array(rawPositions.length);
        for (let v = 0; v < vertexCount && !unmoved; v += 1) {
          const [x, y, z] = transformPoint(world, rawPositions[v * 3]!, rawPositions[v * 3 + 1]!, rawPositions[v * 3 + 2]!);
          positions[v * 3] = x;
          positions[v * 3 + 1] = y;
          positions[v * 3 + 2] = z;
        }
        let normals: Float32Array | null = null;
        if (rawNormals) {
          const nm = normalMatrix(world);
          normals = new Float32Array(rawNormals.length);
          for (let v = 0; v < vertexCount; v += 1) {
            const [nx, ny, nz] = transformDirection(nm, rawNormals[v * 3]!, rawNormals[v * 3 + 1]!, rawNormals[v * 3 + 2]!);
            normals[v * 3] = nx;
            normals[v * 3 + 1] = ny;
            normals[v * 3 + 2] = nz;
          }
        }
        totalVertices += vertexCount;
        totalIndices += indices.length;
        if (totalVertices > MAX_MESH_VERTICES || totalIndices > MAX_MESH_INDICES) {
          throw new Error("glTF mesh exceeds the supported size");
        }
        primitives.push({
          positions,
          normals,
          uvs: uvs ? uvs.slice() : null,
          indices: indices.slice(),
          material,
          ...(uvs2 ? { uvs2: uvs2.slice() } : {}),
          ...(binding ? { joints: binding.joints, weights: binding.weights } : {}),
        });
        mapped.forEach((m, v) => variantMaterials[v]!.push(m));
      }
    }
  });

  if (primitives.length === 0) throw new Error("glTF file contains no triangle geometry");
  // A set that changes nothing is dropped.
  const variants: MeshVariant[] = variantNames.map((n, v) => ({ name: n, materials: variantMaterials[v]! })).filter((v) => v.materials.some((m) => m));
  const sets = variants.length > 0 ? { variants } : {};
  if (!rig || !primitives.some((p) => p.joints)) return { name, primitives, ...sets };
  const clips = readClips(json, buffers, rig.jointOfNode);
  return { name, primitives, skin: rig.skin, ...(clips.length > 0 ? { clips } : {}), ...sets };
}

interface Rig {
  readonly skin: MeshSkin;
  readonly jointOfNode: ReadonlyMap<number, number>;
  /** How node `node`'s primitive binds to the skeleton, or null when it doesn't. */
  bindingFor(
    node: number,
    primitive: GltfPrimitive,
    vertexCount: number,
  ): { joints: Uint16Array; weights: Float32Array; place: (nodeWorld: Mat4) => Mat4 } | null;
}

/**
 * The asset's skeleton: the first skin a mesh node uses. Its joints keep their
 * rest transforms (roots also the transform of the non-joint nodes above them).
 *
 * Skinned vertices are stored pre-multiplied by C = G₀·IBM₀ (the first joint's
 * rest world × inverse bind) and every inverse bind by C⁻¹, which skins exactly
 * as the file does while the stored positions show the rest pose — so bounds,
 * colliders and the editor's still preview see the character as it stands.
 */
function readRig(json: GltfJson, buffers: (Uint8Array | null)[]): Rig | null {
  const nodes = json.nodes ?? [];
  const skinIndex = nodes.find((n) => n.mesh !== undefined && n.skin !== undefined)?.skin;
  const gltfSkin = skinIndex !== undefined ? json.skins?.[skinIndex] : undefined;
  if (!gltfSkin || gltfSkin.joints.length === 0 || gltfSkin.joints.length > MAX_SKIN_JOINTS) return null;
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const worldCache = new Map<number, Mat4>();
  const worldOf = (i: number, depth = 0): Mat4 => {
    const hit = worldCache.get(i);
    if (hit) return hit;
    const node = nodes[i];
    const p = parentOf.get(i);
    const local = node ? nodeMatrix(node) : IDENTITY4();
    const w = p !== undefined && depth < nodes.length ? multiply4(worldOf(p, depth + 1), local) : local;
    worldCache.set(i, w);
    return w;
  };
  const jointOfNode = new Map<number, number>(gltfSkin.joints.map((node, j) => [node, j]));
  const joints: SkinJoint[] = gltfSkin.joints.map((nodeIndex, j) => {
    const node = nodes[nodeIndex] ?? {};
    // The nearest joint above this one, else the (non-joint) nodes above it as a base.
    let parent = -1;
    for (let p = parentOf.get(nodeIndex), steps = 0; p !== undefined && steps <= nodes.length; p = parentOf.get(p), steps += 1) {
      const pj = jointOfNode.get(p);
      if (pj !== undefined) {
        parent = pj;
        break;
      }
    }
    const up = parentOf.get(nodeIndex);
    const base = parent < 0 && up !== undefined ? Array.from(worldOf(up)) : undefined;
    return { name: node.name ?? `joint ${j}`, parent, ...nodeTRS(node), ...(base ? { base } : {}) };
  });
  const rawIbm = gltfSkin.inverseBindMatrices !== undefined ? readAccessorFloats(json, buffers, gltfSkin.inverseBindMatrices) : null;
  const ibmOf = (j: number): Mat4 =>
    rawIbm && rawIbm.length >= (j + 1) * 16 ? Float64Array.from(rawIbm.subarray(j * 16, j * 16 + 16)) : IDENTITY4();
  const restWorld = (j: number): Mat4 => worldOf(gltfSkin.joints[j]!);
  const c = nearIdentity(multiply4(restWorld(0), ibmOf(0)), restWorld(0));
  const cInv = invertAffine4(c);
  const inverseBind = new Float32Array(joints.length * 16);
  joints.forEach((_, j) => inverseBind.set(isIdentity4(c) ? ibmOf(j) : multiply4(ibmOf(j), cInv), j * 16));
  const skin: MeshSkin = { joints, inverseBind };
  return {
    skin,
    jointOfNode,
    bindingFor(node, primitive, vertexCount) {
      const n = nodes[node];
      if (n?.skin === skinIndex && primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined) {
        const rawJoints = readAccessorFloats(json, buffers, primitive.attributes.JOINTS_0);
        const rawWeights = readAccessorFloats(json, buffers, primitive.attributes.WEIGHTS_0);
        if (rawJoints.length !== vertexCount * 4 || rawWeights.length !== vertexCount * 4) return null;
        const jointsOut = new Uint16Array(vertexCount * 4);
        const weightsOut = new Float32Array(vertexCount * 4);
        for (let v = 0; v < vertexCount; v += 1) {
          let total = 0;
          for (let k = 0; k < 4; k += 1) {
            const j = Math.round(rawJoints[v * 4 + k]!);
            const w = Math.max(0, rawWeights[v * 4 + k]!);
            const ok = j >= 0 && j < joints.length;
            jointsOut[v * 4 + k] = ok ? j : 0;
            weightsOut[v * 4 + k] = ok ? w : 0;
            if (ok) total += w;
          }
          if (total > 0) for (let k = 0; k < 4; k += 1) weightsOut[v * 4 + k] = weightsOut[v * 4 + k]! / total;
        }
        return { joints: jointsOut, weights: weightsOut, place: () => c };
      }
      // A mesh under a joint rides on it: stored so that joint's rest skinning
      // matrix puts it back where the file placed it.
      let joint = -1;
      for (let p: number | undefined = node, steps = 0; p !== undefined && steps <= nodes.length; p = parentOf.get(p), steps += 1) {
        const j = jointOfNode.get(p);
        if (j !== undefined) {
          joint = j;
          break;
        }
      }
      if (joint < 0) return null;
      const jointsOut = new Uint16Array(vertexCount * 4).fill(0);
      const weightsOut = new Float32Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v += 1) {
        jointsOut[v * 4] = joint;
        weightsOut[v * 4] = 1;
      }
      const restSkin = multiply4(restWorld(joint), Float64Array.from(inverseBind.subarray(joint * 16, joint * 16 + 16)));
      return { joints: jointsOut, weights: weightsOut, place: (nodeWorld) => multiply4(invertAffine4(restSkin), nodeWorld) };
    },
  };
}

/**
 * `m`, or exactly the identity when it differs from it only by the float32
 * rounding of the matrices it was made from — as G₀·IBM₀ does in a file whose
 * bind pose is its rest pose (Blender's usual, and every file {@link encodeGlb}
 * writes), so such a file's vertices and inverse binds come in exactly as
 * written. `world` (the root joint's rest transform) scales the tolerance on
 * the translation, whose rounding grows with its distance from the origin.
 */
function nearIdentity(m: Mat4, world: Mat4): Mat4 {
  const reach = 1 + Math.max(Math.abs(world[12]!), Math.abs(world[13]!), Math.abs(world[14]!));
  for (let i = 0; i < 16; i += 1) {
    const tolerance = i >= 12 && i < 15 ? 1e-6 * reach : 1e-6;
    if (Math.abs(m[i]! - (i % 5 === 0 ? 1 : 0)) > tolerance) return m;
  }
  return IDENTITY4();
}

/** Every animation's joint channels as clips (weights and non-joint targets skipped). */
function readClips(json: GltfJson, buffers: (Uint8Array | null)[], jointOfNode: ReadonlyMap<number, number>): AnimationClip[] {
  const clips: AnimationClip[] = [];
  let keys = 0;
  for (const [index, animation] of (json.animations ?? []).entries()) {
    if (clips.length >= MAX_CLIPS) break;
    const channels: ClipChannel[] = [];
    let duration = 0;
    for (const channel of animation.channels ?? []) {
      const path = channel.target.path;
      const joint = channel.target.node !== undefined ? jointOfNode.get(channel.target.node) : undefined;
      if (joint === undefined || (path !== "translation" && path !== "rotation" && path !== "scale")) continue;
      const sampler = animation.samplers?.[channel.sampler];
      if (!sampler) continue;
      const times = readAccessorFloats(json, buffers, sampler.input);
      let values = readAccessorFloats(json, buffers, sampler.output);
      const width = path === "rotation" ? 4 : 3;
      if (sampler.interpolation === "CUBICSPLINE" && values.length === times.length * width * 3) {
        // In-tangent, value, out-tangent per key: keep the values.
        const picked = new Float32Array(times.length * width);
        for (let k = 0; k < times.length; k += 1) picked.set(values.subarray((k * 3 + 1) * width, (k * 3 + 2) * width), k * width);
        values = picked;
      }
      if (times.length === 0 || values.length !== times.length * width) continue;
      keys += times.length;
      if (keys > MAX_CLIP_KEYS) throw new Error("glTF animation exceeds the supported size");
      duration = Math.max(duration, times[times.length - 1]!);
      channels.push({ joint, path, interpolation: sampler.interpolation === "STEP" ? "step" : "linear", times, values });
    }
    // A length written with the clip (see encodeGlb) stands unless the keys now run past it.
    const stated = animation.extras?.duration;
    if (typeof stated === "number" && Number.isFinite(stated) && stated >= duration - 1e-5) duration = stated;
    if (channels.length > 0) clips.push({ name: animation.name?.trim() || `clip ${index + 1}`, duration, channels });
  }
  return clips;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/**
 * Parse a binary `.glb` file. The container is a 12-byte header then length-typed
 * chunks; the JSON chunk describes the scene and the BIN chunk is buffer 0.
 */
export function parseGlb(bytes: Uint8Array, name = "mesh", decoders: GltfDecoders = {}): MeshAsset {
  const { json, buffers } = readGlb(bytes);
  return parseGltf(json, buffers, name, decoders);
}

/** A `.glb`'s JSON and its resolved buffers (buffer 0 is the BIN chunk). */
export function readGlb(bytes: Uint8Array): { json: GltfJson; buffers: (Uint8Array | null)[] } {
  if (bytes.length < 12) throw new Error("File is too short to be a .glb");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("Not a glTF binary: bad magic bytes");
  if (dv.getUint32(4, true) !== 2) throw new Error("Unsupported glTF binary version (expected 2)");

  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    if (contentStart + chunkLength > bytes.length) break; // truncated chunk
    const content = bytes.subarray(contentStart, contentStart + chunkLength);
    if (chunkType === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(content)) as GltfJson;
    else if (chunkType === CHUNK_BIN) bin = content;
    offset = contentStart + chunkLength + ((4 - (chunkLength % 4)) % 4); // chunks are 4-byte aligned
  }
  if (!json) throw new Error("glTF binary has no JSON chunk");

  // Resolve every declared buffer: buffer 0 is the BIN chunk; others must be
  // data-URI embedded (external files aren't available to a pure parser).
  const buffers = (json.buffers ?? []).map((buffer, index) => {
    if (index === 0 && bin) return bin;
    return buffer.uri ? decodeDataUri(buffer.uri) : null;
  });
  return { json, buffers: buffers.length ? buffers : [bin] };
}

/**
 * Parse a text `.gltf` document whose buffers and images are embedded as `data:`
 * URIs (the common self-contained text form). A document referencing external
 * files throws, so the browser importer can resolve them and call
 * {@link parseGltf} directly with the buffers it read.
 */
export function parseGltfText(text: string, name = "mesh", decoders: GltfDecoders = {}): MeshAsset {
  const json = JSON.parse(text) as GltfJson;
  const buffers = (json.buffers ?? []).map((buffer) => {
    // A meshopt fallback buffer may have no data at all: the compressed views carry it.
    if (!buffer.uri) {
      if ((buffer as { extensions?: { EXT_meshopt_compression?: { fallback?: boolean } } }).extensions?.EXT_meshopt_compression?.fallback) return null;
      throw new Error("glTF buffer has no URI (GLB-embedded buffer in a .gltf?)");
    }
    const bytes = decodeDataUri(buffer.uri);
    if (!bytes) throw new Error("This .gltf references external buffer files; import the .glb form instead");
    return bytes;
  });
  return parseGltf(json, buffers, name, decoders);
}

// --- Encode ----------------------------------------------------------------

/** Round up to the next multiple of 4, as glTF alignment requires. */
const align4 = (n: number): number => n + ((4 - (n % 4)) % 4);

/** glTF's accessor type for a number of components. */
const ACCESSOR_TYPES: Record<number, string> = { 1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4" };

/**
 * Encode a {@link MeshAsset} to a binary `.glb`. Writes one buffer holding every
 * primitive's positions/normals/UVs/indices and each base-colour image, with the
 * accessors, materials, textures, and a single node/scene that reference them —
 * so the file reopens with its exact geometry and textures, and round-trips
 * losslessly through {@link parseGlb}.
 *
 * A skinned mesh (L14) also writes its rig: the joints as a node tree (names
 * and rest transforms, any base above a root as a parent node), `skins[0]`
 * with its inverse binds, JOINTS_0/WEIGHTS_0 on every bound primitive, and one
 * animation per clip — so Blender opens it as an armature with its actions,
 * and it reads back with the same positions, weights, joints and keys. The
 * stored forms of a rigid binding (one joint for a whole part, or a joint a
 * vertex) are already four influences a vertex in memory, and are written so.
 * LODs, trails, state machines and the cart-only material fields (team
 * colour, surface effects, graphs) have no glTF form and stay in the cart.
 */
export function encodeGlb(mesh: MeshAsset): Uint8Array {
  const bufferViews: GltfBufferView[] = [];
  const accessors: GltfAccessor[] = [];
  const images: GltfImage[] = [];
  const textures: GltfTexture[] = [];
  const materials: GltfMaterial[] = [];
  const gltfPrimitives: GltfPrimitive[] = [];
  const chunks: Uint8Array[] = [];
  let binLength = 0;

  /** Append bytes to the BIN buffer (4-byte aligned) and return the bufferView index. */
  const addView = (bytes: Uint8Array, byteStride?: number): number => {
    const byteOffset = binLength;
    chunks.push(bytes);
    binLength += bytes.byteLength;
    // Pad so the next view starts 4-byte aligned.
    const pad = align4(binLength) - binLength;
    if (pad > 0) {
      chunks.push(new Uint8Array(pad));
      binLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...(byteStride ? { byteStride } : {}) });
    return bufferViews.length - 1;
  };

  const addFloatAccessor = (array: Float32Array, components: number, withBounds: boolean): number => {
    const view = addView(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    const type = ACCESSOR_TYPES[components] ?? "SCALAR";
    const accessor: GltfAccessor = { bufferView: view, componentType: 5126, count: array.length / components, type };
    if (withBounds) {
      const min = new Array(components).fill(Infinity);
      const max = new Array(components).fill(-Infinity);
      for (let i = 0; i < array.length; i += components) {
        for (let c = 0; c < components; c += 1) {
          const value = array[i + c]!;
          if (value < min[c]) min[c] = value;
          if (value > max[c]) max[c] = value;
        }
      }
      accessor.min = min;
      accessor.max = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  // Each image once (a packed occlusion/roughness/metal map fills two slots), each material once.
  const textureOf = new Map<EncodedImage, number>();
  const addTexture = (image: EncodedImage): { index: number } => {
    if (!textureOf.has(image)) {
      images.push({ bufferView: addView(image.bytes), mimeType: image.mime });
      const ktx2 = image.mime === "image/ktx2";
      textures.push(ktx2 ? { extensions: { KHR_texture_basisu: { source: images.length - 1 } } } : { source: images.length - 1 });
      textureOf.set(image, textures.length - 1);
    }
    return { index: textureOf.get(image)! };
  };
  const materialOf = new Map<MeshMaterial, number>();
  const addMaterial = (m: MeshMaterial): number => {
    if (materialOf.has(m)) return materialOf.get(m)!;
    const gltfMaterial: GltfMaterial = {
      name: m.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...m.baseColorFactor],
        ...(m.baseColorImage ? { baseColorTexture: addTexture(m.baseColorImage) } : {}),
        ...(m.metallicFactor !== undefined ? { metallicFactor: m.metallicFactor } : {}),
        ...(m.roughnessFactor !== undefined ? { roughnessFactor: m.roughnessFactor } : {}),
        ...(m.metallicRoughnessImage ? { metallicRoughnessTexture: addTexture(m.metallicRoughnessImage) } : {}),
      },
      ...(m.normalImage ? { normalTexture: addTexture(m.normalImage) } : {}),
      ...(m.occlusionImage ? { occlusionTexture: addTexture(m.occlusionImage) } : {}),
      ...(m.emissiveImage ? { emissiveTexture: addTexture(m.emissiveImage) } : {}),
      ...(m.emissiveFactor ? { emissiveFactor: [...m.emissiveFactor] } : {}),
      // glTF has no additive mode: it exports as blended.
      ...(m.alphaMode === "mask" ? { alphaMode: "MASK" as const, alphaCutoff: m.alphaCutoff ?? 0.5 } : {}),
      ...(m.alphaMode === "blend" || m.alphaMode === "additive" ? { alphaMode: "BLEND" as const } : {}),
      ...materialLayerExtensions(m),
    };
    materials.push(gltfMaterial);
    materialOf.set(m, materials.length - 1);
    return materials.length - 1;
  };

  const skin = isSkinned(mesh) ? mesh.skin! : null;
  const bound = mesh.primitives.map((p) => Boolean(skin && p.joints && p.weights));
  for (const [index, primitive] of mesh.primitives.entries()) {
    // POSITION accessors must carry min/max per the spec (engines use them to cull).
    const positionAccessor = addFloatAccessor(primitive.positions, 3, true);
    const attributes: GltfPrimitive["attributes"] = { POSITION: positionAccessor };
    if (primitive.normals) attributes.NORMAL = addFloatAccessor(primitive.normals, 3, false);
    if (primitive.uvs) attributes.TEXCOORD_0 = addFloatAccessor(primitive.uvs, 2, false);
    if (primitive.uvs2) attributes.TEXCOORD_1 = addFloatAccessor(primitive.uvs2, 2, false);
    if (skin && bound[index]) {
      const influences = gltfInfluences(primitive.joints!, primitive.weights!, skin.joints.length);
      const jointBytes = new Uint8Array(influences.joints.buffer, influences.joints.byteOffset, influences.joints.byteLength);
      accessors.push({ bufferView: addView(jointBytes), componentType: influences.joints.BYTES_PER_ELEMENT === 1 ? 5121 : 5123, count: influences.joints.length / 4, type: "VEC4" });
      attributes.JOINTS_0 = accessors.length - 1;
      attributes.WEIGHTS_0 = addFloatAccessor(influences.weights, 4, false);
    }

    const indexView = addView(new Uint8Array(primitive.indices.buffer, primitive.indices.byteOffset, primitive.indices.byteLength));
    accessors.push({ bufferView: indexView, componentType: 5125, count: primitive.indices.length, type: "SCALAR" });
    const indexAccessor = accessors.length - 1;

    const material = addMaterial(primitive.material);
    const sets = (mesh.variants ?? []).slice(0, MAX_MESH_VARIANTS).flatMap((v, k) => (v.materials[index] ? [{ material: addMaterial(v.materials[index]!), variants: [k] }] : []));
    gltfPrimitives.push({ attributes, indices: indexAccessor, material, ...(sets.length > 0 ? { extensions: { KHR_materials_variants: { mappings: sets } } } : {}) });
  }

  const scene = skin
    ? writeRig(mesh, skin, gltfPrimitives, bound, addFloatAccessor)
    : { scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: gltfPrimitives }] };
  const json: GltfJson = {
    asset: { version: "2.0" },
    scene: 0,
    ...scene,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
    materials,
    ...(textures.length ? { textures, images } : {}),
    ...withVariants(extensionLists(textures.some((t) => t.extensions?.KHR_texture_basisu), materials), mesh.variants),
  };

  // Assemble the GLB: header, JSON chunk (space-padded), BIN chunk (zero-padded).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = align4(jsonBytes.length);
  const bin = concatChunks(chunks, binLength);
  const binPadded = align4(bin.length);
  const total = 12 + 8 + jsonPadded + 8 + binPadded;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);

  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded); // pad JSON with spaces

  const binChunkStart = 20 + jsonPadded;
  dv.setUint32(binChunkStart, binPadded, true);
  dv.setUint32(binChunkStart + 4, CHUNK_BIN, true);
  out.set(bin, binChunkStart + 8);
  return out;
}

/**
 * A primitive's influences as glTF wants them: joints as bytes (as shorts past
 * 256 joints), an unused slot's joint 0, and every vertex's weights summing to
 * 1 — renormalised only where they don't already, so weights read from a file
 * go back out bit for bit. A vertex with no weight at all (which the engine
 * leaves where it was bound) rides its first joint wholly, as glTF has no
 * unweighted vertex.
 */
function gltfInfluences(joints: Uint16Array, weights: Float32Array, jointCount: number): { joints: Uint8Array | Uint16Array; weights: Float32Array } {
  const count = Math.min(joints.length, weights.length) >> 2;
  const outJoints = jointCount <= 256 ? new Uint8Array(count * 4) : new Uint16Array(count * 4);
  const outWeights = new Float32Array(count * 4);
  for (let v = 0; v < count; v += 1) {
    let total = 0;
    for (let k = 0; k < 4; k += 1) {
      const j = joints[v * 4 + k]!;
      const w = weights[v * 4 + k]!;
      const used = j < jointCount && Number.isFinite(w) && w > 0;
      outJoints[v * 4 + k] = used ? j : 0;
      outWeights[v * 4 + k] = used ? w : 0;
      if (used) total += w;
    }
    if (total <= 0) {
      outJoints[v * 4] = Math.min(joints[v * 4]!, jointCount - 1);
      outWeights[v * 4] = 1;
    } else if (Math.abs(total - 1) > 5e-7) {
      for (let k = 0; k < 4; k += 1) outWeights[v * 4 + k] = outWeights[v * 4 + k]! / total;
    }
  }
  return { joints: outJoints, weights: outWeights };
}

/** Whether a transform component is its default (and so left off the node). */
const isDefault = (values: readonly number[], fallback: readonly number[]): boolean => values.every((v, i) => v === fallback[i]);

/**
 * A skinned mesh's scene: the joints as nodes 0…n−1 in skin order (each with
 * its name, rest transform and child joints), a parent node for each distinct
 * `base` above a root (the armature object a Blender file had), then a mesh
 * node per run of primitives — bound runs on `skin: 0`, an unbound part on a
 * node of its own — so the primitives read back in their order. Also writes
 * the skin and one animation per clip (a channel on a joint out of range, or
 * with mismatched keys, is skipped; a clip left with none is dropped).
 */
function writeRig(
  mesh: MeshAsset,
  skin: MeshSkin,
  gltfPrimitives: readonly GltfPrimitive[],
  bound: readonly boolean[],
  addFloatAccessor: (array: Float32Array, components: number, withBounds: boolean) => number,
): Pick<GltfJson, "scenes" | "nodes" | "meshes" | "skins" | "animations"> {
  const n = skin.joints.length;
  const nodes: GltfNode[] = skin.joints.map((joint, j) => {
    const children = skin.joints.flatMap((c, i) => (c.parent === j && i !== j ? [i] : []));
    return {
      name: joint.name,
      ...(isDefault(joint.translation, [0, 0, 0]) ? {} : { translation: [...joint.translation] }),
      ...(isDefault(joint.rotation, [0, 0, 0, 1]) ? {} : { rotation: [...joint.rotation] }),
      ...(isDefault(joint.scale, [1, 1, 1]) ? {} : { scale: [...joint.scale] }),
      ...(children.length > 0 ? { children } : {}),
    };
  });
  // Roots sit in the scene, or under a node standing for their base (one per distinct base).
  const roots: number[] = [];
  const bases = new Map<string, number>();
  skin.joints.forEach((joint, j) => {
    if (joint.parent >= 0 && joint.parent < n && joint.parent !== j) return;
    if (!joint.base || joint.base.length !== 16) {
      roots.push(j);
      return;
    }
    const key = joint.base.join(",");
    if (!bases.has(key)) {
      const identity = isDefault(joint.base, Array.from(IDENTITY4()));
      nodes.push({ name: bases.size === 0 ? "Armature" : `Armature ${bases.size + 1}`, ...(identity ? {} : { matrix: [...joint.base] }), children: [] });
      bases.set(key, nodes.length - 1);
      roots.push(nodes.length - 1);
    }
    nodes[bases.get(key)!]!.children!.push(j);
  });
  // Consecutive primitives that are all bound, or all not, share a mesh.
  const meshes: GltfMesh[] = [];
  gltfPrimitives.forEach((primitive, i) => {
    if (i > 0 && bound[i] === bound[i - 1]) {
      meshes[meshes.length - 1]!.primitives.push(primitive);
      return;
    }
    meshes.push({ name: mesh.name, primitives: [primitive] });
    nodes.push({ name: mesh.name, mesh: meshes.length - 1, ...(bound[i] ? { skin: 0 } : {}) });
    roots.push(nodes.length - 1);
  });
  const skins: GltfSkin[] = [{ name: mesh.name, joints: skin.joints.map((_, j) => j), inverseBindMatrices: addFloatAccessor(skin.inverseBind.subarray(0, n * 16), 16, false) }];
  // Each clip an animation; key times written once however many channels share them.
  const timesAccessor = new Map<string, number>();
  const animations: GltfAnimation[] = [];
  for (const clip of mesh.clips ?? []) {
    const animation: GltfAnimation = { name: clip.name, channels: [], samplers: [] };
    let last = 0;
    for (const channel of clip.channels) {
      const width = channel.path === "rotation" ? 4 : 3;
      if (channel.joint < 0 || channel.joint >= n || channel.times.length === 0 || channel.values.length !== channel.times.length * width) continue;
      const key = Array.prototype.join.call(channel.times, ",");
      if (!timesAccessor.has(key)) timesAccessor.set(key, addFloatAccessor(channel.times, 1, true));
      animation.samplers.push({ input: timesAccessor.get(key)!, output: addFloatAccessor(channel.values, width, false), interpolation: channel.interpolation === "step" ? "STEP" : "LINEAR" });
      animation.channels.push({ sampler: animation.samplers.length - 1, target: { node: channel.joint, path: channel.path } });
      last = Math.max(last, channel.times[channel.times.length - 1]!);
    }
    if (animation.channels.length === 0) continue;
    // A glTF clip lasts until its last key; one whose length differs says so.
    if (clip.duration !== last) animation.extras = { duration: clip.duration };
    animations.push(animation);
  }
  return { scenes: [{ nodes: roots }], nodes, meshes, skins, ...(animations.length > 0 ? { animations } : {}) };
}

/** The document's extension lists with its material sets (KHR_materials_variants) added, if it has any. */
function withVariants(lists: Pick<GltfJson, "extensionsUsed" | "extensionsRequired">, variants: readonly MeshVariant[] | undefined): Pick<GltfJson, "extensionsUsed" | "extensionsRequired" | "extensions"> {
  if (!variants || variants.length === 0) return lists;
  return {
    ...lists,
    extensionsUsed: [...(lists.extensionsUsed ?? []), "KHR_materials_variants"],
    extensions: { KHR_materials_variants: { variants: variants.slice(0, MAX_MESH_VARIANTS).map((v) => ({ name: v.name })) } },
  };
}

/** Concatenate the BIN chunk pieces into one buffer of the known total length. */
function concatChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

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
 * Pure and DOM-free.
 */

import {
  type MeshAsset,
  type MeshPrimitive,
  type MeshMaterial,
  type EncodedImage,
  MAX_MESH_VERTICES,
  MAX_MESH_INDICES,
} from "./MeshAsset";
import { base64ToBytes } from "./base64";
import { decompressGltf, type GltfDecoders, type MeshoptViewExtension } from "./gltfCompression";
import { MAX_CLIP_KEYS, MAX_CLIPS, MAX_SKIN_JOINTS, type AnimationClip, type ClipChannel, type MeshSkin, type SkinJoint } from "./skeleton";

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
}
export interface GltfPrimitive {
  attributes: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number; JOINTS_0?: number; WEIGHTS_0?: number };
  indices?: number;
  material?: number;
  extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> } };
}
export interface GltfMesh {
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
  joints: number[];
  inverseBindMatrices?: number;
}
interface GltfAnimation {
  name?: string;
  channels: { sampler: number; target: { node?: number; path: string } }[];
  samplers: { input: number; output: number; interpolation?: string }[];
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

/** Resolve a material's base-colour factor and, if any, its embedded texture image. */
function readMaterial(json: GltfJson, buffers: (Uint8Array | null)[], materialIndex: number | undefined): MeshMaterial {
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
    const image = source !== undefined ? json.images?.[source] : undefined;
    return image ? readImage(json, buffers, image) : null;
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
      const indices = readIndices(json, buffers, primitive.indices, vertexCount);
      const material = readMaterial(json, buffers, primitive.material);

      // Emit one primitive per node instance of this mesh, baking that node's
      // world transform into the positions (and inverse-transpose into normals).
      // A skinned node is placed by its skeleton instead (glTF ignores a skinned
      // node's own transform); a node under a joint is bound rigidly to it.
      for (const { world: nodeWorld, node } of worlds) {
        const binding = rig ? rig.bindingFor(node, primitive, vertexCount) : null;
        const world = binding ? binding.place(nodeWorld) : nodeWorld;
        const positions = new Float32Array(rawPositions.length);
        for (let v = 0; v < vertexCount; v += 1) {
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
          ...(binding ? { joints: binding.joints, weights: binding.weights } : {}),
        });
      }
    }
  });

  if (primitives.length === 0) throw new Error("glTF file contains no triangle geometry");
  if (!rig || !primitives.some((p) => p.joints)) return { name, primitives };
  const clips = readClips(json, buffers, rig.jointOfNode);
  return { name, primitives, skin: rig.skin, ...(clips.length > 0 ? { clips } : {}) };
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
  const c = multiply4(restWorld(0), ibmOf(0));
  const cInv = invertAffine4(c);
  const inverseBind = new Float32Array(joints.length * 16);
  joints.forEach((_, j) => inverseBind.set(multiply4(ibmOf(j), cInv), j * 16));
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

/**
 * Encode a {@link MeshAsset} to a binary `.glb`. Writes one buffer holding every
 * primitive's positions/normals/UVs/indices and each base-colour image, with the
 * accessors, materials, textures, and a single node/scene that reference them —
 * so the file reopens with its exact geometry and textures, and round-trips
 * losslessly through {@link parseGlb}.
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
    const type = components === 3 ? "VEC3" : components === 2 ? "VEC2" : "SCALAR";
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

  for (const primitive of mesh.primitives) {
    // POSITION accessors must carry min/max per the spec (engines use them to cull).
    const positionAccessor = addFloatAccessor(primitive.positions, 3, true);
    const attributes: GltfPrimitive["attributes"] = { POSITION: positionAccessor };
    if (primitive.normals) attributes.NORMAL = addFloatAccessor(primitive.normals, 3, false);
    if (primitive.uvs) attributes.TEXCOORD_0 = addFloatAccessor(primitive.uvs, 2, false);

    const indexView = addView(new Uint8Array(primitive.indices.buffer, primitive.indices.byteOffset, primitive.indices.byteLength));
    accessors.push({ bufferView: indexView, componentType: 5125, count: primitive.indices.length, type: "SCALAR" });
    const indexAccessor = accessors.length - 1;

    // Material, embedding the base-colour image as its own bufferView.
    const gltfMaterial: GltfMaterial = {
      name: primitive.material.name,
      pbrMetallicRoughness: { baseColorFactor: [...primitive.material.baseColorFactor] },
    };
    if (primitive.material.baseColorImage) {
      const imageView = addView(primitive.material.baseColorImage.bytes);
      images.push({ bufferView: imageView, mimeType: primitive.material.baseColorImage.mime });
      const ktx2 = primitive.material.baseColorImage.mime === "image/ktx2";
      textures.push(ktx2 ? { extensions: { KHR_texture_basisu: { source: images.length - 1 } } } : { source: images.length - 1 });
      gltfMaterial.pbrMetallicRoughness!.baseColorTexture = { index: textures.length - 1 };
    }
    materials.push(gltfMaterial);

    gltfPrimitives.push({ attributes, indices: indexAccessor, material: materials.length - 1 });
  }

  const json: GltfJson = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: gltfPrimitives }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
    materials,
    ...(textures.length ? { textures, images } : {}),
    ...(textures.some((t) => t.extensions?.KHR_texture_basisu)
      ? { extensionsUsed: ["KHR_texture_basisu"], extensionsRequired: ["KHR_texture_basisu"] }
      : {}),
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

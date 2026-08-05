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
 * single base-colour texture per material; no skinning, morphs, or animation.
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
import { base64ToBytes, bytesToBase64 } from "./base64";

// --- glTF JSON shape (only the fields this codec reads/writes) -------------

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfImage {
  bufferView?: number;
  mimeType?: string;
  uri?: string;
}
interface GltfTexture {
  source?: number;
}
interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: { index: number };
  };
}
interface GltfPrimitive {
  attributes: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
  indices?: number;
  material?: number;
}
interface GltfMesh {
  primitives: GltfPrimitive[];
}
interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfScene {
  nodes?: number[];
}
interface GltfBuffer {
  uri?: string;
  byteLength: number;
}
interface GltfJson {
  asset?: { version?: string };
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

const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

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

/** Collect world transforms per mesh index by walking the scene's node tree. */
function collectMeshInstances(json: GltfJson): Map<number, Mat4[]> {
  const instances = new Map<number, Mat4[]>();
  const walk = (nodeIndex: number, parent: Mat4): void => {
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const world = multiply4(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const list = instances.get(node.mesh) ?? [];
      list.push(world);
      instances.set(node.mesh, list);
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  const sceneIndex = json.scene ?? 0;
  const roots = json.scenes?.[sceneIndex]?.nodes ?? [];
  for (const root of roots) walk(root, IDENTITY4());
  // A file may define meshes but no scene graph; render each mesh once at identity.
  if (instances.size === 0 && json.meshes) {
    json.meshes.forEach((_mesh, index) => instances.set(index, [IDENTITY4()]));
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

  let baseColorImage: EncodedImage | null = null;
  const textureIndex = pbr?.baseColorTexture?.index;
  if (textureIndex !== undefined) {
    const source = json.textures?.[textureIndex]?.source;
    const image = source !== undefined ? json.images?.[source] : undefined;
    if (image) baseColorImage = readImage(json, buffers, image);
  }
  return { name: material?.name ?? `material_${materialIndex ?? 0}`, baseColorFactor, baseColorImage };
}

/** Extract an image's compressed bytes — from an embedded bufferView or a data URI. */
function readImage(json: GltfJson, buffers: (Uint8Array | null)[], image: GltfImage): EncodedImage | null {
  if (image.bufferView !== undefined) {
    const view = bufferViewOf(json, image.bufferView);
    const buffer = buffers[view.buffer];
    if (!buffer) return null;
    const start = view.byteOffset ?? 0;
    const bytes = buffer.slice(start, start + view.byteLength);
    return { mime: image.mimeType ?? "image/png", bytes };
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
export function parseGltf(json: GltfJson, buffers: (Uint8Array | null)[], name = "mesh"): MeshAsset {
  const instances = collectMeshInstances(json);
  const primitives: MeshPrimitive[] = [];
  let totalVertices = 0;
  let totalIndices = 0;

  (json.meshes ?? []).forEach((mesh, meshIndex) => {
    const worlds = instances.get(meshIndex) ?? [IDENTITY4()];
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
      for (const world of worlds) {
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
        primitives.push({ positions, normals, uvs: uvs ? uvs.slice() : null, indices: indices.slice(), material });
      }
    }
  });

  if (primitives.length === 0) throw new Error("glTF file contains no triangle geometry");
  return { name, primitives };
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/**
 * Parse a binary `.glb` file. The container is a 12-byte header then length-typed
 * chunks; the JSON chunk describes the scene and the BIN chunk is buffer 0.
 */
export function parseGlb(bytes: Uint8Array, name = "mesh"): MeshAsset {
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
  return parseGltf(json, buffers.length ? buffers : [bin], name);
}

/**
 * Parse a text `.gltf` document whose buffers and images are embedded as `data:`
 * URIs (the common self-contained text form). A document referencing external
 * files throws, so the browser importer can resolve them and call
 * {@link parseGltf} directly with the buffers it read.
 */
export function parseGltfText(text: string, name = "mesh"): MeshAsset {
  const json = JSON.parse(text) as GltfJson;
  const buffers = (json.buffers ?? []).map((buffer) => {
    if (!buffer.uri) throw new Error("glTF buffer has no URI (GLB-embedded buffer in a .gltf?)");
    const bytes = decodeDataUri(buffer.uri);
    if (!bytes) throw new Error("This .gltf references external buffer files; import the .glb form instead");
    return bytes;
  });
  return parseGltf(json, buffers, name);
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
      textures.push({ source: images.length - 1 });
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

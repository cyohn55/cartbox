/**
 * The binary asset package (AAA_FIDELITY_ROADMAP.md F9e): a mesh and its maps
 * in one file of chunks behind a manifest, in place of the base64 JSON
 * sidecars that inflate binary by a third and must be parsed whole.
 *
 * Layout (little-endian):
 *
 * - `CBPK`, a u32 version, a u32 manifest length;
 * - the manifest, UTF-8 JSON: the asset's name and kind, and per chunk its
 *   name, role, encoding, offset, length, raw length, element count and the
 *   SHA-256 of its stored bytes;
 * - the chunks, each starting on a 16-byte boundary so a typed array can view
 *   it in place.
 *
 * Geometry chunks are the primitives' streams as their typed arrays
 * (positions, normals, UVs, tangents, indices…), stored raw or squeezed with
 * meshoptimizer's vertex and index codecs (the caller hands the encoder in, as
 * the glTF decoders are, so this stays DOM-free). Images are stored as they are
 * encoded (PNG, KTX2 — already compressed). The materials, without their
 * images, travel in the manifest as JSON.
 *
 * Reading checks the magic, the version, every chunk's bounds and (when asked)
 * its hash, so a truncated or tampered package fails loudly.
 */

import type { EncodedImage, MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";
import { deserializeMaterial, deserializeMeshAsset, serializeMaterial, serializeMeshAsset } from "./MeshAsset";

/** The file's first four bytes. */
export const PACKAGE_MAGIC = 0x4b504243; // "CBPK"
export const PACKAGE_VERSION = 1;
/** Chunks start on this boundary. */
const ALIGN = 16;

/** meshoptimizer's codecs (`MeshoptEncoder` / `MeshoptDecoder`, once ready). */
export interface MeshoptCodec {
  readonly encodeVertexBuffer: (source: Uint8Array, count: number, size: number) => Uint8Array;
  readonly encodeIndexBuffer: (source: Uint8Array, count: number, size: number) => Uint8Array;
  readonly decodeVertexBuffer: (target: Uint8Array, count: number, size: number, source: Uint8Array) => void;
  readonly decodeIndexBuffer: (target: Uint8Array, count: number, size: number, source: Uint8Array) => void;
}

export type ChunkEncoding = "raw" | "meshopt-vertex" | "meshopt-index";

/** One chunk as the manifest describes it. */
export interface PackageChunk {
  readonly name: string;
  /** What it holds: a primitive's stream ("p0.positions"), or an image ("m0.normalImage"). */
  readonly role: "stream" | "image";
  readonly encoding: ChunkEncoding;
  readonly offset: number;
  readonly length: number;
  /** The decoded length, in bytes. */
  readonly rawLength: number;
  /** Elements, and bytes an element (for the meshopt codecs and the typed array). */
  readonly count: number;
  readonly stride: number;
  /** "f32", "u32" or "u16" for a stream; the MIME type for an image. */
  readonly type: string;
  /** SHA-256 of the stored bytes, hex. */
  readonly hash: string;
}

export interface PackageManifest {
  readonly name: string;
  readonly kind: "mesh";
  readonly chunks: readonly PackageChunk[];
  /** Per primitive: which streams it has, and its material's index. */
  readonly primitives: readonly { readonly streams: readonly string[]; readonly material: number }[];
  /** The materials, serialised without their images (those are chunks). */
  readonly materials: readonly unknown[];
  /** The rest of the mesh (its skin, clips, trails and variants), as the JSON codec stores it, or absent. */
  readonly rest?: string;
}

/** The streams a primitive may carry, with their element size and type. */
const STREAMS = [
  ["positions", 12, "f32"],
  ["normals", 12, "f32"],
  ["uvs", 8, "f32"],
  ["uvs2", 8, "f32"],
  ["tangents", 16, "f32"],
  ["blend", 4, "f32"],
  ["sway", 4, "f32"],
  ["joints", 8, "u16"],
  ["weights", 16, "f32"],
  ["indices", 4, "u32"],
] as const;

/** The image slots a material may carry. */
const IMAGE_SLOTS = ["baseColorImage", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage", "lightmapImage", "lightmapHdrImage", "tintMaskImage", "detailImage", "blendImage", "reliefImage"] as const;

/** SHA-256 of bytes, hex (a small synchronous implementation, so packing stays synchronous and DOM-free). */
export function sha256(bytes: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Pack a mesh and its images (see the module comment); `meshopt` squeezes the geometry. */
export function packMeshAsset(mesh: MeshAsset, meshopt: MeshoptCodec | null = null): Uint8Array {
  const chunks: { meta: Omit<PackageChunk, "offset" | "hash">; data: Uint8Array }[] = [];
  const materials: MeshMaterial[] = [];
  const materialIndex = new Map<MeshMaterial, number>();
  const primitives = mesh.primitives.map((p, pi) => {
    const streams: string[] = [];
    for (const [stream, stride, type] of STREAMS) {
      const value = (p as unknown as Record<string, ArrayBufferView | null | undefined>)[stream];
      if (!value || value.byteLength === 0) continue;
      const raw = bytesOf(value);
      const count = raw.byteLength / stride;
      let data = raw;
      let encoding: ChunkEncoding = "raw";
      if (meshopt && Number.isInteger(count)) {
        // The index codec takes triangles (a count divisible by three); the vertex codec any stride divisible by four.
        const squeezed = stream === "indices" ? (count % 3 === 0 ? meshopt.encodeIndexBuffer(raw, count, stride) : null) : meshopt.encodeVertexBuffer(raw, count, stride);
        if (squeezed && squeezed.byteLength < raw.byteLength) {
          data = squeezed;
          encoding = stream === "indices" ? "meshopt-index" : "meshopt-vertex";
        }
      }
      chunks.push({ meta: { name: `p${pi}.${stream}`, role: "stream", encoding, length: data.byteLength, rawLength: raw.byteLength, count, stride, type }, data });
      streams.push(stream);
    }
    let m = materialIndex.get(p.material);
    if (m === undefined) {
      m = materials.length;
      materialIndex.set(p.material, m);
      materials.push(p.material);
    }
    return { streams, material: m };
  });
  const serialized = materials.map((material, mi) => {
    const s = serializeMaterial(material) as unknown as Record<string, unknown>;
    // Images go in chunks; the manifest keeps only which slots have one.
    for (const slot of IMAGE_SLOTS) {
      const image = material[slot] as EncodedImage | null | undefined;
      const stored = slot === "baseColorImage" ? "image" : slot;
      delete s[stored];
      if (image && image.bytes.length > 0) chunks.push({ meta: { name: `m${mi}.${slot}`, role: "image", encoding: "raw", length: image.bytes.length, rawLength: image.bytes.length, count: 1, stride: 1, type: image.mime }, data: image.bytes });
    }
    return s;
  });
  // Lay the chunks out, then the manifest that points at them.
  let at = 0;
  const placed: PackageChunk[] = chunks.map((c) => {
    at = Math.ceil(at / ALIGN) * ALIGN;
    const chunk: PackageChunk = { ...c.meta, offset: at, hash: sha256(c.data) };
    at += c.data.byteLength;
    return chunk;
  });
  const hasRest = Boolean(mesh.skin || mesh.clips?.length || mesh.trails?.length || mesh.variants?.length);
  const manifest: PackageManifest = { name: mesh.name, kind: "mesh", chunks: placed, primitives, materials: serialized, ...(hasRest ? { rest: serializeMeshAsset({ ...mesh, primitives: [] }) } : {}) };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const head = Math.ceil((12 + json.byteLength) / ALIGN) * ALIGN;
  const out = new Uint8Array(head + at);
  const view = new DataView(out.buffer);
  view.setUint32(0, PACKAGE_MAGIC, true);
  view.setUint32(4, PACKAGE_VERSION, true);
  view.setUint32(8, json.byteLength, true);
  out.set(json, 12);
  placed.forEach((c, i) => out.set(chunks[i]!.data, head + c.offset));
  return out;
}

/** A package's manifest and where its chunks start, after checking its header. */
export function readPackageManifest(bytes: Uint8Array): { manifest: PackageManifest; base: number } {
  if (bytes.byteLength < 12) throw new Error("Not a Cartbox package: too short.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== PACKAGE_MAGIC) throw new Error("Not a Cartbox package.");
  const version = view.getUint32(4, true);
  if (version !== PACKAGE_VERSION) throw new Error(`Cartbox package version ${version} isn't one this build reads (${PACKAGE_VERSION}).`);
  const length = view.getUint32(8, true);
  if (12 + length > bytes.byteLength) throw new Error("Cartbox package truncated in its manifest.");
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))) as PackageManifest;
  const base = Math.ceil((12 + length) / ALIGN) * ALIGN;
  for (const c of manifest.chunks) {
    if (!(c.offset >= 0 && c.length >= 0 && base + c.offset + c.length <= bytes.byteLength)) throw new Error(`Cartbox package truncated in chunk ${c.name}.`);
  }
  return { manifest, base };
}

/** Unpack a mesh (see the module comment); `verify` checks every chunk's hash. */
export function unpackMeshAsset(bytes: Uint8Array, meshopt: MeshoptCodec | null = null, verify = true): MeshAsset {
  const { manifest, base } = readPackageManifest(bytes);
  const byName = new Map(manifest.chunks.map((c) => [c.name, c]));
  const read = (c: PackageChunk): Uint8Array => {
    const stored = bytes.subarray(base + c.offset, base + c.offset + c.length);
    if (verify && sha256(stored) !== c.hash) throw new Error(`Cartbox package chunk ${c.name} doesn't match its hash.`);
    if (c.encoding === "raw") return stored.slice();
    if (!meshopt) throw new Error(`Cartbox package chunk ${c.name} is meshopt-compressed: load the decoder first.`);
    const out = new Uint8Array(c.rawLength);
    if (c.encoding === "meshopt-index") meshopt.decodeIndexBuffer(out, c.count, c.stride, stored);
    else meshopt.decodeVertexBuffer(out, c.count, c.stride, stored);
    return out;
  };
  const materials = manifest.materials.map((s, mi) => {
    const material = deserializeMaterial(s);
    const images: Record<string, EncodedImage> = {};
    for (const slot of IMAGE_SLOTS) {
      const c = byName.get(`m${mi}.${slot}`);
      if (c) images[slot] = { mime: c.type, bytes: read(c) };
    }
    return { ...material, ...images } as MeshMaterial;
  });
  const primitives = manifest.primitives.map((p, pi) => {
    const out: Record<string, unknown> = { material: materials[p.material]! };
    for (const [stream, , type] of STREAMS) {
      const c = byName.get(`p${pi}.${stream}`);
      if (!c) {
        if (stream === "normals" || stream === "uvs") out[stream] = null;
        continue;
      }
      const raw = read(c);
      out[stream] = type === "u32" ? new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) : type === "u16" ? new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2) : new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    }
    return out as unknown as MeshPrimitive;
  });
  const rest = manifest.rest ? deserializeMeshAsset(manifest.rest) : null;
  return { ...(rest ?? {}), name: manifest.name, primitives } as MeshAsset;
}

/**
 * Compressed textures by default (HALO_INFINITE_STYLE_ROADMAP.md I13): an
 * imported model's PNG and JPEG maps are encoded to KTX2 with the vendored
 * Basis Universal encoder — colour maps as ETC1S in sRGB, normal and data maps
 * as near-lossless UASTC — and the KTX2 form is kept when it travels lighter.
 * What the encoder writes, the vendored transcoder (and so every player) reads.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { deserializeMeshAsset, serializeMeshAsset, type DecodedTexture, type EncodedImage, type MeshAsset, type MeshMaterial } from "@cartbox/editor";
import { transcodeKtx2 } from "@/lib/ktx2Decoder";
import { encodeKtx2, type TextureKind } from "@/lib/ktx2Encoder";
import { compressMeshTextures } from "@/lib/ktx2Policy";

const vendor = (name: string) => new URL(`../apps/web/src/vendor/basis/${name}`, import.meta.url);
const wasm = (name: string) => {
  const bytes = readFileSync(vendor(name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

async function encoderModule() {
  const { default: createBasis } = (await import("../apps/web/src/vendor/basis/basis_encoder.mjs")) as { default: (o: object) => Promise<{ initializeBasis(): void }> };
  const basis = await createBasis({ wasmBinary: wasm("basis_encoder.wasm") });
  basis.initializeBasis();
  return basis;
}
async function transcoderModule() {
  const require = createRequire(import.meta.url);
  const createBasis = require(vendor("basis_transcoder.cjs").pathname) as (o: object) => Promise<{ initializeBasis(): void }>;
  const basis = await createBasis({ wasmBinary: wasm("basis_transcoder.wasm") });
  basis.initializeBasis();
  return basis;
}

/** A painted-looking texture: smooth colour fields with a little grain. */
function texture(size: number, seed: number): DecodedTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const grain = rand() * 12;
      data[i] = 90 + 80 * Math.sin(x / 17 + seed) + grain;
      data[i + 1] = 110 + 60 * Math.cos(y / 23) + grain;
      data[i + 2] = 140 + 50 * Math.sin((x + y) / 31) + grain;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** A tangent-space normal map: unit normals of a bumpy surface, encoded 0..255. */
function normalMap(size: number): DecodedTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = 0.4 * Math.sin(x / 9), ny = 0.4 * Math.cos(y / 7);
      const nz = Math.sqrt(1 - nx * nx - ny * ny);
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/** A real PNG of a texture (unfiltered rows, zlib), so sizes are measured as they'd travel. */
function png(t: DecodedTexture): Uint8Array {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = table[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, t.width);
  hv.setUint32(4, t.height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array((t.width * 4 + 1) * t.height);
  for (let y = 0; y < t.height; y += 1) raw.set(t.data.subarray(y * t.width * 4, (y + 1) * t.width * 4), y * (t.width * 4 + 1) + 1);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const meanError = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) if (i % 4 !== 3) sum += Math.abs(a[i]! - b[i]!);
  return sum / ((a.length / 4) * 3);
};

describe("the KTX2 encoder", () => {
  it("writes files the player's transcoder reads back closely: colour as ETC1S, normals and data as UASTC", async () => {
    const [enc, dec] = await Promise.all([encoderModule(), transcoderModule()]);
    const cases: [DecodedTexture, TextureKind, number][] = [
      [texture(128, 1), "color", 6],
      [normalMap(128), "normal", 2],
      [texture(128, 2), "data", 2],
    ];
    for (const [source, kind, tolerance] of cases) {
      const ktx2 = encodeKtx2(enc, source, kind)!;
      expect(ktx2, kind).not.toBeNull();
      const back = transcodeKtx2(dec, ktx2)!;
      expect([back.width, back.height]).toEqual([128, 128]);
      expect(meanError(source.data, back.data), kind).toBeLessThan(tolerance);
    }
  }, 120_000);

  it("refuses what it can't take, rather than failing the import", async () => {
    const enc = await encoderModule();
    expect(encodeKtx2(enc, { width: 0, height: 0, data: new Uint8ClampedArray(0) }, "color")).toBeNull();
    expect(encodeKtx2(enc, { width: 8192, height: 4096, data: new Uint8ClampedArray(4) }, "color")).toBeNull();
  }, 60_000);
});

describe("compressing an import", () => {
  // A model as an artist exports it: painted armour with a normal map and a packed ORM map in both of its slots,
  // and a material set with its own paint that shares the normal and ORM maps.
  const paint = texture(256, 3), worn = texture(256, 4), normals = normalMap(256), orm = texture(256, 5);
  const image = (t: DecodedTexture): EncodedImage => ({ mime: "image/png", bytes: png(t) });
  const [paintImage, wornImage, normalImage, ormImage] = [paint, worn, normals, orm].map(image);
  const pixels = new Map([[paintImage, paint], [wornImage, worn], [normalImage, normals], [ormImage, orm]]);
  const armor: MeshMaterial = { name: "armor", baseColorFactor: [1, 1, 1, 1], baseColorImage: paintImage, normalImage, metallicRoughnessImage: ormImage, occlusionImage: ormImage };
  const tri = { positions: new Float32Array(9), normals: null, uvs: new Float32Array(6), indices: Uint32Array.from([0, 1, 2]) };
  const mesh: MeshAsset = {
    name: "spartan",
    primitives: [{ ...tri, material: armor }, { ...tri, material: { name: "plain", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
    variants: [{ name: "Veteran", materials: [{ ...armor, name: "veteran", baseColorImage: wornImage }, null] }],
  };

  const crate = texture(64, 6);
  const crateImage = image(crate);
  const small = new Map([[crateImage, crate]]);
  const prop: MeshAsset = { name: "crate", primitives: [{ ...tri, material: { name: "crate", baseColorFactor: [1, 1, 1, 1], baseColorImage: crateImage } }] };

  async function compress(sceneHasKtx2: boolean, model = mesh) {
    const enc = await encoderModule();
    const kinds: [EncodedImage, TextureKind, boolean][] = [];
    let loads = 0;
    const result = await compressMeshTextures(model, {
      sceneHasKtx2,
      decode: async (img, raw) => {
        kinds.push([img, "color", raw]);
        return pixels.get(img) ?? small.get(img) ?? null;
      },
      encoder: async () => {
        loads += 1;
        return (t, kind) => {
          kinds[kinds.length - 1]![1] = kind;
          return encodeKtx2(enc, t, kind);
        };
      },
    });
    return { result, kinds, loads };
  }

  it("encodes each map once, by what it holds, reading data maps raw", async () => {
    const { kinds, loads } = await compress(true);
    expect(loads).toBe(1);
    const kindOf = new Map(kinds.map(([img, kind, raw]) => [img, [kind, raw]]));
    expect(kinds.length).toBe(4);
    expect(kindOf.get(paintImage)).toEqual(["color", false]);
    expect(kindOf.get(wornImage)).toEqual(["color", false]);
    expect(kindOf.get(normalImage)).toEqual(["normal", true]);
    expect(kindOf.get(ormImage)).toEqual(["data", true]);
  }, 120_000);

  it("keeps KTX2 when it travels lighter, in the primitives and the material sets, still shared", async () => {
    const { result } = await compress(true);
    expect(result.outcome).toBe("compressed");
    expect(result.ktx2Bytes).toBeLessThan(result.sourceBytes);
    const m = result.mesh.primitives[0]!.material;
    expect([m.baseColorImage, m.normalImage, m.metallicRoughnessImage].map((i) => i!.mime)).toEqual(["image/ktx2", "image/ktx2", "image/ktx2"]);
    expect(m.occlusionImage).toBe(m.metallicRoughnessImage);
    const veteran = result.mesh.variants![0]!.materials[0]!;
    expect(veteran.baseColorImage!.mime).toBe("image/ktx2");
    expect(veteran.normalImage).toBe(m.normalImage);
    expect(result.mesh.primitives[1]!.material.baseColorImage).toBeNull();
    // Stored once each, and read back the same.
    const back = deserializeMeshAsset(serializeMeshAsset(result.mesh));
    expect(back.primitives[0]!.material.occlusionImage).toBe(back.primitives[0]!.material.metallicRoughnessImage);
    expect(back.variants![0]!.materials[0]!.normalImage).toBe(back.primitives[0]!.material.normalImage);
  }, 120_000);

  it("keeps the imported maps when the saving wouldn't pay for the transcoder", async () => {
    // A prop with one small map: KTX2 saves far less than the transcoder players would fetch.
    const { result } = await compress(false, prop);
    expect(result.outcome).toBe("kept");
    expect(result.mesh).toBe(prop);
    expect(result.ktx2Bytes).toBeGreaterThan(0);
    // The armour's four large maps save more than the transcoder costs, even in a scene without KTX2.
    expect((await compress(false)).result.outcome).toBe("compressed");
  }, 120_000);

  it("doesn't load the encoder for a model without PNG or JPEG maps", async () => {
    let loads = 0;
    const plain: MeshAsset = { name: "rock", primitives: [mesh.primitives[1]!] };
    const result = await compressMeshTextures(plain, { sceneHasKtx2: false, decode: async () => null, encoder: async () => ((loads += 1), () => null) });
    expect(result.outcome).toBe("none");
    expect(loads).toBe(0);
  });
});

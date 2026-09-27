/**
 * KTX2 (Basis Universal) textures (ENGINE_ROADMAP.md, Phase 4): imported from
 * glTF's KHR_texture_basisu, transcoded to RGBA by the vendored transcoder,
 * kept compressed only when that saves more than the transcoder costs, counted
 * in the download budget, and decoded by the player only for scenes that have
 * one.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { composeModelMatrix, encodeGlb, isKtx2, parseGlb, parseGltf, type DecodedTexture, type MeshAsset } from "@cartbox/editor";
import { MeshOverlaySurface, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { KTX2_TRANSCODER_TRANSFER_BYTES, gzipSize, measureDownload } from "../apps/web/src/lib/downloadBudget";
import { transcodeKtx2 } from "../apps/web/src/lib/ktx2Decoder";
import { keepKtx2, sceneHasKtx2, settleKtx2Textures } from "../apps/web/src/lib/ktx2Policy";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const vendor = (name: string) => new URL(`../apps/web/src/vendor/basis/${name}`, import.meta.url);

async function basisModule() {
  const require = createRequire(import.meta.url);
  const createBasis = require(vendor("basis_transcoder.cjs").pathname) as (o: object) => Promise<{ initializeBasis(): void }>;
  const wasm = readFileSync(vendor("basis_transcoder.wasm"));
  const basis = await createBasis({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  basis.initializeBasis();
  return basis;
}

/** A minimal PNG encoder (unfiltered rows, zlib), so the policy measures real PNG sizes. */
async function encodePng(texture: DecodedTexture): Promise<Uint8Array> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, texture.width);
  hv.setUint32(4, texture.height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(texture.height * (texture.width * 4 + 1));
  for (let y = 0; y < texture.height; y += 1) raw.set(texture.data.subarray(y * texture.width * 4, (y + 1) * texture.width * 4), y * (texture.width * 4 + 1) + 1);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A one-quad glTF whose base colour is a KHR_texture_basisu KTX2 image. */
function ktx2Gltf(image: Uint8Array): { json: Parameters<typeof parseGltf>[0]; buffers: Uint8Array[] } {
  const positions = Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const uvs = Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const parts = [new Uint8Array(positions.buffer), new Uint8Array(uvs.buffer), new Uint8Array(indices.buffer), image];
  const bin = new Uint8Array(parts.reduce((n, p) => n + p.length + 3, 0));
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let at = 0;
  for (const p of parts) {
    bin.set(p, at);
    views.push({ buffer: 0, byteOffset: at, byteLength: p.length });
    at += p.length + ((4 - (p.length % 4)) % 4);
  }
  return {
    json: {
      extensionsUsed: ["KHR_texture_basisu"],
      extensionsRequired: ["KHR_texture_basisu"],
      buffers: [{ byteLength: bin.length }],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 4, type: "VEC2" },
        { bufferView: 2, componentType: 5125, count: 6, type: "SCALAR" },
      ],
      images: [{ bufferView: 3, mimeType: "image/ktx2" }],
      textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    },
    buffers: [bin],
  };
}

/** The four quadrant colours the fixtures were encoded from (8×8: red, green / blue, white). */
function expectQuadrants(texture: DecodedTexture, tolerance: number) {
  expect([texture.width, texture.height]).toEqual([8, 8]);
  const at = (x: number, y: number) => Array.from(texture.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
  const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]!)).toBeLessThanOrEqual(tolerance));
  near(at(1, 1), [255, 0, 0, 255]);
  near(at(6, 1), [0, 255, 0, 255]);
  near(at(1, 6), [0, 0, 255, 255]);
  near(at(6, 6), [255, 255, 255, 255]);
}

describe("KTX2 import", () => {
  it("reads a KHR_texture_basisu texture as image/ktx2, and writes one back", () => {
    const { json, buffers } = ktx2Gltf(fixture("quad8-uastc.ktx2"));
    const mesh = parseGltf(json, buffers, "crate");
    const image = mesh.primitives[0]!.material.baseColorImage!;
    expect(image.mime).toBe("image/ktx2");
    expect(isKtx2(image.bytes)).toBe(true);
    const again = parseGlb(encodeGlb(mesh));
    expect(again.primitives[0]!.material.baseColorImage).toEqual(image);
  });
});

describe("the Basis transcoder", () => {
  it("transcodes UASTC and ETC1S KTX2 files to RGBA", async () => {
    const basis = await basisModule();
    expectQuadrants(transcodeKtx2(basis, fixture("quad8-uastc.ktx2"))!, 8);
    // ETC1S is the lossier mode.
    expectQuadrants(transcodeKtx2(basis, fixture("quad8-etc1s.ktx2"))!, 40);
  });

  it("returns null for bytes that aren't KTX2", async () => {
    expect(transcodeKtx2(await basisModule(), new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("is the size the download budget says", async () => {
    const actual = (await gzipSize(readFileSync(vendor("basis_transcoder.cjs")))) + (await gzipSize(readFileSync(vendor("basis_transcoder.wasm"))));
    expect(Math.abs(actual - KTX2_TRANSCODER_TRANSFER_BYTES) / actual).toBeLessThan(0.05);
  });
});

describe("when KTX2 stays", () => {
  it("keeps KTX2 only when it saves more than the transcoder, unless the scene already pays for it", () => {
    const big = KTX2_TRANSCODER_TRANSFER_BYTES + 1000;
    expect(keepKtx2({ ktx2Bytes: 100_000, pngBytes: 100_000 + big, sceneHasKtx2: false })).toBe(true);
    expect(keepKtx2({ ktx2Bytes: 100_000, pngBytes: 150_000, sceneHasKtx2: false })).toBe(false);
    expect(keepKtx2({ ktx2Bytes: 100_000, pngBytes: 150_000, sceneHasKtx2: true })).toBe(true);
    expect(keepKtx2({ ktx2Bytes: 100_000, pngBytes: 90_000, sceneHasKtx2: true })).toBe(false);
  });

  it("converts a small model's KTX2 textures to PNG, and keeps them in a scene that already has KTX2", async () => {
    const basis = await basisModule();
    const decode = (bytes: Uint8Array) => transcodeKtx2(basis, bytes);
    const { json, buffers } = ktx2Gltf(fixture("quad8-etc1s.ktx2"));
    const mesh = parseGltf(json, buffers, "crate");

    const converted = await settleKtx2Textures(mesh, { sceneHasKtx2: false, decode, encodePng });
    expect(converted.outcome).toBe("converted");
    const png = converted.mesh.primitives[0]!.material.baseColorImage!;
    expect(png.mime).toBe("image/png");
    expect(Array.from(png.bytes.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"
    expect(mesh.primitives[0]!.material.baseColorImage!.mime).toBe("image/ktx2"); // the input is untouched

    // Already paying for the transcoder: keep KTX2 whenever it's the smaller form.
    const settled = await settleKtx2Textures(mesh, { sceneHasKtx2: true, decode, encodePng });
    expect(settled.outcome).toBe(settled.ktx2Bytes < settled.pngBytes ? "kept" : "converted");
    expect((await settleKtx2Textures(parseGltf(ktx2Gltf(fixture("quad8-uastc.ktx2")).json, ktx2Gltf(fixture("quad8-uastc.ktx2")).buffers), { sceneHasKtx2: false, decode, encodePng })).outcome).toBe("converted");
  });

  it("leaves a mesh without KTX2 alone", async () => {
    const mesh: MeshAsset = { name: "plain", primitives: [] };
    const decode = vi.fn(() => null);
    expect(await settleKtx2Textures(mesh, { sceneHasKtx2: false, decode, encodePng })).toMatchObject({ mesh, outcome: "none" });
    expect(decode).not.toHaveBeenCalled();
  });

  it("spots KTX2 in a stored scene", () => {
    expect(sceneHasKtx2(['{"primitives":[{"material":{"image":{"mime":"image/ktx2","bytes":""}}}]}'])).toBe(true);
    expect(sceneHasKtx2(['{"primitives":[{"material":{"image":{"mime":"image/png","bytes":""}}}]}'])).toBe(false);
  });
});

describe("the download budget", () => {
  it("counts the transcoder only for scenes with KTX2 textures", async () => {
    const base = { modelId: "modern" as const, cartridge: null, otherData: [], uploadedBytes: 0 };
    const withKtx2 = await measureDownload({ ...base, meshSidecar: '{"meshes":[{"mesh":"{\\"mime\\":\\"image/ktx2\\"}"}]}'.replace(/\\"/g, '"') });
    expect(withKtx2.items.find((i) => i.key === "transcoder")?.bytes).toBe(KTX2_TRANSCODER_TRANSFER_BYTES);
    const without = await measureDownload({ ...base, meshSidecar: '{"meshes":[]}' });
    expect(without.items.some((i) => i.key === "transcoder")).toBe(false);
  });
});

describe("the player", () => {
  function ktx2Scene(mesh: MeshAsset) {
    return {
      instances: [
        { mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
        { mesh, model: composeModelMatrix([2, 0, 0], [0, 0, 0], [1, 1, 1]) },
      ],
      bounds: { min: [-1, -1, -1] as [number, number, number], max: [3, 1, 1] as [number, number, number], center: [1, 0, 0] as [number, number, number], radius: 3 },
      lighting: null,
    };
  }
  const recorder = (): SceneRenderer & { draws: { textures: unknown[] }[] } => {
    const draws: { textures: unknown[] }[] = [];
    return { backend: "software", draws, render: (instances, _draw: SceneDraw) => void draws.push({ textures: instances.map((i) => i.textures?.[0] ?? null) }), dispose: () => {} };
  };

  it("loads the KTX2 decoder once for a scene that has KTX2 textures, and uses it", async () => {
    const { json, buffers } = ktx2Gltf(fixture("quad8-uastc.ktx2"));
    const mesh = parseGltf(json, buffers, "crate");
    const basis = await basisModule();
    const decode = vi.fn((bytes: Uint8Array) => transcodeKtx2(basis, bytes));
    const loader = vi.fn(async () => decode);
    const renderer = recorder();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, ktx2Scene(mesh), renderer, { ktx2: loader });
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1); // two copies, one mesh: decoded once
    const texture = renderer.draws.at(-1)!.textures[0] as DecodedTexture;
    expectQuadrants(texture, 8);
  });

  it("never loads it for a scene without KTX2, and falls back to flat colour without a loader", async () => {
    const loader = vi.fn(async () => () => null);
    const plain: MeshAsset = { ...parseGltf(ktx2Gltf(fixture("quad8-uastc.ktx2")).json, ktx2Gltf(fixture("quad8-uastc.ktx2")).buffers) };
    const noTexture: MeshAsset = { ...plain, primitives: plain.primitives.map((p) => ({ ...p, material: { ...p.material, baseColorImage: null } })) };
    await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, ktx2Scene(noTexture), recorder(), { ktx2: loader });
    expect(loader).not.toHaveBeenCalled();

    const renderer = recorder();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, ktx2Scene(plain), renderer);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(renderer.draws.at(-1)!.textures[0]).toBeNull();
  });
});

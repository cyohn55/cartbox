/**
 * KTX2 to the GPU's own compressed formats (AAA_FIDELITY_ROADMAP.md F1a): the
 * encoder writes the mip chain; the transcoder turns it into BC7, ASTC 4×4 or
 * ETC2 for a renderer that names them, keeping the RGBA top level for every
 * other path; the memory estimate counts the compressed bytes. On a real
 * device (Dawn, which has BC), the WebGPU renderer uploads the chain and draws
 * it as the RGBA path does, within BC7's error.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, DEFAULT_RASTER_STYLE, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer, type SceneDraw } from "@cartbox/player";
import { transcodeKtx2, NATIVE_TARGETS } from "@/lib/ktx2Decoder";
import { encodeKtx2 } from "@/lib/ktx2Encoder";
import { textureMemory } from "../packages/player/src/debug/profiler";
import { compressedFormatsFor } from "../packages/player/src/lighting/webgpuDevice";

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
function painted(size: number): DecodedTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = 90 + 80 * Math.sin(x / 9);
      data[i + 1] = 110 + 60 * Math.cos(y / 11);
      data[i + 2] = 140 + 50 * Math.sin((x + y) / 13);
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

const encoder = await encoderModule();
const transcoder = await transcoderModule();

describe("transcoding to the GPU's formats", () => {
  const file = encodeKtx2(encoder, painted(64), "color")!;

  it("keeps the RGBA top level and adds the whole chain in the first format it can", () => {
    const decoded = transcodeKtx2(transcoder, file, { gpuFormats: ["bc7-rgba-unorm", "astc-4x4-unorm"] })!;
    expect(decoded.width).toBe(64);
    expect(decoded.data.length).toBe(64 * 64 * 4);
    const gpu = decoded.gpu!;
    expect(gpu.format).toBe("bc7-rgba-unorm");
    // 64 → 1: seven levels, each whole 4×4 blocks of 16 bytes (the last few one block).
    expect(gpu.levels.map((l) => l.width)).toEqual([64, 32, 16, 8, 4, 2, 1]);
    for (const level of gpu.levels) expect(level.data.byteLength).toBe(Math.ceil(level.width / 4) * Math.ceil(level.height / 4) * 16);
    // A byte a texel at the top, a quarter of RGBA's.
    expect(gpu.levels[0]!.data.byteLength).toBe(64 * 64);
  });

  it("transcodes to each format a device may sample", () => {
    for (const format of Object.keys(NATIVE_TARGETS)) {
      const decoded = transcodeKtx2(transcoder, file, { gpuFormats: [format] })!;
      expect(decoded.gpu?.format).toBe(format);
      expect(decoded.gpu?.levels.length).toBe(7);
    }
  });

  it("adds nothing without formats, for a format it can't make, or for a file without its mips", () => {
    expect(transcodeKtx2(transcoder, file)!.gpu).toBeUndefined();
    expect(transcodeKtx2(transcoder, file, { gpuFormats: ["rgba8unorm"] })!.gpu).toBeUndefined();
    // A file encoded before mips rode in KTX2 (one level): the renderer must make the mips, so it gets RGBA.
    const flat = new encoder.BasisEncoder();
    flat.setCreateKTX2File(true);
    flat.setMipGen(false);
    flat.setKTX2AndBasisSRGBTransferFunc(true);
    flat.setPerceptual(true);
    flat.setUASTC(false);
    flat.setQualityLevel(128);
    const tex = painted(32);
    flat.setSliceSourceImage(0, new Uint8Array(tex.data.buffer), 32, 32, 0);
    const out = new Uint8Array(64 * 1024);
    const length = flat.encode(out);
    flat.delete();
    expect(length).toBeGreaterThan(0);
    expect(transcodeKtx2(transcoder, out.slice(0, length), { gpuFormats: ["bc7-rgba-unorm"] })!.gpu).toBeUndefined();
  });

  it("counts a compressed texture's own bytes in the memory estimate: under a third of RGBA's with mips", () => {
    const rgba = transcodeKtx2(transcoder, file)!;
    const bc7 = transcodeKtx2(transcoder, file, { gpuFormats: ["bc7-rgba-unorm"] })!;
    expect(textureMemory(rgba)).toBe(Math.round((64 * 64 * 4 * 4) / 3));
    expect(textureMemory(bc7)).toBe(bc7.gpu!.levels.reduce((s, l) => s + l.data.byteLength, 0));
    expect(textureMemory(rgba) / textureMemory(bc7)).toBeGreaterThan(3.9);
  });

  it("names a device's formats: BC7 first, then ASTC, then ETC2", () => {
    const device = (features: string[]) => ({ features: new Set(features) });
    expect(compressedFormatsFor(device([]))).toEqual([]);
    expect(compressedFormatsFor(device(["texture-compression-etc2", "texture-compression-astc"]))).toEqual(["astc-4x4-unorm", "etc2-rgba8unorm"]);
    expect(compressedFormatsFor(device(["texture-compression-bc", "texture-compression-etc2"]))).toEqual(["bc7-rgba-unorm", "etc2-rgba8unorm"]);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    if (!adapter?.features?.has?.("texture-compression-bc")) return null;
    return await adapter.requestDevice({ requiredFeatures: ["texture-compression-bc"] });
  } catch {
    return null;
  }
}
const device = await realDevice();

async function until(done: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
}

describe.skipIf(!device)("on a real device", { timeout: 60_000 }, () => {
  it("uploads the BC7 chain and draws it as the RGBA path does, within BC7's error", async () => {
    const W = 64;
    const H = 48;
    const file = encodeKtx2(encoder, painted(64), "color")!;
    const quad = (): MeshAsset =>
      ({
        name: "q",
        primitives: [
          {
            positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
            normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
            material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
          },
        ],
      }) as unknown as MeshAsset;
    const shot = async (texture: DecodedTexture) => {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H, { ...DEFAULT_RASTER_STYLE, textureFiltering: "bilinear" }, { mips: true }))!;
      expect(renderer.textureFormats).toContain("bc7-rgba-unorm");
      const instances: MeshSceneInstance[] = [{ mesh: quad(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1.2, 1.2, 1]), textures: [texture] }];
      const draw = (): SceneDraw =>
        ({
          width: W,
          height: H,
          out: new Uint8ClampedArray(W * H * 4),
          depth: new Float32Array(W * H),
          background: [0, 0, 0, 255],
          view: viewMatrix([0, 0, 3], [0, 0, 0]),
          projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 50),
          lightDirection: [0, -1, 0],
          ambient: 0.8,
        }) as unknown as SceneDraw;
      for (let i = 0; i < 4; i += 1) {
        renderer.render(instances, draw());
        await until(() => false, 15);
      }
      const out = draw();
      renderer.render(instances, out);
      const uploaded = (renderer as any).colourTextures.get(texture);
      renderer.dispose();
      return { pixels: out.out, format: uploaded?.format };
    };
    const rgba = await shot(transcodeKtx2(transcoder, file)!);
    const bc7 = await shot(transcodeKtx2(transcoder, file, { gpuFormats: ["bc7-rgba-unorm"] })!);
    expect(rgba.format).toBe("rgba8unorm");
    expect(bc7.format).toBe("bc7-rgba-unorm");
    let drawn = 0;
    let total = 0;
    let max = 0;
    for (let i = 0; i < W * H * 4; i += 4) {
      if (rgba.pixels[i + 1]! === 0 && rgba.pixels[i]! === 0) continue;
      drawn += 1;
      for (let k = 0; k < 3; k += 1) {
        const d = Math.abs(rgba.pixels[i + k]! - bc7.pixels[i + k]!);
        total += d;
        max = Math.max(max, d);
      }
    }
    expect(drawn).toBeGreaterThan(500);
    // ETC1S → BC7 versus ETC1S → RGBA: the same blocks, re-quantised.
    expect(total / (drawn * 3)).toBeLessThan(6);
    expect(max).toBeLessThan(32);
  });
});

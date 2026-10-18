/**
 * Mipmapped textures (AAA_FIDELITY_ROADMAP.md F1a): the chain arithmetic, the
 * GPU generator (a colour map averaged in linear light), and, on a real device
 * (Dawn), the renderer's trilinear, anisotropic sampling. It takes the shimmer
 * out of a fine pattern seen far off, and keeps a cut-out's coverage.
 */

import { describe, expect, it } from "vitest";

import { MAX_ANISOTROPY, MipmapGenerator, coverageMips, hasTransparency, mipLevelCount, mipSize } from "../packages/player/src/render/mipmaps";
import { WebgpuSceneRenderer, type SceneDraw } from "@cartbox/player";
import { DEFAULT_RASTER_STYLE, composeModelMatrix, projectionMatrix, viewMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

describe("the chain", () => {
  it("runs down to 1×1, halving each side (never below 1)", () => {
    expect(mipLevelCount(1, 1)).toBe(1);
    expect(mipLevelCount(256, 256)).toBe(9);
    expect(mipLevelCount(300, 20)).toBe(9);
    expect(mipSize(300, 20, 3)).toEqual({ width: 37, height: 2 });
    expect(mipSize(300, 20, 8)).toEqual({ width: 1, height: 1 });
    expect(MAX_ANISOTROPY).toBe(16);
  });

  it("mips a cut-out keeping its coverage, where plain averaging would thin it", () => {
    // A 32×32 card: a disc of opaque green, see-through around it.
    const n = 32;
    const data = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
        data.set([60, 180, 40, r < 0.7 ? 255 : 0], (y * n + x) * 4);
      }
    }
    const card = { width: n, height: n, data };
    expect(hasTransparency(card)).toBe(true);
    expect(hasTransparency(checker(4))).toBe(false);
    const share = (t: { data: Uint8ClampedArray }) => {
      let kept = 0;
      for (let i = 3; i < t.data.length; i += 4) if (t.data[i]! >= 128) kept += 1;
      return kept / (t.data.length / 4);
    };
    const mips = coverageMips(card);
    expect(mips.map((m) => m.width)).toEqual([16, 8, 4, 2, 1]);
    // The share kept tracks the full-size card's (about π·0.35² ≈ 38%), as closely as whole texels allow.
    expect(Math.abs(share(mips[0]!) - share(card))).toBeLessThan(0.03);
    expect(Math.abs(share(mips[1]!) - share(card))).toBeLessThan(0.15);
    // The colour is the card's, never darkened toward the see-through texels' black.
    const centre = mips[2]!.data.subarray((2 * 4 + 2) * 4, (2 * 4 + 2) * 4 + 3);
    expect(Array.from(centre)).toEqual([60, 180, 40]);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
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

/** One mip level of an rgba8unorm texture, as bytes. */
async function readLevel(texture: any, width: number, height: number, mipLevel: number): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, mipLevel }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  let mapped = false;
  void buffer.mapAsync(0x01).then(() => (mapped = true));
  await until(() => mapped);
  const padded = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  buffer.unmap();
  buffer.destroy();
  return out;
}

/** A one-texel black-and-white checkerboard (opaque), `n`×`n`. */
function checker(n: number): DecodedTexture {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) data.set((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * n + x) * 4);
  return { width: n, height: n, data };
}

describe.skipIf(!device)("on a real device", { timeout: 60_000 }, () => {
  it("averages a colour map's mips in linear light, a data map's as bytes", async () => {
    const make = (srgb: boolean) =>
      device.createTexture({ size: { width: 4, height: 4 }, format: "rgba8unorm", mipLevelCount: 3, usage: 0x04 | 0x02 | 0x10 | 0x01, ...(srgb ? { viewFormats: ["rgba8unorm-srgb"] } : {}) });
    const source = checker(4);
    const generator = new MipmapGenerator(device);
    const out: Record<string, Uint8Array> = {};
    for (const srgb of [false, true]) {
      const texture = make(srgb);
      device.queue.writeTexture({ texture }, source.data, { bytesPerRow: 16, rowsPerImage: 4 }, { width: 4, height: 4 });
      generator.generate(texture, 3, srgb ? "rgba8unorm-srgb" : "rgba8unorm");
      out[srgb ? "colour" : "data"] = await readLevel(texture, 1, 1, 2);
      texture.destroy();
    }
    // Half white, half black: 0.5 linear is 188 in sRGB; the plain average of the bytes is 128.
    expect(Math.abs(out.colour![0]! - 188)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data![0]! - 128)).toBeLessThanOrEqual(1);
    expect(out.colour![3]).toBe(255);
  });

  const W = 96;
  const H = 64;
  const plane = (material: Record<string, unknown>, repeat: number): MeshAsset =>
    ({
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: Float32Array.from([0, 0, repeat, 0, repeat, repeat, 0, repeat]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, ...material },
        },
      ],
    }) as unknown as MeshAsset;
  const draw = (eyeZ = 6): SceneDraw =>
    ({
      width: W,
      height: H,
      out: new Uint8ClampedArray(W * H * 4),
      depth: new Float32Array(W * H),
      background: [0, 0, 0, 255],
      view: viewMatrix([0, 1.2, eyeZ], [0, 0, eyeZ - 26]),
      projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 200),
      // Unlit-looking: the ambient floor alone, so a texel's byte shows through unclipped.
      lightDirection: [0, -1, 0],
      ambient: 0.6,
    }) as unknown as SceneDraw;
  const frames = async (instances: MeshSceneInstance[], mips: boolean, eyes: readonly number[] = [6]): Promise<Uint8ClampedArray[]> => {
    // A filtering era (the Modern tier's): mips apply where texels are filtered at all.
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, { ...DEFAULT_RASTER_STYLE, textureFiltering: "bilinear" }, { mips }))!;
    const shots: Uint8ClampedArray[] = [];
    for (const eye of eyes) {
      for (let i = 0; i < 4; i += 1) {
        renderer.render(instances, draw(eye));
        await until(() => false, 15);
      }
      const out = draw(eye);
      renderer.render(instances, out);
      shots.push(out.out);
    }
    renderer.dispose();
    return shots;
  };
  /** The far floor: the rows just below the horizon, where many texels fall on each pixel. */
  const FAR_ROWS = [31, 37] as const;
  const farPixels = (pixels: Uint8ClampedArray) => {
    const values: number[] = [];
    for (let y = FAR_ROWS[0]; y < FAR_ROWS[1]; y += 1) for (let x = 8; x < W - 8; x += 1) values.push(pixels[(y * W + x) * 4]!);
    return values;
  };

  it("takes the shimmer out of a fine pattern far off: trilinear, anisotropic", async () => {
    // A long floor of a one-texel checkerboard, receding to the horizon; the camera steps 3 cm forward.
    const floor: MeshSceneInstance[] = [{ mesh: plane({}, 400), model: composeModelMatrix([0, 0, -34], [0, 0, 0], [40, 1, 40]), textures: [checker(64)] }];
    const measure = (shots: Uint8ClampedArray[]) => {
      const [a, b] = shots.map(farPixels) as [number[], number[]];
      const mean = a.reduce((s, v) => s + v, 0) / a.length;
      const spread = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
      // Shimmer: how much the far pixels change as the camera moves a hair.
      const shimmer = a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
      return { mean, spread, shimmer };
    };
    const plain = measure(await frames(floor, false, [6, 5.97]));
    const mipped = measure(await frames(floor, true, [6, 5.97]));
    // Without mips each far pixel lands on whichever texel it hits: it flickers as the camera moves.
    expect(plain.shimmer).toBeGreaterThan(8);
    // With them it is the pattern's average, steady.
    expect(mipped.shimmer).toBeLessThan(plain.shimmer / 4);
    expect(mipped.spread).toBeLessThan(plain.spread);
    // …and the grey it averages to is the linear-light one: 0.6 × 188, not 0.6 × 128.
    expect(Math.abs(mipped.mean - 0.6 * 188)).toBeLessThan(8);
  });

  it("keeps a cut-out's coverage far off, where its alpha has averaged down its mips", async () => {
    // Grass-card-like alpha: a solid disc covering about half the texture, its rim at the cutoff.
    const n = 64;
    const data = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
        data.set([80, 200, 60, r < 0.8 ? 255 : 0], (y * n + x) * 4);
      }
    }
    const card: DecodedTexture = { width: n, height: n, data };
    const quad = plane({ alphaMode: "mask", alphaCutoff: 0.5 }, 24);
    // A field of tiled cards seen far off, so each card covers a fraction of a pixel.
    const field: MeshSceneInstance[] = [{ mesh: quad, model: composeModelMatrix([0, 0, -34], [0, 0, 0], [40, 1, 40]), textures: [card] }];
    const coverage = (pixels: Uint8ClampedArray) => {
      let drawn = 0;
      let total = 0;
      // Far, but not the farthest: there the chain is down to a few texels a tile, too few to hold any coverage exactly.
      for (let y = 32; y < 41; y += 1) {
        for (let x = 8; x < W - 8; x += 1) {
          total += 1;
          if (pixels[(y * W + x) * 4 + 1]! > 20) drawn += 1;
        }
      }
      return drawn / total;
    };
    const [plain] = await frames(field, false);
    const [mipped] = await frames(field, true);
    // The disc covers π·0.8²/4 ≈ 50% of each tile. Far off, mipped with its coverage kept, the field still
    // reads about half covered: neither thinned away (plain averaging) nor filled in.
    expect(Math.abs(coverage(mipped!) - 0.5)).toBeLessThan(0.1);
    expect(Math.abs(coverage(plain!) - 0.5)).toBeLessThan(0.15);
  });
});

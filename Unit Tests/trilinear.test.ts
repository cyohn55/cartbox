/**
 * True trilinear filtering on the fantasy tiers (AAA_FIDELITY_ROADMAP.md F1a):
 * the N64 onward declare it, and every backend now does it — the software
 * rasteriser builds a texture's chain and picks each pixel's level from its UV
 * derivatives, and WebGPU and WebGL2 upload that same chain and sample it
 * trilinearly. (WebGL2's parity runs in webgl-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_RASTER_STYLE, composeModelMatrix, mipLevelOf, projectionMatrix, textureMips, viewMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer, type SceneDraw } from "@cartbox/player";
import { N64_RASTER_CAPS, XBOX360_RASTER_CAPS } from "../packages/player/src/models";
import { SoftwareSceneRenderer } from "../packages/player/src/render/sceneRenderer";
import { rasterStyleFor } from "../packages/player/src/render/renderCaps";

const checker = (n: number): DecodedTexture => {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) data.set((x + y) % 2 ? [230, 200, 60, 255] : [30, 60, 160, 255], (y * n + x) * 4);
  return { width: n, height: n, data };
};

describe("the chain and the level", () => {
  it("halves each side down to 1×1, each texel the rounded mean of the four above", () => {
    const chain = textureMips(checker(8));
    expect(chain.map((l) => `${l.width}×${l.height}`)).toEqual(["8×8", "4×4", "2×2", "1×1"]);
    // A one-texel checker averages to its two colours' mean everywhere below the top.
    expect([...chain[1]!.data.subarray(0, 4)]).toEqual([130, 130, 110, 255]);
    expect(textureMips(chain[0]!)).toBe(chain);
    const odd = textureMips({ width: 5, height: 3, data: new Uint8ClampedArray(5 * 3 * 4).fill(100) });
    expect(odd.map((l) => `${l.width}×${l.height}`)).toEqual(["5×3", "2×1", "1×1"]);
    expect(odd[1]!.data[0]).toBe(100);
  });

  it("picks the level by the larger of the footprint's two axes, in texels", () => {
    // A 64-texel map, a pixel spanning a sixteenth of it across x: four texels, level 2.
    expect(mipLevelOf(64, 64, [1 / 16, 0, 0, 1 / 64])).toBeCloseTo(2, 9);
    // Magnified: below 0.
    expect(mipLevelOf(64, 64, [1 / 256, 0, 0, 1 / 256])).toBeLessThan(0);
    // A detail map tiled 4× reads 2 levels further down.
    expect(mipLevelOf(64, 64, [1 / 64, 0, 0, 1 / 64], 4)).toBeCloseTo(2, 9);
  });

  it("is what the N64 and the 360 ask for, on every backend", () => {
    expect(rasterStyleFor(N64_RASTER_CAPS).textureFiltering).toBe("trilinear");
    expect(rasterStyleFor(XBOX360_RASTER_CAPS).textureFiltering).toBe("trilinear");
  });
});

const W = 96;
const H = 64;
const floor = (): MeshSceneInstance => ({
  mesh: {
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 24, 0, 24, 24, 0, 24]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "checker", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  } as unknown as MeshAsset,
  model: composeModelMatrix([0, 0, -14], [0, 0, 0], [16, 1, 16]),
  textures: [checker(32)],
});
const draw = (eyeZ = 2, eyeY = 1.2): SceneDraw =>
  ({
    width: W,
    height: H,
    out: new Uint8ClampedArray(W * H * 4),
    depth: new Float32Array(W * H),
    view: viewMatrix([0, eyeY, eyeZ], [0, 0, eyeZ - 10]),
    projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 200),
    background: [0, 0, 0, 255],
  }) as unknown as SceneDraw;
const TRILINEAR = { ...DEFAULT_RASTER_STYLE, textureFiltering: "trilinear" as const };
const BILINEAR = { ...DEFAULT_RASTER_STYLE, textureFiltering: "bilinear" as const };
/** A band of rows' red. The horizon falls at row 27: just below it many texels fall on each pixel. */
const redOf = (pixels: Uint8ClampedArray, from: number, to: number) => {
  const values: number[] = [];
  for (let y = from; y < to; y += 1) for (let x = 8; x < W - 8; x += 1) values.push(pixels[(y * W + x) * 4]!);
  return values;
};
const farRed = (pixels: Uint8ClampedArray) => redOf(pixels, 28, 33);
const meanOf = (values: readonly number[]) => values.reduce((s, v) => s + v, 0) / values.length;
/** The lit checker's mean red, read where it is magnified: whole rows close up hold as many of each colour. */
const nearMean = (pixels: Uint8ClampedArray) => meanOf(redOf(pixels, H - 8, H));

describe("the software rasteriser", () => {
  it("takes the shimmer out of a fine checker far off, and leaves it as it was close up", () => {
    const shot = (style: typeof TRILINEAR, eye: number, height?: number) => {
      const d = draw(eye, height);
      new SoftwareSceneRenderer(style).render([floor()], d);
      return d.out;
    };
    const tri = [shot(TRILINEAR, 2), shot(TRILINEAR, 1.97)].map(farRed) as [number[], number[]];
    const bi = [shot(BILINEAR, 2), shot(BILINEAR, 1.97)].map(farRed) as [number[], number[]];
    const shimmer = ([a, b]: [number[], number[]]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;
    expect(shimmer(bi)).toBeGreaterThan(10);
    expect(shimmer(tri)).toBeLessThan(shimmer(bi) / 3);
    // Far off it reads the lit checker's mean red, as the close-up rows average to.
    expect(Math.abs(meanOf(tri[0]) - nearMean(shot(TRILINEAR, 2)))).toBeLessThan(10);
    // Close up (the bottom rows from a low eye, magnified), trilinear is bilinear exactly.
    const near = (pixels: Uint8ClampedArray) => Array.from(pixels.subarray((H - 4) * W * 4, H * W * 4));
    expect(near(shot(TRILINEAR, 2, 0.15))).toEqual(near(shot(BILINEAR, 2, 0.15)));
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

describe.skipIf(!device)("WebGPU, on a real device", { timeout: 60_000 }, () => {
  it("filters trilinearly like the software rasteriser: the same chain, the level by the footprint", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, TRILINEAR))!;
    expect(renderer).not.toBeNull();
    const instances = [floor()];
    renderer.render(instances, draw());
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      device.tick?.();
    }
    const gpu = draw();
    renderer.render(instances, gpu);
    renderer.dispose();
    const software = draw();
    new SoftwareSceneRenderer(TRILINEAR).render(instances, software);
    let drawn = 0;
    let far = 0;
    for (let p = 0; p < W * H; p += 1) {
      if (software.out[p * 4 + 3]! === 0) continue;
      drawn += 1;
      if ([0, 1, 2].some((c) => Math.abs(gpu.out[p * 4 + c]! - software.out[p * 4 + c]!) > 8)) far += 1;
    }
    // The GPU takes a 2×2 quad's level from finite differences, the rasteriser each pixel's from its exact
    // derivatives: on the horizon they can fall either side of a level boundary, a blend step apart.
    expect(drawn).toBeGreaterThan(1000);
    expect(far / drawn).toBeLessThan(0.05);
    // And the GPU's far floor is the chain's mean too, not a flicker.
    expect(Math.abs(meanOf(farRed(gpu.out)) - nearMean(gpu.out))).toBeLessThan(10);
  });
});

/**
 * Temporal upscaling on the AAA tier (AAA_FIDELITY_ROADMAP.md F4b): the jitter
 * sequence's length, the uniforms, and on a real device a frame of thin
 * glowing slivers rendered at half the display's size and reconstructed over
 * the frames: it comes out at the display's size, closer to the native frame
 * than a plain upsample of one half-size frame is, and its first frame is a
 * plain filtered upsample.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, defaultSceneLighting, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MeshOverlaySurface, QUALITY_PRESETS, WebgpuSceneRenderer, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import { TEMPORAL_SAMPLES, temporalJitter } from "../packages/player/src/render/temporal";
import { UPSCALE_MODES, UPSCALE_UNIFORM_FLOATS, upscaleJitterPhases, upscaleUniforms } from "../packages/player/src/render/upscaler";

describe("the upscaler's set-up", () => {
  it("lengthens the jitter sequence by the display pixels a render pixel covers", () => {
    expect(upscaleJitterPhases(1920, 1920)).toBe(TEMPORAL_SAMPLES);
    expect(upscaleJitterPhases(960, 1920)).toBe(TEMPORAL_SAMPLES * 4);
    expect(upscaleJitterPhases(1280, 1920)).toBe(18);
    expect(UPSCALE_MODES.performance).toBe(0.5);
    // A longer sequence still stays within the pixel, and doesn't repeat within its length.
    const seen = new Set<string>();
    for (let f = 0; f < 32; f += 1) {
      const [x, y] = temporalJitter(f, 32);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      seen.add(`${x},${y}`);
    }
    expect(seen.size).toBe(32);
  });

  it("carries the jitter as it moves the image on screen, and both sizes", () => {
    const u = upscaleUniforms([0.25, 0.125], { width: 64, height: 32 }, { width: 128, height: 64 }, true);
    expect(u).toHaveLength(UPSCALE_UNIFORM_FLOATS);
    expect([...u.slice(4, 12)]).toEqual([0.25, -0.125, 64, 32, 128, 64, 0, 0]);
    expect(u[2]).toBe(1);
  });
});

describe("the player under upscaling", () => {
  it("renders Medium's AAA frames at two-thirds and asks for the display's size back, and High's at full size", async () => {
    const draws: GpuSceneDraw[] = [];
    const sizes: [number, number][] = [];
    const make = (cascades: boolean) => ({ backend: "webgpu", sunCascades: cascades, render: () => {}, resize: (w: number, h: number) => sizes.push([w, h]), renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} }) as unknown as SceneRenderer;
    const presenter = { present: (_frame: PresentFrame) => undefined, stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
    const floor = { name: "floor", primitives: [{ positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1]), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: null, indices: Uint32Array.from([0, 2, 1]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }] } as unknown as MeshAsset;
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene = { instances: [{ mesh: floor, model: IDENTITY }], bounds: { min: [-1, 0, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 2 }, lighting: defaultSceneLighting() } as never;
    const frame = async (cascades: boolean, level: "high" | "medium") => {
      const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 48, 30, scene, make(cascades), { presenter, temporal: true, prepass: true } as never);
      surface.setQuality(QUALITY_PRESETS[level]);
      surface.setHudMode(true);
      surface.blit(new Uint8Array(48 * 30 * 4));
      return draws.at(-1)!;
    };
    const medium = await frame(true, "medium");
    expect(sizes.at(-1)).toEqual([32, 20]);
    expect(medium.upscale).toEqual({ width: 48, height: 30 });
    const high = await frame(true, "high");
    expect(sizes.at(-1)).toEqual([48, 30]);
    expect(high.upscale).toBeUndefined();
    // Without the AAA tier (no upscaler), Medium renders at the display's size.
    expect((await frame(false, "medium")).upscale).toBeUndefined();
    expect(sizes.at(-1)).toEqual([48, 30]);
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

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 800 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

const D = 128;

/** A fan of thin glowing slivers on black: edges everywhere, finer than half the display's pixels. */
function slivers(): MeshSceneInstance[] {
  const out: MeshSceneInstance[] = [];
  const mesh = {
    name: "sliver",
    primitives: [
      {
        positions: Float32Array.from([-0.5, -1, 0, 0.5, -1, 0, 0.5, 1, 0, -0.5, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorImage: null, baseColorFactor: [0, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1, emissiveFactor: [1, 1, 1] },
      },
    ],
  } as unknown as MeshAsset;
  for (let i = 0; i < 12; i += 1) out.push({ mesh, model: composeModelMatrix([-1.6 + i * 0.29, 0, 0], [0, 0, i * 0.11], [0.012 + i * 0.002, 1.4, 1]) });
  return out;
}

/** `frames` frames rendered at `render`² and shown at D²; the last frame's linear light (green) and its size. */
async function frame(render: number, frames: number, upscale = render !== D): Promise<{ g: Float32Array; size: [number, number] }> {
  const renderer = (await WebgpuSceneRenderer.create(device, render, render, undefined, { hdr: true }))!;
  const scene = slivers();
  device.pushErrorScope("validation");
  let texture: any = null;
  for (let f = 0; f < frames; f += 1) {
    texture = renderer.renderToTexture!(scene, {
      width: render,
      height: render,
      view: viewMatrix([0, 0, 4], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      ambient: 0,
      lightDirection: [0, 0, 1],
      lights: [],
      prepass: true,
      temporal: true,
      ambientOcclusion: false,
      ...(upscale ? { upscale: { width: D, height: D } } : {}),
    } as any);
  }
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const w = texture.width;
  const h = texture.height;
  const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * h, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: h }, { width: w, height: h });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  renderer.dispose();
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) g[y * w + x] = half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!);
  return { g, size: [w, h] };
}

/** A half-size frame upsampled bilinearly to D². */
function bilinear(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(D * D);
  for (let y = 0; y < D; y += 1) {
    for (let x = 0; x < D; x += 1) {
      const fx = Math.min(n - 1, Math.max(0, ((x + 0.5) * n) / D - 0.5));
      const fy = Math.min(n - 1, Math.max(0, ((y + 0.5) * n) / D - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      out[y * D + x] = (src[y0 * n + x0]! * (1 - tx) + src[y0 * n + x1]! * tx) * (1 - ty) + (src[y1 * n + x0]! * (1 - tx) + src[y1 * n + x1]! * tx) * ty;
    }
  }
  return out;
}

const meanError = (a: Float32Array, b: Float32Array) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]!), 0) / a.length;

describe.skipIf(!device)("the upscaler, on a real device", { timeout: 180_000 }, () => {
  it("reconstructs a half-size frame at the display's size, nearer the native frame than a plain upsample", async () => {
    const native = await frame(D, 48);
    const up = await frame(D / 2, 96);
    expect(up.size).toEqual([D, D]);
    const plain = await frame(D / 2, 1, false);
    // One half-size frame without upscaling comes back at its own size; upsample it on the CPU.
    expect(plain.size).toEqual([D / 2, D / 2]);
    const naive = bilinear(plain.g, D / 2);
    const reconstructed = meanError(up.g, native.g);
    const upsampled = meanError(naive, native.g);
    expect(reconstructed).toBeLessThan(upsampled * 0.8);
    // Nothing lost or gained: the slivers' total light matches the native frame's.
    const total = (a: Float32Array) => a.reduce((s, v) => s + v, 0);
    expect(Math.abs(total(up.g) - total(native.g)) / total(native.g)).toBeLessThan(0.08);
  });
});

/**
 * The AAA tier at the display's own resolution (AAA_FIDELITY_ROADMAP.md F0d):
 * the canvas's backing size follows its CSS size at the device's pixel ratio
 * (up to 4K), the presenter's frame follows the canvas while the cart's 2D
 * layer keeps its size and is scaled to it, and the scene renderer renders at
 * a new size from one frame to the next.
 */

import { describe, expect, it } from "vitest";

import { GpuPresenter, WebgpuSceneRenderer, getModel } from "@cartbox/player";
import { MAX_NATIVE_PIXELS, nativeBackingSize } from "../packages/player/src/render/GpuCanvasSurface";
import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

describe("the backing size of a native frame", () => {
  it("is the CSS size in device pixels, and the tier asks for it", () => {
    expect(nativeBackingSize(1280, 720, 2)).toEqual({ width: 2560, height: 1440 });
    expect(nativeBackingSize(918, 516, 1)).toEqual({ width: 918, height: 516 });
    expect(nativeBackingSize(800, 450, 1.5)).toEqual({ width: 1200, height: 675 });
    expect(nativeBackingSize(640, 360, Number.NaN)).toEqual({ width: 640, height: 360 });
    expect(getModel("aaa").renderCaps.nativeResolution).toBe(true);
    expect(getModel("modern").renderCaps.nativeResolution).toBeUndefined();
  });

  it("stops at 4K, keeping the shape", () => {
    const { width, height } = nativeBackingSize(2560, 1440, 3);
    expect(width * height).toBeLessThanOrEqual(MAX_NATIVE_PIXELS * 1.001);
    expect(width / height).toBeCloseTo(16 / 9, 2);
    expect(width).toBe(3840);
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

/** A texture read back: bytes for rgba8unorm, halves as floats for rgba16float. */
async function read(texture: any, width: number, height: number, format: "rgba8unorm" | "rgba16float"): Promise<(x: number, y: number, k: number) => number> {
  const texel = format === "rgba8unorm" ? 4 : 8;
  const bytesPerRow = Math.ceil((width * texel) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const copy = buffer.getMappedRange().slice(0);
  buffer.unmap();
  buffer.destroy();
  if (format === "rgba8unorm") {
    const bytes = new Uint8Array(copy);
    return (x, y, k) => bytes[y * bytesPerRow + x * 4 + k]!;
  }
  const halves = new Uint16Array(copy);
  return (x, y, k) => half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!);
}

describe.skipIf(!device)("on a real device", { timeout: 60_000 }, () => {
  it("scales the cart's 2D layer to the frame: each layer pixel covers its share of a bigger one", async () => {
    const LW = 32;
    const LH = 16;
    const presenter = new GpuPresenter(device, LW, LH);
    expect([presenter.width, presenter.height]).toEqual([LW, LH]);
    presenter.resize(64, 32);
    expect([presenter.width, presenter.height]).toEqual([64, 32]);
    // A 2D layer of distinct pixels.
    const rgba = new Uint8Array(LW * LH * 4);
    for (let y = 0; y < LH; y += 1) for (let x = 0; x < LW; x += 1) rgba.set([x * 8, y * 16, (x + y) % 2 ? 255 : 0, 255], (y * LW + x) * 4);
    const out = device.createTexture({ size: { width: 64, height: 32 }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    device.pushErrorScope("validation");
    presenter.present({ base: { kind: "frame", rgba }, scene: null }, out, "rgba8unorm");
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const got = await read(out, 64, 32, "rgba8unorm");
    let wrong = 0;
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const lx = x >> 1;
        const ly = y >> 1;
        for (let k = 0; k < 3; k += 1) if (got(x, y, k) !== rgba[(ly * LW + lx) * 4 + k]) wrong += 1;
      }
    }
    expect(wrong).toBe(0);
    presenter.dispose();
  });

  it("renders at a new size from one frame to the next, with its anti-aliasing, history and prepass", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, 64, 36, undefined, { hdr: true } as any))!;
    expect(renderer).toBeTruthy();
    const quad = {
      name: "q",
      primitives: [
        {
          positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6 },
        },
      ],
    } as unknown as MeshAsset;
    const instances: MeshSceneInstance[] = [{ mesh: quad, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: null }];
    const draw = (width: number, height: number) =>
      ({
        width,
        height,
        view: viewMatrix([0, 0, 3], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 3, 16 / 9, 0.1, 50),
        lightDirection: [0.3, 0.6, 1],
        ambient: 0.3,
        antialias: true,
        temporal: true,
        reflections: true,
        prepass: true,
        tonemap: { exposure: 1 },
      }) as any;
    for (const [w, h] of [
      [64, 36],
      [96, 54],
      [96, 54],
      [48, 27],
    ] as const) {
      renderer.resize!(w, h);
      expect(renderer.size).toEqual({ width: w, height: h });
      device.pushErrorScope("validation");
      const texture = renderer.renderToTexture!(instances, draw(w, h)) as any;
      const error = await settled(device.popErrorScope());
      expect(error ? String((error as any).message ?? error) : null).toBeNull();
      expect([texture.width, texture.height]).toEqual([w, h]);
      const got = await read(texture, w, h, "rgba16float");
      // The quad fills the middle of the frame at every size, and the corners are empty.
      expect(got(w >> 1, h >> 1, 3)).toBeGreaterThan(0.99);
      expect(got(w >> 1, h >> 1, 0)).toBeGreaterThan(0.01);
      expect(got(0, 0, 3)).toBe(0);
    }
    renderer.dispose();
  });
});

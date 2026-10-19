/**
 * Captures of a GPU-presented frame (AAA_FIDELITY_ROADMAP.md F11a): the
 * canvas's texture is copied back as it was presented, its rows unpadded, BGRA
 * swizzled to RGBA and an extended (half-float) frame clipped at SDR white, so
 * a capture script can save what the display showed where a screenshot of a
 * WebGPU canvas comes out blank.
 */

import { describe, expect, it } from "vitest";

import { GpuCanvasSurface, framePixels } from "@cartbox/player";

/** A half float's bits (normal numbers and zero only). */
function toHalf(v: number): number {
  if (v === 0) return 0;
  const e = Math.floor(Math.log2(Math.abs(v)));
  const m = Math.round((Math.abs(v) / 2 ** e - 1) * 1024);
  return (v < 0 ? 0x8000 : 0) | ((e + 15) << 10) | m;
}

describe("a canvas texture's rows, as RGBA", () => {
  it("drops each row's padding and swizzles BGRA", () => {
    // 2x2 at a 12-byte row: 8 bytes of pixels, 4 of padding.
    const bytes = Uint8Array.from([10, 20, 30, 99, 40, 50, 60, 99, 7, 7, 7, 7, 1, 2, 3, 99, 4, 5, 6, 99, 7, 7, 7, 7]);
    expect(Array.from(framePixels(bytes, 2, 2, 12, "bgra8unorm"))).toEqual([30, 20, 10, 255, 60, 50, 40, 255, 3, 2, 1, 255, 6, 5, 4, 255]);
    expect(Array.from(framePixels(bytes, 2, 2, 12, "rgba8unorm")).slice(0, 4)).toEqual([10, 20, 30, 255]);
  });

  it("clips an extended frame at SDR white and keeps what is under it", () => {
    const halves = Uint16Array.from([toHalf(0.5), toHalf(2.5), 0, toHalf(1), toHalf(-0.25), toHalf(1), toHalf(0.25), toHalf(0.75)]);
    expect(Array.from(framePixels(new Uint8Array(halves.buffer), 2, 1, 16, "rgba16float"))).toEqual([128, 255, 0, 255, 0, 255, 64, 255]);
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

describe.skipIf(!device)("on a real device", { timeout: 60_000 }, () => {
  it("reads back the frame just presented, to every capture waiting on it", async () => {
    const W = 70; // a row of 280 bytes, padded to 512
    const H = 3;
    const texture = device.createTexture({ size: { width: W, height: H }, format: "bgra8unorm", usage: 0x10 | 0x01 | 0x02 });
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i += 1) data.set([i % 256, (i * 3) % 256, 200, 255], i * 4);
    device.queue.writeTexture({ texture }, data, { bytesPerRow: W * 4 }, { width: W, height: H });
    // The surface's readback, on a stand-in for its canvas (the DOM half of it isn't under test).
    const results: any[] = [];
    const surface = { device, format: "bgra8unorm", captures: [0, 1].map(() => ({ resolve: (f: unknown) => results.push(f) })) };
    (GpuCanvasSurface.prototype as any).readBack.call(surface, texture);
    expect(surface.captures).toEqual([]);
    for (let i = 0; i < 800 && results.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      device.tick?.();
    }
    expect(results).toHaveLength(2);
    const frame = results[0];
    expect([frame.width, frame.height]).toEqual([W, H]);
    let wrong = 0;
    for (let i = 0; i < W * H; i += 1) {
      const want = [200, (i * 3) % 256, i % 256, 255];
      for (let k = 0; k < 4; k += 1) if (frame.rgba[i * 4 + k] !== want[k]) wrong += 1;
    }
    expect(wrong).toBe(0);
    expect(results[1]).toBe(frame);
  });
});

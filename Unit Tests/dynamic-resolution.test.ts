/**
 * Dynamic resolution on the AAA tier (AAA_FIDELITY_ROADMAP.md F0d): the 3D's
 * share of the native frame follows the GPU's frame time, down at once to
 * where it fits, up slowly when there's room, in steps, never under half; and
 * the presenter filters a smaller scene up to the frame.
 */

import { describe, expect, it } from "vitest";

import { GpuPresenter, getModel } from "@cartbox/player";
import { DynamicResolution, MIN_RENDER_SCALE, quantizeScale, scaledSize } from "../packages/player/src/render/dynamicResolution";

const BUDGET = 1000 / 60;

/** Run `frames` frames of a GPU whose time goes with the pixel count: `fullMs` at the whole frame. */
function run(dyn: DynamicResolution, frames: number, fullMs: (frame: number) => number | null): number[] {
  const scales: number[] = [];
  for (let i = 0; i < frames; i += 1) {
    const full = fullMs(i);
    scales.push(dyn.update(full === null ? null : full * dyn.scale * dyn.scale));
  }
  return scales;
}

describe("the render scale", () => {
  it("moves in twentieths between a half and one", () => {
    expect(quantizeScale(0.93)).toBe(0.9);
    expect(quantizeScale(0.95)).toBeCloseTo(0.95, 10);
    expect(quantizeScale(0.2)).toBe(MIN_RENDER_SCALE);
    expect(quantizeScale(1.4)).toBe(1);
    expect(scaledSize(2560, 1440, 0.75)).toEqual({ width: 1920, height: 1080 });
    expect(getModel("aaa").renderCaps.dynamicResolution).toBe(true);
  });

  it("stays whole while the GPU keeps up", () => {
    const dyn = new DynamicResolution(BUDGET);
    expect(run(dyn, 300, () => 9).every((s) => s === 1)).toBe(true);
  });

  it("drops at once to where the frame fits, and holds there", () => {
    const dyn = new DynamicResolution(BUDGET);
    const scales = run(dyn, 400, () => 25);
    // 25 ms whole is 1.5 budgets: the pixels that fit 85% are √(0.85 / 1.5) ≈ 0.75 across.
    expect(scales[scales.length - 1]).toBeCloseTo(0.75, 10);
    const first = scales.findIndex((s) => s < 1);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(20);
    // It doesn't hunt: one change, then steady.
    expect(new Set(scales.slice(first)).size).toBe(1);
    // At 0.75 the GPU takes 14 ms: within budget.
    expect(25 * 0.75 * 0.75).toBeLessThan(BUDGET);
  });

  it("never goes under half, however slow", () => {
    const dyn = new DynamicResolution(BUDGET);
    const scales = run(dyn, 400, () => 200);
    expect(Math.min(...scales)).toBe(MIN_RENDER_SCALE);
  });

  it("climbs back a step at a time when there is room, and holds without a reading", () => {
    const dyn = new DynamicResolution(BUDGET);
    run(dyn, 200, () => 30);
    const low = dyn.scale;
    expect(low).toBeLessThan(0.75);
    // Lighter now: 6 ms whole. It climbs, one twentieth per two seconds or so.
    const scales = run(dyn, 2000, () => 6);
    expect(scales[scales.length - 1]).toBe(1);
    for (let i = 1; i < scales.length; i += 1) expect(scales[i]! - scales[i - 1]!).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(scales.findIndex((s) => s > low)).toBeGreaterThanOrEqual(100);
    // A browser that can't time the GPU: the scale stays put.
    run(dyn, 200, () => 30);
    const held = dyn.scale;
    expect(run(dyn, 300, () => null).every((s) => s === held)).toBe(true);
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

describe.skipIf(!device)("a smaller scene, on a real device", { timeout: 60_000 }, () => {
  it("is filtered up to the frame: flat where it is flat, blended across an edge", async () => {
    const W = 64;
    const H = 32;
    // The scene at half the frame across: red on the left half, blue on the right.
    const scene = device.createTexture({ size: { width: 32, height: 16 }, format: "rgba8unorm", usage: 0x04 | 0x02 });
    const data = new Uint8Array(32 * 16 * 4);
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 32; x += 1) data.set(x < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * 32 + x) * 4);
    device.queue.writeTexture({ texture: scene }, data, { bytesPerRow: 32 * 4 }, { width: 32, height: 16 });
    const presenter = new GpuPresenter(device, W, H);
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    device.pushErrorScope("validation");
    presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene }, out, "rgba8unorm");
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const buffer = device.createBuffer({ size: 256 * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: out }, { buffer, bytesPerRow: 256, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    const at = (x: number, y: number) => Array.from(bytes.slice(y * 256 + x * 4, y * 256 + x * 4 + 3));
    expect(at(8, 16)).toEqual([255, 0, 0]);
    expect(at(56, 16)).toEqual([0, 0, 255]);
    // Across the edge (frame columns 31 and 32 sit a quarter texel either side of it): a blend of the two.
    const [r, , b] = at(31, 16);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(255);
    expect(b).toBeGreaterThan(20);
    presenter.dispose();
  });
});

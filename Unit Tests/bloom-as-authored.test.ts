/**
 * The AAA tier's bloom as the maps were authored (AAA_FIDELITY_ROADMAP.md
 * F11a-4): the post stack's thresholded glow, added over the frame as shown,
 * where the physical bloom (F4d) moved light into a glow and so left lit
 * surfaces darker than the art was tuned for. Past white it gathers the light
 * an HDR display would show, so a bright light still blooms harder than one
 * that clipped alike; the base (a painted sky, a backdrop) blooms as painted.
 */

import { describe, expect, it } from "vitest";

import { GpuPresenter, defaultPostFxSettings, paramKey, uniformsFromSettings } from "@cartbox/player";
import { POST_UNIFORM_FLOATS, packPostUniforms } from "../packages/player/src/fx/gpuPostFx";
import { shownAs } from "../packages/player/src/render/toneMappers";

describe("the bloom's model", () => {
  it("is the authored one unless the post stack asks for the physical", () => {
    const settings = defaultPostFxSettings();
    settings.enabled.bloom = true;
    expect(uniformsFromSettings(settings).bloomPhysical).toBe(0);
    settings.values[paramKey("bloom", "physical")] = 1;
    expect(uniformsFromSettings(settings).bloomPhysical).toBe(1);
  });

  it("hands the post stack its lens dirt, none unless given", () => {
    const u = uniformsFromSettings(defaultPostFxSettings());
    expect(packPostUniforms(u, 64, 32, 0, true)[74]).toBe(0);
    expect(packPostUniforms(u, 64, 32, 0, true, new Float32Array(POST_UNIFORM_FLOATS), 1, 0.7)[74]).toBeCloseTo(0.7, 6);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    if (!adapter) return null;
    const timestamps = adapter.features?.has?.("timestamp-query") === true;
    return await adapter.requestDevice(timestamps ? { requiredFeatures: ["timestamp-query"] } : undefined);
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

async function until(done: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
}

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const bits = new Uint32Array(f.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const e = ((bits >>> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  return sign | (Math.min(30, e) << 10) | ((bits & 0x7fffff) >>> 13);
}

const W = 64;
const H = 32;

/** A half-float scene layer: colour and coverage per texel (nothing drawn is all zero). */
function sceneOf(at: (x: number, y: number) => [number, number, number, number]): any {
  const t = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x04 | 0x02 | 0x10 });
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set(at(x, y).map(toHalf), (y * W + x) * 4);
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
  return t;
}

/** The presented frame, as 0..1 per channel. */
async function show(presenter: GpuPresenter, frame: object): Promise<(x: number, y: number, k?: number) => number> {
  const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
  device.pushErrorScope("validation");
  presenter.present(frame as any, out, "rgba8unorm");
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const bytesPerRow = 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: out }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  out.destroy();
  return (x, y, k = 1) => bytes[y * bytesPerRow + x * 4 + k]! / 255;
}

const bloom = (extra: object = {}) => ({ uniforms: { ...uniformsFromSettings(defaultPostFxSettings()), bloomStrength: 0.8, bloomThreshold: 0.5, bloomRadius: 0.5, ...extra }, time: 0 });
const BLACK = { kind: "colour", rgba: [0, 0, 0, 255] };

describe.skipIf(!device)("the bloom as authored, on a real device", { timeout: 60_000 }, () => {
  // Through the curve physically, and as authored (F11a-5): either way the frame as shown is what blooms.
  it.each([false, true])("blooms as the byte path does where the frame shows under white (authored curve: %s)", async (authored) => {
    // A lit square and a coloured patch on a dark ground, all showing under 0.9 of white.
    const light = (x: number, y: number): [number, number, number] =>
      x >= 14 && x < 22 && y >= 10 && y < 20 ? [0.8, 0.8, 0.8] : x >= 40 && x < 50 && y >= 8 && y < 22 ? [0.9, 0.35, 0.1] : [0.02, 0.02, 0.02];
    const byte = new GpuPresenter(device, W, H);
    const linear = new GpuPresenter(device, W, H, { hdr: true });
    const shownAt = (x: number, y: number) => shownAs("filmic", light(x, y), 1, authored);
    const want = await show(byte, { base: BLACK, scene: sceneOf((x, y) => [...shownAt(x, y), 1]), post: bloom() });
    const got = await show(linear, { base: BLACK, scene: sceneOf((x, y) => [...light(x, y), 1]), tonemap: { exposure: 1, authored }, post: bloom() });
    let worst = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(got(x, y, k) - want(x, y, k)));
    expect(worst).toBeLessThanOrEqual(3 / 255);
    // …and it does bloom: the ground beside the square is lit by its glow, and the square brighter than it shows.
    expect(got(25, 15)).toBeGreaterThan(shownAt(0, 0)[1] + 10 / 255);
    expect(got(18, 15)).toBeGreaterThan(shownAt(18, 15)[1] + 5 / 255);
    // Where the physical bloom moved light into its glow, and the square showed darker than drawn.
    const physical = await show(linear, { base: BLACK, scene: sceneOf((x, y) => [...light(x, y), 1]), tonemap: { exposure: 1, authored }, post: bloom({ bloomPhysical: 1 }) });
    expect(physical(18, 15)).toBeLessThan(got(18, 15) - 5 / 255);
    byte.dispose();
    linear.dispose();
  });

  it("blooms a light past white harder than one that clipped alike", async () => {
    // A light of 60 at the left and one of 2 at the right: both all but white on the display.
    const scene = sceneOf((x, y) => (Math.abs(y - 16) < 2 && Math.abs(x - 16) < 2 ? [60, 60, 60, 1] : Math.abs(y - 16) < 2 && Math.abs(x - 48) < 2 ? [2, 2, 2, 1] : [0, 0, 0, 1]));
    const linear = new GpuPresenter(device, W, H, { hdr: true });
    const got = await show(linear, { base: BLACK, scene, tonemap: { exposure: 1 }, post: bloom() });
    // The lights themselves show as the curve shows them.
    expect(Math.abs(got(16, 16) - 1)).toBeLessThanOrEqual(1 / 255);
    for (const [dx, dy] of [
      [0, 4],
      [4, 0],
      [3, 3],
    ] as const) {
      const bright = got(16 + dx, 16 + dy);
      const dim = got(48 + dx, 16 + dy);
      expect(dim).toBeGreaterThan(5 / 255);
      expect(bright).toBeGreaterThan(dim * 1.15);
    }
    linear.dispose();
  });

  it("blooms the base as painted: only the scene gathers past white", async () => {
    // The same light twice, showing past 0.9 of white: as the backdrop, and drawn in the scene over black.
    const paint = 250;
    const v = (paint / 255 + 0.055) ** 2.4 / 1.055 ** 2.4;
    const linear = new GpuPresenter(device, W, H, { hdr: true });
    const backdrop = { base: { kind: "colour", rgba: [paint, paint, paint, 255] }, scene: sceneOf(() => [0, 0, 0, 0]), tonemap: { exposure: 1.7 } };
    const drawn = { base: BLACK, scene: sceneOf(() => [v, v, v, 1]), tonemap: { exposure: 1.7 } };
    // Unbloomed they show alike…
    const plain = await show(linear, backdrop);
    expect(plain(32, 16)).toBeGreaterThan(0.93);
    expect(Math.abs((await show(linear, drawn))(32, 16) - plain(32, 16))).toBeLessThanOrEqual(1 / 255);
    // …and bloomed, the backdrop glows by what it shows; the scene's light by what an HDR display would show past it.
    const post = bloom({ bloomStrength: 0.05, bloomThreshold: 0.9 });
    const painted = await show(linear, { ...backdrop, post });
    const lit = await show(linear, { ...drawn, post });
    expect(painted(32, 16)).toBeGreaterThan(plain(32, 16));
    expect(lit(32, 16)).toBeGreaterThan(painted(32, 16) + 3 / 255);
    linear.dispose();
  });

  it("runs as one pass and the post stack's bloom", async () => {
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const scene = sceneOf(() => [0.3, 0.3, 0.3, 1]);
    for (let i = 0; i < 3; i += 1) await show(presenter, { base: BLACK, scene, tonemap: { exposure: 1 }, post: bloom() });
    if (device.features.has("timestamp-query")) {
      await until(() => (presenter.stats.passes?.length ?? 0) > 0);
      expect(presenter.stats.passes!.map((p) => p.name)).toEqual(["compose and tone map", "post"]);
    }
    presenter.dispose();
  });
});

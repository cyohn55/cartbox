/**
 * The lens pass (AAA_FIDELITY_ROADMAP.md F4e-2): on the AAA tier's linear
 * frame, aberration, tilt-shift, the wet-floor reflection, god rays and
 * streaks run in light before the tone map. The display stack hands them
 * over (unless the screen is folded or curved), an image without highlights
 * comes out as it did, the same pixels gather, and a brighter light streaks
 * harder where on the clipped display image the two looked alike.
 */

import { describe, expect, it } from "vitest";

import { GpuPresenter, defaultPostFxSettings, uniformsFromSettings } from "@cartbox/player";
import { LENS_SHOWN_FLOATS, packLensShown, splitLens } from "../packages/player/src/render/lensFx";
import { toneMap } from "../packages/player/src/render/toneMappers";

const neutral = () => uniformsFromSettings(defaultPostFxSettings());

describe("the post stack split for a linear frame", () => {
  it("hands the lens effects to the lens pass and keeps the rest", () => {
    const u = { ...neutral(), aberration: 3, streakStrength: 0.5, godrayStrength: 0.4, tiltStrength: 0.2, reflectionStrength: 0.3, vignette: 0.5, scanlines: 0.2 };
    const { lens, display } = splitLens(u);
    expect(lens).toBe(true);
    expect([display.aberration, display.streakStrength, display.godrayStrength, display.tiltStrength, display.reflectionStrength]).toEqual([0, 0, 0, 0, 0]);
    expect([display.vignette, display.scanlines]).toEqual([0.5, 0.2]);
  });

  it("leaves everything in the display stack when the screen is curved or folded, or nothing is on", () => {
    const u = { ...neutral(), aberration: 3, streakStrength: 0.5 };
    for (const shaped of [{ ...u, curvature: 0.08 }, { ...u, kaleidoSegments: 6 }, neutral()]) {
      const { lens, display } = splitLens(shaped);
      expect(lens).toBe(false);
      expect(display).toBe(shaped);
    }
  });

  it("tells the bright pass how a pixel will show", () => {
    const shown = packLensShown(1.5, 2, true, { brightness: 1.2, contrast: 1.1, saturation: 0.9 }, 1.3, 3);
    expect(shown.length).toBe(LENS_SHOWN_FLOATS);
    [1.5, 2, 1, 1, 1.2, 1.1, 0.9, 0, 1.3, 3, 0, 0].forEach((v, i) => expect(shown[i]).toBeCloseTo(v, 6));
    expect(Array.from(packLensShown(1, 0, false, null, 1, 3))).toEqual([1, 0, 0, 0, 1, 1, 1, 0, 1, 3, 0, 0]);
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
const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

const W = 64;
const H = 32;

type Rgb = [number, number, number];

function sceneOf(at: (x: number, y: number) => Rgb): any {
  const t = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x04 | 0x02 | 0x10 });
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set([...at(x, y), 1].map(toHalf), (y * W + x) * 4);
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
  return t;
}

/** The presenter's output (rgba8unorm) of `scene` through `uniforms`, read back as 0..1. */
async function show(scene: any, uniforms: any, presenter = new GpuPresenter(device, W, H, { hdr: true })): Promise<(x: number, y: number, k: number) => number> {
  const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
  device.pushErrorScope("validation");
  presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene, tonemap: { exposure: 1, operator: "filmic" }, post: { uniforms, time: 0 } }, out, "rgba8unorm");
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
  return (x, y, k) => bytes[y * bytesPerRow + x * 4 + k]! / 255;
}

describe.skipIf(!device)("the lens pass, on a real device", { timeout: 60_000 }, () => {
  it("shows an image without highlights as it did: the aberration samples light where it sampled the display", async () => {
    // A colour ramp well under white: filmic is per channel, so splitting the channels commutes with the curve.
    const at = (x: number, y: number): Rgb => [0.02 + x * 0.006, 0.05 + y * 0.01, 0.3 - x * 0.003];
    const scene = sceneOf(at);
    const amount = 5;
    const got = await show(scene, { ...neutral(), aberration: amount });
    let worst = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const u = (x + 0.5) / W;
        const v = (y + 0.5) / H;
        const fx = ((u - 0.5) * amount) / W;
        const fy = ((v - 0.5) * amount) / H;
        const texel = (su: number, sv: number) => at(Math.min(W - 1, Math.max(0, Math.floor(su * W))), Math.min(H - 1, Math.max(0, Math.floor(sv * H))));
        const want = [texel(u + fx, v + fy)[0], at(x, y)[1], texel(u - fx, v - fy)[2]].map((c) => srgb(toneMap("filmic", [c, c, c])[0]));
        for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(got(x, y, k) - want[k]!) * 255);
      }
    }
    expect(worst).toBeLessThanOrEqual(2);
  });

  it("streaks a light of 40 harder than one of 2, where on the clipped display image they streaked alike, and one under white as before", async () => {
    const light = (y: number) => (y === 6 ? 40 : y === 16 ? 2 : y === 26 ? 0.6 : 0);
    const scene = sceneOf((x, y) => (x >= 20 && x < 22 ? [light(y), light(y), light(y)] : [0, 0, 0]));
    const streaks = { ...neutral(), streakStrength: 0.6, streakLength: 1, bloomThreshold: 0.5 };
    const lens = await show(scene, streaks);
    // A hair of curvature keeps the streaks in the display stack: the old way, for comparison.
    const display = await show(scene, { ...streaks, curvature: 0.0001 });
    const along = (got: typeof lens, y: number) => got(26, y, 1);
    // On the display image both had clipped to white: they streaked alike.
    expect(along(display, 6)).toBeGreaterThan(0);
    expect(Math.abs(along(display, 6) - along(display, 16))).toBeLessThan(0.05);
    // In light, each gathers as bright as an HDR display shows it: the brighter one harder, both past what they clipped to.
    expect(along(lens, 6)).toBeGreaterThan(along(lens, 16));
    expect(along(lens, 6)).toBeGreaterThan(along(display, 6) * 1.3);
    expect(along(lens, 16)).toBeGreaterThan(along(display, 16) * 1.2);
    // A light under white streaks as it did.
    expect(Math.abs(along(lens, 26) - along(display, 26))).toBeLessThanOrEqual(1 / 255);
  });

  it("gathers the same pixels: a light that shows under the threshold streaks not at all", async () => {
    // filmic(0.25) shows at about 0.5, under a threshold of 0.8.
    const scene = sceneOf((x, y) => (x >= 20 && x < 22 && y === 8 ? [0.25, 0.25, 0.25] : [0, 0, 0]));
    const got = await show(scene, { ...neutral(), streakStrength: 0.8, streakLength: 1, bloomThreshold: 0.8 });
    for (let x = 0; x < W; x += 1) if (x < 20 || x >= 22) expect(got(x, 8, 1)).toBe(0);
  });

  it("keeps a defocused highlight bright: the tilt-shift blurs its light, not its clipped value", async () => {
    // A light of 40 near the top, far out of the band in focus (the middle).
    const scene = sceneOf((x, y) => (x >= 31 && x < 33 && y >= 3 && y < 5 ? [40, 40, 40] : [0.02, 0.02, 0.02]));
    const tilt = { ...neutral(), tiltStrength: 1, tiltFocus: 0.5, tiltRange: 0.05 };
    const lens = await show(scene, tilt);
    const display = await show(scene, { ...tilt, curvature: 0.0001 });
    // Three texels off the light, inside its blur: on the display image it spread a clipped 1, in light it spreads 40.
    expect(display(35, 4, 1)).toBeLessThan(0.5);
    expect(lens(35, 4, 1)).toBeGreaterThan(display(35, 4, 1) + 0.25);
    // Inside the band in focus nothing blurs, either way.
    expect(Math.abs(lens(10, 16, 1) - display(10, 16, 1))).toBeLessThanOrEqual(1 / 255);
  });

  it("runs in the frame graph between the composite and the tone map", async () => {
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const scene = sceneOf(() => [0.1, 0.1, 0.1]);
    const uniforms = { ...neutral(), aberration: 2, bloomStrength: 0.4, bloomRadius: 0.5, bloomPhysical: 1, vignette: 0.3 };
    for (let i = 0; i < 3; i += 1) await show(scene, uniforms, presenter);
    if (device.features.has("timestamp-query")) {
      await until(() => (presenter.stats.passes?.length ?? 0) > 0);
      expect(presenter.stats.passes!.map((p) => p.name)).toEqual(["linear composite", "bloom", "lens", "tone map", "post"]);
    }
    presenter.dispose();
  });
});

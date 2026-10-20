/**
 * The AAA tier's grade and display output (AAA_FIDELITY_ROADMAP.md F4d): the
 * grade in ACEScct before the tone map (contrast scales stops about 18% grey),
 * HDR output that keeps grey where SDR shows it and lets highlights past
 * white, and on a real device (Dawn) the presenter doing both as the
 * TypeScript does, and lighting lens dirt with its bloom.
 */

import { describe, expect, it } from "vitest";

import { GpuPresenter, defaultPostFxSettings, uniformsFromSettings } from "@cartbox/player";
import { CCT_GREY, HDR_HEADROOM, extendedExposure, fromAcesCct, gradeLinear, toAcesCct, toneMapExtended } from "../packages/player/src/render/grading";
import { TONE_MAPPERS, toneMap } from "../packages/player/src/render/toneMappers";

describe("the grade in log space", () => {
  it("encodes to ACEScct and back", () => {
    for (const x of [0, 0.001, 0.0078125, 0.05, 0.18, 1, 16]) expect(fromAcesCct(toAcesCct(x))).toBeCloseTo(x, 6);
    expect(CCT_GREY).toBeCloseTo(0.4135, 3);
  });

  it("is neutral at 1, 1, 1", () => {
    const c: [number, number, number] = [0.3, 0.12, 2.5];
    gradeLinear(c, 1, 1, 1).forEach((v, k) => expect(v).toBeCloseTo(c[k]!, 6));
  });

  it("scales stops about 18% grey: contrast 1.5 makes two stops over grey three", () => {
    const grey = gradeLinear([0.18, 0.18, 0.18], 1, 1.5, 1);
    expect(grey[0]).toBeCloseTo(0.18, 5);
    expect(gradeLinear([0.72, 0.72, 0.72], 1, 1.5, 1)[0]).toBeCloseTo(0.18 * 2 ** 3, 4);
    expect(gradeLinear([0.045, 0.045, 0.045], 1, 1.5, 1)[0]).toBeCloseTo(0.18 * 2 ** -3, 4);
  });

  it("brightens as exposure and desaturates about the luma", () => {
    expect(gradeLinear([0.5, 0.5, 0.5], 2, 1, 1)[0]).toBeCloseTo(1, 5);
    const [r, g, b] = gradeLinear([1, 0.2, 0.1], 1, 1, 0);
    expect(r).toBeCloseTo(g, 6);
    expect(g).toBeCloseTo(b, 6);
    expect(r).toBeCloseTo(0.2126 + 0.7152 * 0.2 + 0.0722 * 0.1, 5);
  });
});

describe("HDR display output", () => {
  it("keeps 18% grey where SDR shows it, through every curve", () => {
    for (const mapper of TONE_MAPPERS) {
      const sdr = toneMap(mapper, [0.18, 0.18, 0.18])[1];
      expect(toneMapExtended(mapper, [0.18, 0.18, 0.18])[1]).toBeCloseTo(sdr, 4);
      expect(extendedExposure(mapper)).toBeGreaterThan(0.5);
    }
  });

  it("lets a highlight past SDR white, up to the headroom", () => {
    for (const mapper of TONE_MAPPERS) {
      const sdr = toneMap(mapper, [40, 40, 40])[1];
      const hdr = toneMapExtended(mapper, [40, 40, 40])[1];
      expect(sdr).toBeLessThanOrEqual(1);
      expect(hdr).toBeGreaterThan(1.5);
      expect(hdr).toBeLessThanOrEqual(HDR_HEADROOM);
    }
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

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const bits = new Uint32Array(f.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const e = ((bits >>> 23) & 0xff) - 112;
  if (e <= 0) return sign;
  return sign | (Math.min(30, e) << 10) | ((bits & 0x7fffff) >>> 13);
}
function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}
const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

const W = 64;
const H = 32;

function sceneOf(at: (x: number, y: number) => [number, number, number]): any {
  const t = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x04 | 0x02 | 0x10 });
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set([...at(x, y), 1].map(toHalf), (y * W + x) * 4);
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
  return t;
}

/** A target read back as floats: bytes / 255 for rgba8unorm, halves for rgba16float. */
async function read(texture: any, format: "rgba8unorm" | "rgba16float"): Promise<(x: number, y: number, k: number) => number> {
  const bytesPerRow = 512;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const copy = buffer.getMappedRange().slice(0);
  buffer.unmap();
  if (format === "rgba8unorm") {
    const bytes = new Uint8Array(copy);
    return (x, y, k) => bytes[y * bytesPerRow + x * 4 + k]! / 255;
  }
  const halves = new Uint16Array(copy);
  return (x, y, k) => half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!);
}

describe.skipIf(!device)("the presenter, on a real device", { timeout: 60_000 }, () => {
  const ramp = (x: number, y: number): [number, number, number] => {
    const v = 0.01 * 1.15 ** x;
    return y < 16 ? [v, v, v] : [v, v * 0.5, v * 0.2];
  };

  async function show(options: { extended?: boolean; post?: any; format?: "rgba8unorm" | "rgba16float"; scene?: any }) {
    const format = options.format ?? "rgba8unorm";
    const presenter = new GpuPresenter(device, W, H, { hdr: true, extended: options.extended });
    const out = device.createTexture({ size: { width: W, height: H }, format, usage: 0x10 | 0x01 });
    device.pushErrorScope("validation");
    presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene: options.scene ?? sceneOf(ramp), tonemap: { exposure: 1, operator: "neutral" }, post: options.post ?? null }, out, format);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const got = await read(out, format);
    presenter.dispose();
    return got;
  }

  it("grades the linear frame in ACEScct before its curve, and the post stack's grade stands down", async () => {
    const uniforms = { ...uniformsFromSettings(defaultPostFxSettings()), contrast: 1.3, saturation: 0.7 };
    const got = await show({ post: { uniforms, time: 0 } });
    let worst = 0;
    for (let y = 0; y < H; y += 5) {
      for (let x = 0; x < W; x += 4) {
        const want = toneMap("neutral", gradeLinear(ramp(x, y), 1, 1.3, 0.7)).map(srgb);
        for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(got(x, y, k) - want[k]!) * 255);
      }
    }
    expect(worst).toBeLessThanOrEqual(2.5);
  });

  it("shows past SDR white on an HDR display, grey where SDR shows it", async () => {
    // The ramp, with 18% grey down its first columns.
    const scene = sceneOf((x, y) => (x < 4 ? [0.18, 0.18, 0.18] : ramp(x, y)));
    const sdr = await show({ scene });
    const hdr = await show({ scene, extended: true, format: "rgba16float" });
    // The ramp's last columns are far over white: past 1 (sRGB-encoded) on the HDR display.
    expect(sdr(W - 1, 4, 1)).toBeLessThanOrEqual(1);
    expect(hdr(W - 1, 4, 1)).toBeGreaterThan(1.1);
    // Grey shows the same on both.
    expect(Math.abs(hdr(1, 4, 1) - sdr(1, 4, 1))).toBeLessThan(2.5 / 255);
  });

  // Both blooms: the physical one (F4d) in the presenter's finish, the authored one (F11a-4) in the post stack.
  it.each([1, 0])("lights lens dirt with the bloom (physical: %i)", async (bloomPhysical) => {
    const scene = sceneOf((x, y) => (Math.abs(x - 32) < 3 && Math.abs(y - 16) < 3 ? [80, 80, 80] : [0, 0, 0]));
    const base = { ...uniformsFromSettings(defaultPostFxSettings()), bloomStrength: 0.9, bloomRadius: 1, bloomPhysical };
    const clean = await show({ scene, post: { uniforms: base, time: 0 } });
    const dirty = await show({ scene, post: { uniforms: { ...base, bloomDirt: 1 }, time: 0 } });
    let brighter = 0;
    let darker = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const d = dirty(x, y, 1) - clean(x, y, 1);
        if (d > 1.5 / 255) brighter += 1;
        if (d < -1.5 / 255) darker += 1;
      }
    }
    // The dirt only adds to the glow.
    expect(brighter).toBeGreaterThan(20);
    expect(darker).toBe(0);
  });
});

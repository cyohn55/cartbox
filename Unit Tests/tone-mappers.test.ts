/**
 * Tone mapping and bloom on the AAA tier (AAA_FIDELITY_ROADMAP.md F4d): the
 * curves' shapes (filmic as every tier has it, ACES's fitted RRT and ODT,
 * AgX, Khronos PBR Neutral), the scene's choice reaching the tone map, and on
 * a real device (Dawn) the presenter mapping through each exactly as the
 * TypeScript does, and blooming from the HDR frame with its energy kept.
 */

import { describe, expect, it } from "vitest";

import { acesFilmic, defaultSceneLighting, parseSceneLighting, sceneLightingTonemap } from "@cartbox/editor";
import { GpuPresenter, defaultPostFxSettings, uniformsFromSettings } from "@cartbox/player";
import { TONE_MAPPERS, toneMap, toneMapperIndex } from "../packages/player/src/render/toneMappers";
import { HdrBloom, bloomLevels } from "../packages/player/src/render/hdrBloom";

describe("the tone-mapping curves", () => {
  it("keep filmic as every tier's curve, term for term", () => {
    for (const v of [0, 0.05, 0.18, 0.5, 1, 4, 40]) expect(toneMap("filmic", [v, v, v])[0]).toBeCloseTo(acesFilmic(v), 6);
  });

  it("map any light into 0..1, rising with it", () => {
    for (const mapper of TONE_MAPPERS) {
      let last = -1;
      for (const v of [0, 0.01, 0.05, 0.18, 0.5, 1, 2, 8, 64, 1000]) {
        const [r, g, b] = toneMap(mapper, [v, v, v]);
        for (const c of [r, g, b]) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
        expect(g).toBeGreaterThanOrEqual(last - 1e-6);
        last = g;
      }
      expect(last).toBeGreaterThan(0.9); // a very bright light reads near white
    }
  });

  it("Neutral shows a base colour as authored and rolls off only highlights", () => {
    // Under its knee only the small black offset (0.04) comes off.
    const [r, g, b] = toneMap("neutral", [0.5, 0.3, 0.2]);
    expect(r).toBeCloseTo(0.46, 3);
    expect(g).toBeCloseTo(0.26, 3);
    expect(b).toBeCloseTo(0.16, 3);
    expect(toneMap("neutral", [4, 4, 4])[0]).toBeLessThan(1);
  });

  it("AgX and ACES take a saturated light toward white; filmic keeps it red", () => {
    const red: [number, number, number] = [40, 0.02, 0.02];
    expect(toneMap("filmic", red)[1]).toBeLessThan(0.05);
    expect(toneMap("agx", red)[1]).toBeGreaterThan(0.2);
    expect(toneMap("aces", red)[1]).toBeGreaterThan(toneMap("filmic", red)[1] * 2);
  });

  it("is the scene's choice: stored, read back, and carried to the tone map", () => {
    const lighting = { ...defaultSceneLighting(), tonemap: true, tonemapper: "agx" as const };
    const again = parseSceneLighting(JSON.parse(JSON.stringify(lighting)))!;
    expect(again.tonemapper).toBe("agx");
    expect(sceneLightingTonemap(again)?.operator).toBe("agx");
    expect(parseSceneLighting({ ...JSON.parse(JSON.stringify(lighting)), tonemapper: "lol" })!.tonemapper).toBeUndefined();
    expect(sceneLightingTonemap({ ...lighting, tonemapper: undefined })?.operator).toBeUndefined();
    expect(toneMapperIndex(undefined)).toBe(0);
    expect(toneMapperIndex("neutral")).toBe(3);
  });

  it("blooms over three to six levels by the radius, none under four texels", () => {
    expect(bloomLevels(256, 128, 0).length).toBe(3);
    expect(bloomLevels(256, 128, 1).length).toBe(5); // 128×64 … 8×4
    expect(bloomLevels(4, 4, 1).length).toBe(0);
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
const srgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));

const W = 64;
const H = 32;

/** A linear rgba16float scene (premultiplied, opaque) of `at(x, y)`. */
function sceneOf(at: (x: number, y: number) => [number, number, number]): any {
  const t = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x04 | 0x02 | 0x10 });
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set([...at(x, y), 1].map(toHalf), (y * W + x) * 4);
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: W * 8, rowsPerImage: H }, { width: W, height: H });
  return t;
}

async function readBytes(texture: any): Promise<Uint8Array> {
  const bytesPerRow = 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const padded = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + W * 4), y * W * 4);
  return out;
}

describe.skipIf(!device)("the presenter, on a real device", { timeout: 60_000 }, () => {
  // A ramp of colours: brightness across, hue down.
  const ramp = (x: number, y: number): [number, number, number] => {
    const v = 0.02 * 1.12 ** x;
    return y < 10 ? [v, v, v] : y < 20 ? [v, v * 0.4, v * 0.1] : [v * 0.2, v * 0.6, v];
  };

  it("maps a linear frame through the scene's curve, as the TypeScript does", async () => {
    const scene = sceneOf(ramp);
    for (const mapper of TONE_MAPPERS) {
      const presenter = new GpuPresenter(device, W, H, { hdr: true });
      const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
      device.pushErrorScope("validation");
      presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene, tonemap: { exposure: 1.5, operator: mapper } }, out, "rgba8unorm");
      const error = await settled(device.popErrorScope());
      expect(error ? String((error as any).message ?? error) : null).toBeNull();
      const bytes = await readBytes(out);
      let worst = 0;
      for (let y = 0; y < H; y += 3) {
        for (let x = 0; x < W; x += 3) {
          const want = toneMap(mapper, ramp(x, y).map((v) => v * 1.5) as [number, number, number]).map(srgb);
          for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(bytes[(y * W + x) * 4 + k]! - want[k]!));
        }
      }
      // Half-float input and float32 maths: a step or two of 255.
      expect(worst).toBeLessThanOrEqual(2);
      presenter.dispose();
      out.destroy();
    }
  });

  it("blooms from the HDR frame: a bright light glows round it; a dim one barely", async () => {
    // A light of 60 at the left, one of 1.2 at the right, on black.
    const scene = sceneOf((x, y) => (Math.abs(y - 16) < 2 && Math.abs(x - 16) < 2 ? [60, 60, 60] : Math.abs(y - 16) < 2 && Math.abs(x - 48) < 2 ? [1.2, 1.2, 1.2] : [0, 0, 0]));
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    const uniforms = { ...uniformsFromSettings(defaultPostFxSettings()), bloomStrength: 0.6, bloomRadius: 0.5 };
    device.pushErrorScope("validation");
    presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene, tonemap: { exposure: 1 }, post: { uniforms, time: 0 } }, out, "rgba8unorm");
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytes = await readBytes(out);
    const at = (x: number, y: number) => bytes[(y * W + x) * 4]!;
    // Eight texels from each: the bright one's glow shows, the dim one's hardly does.
    expect(at(16, 24)).toBeGreaterThan(20);
    expect(at(48, 24)).toBeLessThan(at(16, 24) / 3);
    presenter.dispose();
    out.destroy();
  });

  it("keeps the frame's energy: the chain, over its levels, holds the frame's mean light", async () => {
    const scene = sceneOf((x, y) => [((x * 7 + y * 13) % 17) / 4, 0.5, x === 20 && y === 10 ? 50 : 0.1]);
    const bloom = new HdrBloom(device);
    const encoder = device.createCommandEncoder();
    const glow = bloom.encode(encoder, scene, W, H, 0.5)!;
    device.queue.submit([encoder.finish()]);
    const size = bloomLevels(W, H, 0.5)[0]!;
    const bytesPerRow = 256;
    const buffer = device.createBuffer({ size: bytesPerRow * size.height, usage: 0x01 | 0x08 });
    const copy = device.createCommandEncoder();
    copy.copyTextureToBuffer({ texture: glow.texture }, { buffer, bytesPerRow, rowsPerImage: size.height }, { width: size.width, height: size.height });
    device.queue.submit([copy.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    let sum = 0;
    for (let y = 0; y < size.height; y += 1) for (let x = 0; x < size.width; x += 1) sum += half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!);
    // The green channel is 0.5 everywhere: the glow's mean over its levels is 0.5 too.
    expect(sum / (size.width * size.height) / glow.count).toBeCloseTo(0.5, 2);
    bloom.dispose();
  });
});

/**
 * Water on the AAA tier (AAA_FIDELITY_ROADMAP.md F5d), the CPU reference:
 * light through the water, foam, Gerstner waves, the FFT ocean, the ripples
 * a cart makes, and caustics.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { packWaterFrame, toHalf, WATER_FRAME_FLOATS, type WaterFrame } from "../packages/player/src/render/waterLook";

import {
  Ocean,
  RIPPLE_CELL,
  RippleField,
  WATER_DEFAULTS,
  caustics,
  fft,
  gerstnerHeight,
  gerstnerSlope,
  parseWaterLook,
  phillips,
  resolveWaterLook,
  sampleSlopes,
  shoreFoam,
  throughWater,
  waterInscatter,
  waterTransmittance,
} from "../packages/editor/src/model/water";

describe("a water material's look", () => {
  it("parses in range and resolves to clear river water", () => {
    expect(parseWaterLook(null)).toBeNull();
    expect(parseWaterLook({})).toBeNull();
    expect(parseWaterLook({ foam: 3, absorption: [1, -1, 2], waves: "x" })).toEqual({ foam: 1, absorption: [1, 0, 2] });
    expect(resolveWaterLook(null).absorption).toEqual(WATER_DEFAULTS.absorption);
  });
});

describe("light through water", () => {
  const look = resolveWaterLook(null);
  it("loses red first, and gathers the water's colour the deeper it goes", () => {
    const t = waterTransmittance(3, look.absorption, look.scattering);
    expect(t[0]).toBeLessThan(t[1]);
    expect(t[0]).toBeLessThan(0.3);
    expect(waterTransmittance(0, look.absorption, look.scattering)).toEqual([1, 1, 1]);
    // Deep enough, the in-scattered light is the scattering's share of the extinction.
    const deep = waterInscatter(500, look.absorption, look.scattering, [1, 1, 1]);
    [0, 1, 2].forEach((c) => expect(deep[c]).toBeCloseTo(look.scattering[c]! / (look.absorption[c]! + look.scattering[c]!), 6));
    const shallow = throughWater([0.8, 0.7, 0.6], 0.2, look, [1, 1, 1]);
    const deeper = throughWater([0.8, 0.7, 0.6], 4, look, [1, 1, 1]);
    expect(deeper[0]).toBeLessThan(shallow[0]);
    expect(deeper[1] / deeper[0]).toBeGreaterThan(shallow[1] / shallow[0]);
  });

  it("foams at the waterline and not half a metre down, nor without foam", () => {
    let at = 0;
    let deep = 0;
    for (let i = 0; i < 200; i += 1) {
      at += shoreFoam(0.02, i * 0.13, i * 0.07, 1, 1);
      deep += shoreFoam(0.7, i * 0.13, i * 0.07, 1, 1);
    }
    expect(at / 200).toBeGreaterThan(0.3);
    expect(deep).toBe(0);
    expect(shoreFoam(0.02, 1, 1, 1, 0)).toBe(0);
  });
});

describe("waves", () => {
  it("Gerstner: the slope is the height's gradient, still with no height", () => {
    expect(gerstnerSlope(1, 2, 3, 0, 0)).toEqual([0, 0]);
    const e = 1e-4;
    for (const [x, z, t] of [[0.3, 1.1, 0.5], [4.2, -2, 7]]) {
      const [sx, sz] = gerstnerSlope(x!, z!, t!, 0.6, 0.4);
      expect(sx).toBeCloseTo((gerstnerHeight(x! + e, z!, t!, 0.6, 0.4) - gerstnerHeight(x! - e, z!, t!, 0.6, 0.4)) / (2 * e), 5);
      expect(sz).toBeCloseTo((gerstnerHeight(x!, z! + e, t!, 0.6, 0.4) - gerstnerHeight(x!, z! - e, t!, 0.6, 0.4)) / (2 * e), 5);
    }
  });

  it("the FFT round-trips, and the Phillips spectrum follows the wind", () => {
    const re = Float64Array.from([1, 2, 3, 4, 0, -1, 0.5, 2]);
    const im = new Float64Array(8);
    const copy = [...re];
    fft(re, im, false);
    fft(re, im, true);
    copy.forEach((v, i) => expect(re[i]! / 8).toBeCloseTo(v, 9));
    expect(phillips(0.5, 0, [10, 0])).toBeGreaterThan(phillips(0, 0.5, [10, 0]) * 100);
    expect(phillips(0, 0, [10, 0])).toBe(0);
  });

  it("the ocean's slopes tile, move with time and grow with the wind", () => {
    const calm = new Ocean([4, 0]);
    const storm = new Ocean([14, 0]);
    const rms = (o: Ocean, t: number) => {
      const s = o.slopes(t);
      let sum = 0;
      for (let i = 0; i < s.length; i += 1) sum += s[i]! * s[i]!;
      return Math.sqrt(sum / s.length);
    };
    expect(rms(calm, 0)).toBeGreaterThan(0);
    expect(rms(storm, 0)).toBeGreaterThan(rms(calm, 0));
    const a = calm.slopes(0);
    const b = calm.slopes(1);
    expect(Math.abs(a[100]! - b[100]!)).toBeGreaterThan(0);
    expect(sampleSlopes(a, 3, 5)[0]).toBeCloseTo(sampleSlopes(a, 3 + 40, 5 - 80)[0], 6);
    // The slopes are real: a mean of nothing (no tilt over the whole patch).
    let mean = 0;
    for (let i = 0; i < a.length; i += 2) mean += a[i]!;
    expect(Math.abs(mean / (a.length / 2))).toBeLessThan(0.05 * rms(calm, 0));
  });
});

describe("ripples a cart makes", () => {
  it("spread from where the water is struck, then die away", () => {
    const f = new RippleField();
    f.follow(0, 0);
    f.impulse(0, 0, 0.1);
    f.step(0.5);
    // Half a second at 1.2 m/s: the ring is some 60 cm out, and the middle has settled back.
    const ring = Math.hypot(...f.slope(0.6, 0));
    expect(ring).toBeGreaterThan(Math.hypot(...f.slope(3, 0)));
    expect(f.active).toBe(true);
    f.step(20);
    expect(f.active).toBe(false);
  });

  it("follow the eye without the ripples swimming", () => {
    const f = new RippleField();
    f.follow(0, 0);
    f.impulse(1, 1, 0.1);
    const before = f.slope(1.3, 1);
    f.follow(2 * RIPPLE_CELL * 3, 0);
    const after = f.slope(1.3, 1);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });
});

describe("caustics", () => {
  it("average out to the sun's light, bright web just under the surface, evening out with depth", () => {
    const stats = (depth: number) => {
      let sum = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 2500; i += 1) {
        const v = caustics((i % 50) * 0.11, Math.floor(i / 50) * 0.13, 2, depth);
        sum += v;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return { mean: sum / 2500, spread: hi - lo };
    };
    const shallow = stats(0.3);
    const deep = stats(8);
    expect(shallow.mean).toBeGreaterThan(0.8);
    expect(shallow.mean).toBeLessThan(1.2);
    expect(shallow.spread).toBeGreaterThan(1);
    expect(deep.spread).toBeLessThan(shallow.spread * 0.2);
    expect(caustics(1, 1, 1, 0)).toBe(1);
  });
});

// --- On a real device -----------------------------------------------------------


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

describe("the water's frame terms", () => {
  it("pack its plane, look and grids, the grids as half floats", () => {
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(half(toHalf(0.1234))).toBeCloseTo(0.1234, 3);
    expect([...packWaterFrame(null)].every((v) => v === 0)).toBe(true);
    const ocean = new Float32Array(64 * 64 * 2).fill(0.25);
    const frame: WaterFrame = { plane: 2, bounds: [0, 0, 4, 4], absorption: [1, 0.2, 0.1], scattering: [0.01, 0.02, 0.03], light: [1, 1, 1], underwater: true, ocean, ripples: null, time: 3 };
    const packed = packWaterFrame(frame);
    expect(packed.length).toBe(WATER_FRAME_FLOATS);
    expect([...packed.slice(0, 4)]).toEqual([2, 1, 3, 1]);
    const words = new Uint32Array(packed.buffer);
    expect(half(words[24]! & 0xffff)).toBeCloseTo(0.25, 6);
    expect(half(words[24]! >>> 16)).toBeCloseTo(0.25, 6);
  });
});

const W = 48;
const H = 48;
const quad = (name: string, material: object): MeshAsset =>
  ({
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name, baseColorImage: null, metallicFactor: 0, ...material },
      },
    ],
  }) as unknown as MeshAsset;

/** The mean linear-light red and green over the frame's middle, looking down through a water surface 2 m over a pale bed. */
async function throughSurface(water: WaterFrame | null): Promise<[number, number]> {
  const bed: MeshSceneInstance = { mesh: quad("bed", { baseColorFactor: [0.8, 0.75, 0.6, 1], roughnessFactor: 0.9 }), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [10, 1, 10]) };
  const surface: MeshSceneInstance = {
    mesh: quad("water", { baseColorFactor: [0.2, 0.3, 0.35, 0.15], roughnessFactor: 0.05, alphaMode: "blend", refraction: 0.3, water: { strength: 0.2, scale: 1, speed: 0.5, flow: 0, foam: 0 } }),
    model: composeModelMatrix([0, 2, 0], [0, 0, 0], [10, 1, 10]),
  };
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!([bed, surface], {
    width: W,
    height: H,
    view: viewMatrix([0, 6, 0.01], [0, 0, 0]),
    projection: projectionMatrix(Math.PI / 4, 1, 0.1, 50),
    ambient: 0.4,
    lightDirection: [0.3, 0.9, 0.2],
    lights: [{ kind: "directional", direction: [0.3, 0.9, 0.2], color: [1, 1, 1], intensity: 1 }],
    prepass: true,
    water,
    time: 1,
  } as any);
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  renderer.dispose();
  let r = 0;
  let g = 0;
  let n = 0;
  for (let y = H / 4; y < (3 * H) / 4; y += 1) {
    for (let x = W / 4; x < (3 * W) / 4; x += 1) {
      r += half(halves[(y * bytesPerRow) / 2 + x * 4]!);
      g += half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!);
      n += 1;
    }
  }
  return [r / n, g / n];
}

describe.skipIf(!device)("water on a real device", { timeout: 120_000 }, () => {
  it("absorbs the bed's red through two metres of water, and leaves it be without a water body", async () => {
    const plain = await throughSurface(null);
    const body: WaterFrame = { plane: 2, bounds: [-10, -10, 10, 10], absorption: [0.6, 0.08, 0.05], scattering: [0.005, 0.015, 0.015], light: [1.2, 1.2, 1.2], underwater: false, ocean: null, ripples: null, time: 1 };
    const deep = await throughSurface(body);
    expect(plain[0]).toBeGreaterThan(0.02);
    // Two metres at 0.6 a metre keep about 30% of the red; green keeps most of its.
    expect(deep[0]).toBeLessThan(plain[0] * 0.7);
    expect(deep[1] / deep[0]).toBeGreaterThan((plain[1] / plain[0]) * 1.2);
  });
});

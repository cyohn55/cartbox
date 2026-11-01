/**
 * Weather (AAA_FIDELITY_ROADMAP.md F5e): wet, puddled and snowy surfaces under
 * one weather state, sheltered where the sky can't reach, and the rain and
 * snow that fall; the CPU reference, the shader's terms, and a floor drawn
 * under each on a real device.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import {
  PRECIPITATION_BOX,
  SNOW_ALBEDO,
  WATER_F0,
  parseWeather,
  patchNoise,
  precipitationOrigin,
  puddleDepth,
  rainRipples,
  resolveWeather,
  snowCover,
  weatherActive,
  weatherEmitters,
  weatherSurface,
  wetSurface,
} from "../packages/editor/src/model/weather";
import { compileEmitter } from "../packages/editor/src/model/particleGraph";
import { packWeatherFrame, WEATHER_WGSL } from "../packages/player/src/render/weather";
import { sceneShader } from "../packages/player/src/render/WebgpuSceneRenderer";

describe("weather settings", () => {
  it("parse in range, resolve to dry and clear, and say when they change nothing", () => {
    expect(parseWeather(null)).toBeNull();
    expect(parseWeather({ wetness: 2, snow: -1, rain: "x", scale: 0 })).toEqual({ wetness: 1, snow: 0, scale: 0.25 });
    const dry = resolveWeather(null);
    expect(weatherActive(dry)).toBe(false);
    expect(weatherActive(resolveWeather({ rain: 0.1 }))).toBe(true);
    expect([...packWeatherFrame(dry, 5)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const terms = packWeatherFrame(resolveWeather({ wetness: 0.5, puddles: 0.4, snow: 0.2, rain: 0.7, snowLine: 3, scale: 6 }), 1234.5);
    expect([...terms]).toEqual([0.5, 0.4, 0.2, 0.7, 3, 1234.5 % 600, 6, 1].map((v) => Math.fround(v)));
  });
});

describe("the surface layers", () => {
  it("wet a porous surface darker and glossier, and a metal only glossier", () => {
    const rough = wetSurface([0.5, 0.4, 0.3], 0.8, 0, 1);
    expect(rough.albedo[0]).toBeLessThan(0.5 * 0.6);
    expect(rough.roughness).toBeCloseTo(0.3, 9);
    const metal = wetSurface([0.9, 0.9, 0.9], 0.6, 1, 1);
    expect(metal.albedo[0]).toBeCloseTo(0.9, 9);
    expect(metal.roughness).toBeCloseTo(0.3, 9);
    const dry = wetSurface([0.5, 0.4, 0.3], 0.8, 0, 0);
    expect(dry.albedo[0]).toBeCloseTo(0.5, 9);
    expect(dry.roughness).toBe(0.8);
  });

  it("gather puddles on up-facing ground in the open, more of it with more rain", () => {
    const share = (puddles: number, ny = 1, sky = 1) => {
      const w = resolveWeather({ puddles });
      let wet = 0;
      for (let i = 0; i < 900; i += 1) wet += puddleDepth(w, (i % 30) * 0.37, Math.floor(i / 30) * 0.41, ny, sky) > 0.5 ? 1 : 0;
      return wet / 900;
    };
    expect(share(0)).toBe(0);
    expect(share(0.3)).toBeLessThan(share(0.7));
    expect(share(1)).toBeGreaterThan(0.9);
    // A wall, or the floor under a roof, stays dry.
    expect(share(1, 0.3)).toBe(0);
    expect(share(1, 1, 0.2)).toBe(0);
  });

  it("lay snow on what faces up above the snow line, in the open", () => {
    const w = resolveWeather({ snow: 1, snowLine: 2 });
    expect(snowCover(w, 1, 3, 1, 1, 1)).toBeGreaterThan(0.99);
    expect(snowCover(w, 1, 1, 1, 1, 1)).toBe(0);
    expect(snowCover(w, 1, 3, 1, 0, 1)).toBe(0);
    expect(snowCover(w, 1, 3, 1, 1, 0.1)).toBe(0);
    const light = resolveWeather({ snow: 0.3 });
    let covered = 0;
    for (let i = 0; i < 400; i += 1) covered += snowCover(light, i * 0.53, 0, i * 0.29, 1, 1) > 0.5 ? 1 : 0;
    expect(covered).toBeGreaterThan(20);
    expect(covered).toBeLessThan(380);
  });

  it("ring a puddle with rain that comes and goes, and leave it still without rain", () => {
    expect(rainRipples(1, 2, 3, 0)).toEqual([0, 0]);
    let moving = 0;
    for (let i = 0; i < 200; i += 1) {
      const [gx, gz] = rainRipples((i % 20) * 0.05, Math.floor(i / 20) * 0.05, 1.3, 1);
      if (Math.hypot(gx, gz) > 1e-3) moving += 1;
    }
    expect(moving).toBeGreaterThan(5);
    // The patch noise is smooth: a centimetre apart, nearly the same.
    expect(Math.abs(patchNoise(3, 4, 4) - patchNoise(3.01, 4, 4))).toBeLessThan(0.01);
  });

  it("put a puddle's water and a drift's snow over the material", () => {
    const w = resolveWeather({ puddles: 1, snow: 0 });
    const s = weatherSurface(w, [0, 0, 0], [0, 1, 0], 1, 0, { albedo: [0.5, 0.5, 0.5], roughness: 0.8, metallic: 0.5, f0: 0.04 });
    expect(s.roughness).toBeLessThan(0.05);
    expect(s.f0).toBeCloseTo(WATER_F0, 6);
    expect(s.metallic).toBeCloseTo(0, 6);
    const snowy = weatherSurface(resolveWeather({ snow: 1 }), [0, 0, 0], [0.2, 0.98, 0], 1, 0, { albedo: [0.1, 0.1, 0.1], roughness: 0.2, metallic: 0, f0: 0.04 });
    expect(snowy.albedo[0]).toBeCloseTo(SNOW_ALBEDO[0], 2);
    expect(snowy.normal[1]).toBeGreaterThan(0.99);
  });
});

describe("rain and snow falling", () => {
  it("are emitters over a box round the eye, colliding with the depth buffer, as hard as it falls", () => {
    expect(weatherEmitters(resolveWeather({}))).toEqual([]);
    const both = weatherEmitters(resolveWeather({ rain: 1, snowfall: 0.5 }));
    expect(both.map((e) => e.name)).toEqual(["weather:rain", "weather:snow"]);
    const rain = compileEmitter(both[0]!);
    expect(rain.depthCollide).toBe(true);
    expect(rain.gravity[1]).toBeLessThan(-5);
    expect(rain.rate).toBe(4000);
    const snow = compileEmitter(both[1]!);
    expect(snow.gravity[1]).toBeGreaterThan(-2);
    expect(snow.rate).toBe(400);
    expect(compileEmitter(weatherEmitters(resolveWeather({ rain: 0.25 }))[0]!).rate).toBe(1000);
    expect(precipitationOrigin([1, 2, 3])).toEqual([1, 2 + PRECIPITATION_BOX[1], 3]);
  });
});

describe("the shader", () => {
  it("lays the weather over the linear-light surfaces only", () => {
    expect(sceneShader(null, false, true)).toContain("let ws = weatherSurface(in.worldPos, N, wSky, albedo, rough, metallic);");
    expect(sceneShader(null, false, true)).toContain(WEATHER_WGSL.trim().slice(0, 40));
    expect(sceneShader(null, false, false)).not.toContain("weatherSurface(");
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

const W = 48;
const H = 48;
const floorMesh = (albedo: number, rough: number): MeshAsset =>
  ({
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "floor", baseColorImage: null, baseColorFactor: [albedo, albedo, albedo, 1], metallicFactor: 0, roughnessFactor: rough },
      },
    ],
  }) as unknown as MeshAsset;

/** The floor's mean linear-light green over the middle of the frame, a sun from the side and a little ambient, under `weather`. */
async function floorUnder(weather: object | null): Promise<number> {
  const ground: MeshSceneInstance = { mesh: floorMesh(0.5, 0.9), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [8, 1, 8]) };
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!([ground], {
    width: W,
    height: H,
    view: viewMatrix([0, 4, 3], [0, 0, -1]),
    projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
    ambient: 0.2,
    lightDirection: [0.4, 0.8, -0.45],
    lights: [{ kind: "directional", direction: [0.4, 0.8, -0.45], color: [1, 1, 1], intensity: 1 }],
    weather: weather ? resolveWeather(weather) : null,
    time: 1.5,
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
  let sum = 0;
  let n = 0;
  for (let y = H / 4; y < (3 * H) / 4; y += 1) {
    for (let x = W / 4; x < (3 * W) / 4; x += 1) {
      sum += half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!);
      n += 1;
    }
  }
  return sum / n;
}

describe.skipIf(!device)("weather on a real device", { timeout: 120_000 }, () => {
  it("darkens a wet floor, whitens a snowy one, and leaves a dry one as it was", async () => {
    const dry = await floorUnder(null);
    const off = await floorUnder({ wetness: 0, snow: 0 });
    const wet = await floorUnder({ wetness: 1 });
    const snowy = await floorUnder({ snow: 1 });
    expect(dry).toBeGreaterThan(0.05);
    expect(off).toBeCloseTo(dry, 6);
    // Wet: the porous albedo near squared, and darker still (0.5 → about 0.19): the diffuse falls by more than a third.
    expect(wet).toBeLessThan(dry * 0.75);
    expect(snowy).toBeGreaterThan(dry * 1.4);
  });
});

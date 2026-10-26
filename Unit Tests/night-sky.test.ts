/**
 * The moon and the night sky in physical units (AAA_FIDELITY_ROADMAP.md
 * F5a-3): the moon's phase and light worked out by hand, the moon taking the
 * key once the sun has set, the night sky scattering its light, and the AAA
 * backdrop's moon, stars and glow on a real device.
 */

import { describe, expect, it } from "vitest";

import {
  LUX_TO_UNITS,
  MOON_ALBEDO,
  MOON_RADIUS,
  MOON_SOLID_ANGLE,
  NIGHT_SKY_RADIANCE,
  atmosphereLighting,
  atmosphereLuts,
  atmospherePanorama,
  atmosphereSun,
  defaultProceduralSky,
  defaultSceneLighting,
  moonLightsSky,
  moonPhase,
  moonRadiance,
  parseAtmosphere,
  projectionMatrix,
  resolveAtmosphere,
  skyRadiance,
  starIlluminance,
  sunDiscRadiance,
  sunTransmittance,
  viewMatrix,
  type SceneLighting,
} from "@cartbox/editor";
import { GpuPresenter } from "@cartbox/player";

const EARTH = resolveAtmosphere({});
const LUTS = atmosphereLuts(EARTH);
const elevated = (degrees: number, azimuth = 0): [number, number, number] => {
  const e = (degrees * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
};
const WHITE: [number, number, number] = [1, 1, 1];

function rig(sun: [number, number, number], atmosphere: object = {}): SceneLighting {
  return { ...defaultSceneLighting(), lights: [{ kind: "directional", direction: sun, color: [1, 1, 1], intensity: 1 }], sky: { ...defaultProceduralSky(), atmosphere } };
}

describe("the moon, worked out by hand", () => {
  it("is full opposite the sun, a 1/π quarter at right angles, and new beside it", () => {
    const sun = elevated(-30, 0);
    expect(moonPhase(sun, sun.map((v) => -v))).toBeCloseTo(1, 9);
    expect(moonPhase(sun, elevated(0, 90))).toBeCloseTo(1 / Math.PI, 3);
    expect(moonPhase(sun, sun)).toBeCloseTo(0, 9);
  });

  it("lights a full moon's night at a quarter of a lux, from its albedo and size", () => {
    const sun = elevated(-30);
    const full = moonRadiance(WHITE, sun, sun.map((v) => -v));
    expect(full[0]).toBeCloseTo((MOON_ALBEDO * MOON_SOLID_ANGLE) / Math.PI, 12);
    // A sun of 1 is 123.5 klx above the air: the full moon above it gives a quarter of a lux or so.
    const lux = full[0] * 123500;
    expect(lux).toBeGreaterThan(0.2);
    expect(lux).toBeLessThan(0.35);
    expect(MOON_RADIUS).toBeCloseTo((0.26 * Math.PI) / 180, 12);
  });

  it("puts a magnitude-0 star near 2.5 microlux, and the night sky's glow a million times under the day's", () => {
    expect(starIlluminance(0)).toBeCloseTo(2.54e-6, 12);
    expect(starIlluminance(5) / starIlluminance(0)).toBeCloseTo(0.01, 9);
    expect(LUX_TO_UNITS).toBeCloseTo(Math.PI / 123500, 15);
    expect(NIGHT_SKY_RADIANCE).toBeLessThan(skyRadiance(LUTS, [0, 1, 0], elevated(40), WHITE)[2] * 1e-6);
  });

  it("reads its settings in range and keeps a direction it is given", () => {
    expect(parseAtmosphere({ moon: -2, stars: 5000, moonDirection: [0, 2, 0] })).toEqual({ moon: 0, stars: 1000, moonDirection: [0, 2, 0] });
    expect(parseAtmosphere({ moonDirection: [0, 0, 0] })).toEqual({});
    const placed = atmosphereSun(rig(elevated(-20), { moonDirection: [0, 1, 0] }))!;
    expect(placed.moon!.direction).toEqual([0, 1, 0]);
    expect(atmosphereSun(rig(elevated(-20), { moon: 0 }))!.moon).toBeNull();
  });
});

describe("the moon among the rig's lights", () => {
  it("stands opposite the sun by default, a dim light of its own while the sun is up", () => {
    const lighting = atmosphereLighting(rig(elevated(-30, 0)));
    const day = atmosphereLighting(rig(elevated(30, 0)));
    // By day the sun stays the key, and the moon (set, opposite it) adds nothing.
    expect(day.lights).toHaveLength(1);
    expect(day.lights[0]!.direction![1]).toBeGreaterThan(0);
    // By night (the sun 30° down), the moon 30° up is the key, through the air toward it.
    const key = lighting.lights[0]!;
    expect(key.kind).toBe("directional");
    expect(key.direction![1]).toBeCloseTo(Math.sin(Math.PI / 6), 9);
    const want = moonRadiance(WHITE, elevated(-30, 0), elevated(30, 180)).map((r, c) => r * sunTransmittance(LUTS, elevated(30, 180))[c]!);
    expect(key.intensity).toBeCloseTo(Math.max(...want), 12);
    // The set sun is still there, dark, after it.
    expect(lighting.lights[1]!.color).toEqual([0, 0, 0]);
  });

  it("lights the night sky through the air, which only counts once the sun is down", () => {
    const sun = elevated(-25, 0);
    const night = atmosphereSun(rig(sun))!;
    expect(moonLightsSky(sun, night.moon)).toBe(true);
    expect(moonLightsSky(elevated(10), night.moon)).toBe(false);
    const pano = atmospherePanorama(LUTS, sun, WHITE, 32, 16, night.moon);
    const bare = atmospherePanorama(LUTS, sun, WHITE, 32, 16);
    const y = 4, x = 20;
    const i = (y * 32 + x) * 3;
    const theta = (Math.PI * (y + 0.5)) / 16;
    const phi = (2 * Math.PI * (x + 0.5)) / 32 - Math.PI;
    const d = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
    const fromMoon = skyRadiance(LUTS, d, night.moon!.direction, night.moon!.radiance);
    for (let c = 0; c < 3; c += 1) expect(pano.data[i + c]! - bare.data[i + c]!).toBeCloseTo(fromMoon[c]!, 12);
    // Moonlit sky is still blue, a millionth of the day's or so.
    expect(fromMoon[2]).toBeGreaterThan(fromMoon[0]);
    expect(fromMoon[2] / skyRadiance(LUTS, d, elevated(30, 180), WHITE)[2]).toBeLessThan(1e-4);
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
  for (let i = 0; i < 400 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

describe.skipIf(!device)("the AAA night sky, on a real device", { timeout: 120_000 }, () => {
  const W = 96;
  const H = 64;
  // Looking toward the moon, 30° up in the south (opposite a sun 30° under the north).
  const sun = elevated(-30, 0);
  const moonDir = elevated(30, 180);
  const view = viewMatrix([0, 1, 0], [1 + moonDir[0] - 1, 1 + moonDir[1], moonDir[2]]);
  const projection = projectionMatrix(0.12, W / H, 0.1, 100);

  /** The display's encoding undone: the presenter encodes an unmapped frame for the display, even into half floats. */
  const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

  /** The backdrop in linear light, a lookup of RGB at a pixel. */
  async function backdrop(stars: number): Promise<(x: number, y: number) => number[]> {
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const at = atmosphereSun(rig(sun, { stars }))!;
    const t = sunTransmittance(LUTS, at.moon!.direction);
    const moonDisc = [0, 1, 2].map((c) => MOON_ALBEDO * t[c]!) as [number, number, number];
    const atmosphere = { atmosphere: EARTH, sun, sunRadiance: WHITE, disc: sunDiscRadiance(LUTS, sun, WHITE), moon: at.moon, stars, moonDisc };
    const map = { width: 4, height: 2, data: new Uint8ClampedArray(32).fill(255) };
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba16float", usage: 0x10 | 0x01 });
    device.pushErrorScope("validation");
    presenter.present({ base: { kind: "sky", sky: { map, view, projection, sun: null, clouds: [], time: 0, atmosphere } }, scene: null, tonemap: null } as any, out, "rgba16float");
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: out }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    out.destroy();
    presenter.dispose();
    return (x, y) => [0, 1, 2].map((k) => decode(half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!)));
  }

  it("draws the full moon lit by the sun over its own light in the air, as the CPU works it out", async () => {
    const at = await backdrop(0);
    // The frame's centre looks at the moon's: its near face square to the sun behind the eye.
    const centre = at(W >> 1, H >> 1);
    const air = skyRadiance(LUTS, moonDir, sun, WHITE).map((v, c) => v + skyRadiance(LUTS, moonDir, moonDir, moonRadiance(WHITE, sun, moonDir))[c]!);
    const t = sunTransmittance(LUTS, moonDir);
    // The point on the moon's face the centre pixel's ray meets (half a pixel off its middle), lit by the sun.
    const nx = (((W >> 1) + 0.5) / W) * 2 - 1;
    const ny = 1 - (((H >> 1) + 0.5) / H) * 2;
    const ray = [0, 1, 2].map((a) => view[a * 4]! * (nx / projection[0]!) + view[a * 4 + 1]! * (ny / projection[5]!) - view[a * 4 + 2]!);
    const len = Math.hypot(ray[0]!, ray[1]!, ray[2]!);
    const n = ray.map((v) => v / len);
    const along = n[0]! * moonDir[0] + n[1]! * moonDir[1] + n[2]! * moonDir[2];
    const x = n.map((v, k) => (v - moonDir[k]! * along) / Math.sin(MOON_RADIUS));
    const N = x.map((v, k) => v - moonDir[k]! * Math.sqrt(Math.max(0, 1 - (x[0]! ** 2 + x[1]! ** 2 + x[2]! ** 2))));
    const lit = Math.max(0, N[0]! * sun[0] + N[1]! * sun[1] + N[2]! * sun[2]);
    expect(lit).toBeGreaterThan(0.9);
    for (let c = 0; c < 3; c += 1) {
      const want = air[c]! + MOON_ALBEDO * t[c]! * lit;
      expect(Math.abs(centre[c]! - want) / want).toBeLessThan(0.03);
    }
    // Off the disc, only the moonlit air: a hundred-thousandth of the disc.
    const off = at(4, 4);
    expect(off[2]!).toBeLessThan(centre[2]! * 1e-4);
    expect(off[2]!).toBeGreaterThan(0);
  });

  it("scatters stars over the night sky, which leave the sky alone where there are none", async () => {
    const dark = await backdrop(0);
    const starry = await backdrop(1);
    let brightest = 0;
    let lifted = 0;
    let n = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (Math.hypot(x - W / 2, y - H / 2) < 8) continue; // the moon
        const gain = starry(x, y)[1]! - dark(x, y)[1]!;
        brightest = Math.max(brightest, gain);
        if (gain > NIGHT_SKY_RADIANCE * 2) lifted += 1;
        n += 1;
      }
    }
    // Somewhere a star stands far over the night sky's glow; most of the sky is only the glow.
    expect(brightest).toBeGreaterThan(NIGHT_SKY_RADIANCE * 100);
    expect(lifted / n).toBeLessThan(0.2);
  });
});

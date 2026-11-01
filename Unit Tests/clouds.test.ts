/**
 * Volumetric clouds (AAA_FIDELITY_ROADMAP.md F5c), the CPU reference: the
 * settings, the tileable noises, the density's shell and coverage, the light a
 * layer sends toward the eye and lets through, and its shadows.
 */

import { describe, expect, it } from "vitest";

import { atmosphereLuts, resolveAtmosphere, skyRadiance } from "../packages/editor/src/model/atmosphere";
import {
  CLOUD_DEFAULTS,
  airTransmittance,
  SHAPE_SIZE,
  cloudDensity,
  cloudNoise,
  cloudRadiance,
  cloudShadow,
  heightGradient,
  hgPhase,
  parseClouds,
  resolveClouds,
  sampleVolume,
  valueNoise,
  worley,
} from "../packages/editor/src/model/clouds";

const luts = atmosphereLuts(resolveAtmosphere());
const noise = cloudNoise();
const bottom = luts.atmosphere.bottom;
const norm = (v: number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((x) => x / l);
};
const noon = norm([0.3, 0.9, 0.2]);
const sunRadiance = [1, 1, 1];
const ambientOf = (sun: number[]) => {
  // The upper sky's mean radiance, from a handful of directions.
  const sum = [0, 0, 0];
  const dirs = [[0, 1, 0], [1, 0.5, 0], [-1, 0.5, 0], [0, 0.5, 1], [0, 0.5, -1]].map(norm);
  for (const d of dirs) skyRadiance(luts, d, sun, sunRadiance).forEach((v, c) => (sum[c]! += v / dirs.length));
  return sum;
};

describe("cloud settings", () => {
  it("parse sparsely and in range, and resolve to the defaults", () => {
    expect(parseClouds(null)).toBeNull();
    expect(parseClouds({ coverage: 2, base: -1, type: "x", density: 30 })).toEqual({ coverage: 1, base: 0.1, density: 30 });
    const c = resolveClouds({});
    expect(c.coverage).toBe(CLOUD_DEFAULTS.coverage);
    expect(c.thickness).toBe(CLOUD_DEFAULTS.thickness);
    // 12 m/s toward 30°, in km a second.
    expect(Math.hypot(c.wind[0], c.wind[1])).toBeCloseTo(0.012, 6);
    expect(Math.atan2(c.wind[1], c.wind[0])).toBeCloseTo(Math.PI / 6, 6);
  });
});

describe("cloud noises", () => {
  it("tile: a period on, the same value", () => {
    for (const [x, y, z] of [[0.3, 1.7, 2.2], [3.9, 0.1, 1.5]]) {
      expect(valueNoise(x!, y!, z!, 4, 1)).toBeCloseTo(valueNoise(x! + 4, y! - 4, z! + 8, 4, 1), 9);
      expect(worley(x!, y!, z!, 4, 1)).toBeCloseTo(worley(x! + 4, y!, z! - 4, 4, 1), 9);
    }
  });

  it("bake into volumes that cover their range and wrap at the edges", () => {
    expect(noise.shape.length).toBe(SHAPE_SIZE ** 3 * 4);
    let lo = 255, hi = 0;
    for (let i = 0; i < noise.shape.length; i += 4) {
      lo = Math.min(lo, noise.shape[i]!);
      hi = Math.max(hi, noise.shape[i]!);
    }
    expect(lo).toBeLessThan(60);
    expect(hi).toBeGreaterThan(200);
    expect(sampleVolume(noise.shape, SHAPE_SIZE, 0.01, 0.5, 0.5, 1)).toBeCloseTo(sampleVolume(noise.shape, SHAPE_SIZE, 1.01, 0.5, -0.5, 1), 9);
  });
});

describe("cloud density", () => {
  it("runs from the floor to the top by type: stratus stays low, cumulus towers", () => {
    expect(heightGradient(0, 1)).toBe(0);
    expect(heightGradient(1, 1)).toBe(0);
    expect(heightGradient(0.5, 0)).toBe(0);
    expect(heightGradient(0.5, 1)).toBe(1);
    expect(heightGradient(0.12, 0)).toBe(1);
  });

  it("fills only the layer's shell, more of it the more the cover", () => {
    const c = resolveClouds({ coverage: 0.5 });
    expect(cloudDensity(c, noise, bottom, [0, c.base - 0.1, 0], 0)).toBe(0);
    expect(cloudDensity(c, noise, bottom, [0, c.base + c.thickness + 0.1, 0], 0)).toBe(0);
    const mean = (coverage: number) => {
      const layer = resolveClouds({ coverage });
      let sum = 0;
      for (let i = 0; i < 400; i += 1) sum += cloudDensity(layer, noise, bottom, [(i % 20) * 1.7, layer.base + layer.thickness * 0.3, Math.floor(i / 20) * 1.9], 0);
      return sum / 400;
    };
    expect(mean(0)).toBe(0);
    expect(mean(0.3)).toBeLessThan(mean(0.6));
    expect(mean(0.6)).toBeLessThan(mean(1));
    expect(mean(1)).toBeGreaterThan(0.2 * CLOUD_DEFAULTS.density);
  });

  it("drifts with the wind", () => {
    const c = resolveClouds({ coverage: 0.7, windSpeed: 20, windDirection: 0 });
    const p = [3, c.base + 0.4, 5];
    const later = cloudDensity(c, noise, bottom, [p[0]! + 0.02 * 100, p[1]!, p[2]!], 100);
    // The floor drifts 20 m/s × 100 s = 2 km (the shape's lean is a share of the height above it).
    const h = 0.4 / c.thickness;
    const earlier = cloudDensity(c, noise, bottom, [p[0]! + 0.02 * 100 - 0.02 * 100 * (1 + 0.5 * h), p[1]!, p[2]!], 0);
    // (The same up to the planet's curve, a millimetre or two over a few km.)
    expect(Math.abs(later - earlier)).toBeLessThan(0.05 * Math.max(later, earlier));
    expect(Math.abs(later - cloudDensity(c, noise, bottom, [p[0]! + 0.02 * 100, p[1]!, p[2]!], 0))).toBeGreaterThan(0.05 * later);
  });
});

describe("the light through a cloud layer", () => {
  it("is nothing at all under a clear sky, or below the horizon", () => {
    const clear = resolveClouds({ coverage: 0 });
    const up = cloudRadiance(luts, clear, noise, [0, 1, 0], noon, sunRadiance, ambientOf(noon), 0);
    expect(up.transmittance).toBe(1);
    expect(up.inscatter).toEqual([0, 0, 0]);
    const down = cloudRadiance(luts, resolveClouds({ coverage: 1 }), noise, norm([1, -0.2, 0]), noon, sunRadiance, ambientOf(noon), 0);
    expect(down.transmittance).toBe(1);
  });

  it("hides the sky under overcast, and is a bright, near-white grey at noon", () => {
    const overcast = resolveClouds({ coverage: 1, density: 80 });
    const up = cloudRadiance(luts, overcast, noise, norm([0.1, 1, 0.05]), noon, sunRadiance, ambientOf(noon), 0);
    expect(up.transmittance).toBeLessThan(0.05);
    const [r, g, b] = up.inscatter;
    // An overcast sky's luminance is about a tenth of a sunlit white surface's (10 klx under it against 100 klx of sun).
    expect(g).toBeGreaterThan(0.02);
    expect(g).toBeLessThan(0.4);
    // Whiter than the blue sky behind it: its channels within a third of each other.
    expect(Math.min(r, g, b) / Math.max(r, g, b)).toBeGreaterThan(0.6);
    expect(up.distance).toBeGreaterThan(overcast.base);
  });

  it("glows toward the sun (its forward lobe) and darkens once the sun has set", () => {
    expect(hgPhase(1, 0.8)).toBeGreaterThan(20 * hgPhase(-1, 0.8));
    const layer = resolveClouds({ coverage: 0.9, density: 6 });
    const low = norm([1, 0.25, 0]);
    const toward = cloudRadiance(luts, layer, noise, norm([1, 0.3, 0.05]), low, sunRadiance, ambientOf(low), 0);
    const away = cloudRadiance(luts, layer, noise, norm([-1, 0.3, 0.05]), low, sunRadiance, ambientOf(low), 0);
    expect(toward.inscatter[1]).toBeGreaterThan(away.inscatter[1]);
    const set = norm([1, -0.2, 0]);
    const dusk = cloudRadiance(luts, layer, noise, norm([0.1, 1, 0]), set, sunRadiance, ambientOf(set), 0);
    const day = cloudRadiance(luts, layer, noise, norm([0.1, 1, 0]), noon, sunRadiance, ambientOf(noon), 0);
    expect(dusk.inscatter[1]).toBeLessThan(0.02 * day.inscatter[1]);
  });
});

describe("cloud shadows", () => {
  it("let the sun through a clear sky, dim it under overcast by the setting, and lift when the sun is down", () => {
    expect(cloudShadow(resolveClouds({ coverage: 0 }), noise, bottom, 1, 2, noon, 0)).toBe(1);
    const overcast = resolveClouds({ coverage: 1, density: 80, shadows: 0.8 });
    const s = cloudShadow(overcast, noise, bottom, 1, 2, noon, 0);
    expect(s).toBeLessThan(0.3);
    expect(s).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(cloudShadow(overcast, noise, bottom, 1, 2, [1, 0, 0], 0)).toBe(1);
  });
});

// --- On a real device (Dawn) ------------------------------------------------------------

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
  for (let i = 0; i < 2000 && !done; i += 1) {
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

describe.skipIf(!device)("clouds on a real device", { timeout: 300_000 }, () => {
  it("march as the CPU does, texel by texel, and lie over the sky in the presenter's order", async () => {
    const { GpuAtmosphere } = await import("../packages/player/src/render/atmosphere");
    const { GpuClouds } = await import("../packages/player/src/render/clouds");
    const { viewMatrix, projectionMatrix } = await import("../packages/editor/src/index");
    const atmosphere = resolveAtmosphere();
    const sun = norm([0.5, 0.6, 0.3]) as [number, number, number];
    const sky = { atmosphere, sun, sunRadiance: [1, 1, 1] as [number, number, number] };
    const clouds = resolveClouds({ coverage: 0.7, density: 30 });
    const ambient = ambientOf(sun) as [number, number, number];
    const time = 37;
    const W = 24, H = 16; // the frame; the clouds march at half that
    const view = viewMatrix([0, 2, 0], [10, 14, 6]);
    const projection = projectionMatrix(Math.PI / 2, W / H, 0.1, 5000);
    const gpuAtm = new GpuAtmosphere(device);
    gpuAtm.update(sky);
    const gpu = new GpuClouds(device);
    device.pushErrorScope("validation");
    const encoder = device.createCommandEncoder();
    const target = gpu.march(encoder, sky, { clouds, ambient, time }, view, projection, gpuAtm.transmittance, W, H, 0.5);
    const tw = W / 2, th = H / 2;
    const rowBytes = 256;
    const buffer = device.createBuffer({ size: rowBytes * th, usage: 0x01 | 0x08 });
    encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: rowBytes }, { width: tw, height: th });
    device.queue.submit([encoder.finish()]);
    const error = await settled(device.popErrorScope());
    if (error) console.log("GPU error:", String((error as any).message ?? error));
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    await settled(buffer.mapAsync(0x01));
    const data = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    const v = view, p = projection;
    let worstLight = 0, worstT = 0, cloudy = 0;
    let peak = 0;
    const want: { light: number[]; t: number }[] = [];
    for (let y = 0; y < th; y += 1) {
      for (let x = 0; x < tw; x += 1) {
        const ndc = [((x + 0.5) / tw) * 2 - 1, 1 - ((y + 0.5) / th) * 2];
        const d = norm([
          v[0]! * ndc[0]! / p[0]! + v[1]! * ndc[1]! / p[5]! - v[2]!,
          v[4]! * ndc[0]! / p[0]! + v[5]! * ndc[1]! / p[5]! - v[6]!,
          v[8]! * ndc[0]! / p[0]! + v[9]! * ndc[1]! / p[5]! - v[10]!,
        ]);
        const m = cloudRadiance(luts, clouds, noise, d, sun, [1, 1, 1], ambient, time, 0.5);
        const air = m.distance > 0 ? airTransmittance(luts, d, m.distance) : [1, 1, 1];
        const light = m.inscatter.map((c, k) => c * air[k]!);
        want.push({ light, t: m.transmittance });
        peak = Math.max(peak, ...light);
        if (m.transmittance < 0.9) cloudy += 1;
      }
    }
    for (let i = 0; i < want.length; i += 1) {
      const x = i % tw, y = Math.floor(i / tw);
      const o = (y * rowBytes) / 2 + x * 4;
      for (let k = 0; k < 3; k += 1) worstLight = Math.max(worstLight, Math.abs(half(data[o + k]!) - want[i]!.light[k]!) / Math.max(0.1 * want[i]!.light[k]!, 0.04 * peak));
      worstT = Math.max(worstT, Math.abs(half(data[o + 3]!) - want[i]!.t));
    }
    // The view looks up into the layer: most texels see cloud, some see through.
    expect(cloudy).toBeGreaterThan(want.length * 0.3);
    // 8-bit noise filtered by the hardware against the CPU's exact trilinear, through Nubis's remaps: close, not exact.
    expect(worstLight).toBeLessThan(1);
    expect(worstT).toBeLessThan(0.08);
    gpu.dispose();
    gpuAtm.dispose();
  });
});

describe("the key light under a cloud layer", () => {
  it("is dimmed by the layer's shadow where the eye stands, in steps, and left alone without clouds", async () => {
    const { cloudShadedLighting, defaultSceneLighting } = await import("../packages/editor/src/index");
    const base = defaultSceneLighting();
    const sun = { kind: "directional" as const, direction: [0.3, 0.9, 0.2] as [number, number, number], color: [1, 1, 1] as [number, number, number], intensity: 2 };
    const sky = base.sky!;
    const clear = { ...base, lights: [sun], sky: { ...sky, atmosphere: {} } };
    expect(cloudShadedLighting(clear, 10, 20, 0)).toBe(clear);
    const overcast = { ...clear, sky: { ...sky, atmosphere: { clouds: { coverage: 1, density: 80, shadows: 0.8 } } } };
    const lit = cloudShadedLighting(overcast, 10, 20, 0);
    const k = lit.lights[0]!.intensity / 2;
    expect(k).toBeLessThan(0.35);
    expect(k).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(Math.round(k * 64)).toBeCloseTo(k * 64, 9);
    // The same shade again is the same rig.
    expect(cloudShadedLighting(overcast, 10, 20, 0)).toBe(lit);
  });

  it("parses under a physical sky and survives a save", async () => {
    const { parseAtmosphere } = await import("../packages/editor/src/index");
    const parsed = parseAtmosphere({ clouds: { coverage: 0.6, windSpeed: 400 } });
    expect(parsed?.clouds).toEqual({ coverage: 0.6, windSpeed: 100 });
    expect(parseAtmosphere(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

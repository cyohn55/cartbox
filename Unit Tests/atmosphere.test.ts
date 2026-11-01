/**
 * The physically based sky (AAA_FIDELITY_ROADMAP.md F5a): Hillaire's
 * atmosphere on the CPU held to what can be worked out by hand, the GPU's
 * LUTs held to the CPU texel by texel, and what the renderers light by from it.
 */

import { describe, expect, it } from "vitest";

import {
  MULTISCATTER_SIZE,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
  atmosphereLighting,
  atmosphereLuts,
  atmospherePanorama,
  atmosphereSun,
  defaultProceduralSky,
  decodeHdrLightmap,
  defaultSceneLighting,
  deserializeMeshAsset,
  integrateTransmittance,
  miePhase,
  parseAtmosphere,
  parseSky,
  projectionMatrix,
  rayleighPhase,
  resolveAtmosphere,
  sampleLut,
  skyRadiance,
  sunDiscRadiance,
  sunTransmittance,
  transmittanceRMu,
  transmittanceUv,
  viewMatrix,
  type MeshAsset,
  type SceneLighting,
} from "@cartbox/editor";
import { GpuPresenter, MeshOverlaySurface, environmentPanorama, parseMeshScene, sceneSkyEnvironment, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import { addMesh, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { bakeSceneLighting } from "../apps/web/src/lib/lightBake";
import { GpuAtmosphere, SKY_VIEW_HEIGHT, SKY_VIEW_WIDTH, skyViewDirection, skyViewUv } from "../packages/player/src/render/atmosphere";

const EARTH = resolveAtmosphere({});
const LUTS = atmosphereLuts(EARTH);
const elevated = (degrees: number): [number, number, number] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0];
const WHITE: [number, number, number] = [1, 1, 1];

/** The sky's irradiance over π on level ground (in the renderer's units): its cosine-weighted mean over the upper hemisphere. */
function skyIrradiance(sun: readonly number[], n = 48): number[] {
  const out = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const th = ((i + 0.5) / n) * (Math.PI / 2);
    for (let j = 0; j < 2 * n; j += 1) {
      const ph = ((j + 0.5) / (2 * n)) * 2 * Math.PI;
      const L = skyRadiance(LUTS, [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)], sun, WHITE);
      const w = (Math.cos(th) * Math.sin(th) * (Math.PI / 2 / n) * (Math.PI / n)) / Math.PI;
      for (let c = 0; c < 3; c += 1) out[c]! += L[c]! * w;
    }
  }
  return out;
}

describe("the atmosphere, on the CPU", () => {
  it("reads its settings defensively and resolves Earth's medium by default", () => {
    expect(parseAtmosphere(null)).toBeNull();
    expect(parseAtmosphere({ mie: 500, ozone: -1, altitude: 120, junk: 3 })).toEqual({ mie: 50, ozone: 0, altitude: 120 });
    expect(EARTH.bottom).toBe(6360);
    expect(EARTH.top).toBe(6460);
    expect(EARTH.rayleighScattering[2]).toBeCloseTo(33.1e-3, 9);
    expect(resolveAtmosphere({ mie: 2 }).mieExtinction).toBeCloseTo(2 * (3.996e-3 + 4.4e-3), 9);
    // A sky keeps its atmosphere through a save; without one it is painted.
    expect(parseSky({ ...defaultProceduralSky(), atmosphere: { rayleigh: 1.5 } })?.atmosphere).toEqual({ rayleigh: 1.5 });
    expect(parseSky(defaultProceduralSky())?.atmosphere).toBeUndefined();
  });

  it("maps the transmittance LUT both ways, and integrates the zenith's optical depth in closed form", () => {
    for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.05], [0.3, 0.95]] as const) {
      const { r, mu } = transmittanceRMu(EARTH, u, v);
      const [u2, v2] = transmittanceUv(EARTH, r, mu);
      expect(u2).toBeCloseTo(u, 6);
      expect(v2).toBeCloseTo(v, 6);
    }
    // Straight up from the ground: σ_R · 8 (1 − e^−12.5) + σ_M · 1.2 (1 − e^−83) + σ_O · 15.
    const depth = [0, 1, 2].map((c) => EARTH.rayleighScattering[c]! * 8 * (1 - Math.exp(-100 / 8)) + EARTH.mieExtinction * 1.2 + EARTH.ozoneAbsorption[c]! * 15);
    const up = integrateTransmittance(EARTH, EARTH.bottom, 1);
    depth.forEach((d, c) => expect(up[c]! / Math.exp(-d)).toBeCloseTo(1, 3));
    // The LUT agrees with the integral between its texels.
    const lut = sampleLut(LUTS.transmittance, ...transmittanceUv(EARTH, EARTH.bottom + 2, 0.3));
    const exact = integrateTransmittance(EARTH, EARTH.bottom + 2, 0.3);
    exact.forEach((t, c) => expect(Math.abs(lut[c]! - t)).toBeLessThan(0.005));
  });

  it("normalises its phase functions over the sphere", () => {
    let rayleigh = 0, mie = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const c = 1 - (2 * (i + 0.5)) / n;
      rayleigh += rayleighPhase(c) * (4 * Math.PI) / n;
      mie += miePhase(c, 0.8) * (4 * Math.PI) / n;
    }
    expect(rayleigh).toBeCloseTo(1, 4);
    expect(mie).toBeCloseTo(1, 2);
  });

  it("is blue overhead at noon, red toward a setting sun, and dark once it has set", () => {
    const noon = skyRadiance(LUTS, [0, 1, 0], elevated(60), WHITE);
    expect(noon[2]!).toBeGreaterThan(1.5 * noon[0]!);
    const sunset = skyRadiance(LUTS, [Math.cos(0.03), Math.sin(0.03), 0], elevated(1), WHITE);
    expect(sunset[0]!).toBeGreaterThan(3 * sunset[2]!);
    const set = skyRadiance(LUTS, [0, 1, 0], elevated(-8), WHITE);
    expect(Math.max(...set)).toBeLessThan(0.02 * Math.max(...noon));
    // The horizon is brighter than the zenith at noon, and the sun's own side brighter than the far side at dusk.
    expect(skyRadiance(LUTS, [Math.cos(0.05), Math.sin(0.05), 0], elevated(60), WHITE)[1]!).toBeGreaterThan(noon[1]!);
    expect(sunset[0]!).toBeGreaterThan(skyRadiance(LUTS, [-Math.cos(0.03), Math.sin(0.03), 0], elevated(1), WHITE)[0]! * 2);
  });

  it("lights the ground with a tenth or so of the sun's light from a clear noon sky", () => {
    // The diffuse share of a clear sky at a high sun is about 10–20% of the direct beam's.
    const sun = elevated(70);
    const E = skyIrradiance(sun);
    const direct = sunTransmittance(LUTS, sun).map((t) => t * Math.sin((70 * Math.PI) / 180));
    const lum = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(lum(E) / lum(direct)).toBeGreaterThan(0.06);
    expect(lum(E) / lum(direct)).toBeLessThan(0.25);
    // Doubling the haze whitens the sky toward the horizon.
    const hazy = atmosphereLuts(resolveAtmosphere({ mie: 8 }));
    const d = [Math.cos(0.1), Math.sin(0.1), 0];
    const clear = skyRadiance(LUTS, d, elevated(70), WHITE);
    const white = skyRadiance(hazy, d, elevated(70), WHITE);
    expect(white[0]! / white[2]!).toBeGreaterThan(clear[0]! / clear[2]!);
  });

  it("tints the key light by the air toward it, and draws the sun's disc at its illuminance over its solid angle", () => {
    const noon = sunTransmittance(LUTS, [0, 1, 0]);
    const exact = integrateTransmittance(EARTH, EARTH.bottom + EARTH.viewHeight, 1, 4000);
    noon.forEach((t, c) => expect(t).toBeCloseTo(exact[c]!, 2));
    expect(sunTransmittance(LUTS, elevated(-1))).toEqual([0, 0, 0]);
    const disc = sunDiscRadiance(LUTS, [0, 1, 0], WHITE);
    const solid = 2 * Math.PI * (1 - Math.cos(EARTH.sunRadius));
    expect(disc[1]! * solid).toBeCloseTo(Math.PI * noon[1]!, 3);

    const lighting: SceneLighting = {
      ...defaultSceneLighting(),
      lights: [{ kind: "directional", direction: elevated(3), color: [1, 1, 1], intensity: 1.2, temperature: 6500 }, { kind: "point", position: [0, 1, 0], color: [1, 0, 0], intensity: 1 }],
      sky: { ...defaultProceduralSky(), atmosphere: {} },
    };
    const sun = atmosphereSun(lighting)!;
    expect(sun.direction[1]).toBeCloseTo(Math.sin((3 * Math.PI) / 180), 6);
    const lit = atmosphereLighting(lighting);
    expect(atmosphereLighting(lighting)).toBe(lit);
    const key = lit.lights[0]!;
    expect(key.temperature).toBeUndefined();
    expect(key.intensity).toBe(1.2);
    // A low sun is orange: red through, blue mostly scattered away.
    expect(key.color[0]).toBeGreaterThan(key.color[2] + 0.3);
    expect(lit.lights[1]).toBe(lighting.lights[1]);
    // A painted sky leaves the rig alone.
    const painted = { ...lighting, sky: defaultProceduralSky() };
    expect(atmosphereLighting(painted)).toBe(painted);
  });

  it("bakes a panorama that is the sky radiance in the IBL's layout", () => {
    const sun = elevated(30);
    const pano = atmospherePanorama(LUTS, sun, WHITE, 32, 16);
    // Texel (x, y)'s direction: u around from −x, v down from the zenith.
    const x = 20, y = 5;
    const phi = (2 * Math.PI * (x + 0.5)) / 32 - Math.PI;
    const theta = (Math.PI * (y + 0.5)) / 16;
    const L = skyRadiance(LUTS, [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)], sun, WHITE);
    L.forEach((v, c) => expect(pano.data[(y * 32 + x) * 3 + c]).toBeCloseTo(v, 6));
  });

  it("maps the sky view both ways, the horizon at its middle row", () => {
    for (const [u, v] of [[0.1, 0.1], [0.6, 0.45], [0.9, 0.7], [0.3, 0.95]] as const) {
      const d = skyViewDirection(EARTH, u, v);
      const [u2, v2] = skyViewUv(EARTH, d, [1, 0.2, 0]);
      expect(u2).toBeCloseTo(u, 4);
      expect(v2).toBeCloseTo(v, 4);
    }
    // The geometric horizon, just below level for a viewer above the ground.
    const r = EARTH.bottom + EARTH.viewHeight;
    const dip = Math.PI / 2 - Math.acos(Math.sqrt(r * r - EARTH.bottom * EARTH.bottom) / r);
    expect(skyViewUv(EARTH, [Math.cos(dip), -Math.sin(dip), 0], [1, 0, 0])[1]).toBeCloseTo(0.5, 4);
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
  for (let i = 0; i < 40_000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  if (e === 31) return m ? NaN : s * Infinity;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

/** An rgba16float texture's texels as RGB floats. */
async function readHalfTexture(texture: any, width: number, height: number): Promise<Float32Array> {
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (let c = 0; c < 3; c += 1) out[(y * width + x) * 3 + c] = half(halves[(y * bytesPerRow) / 2 + x * 4 + c]!);
  return out;
}

/** The largest error between two RGB arrays, against the larger of a floor and the value's own size. */
function worst(gpu: Float32Array, cpu: Float32Array, floor: number): number {
  let w = 0;
  for (let i = 0; i < cpu.length; i += 1) w = Math.max(w, Math.abs(gpu[i]! - cpu[i]!) / Math.max(floor, Math.abs(cpu[i]!)));
  return w;
}

describe.skipIf(!device)("the atmosphere's LUTs on a real device", { timeout: 120_000 }, () => {
  it("builds the transmittance, multiple-scattering and sky-view LUTs the CPU does", async () => {
    const gpu = new GpuAtmosphere(device);
    const sun = elevated(20);
    device.pushErrorScope("validation");
    expect(gpu.update({ atmosphere: EARTH, sun, sunRadiance: WHITE })).toBe(true);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    // Unchanged, nothing is rebuilt.
    expect(gpu.update({ atmosphere: EARTH, sun, sunRadiance: WHITE })).toBe(false);

    const transmittance = await readHalfTexture(gpu.transmittance, TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT);
    expect(worst(transmittance, LUTS.transmittance.data, 0.01)).toBeLessThan(0.005);
    const ms = await readHalfTexture(gpu.multiScattering, MULTISCATTER_SIZE, MULTISCATTER_SIZE);
    const msPeak = Math.max(...LUTS.multiScattering.data);
    expect(worst(ms, LUTS.multiScattering.data, 0.01 * msPeak)).toBeLessThan(0.01);

    const view = await readHalfTexture(gpu.skyView, SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT);
    const cpu = new Float32Array(view.length);
    for (let y = 0; y < SKY_VIEW_HEIGHT; y += 1) {
      for (let x = 0; x < SKY_VIEW_WIDTH; x += 1) {
        const d = skyViewDirection(EARTH, (x + 0.5) / SKY_VIEW_WIDTH, (y + 0.5) / SKY_VIEW_HEIGHT);
        // The sun at azimuth 0, as the LUT puts it.
        cpu.set(skyRadiance(LUTS, d, [Math.cos((20 * Math.PI) / 180), Math.sin((20 * Math.PI) / 180), 0], WHITE), (y * SKY_VIEW_WIDTH + x) * 3);
      }
    }
    const peak = Math.max(...cpu);
    expect(worst(view, cpu, 0.01 * peak)).toBeLessThan(0.02);
    gpu.dispose();
  });
});

describe.skipIf(!device)("the AAA tier's physical backdrop, on a real device", { timeout: 120_000 }, () => {
  const W = 64;
  const H = 32;
  const view = viewMatrix([0, 1, 0], [0, 1 + Math.tan(0.6), -1]); // looking north, 34° up
  const projection = projectionMatrix(Math.PI / 3, W / H, 0.1, 100);
  /** The ray through pixel (x, y)'s centre, as the pass casts it. */
  const ray = (x: number, y: number): [number, number, number] => {
    const nx = ((x + 0.5) / W) * 2 - 1;
    const ny = 1 - ((y + 0.5) / H) * 2;
    const d = [0, 1, 2].map((a) => view[a * 4]! * (nx / projection[0]!) + view[a * 4 + 1]! * (ny / projection[5]!) - view[a * 4 + 2]!);
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return [d[0]! / l, d[1]! / l, d[2]! / l];
  };
  const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

  it("draws the sky the CPU works out, per pixel, with the sun's disc where the sun is", async () => {
    const presenter = new GpuPresenter(device, W, H, { hdr: true });
    const sun = ray(40, 12);
    const atmosphere = { atmosphere: EARTH, sun, sunRadiance: WHITE, disc: sunDiscRadiance(LUTS, sun, WHITE) };
    const map = { width: 4, height: 2, data: new Uint8ClampedArray(32).fill(255) };
    const out = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    device.pushErrorScope("validation");
    // Unmapped and encoded (the sky stays under 1 away from the sun).
    presenter.present({ base: { kind: "sky", sky: { map, view, projection, sun: null, clouds: [], time: 0, atmosphere } }, scene: null, tonemap: null } as any, out, "rgba8unorm");
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
    const at = (x: number, y: number, k: number) => bytes[y * bytesPerRow + x * 4 + k]! / 255;
    let worst = 0;
    for (const [x, y] of [[4, 4], [20, 8], [60, 20], [10, 28], [32, 16], [50, 2]] as const) {
      const L = skyRadiance(LUTS, ray(x, y), sun, WHITE);
      for (let k = 0; k < 3; k += 1) worst = Math.max(worst, Math.abs(at(x, y, k) - encode(Math.min(1, L[k]!))));
    }
    expect(worst).toBeLessThan(4 / 255);
    // Blue away from the sun; the disc itself past white.
    expect(at(4, 28, 2)).toBeGreaterThan(at(4, 28, 0) + 0.1);
    expect([0, 1, 2].map((k) => at(40, 12, k))).toEqual([1, 1, 1]);
    out.destroy();
    presenter.dispose();
  });
});

/** A physical-sky rig: a key light 25° up toward +x, at `intensity`. */
function physicalRig(intensity = 1): SceneLighting {
  return { ...defaultSceneLighting(), lights: [{ kind: "directional", direction: elevated(25), color: [1, 1, 1], intensity }], sky: { ...defaultProceduralSky(), atmosphere: {} } };
}

/** A floor 6 m square facing up. */
const FLOOR = {
  name: "floor",
  primitives: [
    {
      positions: Float32Array.from([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]),
      normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: null,
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      material: { name: "m", baseColorImage: null, baseColorFactor: [0.6, 0.6, 0.6, 1] },
    },
  ],
} as unknown as MeshAsset;

/** A panorama's irradiance over π on a floor facing up. */
function upIrradiance(pano: { width: number; height: number; data: Float32Array }): number[] {
  const out = [0, 0, 0];
  for (let y = 0; y < pano.height; y += 1) {
    const theta = (Math.PI * (y + 0.5)) / pano.height;
    if (theta >= Math.PI / 2) break;
    const w = (Math.cos(theta) * Math.sin(theta) * (Math.PI / pano.height) * ((2 * Math.PI) / pano.width)) / Math.PI;
    for (let x = 0; x < pano.width; x += 1) for (let c = 0; c < 3; c += 1) out[c]! += pano.data[(y * pano.width + x) * 4 + c]! * w;
  }
  return out;
}

describe("the scene under a physical sky", () => {
  it("lights by the atmosphere's own HDR light, and paints its 8-bit copy blue", async () => {
    let sidecar = { ...emptyMeshSidecar(), lighting: physicalRig(1.5) } as ReturnType<typeof emptyMeshSidecar>;
    sidecar = addMesh(sidecar, FLOOR, "floor").sidecar;
    const scene = parseMeshScene(encodeMeshSidecar(sidecar)!)!;
    const env = (await sceneSkyEnvironment(scene))!;
    expect(env.hdr).toBeTruthy();
    // Its zenith texel is the sky's radiance there, under the key light's 1.5 above the air.
    const hdr = env.hdr!;
    const y = 2, x = 7;
    const theta = (Math.PI * (y + 0.5)) / hdr.height;
    const phi = (2 * Math.PI * (x + 0.5)) / hdr.width - Math.PI;
    const L = skyRadiance(LUTS, [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)], elevated(25), [1.5, 1.5, 1.5]);
    L.forEach((v, c) => expect(hdr.data[(y * hdr.width + x) * 3 + c]! / v).toBeCloseTo(1, 1));
    // The painted copy (every other tier's backdrop) is blue overhead.
    const map = env.map!;
    const top = (2 * map.width + 10) * 4;
    expect(map.data[top + 2]!).toBeGreaterThan(map.data[top]! + 20);
  });
});

describe("the player under a physical sky", () => {
  it("hands the presenter the atmosphere and its sun, and lights the scene by the key light through the air", async () => {
    const lighting = { ...physicalRig(1.2), lights: [{ kind: "directional" as const, direction: elevated(4), color: [1, 1, 1] as [number, number, number], intensity: 1.2 }] };
    const draws: GpuSceneDraw[] = [];
    const renderer: SceneRenderer = { backend: "webgpu", draws, render: () => {}, renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} } as unknown as SceneRenderer;
    const frames: PresentFrame[] = [];
    const presenter = { present: (frame: PresentFrame) => frames.push(frame), stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
    const scene = { instances: [{ mesh: FLOOR, model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], bounds: { min: [-3, 0, -3], max: [3, 1, 3], center: [0, 0.5, 0], radius: 4.5 }, lighting } as never;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, renderer, { presenter } as never);
    surface.setHudMode(true);
    surface.blit(new Uint8Array(32 * 24 * 4));
    const frame = frames.at(-1)!;
    expect(frame.base.kind).toBe("sky");
    const sky = (frame.base as { sky: { atmosphere: { sun: number[]; sunRadiance: number[]; disc: number[] } } }).sky;
    expect(sky.atmosphere.sun[1]).toBeCloseTo(Math.sin((4 * Math.PI) / 180), 6);
    // Above the air, the key light's own 1.2; the disc through it.
    expect(sky.atmosphere.sunRadiance).toEqual([1.2, 1.2, 1.2]);
    expect(sky.atmosphere.disc).toEqual(sunDiscRadiance(LUTS, sky.atmosphere.sun, [1.2, 1.2, 1.2]));
    // The renderer lights by the key light through the air (orange so low), and by the atmosphere's own light.
    const draw = draws.at(-1)!;
    const key = draw.lights!.find((l) => l.kind === "directional")!;
    expect(key.color[0]).toBeGreaterThan(key.color[2] + 0.3);
    expect(draw.environment?.hdr).toBeTruthy();
  });
});

describe.skipIf(!device)("the GPU bake under a physical sky", { timeout: 300_000 }, () => {
  it("lights an open floor by the atmosphere's sky, not the rig's gradient", async () => {
    let sidecar = { ...emptyMeshSidecar(), lighting: physicalRig() } as ReturnType<typeof emptyMeshSidecar>;
    sidecar = addMesh(sidecar, FLOOR, "floor").sidecar;
    const env = (await sceneSkyEnvironment(parseMeshScene(encodeMeshSidecar(sidecar)!)!))!;
    const sky = upIrradiance(environmentPanorama(env));
    const baked = await settled(bakeSceneLighting(sidecar, { density: 2, rays: 64, bounces: 1, probeSpacing: 0, device }));
    const prim = deserializeMeshAsset(baked.meshes[0]!.mesh).primitives[0]!;
    const map = await decodeHdrLightmap(prim.material.lightmapHdrImage!.bytes);
    const uv = [0, 1].map((a) => (prim.uvs2![a]! + prim.uvs2![4 + a]!) / 2);
    const i = (Math.floor((1 - uv[1]!) * map.height) * map.width + Math.floor(uv[0]! * map.width)) * 3;
    for (let c = 0; c < 3; c += 1) {
      expect(map.irradiance[i + c]! / sky[c]!).toBeGreaterThan(0.95);
      expect(map.irradiance[i + c]! / sky[c]!).toBeLessThan(1.05);
    }
    // A physical clear sky's light is blue.
    expect(map.irradiance[i + 2]!).toBeGreaterThan(1.5 * map.irradiance[i]!);
  });
});

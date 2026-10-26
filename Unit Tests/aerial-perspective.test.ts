/**
 * Aerial perspective and the time of day under a physical sky
 * (AAA_FIDELITY_ROADMAP.md F5a-2): the froxel volume's CPU reference held to
 * what can be worked out by hand and to the sky it must meet, the GPU's volume
 * held to the CPU froxel by froxel, the AAA scene shader laying it over a
 * surface as the CPU says, and a moving sun re-lighting the environment.
 */

import { describe, expect, it } from "vitest";

import {
  AERIAL_RANGE,
  AERIAL_SIZE,
  AERIAL_SLICES,
  aerialCamera,
  aerialColumn,
  aerialDirection,
  aerialDistance,
  aerialSlice,
  atmosphereLuts,
  bakeAerialPerspective,
  composeModelMatrix,
  defaultProceduralSky,
  defaultSceneLighting,
  mediumAt,
  multiScatteringAt,
  miePhase,
  parseAtmosphere,
  parseSky,
  projectionMatrix,
  rayleighPhase,
  resolveAtmosphere,
  sampleAerialPerspective,
  skyRadiance,
  transmittanceTo,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneLighting,
} from "@cartbox/editor";
import { MeshOverlaySurface, WebgpuSceneRenderer, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import { AERIAL_LUT_BYTES, GpuAtmosphere, packAerialFrame, type AtmosphereSky } from "../packages/player/src/render/atmosphere";

const EARTH = resolveAtmosphere({});
const LUTS = atmosphereLuts(EARTH);
const elevated = (degrees: number, azimuth = 0): [number, number, number] => {
  const e = (degrees * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
};
const WHITE: [number, number, number] = [1, 1, 1];
const SUN = elevated(30, 40);

/** The slice whose centre is nearest `t` km. */
const sliceAt = (t: number) => Math.round(aerialSlice(t) * AERIAL_SLICES - 0.5);

describe("aerial perspective's settings", () => {
  it("is on at Earth's scale by default, read in range and kept through a save", () => {
    expect(EARTH.aerialScale).toBe(1);
    expect(parseAtmosphere({ aerialScale: 400 })).toEqual({ aerialScale: 100 });
    expect(parseAtmosphere({ aerialScale: -1 })).toEqual({ aerialScale: 0 });
    expect(resolveAtmosphere({ aerialScale: 0 }).aerialScale).toBe(0);
    const sky = parseSky(JSON.parse(JSON.stringify({ ...defaultProceduralSky(), atmosphere: { aerialScale: 12 } })));
    expect(sky?.atmosphere).toEqual({ aerialScale: 12 });
  });

  it("spaces its slices quadratically out to the range, and maps distances back", () => {
    expect(aerialDistance(1)).toBe(AERIAL_RANGE);
    expect(aerialDistance(0.5)).toBe(AERIAL_RANGE / 4);
    for (const w of [0, 0.1, 0.37, 0.9, 1]) expect(aerialSlice(aerialDistance(w))).toBeCloseTo(w, 12);
    expect(aerialSlice(AERIAL_RANGE * 9)).toBe(1);
    // The first slice's centre is a few metres out: the near air gets the slices.
    expect(aerialDistance(0.5 / AERIAL_SLICES) * 1000).toBeLessThan(10);
  });

  it("aims each froxel column along the camera ray through its screen point", () => {
    const view = viewMatrix([0, 2, 0], [10, 2, 0]);
    const camera = aerialCamera(view, projectionMatrix(Math.PI / 2, 1, 0.1, 1000));
    expect(aerialDirection(camera, 0.5, 0.5).map((v) => +v.toFixed(9))).toEqual([1, 0, 0]);
    // A 90° frustum's top-right corner, 45° both ways off the axis (y down the screen).
    const corner = aerialDirection(camera, 1, 0);
    expect(corner[1]).toBeCloseTo(1 / Math.sqrt(3), 9);
    expect(corner[0]).toBeCloseTo(1 / Math.sqrt(3), 9);
  });
});

describe("the CPU's froxel columns", () => {
  const level = elevated(0, 90);

  it("passes light through a short level stretch as the air at the eye's height absorbs it", () => {
    const column = aerialColumn(LUTS, level, SUN, WHITE);
    const ext = mediumAt(EARTH, EARTH.viewHeight).extinction;
    for (const t of [0.05, 0.3, 1]) {
      const z = sliceAt(t);
      const d = aerialDistance((z + 0.5) / AERIAL_SLICES);
      for (let c = 0; c < 3; c += 1) expect(column.transmittance[z]![c]! / Math.exp(-ext[c]! * d)).toBeCloseTo(1, 3);
    }
  });

  it("gathers what a uniform slab of that air scatters toward the eye, in closed form", () => {
    const column = aerialColumn(LUTS, level, SUN, WHITE);
    const r = EARTH.bottom + EARTH.viewHeight;
    const m = mediumAt(EARTH, EARTH.viewHeight);
    const cos = level[0] * SUN[0] + level[1] * SUN[1] + level[2] * SUN[2];
    const ts = transmittanceTo(EARTH, LUTS.transmittance, r, SUN[1]);
    const ms = multiScatteringAt(EARTH, LUTS.multiScattering, EARTH.viewHeight, SUN[1]);
    const z = sliceAt(0.5);
    const d = aerialDistance((z + 0.5) / AERIAL_SLICES);
    for (let c = 0; c < 3; c += 1) {
      const S = Math.PI * ((m.rayleigh[c]! * rayleighPhase(cos) + m.mie * miePhase(cos, EARTH.mieG)) * ts[c]! + ms[c]! * (m.rayleigh[c]! + m.mie));
      const want = (S / m.extinction[c]!) * (1 - Math.exp(-m.extinction[c]! * d));
      expect(column.inscatter[z]![c]! / want).toBeCloseTo(1, 1);
    }
  });

  it("thickens with distance, and meets the sky overhead once it has passed most of the air", () => {
    const up = aerialColumn(LUTS, [0, 1, 0], SUN, WHITE);
    for (let z = 1; z < AERIAL_SLICES; z += 1) {
      for (let c = 0; c < 3; c += 1) {
        expect(up.inscatter[z]![c]!).toBeGreaterThanOrEqual(up.inscatter[z - 1]![c]!);
        expect(up.transmittance[z]![c]!).toBeLessThanOrEqual(up.transmittance[z - 1]![c]!);
      }
    }
    // 32 km up is past 98% of the Rayleigh column: the volume's far end is all but the zenith's sky.
    const sky = skyRadiance(LUTS, [0, 1, 0], SUN, WHITE);
    for (let c = 0; c < 3; c += 1) {
      expect(up.inscatter[AERIAL_SLICES - 1]![c]! / sky[c]!).toBeGreaterThan(0.9);
      expect(up.inscatter[AERIAL_SLICES - 1]![c]! / sky[c]!).toBeLessThan(1.02);
    }
    // Blue scatters most: distant things go blue, then (through more air) the haze whitens.
    const far = aerialColumn(LUTS, level, SUN, WHITE).inscatter[sliceAt(5)]!;
    expect(far[2]).toBeGreaterThan(far[0] * 1.5);
  });

  it("hazes more with more aerosol, and goes dark once the sun has set", () => {
    const hazy = atmosphereLuts(resolveAtmosphere({ mie: 10 }));
    const z = sliceAt(2);
    const clear = aerialColumn(LUTS, elevated(0, 90), SUN, WHITE);
    const murky = aerialColumn(hazy, elevated(0, 90), SUN, WHITE);
    expect(murky.transmittance[z]![1]!).toBeLessThan(clear.transmittance[z]![1]! - 0.05);
    const night = aerialColumn(LUTS, elevated(0, 90), elevated(-12), WHITE).inscatter[z]!;
    const day = clear.inscatter[z]!;
    for (let c = 0; c < 3; c += 1) expect(night[c]!).toBeLessThan(day[c]! * 0.02);
  });
});

describe("the volume as the scene samples it", () => {
  const view = viewMatrix([0, 2, 0], [10, 2, 3]);
  const projection = projectionMatrix(Math.PI / 3, 4 / 3, 0.1, 5000);
  const camera = aerialCamera(view, projection);
  const lut = bakeAerialPerspective(LUTS, camera, SUN, WHITE);

  it("lays its froxels out x first, then down the screen, then out along the slices", () => {
    expect(lut.length).toBe(AERIAL_SIZE * AERIAL_SIZE * AERIAL_SLICES * 4);
    const [x, y, z] = [3, 11, 17];
    const column = aerialColumn(LUTS, aerialDirection(camera, (x + 0.5) / AERIAL_SIZE, (y + 0.5) / AERIAL_SIZE), SUN, WHITE);
    const i = ((z * AERIAL_SIZE + y) * AERIAL_SIZE + x) * 4;
    expect(Array.from(lut.subarray(i, i + 3))).toEqual(column.inscatter[z]!.map(Math.fround));
    const T = column.transmittance[z]!;
    expect(lut[i + 3]).toBeCloseTo((T[0] + T[1] + T[2]) / 3, 6);
  });

  it("reads a froxel's centre as it is, and fades to clear air at the eye", () => {
    const [x, y, z] = [5, 8, 20];
    const t = aerialDistance((z + 0.5) / AERIAL_SLICES);
    const got = sampleAerialPerspective(lut, (x + 0.5) / AERIAL_SIZE, (y + 0.5) / AERIAL_SIZE, t);
    const i = ((z * AERIAL_SIZE + y) * AERIAL_SIZE + x) * 4;
    got.inscatter.forEach((v, c) => expect(v).toBeCloseTo(lut[i + c]!, 6));
    expect(got.transmittance).toBeCloseTo(lut[i + 3]!, 6);
    const eye = sampleAerialPerspective(lut, 0.5, 0.5, 0);
    expect(eye).toEqual({ inscatter: [0, 0, 0], transmittance: 1 });
    // Halfway to the first slice's centre, half its air.
    const first = aerialDistance(0.5 / AERIAL_SLICES);
    const half = sampleAerialPerspective(lut, (x + 0.5) / AERIAL_SIZE, (y + 0.5) / AERIAL_SIZE, first / 2);
    const j = (y * AERIAL_SIZE + x) * 4;
    expect(half.inscatter[2]).toBeCloseTo(lut[j + 2]! / 2, 7);
    expect(half.transmittance).toBeCloseTo(1 - (1 - lut[j + 3]!) / 2, 7);
  });

  it("hands the shader the eye, the camera's axes and focal terms, and the km a metre counts for, or nothing", () => {
    const sky: AtmosphereSky = { atmosphere: resolveAtmosphere({ aerialScale: 8 }), sun: SUN, sunRadiance: WHITE };
    const terms = packAerialFrame(sky, view, projection);
    expect(Array.from(terms.subarray(0, 4)).map((v) => +v.toFixed(5))).toEqual([0, 2, 0, 1]);
    expect(terms[7]).toBeCloseTo(projection[0]!, 6);
    expect(terms[11]).toBeCloseTo(projection[5]!, 6);
    expect(terms[15]).toBeCloseTo(0.008, 9);
    expect(Array.from(packAerialFrame(null, view, projection))).toEqual(new Array(16).fill(0));
    expect(packAerialFrame({ ...sky, atmosphere: resolveAtmosphere({ aerialScale: 0 }) }, view, projection)[3]).toBe(0);
    const ortho = Float64Array.from([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1]);
    expect(packAerialFrame(sky, view, ortho as never)[3]).toBe(0);
  });
});

/** A physical rig: a key light toward `sun` above the air, and Earth's air hazing at `aerialScale`. */
function physicalRig(sun: [number, number, number], intensity = 1, aerialScale = 1): SceneLighting {
  return { ...defaultSceneLighting(), ambient: 0, lights: [{ kind: "directional", direction: sun, color: [1, 1, 1], intensity }], sky: { ...defaultProceduralSky(), atmosphere: { aerialScale } } };
}

const FLOOR = {
  name: "floor",
  primitives: [
    {
      positions: Float32Array.from([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]),
      normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: null,
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
    },
  ],
} as unknown as MeshAsset;

describe("the player under a physical sky, as the day goes on", () => {
  it("hands the AAA scene the air, and re-lights the environment for a sun that has moved, whole, a row a frame", async () => {
    const draws: GpuSceneDraw[] = [];
    const renderer: SceneRenderer = { backend: "webgpu", draws, render: () => {}, renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} } as unknown as SceneRenderer;
    const presenter = { present: (_frame: PresentFrame) => undefined, stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
    const scene = { instances: [{ mesh: FLOOR, model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], bounds: { min: [-3, 0, -3], max: [3, 1, 3], center: [0, 0.5, 0], radius: 4.5 }, lighting: physicalRig(elevated(40), 1, 6) } as never;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, renderer, { presenter } as never);
    surface.setHudMode(true);
    surface.blit(new Uint8Array(32 * 24 * 4));
    const first = draws.at(-1)!;
    expect(first.atmosphere?.atmosphere.aerialScale).toBe(6);
    expect(first.atmosphere?.sun[1]).toBeCloseTo(Math.sin((40 * Math.PI) / 180), 6);
    const noon = first.environment!.hdr!;
    // The rig's own sun: nothing to re-light.
    for (let i = 0; i < 5; i += 1) surface.blit(new Uint8Array(32 * 24 * 4));
    expect(draws.at(-1)!.environment!.hdr).toBe(noon);
    // The cart lowers the sun toward the horizon (cartbox.sun3d).
    surface.setCartLights([{ position: elevated(6, 30), range: 0, color: [1, 0.9, 0.8], sun: true }]);
    surface.blit(new Uint8Array(32 * 24 * 4));
    const sunset = draws.at(-1)!.atmosphere!;
    expect(sunset.sun[1]).toBeCloseTo(Math.sin((6 * Math.PI) / 180), 3);
    // Until every row is drawn, the old light stays; then the new one goes in whole.
    for (let i = 0; i < 40; i += 1) surface.blit(new Uint8Array(32 * 24 * 4));
    expect(draws.at(-1)!.environment!.hdr).toBe(noon);
    for (let i = 0; i < 10; i += 1) surface.blit(new Uint8Array(32 * 24 * 4));
    const env = draws.at(-1)!.environment!;
    expect(env.hdr).not.toBe(noon);
    const hdr = env.hdr!;
    expect([hdr.width, hdr.height]).toEqual([noon.width, noon.height]);
    // It is the sky for the sun where it now stands: a texel halfway up, toward the sun and away from it.
    for (const x of [Math.round(hdr.width * 0.58), Math.round(hdr.width * 0.08)]) {
      const y = Math.round(hdr.height / 4);
      const theta = (Math.PI * (y + 0.5)) / hdr.height;
      const phi = (2 * Math.PI * (x + 0.5)) / hdr.width - Math.PI;
      const L = skyRadiance(LUTS, [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)], sunset.sun, sunset.sunRadiance);
      L.forEach((v, c) => expect(hdr.data[(y * hdr.width + x) * 3 + c]! / v).toBeCloseTo(1, 1));
    }
    // Lower, the sun leaves the sky dimmer than at 40°, and the other tiers' copy follows.
    const mean = (data: Float32Array) => data.reduce((a, v) => a + v, 0) / data.length;
    expect(mean(hdr.data)).toBeLessThan(mean(noon.data) * 0.7);
    expect(env.map).not.toBe(first.environment!.map);
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

async function readBuffer(source: any, size: number): Promise<ArrayBuffer> {
  const buffer = device.createBuffer({ size, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, buffer, 0, size);
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const out = buffer.getMappedRange().slice(0);
  buffer.unmap();
  buffer.destroy();
  return out;
}

describe.skipIf(!device)("aerial perspective on a real device", { timeout: 120_000 }, () => {
  it("builds the CPU's froxels in compute, within half floats", async () => {
    const sky: AtmosphereSky = { atmosphere: resolveAtmosphere({ mie: 3 }), sun: elevated(12, -30), sunRadiance: [2, 1.8, 1.6] };
    const camera = aerialCamera(viewMatrix([0, 5, 0], [10, 3, 4]), projectionMatrix(Math.PI / 3, 16 / 9, 0.1, 5000));
    const want = bakeAerialPerspective(atmosphereLuts(sky.atmosphere), camera, sky.sun, sky.sunRadiance);
    const target = device.createBuffer({ size: AERIAL_LUT_BYTES, usage: 0x80 | 0x04 }); // STORAGE | COPY_SRC
    const gpu = new GpuAtmosphere(device);
    device.pushErrorScope("validation");
    gpu.aerial(sky, camera, target);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const halves = new Uint16Array(await readBuffer(target, AERIAL_LUT_BYTES));
    let peak = 0;
    for (let i = 0; i < want.length; i += 4) peak = Math.max(peak, want[i]!, want[i + 1]!, want[i + 2]!);
    let worst = 0;
    for (let i = 0; i < want.length; i += 1) {
      const got = half(halves[i]!);
      // In-scattered light to 1% of itself (or of a hundredth of the brightest), transmittance to 0.002.
      const allowed = i % 4 === 3 ? 0.002 : Math.max(0.01 * want[i]!, 1e-4 * peak);
      worst = Math.max(worst, Math.abs(got - want[i]!) / allowed);
    }
    expect(worst).toBeLessThan(1);
    target.destroy();
    gpu.dispose();
  });

  const W = 40;
  const H = 30;
  const EYE: [number, number, number] = [0, 2, 0];

  /** The linear colour at the frame's centre: a grey wall 300 m off, lit by a low sun, with the air between or without. */
  async function centre(atmosphere: AtmosphereSky | null): Promise<number[]> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const wall: MeshAsset = { ...FLOOR, primitives: [{ ...FLOOR.primitives[0]!, normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]) }] };
    const instances: MeshSceneInstance[] = [{ mesh: wall, model: composeModelMatrix([0, 2, -300], [0, 0, 0], [120, 120, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix(EYE, [0, 2, -10]),
      projection: projectionMatrix(Math.PI / 3, W / H, 0.5, 2000),
      ambient: 0,
      lightDirection: elevated(20, 90),
      environment: null,
      lights: [{ kind: "directional", direction: elevated(20, 90), color: [1, 1, 1], intensity: 1 }],
      atmosphere,
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
    const at = ((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4;
    return [0, 1, 2].map((c) => half(halves[at + c]!));
  }

  it("lays the air over a distant wall as the CPU's volume says, and leaves it alone without a sky", async () => {
    const sky: AtmosphereSky = { atmosphere: resolveAtmosphere({ aerialScale: 10 }), sun: elevated(20, 90), sunRadiance: [1, 1, 1] };
    const bare = await centre(null);
    const hazed = await centre(sky);
    const off = await centre({ ...sky, atmosphere: resolveAtmosphere({ aerialScale: 0 }) });
    expect(off).toEqual(bare);
    // Where the centre pixel's ray meets the wall, and the air the CPU puts there (3 km of it at ×10).
    const view = viewMatrix(EYE, [0, 2, -10]);
    const projection = projectionMatrix(Math.PI / 3, W / H, 0.5, 2000);
    const u = ((W >> 1) + 0.5) / W;
    const v = ((H >> 1) + 0.5) / H;
    const camera = aerialCamera(view, projection);
    const d = aerialDirection(camera, u, v);
    const distance = 300 / -d[2];
    const lut = bakeAerialPerspective(LUTS, camera, sky.sun, sky.sunRadiance);
    const air = sampleAerialPerspective(lut, u, v, distance * 0.001 * 10);
    expect(air.transmittance).toBeLessThan(0.95);
    for (let c = 0; c < 3; c += 1) {
      const want = bare[c]! * air.transmittance + air.inscatter[c]!;
      expect(Math.abs(hazed[c]! - want) / want).toBeLessThan(0.02);
    }
    // The haze is blue against the grey wall.
    expect(hazed[2]! - bare[2]!).toBeGreaterThan(hazed[0]! - bare[0]!);
  });
});

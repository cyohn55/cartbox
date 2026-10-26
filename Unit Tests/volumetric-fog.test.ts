/**
 * Volumetric fog (AAA_FIDELITY_ROADMAP.md F5b): the CPU reference held to
 * closed forms, the GPU's froxels held to the CPU's, the fog laid over a
 * surface as the CPU says, its history converging on the same light, and the
 * sun's shadow carving shafts through it.
 */

import { describe, expect, it } from "vitest";

import {
  FOG_SLICES,
  aerialCamera,
  aerialDirection,
  bakeFogVolume,
  composeModelMatrix,
  defaultSceneLighting,
  fogColumn,
  fogExtinction,
  fogGrid,
  fogSliceDistance,
  fogSun,
  henyeyGreenstein,
  parseSceneLighting,
  parseVolumetricFog,
  projectionMatrix,
  resolveVolumetricFog,
  sampleFogVolume,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneFog,
  type SceneLight,
} from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { fogJitter, packFogFrame } from "../packages/player/src/render/volumetricFog";

const FOG: SceneFog = { color: [0.7, 0.75, 0.8], density: 0.02, start: 10, max: 0.5, volumetric: { albedo: [1, 1, 1], anisotropy: 0.5, distance: 60 } };
const elevated = (degrees: number, azimuth = 0): [number, number, number] => {
  const e = (degrees * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
};

describe("volumetric fog's settings and medium", () => {
  it("reads its settings in range, keeps them through a save, and resolves its defaults", () => {
    expect(parseVolumetricFog({ anisotropy: 2, distance: 5, ambient: -1, albedo: [2, 0.5, -1] })).toEqual({ albedo: [1, 0.5, 0], anisotropy: 0.95, distance: 8, ambient: 0 });
    expect(parseVolumetricFog(null)).toBeNull();
    const rig = parseSceneLighting(JSON.parse(JSON.stringify({ ...defaultSceneLighting(), fog: FOG })))!;
    expect(rig.fog?.volumetric).toEqual(FOG.volumetric);
    expect(parseSceneLighting(JSON.parse(JSON.stringify({ ...defaultSceneLighting(), fog: { ...FOG, volumetric: undefined } })))!.fog?.volumetric).toBeUndefined();
    const v = resolveVolumetricFog({ ...FOG, volumetric: {} })!;
    expect(v).toMatchObject({ albedo: [1, 1, 1], anisotropy: 0.6, distance: 96, ambient: 1 });
    expect(resolveVolumetricFog({ ...FOG, volumetric: null })).toBeNull();
    expect(resolveVolumetricFog(null)).toBeNull();
  });

  it("is the distance fog everywhere, the height fog thinning above its base, and each box's own", () => {
    const fog: SceneFog = { ...FOG, height: { base: 2, density: 0.5, falloff: 1 }, volumes: [{ min: [10, 0, -5], max: [20, 8, 5], density: 0.3, falloff: 0.5 }] };
    expect(fogExtinction(fog, [0, 1, 0])).toBeCloseTo(0.02 + 0.5, 12);
    expect(fogExtinction(fog, [0, 4, 0])).toBeCloseTo(0.02 + 0.5 * Math.exp(-2), 12);
    expect(fogExtinction(fog, [15, 4, 0])).toBeCloseTo(0.02 + 0.5 * Math.exp(-2) + 0.3 * Math.exp(-2), 12);
    expect(fogExtinction(fog, [25, 4, 0])).toBeCloseTo(0.02 + 0.5 * Math.exp(-2), 12);
  });

  it("scatters by Henyey–Greenstein's phase, which integrates to one and is even at g = 0", () => {
    for (const g of [0, 0.5, 0.9, -0.4]) {
      let sum = 0;
      const n = 4000;
      for (let i = 0; i < n; i += 1) {
        const c = -1 + (2 * (i + 0.5)) / n;
        sum += henyeyGreenstein(c, g) * 2 * Math.PI * (2 / n);
      }
      expect(sum).toBeCloseTo(1, 3);
    }
    expect(henyeyGreenstein(0.3, 0)).toBeCloseTo(1 / (4 * Math.PI), 12);
    expect(henyeyGreenstein(1, 0.6)).toBeGreaterThan(henyeyGreenstein(-1, 0.6) * 10);
  });

  it("lays a column every twelve pixels, at least eight and at most 160 by 90, and 64 slices", () => {
    expect(fogGrid(1920, 1080)).toEqual([160, 90, 64]);
    expect(fogGrid(1280, 720)).toEqual([107, 60, 64]);
    expect(fogGrid(40, 30)).toEqual([8, 8, 64]);
  });
});

describe("the CPU's columns", () => {
  const v = resolveVolumetricFog(FOG)!;

  it("in an even fog lit by the sky alone, are the closed form: L = albedo × sky × (1 − T), T = e^(−σt)", () => {
    const sky = [0.4, 0.5, 0.7];
    const column = fogColumn(v, { sun: null, sky }, [0, 2, 0], [0, 0, -1]);
    for (const z of [0, 10, 40, FOG_SLICES - 1]) {
      const t = fogSliceDistance((z + 0.5) / FOG_SLICES, 60);
      expect(column.transmittance[z]).toBeCloseTo(Math.exp(-0.02 * t), 6);
      for (let c = 0; c < 3; c += 1) expect(column.inscatter[z]![c]).toBeCloseTo(sky[c]! * (1 - Math.exp(-0.02 * t)), 6);
    }
  });

  it("glows toward the sun, and only by the sky where the sun is shadowed", () => {
    const sun = { direction: elevated(10, -90), radiance: [1, 1, 1] };
    const toward = fogColumn(v, { sun, sky: [0, 0, 0] }, [0, 2, 0], elevated(10, -90)).inscatter[40]!;
    const away = fogColumn(v, { sun, sky: [0, 0, 0] }, [0, 2, 0], elevated(-10, 90)).inscatter[40]!;
    expect(toward[0]).toBeGreaterThan(away[0] * 10);
    const dark = fogColumn(v, { sun, sky: [0.1, 0.1, 0.1], shadow: () => 0 }, [0, 2, 0], elevated(10, -90)).inscatter[40]!;
    const skyOnly = fogColumn(v, { sun: null, sky: [0.1, 0.1, 0.1] }, [0, 2, 0], elevated(10, -90)).inscatter[40]!;
    expect(dark).toEqual(skyOnly);
  });

  it("finds the key light, in linear light", () => {
    const lights: SceneLight[] = [{ kind: "point", position: [0, 0, 0], color: [1, 1, 1], intensity: 1 }, { kind: "directional", direction: [0, 2, 0], color: [0.5, 1, 1], intensity: 3 }];
    const sun = fogSun(lights)!;
    expect(sun.direction).toEqual([0, 1, 0]);
    expect(sun.radiance[0]).toBeCloseTo(0.214 * 3, 2);
    expect(fogSun([lights[0]!])).toBeNull();
  });
});

describe("the frame's fog terms", () => {
  it("hand the shader the eye, the camera's axes, focal terms and reach, or nothing", () => {
    expect(Array.from(packFogFrame(null))).toEqual(new Array(16).fill(0));
    const view = viewMatrix([1, 2, 3], [1, 2, -10]);
    const projection = projectionMatrix(Math.PI / 3, 1.5, 0.1, 100);
    const terms = packFogFrame({ fog: resolveVolumetricFog(FOG)!, light: { sun: null, sky: [0, 0, 0] }, grid: [8, 8, 64], camera: { camera: aerialCamera(view, projection), eye: [1, 2, 3] }, previous: null, jitter: [0, 0, 0], cascades: null });
    expect(Array.from(terms.subarray(0, 4))).toEqual([1, 2, 3, 1]);
    expect(terms[7]).toBeCloseTo(projection[0]!, 6);
    expect(terms[15]).toBe(60);
  });

  it("jitters a temporal frame's samples within their froxels, evenly", () => {
    const seen = Array.from({ length: 64 }, (_, i) => fogJitter(i));
    for (const j of seen) for (const c of j) expect(Math.abs(c)).toBeLessThanOrEqual(0.5);
    const mean = [0, 1, 2].map((c) => seen.reduce((a, j) => a + j[c]!, 0) / seen.length);
    for (const m of mean) expect(Math.abs(m)).toBeLessThan(0.02);
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

/** A quad facing +z, `size` across. */
function wall(): MeshAsset {
  return {
    name: "wall",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  } as unknown as MeshAsset;
}

/** A quad facing −y (a roof), two units across before scaling. */
function roof(): MeshAsset {
  const m = wall();
  return { ...m, primitives: [{ ...m.primitives[0]!, positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), normals: Float32Array.from([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]) }] } as unknown as MeshAsset;
}

const W = 48;
const H = 32;
const EYE: [number, number, number] = [0, 2, 0];
const VIEW = viewMatrix(EYE, [0, 2, -10]);
const PROJECTION = projectionMatrix(Math.PI / 3, W / H, 0.1, 200);
const SUN = elevated(25, -70);
const LIGHTS: SceneLight[] = [{ kind: "directional", direction: SUN, color: [1, 1, 1], intensity: 1 }];

async function readTexture(texture: any, width: number, height: number, depth: number): Promise<Float32Array> {
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height * depth, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: depth });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const out = new Float32Array(width * height * depth * 4);
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < 4; c += 1) out[((z * height + y) * width + x) * 4 + c] = half(halves[((z * height + y) * bytesPerRow) / 2 + x * 4 + c]!);
      }
    }
  }
  return out;
}

describe.skipIf(!device)("volumetric fog on a real device", { timeout: 240_000 }, () => {
  /** Render `frames` frames of `instances` in `fog`; the frame's centre (linear), and the fog's volume. */
  async function render(instances: MeshSceneInstance[], fog: SceneFog | null, options: { frames?: number; temporal?: boolean; sunShadow?: object } = {}) {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    device.pushErrorScope("validation");
    let texture: any = null;
    for (let f = 0; f < (options.frames ?? 1); f += 1) {
      texture = renderer.renderToTexture!(instances, {
        width: W,
        height: H,
        view: VIEW,
        projection: PROJECTION,
        ambient: 0,
        lightDirection: SUN,
        environment: null,
        lights: LIGHTS,
        fog,
        temporal: options.temporal ?? false,
        ...(options.sunShadow ? { sunShadow: options.sunShadow } : {}),
      } as any);
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const frame = await readTexture(texture, W, H, 1);
    const fogState = (renderer as any).volumetricFog;
    const grid = fogGrid(W, H);
    const volume = fogState ? await readTexture(fogState.volume, grid[0], grid[1], grid[2]) : null;
    renderer.dispose();
    const at = ((H >> 1) * W + (W >> 1)) * 4;
    return { centre: [frame[at]!, frame[at + 1]!, frame[at + 2]!], volume, frame };
  }

  const grid = fogGrid(W, H);
  const camera = aerialCamera(VIEW, PROJECTION);
  // Something to draw (a frame with nothing in it draws nothing): a speck behind the eye.
  const speck: MeshSceneInstance = { mesh: wall(), model: composeModelMatrix([0, 2, 5], [0, 0, 0], [0.01, 0.01, 1]) };
  const sunLight = { sun: fogSun(LIGHTS), sky: [0, 0, 0] };

  it("builds the CPU's froxels, within half floats", async () => {
    const fog: SceneFog = { ...FOG, height: { base: 1, density: 0.2, falloff: 0.4 }, volumes: [{ min: [-8, 0, -30], max: [0, 6, -10], density: 0.15, falloff: 0.3 }] };
    const { volume } = await render([speck], fog);
    const want = bakeFogVolume(resolveVolumetricFog(fog)!, sunLight, camera, EYE, grid);
    let peak = 0;
    for (let i = 0; i < want.length; i += 4) peak = Math.max(peak, want[i]!);
    let worst = 0;
    for (let i = 0; i < want.length; i += 1) {
      const allowed = i % 4 === 3 ? 0.003 : Math.max(0.01 * Math.abs(want[i]!), 2e-3 * peak);
      worst = Math.max(worst, Math.abs(volume![i]! - want[i]!) / allowed);
    }
    expect(worst).toBeLessThan(1);
  });

  it("lays the fog over a wall as the CPU's volume says, in place of the painted fade", async () => {
    const instances: MeshSceneInstance[] = [{ mesh: wall(), model: composeModelMatrix([0, 2, -40], [0, 0, 0], [40, 40, 1]) }];
    const bare = (await render(instances, null)).centre;
    const misted = (await render(instances, FOG)).centre;
    // The painted fade gives way: a volumetric fog with no medium leaves the wall as it is.
    const clear = (await render(instances, { ...FOG, density: 0 })).centre;
    clear.forEach((v, c) => expect(v).toBeCloseTo(bare[c]!, 3));
    const u = ((W >> 1) + 0.5) / W;
    const v = ((H >> 1) + 0.5) / H;
    const d = aerialDirection(camera, u, v);
    const t = 40 / -d[2];
    const air = sampleFogVolume(bakeFogVolume(resolveVolumetricFog(FOG)!, sunLight, camera, EYE, grid), grid, 60, u, v, t);
    expect(air.transmittance).toBeLessThan(0.6);
    for (let c = 0; c < 3; c += 1) {
      const want = bare[c]! * air.transmittance + air.inscatter[c]!;
      expect(Math.abs(misted[c]! - want) / want).toBeLessThan(0.02);
    }
  });

  it("converges on the same light with its jittered history, for a still camera", async () => {
    const still = await render([speck], FOG);
    const temporal = await render([speck], FOG, { frames: 24, temporal: true });
    let worst = 0;
    let peak = 0;
    for (let i = 0; i < still.volume!.length; i += 4) peak = Math.max(peak, still.volume![i]!);
    for (let i = 0; i < still.volume!.length; i += 1) {
      const allowed = i % 4 === 3 ? 0.01 : Math.max(0.05 * Math.abs(still.volume![i]!), 0.01 * peak);
      worst = Math.max(worst, Math.abs(temporal.volume![i]! - still.volume![i]!) / allowed);
    }
    expect(worst).toBeLessThan(1);
  });

  it("is dark where the sun's cascades say a roof shadows it: a shaft's edge", async () => {
    // A roof over the left of the view, between the fog and a sun low in the west.
    const cover: MeshSceneInstance = { mesh: roof(), model: composeModelMatrix([-60, 6, -30], [0, 0, 0], [60, 1, 60]) };
    const sunShadow = { casters: [cover], toLight: SUN, distance: 80, size: 1024, reach: 80 };
    const lit = await render([speck], FOG);
    const shaded = await render([speck, cover], FOG, { sunShadow });
    const [nx, ny] = grid;
    const at = (x: number, z: number) => (((z * ny + (ny >> 1)) * nx + x) * 4);
    // Deep in, on the left the roof's shadow has kept the sun's light out; on the right the fog is lit as without it.
    const z = FOG_SLICES - 8;
    expect(shaded.volume![at(0, z)]!).toBeLessThan(lit.volume![at(0, z)]! * 0.5);
    expect(shaded.volume![at(nx - 1, z)]! / lit.volume![at(nx - 1, z)]!).toBeGreaterThan(0.97);
  });
});

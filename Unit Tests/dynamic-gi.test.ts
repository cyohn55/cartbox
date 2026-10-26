/**
 * Real-time global illumination (AAA_FIDELITY_ROADMAP.md F3e): the live
 * probe volume's settings and grid, its frame's random rotations, and on a
 * real device its probes converging on what the GPU bake gives the same
 * scene, and following a light that comes on and goes off.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_LIGHT_PROBES,
  PROBE_SH,
  PROBE_VOLUME_SLOTS,
  defaultSceneLighting,
  dynamicGiGrid,
  emptyProbeVolume,
  parseDynamicGi,
  parseSceneLighting,
  probeVolumeTexels,
  projectionMatrix,
  resolveDynamicGi,
  sceneLightingEnvironment,
  viewMatrix,
  type MeshAsset,
  type Occluder,
  type SceneLight,
} from "@cartbox/editor";
import { MeshOverlaySurface, WebgpuSceneRenderer, environmentPanorama, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import { bakeLights, bakeProbeVolumeGpu } from "../packages/player/src/render/gpuLightmapper";
import { GpuProbeGi, giSpacing, randomRotation } from "../packages/player/src/render/dynamicGi";

describe("the live volume's settings", () => {
  it("reads them in range, keeps them through a save, and resolves the defaults", () => {
    expect(parseDynamicGi({ rays: 1000, hysteresis: 2, spacing: 0.1 })).toEqual({ rays: 256, hysteresis: 0.995, spacing: 0.5 });
    expect(parseDynamicGi(null)).toBeNull();
    expect(resolveDynamicGi({})).toEqual({ rays: 64, hysteresis: 0.97, spacing: 3 });
    const rig = parseSceneLighting(JSON.parse(JSON.stringify({ ...defaultSceneLighting(), dynamicGi: { rays: 32 } })))!;
    expect(rig.dynamicGi).toEqual({ rays: 32 });
  });

  it("lays its grid a little past the scene's bounds, within the probe limits", () => {
    const grid = dynamicGiGrid([-20, 0, -30], [20, 8, 30], 3);
    expect(grid.min[0]).toBeLessThan(-20);
    expect(grid.max[1]).toBeGreaterThan(8);
    expect(grid.counts[0] * grid.counts[1] * grid.counts[2]).toBeLessThanOrEqual(MAX_LIGHT_PROBES);
    for (const c of grid.counts) expect(c).toBeGreaterThanOrEqual(2);
  });

  it("turns its rays by rotations, which keep lengths and angles", () => {
    for (const u of [[0.1, 0.2, 0.3], [0.9, 0.5, 0.01]]) {
      const r = randomRotation(u[0]!, u[1]!, u[2]!);
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) {
          const dot = r[i]![0]! * r[j]![0]! + r[i]![1]! * r[j]![1]! + r[i]![2]! * r[j]![2]!;
          expect(dot).toBeCloseTo(i === j ? 1 : 0, 9);
        }
      }
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
  for (let i = 0; i < 2000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

/** A floor 12 m square facing up, and (with `walls`) a box room round it with a window in the roof. */
function room(walls: boolean): MeshAsset {
  const quads: number[][] = [[-6, 0, -6, 6, 0, -6, 6, 0, 6, -6, 0, 6]];
  if (walls) {
    quads.push([-6, 0, -6, -6, 4, -6, 6, 4, -6, 6, 0, -6], [-6, 0, 6, 6, 0, 6, 6, 4, 6, -6, 4, 6], [-6, 0, -6, -6, 0, 6, -6, 4, 6, -6, 4, -6], [6, 0, -6, 6, 4, -6, 6, 4, 6, 6, 0, 6]);
    // A roof over all but a window along the +z wall.
    quads.push([-6, 4, -6, -6, 4, 2, 6, 4, 2, 6, 4, -6]);
  }
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    positions.push(...q);
    const e1 = [q[3]! - q[0]!, q[4]! - q[1]!, q[5]! - q[2]!];
    const e2 = [q[9]! - q[0]!, q[10]! - q[1]!, q[11]! - q[2]!];
    // e2 × e1: up for the floor, inward for the walls, down for the roof.
    const n = [e2[1]! * e1[2]! - e2[2]! * e1[1]!, e2[2]! * e1[0]! - e2[0]! * e1[2]!, e2[0]! * e1[1]! - e2[1]! * e1[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (let k = 0; k < 4; k += 1) normals.push(n[0]! / l, n[1]! / l, n[2]! / l);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return {
    name: "room",
    primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }],
  } as unknown as MeshAsset;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe("the player under real-time GI", () => {
  it("hands the AAA renderer the still scene and one volume over its bounds, frame after frame, and nothing elsewhere", async () => {
    const draws: GpuSceneDraw[] = [];
    const make = (cascades: boolean) => ({ backend: "webgpu", sunCascades: cascades, draws, render: () => {}, renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} }) as unknown as SceneRenderer;
    const presenter = { present: (_frame: PresentFrame) => undefined, stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
    const scene = { instances: [{ mesh: room(true), model: IDENTITY }], bounds: { min: [-6, 0, -6], max: [6, 4, 6], center: [0, 2, 0], radius: 9 }, lighting: { ...defaultSceneLighting(), dynamicGi: { spacing: 4 } } } as never;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, make(true), { presenter } as never);
    surface.setHudMode(true);
    surface.blit(new Uint8Array(32 * 24 * 4));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const [a, b] = draws.slice(-2) as [GpuSceneDraw, GpuSceneDraw];
    expect(a.dynamicGi?.settings).toEqual({ rays: 64, hysteresis: 0.97, spacing: 4 });
    expect(a.dynamicGi?.occluders).toHaveLength(1);
    const volume = a.environment!.probeVolume!;
    expect(volume.min[0]).toBeLessThan(-6);
    expect(b.environment!.probeVolume).toBe(volume);
    // Without the AAA tier's cascades (another renderer), no live GI.
    draws.length = 0;
    const plain = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, make(false), { presenter } as never);
    plain.setHudMode(true);
    plain.blit(new Uint8Array(32 * 24 * 4));
    expect(draws.at(-1)!.dynamicGi).toBeUndefined();
  });
});

describe.skipIf(!device)("the live volume on a real device", { timeout: 600_000 }, () => {
  const min: [number, number, number] = [-4, 0.5, -4];
  const max: [number, number, number] = [4, 3, 4];
  const counts: [number, number, number] = [3, 2, 3];
  const count = counts[0] * counts[1] * counts[2];
  const sun: SceneLight = { kind: "directional", direction: [0.4, 1, 0.3], color: [1, 0.95, 0.9], intensity: 1.5 };
  const sky = environmentPanorama(sceneLightingEnvironment(defaultSceneLighting()));

  /** A frame of the live volume per entry of `lights` (that frame's lights), from nothing, over `occluders`: the probes' slots as the scene reads them. */
  async function live(occluders: Occluder[], lights: SceneLight[][], hysteresis: number, rays = 128): Promise<Float32Array> {
    const { reach } = giSpacing({ min, max, counts });
    const texels = probeVolumeTexels(emptyProbeVolume(min, max, counts, reach));
    const probes = device.createBuffer({ size: texels.byteLength, usage: 0x80 | 0x08 | 0x04 });
    device.queue.writeBuffer(probes, 0, texels);
    const gi = new GpuProbeGi(device, occluders);
    device.pushErrorScope("validation");
    for (const frameLights of lights) {
      const encoder = device.createCommandEncoder();
      gi.update(encoder, probes, { min, max, counts }, { rays, hysteresis, spacing: 3 }, frameLights, sky);
      device.queue.submit([encoder.finish()]);
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const read = device.createBuffer({ size: texels.byteLength, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(probes, 0, read, 0, texels.byteLength);
    device.queue.submit([encoder.finish()]);
    await settled(read.mapAsync(0x01));
    const data = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    for (const b of [probes, read]) b.destroy();
    gi.dispose();
    return data;
  }

  /** A probe's L0 irradiance (its slot 0's RGB) in the scene's layout. */
  const l0 = (data: Float32Array, p: number) => {
    const x = p % counts[0], y = Math.floor(p / counts[0]) % counts[1], z = Math.floor(p / (counts[0] * counts[1]));
    const at = ((z * counts[1] + y) * (PROBE_VOLUME_SLOTS * counts[0]) + x) * 4;
    return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
  };

  it("converges on what the GPU bake gives the same open scene, sky and sun", async () => {
    const occluders: Occluder[] = [{ mesh: room(false), model: IDENTITY as never }];
    const data = await live(occluders, Array.from({ length: 40 }, () => [sun]), 0.8, 256);
    const baked = await bakeProbeVolumeGpu(device, min, max, counts, occluders, { rays: 4096, bounces: 4, sky, lights: bakeLights([sun]) });
    let worst = 0;
    for (let p = 0; p < count; p += 1) {
      const got = l0(data, p);
      expect(got[3]).toBeGreaterThan(0.5); // valid
      for (let c = 0; c < 3; c += 1) {
        const want = baked.sh[p * PROBE_SH * 3 + c]!;
        worst = Math.max(worst, Math.abs(got[c]! - want) / want);
      }
    }
    expect(worst).toBeLessThan(0.08);
  });

  it("follows a light that comes on in a closed room, and falls back when it goes off", async () => {
    const occluders: Occluder[] = [{ mesh: room(true), model: IDENTITY as never }];
    const lamp: SceneLight = { kind: "point", position: [3, 2, 3], color: [1, 0.8, 0.6], intensity: 20, range: 20, falloff: "inverseSquare" };
    const dark = await live(occluders, Array.from({ length: 20 }, () => [sun]), 0.6);
    const lit = await live(occluders, Array.from({ length: 20 }, () => [sun, lamp]), 0.6);
    const off = await live(occluders, [...Array.from({ length: 20 }, () => [sun, lamp]), ...Array.from({ length: 20 }, () => [sun])], 0.6);
    // The probe nearest the lamp (the far corner, up): far brighter with it, and back near the dark room's once it is off.
    const near = (1 * counts[1] + 1) * counts[0] + 2;
    expect(l0(lit, near)[0]!).toBeGreaterThan(l0(dark, near)[0]! * 2);
    expect(Math.abs(l0(off, near)[0]! - l0(dark, near)[0]!) / l0(dark, near)[0]!).toBeLessThan(0.15);
    // Light bounces round the walls: a probe in the room's other corner gains too, if less.
    const across = 0;
    expect(l0(lit, across)[0]!).toBeGreaterThan(l0(dark, across)[0]! * 1.05);
  });

  it("lights the AAA renderer's surfaces with the bounce it traces, frame by frame", async () => {
    const W = 32, H = 24;
    const occluders: Occluder[] = [{ mesh: room(true), model: IDENTITY as never }];
    const lamp: SceneLight = { kind: "point", position: [3, 2, 3], color: [1, 0.8, 0.6], intensity: 20, range: 20, falloff: "inverseSquare" };
    const { reach } = giSpacing({ min, max, counts });
    const environment = { ...sceneLightingEnvironment(defaultSceneLighting()), probeVolume: emptyProbeVolume(min, max, counts, reach) };
    // Looking at the room's −z wall from inside, the lamp behind the eye.
    const render = async (gi: boolean, frames: number) => {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
      device.pushErrorScope("validation");
      let texture: any = null;
      for (let f = 0; f < frames; f += 1) {
        texture = renderer.renderToTexture!([{ mesh: room(true), model: IDENTITY as never }], {
          width: W, height: H, view: viewMatrix([0, 2, 2], [0, 2, -6]), projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 50),
          ambient: 0, lightDirection: sun.direction, environment, lights: [sun, lamp],
          ...(gi ? { dynamicGi: { occluders, key: "room", settings: { rays: 64, hysteresis: 0.6, spacing: 3 } } } : {}),
        } as any);
      }
      const error = await settled(device.popErrorScope());
      expect(error ? String((error as any).message ?? error) : null).toBeNull();
      const bytesPerRow = 256;
      const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
      device.queue.submit([encoder.finish()]);
      await settled(buffer.mapAsync(0x01));
      const halves = new Uint16Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      renderer.dispose();
      const h = halves[(H >> 1) * (bytesPerRow / 2) + (W >> 1) * 4]!;
      const e = (h >> 10) & 0x1f, m = h & 0x3ff;
      return e === 0 ? 2 ** -14 * (m / 1024) : 2 ** (e - 15) * (1 + m / 1024);
    };
    const direct = await render(false, 1);
    const once = await render(true, 1);
    const settledGi = await render(true, 16);
    // The wall's own light, then the room's bounce gathering on it as the volume fills.
    expect(once).toBeGreaterThan(direct);
    expect(settledGi).toBeGreaterThan(once * 1.05);
  });
});

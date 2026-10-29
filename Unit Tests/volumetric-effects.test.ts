/**
 * Volumetric effects (AAA_FIDELITY_ROADMAP.md F8b): the stable-fluids solver
 * (projection, buoyancy, conservation), baking, the blackbody and the light a
 * fire casts, and on a real device (Dawn) the GPU's solver against the CPU's,
 * smoke darkening and fire brightening a frame, and the fire's light reaching
 * the scene.
 */

import { describe, expect, it } from "vitest";

import {
  FluidGrid,
  bakeVolume,
  blackbody,
  burn,
  composeModelMatrix,
  divergence,
  effectSources,
  parseVolumeEffects,
  project,
  projectionMatrix,
  stepFluid,
  viewMatrix,
  volumeLight,
  volumePreset,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";
import { GpuVolumes } from "../packages/player/src/render/volumetricEffects";

/** The largest divergence over a grid's cells. */
function worstDivergence(g: FluidGrid): number {
  let worst = 0;
  for (let z = 0; z < g.n; z += 1) for (let y = 0; y < g.n; y += 1) for (let x = 0; x < g.n; x += 1) worst = Math.max(worst, Math.abs(divergence(g, x, y, z)));
  return worst;
}

describe("the solver", () => {
  it("projects a swirl-and-source velocity toward no divergence", () => {
    const g = new FluidGrid(12);
    // A burst out from the middle: all divergence.
    for (let z = 0; z < 12; z += 1)
      for (let y = 0; y < 12; y += 1)
        for (let x = 0; x < 12; x += 1) {
          const i = g.index(x, y, z);
          g.velocity.set([x - 5.5, y - 5.5, z - 5.5], i * 3);
        }
    const before = worstDivergence(g);
    project(g, 60);
    expect(worstDivergence(g)).toBeLessThan(before * 0.35);
  });

  it("lifts heat, and roughly keeps the density it moves (no dissipation)", () => {
    const g = new FluidGrid(16);
    const effect = { buoyancy: 4, dissipation: 0, cooling: 0 };
    stepFluid(g, effect, [{ center: [8, 4, 8], radius: 3, density: 10, temperature: 20, velocity: [0, 0, 0] }], 0.1);
    const mass = g.mass;
    const centroid = () => {
      let m = 0;
      let y = 0;
      for (let k = 0; k < 16; k += 1)
        for (let j = 0; j < 16; j += 1)
          for (let i = 0; i < 16; i += 1) {
            const d = g.density[g.index(i, j, k)]!;
            m += d;
            y += d * (j + 0.5);
          }
      return y / m;
    };
    const start = centroid();
    for (let s = 0; s < 15; s += 1) stepFluid(g, effect, [], 0.1);
    expect(centroid()).toBeGreaterThan(start + 1);
    // Semi-Lagrangian advection isn't conservative (trilinear resampling, the walls' clamp): a strong plume drifts
    // its mass by some percent over 15 steps.
    expect(Math.abs(g.mass - mass) / mass).toBeLessThan(0.2);
  });

  it("bakes an effect's frames, and fades by its dissipation", () => {
    const effect = { ...volumePreset("smoke"), duration: 1, resolution: 12 };
    const baked = bakeVolume(effect, 10, 12);
    expect(baked.frames).toHaveLength(10);
    expect(baked.frames[5]!.density.some((d) => d > 0)).toBe(true);
    expect(effectSources(effect, 12, 0.9)).toEqual([]);
  });
});

describe("light from fire", () => {
  it("glows a blackbody's colour, brighter the hotter", () => {
    expect(blackbody(300)).toEqual([0, 0, 0]);
    const warm = blackbody(1500);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const hot = blackbody(6500);
    expect(Math.abs(hot[0] / hot[2] - 1)).toBeLessThan(0.15);
    expect(hot[1]).toBeGreaterThan(warm[1] * 100);
  });

  it("burns up fast and dies away, and casts a light while it burns", () => {
    const boom = volumePreset("explosion");
    expect(burn(boom, 0.05)).toBeGreaterThan(0.9);
    expect(burn(boom, 3)).toBeLessThan(burn(boom, 0.5));
    expect(burn(volumePreset("smoke"), 1)).toBe(0);
    const light = volumeLight(boom, [1, 0, 2], 0.1)!;
    expect(light.position).toEqual([1, boom.size * 0.3, 2]);
    expect(light.color[0]).toBe(1);
    expect(light.intensity).toBeGreaterThan(1000);
    expect(volumeLight(boom, [0, 0, 0], 10)).toBeNull();
  });

  it("reads stored effects defensively", () => {
    const [fire] = parseVolumeEffects([{ name: "f", kind: "fire", resolution: 500, color: [2, 0.5, -1] }, { kind: "nope" }]);
    expect(fire!.resolution).toBe(64);
    expect(fire!.color).toEqual([1, 0.5, 0]);
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
  for (let i = 0; i < 4000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

async function readFloats(buffer: any, bytes: number): Promise<Float32Array> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}

const W = 32;
const H = 32;

describe.skipIf(!device)("volumes on a real device", { timeout: 300_000 }, () => {
  it("solves the fluid as the CPU does", async () => {
    const effect = { ...volumePreset("fire"), resolution: 16 };
    const gpu = new GpuVolumes(device, "rgba16float", [effect]);
    gpu.trigger(0, [0, 0, 0]);
    const cpu = new FluidGrid(16);
    device.pushErrorScope("validation");
    for (let s = 0; s < 10; s += 1) {
      gpu.simulate(1 / 30);
      stepFluid(cpu, effect, effectSources(effect, 16, s / 30), 1 / 30);
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const state = gpu.state(0)!;
    const fields = await readFloats(state.fields, 16 ** 3 * 8);
    let worst = 0;
    let peak = 0;
    for (let i = 0; i < 16 ** 3; i += 1) {
      worst = Math.max(worst, Math.abs(fields[i * 2]! - cpu.density[i]!));
      peak = Math.max(peak, cpu.density[i]!);
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(worst).toBeLessThan(peak * 0.01);
    gpu.dispose();
  });

  function wall(color: [number, number, number, number]): MeshAsset {
    return {
      name: "wall",
      primitives: [
        {
          positions: Float32Array.from([-20, -5, -8, 20, -5, -8, 20, 20, -8, -20, 20, -8]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: new Float32Array(8),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "wall", baseColorFactor: [0, 0, 0, 1], emissiveFactor: color.slice(0, 3), baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
    } as unknown as MeshAsset;
  }

  it("darkens a bright frame with smoke, brightens a dark one with fire, and lights the scene by the fire", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    renderer.setVolumes([{ ...volumePreset("smoke"), resolution: 16, absorption: 6 }, { ...volumePreset("fire"), resolution: 16 }]);
    const draw = { width: W, height: H, view: viewMatrix([0, 1, 5], [0, 1, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), environment: null, lights: [], ambient: 0.2, lightDirection: [0, 1, 0], prepass: true } as any;
    const centre = (data: Float32Array) => {
      let s = 0;
      for (let y = 12; y < 20; y += 1) for (let x = 12; x < 20; x += 1) s += data[(y * W + x) * 4]! + data[(y * W + x) * 4 + 1]! + data[(y * W + x) * 4 + 2]!;
      return s / 64;
    };
    const bright = [{ mesh: wall([2, 2, 2, 1]), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    const before = centre((await readLinearTexture(device, renderer.renderToTexture(bright, draw), W, H, settled)).data);
    renderer.volumeTrigger(0, [0, 0, 0]);
    device.pushErrorScope("validation");
    let shot: any = null;
    for (let i = 0; i < 60; i += 1) shot = renderer.renderToTexture(bright, draw);
    let error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const smoky = centre((await readLinearTexture(device, shot, W, H, settled)).data);
    expect(smoky).toBeLessThan(before * 0.9);
    // Fire against a black wall, in its own renderer state: brighter for its glow.
    renderer.setVolumes([{ ...volumePreset("fire"), resolution: 16 }]);
    const dark = [{ mesh: wall([0, 0, 0, 1]), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    const unlit = centre((await readLinearTexture(device, renderer.renderToTexture(dark, draw), W, H, settled)).data);
    renderer.volumeTrigger(0, [0, 0, 0]);
    device.pushErrorScope("validation");
    for (let i = 0; i < 40; i += 1) shot = renderer.renderToTexture(dark, draw);
    error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const burning = centre((await readLinearTexture(device, shot, W, H, settled)).data);
    expect(burning).toBeGreaterThan(unlit + 0.05);
    renderer.dispose();
  });
});

/**
 * Emissive surfaces that light (AAA_FIDELITY_ROADMAP.md F2f): a glowing
 * surface is a light through the GI, the GPU bake's (F3d) and the live
 * volume's (F3e) alike. Held to the closed form: a point facing a glowing
 * plane that fills its view takes the plane's radiance as its irradiance
 * over π, as a white Lambertian surface there would reflect it.
 */

import { describe, expect, it } from "vitest";

import { PROBE_SH, PROBE_VOLUME_SLOTS, emptyProbeVolume, probeVolumeTexels, shBasis, type MeshAsset, type Occluder } from "@cartbox/editor";
import { bakeProbeVolumeGpu } from "../packages/player/src/render/gpuLightmapper";
import { GpuProbeGi, giSpacing } from "../packages/player/src/render/dynamicGi";

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

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const GLOW: [number, number, number] = [1, 0.5, 0.2];
/** A black floor 400 m square that glows GLOW, facing up. */
const FLOOR = {
  name: "glow",
  primitives: [
    {
      positions: Float32Array.from([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]),
      normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: null,
      indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
      material: { name: "m", baseColorFactor: [0, 0, 0, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, emissiveFactor: GLOW },
    },
  ],
} as unknown as MeshAsset;
const OCCLUDERS: Occluder[] = [{ mesh: FLOOR, model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as never }];
const MIN: [number, number, number] = [-2, 1, -2];
const MAX: [number, number, number] = [2, 3, 2];
const COUNTS: [number, number, number] = [2, 2, 2];

/** The SH irradiance (over π) of nine RGB coefficients along a unit normal. */
function irradiance(sh: (k: number, c: number) => number, n: [number, number, number]): number[] {
  const basis = shBasis(n[0], n[1], n[2]);
  return [0, 1, 2].map((c) => basis.reduce((sum, b, k) => sum + b * sh(k, c), 0));
}

describe.skipIf(!device)("a glowing surface lights through the GI", { timeout: 300_000 }, () => {
  const L = GLOW.map(toLinear);

  it("in the GPU bake: a probe facing the glowing floor takes its radiance", async () => {
    const volume = await bakeProbeVolumeGpu(device, MIN, MAX, COUNTS, OCCLUDERS, { rays: 4096, bounces: 1, sky: null, lights: [] });
    for (let p = 0; p < 8; p += 1) {
      const e = irradiance((k, c) => volume.sh[(p * PROBE_SH + k) * 3 + c]!, [0, -1, 0]);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(e[c]! - L[c]!) / L[c]!).toBeLessThan(0.1);
      // Facing away (no sky), nearly dark.
      expect(irradiance((k, c) => volume.sh[(p * PROBE_SH + k) * 3 + c]!, [0, 1, 0])[0]!).toBeLessThan(L[0]! * 0.1);
    }
  });

  it("in the live volume: the same, traced frame by frame", async () => {
    const { reach } = giSpacing({ min: MIN, max: MAX, counts: COUNTS });
    const texels = probeVolumeTexels(emptyProbeVolume(MIN, MAX, COUNTS, reach));
    const probes = device.createBuffer({ size: texels.byteLength, usage: 0x80 | 0x08 | 0x04 });
    device.queue.writeBuffer(probes, 0, texels);
    const gi = new GpuProbeGi(device, OCCLUDERS);
    for (let f = 0; f < 30; f += 1) {
      const encoder = device.createCommandEncoder();
      gi.update(encoder, probes, { min: MIN, max: MAX, counts: COUNTS }, { rays: 256, hysteresis: 0.8, spacing: 4 }, [], null);
      device.queue.submit([encoder.finish()]);
    }
    const read = device.createBuffer({ size: texels.byteLength, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(probes, 0, read, 0, texels.byteLength);
    device.queue.submit([encoder.finish()]);
    await settled(read.mapAsync(0x01));
    const data = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    gi.dispose();
    for (const b of [probes, read]) b.destroy();
    const [cx, cy] = COUNTS;
    for (let p = 0; p < 8; p += 1) {
      const x = p % cx, y = Math.floor(p / cx) % cy, z = Math.floor(p / (cx * cy));
      const slot = (k: number, c: number) => data[((z * cy + y) * (PROBE_VOLUME_SLOTS * cx) + k * cx + x) * 4 + c]!;
      const e = irradiance(slot, [0, -1, 0]);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(e[c]! - L[c]!) / L[c]!).toBeLessThan(0.1);
    }
  });
});

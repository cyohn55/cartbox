/**
 * Clustered lights on the GPU (AAA_FIDELITY_ROADMAP.md F0e): on a real device
 * (Dawn), the cells the compute passes build against the CPU's
 * (lightClusters.ts), and a lit frame drawn either way.
 */

import { describe, expect, it } from "vitest";

import { CLUSTER_CELLS, buildLightClusters, clusterGrid, composeModelMatrix, orderLights, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { GpuLightClusters } from "../packages/player/src/render/gpuLightClusters";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";
import { packLights } from "../packages/player/src/render/scenePacking";

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

async function readBuffer(buffer: any, bytes: number): Promise<ArrayBuffer> {
  const staging = device.createBuffer({ size: bytes, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return out;
}

/** A scatter of point and spot lights (and a sun) around the origin. */
function lights(count: number): SceneLight[] {
  let s = 7;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out: SceneLight[] = [{ kind: "directional", direction: [0.3, 1, 0.2], color: [1, 1, 1], intensity: 1 }];
  for (let i = 0; i < count; i += 1) {
    const position: [number, number, number] = [(rand() - 0.5) * 30, (rand() - 0.5) * 10, (rand() - 0.5) * 40 - 5];
    out.push(i % 3 === 0 ? { kind: "spot", position, direction: [0, -1, 0], color: [1, 0.8, 0.6], intensity: 4, range: 1 + rand() * 6, angle: 0.6 } : { kind: "point", position, color: [0.6, 0.8, 1], intensity: 3, range: 1 + rand() * 6 });
  }
  return out;
}

describe.skipIf(!device)("clustered lights on a real device", { timeout: 300_000 }, () => {
  it("lists every light the CPU lists, in the same order, nearly always nothing more", async () => {
    const W = 320;
    const H = 180;
    const view = viewMatrix([1, 2, 8], [0, 0, -5]);
    const projection = projectionMatrix(Math.PI / 3, W / H, 0.1, 80);
    const { ordered, globalCount } = orderLights(lights(120));
    const cpu = buildLightClusters(ordered, globalCount, view, projection, W, H)!;
    const grid = clusterGrid(projection, W, H)!;
    expect(GpuLightClusters.params(grid)).toEqual(cpu.params);

    const packed = packLights(ordered, true, null);
    const lightBuffer = device.createBuffer({ size: packed.byteLength, usage: 0x80 | 0x08 });
    device.queue.writeBuffer(lightBuffer, 0, packed);
    const data = device.createBuffer({ size: CLUSTER_CELLS * 8 + 16384 * 4, usage: 0x80 | 0x08 | 0x04 });
    const clusterer = new GpuLightClusters(device);
    clusterer.prepare(grid, view, W, H, globalCount, ordered.length);
    const encoder = device.createCommandEncoder();
    clusterer.encode(encoder, lightBuffer, data);
    device.queue.submit([encoder.finish()]);
    const out = new Uint32Array(await readBuffer(data, CLUSTER_CELLS * 8 + 16384 * 4));

    let same = 0;
    let lit = 0;
    for (let cell = 0; cell < CLUSTER_CELLS; cell += 1) {
      const cpuList = Array.from(cpu.indices.subarray(cpu.table[cell * 2]!, cpu.table[cell * 2]! + cpu.table[cell * 2 + 1]!));
      const gpuList = Array.from(out.subarray(CLUSTER_CELLS * 2 + out[cell * 2]!, CLUSTER_CELLS * 2 + out[cell * 2]! + out[cell * 2 + 1]!));
      if (cpuList.length > 0) lit += 1;
      // Every light the CPU lists, and in order.
      expect(gpuList.filter((l) => cpuList.includes(l))).toEqual(cpuList);
      if (gpuList.length === cpuList.length) same += 1;
    }
    expect(lit).toBeGreaterThan(200);
    // The GPU's wider slack (against f32 rounding) adds a light to about one cell in a hundred.
    expect(same / CLUSTER_CELLS).toBeGreaterThan(0.98);
    // The starts are the counts' running sum.
    let at = 0;
    for (let cell = 0; cell < CLUSTER_CELLS; cell += 1) {
      expect(out[cell * 2]).toBe(at);
      at += out[cell * 2 + 1]!;
    }
    clusterer.destroy();
  });

  it("draws the same lit frame from the GPU's cells as from the CPU's", async () => {
    const W = 64;
    const H = 48;
    const floor = {
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-20, 0, -30, 20, 0, -30, 20, 0, 10, -20, 0, 10]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: new Float32Array(8),
          indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
          material: { name: "floor", baseColorFactor: [0.7, 0.7, 0.7, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.7 },
        },
      ],
    } as unknown as MeshAsset;
    const instances = [{ mesh: floor, model: composeModelMatrix([0, -2, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    const draw = { width: W, height: H, view: viewMatrix([0, 3, 8], [0, -2, -5]), projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 80), environment: null, lights: lights(40), ambient: 0.1, prepass: true } as any;
    const read = async (gpuCull: boolean) => {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
      const frame = (await readLinearTexture(device, renderer.renderToTexture(instances, { ...draw, gpuCull }), W, H, settled)).data;
      renderer.dispose();
      return frame;
    };
    const cpu = await read(false);
    device.pushErrorScope("validation");
    const gpu = await read(true);
    expect(await settled(device.popErrorScope())).toBeNull();
    let worst = 0;
    let bright = 0;
    for (let i = 0; i < cpu.length; i += 1) {
      worst = Math.max(worst, Math.abs(cpu[i]! - gpu[i]!));
      bright = Math.max(bright, cpu[i]!);
    }
    expect(bright).toBeGreaterThan(0.05);
    expect(worst).toBeLessThan(1e-5);
  });
});

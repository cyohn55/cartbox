/**
 * Each copy's transforms made on the GPU (AAA_FIDELITY_ROADMAP.md F0e): from
 * the model matrices alone, on a real device (Dawn), the records the CPU
 * would have written, motion records too, to float32 rounding.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, multiplyMat4, projectionMatrix, viewMatrix, type Mat4 } from "@cartbox/editor";

import { GpuTransforms, writeInstanceModel } from "../packages/player/src/render/gpuTransforms";
import { INSTANCE_FLOATS, normalBasis3x3, writeInstanceTransform } from "../packages/player/src/render/scenePacking";

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

/** Fill `copies` records on the GPU from `models` (and `previous` in the motion records), and read them back. */
async function fillOnGpu(models: readonly Mat4[], previous: readonly Mat4[] | null, frame: Parameters<GpuTransforms["prepare"]>[1]): Promise<Float32Array> {
  const n = models.length;
  const records = n * (previous ? 2 : 1);
  const data = new Float32Array(records * INSTANCE_FLOATS).fill(123);
  models.forEach((m, i) => writeInstanceModel(data, i, m));
  previous?.forEach((m, i) => writeInstanceModel(data, n + i, m));
  const buffer = device.createBuffer({ size: data.byteLength, usage: 0x80 | 0x08 | 0x04 }); // STORAGE | COPY_DST | COPY_SRC
  device.queue.writeBuffer(buffer, 0, data);
  const transforms = new GpuTransforms(device);
  transforms.prepare(n, frame);
  const staging = device.createBuffer({ size: data.byteLength, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  transforms.encode(encoder, buffer);
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, data.byteLength);
  device.queue.submit([encoder.finish()]);
  await settled(staging.mapAsync(1));
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  buffer.destroy();
  transforms.destroy();
  return out;
}

/** The largest difference between two runs of 16-float matrices, relative to each matrix's largest entry (a float32 product's rounding scales with its terms, not its result). */
function worstOf(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let worst = 0;
  for (let m = from; m < to; m += 16) {
    let size = 1;
    for (let i = m; i < Math.min(to, m + 16); i += 1) size = Math.max(size, Math.abs(b[i]!));
    for (let i = m; i < Math.min(to, m + 16); i += 1) worst = Math.max(worst, Math.abs(a[i]! - b[i]!) / size);
  }
  return worst;
}

describe.skipIf(!device)("copies' transforms on a real device", { timeout: 300_000 }, () => {
  const viewProj = multiplyMat4(projectionMatrix(Math.PI / 3, 16 / 9, 0.1, 1500), viewMatrix([30, 12, 40], [0, 0, 0]));
  const lightViewProj = multiplyMat4(projectionMatrix(0.8, 1, 1, 400), viewMatrix([100, 200, 50], [0, 0, 0]));
  const models = Array.from({ length: 150 }, (_, i) => composeModelMatrix([i * 3 - 200, (i % 7) * 2, 400 - i * 5], [i * 7, i * 13, i * 3], [0.5 + (i % 4) * 0.5, 1, 0.75]));

  it("makes each copy's clip, light and normal transforms as the CPU does", async () => {
    const gpu = await fillOnGpu(models, null, { viewProj, lightViewProj, motion: null });
    const cpu = new Float32Array(gpu.length);
    models.forEach((model, i) => writeInstanceTransform(cpu, i, { mvp: multiplyMat4(viewProj, model), lightMvp: multiplyMat4(lightViewProj, model), model, normalBasis: normalBasis3x3(model) }));
    for (let i = 0; i < models.length; i += 1) expect(worstOf(gpu, cpu, i * INSTANCE_FLOATS, i * INSTANCE_FLOATS + 48)).toBeLessThan(1e-6);
    // The normal basis is the model's own 3×3, exactly.
    for (let i = 0; i < models.length; i += 1) expect([...gpu.subarray(i * INSTANCE_FLOATS + 48, (i + 1) * INSTANCE_FLOATS)]).toEqual([...cpu.subarray(i * INSTANCE_FLOATS + 48, (i + 1) * INSTANCE_FLOATS)]);
  });

  it("zeroes the light transform with no shadow", async () => {
    const gpu = await fillOnGpu(models.slice(0, 3), null, { viewProj, lightViewProj: null, motion: null });
    for (let i = 0; i < 3; i += 1) expect([...gpu.subarray(i * INSTANCE_FLOATS + 16, i * INSTANCE_FLOATS + 32)].every((v) => v === 0)).toBe(true);
  });

  it("fills each motion record with the copy's clip transform now and its last model's then", async () => {
    const now = multiplyMat4(projectionMatrix(Math.PI / 3, 16 / 9, 0.1, 1500), viewMatrix([30, 12, 40], [0, 0, 0]));
    const then = multiplyMat4(projectionMatrix(Math.PI / 3, 16 / 9, 0.1, 1500), viewMatrix([29.5, 12, 40.2], [0, 0, 0]));
    const previous = models.map((m, i) => (i % 2 === 0 ? m : composeModelMatrix([i * 3 - 200.4, (i % 7) * 2, 400 - i * 5], [i * 7, i * 13, i * 3], [0.5 + (i % 4) * 0.5, 1, 0.75])));
    const gpu = await fillOnGpu(models, previous, { viewProj, lightViewProj, motion: { now, then } });
    const n = models.length;
    for (let i = 0; i < n; i += 1) {
      const cpu = new Float32Array(INSTANCE_FLOATS);
      writeInstanceTransform(cpu, 0, { mvp: multiplyMat4(now, models[i]!), lightMvp: multiplyMat4(then, previous[i]!), model: previous[i]!, normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
      const record = gpu.subarray((n + i) * INSTANCE_FLOATS, (n + i + 1) * INSTANCE_FLOATS);
      // The clip transforms (its normal basis is never read).
      expect(worstOf(record, cpu, 0, 48)).toBeLessThan(1e-6);
    }
  });
});

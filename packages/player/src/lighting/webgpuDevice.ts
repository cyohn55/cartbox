/**
 * Acquires a shared WebGPU device, memoised so a page with many players probes
 * the adapter only once. Returns null (never throws) when WebGPU is unavailable
 * or the adapter/device can't be obtained, which is the signal the factory uses
 * to fall back to WebGL.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let devicePromise: Promise<any | null> | undefined;

export function getWebgpuDevice(): Promise<any | null> {
  if (!devicePromise) devicePromise = acquireDevice();
  return devicePromise;
}

async function acquireDevice(): Promise<any | null> {
  try {
    const gpu = (globalThis as any).navigator?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch {
    return null;
  }
}

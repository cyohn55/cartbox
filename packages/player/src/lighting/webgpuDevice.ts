/**
 * Acquires a shared WebGPU device, memoised so a page with many players probes
 * the adapter only once. Returns null (never throws) when WebGPU is unavailable
 * or the adapter/device can't be obtained, which is the signal the factory uses
 * to fall back to WebGL.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let devicePromise: Promise<any | null> | undefined;

/** The block-compressed texture families a device can sample (desktop, mobile, Apple), each a WebGPU feature. */
export const TEXTURE_COMPRESSION_FEATURES = ["texture-compression-bc", "texture-compression-etc2", "texture-compression-astc"] as const;

/**
 * The compressed formats (F1a) a KTX2 file should transcode to for `device`,
 * preferred first: BC7 on desktop, ASTC 4×4 on Apple and mobile, ETC2 the
 * fallback. Empty without any of the features.
 */
export function compressedFormatsFor(device: any): string[] {
  const has = (feature: string) => device?.features?.has?.(feature) === true;
  return [
    ...(has("texture-compression-bc") ? ["bc7-rgba-unorm"] : []),
    ...(has("texture-compression-astc") ? ["astc-4x4-unorm"] : []),
    ...(has("texture-compression-etc2") ? ["etc2-rgba8unorm"] : []),
  ];
}

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
    // GPU timing for the playtest profiler, and block-compressed textures (F1a), where the adapter offers them.
    const wanted = ["timestamp-query", ...TEXTURE_COMPRESSION_FEATURES];
    const features = wanted.filter((feature) => adapter.features?.has?.(feature) === true);
    return await adapter.requestDevice(features.length > 0 ? { requiredFeatures: features } : undefined);
  } catch {
    return null;
  }
}

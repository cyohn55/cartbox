/**
 * Chooses and builds the lighting renderer: WebGPU when a device is available,
 * otherwise the WebGL fallback. Because a canvas is locked to one context type
 * once `getContext` is called, this owns canvas creation — it hands back the
 * canvas it configured alongside the renderer, and uses a fresh canvas for the
 * WebGL attempt so a failed WebGPU probe can't poison it. Returns null only when
 * neither backend works (the caller then shows the cart unlit in plain 2D).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { LightingLayer } from "./LightingLayer.js";
import { WebgpuLightingLayer } from "./WebgpuLightingLayer.js";
import { getWebgpuDevice } from "./webgpuDevice.js";
import type { LightingRenderer } from "./LightingRenderer.js";

export interface BuiltLightingRenderer {
  renderer: LightingRenderer;
  canvas: HTMLCanvasElement;
}

/** Resolves a shared WebGPU device, or null. Injectable for tests. */
export type DeviceProvider = () => Promise<any | null>;

/**
 * Above this many framebuffer pixels, auto-supersampling backs off to 1×: the
 * N² lighting-pass cost stops being worth the de-banding on large targets (the
 * Pro core's 640×360 = 230k lands here; the standard 240×136 = 33k does not).
 */
const SUPERSAMPLE_AUTO_MAX_PIXELS = 100_000;

/**
 * The supersample factor to actually use: an explicit request clamped to 1..4,
 * or — when unset — 2 for standard-resolution framebuffers and 1 for large ones.
 * Exposed so both the layer factory and its tests resolve it the same way.
 */
export function resolveSupersample(width: number, height: number, requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(1, Math.min(4, Math.round(requested)));
  }
  return width * height <= SUPERSAMPLE_AUTO_MAX_PIXELS ? 2 : 1;
}

export async function createLightingLayer(
  doc: Document,
  width: number,
  height: number,
  deviceProvider: DeviceProvider = getWebgpuDevice,
  supersample?: number,
): Promise<BuiltLightingRenderer | null> {
  const factor = resolveSupersample(width, height, supersample);

  // Preferred path: WebGPU.
  const device = await deviceProvider();
  if (device) {
    const canvas = doc.createElement("canvas");
    const renderer = await WebgpuLightingLayer.create(canvas, width, height, device, factor);
    if (renderer) return { renderer, canvas };
  }

  // Fallback: WebGL on a fresh, unclaimed canvas.
  const canvas = doc.createElement("canvas");
  try {
    return { renderer: new LightingLayer(canvas, width, height, factor), canvas };
  } catch {
    return null;
  }
}

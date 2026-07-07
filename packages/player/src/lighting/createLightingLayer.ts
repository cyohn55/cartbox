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

export async function createLightingLayer(
  doc: Document,
  width: number,
  height: number,
  deviceProvider: DeviceProvider = getWebgpuDevice,
): Promise<BuiltLightingRenderer | null> {
  // Preferred path: WebGPU.
  const device = await deviceProvider();
  if (device) {
    const canvas = doc.createElement("canvas");
    const renderer = await WebgpuLightingLayer.create(canvas, width, height, device);
    if (renderer) return { renderer, canvas };
  }

  // Fallback: WebGL on a fresh, unclaimed canvas.
  const canvas = doc.createElement("canvas");
  try {
    return { renderer: new LightingLayer(canvas, width, height), canvas };
  } catch {
    return null;
  }
}

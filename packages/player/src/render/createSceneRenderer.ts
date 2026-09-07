/**
 * Chooses and builds the 3D scene renderer: WebGPU when a device is available,
 * the software rasteriser otherwise.
 *
 * The same shape as `createLightingLayer`, deliberately — one memoised adapter
 * probe per page, a provider that returns null rather than throwing, and a
 * caller that never has to know which backend it got. The one difference is the
 * return type: lighting can genuinely fail to build (the cart then shows unlit),
 * but there is always a scene renderer, because the software path needs nothing
 * from the platform. This never returns null, so no caller needs a third branch.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getWebgpuDevice } from "../lighting/webgpuDevice.js";
import { SoftwareSceneRenderer, type SceneRenderer } from "./sceneRenderer.js";
import { WebgpuSceneRenderer } from "./WebgpuSceneRenderer.js";

/** Resolves a shared WebGPU device, or null. Injectable for tests. */
export type DeviceProvider = () => Promise<any | null>;

/**
 * Build the best available renderer for one framebuffer size.
 *
 * Pass a provider returning null to force the software path — which is how the
 * fallback stays tested rather than becoming code nobody runs until a browser
 * without WebGPU finds the bug.
 */
export async function createSceneRenderer(
  width: number,
  height: number,
  deviceProvider: DeviceProvider = getWebgpuDevice,
): Promise<SceneRenderer> {
  const device = await deviceProvider();
  if (device) {
    const renderer = await WebgpuSceneRenderer.create(device, width, height);
    if (renderer) return renderer;
  }
  return new SoftwareSceneRenderer();
}

/**
 * Chooses and builds the 3D scene renderer: WebGPU when a device is available,
 * else WebGL2 (the GPU path for browsers without WebGPU), else the software
 * rasteriser.
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
import type { RenderCaps } from "../models.js";
import { rasterStyleFor } from "./renderCaps.js";
import {
  CappedSceneRenderer,
  SoftwareSceneRenderer,
  capsConstrainScene,
  type SceneRenderer,
} from "./sceneRenderer.js";
import { WebglSceneRenderer, type GlContextProvider } from "./WebglSceneRenderer.js";
import { WebgpuSceneRenderer } from "./WebgpuSceneRenderer.js";

/** Resolves a shared WebGPU device, or null. Injectable for tests. */
export type DeviceProvider = () => Promise<any | null>;

/**
 * Build the best available renderer for one framebuffer size, under one model's
 * {@link RenderCaps}.
 *
 * Caps are required rather than optional: a renderer exists to draw *some
 * model's* scenes, and leaving its limits implicit is how an era model ends up
 * silently rendering with another era's rules. The caps wrapper is only applied
 * when it would do something, so an unbounded model pays nothing for it.
 *
 * Pass providers returning null to force the software path — which is how the
 * fallback stays tested rather than becoming code nobody runs until a browser
 * without a GPU finds the bug.
 */
export async function createSceneRenderer(
  width: number,
  height: number,
  caps: RenderCaps,
  deviceProvider: DeviceProvider = getWebgpuDevice,
  glProvider?: GlContextProvider,
): Promise<SceneRenderer> {
  // The model's era decides how to rasterise, and therefore which backends are
  // even eligible: WebGPU declines a style it cannot reproduce (see
  // `webgpuCanHonour`), which is what keeps a console model looking the same
  // whether or not the viewer has a device.
  const style = rasterStyleFor(caps);

  const device = await deviceProvider();
  let renderer: SceneRenderer | null = null;
  if (device) renderer = await WebgpuSceneRenderer.create(device, width, height, style);
  renderer ??= WebglSceneRenderer.create(width, height, style, glProvider);
  renderer ??= new SoftwareSceneRenderer(style);

  return capsConstrainScene(caps) ? new CappedSceneRenderer(renderer, caps) : renderer;
}

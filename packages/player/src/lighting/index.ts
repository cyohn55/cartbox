/**
 * @cartbox/player lighting — a dynamic lighting layer for the player.
 *
 * The player relights a running cart when `mount(..., { lighting })` is given a
 * light provider. Without a material buffer it lights flat pixels (coloured,
 * attenuated pools over the cart's art); with one it runs full per-pixel
 * normals, specular, and height-field shadows — the same pipeline as the LUMEN
 * demo. The renderer here is framework-agnostic and reusable on its own.
 */

export { LightingLayer } from "./LightingLayer.js";
export type { RenderCanvas } from "./LightingLayer.js";
export { WebgpuLightingLayer } from "./WebgpuLightingLayer.js";
export { getWebgpuDevice } from "./webgpuDevice.js";
export { createLightingLayer } from "./createLightingLayer.js";
export type { BuiltLightingRenderer, DeviceProvider } from "./createLightingLayer.js";
export { createFlatMaterial } from "./LightingRenderer.js";
export type { LightingBackend, LightingRenderer } from "./LightingRenderer.js";
export { LitCanvasSurface } from "./LitCanvasSurface.js";
export {
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  nearestDirection,
  normalVector,
  shade,
} from "./lightingModel.js";
export type { Rgb, Vec3 } from "./lightingModel.js";
export type {
  Light,
  LightingFrameContext,
  LightingOptions,
  LightingScene,
  MaterialBuffer,
} from "./types.js";

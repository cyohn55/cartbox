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
export { createLightingLayer, resolveSupersample } from "./createLightingLayer.js";
export type { BuiltLightingRenderer, DeviceProvider } from "./createLightingLayer.js";
export { createFlatMaterial } from "./LightingRenderer.js";
export type { LightingBackend, LightingRenderer } from "./LightingRenderer.js";
export { LitCanvasSurface } from "./LitCanvasSurface.js";
export {
  DEFAULT_LIGHT_DIRECTION,
  DEFAULT_SPOT_CONE_COS,
  LIGHT_KIND_CODE,
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  SPOT_CONE_SOFTNESS,
  interpolateNormal,
  nearestDirection,
  normalVector,
  sampleLight,
  sampleNormalBilinear,
  sampleScalarBilinear,
  shade,
} from "./lightingModel.js";
export type { LightSample, Rgb, Vec3 } from "./lightingModel.js";
export type {
  Light,
  LightingFrameContext,
  LightingOptions,
  LightingScene,
  LightKind,
  MaterialBuffer,
} from "./types.js";

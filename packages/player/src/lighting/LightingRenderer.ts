/**
 * The backend-agnostic contract for the lighting renderer. Two implementations
 * satisfy it — {@link WebgpuLightingLayer} (preferred) and the WebGL
 * {@link LightingLayer} (fallback) — so the display surface and the factory can
 * treat them identically. Both run the same passes and the same lighting model
 * ({@link shade}); only the graphics API differs.
 */

import type { LightingScene, MaterialBuffer } from "./types.js";

/** Which graphics API a renderer is running on. */
export type LightingBackend = "webgpu" | "webgl";

export interface LightingRenderer {
  /** The backend this instance is using — for diagnostics and telemetry. */
  readonly backend: LightingBackend;
  /**
   * Relight one frame and present it to the canvas.
   *
   * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
   * @param material Optional per-pixel material (normal/height/spec/rough); when
   *                 null, pixels are lit flat.
   * @param scene    The lights and ambient for this frame.
   */
  render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void;
  /** Releases all GPU resources held by this renderer. */
  dispose(): void;
}

/**
 * A flat material: normal index 0 (facing camera), height 0, specular 0,
 * roughness full. Lighting a frame with this gives coloured, attenuated pools
 * over the cart's own art — the "no per-pixel material" path both backends share.
 */
export function createFlatMaterial(width: number, height: number): Uint8Array {
  const material = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) material[i * 4 + 3] = 255;
  return material;
}

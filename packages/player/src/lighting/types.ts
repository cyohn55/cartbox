/**
 * Public types for the player's dynamic lighting layer. Kept DOM-free so hosts
 * and tests can build lighting scenes without importing the renderer.
 */

/** A coloured point light positioned over the console framebuffer. */
export interface Light {
  /** Column in native framebuffer pixels (0 = left). */
  x: number;
  /** Row in native framebuffer pixels (0 = top). */
  y: number;
  /** Height above the surface, in pixel units; larger = a broader, softer pool. */
  z: number;
  /** Light colour; each channel is a multiplier (may exceed 1 for a hot light). */
  color: readonly [number, number, number];
  /** Reach in pixels; brightness falls to zero at this distance. */
  radius: number;
}

/** Context passed to a per-frame light provider. */
export interface LightingFrameContext {
  /** Presented-frame counter since the layer was created. */
  frame: number;
  /** High-resolution timestamp in milliseconds. */
  timeMs: number;
  /** Native framebuffer width in pixels. */
  width: number;
  /** Native framebuffer height in pixels. */
  height: number;
}

/**
 * A material buffer aligned to the framebuffer: one RGBA texel per pixel with
 * R = normal-direction index (0..15), G = height (0..255 -> 0..HEIGHT_MAX),
 * B = specular strength, A = roughness. Optional — without it the layer lights
 * flat pixels (coloured, attenuated pools over the cart's own art).
 */
export type MaterialBuffer = Uint8Array;

/**
 * How the player relights a cartridge's frame. The host supplies the lights
 * (typically animated per frame) and, optionally, a material buffer to unlock
 * per-pixel normals, specular glints, and height-field shadows.
 */
export interface LightingOptions {
  /** Minimum brightness in shadow, 0..1. Default 0.16. */
  ambient?: number;
  /** Tint of the ambient floor, each channel 0..1. Default a cool dusk. */
  ambientColor?: readonly [number, number, number];
  /** Bloom the bright pixels (emissive + hot speculars). Default true. */
  bloom?: boolean;
  /** Cast height-field shadows. Needs a material buffer with height. Default false. */
  shadows?: boolean;
  /**
   * When true, a frame with no lights (neither cart- nor host-provided) is shown
   * unlit — the cart looks exactly as it would without lighting until it emits a
   * light. This is what lets the app enable lighting for every cart safely:
   * ordinary carts are untouched, lighting-aware carts light up on their own.
   * Default false (a frame with no lights is drawn at the ambient floor).
   */
  autoDetect?: boolean;
  /**
   * The per-pixel material buffer, or a provider called each frame. Omit to
   * light flat pixels.
   */
  material?: MaterialBuffer | ((context: LightingFrameContext) => MaterialBuffer | null);
  /**
   * Returns host-provided lights for a frame, called once per presented frame.
   * Optional: a cart can instead emit its own lights via `cartbox.light(...)`,
   * and when both are present they are combined. Omit both and the frame is lit
   * by ambient alone.
   */
  lights?: (context: LightingFrameContext) => readonly Light[];
}

/** A relightable scene handed to the renderer for a single frame. */
export interface LightingScene {
  lights: readonly Light[];
  ambient: number;
  ambientColor: readonly [number, number, number];
  bloom: boolean;
  shadows: boolean;
  /** Skip lighting entirely and present the albedo unchanged (see autoDetect). */
  unlit?: boolean;
}

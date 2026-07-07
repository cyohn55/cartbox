/**
 * Thumbnail render core.
 *
 * Given a loaded console, advances a few frames so animated title screens
 * settle, captures the framebuffer, upscales it, and encodes a PNG. The console
 * and the encoder are passed in (dependency injection), so this whole pipeline
 * is testable with a fake console and a trivial encoder — no WASM, no pngjs.
 */

import type { ConsoleInstance, ConsoleModel } from "@cartbox/player";

import { upscaleNearestNeighbor } from "./framebuffer.js";
import { encodePng } from "./png.js";

/** Frames advanced before capture — long enough for intro animations to settle. */
export const DEFAULT_WARMUP_FRAMES = 30;

/** Default integer upscale, so a 240x136 screen becomes a crisp 480x272 thumbnail. */
export const DEFAULT_UPSCALE = 2;

/** Neutral gamepad state used while warming up (no buttons held). */
const NO_INPUT = 0;

export interface RenderThumbnailOptions {
  /** Frames to advance before capturing. Defaults to {@link DEFAULT_WARMUP_FRAMES}. */
  warmupFrames?: number;
  /** Integer upscale factor. Defaults to {@link DEFAULT_UPSCALE}. */
  upscale?: number;
  /** Encoder to use. Defaults to PNG; injectable for testing. */
  encode?: (rgba: Uint8Array, width: number, height: number) => Buffer;
}

/**
 * Renders a cartridge thumbnail from a loaded console.
 *
 * @param console A console that already has a cartridge loaded.
 * @param model The console model, which provides the framebuffer dimensions.
 * @param options Warmup/scale/encoder overrides.
 * @returns Encoded image bytes (PNG by default).
 */
export function renderThumbnail(
  console: ConsoleInstance,
  model: ConsoleModel,
  options: RenderThumbnailOptions = {},
): Buffer {
  const warmupFrames = options.warmupFrames ?? DEFAULT_WARMUP_FRAMES;
  const upscale = options.upscale ?? DEFAULT_UPSCALE;
  const encode = options.encode ?? encodePng;

  if (!Number.isInteger(warmupFrames) || warmupFrames < 1) {
    throw new RangeError(`warmupFrames must be a positive integer, got ${warmupFrames}`);
  }

  for (let frame = 0; frame < warmupFrames; frame++) {
    console.tick(NO_INPUT);
  }

  const framebuffer = console.readFramebuffer();
  const scaled = upscaleNearestNeighbor(framebuffer, model.width, model.height, upscale);
  return encode(scaled, model.width * upscale, model.height * upscale);
}

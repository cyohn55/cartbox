/**
 * @deprecated Dimensions and timing are per-model now — see ./models.ts.
 *
 * These classic-model aliases remain only for backward compatibility, and derive
 * from the model registry so there is still a single source of truth.
 */

import { MODELS, framebufferBytes, frameDurationMs } from "./models.js";

const CLASSIC = MODELS.classic;

export const NATIVE_WIDTH = CLASSIC.width;
export const NATIVE_HEIGHT = CLASSIC.height;
export const BYTES_PER_PIXEL = CLASSIC.pixelBytes;
export const FRAMEBUFFER_BYTES = framebufferBytes(CLASSIC);
export const TARGET_FPS = CLASSIC.fps;
export const FRAME_DURATION_MS = frameDurationMs(CLASSIC);
export const DEFAULT_SAMPLE_RATE = CLASSIC.sampleRate;

/**
 * Console models. A model is a fixed hardware spec plus the WASM runtime that
 * runs it. Threading a model through the player/engine/replay/thumbnail paths
 * (instead of hard-coding 240x136 / 60fps) is what makes additional models —
 * Pro, Voxel — additive rather than a rewrite.
 *
 * Constraints stay fixed *per model*. There are deliberately no free-form
 * toggles: that would dissolve the aesthetic and break the fixed-spec
 * assumptions the platform layer depends on.
 */

export type ModelId = "classic" | "pro" | "voxel";

export interface ConsoleModel {
  id: ModelId;
  label: string;
  /**
   * Rasterizer family. Even a voxel3d model presents a 2D RGBA framebuffer for
   * display, so the player's blit path stays model-agnostic.
   */
  kind: "raster2d" | "voxel3d";
  width: number;
  height: number;
  /** Bytes per framebuffer pixel (RGBA = 4). */
  pixelBytes: number;
  /** Fixed frame rate (fixed-timestep loop). */
  fps: number;
  audioChannels: number;
  sampleRate: number;
  /** Editor-enforced creative limits (informational at runtime). */
  paletteSize: number;
  cartSizeBytes: number;
  /** Default runtime URL for this model; overridable per player instance. */
  engineUrl: string;
  inputs: Array<"gamepad" | "mouse" | "keyboard">;
}

export const MODELS: Record<ModelId, ConsoleModel> = {
  classic: {
    id: "classic",
    label: "Classic",
    kind: "raster2d",
    width: 240,
    height: 136,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 2,
    sampleRate: 44100,
    paletteSize: 16,
    cartSizeBytes: 64 * 1024,
    engineUrl: "/engine/classic/tic80.js",
    inputs: ["gamepad", "mouse", "keyboard"],
  },
  pro: {
    id: "pro",
    label: "Pro",
    kind: "raster2d",
    // 16:9 (640x360): scales to 1080p at exact 3x and 4K at 6x. Big enough that a
    // Classic cart (240x136) composites at pixel-perfect integer 2x (480x272)
    // pillarboxed inside with even 80px side / 44px top-bottom margins, rather
    // than being non-integer-scaled to fit. Both dimensions divide the 8px tile
    // grid (80x45 cells).
    width: 640,
    height: 360,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    // 64-color authoring palette (editor-enforced), 4x Classic's 16. The pro core's
    // framebuffer is 8bpp/256-capable (6bpp is not byte-aligned; see the engine
    // build note), so 64 is the creative limit, not a hardware cap.
    paletteSize: 64,
    cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/pro/engine.js",
    inputs: ["gamepad", "mouse", "keyboard"],
  },
  voxel: {
    id: "voxel",
    label: "Voxel",
    kind: "voxel3d",
    width: 320,
    height: 180,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    cartSizeBytes: 2 * 1024 * 1024,
    engineUrl: "/engine/voxel/engine.js",
    inputs: ["gamepad", "mouse"],
  },
};

/** Model used when a cart or caller does not specify one. */
export const DEFAULT_MODEL_ID: ModelId = "classic";

/**
 * Resolves a model by id. Accepts a plain string (e.g. a `console_model` value
 * from the database) and validates it.
 */
export function getModel(id: string = DEFAULT_MODEL_ID): ConsoleModel {
  const model = MODELS[id as ModelId];
  if (!model) {
    throw new Error(`Unknown console model: ${id}`);
  }
  return model;
}

/** Size of one framebuffer, in bytes, for a model. */
export function framebufferBytes(model: ConsoleModel): number {
  return model.width * model.height * model.pixelBytes;
}

/** Duration of one frame, in milliseconds, for a model. */
export function frameDurationMs(model: ConsoleModel): number {
  return 1000 / model.fps;
}

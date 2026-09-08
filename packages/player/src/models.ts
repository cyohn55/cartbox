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

export type ModelId = "classic" | "pro" | "portrait" | "voxel";

/**
 * How a model rasterises triangles.
 *
 * Display specs (width, palette, channels) distinguish the 2D models from each
 * other. They cannot distinguish the *era* models on the roadmap, which differ
 * almost entirely in rendering semantics: a PS1-era model is defined by having
 * no depth buffer and affine texture mapping, an N64-era model by trilinear
 * filtering and a 4KB texture cache. Those are the traits that make era content
 * look like its era, so they belong in the model descriptor beside the
 * resolution rather than inside a renderer.
 *
 * Every model carries these today because the mesh and world overlay surfaces
 * rasterise triangles over any model's framebuffer, whatever its `kind`. The
 * four shipping models therefore declare identical caps — they all run the same
 * software rasteriser. That is the point: the field exists so that adding an era
 * model is a descriptor change plus a renderer that honours it, not a fork of
 * the rendering path. See ERA_MODELS.md.
 */
export interface RenderCaps {
  /** False means painter's-algorithm sorting, so surfaces interpenetrate. */
  zBuffer: boolean;
  /** False means affine texture mapping — the PS1 texture warp. */
  perspectiveCorrect: boolean;
  textureFiltering: "none" | "bilinear" | "trilinear";
  /** Integer vertex coordinates produce the PS1 wobble. */
  vertexPrecision: "integer" | "float";
  /** Texture memory a frame may draw from; 0 means unbounded. */
  textureCacheBytes: number;
  /** Triangles submitted per frame; 0 means unbounded. */
  polyBudget: number;
  /**
   * Whether creators may supply their own shaders. True dissolves the
   * fixed-spec guarantee the platform layer relies on, so it stays false for
   * every fantasy-console model.
   */
  programmableShaders: boolean;
}

/**
 * What the shared software rasteriser behind the mesh/world overlays actually
 * does today: depth-buffered, perspective-correct, unfiltered, float vertices,
 * and unbounded because nothing enforces a ceiling. Era models override this.
 */
export const SOFTWARE_RASTER_CAPS: RenderCaps = {
  zBuffer: true,
  perspectiveCorrect: true,
  textureFiltering: "none",
  vertexPrecision: "float",
  textureCacheBytes: 0,
  polyBudget: 0,
  programmableShaders: false,
};

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
  /**
   * Bytes of content-addressed assets a cart on this model may reference,
   * beyond its cartridge. 0 means none: the cartridge is the whole cart.
   *
   * This is the constraint that lets a 3D era model exist at all. A textured
   * scene does not fit in a cartridge at any resolution, so an era model stores
   * its bulk beside the cart and references it by hash (see
   * `cartAssetStore.ts`). Keeping the allowance *per model* rather than global
   * is the same doctrine as every other limit here: an era model should pick a
   * budget that evokes its generation rather than reproducing a disc, and a
   * cartridge-only model should not silently acquire an asset store.
   */
  assetBudgetBytes: number;
  /** Default runtime URL for this model; overridable per player instance. */
  engineUrl: string;
  inputs: Array<"gamepad" | "mouse" | "keyboard">;
  /** Triangle-rasterisation semantics. See {@link RenderCaps}. */
  renderCaps: RenderCaps;
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
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0,
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
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0,
  },
  portrait: {
    id: "portrait",
    label: "Portrait",
    kind: "raster2d",
    // 9:16 (360x640) — the Pro spec turned on its side, for carts played the way
    // a handheld is actually held. Deliberately Pro's exact pixel count
    // (360*640 == 640*360), so the core reuses Pro's framebuffer and memory map
    // unchanged; only the two dimensions and the overscan buffer differ.
    // Both divide the 8px tile grid (45x80 cells).
    width: 360,
    height: 640,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 64,
    cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/portrait/engine.js",
    inputs: ["gamepad", "mouse", "keyboard"],
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0,
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
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0,
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

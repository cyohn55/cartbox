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

export type ModelId = "classic" | "pro" | "portrait" | "voxel" | "ps1" | "n64" | "xbox360" | "modern";

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

/**
 * The PS1 era, expressed as rasterisation rules.
 *
 * Every field here is an artefact people remember rather than a limitation to
 * be apologised for: no depth buffer means whole triangles sort back-to-front
 * and interpenetrating surfaces resolve wrongly; affine interpolation makes a
 * texture swim across a wall as the camera slides past it; integer vertices
 * give the wobble of a transform unit with no subpixel precision; and
 * unfiltered texels stay crunchy.
 *
 * The two budgets model the *cause* of the era's look rather than its
 * symptoms. A 64KB texture cache is one 256x256 8-bit page — the reason the
 * generation's textures are tiny and reused. The poly budget is roughly what
 * the hardware pushed per frame, and it is also why those games ran at 30fps;
 * this model stays at 60 and constrains the geometry instead, because the
 * frame rate was a consequence of the budget, not a design goal.
 */
export const PS1_RASTER_CAPS: RenderCaps = {
  zBuffer: false,
  perspectiveCorrect: false,
  vertexPrecision: "integer",
  textureFiltering: "none",
  textureCacheBytes: 64 * 1024,
  polyBudget: 3000,
  programmableShaders: false,
};

/**
 * The N64 era, expressed as rasterisation rules.
 *
 * Where the PS1 is defined by what it lacked, the N64 is defined by what it
 * added and then starved: it has the depth buffer, perspective-correct texturing
 * and floating-point vertices the PS1 lacked — so its geometry is stable and its
 * surfaces resolve correctly — but it drew every texel through a **4KB texture
 * cache**. That one number is the whole era's look. It is why N64 textures are
 * so small, so heavily tiled, and so soft: there was almost no room to hold
 * them, and what did fit was trilinear-filtered into the blur the generation is
 * remembered for. See ERA_MODELS.md's PS1/N64 table.
 *
 * The 4KB cache is enforced for real (see `fitTextureToBudget`, whose box-filter
 * halving is exactly what a too-small cache did to a texture). Trilinear maps to
 * bilinear until a mip chain exists on both backends; `rasterStyleFor` documents
 * why that mapping is deliberate rather than a shortcut. Fog — the era's other
 * signature, used to hide a short draw distance — is not modelled yet; it is a
 * rasteriser feature with no cap field, noted in ERA_MODELS.md rather than
 * pretended here.
 */
export const N64_RASTER_CAPS: RenderCaps = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "trilinear",
  textureCacheBytes: 4 * 1024,
  polyBudget: 7000,
  programmableShaders: false,
};

/**
 * The Xbox 360 tier — the generation where the spec stopped constraining the
 * look.
 *
 * This is the honest outlier in the family, and ERA_MODELS.md says so plainly:
 * the 360's defining feature is **programmable shaders**, so there is no
 * fixed-function ceiling to enforce and therefore no era artefact to reproduce.
 * It is a general engine wearing a console costume. What its caps encode is not
 * a set of limitations but their absence: a depth buffer, perspective-correct
 * filtered texturing, float vertices, and both budgets unbounded.
 *
 * `programmableShaders` stays `false` on purpose. The trait is the tier's whole
 * point, but no shader-authoring surface exists yet, so today a 360 cart renders
 * on the same fixed modern path as a high-end N64 one — and the platform's
 * fixed-spec guarantee (replays, verification, thumbnails) still holds for every
 * shipping model. Setting the flag now would claim a capability nothing consumes
 * and dissolve that guarantee for no gain. The flag flips the day the shader
 * pipeline lands; until then it is the tier's real remaining work, tracked in
 * ERA_MODELS.md rather than pretended here.
 */
export const XBOX360_RASTER_CAPS: RenderCaps = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "trilinear",
  textureCacheBytes: 0,
  polyBudget: 0,
  programmableShaders: false,
};

/**
 * The Modern (AAA) tier — the top of the family, where the goal flips from
 * *reproducing* era limits to *removing* them: an uncapped, physically-based,
 * WebGPU-lit path for photoreal-leaning web games, alongside (never replacing)
 * the fantasy-console tiers. See AAA_TIER_ROADMAP.md.
 *
 * `programmableShaders` is `true` here — unlike the 360 tier, which keeps it
 * `false` because it renders on the fixed path. The Modern tier's whole premise
 * is a programmable PBR pipeline, so the flag asserts the capability the tier
 * exists to provide. Everything else is unbounded: no poly budget, no texture
 * cache, float vertices, perspective-correct filtered texturing.
 */
export const MODERN_RASTER_CAPS: RenderCaps = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "trilinear",
  textureCacheBytes: 0,
  polyBudget: 0,
  programmableShaders: true,
};

export interface ConsoleModel {
  id: ModelId;
  label: string;
  /**
   * Rasterizer family. Every model presents a 2D RGBA framebuffer for display,
   * whatever it draws into it, so the player's blit path stays model-agnostic.
   *
   * `poly3d` is a model whose games are textured triangle scenes: the core
   * still supplies the 2D frame, script and sound, and the mesh/world overlays
   * composite the 3D over it. The editor uses this to decide whether the
   * spatial authoring tabs apply.
   */
  kind: "raster2d" | "voxel3d" | "poly3d";
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
    // The classic core ships at /engine/tic80.js (not a /classic/ subdirectory
    // like the later models). The web app already loads it from here via
    // ENGINE_URL_BY_MODEL; this default was pointing at a path that has never
    // existed, so any caller that mounted a classic cart without an explicit
    // engineUrl override got a 404.
    engineUrl: "/engine/tic80.js",
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
    // No voxel core is built yet, so /engine/voxel/engine.js does not exist —
    // pointing here would 404. Fall back to the classic core, matching the web
    // app's ENGINE_URL_BY_MODEL, which is why voxel is not offered as a
    // selectable model. Replace this with the real core once it is built.
    engineUrl: "/engine/tic80.js",
    inputs: ["gamepad", "mouse"],
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0,
  },
  ps1: {
    id: "ps1",
    label: "PS1",
    kind: "poly3d",
    // 320x240, the era's NTSC frame. 4:3 rather than the 16:9 the Pro models
    // use, because the aspect ratio is as much a period signal as the pixels:
    // a 16:9 PS1 game would read as a remaster.
    width: 320,
    height: 240,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    // 8-bit CLUT textures were the era's workhorse (4-bit for the rest), so 256
    // is authentic rather than a compromise.
    paletteSize: 256,
    // The cartridge carries code, 2D art and sound. Geometry and textures do
    // not live here — they go to the content-addressed asset store, which is
    // the whole reason a 3D era model is possible at all.
    cartSizeBytes: 2 * 1024 * 1024,
    engineUrl: "/engine/ps1/engine.js",
    inputs: ["gamepad", "keyboard"],
    renderCaps: PS1_RASTER_CAPS,
    // A CD-ROM, because that is what the era's games shipped on. The disc is
    // the defining physical fact about this generation — it is why its games
    // have full-motion video, streamed audio and textured worlds at all, where
    // the cartridge eras did not.
    //
    // The alternative was a smaller figure chosen to keep pressure on the
    // artist. That would be inventing a constraint the hardware did not have,
    // which is the opposite of how every other number in this file was picked:
    // the frame is 320x240 because that is the frame, and the texture cache is
    // 64KB because that is the page. The budget follows the same rule.
    //
    // The pressure that shaped the era's art comes from the caps above — a
    // 64KB texture page and a 3,000-triangle frame — not from disc capacity.
    // Those bind on every frame; the disc only ever bound on the whole game.
    assetBudgetBytes: 660 * 1024 * 1024,
  },
  n64: {
    id: "n64",
    label: "N64",
    kind: "poly3d",
    // 320x240, the era's common output. The N64 shared the PS1's resolution;
    // what separated the generations was rendering, not pixels, so the
    // difference lives entirely in renderCaps below — a z-buffer, perspective
    // correction, filtering, and the 4KB texture cache — not in this number.
    width: 320,
    height: 240,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    // Code, 2D HUD art and sound. Geometry and textures live in the asset store.
    cartSizeBytes: 4 * 1024 * 1024,
    engineUrl: "/engine/n64/engine.js",
    inputs: ["gamepad", "keyboard"],
    renderCaps: N64_RASTER_CAPS,
    // A cartridge, not a disc — 64MB, the largest the generation shipped. This
    // is the era-true inverse of the PS1: better rendering, an order of
    // magnitude *less* storage. The tiny cartridge and the 4KB texture cache
    // pull the same direction — small, heavily-reused textures — from storage
    // and from fill respectively.
    assetBudgetBytes: 64 * 1024 * 1024,
  },
  xbox360: {
    id: "xbox360",
    label: "Xbox 360",
    kind: "poly3d",
    // 1280x720 — the generation's signature output, and the first in this family
    // that is HD. This is why it needs its own core binary: the framebuffer and
    // the core's per-frame draw buffers are sized from these compile-time
    // constants (see build-xbox360-wasm.sh).
    width: 1280,
    height: 720,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    cartSizeBytes: 8 * 1024 * 1024,
    engineUrl: "/engine/xbox360/engine.js",
    inputs: ["gamepad", "keyboard"],
    renderCaps: XBOX360_RASTER_CAPS,
    // 2GB — Xbox Live Arcade's final size ceiling, the closest thing the 360 had
    // to a fixed content budget (the doctrine wants a number that evokes the era,
    // and a 360 disc's ~7.9GB is neither web-sane nor how most of this content
    // shipped). Large, because this is the tier where storage genuinely stops
    // being the constraint — which is the whole point ERA_MODELS.md makes about
    // it not being console-shaped.
    assetBudgetBytes: 2 * 1024 * 1024 * 1024,
  },
  modern: {
    id: "modern",
    label: "Modern (AAA)",
    kind: "poly3d",
    // 1080p output — the target for a modern, PBR-lit web title. The stub reuses
    // the 360 core binary (its framebuffer scales), so a dedicated core is not
    // required to prototype the tier; see AAA_TIER_ROADMAP.md Phase 1.
    width: 1920,
    height: 1080,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 48000,
    paletteSize: 256,
    cartSizeBytes: 8 * 1024 * 1024,
    // Stub: reuse the 360 core until a dedicated Modern core lands (Phase 1).
    engineUrl: "/engine/xbox360/engine.js",
    inputs: ["gamepad", "keyboard", "mouse"],
    renderCaps: MODERN_RASTER_CAPS,
    // 8GB — this tier's whole premise is that storage is no longer the constraint;
    // real photoreal scenes need room for compressed meshes + PBR texture sets.
    assetBudgetBytes: 8 * 1024 * 1024 * 1024,
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

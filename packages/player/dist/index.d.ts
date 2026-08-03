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
type ModelId = "classic" | "pro" | "portrait" | "voxel";
interface ConsoleModel {
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
declare const MODELS: Record<ModelId, ConsoleModel>;
/** Model used when a cart or caller does not specify one. */
declare const DEFAULT_MODEL_ID: ModelId;
/**
 * Resolves a model by id. Accepts a plain string (e.g. a `console_model` value
 * from the database) and validates it.
 */
declare function getModel(id?: string): ConsoleModel;
/** Size of one framebuffer, in bytes, for a model. */
declare function framebufferBytes(model: ConsoleModel): number;
/** Duration of one frame, in milliseconds, for a model. */
declare function frameDurationMs(model: ConsoleModel): number;

/**
 * Deterministic replays.
 *
 * A fantasy console is deterministic — fixed timestep, a host-controlled clock,
 * and a per-frame gamepad bitmask. So a full session is captured by recording
 * the input stream plus enough to reproduce initial state (cart identity + RNG
 * seed). Replaying feeds the same inputs back into a fresh console.
 *
 * Input rarely changes every frame, so the stream is run-length encoded: an
 * entry is stored only when the mask changes. This module is pure (no DOM, no
 * engine), so the recorder/playback machinery is fully unit-testable and can run
 * server-side for score verification.
 *
 * NOTE: bit-exact *engine* reproduction additionally requires the cart's RNG to
 * be seeded from `seed`. The host-side machinery here is complete; wiring the
 * seed into the engine shim (a `cbx_seed`) is the remaining determinism step.
 */

/** Bumped when the serialized shape changes incompatibly. */
declare const REPLAY_VERSION = 1;
/** A fresh non-negative 31-bit seed for a new recording. */
declare function randomSeed(): number;
/** A change in the gamepad bitmask, effective from `frame` onward. */
interface InputChange {
    frame: number;
    mask: number;
}
/** A recorded session. */
interface Replay {
    version: number;
    modelId: ModelId;
    /** Identity of the cart this was recorded against (see {@link hashCart}). */
    cartHash: string;
    seed: number;
    frameCount: number;
    /** Run-length input stream: one entry per mask change. */
    inputs: InputChange[];
}
/** Metadata needed to start a recording. */
interface ReplayMeta {
    modelId: ModelId;
    cartHash: string;
    seed?: number;
}
/** Raised when a serialized replay cannot be parsed or is the wrong version. */
declare class ReplayError extends Error {
    constructor(message: string);
}
/**
 * Records the per-frame input stream as run-length input changes. Call
 * {@link record} exactly once per ticked frame with that frame's gamepad mask.
 */
declare class ReplayRecorder {
    private readonly meta;
    private readonly inputs;
    private frame;
    private lastMask;
    constructor(meta: ReplayMeta);
    record(mask: number): void;
    get frameCount(): number;
    /** Produces the immutable replay captured so far. */
    finish(): Replay;
}
/**
 * Reconstructs the per-frame mask from a recorded input stream. Designed for
 * linear playback (frames queried in order); querying an earlier frame rewinds
 * and re-scans, so seeking still works, just not in constant time.
 */
declare class ReplaySource {
    private readonly inputs;
    private cursor;
    private currentMask;
    private lastFrame;
    constructor(inputs: InputChange[]);
    /** The gamepad mask effective at the given frame. */
    maskForFrame(frame: number): number;
}
/**
 * Stable, non-cryptographic identity hash of cart bytes (FNV-1a, 32-bit). Used
 * to confirm a replay is being applied to the same cartridge it was recorded on.
 */
declare function hashCart(bytes: Uint8Array): string;
/** Serializes a replay to a compact JSON string. */
declare function serializeReplay(replay: Replay): string;
/** Parses and validates a serialized replay. */
declare function parseReplay(json: string): Replay;

/**
 * Public types for the player's dynamic lighting layer. Kept DOM-free so hosts
 * and tests can build lighting scenes without importing the renderer.
 */
/**
 * How a light casts. Defaults to "point" everywhere it is omitted, so a bare
 * `{x, y, z, color, radius}` keeps meaning exactly what it always has.
 *
 * - `point`       an omnidirectional pool at (x, y, z), fading to nothing at `radius`.
 * - `directional` a distant key (sun / moon): parallel rays with no falloff, so
 *                 x/y/z and radius are ignored and only `direction` and `color`
 *                 matter. This is the sun/moon shaft central to the cinematic look.
 * - `spot`        a cone from (x, y, z) opening along `direction`, gated by
 *                 `coneCos` and attenuated by `radius` like a point light.
 */
type LightKind = "point" | "directional" | "spot";
/** A coloured light positioned over the console framebuffer. */
interface Light {
    /** Column in native framebuffer pixels (0 = left). Ignored for directional. */
    x: number;
    /** Row in native framebuffer pixels (0 = top). Ignored for directional. */
    y: number;
    /** Height above the surface, in pixel units; larger = a broader, softer pool. */
    z: number;
    /** Light colour; each channel is a multiplier (may exceed 1 for a hot light). */
    color: readonly [number, number, number];
    /** Reach in pixels; brightness falls to zero at this distance. Ignored for directional. */
    radius: number;
    /** Cast type. Omit for a point light (the historical default). */
    kind?: LightKind;
    /**
     * Unit direction, meaning per kind:
     * - directional: the direction that points *toward* the light (where the sun is).
     * - spot: the cone axis — the direction the beam travels.
     * Its z component is taken as non-negative (a light on the viewer's side of the
     * scene); the runtime derives it when a producer only supplies x and y.
     * Ignored for point lights.
     */
    direction?: readonly [number, number, number];
    /**
     * Spot cone: cosine of the inner (full-bright) half-angle, 0..1. A fixed
     * softness feathers the edge to zero just outside it. Ignored unless spot.
     */
    coneCos?: number;
}
/** Context passed to a per-frame light provider. */
interface LightingFrameContext {
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
type MaterialBuffer = Uint8Array;
/**
 * How the player relights a cartridge's frame. The host supplies the lights
 * (typically animated per frame) and, optionally, a material buffer to unlock
 * per-pixel normals, specular glints, and height-field shadows.
 */
interface LightingOptions {
    /** Minimum brightness in shadow, 0..1. Default 0.16. */
    ambient?: number;
    /** Tint of the ambient floor, each channel 0..1. Default a cool dusk. */
    ambientColor?: readonly [number, number, number];
    /** Bloom the bright pixels (emissive + hot speculars). Default true. */
    bloom?: boolean;
    /** Cast height-field shadows. Needs a material buffer with height. Default false. */
    shadows?: boolean;
    /**
     * Bilinearly interpolate the per-pixel normals instead of using the raw
     * 16-direction quantised value. Kills the facet banding that betrays the
     * discrete normal palette on curved surfaces (cinematic gap #2). A no-op on
     * flat/unmapped materials, whose normals are uniform. Default true.
     */
    smoothNormals?: boolean;
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
interface LightingScene {
    lights: readonly Light[];
    ambient: number;
    ambientColor: readonly [number, number, number];
    bloom: boolean;
    shadows: boolean;
    /** Bilinearly interpolate the quantised normals to remove facet banding. */
    smoothNormals?: boolean;
    /** Skip lighting entirely and present the albedo unchanged (see autoDetect). */
    unlit?: boolean;
}

/**
 * Event mailbox decoder (Platform P2).
 *
 * Carts emit platform events (achievements, scores, stats) by writing to a
 * reserved slice of persistent memory via the cartbox SDK. The engine exposes
 * that slice as u32 words; this module decodes new events since the last read.
 *
 * The reserved window is 64 pmem words, shared by two sub-protocols:
 *
 *   Events (words 0..24): word[0] is a monotonic sequence counter; words 1..24
 *   are a ring of {@link EVENT_CAPACITY} 3-word records {type, id, value}. The
 *   host reads the ring every tick, so a small capacity is plenty. A burst that
 *   overflows the ring drops the oldest rather than reading stale data.
 *
 *   Lights (words 25..61): word[25] is a light count; each of up to
 *   {@link LIGHTS_CAPACITY} records is {@link LIGHT_STRIDE} words
 *   {x, y, z, radius, packedRGB, intensity*256}. Unlike events, lights are
 *   per-frame *state*: the cart rewrites the whole block each tick (clear + add),
 *   and the host reads the latest set to relight the frame.
 *
 *   Camera (words 62..63): the parallax-scene backdrop position a cart publishes
 *   via `cartbox.camera(x, y)`, so a gameplay-driven backdrop can pan instead of
 *   only auto-scrolling. Like lights it is per-frame state: two signed
 *   fixed-point words (× {@link CAMERA_SCALE}) for x and y. An unset camera reads
 *   as (0, 0), which adds nothing to the scene's own auto-scroll.
 *
 * This module is pure — no engine, no DOM — so the protocol is unit-testable.
 */

declare const MAILBOX_TYPE_ACHIEVEMENT = 1;
declare const MAILBOX_TYPE_SCORE = 2;
declare const MAILBOX_TYPE_PROGRESS = 3;
/** Total reserved pmem words (mirrors CBX_MAILBOX_WORDS in the engine shim). */
declare const MAILBOX_WORDS = 64;
/** Event ring capacity. Small on purpose: the host drains the ring every tick. */
declare const EVENT_CAPACITY = 8;
/** Word index of the light-count header (just past the event ring). */
declare const LIGHTS_BASE: number;
/** Maximum cart-emitted lights (matches the renderer's light limit). */
declare const LIGHTS_CAPACITY = 6;
/** Words per light record: x, y, z, radius, packedRGB, intensity*256. */
declare const LIGHT_STRIDE = 6;
/** Word index of the cart-published parallax camera, just past the lights block. */
declare const CAMERA_BASE: number;
/**
 * Fixed-point scale for the camera's x/y, stored as signed 32-bit words. 16 gives
 * sub-pixel panning (parallax factors scale it further) with a range of ±134M px
 * — far beyond any cart world.
 */
declare const CAMERA_SCALE = 16;
type MailboxEventKind = "achievement" | "score" | "progress" | "unknown";
interface MailboxEvent {
    kind: MailboxEventKind;
    /** Raw numeric type code. */
    type: number;
    /** Hashed string id (see {@link hashEventId}); 0 for score events. */
    id: number;
    /** Event payload (e.g. the score). */
    value: number;
}
interface MailboxRead {
    events: MailboxEvent[];
    /** The sequence counter to remember for the next read. */
    seq: number;
}
/**
 * Decodes new events from the mailbox words.
 *
 * @param words The mailbox region (word[0] = sequence counter).
 * @param lastSeq The sequence counter from the previous read.
 * @returns The new events and the sequence to remember next time.
 */
declare function decodeMailbox(words: Uint32Array, lastSeq: number): MailboxRead;
/**
 * Decodes the lights a cart wrote this frame via `cartbox.light(...)`.
 *
 * Lights are per-frame state, not events: the block always holds the latest set
 * the cart published, so there is no sequence to track. Colours are stored as a
 * packed 0xRRGGBB word scaled by a fixed-point intensity; here they become the
 * renderer's per-channel multipliers.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 * @returns The decoded lights, clamped to {@link LIGHTS_CAPACITY}.
 */
declare function decodeLights(words: Uint32Array): Light[];
/** A backdrop camera position in cart pixels. */
interface MailboxCamera {
    x: number;
    y: number;
}
/**
 * Decodes the parallax-scene camera a cart published this frame via
 * `cartbox.camera(x, y)`.
 *
 * The two words are signed fixed-point: reinterpreted from u32 to int32 (`| 0`)
 * and divided by {@link CAMERA_SCALE}. A cart that never calls `cartbox.camera`
 * leaves the words zero, so this returns (0, 0) — which the scene adds to its own
 * auto-scroll, leaving auto-scroll-only carts unchanged.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 */
declare function decodeCamera(words: Uint32Array): MailboxCamera;
/**
 * FNV-1a 32-bit hash of a string event id. Mirrors the hash in the cartbox SDK
 * so the platform can map a mailbox id back to the achievement/stat key.
 */
declare function hashEventId(id: string): number;

/**
 * Data-driven post-processing effect model, shared by the editor's FX tab and
 * the runtime player. Each effect declares its parameters (with ranges and
 * defaults); UIs render them generically and `uniformsFromSettings` folds the
 * whole stack into the flat uniform block the shader consumes — a disabled
 * effect collapses to its neutral value, so the shader needs no per-effect
 * branching and never recompiles.
 *
 * DOM-free so server code (the save API validates with `parsePostFxSettings`)
 * and tests consume it without a browser.
 *
 * The stack divides into two halves. The first seven effects are the console's
 * own signal path — the grade, the tube, the lens. The rest are screen-space
 * looks ported from the Shade Studio shader library, chosen for being
 * single-pass (the no-recompile design has no room for a second target) and for
 * suiting pixel art rather than fighting it: ordered dithering and halftone are
 * how a small palette fakes a gradient, and light shafts and streaks are how a
 * flat 2D scene suggests a light source it cannot actually cast.
 */
type PostFxEffectId = "grade" | "fog" | "bloom" | "tonemap" | "crt" | "chroma" | "vignette" | "posterize" | "dither" | "halftone" | "godrays" | "streaks" | "splittone" | "reflection" | "tiltshift" | "kaleidoscope" | "grain";
interface PostFxParamDef {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
}
/** A colour an effect exposes, e.g. the fog tint or a split-tone end. */
interface PostFxColorDef {
    id: string;
    label: string;
    /** #rrggbb. */
    defaultValue: string;
}
interface PostFxEffectDef {
    id: PostFxEffectId;
    label: string;
    description: string;
    params: PostFxParamDef[];
    /** Colour pickers this effect exposes, if any. */
    colors?: PostFxColorDef[];
}
declare const POST_FX_EFFECTS: PostFxEffectDef[];
/** Key for one parameter's (or colour's) value in the settings map. */
declare function paramKey(effect: PostFxEffectId, param: string): string;
interface PostFxSettings {
    enabled: Record<PostFxEffectId, boolean>;
    values: Record<string, number>;
    /** Effect colours as #rrggbb, keyed by {@link paramKey}. */
    colors: Record<string, string>;
}
declare function defaultPostFxSettings(): PostFxSettings;
/** Whether any effect in the stack is switched on. */
declare function anyPostFxEnabled(settings: PostFxSettings): boolean;
/**
 * Validate untrusted JSON (a PUT body or a jsonb column) into PostFxSettings,
 * or null when malformed. Lenient about omissions — unknown effects/params are
 * dropped and missing ones take their defaults, so the wire format survives
 * adding effects later — but strict about types and ranges, clamping values
 * into each parameter's declared bounds.
 *
 * A top-level `fogColor` string is still honoured: rows written before effects
 * could declare their own colours carry the fog tint there, and silently losing
 * an artist's fog colour on the next save would be a worse outcome than one
 * branch here.
 */
declare function parsePostFxSettings(value: unknown): PostFxSettings | null;
/** The flat uniform block the post-process shader consumes. */
interface PostFxUniforms {
    brightness: number;
    contrast: number;
    saturation: number;
    fogDensity: number;
    fogHorizon: number;
    fogColor: [number, number, number];
    bloomStrength: number;
    bloomThreshold: number;
    /** Pyramid spread, 0..1: how much the coarse blur levels contribute. */
    bloomRadius: number;
    /** 0 leaves the frame in gamma space; 1 applies the ACES filmic rolloff. */
    toneMap: number;
    /** Pre-tonemap exposure multiplier (only read when {@link toneMap} is on). */
    exposure: number;
    curvature: number;
    scanlines: number;
    aberration: number;
    vignette: number;
    /** 0 disables posterisation; otherwise the level count. */
    posterize: number;
    ditherAmount: number;
    ditherScale: number;
    halftoneStrength: number;
    halftoneScale: number;
    /** Screen angle in radians. */
    halftoneAngle: number;
    godrayStrength: number;
    godrayDensity: number;
    godrayDecay: number;
    godrayOrigin: [number, number];
    streakStrength: number;
    streakLength: number;
    splitStrength: number;
    splitBalance: number;
    splitShadows: [number, number, number];
    splitHighlights: [number, number, number];
    /** Wet-floor reflection strength (0 disables the mirror). */
    reflectionStrength: number;
    /** Screen row of the reflective surface's near edge, 0..1. */
    reflectionHorizon: number;
    /** How far below the horizon the reflection persists, in screen-height units. */
    reflectionFalloff: number;
    /** Sideways ripple amplitude of the reflection. */
    reflectionWobble: number;
    /** Tilt-shift max blur (0 disables the depth of field). */
    tiltStrength: number;
    /** Centre row of the in-focus band, 0..1. */
    tiltFocus: number;
    /** Half-height of the fully-sharp band, in screen-height units. */
    tiltRange: number;
    /** Below 2 the shader leaves the frame alone. */
    kaleidoSegments: number;
    /** Rotation in radians. */
    kaleidoAngle: number;
    grainAmount: number;
    grainSize: number;
}
/** Parse #rrggbb into a 0..1 RGB triplet. */
declare function hexToRgb01(hex: string): [number, number, number];
/**
 * Fold the settings into shader uniforms. Disabled effects map to their
 * neutral values (identity grade, zero density/strength), so toggling an
 * effect never needs a shader recompile.
 */
declare function uniformsFromSettings(settings: PostFxSettings): PostFxUniforms;

/**
 * Gap #3 — a runtime parallax + atmosphere compositor.
 *
 * The editor already has a preview-only layered-scene compositor
 * (packages/editor/src/render/layeredScene.ts) with parallax projection, but no
 * *aerial perspective*: the thing that makes REPLACED / THE LAST NIGHT read as
 * deep space rather than stacked stickers — distant layers go dimmer, bluer,
 * lower-contrast and haze toward the sky. Carts hand-roll parallax scroll in Lua
 * today; the atmosphere is the hard part they can't easily fake.
 *
 * This module is the reusable core of the runtime system: pure, DOM-free,
 * RGBA-in / RGBA-out (same shape as renderLitRgba / the editor compositor), so it
 * can be unit-tested and later driven by a cart-facing SDK/sidecar and composited
 * ahead of the lighting + post-FX passes. Intended app home:
 * packages/player/src/scene/parallaxScene.ts.
 */
type Rgb$1 = readonly [number, number, number];
/** One depth layer of the scene. */
interface ParallaxLayer {
    /** Straight-alpha RGBA pixels, width*height*4 bytes. */
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    /**
     * Depth, 0 (nearest, on the camera plane) .. 1 (farthest, at the horizon).
     * Drives both how little the layer parallaxes and how much atmosphere it takes.
     */
    depth: number;
    /**
     * How much the layer shifts with the camera: 1 = locked to the world (full
     * parallax), 0 = locked to the screen. Defaults to `1 - depth` so near layers
     * slide under far ones without the author computing anything.
     */
    parallax?: number;
    /** Tile the layer horizontally when the camera scrolls past its edge. Default true. */
    wrapX?: boolean;
    /** Vertical placement in the output, in pixels (align a horizon). Default 0. */
    offsetY?: number;
    /**
     * Horizontal placement in the output, in pixels, ADDED to the parallax shift.
     * Default 0. Lets a layer drift independently of the camera (e.g. animated fog).
     */
    offsetX?: number;
    /** Layer-wide alpha multiplier, 0..1. Default 1 (fully as authored). */
    opacity?: number;
    /**
     * Layer-wide RGB gain. Default 1. Values > 1 brighten the layer's contribution
     * (an animated emissive glow), which the post-FX bloom pass then picks up.
     */
    emissive?: number;
    /**
     * The aerial-perspective haze is already baked into {@link pixels} (see
     * {@link prehazeLayers}), so compositing must not apply it again. A layer's haze
     * is frame-invariant — it depends only on the layer's depth and the scene
     * atmosphere — so the runtime bakes it once and skips it in the per-frame loop.
     */
    hazed?: boolean;
}
/** Aerial-perspective parameters, shared by the whole scene. */
interface AtmosphereParams {
    /** The haze/sky colour distance fades toward (each channel 0..255). */
    fog: Rgb$1;
    /** 0..1 — how strongly the farthest layer is pulled toward `fog`. */
    density: number;
    /** 0..1 — how much colour the farthest layer loses (aerial desaturation). */
    desaturate: number;
    /** 0..1 — how much the farthest layer's contrast flattens (haze lifts blacks). */
    lift: number;
}
/** The camera, in world pixels; only its offset matters for parallax. */
interface ParallaxCamera {
    x: number;
    y: number;
}
/**
 * Bake each layer's aerial-perspective haze into its pixels once, returning new
 * layers flagged {@link ParallaxLayer.hazed} so {@link composeParallax} skips the
 * per-pixel haze in the hot path.
 *
 * A layer's haze depends only on its depth and the (constant) atmosphere, so it
 * is identical every frame — computing it once here instead of per pixel per
 * frame is what keeps an N-layer scene inside the 60fps budget. The input layers
 * are not mutated; a layer that takes no haze is returned with its pixels shared.
 */
declare function prehazeLayers(layers: readonly ParallaxLayer[], atmosphere: AtmosphereParams): ParallaxLayer[];
/**
 * Composite parallax layers into `out` (outW×outH RGBA), far to near, applying
 * per-layer aerial perspective by depth. `out` should already hold the sky /
 * clear colour; layers blend over it by their own alpha.
 *
 * Parallax: a layer shifts by `-camera * parallaxOf(layer)`, so the nearest
 * layers slide fastest. Horizontal wrap tiles a layer seamlessly; vertical uses
 * `offsetY` and clips.
 */
declare function composeParallax(out: Uint8ClampedArray, outW: number, outH: number, layers: readonly ParallaxLayer[], camera: ParallaxCamera, atmosphere: AtmosphereParams): void;

/**
 * Gap #3 part 2 — the cart-facing `scene` model.
 *
 * A cart declares a parallax scene the way it declares fx / rig / materials:
 * a JSON sidecar validated on load. Each layer points at a region of the cart's
 * OWN sprite sheet (authored in the editor), sits at a depth, and the runtime
 * composites the layers with parallax scroll + aerial-perspective atmosphere
 * (see parallaxScene.ts) BEHIND the cart's interactive foreground. This is what
 * turns "hand-roll parallax + fake haze in Lua" into "author art, declare depth".
 *
 * This module is the pure, DOM-free data + validation half (mirrors the defensive
 * parse style of apps/web/src/lib/rig.ts): parse untrusted JSON into a safe
 * SceneSpec, dropping anything malformed rather than throwing. The rendering half
 * is sceneRender.ts. Intended app homes: apps/web/src/lib/scene.ts (parse) +
 * packages/player/src/scene/ (render).
 */

/** A region of the sprite sheet backing one parallax layer. */
interface SpriteRegion {
    /** Sprite page: 0 (fg) or 1 (bg). */
    page: 0 | 1;
    /** Top-left tile index of the region within the page. */
    tile: number;
    /** Region size in tiles. */
    tilesW: number;
    tilesH: number;
}
/** One declared parallax layer. */
interface SceneLayer {
    source: SpriteRegion;
    /** 0 (nearest) .. 1 (horizon) — drives parallax factor + atmosphere. */
    depth: number;
    /** Optional explicit parallax factor (else derived from depth). */
    parallax?: number;
    /** Tile horizontally as the camera scrolls. Default true. */
    wrapX?: boolean;
    /** Vertical placement in the backdrop, in pixels. Default 0. */
    offsetY?: number;
}
/** How the scene camera moves each frame. */
interface SceneCamera {
    /** Auto-scroll in px/frame (a living backdrop with no cart input). Default 0. */
    autoScrollX?: number;
    autoScrollY?: number;
}
/** A full declared scene. */
interface SceneSpec {
    layers: SceneLayer[];
    atmosphere: AtmosphereParams;
    camera: SceneCamera;
    /**
     * The palette index the cart leaves as "background": the runtime shows the
     * parallax backdrop through every pixel the cart drew in this colour, and keeps
     * the rest as the cart's own foreground. Default 0 (TIC-80's conventional
     * background colour).
     */
    keyColor: number;
}
/** The default atmosphere — a cool dusk haze, if a cart omits it. */
declare const DEFAULT_ATMOSPHERE: AtmosphereParams;
/**
 * Parse untrusted sidecar JSON into a SceneSpec, or null when there is no usable
 * scene (no object, or every layer malformed). Layers are validated individually
 * and bad ones dropped — losing one layer beats refusing the whole backdrop.
 */
declare function parseScene(raw: unknown): SceneSpec | null;

/**
 * Cinematic gap #1 (animation timeline) — the cart-facing `anim` model.
 *
 * A cart declares ambient motion the way it declares fx / scene / rig: a JSON
 * sidecar validated on load. The runtime plays it back host-side from the frame
 * clock (no cart Lua, no mailbox words — the mailbox is full), which is exactly
 * what the REPLACED / THE LAST NIGHT look needs: flickering neon, drifting fog,
 * a guttering candle, idle sway. See Working/cinematic-artstyle/anim-timeline-spec.md.
 *
 * This module is the pure, DOM-free data + validation half (mirrors the defensive
 * parse style of scene/sceneModel.ts + apps/web/src/lib/rig.ts): parse untrusted
 * JSON into a safe AnimSpec, dropping anything malformed rather than throwing. The
 * playback half is animPlayer.ts. Intended app homes: apps/web/src/lib/anim.ts
 * (parse) + packages/player/src/anim/ (playback).
 */

/** How a sprite clip repeats. */
type AnimMode = "loop" | "pingpong" | "once";
/** How a property track repeats past its key range. */
type TrackMode = "loop" | "pingpong" | "hold";
/** Interpolation on the segment beginning at a keyframe. */
type Ease = "linear" | "step" | "smooth";
/** A named sprite-frame animation drawn from the cart's own sheet. */
interface AnimClip {
    name: string;
    /** Ordered frames; each a region of the sprite sheet. */
    frames: SpriteRegion[];
    /** Ticks each frame is held; always aligned 1:1 with `frames`. */
    durations: number[];
    mode: AnimMode;
}
/** One control point on a property track. */
interface Keyframe {
    /** Tick position (>= 0). */
    t: number;
    value: number;
    /** Ease applied from this key to the next. */
    ease: Ease;
}
/** Channels a track can drive on a parallax scene layer (by index). */
type LayerChannel = "opacity" | "offsetX" | "offsetY" | "emissive";
/** Channels a track can drive on a foreground placement (by index). */
type PlacementChannel = "x" | "y" | "opacity" | "scale";
/** What a track animates. Loosely coupled: scene layers are addressed by index. */
type AnimTarget = {
    kind: "sceneLayer";
    index: number;
    channel: LayerChannel;
} | {
    kind: "postfx";
    key: string;
} | {
    kind: "placement";
    index: number;
    channel: PlacementChannel;
};
/** A keyframed scalar curve bound to one target channel. */
interface AnimTrack {
    target: AnimTarget;
    /** Sorted ascending by `t`; at least one key. */
    keys: Keyframe[];
    mode: TrackMode;
    /** Loop period in ticks (loop mode only). Defaults to the last key's `t`. */
    loopLength?: number;
}
/** A clip instance drawn OVER the cart frame (animated set-dressing). */
interface AnimPlacement {
    /** References an AnimClip by name. */
    clip: string;
    x: number;
    y: number;
    /** 0 (nearest) .. 1 (far) — for future ordering; not composited in Phase A. */
    depth: number;
    /** Base opacity 0..1 (tracks may override). */
    opacity: number;
    /** Base scale > 0 (tracks may override). */
    scale: number;
}
/** A full declared animation set. */
interface AnimSpec {
    clips: AnimClip[];
    tracks: AnimTrack[];
    placements: AnimPlacement[];
}
/**
 * Parse untrusted sidecar JSON into an AnimSpec, or null when there is nothing
 * usable (no object, or no valid clips/tracks/placements). Entries are validated
 * individually and bad ones dropped — losing one clip beats refusing the whole
 * animation. Order matters: clips first (placements reference clip names), then
 * placements (tracks bounds-check placement indices), then tracks.
 */
declare function parseAnim(raw: unknown): AnimSpec | null;

/**
 * The particle sidecar data model + its defensive parser — cinematic gap #6
 * (weather and atmosphere: rain, snow, drifting embers, rolling fog). Kept DOM-free
 * so the save API validates with the same code the runtime and editor consume, the
 * way the scene and anim sidecars are.
 *
 * A cart declares a small set of emitters; the runtime {@link ./particleField.ts}
 * turns each into a deterministic, host-played particle field and the
 * {@link ./ParticleOverlaySurface.ts} composites them over the frame. Emitters
 * carry only the handful of knobs that read differently per weather — count,
 * colour, opacity, size, fall/rise speed, wind — while the per-kind *motion*
 * (streaking, sway, flicker) is baked into the field, so the sidecar stays small
 * and an author picks a preset and nudges a few sliders.
 */
/** The weather an emitter produces; also selects how the field draws and moves it. */
type ParticleKind = "rain" | "snow" | "embers" | "fog";
/** Every kind, in a stable order (used by the editor's kind picker). */
declare const PARTICLE_KINDS: readonly ParticleKind[];
/** At most this many emitters per cart — a full weather system needs only a few. */
declare const MAX_EMITTERS = 6;
/** Per-emitter particle-count ceiling, bounding worst-case per-frame draw cost. */
declare const MAX_PARTICLES_PER_EMITTER = 600;
/** One weather layer. */
interface ParticleEmitter {
    /** Weather kind — chooses draw style and motion. */
    kind: ParticleKind;
    /** How many particles this layer maintains, 1..{@link MAX_PARTICLES_PER_EMITTER}. */
    count: number;
    /** Particle colour, each channel 0..255. */
    color: readonly [number, number, number];
    /** Base opacity of each particle, 0..1. */
    opacity: number;
    /** Particle size in pixels, 1..8. */
    size: number;
    /** Speed along the kind's axis (fall or rise), in pixels/frame, 0..12. */
    speed: number;
    /** Horizontal drift in pixels/frame, signed, -6..6. */
    wind: number;
    /** Integer seed so the field is reproducible across reloads and replays. */
    seed: number;
}
/** A cart's declared weather: an ordered list of emitters. */
interface ParticleSpec {
    emitters: ParticleEmitter[];
}
/** A ready-to-use emitter for a kind, at that kind's preset with the given seed. */
declare function emitterPreset(kind: ParticleKind, seed: number): ParticleEmitter;
/**
 * Validate untrusted JSON (a PUT body or a jsonb column) into a {@link ParticleSpec},
 * or null when nothing usable is present. Lenient about shape — malformed emitters
 * are dropped and missing fields take their kind's preset — but strict about kind
 * and ranges. Caps at {@link MAX_EMITTERS}. Returns null for an emitter-less result,
 * the same null-on-empty contract the scene and anim routes rely on so an empty
 * declaration clears the column rather than storing a no-op.
 */
declare function parseParticles(raw: unknown): ParticleSpec | null;

/**
 * Public and shared types for @cartbox/player.
 *
 * Kept free of DOM/engine imports so it can be consumed by any module without
 * pulling in browser or WASM dependencies.
 */

/**
 * Which input methods the player wires up.
 * - "auto": keyboard on devices with a fine pointer, on-screen touch controls otherwise.
 * - "keyboard": keyboard only.
 * - "touch": on-screen controls only.
 */
type ControlScheme = "auto" | "keyboard" | "touch";
/**
 * How the console image is sized inside its container.
 * - "fit": largest size that fits, preserving aspect ratio (may be fractional — smooth).
 * - "integer": largest whole-number multiple that fits (crisp, no pixel shimmer).
 * - number: an explicit scale multiplier (e.g. 3 renders at 3x native).
 */
type ScaleMode = "fit" | "integer" | number;
/** The eight face/direction buttons of a TIC-80 gamepad. Values are bit positions. */
declare enum ConsoleButton {
    Up = 0,
    Down = 1,
    Left = 2,
    Right = 3,
    A = 4,
    B = 5,
    X = 6,
    Y = 7
}
/** Options accepted by {@link mount}. Only `cartUrl` is required. */
interface PlayerOptions {
    /** URL of the `.tic` cartridge to load. */
    cartUrl: string;
    /**
     * URL of the engine loader script (the Emscripten glue that instantiates the
     * WASM core). Defaults to the selected model's `engineUrl` when omitted.
     */
    engineUrl?: string;
    /** Console model — selects the runtime and its fixed specs. Defaults to "classic". */
    modelId?: ModelId;
    /** When false (default) a poster is shown and playback starts on the first user gesture. */
    autostart?: boolean;
    /** Input scheme. Defaults to "auto". */
    controls?: ControlScheme;
    /** Display scaling policy. Defaults to "fit". */
    scale?: ScaleMode;
    /** Audio sample rate. Defaults to the model's sample rate. */
    sampleRate?: number;
    /** Record the input stream for replay. Defaults to true (negligible cost). */
    record?: boolean;
    /**
     * Play back a recorded replay instead of live input. When set, user input is
     * ignored and the console is driven by the replay's input stream.
     */
    replay?: Replay;
    /** Called once the cartridge is loaded and the first frame is ready. */
    onReady?: () => void;
    /** Called for any load or runtime error the player cannot recover from. */
    onError?: (error: Error) => void;
    /** Called for each platform event a cart emits via the cartbox SDK. */
    onEvent?: (event: MailboxEvent) => void;
    /**
     * Relight the cart's frames with dynamic point lights. When set, the player
     * renders through a WebGL lighting layer (falling back to plain 2D if WebGL is
     * unavailable). See {@link LightingOptions}.
     */
    lighting?: LightingOptions;
    /**
     * Post-process every presented frame through the cart's effect stack (fog,
     * bloom, CRT, …). Composes with `lighting`. Ignored when no effect is
     * enabled or WebGL is unavailable, so it can never stop a cart from playing.
     */
    postFx?: PostFxSettings;
    /**
     * Composite a declared parallax scene behind the cart's frame: layers point at
     * regions of the cart's own sprite sheet at depths, rendered with parallax
     * scroll + aerial-perspective atmosphere and chroma-keyed under the cart's
     * foreground (its background {@link SceneSpec.keyColor}). Runs before lighting
     * and post-FX, so both finish the backdrop and foreground together. Parse a
     * cart's sidecar into a SceneSpec with `parseScene`.
     */
    scene?: SceneSpec;
    /**
     * Play a declared animation set host-side (no cart code): sprite-frame clips as
     * foreground placements, plus keyframed tracks that drive scene-layer channels
     * (opacity/offset/emissive), post-FX values, and placement transforms — the
     * ambient motion (flickering neon, drifting fog, a guttering candle) the
     * REPLACED / THE LAST NIGHT look leans on. Driven off the same frame clock as the
     * scene backdrop. Parse a cart's sidecar into an AnimSpec with `parseAnim`.
     */
    anim?: AnimSpec;
    /**
     * Composite a declared weather system over each frame: rain, snow, drifting
     * embers, or rolling fog, played host-side (no cart code) as a stateless field.
     * Drawn in front of the cart, its backdrop, and any foreground placements, and —
     * with post-FX active — graded and bloomed with the scene. The atmosphere layer
     * of the REPLACED / THE LAST NIGHT look. Parse a cart's sidecar into a
     * ParticleSpec with `parseParticles`.
     */
    particles?: ParticleSpec;
}
/** Handle returned by {@link mount} for controlling a live player instance. */
interface PlayerHandle {
    /** Halt the run loop and silence audio without tearing down the instance. */
    pause(): void;
    /** Resume a paused instance. */
    resume(): void;
    /** Stop everything and release the canvas, listeners, audio, and WASM instance. */
    destroy(): void;
    /**
     * The replay captured so far, or null when recording is disabled or the player
     * is itself replaying. Safe to call at any time (e.g. when the player ends).
     */
    getReplay(): Replay | null;
    /** Whether the run loop is currently advancing frames. */
    readonly running: boolean;
}

/**
 * Cartridge fetching.
 *
 * Single responsibility: turn a cartridge URL into validated bytes. It knows
 * nothing about the engine or rendering, so it can be reused by the gallery,
 * thumbnail renderer, or any other consumer.
 */
/** Raised when a cartridge cannot be fetched or is obviously not a cartridge. */
declare class CartridgeLoadError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}

/**
 * Input handling. Both sources (keyboard, touch) write into a shared
 * {@link GamepadState} that the run loop samples once per frame as a bitmask.
 *
 * The key-binding lookup is a pure function so it can be unit-tested without a DOM.
 */

/**
 * Default keyboard layout, matching TIC-80 conventions: arrows for the D-pad,
 * Z/X for A/B, A/S for X/Y. Keyed by `KeyboardEvent.code` so it is layout-independent.
 */
declare const DEFAULT_KEY_BINDINGS: Readonly<Record<string, ConsoleButton>>;
/**
 * Resolves a physical key to a console button, or undefined if unbound.
 * Pure — no DOM access — so callers and tests can use it freely.
 */
declare function resolveButton(keyCode: string, bindings?: Readonly<Record<string, ConsoleButton>>): ConsoleButton | undefined;

/**
 * Deterministic RNG seeding via cart-code injection.
 *
 * Cart randomness comes from the scripting language's own RNG (e.g. Lua's
 * math.random), which each language auto-seeds non-deterministically. A single
 * engine-level seed can't reach it. The robust, engine-agnostic fix is to seed
 * the language RNG from the cart itself: we inject a `math.randomseed(<seed>)`
 * prologue into the CODE chunk before loading, so a replay that reuses the same
 * seed reproduces the same random sequence.
 *
 * This is pure and testable. It currently covers Lua (TIC-80's default and most
 * common language); carts marked as another language are returned unchanged.
 *
 * .tic chunk header (4 bytes, LE): [type(5 bits) | bank(3 bits)][size lo][size hi][reserved]
 */
/** Returns the cart's source code (first CODE chunk), or null if absent. */
declare function readCartCode(bytes: Uint8Array): string | null;
/**
 * Returns a copy of the cartridge with a deterministic RNG seed injected into
 * its Lua code, so a replay reusing the same seed reproduces the randomness.
 *
 * @param bytes Original cartridge bytes.
 * @param seed Seed to make the language RNG reproducible.
 */
declare function seedCartridge(bytes: Uint8Array, seed: number): Uint8Array;

/**
 * The cartbox SDK as an injectable string.
 *
 * Kept in sync with sdk/cartbox.lua (that file is the copy creators read/import;
 * this string is what the platform injects into carts that opt in). Both must
 * agree with the mailbox protocol in mailbox.ts (base word 192, event ring
 * capacity 8, lights block at word 217, event types 1/2/3, FNV-1a id hash).
 */
/** Lua source of the cartbox SDK. */
declare const CARTBOX_SDK_LUA = "local _MB = 192\nlocal _CAP = 8\nlocal _LB = _MB + 25\nlocal _LCAP = 6\nlocal _CB = _LB + 1 + _LCAP * 6\nlocal _ln = 0\nlocal function _emit(kind, id, value)\n  local seq = pmem(_MB)\n  local slot = seq % _CAP\n  local base = _MB + 1 + slot * 3\n  pmem(base, kind)\n  pmem(base + 1, id)\n  pmem(base + 2, value)\n  pmem(_MB, seq + 1)\nend\nlocal function _hash(s)\n  local h = 2166136261\n  for i = 1, #s do\n    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff\n  end\n  return h\nend\nlocal function _norm(x, y, z)\n  local m = math.sqrt(x * x + y * y + z * z)\n  if m < 1e-6 then return 0, 0, 1 end\n  return x / m, y / m, z / m\nend\nlocal function _byte(v)\n  local b = math.floor((v or 0) * 127 + 0.5)\n  if b < -127 then b = -127 elseif b > 127 then b = 127 end\n  if b < 0 then b = b + 256 end\n  return b\nend\nlocal function _light(kind, x, y, z, radius, r, g, b, intensity, dx, dy, cone)\n  if _ln >= _LCAP then return end\n  local base = _LB + 1 + _ln * 6\n  pmem(base, x // 1)\n  pmem(base + 1, y // 1)\n  pmem(base + 2, z // 1)\n  pmem(base + 3, radius // 1)\n  local rgb = (math.floor(r or 255) & 0xff) << 16\n  rgb = rgb | ((math.floor(g or 255) & 0xff) << 8)\n  rgb = rgb | (math.floor(b or 255) & 0xff)\n  pmem(base + 4, rgb | (kind << 24) | (cone << 26))\n  local inten = math.floor((intensity or 1) * 256)\n  if inten < 0 then inten = 0 elseif inten > 0xffff then inten = 0xffff end\n  pmem(base + 5, inten | (dx << 16) | (dy << 24))\n  _ln = _ln + 1\n  pmem(_LB, _ln)\nend\ncartbox = {\n  unlock = function(id) _emit(1, _hash(id), 0) end,\n  score = function(v) _emit(2, 0, v // 1) end,\n  progress = function(id, v) _emit(3, _hash(id), v // 1) end,\n  clearlights = function() _ln = 0 pmem(_LB, 0) end,\n  light = function(x, y, radius, r, g, b, z, intensity)\n    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)\n  end,\n  sun = function(dx, dy, dz, r, g, b, intensity)\n    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)\n    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)\n  end,\n  spot = function(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)\n    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)\n    local cone = math.floor(math.cos(math.rad(angle or 30)) * 63 + 0.5)\n    if cone < 0 then cone = 0 elseif cone > 63 then cone = 63 end\n    _light(2, x, y, z or 12, radius, r, g, b, intensity, _byte(nx), _byte(ny), cone)\n  end,\n  camera = function(x, y)\n    pmem(_CB, math.floor((x or 0) * 16 + 0.5) & 0xffffffff)\n    pmem(_CB + 1, math.floor((y or 0) * 16 + 0.5) & 0xffffffff)\n  end,\n}";
/** Injects the cartbox SDK into a Lua cart (returns non-Lua carts unchanged). */
declare function injectSdk(bytes: Uint8Array): Uint8Array;

/**
 * Engine adapter — the single seam between this player and the TIC-80 WASM core.
 *
 * `packages/engine` compiles the TIC-80 core plus a thin C shim to WASM via
 * Emscripten. The shim exports the stable C entry points below (prefixed `cbx_`);
 * keeping the shim contract narrow means struct layout changes in TIC-80 never
 * leak into the TypeScript. Everything WASM-specific lives here and nowhere else.
 *
 * Shim contract (implemented in packages/engine/shim.c, exported via
 * EXPORTED_FUNCTIONS):
 *   int  cbx_create(int sampleRate)                -> opaque console handle
 *   int  cbx_load(int handle, int ptr, int size)   -> 1 on success, 0 on failure
 *   void cbx_tick(int handle, int gamepadMask)      -> advance one 60Hz frame
 *   int  cbx_screen_ptr(int handle)                 -> ptr to RGBA framebuffer
 *   int  cbx_samples_ptr(int handle)                -> ptr to Int16 PCM for this frame
 *   int  cbx_samples_count(int handle)              -> sample count for this frame
 *   void cbx_delete(int handle)                     -> free the console
 */

/** Minimal view of the Emscripten module we depend on. */
interface EmscriptenModule {
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _cbx_create(sampleRate: number): number;
    _cbx_load(handle: number, ptr: number, size: number): number;
    _cbx_tick(handle: number, gamepadMask: number): void;
    _cbx_screen_ptr(handle: number): number;
    _cbx_samples_ptr(handle: number): number;
    _cbx_samples_count(handle: number): number;
    _cbx_mailbox_ptr(handle: number): number;
    _cbx_mailbox_words(handle: number): number;
    _cbx_material_ptr(handle: number): number;
    _cbx_emissive_ptr(handle: number): number;
    _cbx_set_material_capture(handle: number, enabled: number): void;
    _cbx_delete(handle: number): void;
}
/** A loaded console ready to run a single cartridge. */
interface ConsoleInstance {
    /** Loads cartridge bytes. Returns false if the core rejects the cartridge. */
    loadCartridge(bytes: Uint8Array): boolean;
    /** Advances exactly one frame using the given gamepad bitmask. */
    tick(gamepadMask: number): void;
    /** Returns a view of the current RGBA framebuffer (valid until the next tick). */
    readFramebuffer(): Uint8Array;
    /** Returns the PCM samples produced by the most recent tick. */
    readAudioSamples(): Int16Array;
    /** Returns a copy of the event-mailbox words (word[0] = sequence counter). */
    readMailbox(): Uint32Array;
    /** Enables/disables per-pixel material capture (off by default; unlit carts pay nothing). */
    setMaterialCapture(enabled: boolean): void;
    /**
     * Returns a view of the current material G-buffer (RGBA: normal index, height,
     * specular, roughness), same dimensions as the framebuffer and valid until the
     * next tick. Empty until {@link setMaterialCapture} is enabled.
     */
    readMaterial(): Uint8Array;
    /**
     * Returns a view of the current emissive plane (one byte per pixel of self-
     * illumination; 0 = lit normally), width*height bytes, valid until the next
     * tick. Empty until {@link setMaterialCapture} is enabled.
     */
    readEmissive(): Uint8Array;
    /** Frees the underlying WASM console. */
    dispose(): void;
}
declare function loadEngineModule(engineUrl: string): Promise<EmscriptenModule>;
/** Wraps an Emscripten module as a {@link ConsoleInstance} for a given model. */
declare function createConsole(module: EmscriptenModule, model: ConsoleModel, sampleRate?: number): ConsoleInstance;

/**
 * Replay verification (Platform P2).
 *
 * The payoff of deterministic replays + the event mailbox: a submitted score can
 * be trusted by *re-running the replay* headlessly and reading what the cart
 * actually emitted. Because the run is deterministic (recorded inputs + RNG
 * seed), the recomputed score is exactly what the player saw — so a tampered
 * claim can't pass.
 *
 * This module is pure over a {@link ConsoleInstance} (the caller loads the cart,
 * seeded and with the SDK, into the console). It reuses the same input playback
 * and mailbox decoding the live player uses, so verification and play agree.
 */

/**
 * Re-runs a replay into a loaded console and returns every platform event the
 * cart emits. The console must already hold the correct cartridge (seeded with
 * `replay.seed`, SDK present) for the result to match the original session.
 */
declare function runReplayEvents(console: ConsoleInstance, replay: Replay): MailboxEvent[];
/** The best (maximum) score emitted, or null if the cart posted no score. */
declare function extractScore(events: MailboxEvent[]): number | null;
/** The distinct achievement ids unlocked during the run. */
declare function extractUnlocks(events: MailboxEvent[]): number[];
interface VerificationResult {
    /** The score the replay actually produced (null if none). */
    score: number | null;
    /** Achievement ids the replay legitimately unlocked. */
    unlocks: number[];
    /** True when the claimed score equals the recomputed score. */
    verified: boolean;
}
/**
 * Verifies a claimed score by re-running the replay.
 *
 * @param console A console already loaded with the seeded cart + SDK.
 * @param replay The recorded session.
 * @param claimedScore The score the submitter claims.
 */
declare function verifyReplayScore(console: ConsoleInstance, replay: Replay, claimedScore: number): VerificationResult;

/**
 * Achievement resolution (Platform P2).
 *
 * The mailbox carries achievement unlocks as FNV-1a hashes of their string key
 * (see hashEventId / the cartbox SDK). To grant an unlock, the platform maps
 * those hashes back to the achievements registered for the cart. This resolver
 * is the pure core of that mapping; the worker fetches the cart's registered
 * achievements and calls it with the hashes a verified replay produced.
 */
/** An achievement as registered for a cart. */
interface RegisteredAchievement {
    /** Achievement row id. */
    id: string;
    /** FNV-1a hash of the achievement key (matches the mailbox event id). */
    hash: number;
    /** Optional human key (e.g. "first_blood"). */
    key?: string;
}
/**
 * Returns the registered achievements whose hash appears in the unlock hashes.
 * Hashes are compared as unsigned 32-bit values, matching the mailbox encoding.
 */
declare function resolveUnlockedAchievements(unlockHashes: number[], registered: RegisteredAchievement[]): RegisteredAchievement[];

/**
 * The backend-agnostic contract for the lighting renderer. Two implementations
 * satisfy it — {@link WebgpuLightingLayer} (preferred) and the WebGL
 * {@link LightingLayer} (fallback) — so the display surface and the factory can
 * treat them identically. Both run the same passes and the same lighting model
 * ({@link shade}); only the graphics API differs.
 */

/** Which graphics API a renderer is running on. */
type LightingBackend = "webgpu" | "webgl";
interface LightingRenderer {
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
declare function createFlatMaterial(width: number, height: number): Uint8Array;

/**
 * LightingLayer — a reusable, framework-agnostic WebGL renderer that relights a
 * console framebuffer. It is the LUMEN demo's pipeline lifted into the player so
 * any cart's output can be lit dynamically:
 *
 *   Pass 1  lighting  : albedo + material -> a scene texture
 *                       (Lambert diffuse from the 16-direction normals, plus
 *                        Blinn-Phong specular and height-field cast shadows).
 *   Pass 2  bright    : keep the glowing pixels, at half resolution.
 *   Pass 3  blur      : separable Gaussian, horizontal then vertical.
 *   Pass 4  composite : scene + bloom -> the canvas (this pass flips Y).
 *
 * The material buffer is optional: without it the layer lights flat pixels,
 * giving coloured, distance-attenuated pools over the cart's own art. With a
 * material buffer (from a lighting-aware cart or the editor's normal bank) it
 * upgrades to full per-pixel normals, specular, and shadows.
 *
 * The diffuse term matches {@link shade} in lightingModel.ts by construction.
 */

/** A minimal canvas shape — the real `HTMLCanvasElement` satisfies it, and so
 * can a fake in tests. */
interface RenderCanvas {
    width: number;
    height: number;
    getContext(contextId: string, options?: unknown): unknown;
}
declare class LightingLayer implements LightingRenderer {
    private readonly renderCanvas;
    private readonly width;
    private readonly height;
    readonly backend: LightingBackend;
    private readonly gl;
    private readonly quad;
    private readonly pLight;
    private readonly pBright;
    private readonly pBlur;
    private readonly pComposite;
    private readonly albedoTex;
    private readonly matTex;
    private readonly scene;
    private readonly bright;
    private readonly blurA;
    private readonly blurB;
    private readonly flatNormals;
    private readonly lightPos;
    private readonly lightColor;
    private readonly lightRadius;
    private readonly lightKind;
    private readonly lightDir;
    private readonly lightCone;
    private flatMaterial;
    /** Whether a WebGL lighting context can be created on this canvas. */
    static isSupported(canvas: RenderCanvas): boolean;
    constructor(renderCanvas: RenderCanvas, width: number, height: number);
    /**
     * Relight one frame and present it to the canvas.
     *
     * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
     * @param material Optional per-pixel material (normal/height/spec/rough); when
     *                 null, pixels are lit flat.
     * @param scene    The lights and ambient for this frame.
     */
    render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void;
    /** Releases all GL resources. */
    dispose(): void;
    private flatMaterialBuffer;
    private uni;
    private bindQuad;
    private bindSampler;
    private build;
    private makeDataTexture;
    private makeTarget;
}

/**
 * WebgpuLightingLayer — the WebGPU implementation of the lighting pipeline, the
 * preferred backend. It runs the same four passes as the WebGL {@link
 * LightingLayer} (lighting → bright → blur → composite) and the same lighting
 * model, in WGSL. `create` is async (WebGPU device acquisition is) and returns
 * null on any failure, so the factory can fall back to WebGL — never a blank
 * screen.
 *
 * WebGPU isn't in the TS DOM lib here and we avoid the @webgpu/types dependency
 * (matching the editor's WebGpuLitRenderer), so GPU handles are loosely typed.
 * WebGPU keeps a consistent top-left texture/framebuffer origin across render
 * targets, so — unlike the WebGL path — no pass needs a Y-flip.
 */

declare class WebgpuLightingLayer implements LightingRenderer {
    private readonly device;
    private readonly context;
    private readonly width;
    private readonly height;
    private readonly textures;
    private readonly targets;
    private readonly pipelines;
    private readonly binds;
    private readonly buffers;
    readonly backend: LightingBackend;
    private flatMaterial;
    private readonly lightData;
    private readonly compData;
    private constructor();
    static create(canvas: RenderCanvas, width: number, height: number, device: any): Promise<WebgpuLightingLayer | null>;
    render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void;
    dispose(): void;
    private runPass;
    private flatMaterialBuffer;
}

/**
 * Acquires a shared WebGPU device, memoised so a page with many players probes
 * the adapter only once. Returns null (never throws) when WebGPU is unavailable
 * or the adapter/device can't be obtained, which is the signal the factory uses
 * to fall back to WebGL.
 */
declare function getWebgpuDevice(): Promise<any | null>;

/**
 * Chooses and builds the lighting renderer: WebGPU when a device is available,
 * otherwise the WebGL fallback. Because a canvas is locked to one context type
 * once `getContext` is called, this owns canvas creation — it hands back the
 * canvas it configured alongside the renderer, and uses a fresh canvas for the
 * WebGL attempt so a failed WebGPU probe can't poison it. Returns null only when
 * neither backend works (the caller then shows the cart unlit in plain 2D).
 */

interface BuiltLightingRenderer {
    renderer: LightingRenderer;
    canvas: HTMLCanvasElement;
}
/** Resolves a shared WebGPU device, or null. Injectable for tests. */
type DeviceProvider = () => Promise<any | null>;
declare function createLightingLayer(doc: Document, width: number, height: number, deviceProvider?: DeviceProvider): Promise<BuiltLightingRenderer | null>;

/**
 * Display surface: owns the <canvas>, computes scaling, and blits engine
 * framebuffers. The scaling math is a pure function so it can be unit-tested
 * without a DOM.
 */

/**
 * A display surface the player can present frames to. Both the plain 2D
 * {@link CanvasSurface} and the WebGL {@link LitCanvasSurface} implement it, so
 * the run loop presents frames the same way regardless of lighting.
 */
interface DisplaySurface {
    /** Present one RGBA framebuffer. */
    blit(rgba: Uint8Array): void;
    /** Release the canvas and any observers. */
    destroy(): void;
}

/**
 * LitCanvasSurface — a display surface that relights each frame through the
 * lighting renderer before showing it. It is a drop-in for {@link CanvasSurface}:
 * the run loop still calls `blit(albedo)`; this surface pulls the frame's lights
 * (and optional material) from the host's {@link LightingOptions} and renders
 * them over the cart's own art.
 *
 * Construction is async ({@link create}) because choosing the backend may need
 * to await a WebGPU device. The factory prefers WebGPU and falls back to WebGL;
 * if neither is available this surface falls back to plain 2D, so enabling
 * lighting can never stop a cart from playing.
 */

declare class LitCanvasSurface implements DisplaySurface {
    private readonly container;
    private readonly scaleMode;
    private readonly model;
    private readonly options;
    private readonly performanceNow;
    private readonly resizeObserver;
    private readonly renderer?;
    private readonly canvas?;
    private readonly fallback?;
    private frame;
    private cartLights;
    private albedoCopy;
    private cartMaterial;
    private cartMaterialCopy;
    private cartEmissive;
    private constructor();
    /** Builds the surface, choosing the best available lighting backend. */
    static create(container: HTMLElement, scaleMode: ScaleMode, model: ConsoleModel, options: LightingOptions): Promise<LitCanvasSurface>;
    /** Whether the lit path is active (false means it fell back to plain 2D). */
    get isLit(): boolean;
    /** The active backend: "webgpu", "webgl", or "2d" when unlit. */
    get backend(): LightingBackend | "2d";
    /**
     * Sets the lights the running cart emitted this frame (via `cartbox.light`).
     * They are combined with any host-provided lights on the next {@link blit}.
     */
    setCartLights(lights: readonly Light[]): void;
    /**
     * Sets the per-pixel material buffer the engine emitted for this frame's
     * sprites (RGBA: normal index, height, specular, roughness). Copied into a
     * stable buffer on {@link blit}; an empty buffer falls back to host material.
     */
    setCartMaterial(material: Uint8Array): void;
    /**
     * Sets the per-pixel emissive plane (one byte each) the engine emitted this
     * frame. It is folded into the albedo copy's alpha channel on {@link blit},
     * which both lighting backends read as self-illumination. An empty buffer
     * leaves the framebuffer's own alpha untouched.
     */
    setCartEmissive(emissive: Uint8Array): void;
    blit(albedo: Uint8Array): void;
    destroy(): void;
    private resolveMaterial;
    private applyScale;
}

/**
 * The Cartbox lighting model, in pure TypeScript — DOM-free and side-effect
 * free so it can be unit-tested and reused on the server. It is the exact model
 * the editor authors against (packages/editor/src/model/normals.ts and
 * lighting.ts): a per-pixel normal chosen from 16 directions, shaded by Lambert
 * diffuse lifted over an ambient floor. The runtime {@link LightingLayer} runs
 * the same maths in a shader; keeping this here lets both agree by construction.
 */

/** A 3-component vector. */
type Vec3 = readonly [number, number, number];
/** An RGB colour, each channel 0..255. */
type Rgb = readonly [number, number, number];
/** A pixel stores one of this many normal-direction indices (4 bits). */
declare const NORMAL_DIRECTION_COUNT = 16;
declare const NORMAL_VECTORS: readonly Vec3[];
/** The unit surface normal for a direction index (flat when out of range). */
declare function normalVector(direction: number): Vec3;
/** The direction index whose stored normal is closest to an arbitrary vector. */
declare function nearestDirection(vector: Vec3): number;
/**
 * Bilinearly blend four corner normals — decoded unit *vectors*, never the
 * direction indices — by fractional weights and renormalise. Interpolating the
 * vectors is the whole point: the 16 stored directions are an unordered palette,
 * so blending their indices would be meaningless, but blending the vectors they
 * decode to turns the quantised, facet-banded field into a smooth one. This is
 * cinematic gap #2 — the fix for the Mach banding that betrays the 16-direction
 * normals on any curved surface. The shaders (WebGL + WebGPU) run this exact
 * blend per fragment from four material-texel lookups; keeping it here lets a
 * test pin the behaviour the GLSL only shows on a GPU.
 *
 * @param corner00 Normal at the top-left texel.
 * @param corner10 Normal at the top-right texel.
 * @param corner01 Normal at the bottom-left texel.
 * @param corner11 Normal at the bottom-right texel.
 * @param fractionX Horizontal blend weight, 0 (left) .. 1 (right).
 * @param fractionY Vertical blend weight, 0 (top) .. 1 (bottom).
 */
declare function interpolateNormal(corner00: Vec3, corner10: Vec3, corner01: Vec3, corner11: Vec3, fractionX: number, fractionY: number): Vec3;
/**
 * The smoothed surface normal at a continuous pixel position, bilinearly blended
 * from the four surrounding material texels' normals. `indexAt(x, y)` returns the
 * stored direction index for an integer pixel (implementations clamp to the
 * material's bounds); this decodes the four corners around `(sampleX, sampleY)`
 * to vectors and hands them to {@link interpolateNormal}. A region of uniform
 * index returns exactly that index's normal, so flat and unmapped surfaces are
 * untouched — only genuinely varying normals get de-banded.
 *
 * @param indexAt  Reads the stored normal index at an integer pixel.
 * @param sampleX  Continuous column (pixel centres at integer coordinates).
 * @param sampleY  Continuous row.
 */
declare function sampleNormalBilinear(indexAt: (x: number, y: number) => number, sampleX: number, sampleY: number): Vec3;
/**
 * Shade an albedo colour by a surface normal and a direction toward the light:
 * Lambert diffuse lifted by an ambient floor, so a surface never drops below
 * `ambient` of its base colour. Each channel is clamped to 0..255.
 */
declare function shade(albedo: Rgb, normal: Vec3, toLight: Vec3, ambient: number): Rgb;

/**
 * Single-pass WebGL1 post-process renderer shared by the editor's FX tab and
 * the runtime player. Takes one frame — either raw RGBA bytes at native cart
 * resolution or a source canvas — as a nearest-filtered texture and draws it
 * through one fragment shader implementing the whole effect chain; per-effect
 * intensity arrives as uniforms (neutral when disabled), so the pipeline
 * compiles once. WebGL1 is used (not WebGPU) because this is a one-texture
 * full-screen quad — maximum compatibility, no async device setup.
 *
 * Effect order mirrors a physical signal path. The frame is folded and bowed
 * first (kaleidoscope, then CRT curvature), sampled through chromatic
 * aberration, and lit (bloom, god rays, streaks). The composed colour is then
 * graded and split-toned, quantised (dither feeding posterize), screened
 * (halftone), and finally passed through the things that sit in front of the
 * picture rather than in it: fog, vignette, grain, scanlines.
 *
 * Everything stays in one pass. That constraint is why the effects here are the
 * ones they are — a separable blur or a depth-aware effect would need a second
 * render target, and the whole point of the flat-uniform design is that there is
 * exactly one program, compiled once, whatever the artist switches on.
 */

/** A frame to post-process: raw RGBA bytes or a canvas to sample. */
type PostFxSource = Uint8Array | Uint8ClampedArray | TexImageSource;
declare class PostFxPass {
    private readonly gl;
    private readonly program;
    private readonly texture;
    private readonly quad;
    private readonly positionLocation;
    /** Null when render-to-texture is unavailable; the shader then falls back
     * to its inline 3x3 bloom rather than the multi-scale pyramid. */
    private readonly bloom;
    private readonly uniformLocations;
    private constructor();
    /** Returns null when WebGL is unavailable or the shaders fail to compile. */
    static create(canvas: HTMLCanvasElement): PostFxPass | null;
    private location;
    /**
     * Upload one frame and draw it through the effect chain.
     *
     * `time` (seconds) drives the only effect that moves, the grain. It is a
     * parameter rather than a clock read inside the pass so a still preview — the
     * editor's FX tab, a test — renders deterministically, and only a caller that
     * actually has a running frame loop supplies one.
     */
    render(source: PostFxSource, width: number, height: number, uniforms: PostFxUniforms, time?: number): void;
    dispose(): void;
}

/**
 * PostFxSurface — a display surface that draws every presented frame through
 * the post-process shader chain. It decorates the real surface (plain 2D or
 * the lighting surface): the inner surface renders into a detached, offscreen
 * container, and each `blit` re-samples its canvas GPU-side into the visible
 * FX canvas. Decorating (rather than merging into the lighting pipeline) keeps
 * lighting and FX orthogonal — any combination of the two just works.
 *
 * Construction can fail (no WebGL, no inner canvas); the factory returns null
 * and the caller mounts the inner surface directly, so enabling FX can never
 * stop a cart from playing.
 */

/** Builds the inner (decorated) surface into the given offscreen container. */
type InnerSurfaceFactory = (container: HTMLElement) => Promise<DisplaySurface> | DisplaySurface;
declare class PostFxSurface implements DisplaySurface {
    private readonly container;
    private readonly scaleMode;
    private readonly model;
    private readonly inner;
    private readonly innerCanvas;
    private readonly canvas;
    private readonly pass;
    private readonly resizeObserver;
    private uniforms;
    /** When this surface started, so animated effects get a monotonic clock. */
    private readonly startedAt;
    private constructor();
    /**
     * Builds the FX surface, or returns null when post-processing cannot run
     * (the caller should then mount the inner surface directly). The inner
     * factory is only invoked once the FX pass itself is viable.
     */
    static create(container: HTMLElement, scaleMode: ScaleMode, model: ConsoleModel, settings: PostFxSettings, makeInner: InnerSurfaceFactory): Promise<PostFxSurface | null>;
    /** Swap the effect stack without rebuilding the pipeline. */
    setSettings(settings: PostFxSettings): void;
    blit(rgba: Uint8Array): void;
    destroy(): void;
    private applyScale;
}

/**
 * A true multi-pass bloom: the wide, soft, energy-preserving glow the old
 * single-pass 3x3 tap could not produce (cinematic gap #4). The frame's bright
 * pixels are extracted through a soft knee, then blurred across a pyramid of
 * successively halved render targets using the dual-Kawase filter — a downsample
 * chain followed by an additive upsample chain — so light spreads across many
 * scales in a handful of cheap passes rather than one fixed-width kernel.
 *
 * The targets are half-float when the GPU can render and linearly filter them
 * (`OES_texture_half_float` + its linear and colour-buffer companions), which is
 * the other half of gap #4: bright light accumulates past 1.0 in the pyramid and
 * only comes back into range at the tonemap, so emissives keep their colour
 * instead of clipping to white. Where half-float is unavailable it falls back to
 * 8-bit targets — still a wide multi-scale blur, just clamped in range.
 *
 * The arithmetic (level count, soft-knee prefilter) lives in {@link bloomModel},
 * which has headless tests; the shaders here are a direct port of it. Creation
 * returns null on any GL failure so {@link PostFxPass} can fall back to its
 * inline bloom and a cart never stops playing.
 */
declare class BloomPyramid {
    private readonly gl;
    private readonly quad;
    private readonly prefilter;
    private readonly downsample;
    private readonly upsample;
    /** The pixel type of the render targets: half-float for HDR, else 8-bit. */
    private readonly textureType;
    private levels;
    private baseWidth;
    private baseHeight;
    private constructor();
    /** Whether the pyramid can hold light past 1.0 (true HDR) or clamps at it. */
    get isHdr(): boolean;
    /**
     * Build the pyramid against an existing GL context, or return null if any
     * shader/buffer allocation fails. The context is shared with the owning pass;
     * this class only ever renders into its own framebuffers and leaves the
     * default framebuffer bound when it is done.
     */
    static create(gl: WebGLRenderingContext): BloomPyramid | null;
    /**
     * Generate the bloom for one frame and return the finest pyramid level (a
     * half-resolution texture holding the accumulated glow), ready to be sampled
     * and added by the composite pass. Targets are reallocated only when the base
     * resolution changes, so steady-state playback allocates nothing.
     */
    generate(source: WebGLTexture, baseWidth: number, baseHeight: number, threshold: number, radius: number): WebGLTexture | null;
    dispose(): void;
    /** Bind a program and its target framebuffer, and point the shared quad at the
     * program's attribute — GLSL ES 1.00 has no VAOs, so this repeats per draw. */
    private begin;
    private allocate;
    private makeLevel;
    private freeLevels;
}

/**
 * The pure arithmetic behind the HDR bloom + tonemap stage, split out from the
 * WebGL plumbing so the algorithm can be validated headlessly (no GL context)
 * and so {@link BloomPyramid}'s shaders are a faithful port of code that has
 * tests rather than the other way round.
 *
 * Three pieces model gap #4's two halves — a real multi-scale bloom and an HDR
 * rolloff: how deep the blur pyramid goes for a given frame, the soft-knee
 * bright pass that seeds it, and the ACES filmic curve that maps the summed HDR
 * light back into the displayable 0..1 range. Every function here has an exact
 * GLSL twin in {@link BloomPyramid} and {@link PostFxPass}; keeping them in step
 * is the whole point of testing this layer.
 */
/** Below this many pixels a further halving has nothing left to blur. */
declare const MIN_PYRAMID_DIMENSION = 4;
/** The pyramid never grows past this many levels, whatever the resolution. */
declare const MAX_PYRAMID_LEVELS = 6;
/**
 * The soft-knee half-width of the bright pass, as a fraction of the 0..1 range.
 * A hard threshold makes bloom pop on and off as a pixel crosses it; the knee
 * fades contribution in across `threshold ± knee` so motion stays smooth.
 */
declare const BLOOM_KNEE = 0.5;
/**
 * How many downsample levels a frame of the given size supports: each level
 * halves both dimensions, stopping once the shorter side would fall below
 * {@link MIN_PYRAMID_DIMENSION} or {@link MAX_PYRAMID_LEVELS} is reached. Always
 * at least one, so a bloom is drawn even for a tiny frame.
 */
declare function pyramidLevelCount(width: number, height: number, maxLevels?: number): number;
/** The pixel size of pyramid level `index` (0 = half the base resolution). */
declare function pyramidLevelSize(baseWidth: number, baseHeight: number, index: number): {
    width: number;
    height: number;
};
/**
 * The soft-knee bright pass (Unity's bloom prefilter). Returns the input colour
 * scaled by how far its brightest channel sits above `threshold`: nothing below
 * `threshold - knee`, the full colour above `threshold + knee`, a quadratic ramp
 * between. Scaling the whole colour rather than each channel keeps the hue of a
 * bright pixel intact instead of tinting the glow toward whichever channel
 * crossed first.
 */
declare function softKneePrefilter(rgb: readonly [number, number, number], threshold: number, knee?: number): [number, number, number];
/**
 * The ACES filmic tonemap for one channel: an S-curve that is near-linear in the
 * shadows and rolls asymptotically toward 1 in the highlights, so summed HDR
 * light compresses into range instead of clipping flat to white. Narkowicz's
 * fitted approximation of the full ACES curve.
 */
declare function acesFilmicChannel(x: number): number;
/**
 * Apply the ACES rolloff to an RGB colour after an exposure multiply. The result
 * is always within 0..1, so however bright the pre-tonemap light was, nothing
 * clips — it rolls off instead.
 */
declare function acesFilmic(rgb: readonly [number, number, number], exposure?: number): [number, number, number];

/**
 * Pure lens-and-surface maths the single-pass post-process shader is a port of,
 * kept DOM-free so the same arithmetic the GLSL runs can be unit-tested headlessly
 * — the pattern {@link ./bloomModel.ts} established for bloom.
 *
 * Two screen-space effects for the cinematic 2.5D look share this file because
 * both key their behaviour off the vertical screen coordinate — the only "depth"
 * a flat frame has:
 *
 * - Tilt-shift depth of field: a horizontal band of the frame stays sharp and
 *   everything above/below it blurs, the miniature-diorama look REPLACED and THE
 *   LAST NIGHT lean on. Screen row stands in for distance.
 * - Screen-space reflection: the picture above a horizon line is mirrored down
 *   into the floor below it and faded with distance, the wet-street reflection
 *   those games use everywhere (and that Neon City hand-rolled per cart).
 *
 * The UV convention matches the shader: y = 0 is the top row, y = 1 the bottom.
 */
/** Feather distance (in screen-height units) over which DoF ramps to full blur. */
declare const TILT_SHIFT_FEATHER = 0.35;
/**
 * Blur weight, 0..1, for a pixel at screen row `y` given a tilt-shift focus band.
 *
 * Inside the band — within `range` of `focus` — the weight is 0 (perfectly
 * sharp). Outside it, the weight ramps up linearly over {@link TILT_SHIFT_FEATHER}
 * and saturates at 1, so the transition from focus to full blur is smooth rather
 * than a hard edge. The shader multiplies this by the effect strength to get the
 * sampling radius, so a returned 0 costs nothing and reads as untouched.
 *
 * @param y      Screen row, 0 (top) .. 1 (bottom).
 * @param focus  Centre of the in-focus band, 0..1.
 * @param range  Half-height of the fully-sharp band, in screen-height units.
 */
declare function tiltShiftBlur(y: number, focus: number, range: number): number;
/**
 * The source row to sample for a mirror reflection of `y` about `horizon`.
 *
 * A pixel `d` below the horizon reflects the pixel `d` above it, so the world
 * standing on the floor appears upside-down in it. Returned unclamped; the shader
 * clamps to the frame and the {@link reflectionFade} of an off-frame sample is
 * already near zero.
 */
declare function reflectionSampleY(y: number, horizon: number): number;
/**
 * Reflection opacity, 0..1, for a pixel at screen row `y`.
 *
 * Zero at and above the horizon (nothing reflects into the scene itself), then
 * fading linearly from full strength at the horizon to zero `falloff` below it —
 * a wet floor mirrors what is close to the waterline sharply and loses the far
 * scene, which is what sells it as a surface rather than a flip of the image.
 *
 * @param y        Screen row, 0 (top) .. 1 (bottom).
 * @param horizon  Row of the reflective surface's near edge, 0..1.
 * @param falloff  How far below the horizon the reflection persists, in screen-height units.
 */
declare function reflectionFade(y: number, horizon: number, falloff: number): number;

/**
 * Gap #3 part 2 — rendering a declared scene.
 *
 * Turns a {@link SceneSpec} (sceneModel.ts) into a composited parallax backdrop:
 * each layer's sprite-sheet region is read to RGBA through a {@link
 * SpriteRegionSource}, becomes a {@link ParallaxLayer}, and the whole set is
 * composited with parallax scroll + aerial-perspective atmosphere by
 * composeParallax. The camera is driven by the scene's auto-scroll plus an
 * optional cart-supplied offset (so gameplay can pan the world).
 *
 * Pure and DOM-free: the sprite source is a tiny interface the real engine (or a
 * test) satisfies, so this is unit-testable without a WASM core or a canvas.
 * Intended app home: packages/player/src/scene/.
 */

/** An RGBA image read out of the cart's sprite sheet. */
interface RegionImage {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
}
/** Reads a rectangular tile region of the cart's sprite sheet as straight-alpha RGBA. */
interface SpriteRegionSource {
    readRegion(page: 0 | 1, tile: number, tilesW: number, tilesH: number): RegionImage;
}
/**
 * Resolve a scene's layers to renderable {@link ParallaxLayer}s by reading each
 * region's pixels once. Call this when the scene or the cart's art changes, not
 * every frame — the images are static; only the camera moves.
 */
declare function resolveSceneLayers(spec: SceneSpec, source: SpriteRegionSource): ParallaxLayer[];
/**
 * The camera for a given presented frame: the scene's constant auto-scroll plus
 * an optional cart-supplied base offset (e.g. the player's world position, which
 * a cart can publish for the backdrop to follow).
 */
declare function cameraAt(spec: SceneSpec, frame: number, base?: ParallaxCamera): ParallaxCamera;
/**
 * Fill `out` with a vertical sky gradient (dark zenith → the atmosphere's fog
 * colour at the horizon), so distant layers hazing toward fog meet a matching
 * sky. Convenience for the common case; a cart can paint its own sky instead.
 */
declare function fillSky(out: Uint8ClampedArray, width: number, height: number, atmosphere: AtmosphereParams, horizonY?: number): void;
/**
 * Render the full backdrop for one frame into `out`: sky, then the parallax
 * layers with atmosphere at the frame's camera. `layers` come from
 * {@link resolveSceneLayers} (resolved once and reused).
 */
declare function renderSceneBackdrop(out: Uint8ClampedArray, width: number, height: number, layers: readonly ParallaxLayer[], spec: SceneSpec, frame: number, base?: ParallaxCamera): void;

/**
 * Gap #3 part 3 — composite a cart's live frame over the parallax backdrop.
 *
 * A TIC-80 cart draws an opaque, full-screen framebuffer, so a backdrop can only
 * show if the cart LEAVES it room: the runtime treats every pixel the cart drew
 * in its background "key" colour as transparent and shows the backdrop there,
 * keeping the rest as the cart's foreground. This is chroma-keying on the cart's
 * own palette background (index 0 by convention; configurable via the scene's
 * keyColor) — the standard, zero-cost way to layer a backdrop behind sprite art.
 *
 * It runs on the RAW cart frame, before lighting + post-FX, so the composited
 * image (backdrop + foreground) is what those later passes finish together.
 *
 * Pure and DOM-free (RGBA in / RGBA out). Intended app home:
 * packages/player/src/scene/.
 */

/**
 * Composite `cartFrame` over `backdrop`: where the cart pixel matches `keyRgb`
 * (its background colour, resolved from the cart palette), show the backdrop;
 * everywhere else keep the cart's own pixel.
 *
 * @param cartFrame The cart's raw RGBA framebuffer (width*height*4).
 * @param backdrop  The rendered scene backdrop, same dimensions.
 * @param width     Framebuffer width.
 * @param height    Framebuffer height.
 * @param keyRgb    The background colour to key out (the cart palette's keyColor).
 * @param tolerance Per-channel match tolerance (0 = exact). Default 0.
 * @param out       Optional target buffer; defaults to a fresh one.
 * @returns The composited RGBA (the same array as `out` when supplied).
 */
declare function compositeOverBackdrop(cartFrame: Uint8ClampedArray, backdrop: Uint8ClampedArray, width: number, height: number, keyRgb: Rgb$1, tolerance?: number, out?: Uint8ClampedArray): Uint8ClampedArray;

/**
 * A {@link SpriteRegionSource} that reads a loaded cart's sprite sheet at runtime.
 *
 * The scene backdrop's layers reference regions of the cart's OWN sprite art; to
 * render them the player reads those tiles out of a cart object created from the
 * same .tic bytes (the `cbx_cart_*` authoring API the engine exposes), resolves
 * each pixel through the cart palette, and returns straight-alpha RGBA — palette
 * index 0 (the sheet's transparent colour) becomes a hole so sky shows through.
 *
 * Bit depth is derived from the model's palette size (Classic packs 4bpp, Pro and
 * the rest are 8bpp), mirroring the editor's tile codec, so no engine change is
 * needed. Pure apart from the WASM reads; the module handle is loosely typed
 * because the engine glue is (matching engine.ts).
 */

/** A region source plus the cart palette lookup + teardown the player needs. */
interface CartSpriteSource {
    source: SpriteRegionSource;
    /** The RGB of a cart palette index (e.g. the scene's background keyColor). */
    paletteRgb(index: number): Rgb$1;
    /** Free the cart object. */
    dispose(): void;
}
type EngineModule = any;
/**
 * Build a region source over a cart's bytes. Returns the source plus a `dispose`
 * that frees the cart object; call it when the player tears down. Returns null if
 * the engine lacks the cart API or the cart fails to load, so the caller can skip
 * the backdrop rather than crash.
 */
declare function createCartSpriteSource(module: EngineModule, bytes: Uint8Array, paletteSize: number): CartSpriteSource | null;

/**
 * SceneBackdropSurface — a display surface that draws a parallax scene backdrop
 * behind the cart's live frame, then presents the result through an inner surface.
 *
 * It decorates any {@link DisplaySurface} (plain 2D, lit, or the FX chain's base):
 * each frame it renders the declared backdrop (parallax layers + aerial-perspective
 * atmosphere) at the scene camera, chroma-keys the cart's own frame over it (the
 * cart's background colour shows the backdrop, its foreground is kept), and blits
 * the composite to the inner surface. Because it runs on the RAW frame before the
 * inner surface, any lighting / post-FX the inner surface applies finishes the
 * backdrop and foreground together.
 *
 * The layers are resolved once (their pixels are static); only the camera advances
 * per frame, so per-frame cost is one composite pass.
 */

/**
 * Per-frame animation overrides for one layer, addressed by its index in the
 * declared scene. Offsets ADD to the layer's authored placement (sway around a
 * base); opacity/emissive are absolute. Deliberately structural — the scene does
 * not depend on the anim module — and deliberately pixel-free, so the pre-hazed
 * layer cache stays valid (sprite-frame swaps, which would invalidate it, are the
 * foreground surface's job, not a scene layer's).
 */
interface SceneLayerOverride {
    opacity?: number;
    offsetX?: number;
    offsetY?: number;
    emissive?: number;
}
declare class SceneBackdropSurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly spec;
    private readonly keyRgb;
    private frame;
    /** The cart-published camera base, added to the scene's auto-scroll each frame. */
    private cameraBase;
    /** Per-layer animation overrides for this frame, keyed by layer index (or null). */
    private layerOverrides;
    /** Layers with aerial haze baked in once (see prehazeLayers) — the per-frame win. */
    private readonly hazedLayers;
    /** The sky gradient, computed once (it depends only on the constant atmosphere). */
    private readonly sky;
    private readonly backdrop;
    private readonly composited;
    private readonly presented;
    constructor(inner: DisplaySurface, width: number, height: number, layers: readonly ParallaxLayer[], spec: SceneSpec, keyRgb: Rgb$1);
    /**
     * Set the backdrop camera the cart published this frame (via `cartbox.camera`).
     * Added to the scene's own auto-scroll, so an auto-scroll-only cart that never
     * sets it keeps panning as before with the default (0, 0).
     */
    setCameraBase(base: ParallaxCamera): void;
    /**
     * Set this frame's per-layer animation overrides (or null for none). Applied on
     * top of the pre-hazed layers without touching their baked pixels, so the
     * frame-invariant haze cache is preserved.
     */
    setLayerOverrides(overrides: Record<number, SceneLayerOverride> | null): void;
    /** The layers to composite this frame: the cached ones, plus any overrides. */
    private frameLayers;
    blit(rgba: Uint8Array): void;
    destroy(): void;
}

/**
 * Cinematic gap #1 (animation timeline) — pure, deterministic playback.
 *
 * The host feeds the frame clock (the same counter scene auto-scroll uses) and
 * gets back the resolved animation state for that tick: which sprite frame each
 * clip is on, each track's sampled value routed to its target, and each foreground
 * placement's current transform. No engine, no DOM, no time — same tick in, same
 * state out — so the wiring half (Phase B) and the editor preview can share it and
 * it is fully unit-testable.
 *
 * Combine semantics (how a sampled value meets the thing it drives) are the
 * wiring's job, not this module's: `evaluate` returns absolute sampled numbers.
 */

/** The frame a clip shows at a given tick. */
interface ClipSample {
    region: SpriteRegion;
    /** Index into the clip's original `frames` array. */
    frameIndex: number;
}
/** A foreground placement resolved for one tick. */
interface ResolvedPlacement {
    region: SpriteRegion;
    frameIndex: number;
    x: number;
    y: number;
    opacity: number;
    scale: number;
    depth: number;
}
/** Everything animated at one tick. */
interface AnimState {
    /** Scene-layer channel overrides, keyed by layer index. */
    layers: Record<number, Partial<Record<LayerChannel, number>>>;
    /** Post-FX value overrides, keyed by effect value key (e.g. "bloom.strength"). */
    postfx: Record<string, number>;
    placements: ResolvedPlacement[];
}
/**
 * Which frame a clip shows at `frame` ticks, honoring per-frame durations and the
 * clip's repeat mode. `once` clamps at the last frame; loop/pingpong wrap.
 * Assumes a non-empty clip with durations aligned to frames (parseAnim guarantees).
 */
declare function sampleClipFrame(clip: AnimClip, frame: number): ClipSample;
/**
 * A track's value at `frame`, folded into its key range by mode. `hold` clamps to
 * the end values; `loop` wraps over `loopLength` (defaulting to the key span);
 * `pingpong` reflects over the key span into a triangle wave.
 */
declare function sampleTrack(track: AnimTrack, frame: number): number;
/**
 * Resolve the whole animation set at one tick. Tracks are routed to their targets
 * (scene layer / post-fx / placement channel); placements resolve their clip's
 * current frame and apply any placement-channel track overrides over their base
 * transform. Placements whose clip is missing are skipped (parseAnim already drops
 * unknown-clip placements; this is belt-and-braces).
 */
declare function evaluate(spec: AnimSpec, frame: number): AnimState;

/**
 * Cinematic gap #1 (animation timeline) — procedural track generators.
 *
 * The artist-friendly path: instead of hand-placing dozens of keyframes for a
 * neon buzz or a drifting cloud, call a generator and get a ready `keys`/`mode`
 * shape to drop onto a target. Output is plain keyframes (not a hidden analytic
 * evaluator) so the sidecar stays self-describing and the editor can show and tweak
 * the generated curve — Phase-A pragmatism over the spec's analytic option, which
 * can come later if periodic-noise JSON size ever bites.
 *
 * All generators are deterministic (flicker is seeded), so preview == reload.
 */

/** A generated track shape: merge with a target to form an AnimTrack. */
interface GeneratedTrack {
    keys: Keyframe[];
    mode: TrackMode;
    loopLength?: number;
}
/**
 * A breathing glow: smoothly rises from `min` to `max` and back over `period`
 * ticks. Pingpong makes the return automatic, so two keys suffice.
 */
declare function pulse(period: number, min: number, max: number): GeneratedTrack;
/**
 * A sinusoid-like sway of `±amplitude` around `center` over `period` ticks — for
 * idle bob, gentle offset drift on a foreground element, or a swaying sign.
 */
declare function sway(period: number, amplitude: number, center?: number): GeneratedTrack;
/**
 * Linear travel from 0 to `distance` over `period` ticks, then a seamless jump
 * back to 0 — for drifting fog/clouds on a wrapX scene layer (the wrap hides the
 * reset). Bind to a layer's offsetX/offsetY.
 */
declare function drift(period: number, distance: number): GeneratedTrack;
/**
 * Erratic buzz between `min` and `max` — for neon flicker or a failing lamp.
 * `steps` random hard-switch levels are spread over `period` ticks and loop; the
 * same `seed` always yields the same pattern. Bind to a layer's emissive/opacity.
 */
declare function flicker(period: number, min: number, max: number, steps?: number, seed?: number): GeneratedTrack;

/**
 * AnimatedForegroundSurface — a display surface that draws animated placements
 * (foreground set-dressing) over the presented frame, then hands off to an inner
 * surface.
 *
 * Each placement is one frame of an AnimClip drawn from the cart's OWN sprite
 * sheet (via a {@link SpriteRegionSource}) at a position, scale, and opacity the
 * animation resolved for this tick (see animPlayer's `evaluate`). It decorates any
 * {@link DisplaySurface} and sits INSIDE the scene backdrop but OUTSIDE lighting/
 * post-FX: placements land in front of the cart + parallax backdrop, and the
 * inner surface's lighting/FX finish them together with the rest of the frame.
 *
 * Region pixels are static for the cart's life, so they are read once and cached;
 * per-frame cost is a frame copy plus the composited placement footprints (nothing
 * when there are no placements — the pass-through fast path).
 */

declare class AnimatedForegroundSurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly source;
    private placements;
    /** Static region pixels cached by region key (page:tile:tilesW:tilesH). */
    private readonly regionCache;
    private readonly output;
    private readonly presented;
    constructor(inner: DisplaySurface, width: number, height: number, source: SpriteRegionSource);
    /** Set the placements resolved for this frame (empty for none). */
    setPlacements(placements: readonly ResolvedPlacement[]): void;
    private region;
    blit(rgba: Uint8Array): void;
    /** Nearest-neighbour scale + straight-alpha composite of one placement. */
    private drawPlacement;
    destroy(): void;
}

/**
 * The deterministic particle field — cinematic gap #6. Turns one
 * {@link ParticleEmitter} into the set of particles visible at a given frame,
 * with zero retained state: a particle's whole trajectory is a closed-form
 * function of its index and the frame counter, so the same frame always yields
 * the same field (matching the editor preview to playback and to a replay) and
 * there is nothing to advance or reset. This is the classic stateless
 * screen-wrapping particle field, and being pure it can be unit-tested headlessly
 * the way the scene and anim models are.
 *
 * The per-kind character lives here, not in the sidecar: rain streaks and slants,
 * snow drifts and sways, embers rise and flicker and fade as they climb, fog
 * crawls sideways in large soft blobs. An emitter only supplies the handful of
 * knobs those share (count/colour/opacity/size/speed/wind).
 */

/** One drawable particle at a moment in time. */
interface Particle {
    /** Column in framebuffer pixels. */
    x: number;
    /** Row in framebuffer pixels. */
    y: number;
    /** Footprint size in pixels. */
    size: number;
    /** Composite alpha, 0..1. */
    alpha: number;
    /** Colour, each channel 0..255. */
    color: readonly [number, number, number];
    /** Vertical streak length in pixels (rain); 0 draws a dot. */
    streak: number;
}
/**
 * The particles an emitter shows at `frame`, wrapped into a `width`×`height` field.
 *
 * Every particle is placed from its hashed spawn point and advanced by the frame
 * clock along its kind's motion; screen-wrapping keeps the field full forever
 * without spawning or retiring anything. Positions are always inside the field.
 */
declare function simulateEmitter(emitter: ParticleEmitter, frame: number, width: number, height: number): Particle[];

/**
 * ParticleOverlaySurface — a display surface that composites a declared weather
 * system (rain/snow/embers/fog) over each presented frame, then hands off to an
 * inner surface. Cinematic gap #6.
 *
 * It decorates any {@link DisplaySurface} and is placed as the INNERMOST decorator
 * (wrapping the base terminal surface, inside the animated foreground and scene
 * backdrop): the weather is drawn last into the framebuffer, so it lands in front
 * of the cart, its parallax backdrop, and any foreground set-dressing — and when a
 * post-FX stack is active it wraps the whole base, so the weather is graded and
 * bloomed with the scene rather than pasted on flat.
 *
 * The field is stateless ({@link simulateEmitter}): each blit advances a frame
 * counter — kept in lockstep with the run loop, one tick per present — and redraws
 * the particles that frame implies, with no simulation to retain. A spec with no
 * emitters is a straight pass-through.
 */

declare class ParticleOverlaySurface implements DisplaySurface {
    private readonly inner;
    private readonly width;
    private readonly height;
    private readonly spec;
    private frame;
    private readonly output;
    private readonly presented;
    constructor(inner: DisplaySurface, width: number, height: number, spec: ParticleSpec);
    blit(rgba: Uint8Array): void;
    destroy(): void;
    /** Straight-alpha composite one particle: a vertical streak, or a square dot. */
    private draw;
    /** Alpha-blend a particle's colour onto one framebuffer pixel (bounds-checked). */
    private blend;
}

/**
 * @cartbox/player — public entry point.
 *
 * Usage:
 *   import { mount } from "@cartbox/player";
 *   const handle = mount(document.getElementById("player")!, {
 *     cartUrl: "https://cdn.cartbox.dev/carts/abc123.tic",
 *     engineUrl: "https://cdn.cartbox.dev/engine/tic80.js",
 *     controls: "auto",
 *     scale: "fit",
 *   });
 *   // later: handle.pause(); handle.resume(); handle.destroy();
 */

/**
 * Mounts a cartridge player into a container element and begins loading.
 *
 * Loading is asynchronous; the returned handle is usable immediately, and
 * lifecycle callbacks (`onReady`, `onError`) report progress. When `autostart`
 * is false (the default), the loop is armed but only runs once `resume()` is
 * called from a user gesture — required for audio on mobile browsers.
 *
 * @param container Element the canvas and any touch controls are appended to.
 * @param options Cartridge/engine URLs and playback preferences.
 * @returns A handle to pause, resume, or destroy the player.
 */
declare function mount(container: HTMLElement, options: PlayerOptions): PlayerHandle;

export { type AnimClip, type AnimMode, type AnimPlacement, type AnimSpec, type AnimState, type AnimTarget, type AnimTrack, AnimatedForegroundSurface, type AtmosphereParams, BLOOM_KNEE, BloomPyramid, type BuiltLightingRenderer, CAMERA_BASE, CAMERA_SCALE, CARTBOX_SDK_LUA, type CartSpriteSource, CartridgeLoadError, type ClipSample, ConsoleButton, type ConsoleInstance, type ConsoleModel, type ControlScheme, DEFAULT_ATMOSPHERE, DEFAULT_KEY_BINDINGS, DEFAULT_MODEL_ID, type DeviceProvider, EVENT_CAPACITY, type Ease, type GeneratedTrack, type InnerSurfaceFactory, type InputChange, type Keyframe, LIGHTS_BASE, LIGHTS_CAPACITY, LIGHT_STRIDE, type LayerChannel, type Light, type LightingBackend, type LightingFrameContext, LightingLayer, type LightingOptions, type LightingRenderer, type LightingScene, LitCanvasSurface, MAILBOX_TYPE_ACHIEVEMENT, MAILBOX_TYPE_PROGRESS, MAILBOX_TYPE_SCORE, MAILBOX_WORDS, MAX_EMITTERS, MAX_PARTICLES_PER_EMITTER, MAX_PYRAMID_LEVELS, MIN_PYRAMID_DIMENSION, MODELS, type MailboxCamera, type MailboxEvent, type MailboxEventKind, type MailboxRead, type MaterialBuffer, type ModelId, NORMAL_DIRECTION_COUNT, NORMAL_VECTORS, PARTICLE_KINDS, POST_FX_EFFECTS, type Particle, type ParticleEmitter, type ParticleKind, ParticleOverlaySurface, type ParticleSpec, type PlacementChannel, type PlayerHandle, type PlayerOptions, type PostFxColorDef, type PostFxEffectDef, type PostFxEffectId, type PostFxParamDef, PostFxPass, type PostFxSettings, type PostFxSource, PostFxSurface, type PostFxUniforms, REPLAY_VERSION, type RegionImage, type RegisteredAchievement, type RenderCanvas, type Replay, ReplayError, ReplayRecorder, ReplaySource, type ResolvedPlacement, type Rgb, type ScaleMode, SceneBackdropSurface, type SceneCamera, type SceneLayer, type SceneSpec, type SpriteRegion, type SpriteRegionSource, TILT_SHIFT_FEATHER, type TrackMode, type Vec3, type VerificationResult, WebgpuLightingLayer, acesFilmic, acesFilmicChannel, anyPostFxEnabled, cameraAt, composeParallax, compositeOverBackdrop, createCartSpriteSource, createConsole, createFlatMaterial, createLightingLayer, decodeCamera, decodeLights, decodeMailbox, defaultPostFxSettings, drift, emitterPreset, evaluate, extractScore, extractUnlocks, fillSky, flicker, frameDurationMs, framebufferBytes, getModel, getWebgpuDevice, hashCart, hashEventId, hexToRgb01, injectSdk, interpolateNormal, loadEngineModule, mount, nearestDirection, normalVector, paramKey, parseAnim, parseParticles, parsePostFxSettings, parseReplay, parseScene, prehazeLayers, pulse, pyramidLevelCount, pyramidLevelSize, randomSeed, readCartCode, reflectionFade, reflectionSampleY, renderSceneBackdrop, resolveButton, resolveSceneLayers, resolveUnlockedAchievements, runReplayEvents, sampleClipFrame, sampleNormalBilinear, sampleTrack, seedCartridge, serializeReplay, shade, simulateEmitter, softKneePrefilter, sway, tiltShiftBlur, uniformsFromSettings, verifyReplayScore };

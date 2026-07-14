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
type ModelId = "classic" | "pro" | "voxel";
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
/** A coloured point light positioned over the console framebuffer. */
interface Light {
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
 */
type PostFxEffectId = "grade" | "fog" | "bloom" | "crt" | "chroma" | "vignette" | "posterize";
interface PostFxParamDef {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
}
interface PostFxEffectDef {
    id: PostFxEffectId;
    label: string;
    description: string;
    params: PostFxParamDef[];
    /** Effect exposes a colour picker (fog tint). */
    hasColor?: boolean;
}
declare const POST_FX_EFFECTS: PostFxEffectDef[];
/** Key for one parameter's value in the settings map. */
declare function paramKey(effect: PostFxEffectId, param: string): string;
interface PostFxSettings {
    enabled: Record<PostFxEffectId, boolean>;
    values: Record<string, number>;
    /** Fog tint as #rrggbb. */
    fogColor: string;
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
    curvature: number;
    scanlines: number;
    aberration: number;
    vignette: number;
    /** 0 disables posterisation; otherwise the level count. */
    posterize: number;
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
declare const CARTBOX_SDK_LUA = "local _MB = 192\nlocal _CAP = 8\nlocal _LB = _MB + 25\nlocal _LCAP = 6\nlocal _ln = 0\nlocal function _emit(kind, id, value)\n  local seq = pmem(_MB)\n  local slot = seq % _CAP\n  local base = _MB + 1 + slot * 3\n  pmem(base, kind)\n  pmem(base + 1, id)\n  pmem(base + 2, value)\n  pmem(_MB, seq + 1)\nend\nlocal function _hash(s)\n  local h = 2166136261\n  for i = 1, #s do\n    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff\n  end\n  return h\nend\ncartbox = {\n  unlock = function(id) _emit(1, _hash(id), 0) end,\n  score = function(v) _emit(2, 0, v // 1) end,\n  progress = function(id, v) _emit(3, _hash(id), v // 1) end,\n  clearlights = function() _ln = 0 pmem(_LB, 0) end,\n  light = function(x, y, radius, r, g, b, z, intensity)\n    if _ln >= _LCAP then return end\n    local base = _LB + 1 + _ln * 6\n    pmem(base, x // 1)\n    pmem(base + 1, y // 1)\n    pmem(base + 2, (z or 12) // 1)\n    pmem(base + 3, radius // 1)\n    local rr = (r or 255) & 0xff\n    local gg = (g or 255) & 0xff\n    local bb = (b or 255) & 0xff\n    pmem(base + 4, (rr << 16) | (gg << 8) | bb)\n    pmem(base + 5, ((intensity or 1) * 256) // 1)\n    _ln = _ln + 1\n    pmem(_LB, _ln)\n  end,\n}";
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
 * Effect order mirrors a physical signal path: sample through CRT curvature
 * and chromatic aberration, add bloom, then grade → posterize → fog →
 * vignette → scanlines on the composed colour.
 */

/** A frame to post-process: raw RGBA bytes or a canvas to sample. */
type PostFxSource = Uint8Array | Uint8ClampedArray | TexImageSource;
declare class PostFxPass {
    private readonly gl;
    private readonly program;
    private readonly texture;
    private readonly uniformLocations;
    private constructor();
    /** Returns null when WebGL is unavailable or the shaders fail to compile. */
    static create(canvas: HTMLCanvasElement): PostFxPass | null;
    private location;
    /** Upload one frame and draw it through the effect chain. */
    render(source: PostFxSource, width: number, height: number, uniforms: PostFxUniforms): void;
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

export { type BuiltLightingRenderer, CARTBOX_SDK_LUA, CartridgeLoadError, ConsoleButton, type ConsoleInstance, type ConsoleModel, type ControlScheme, DEFAULT_KEY_BINDINGS, DEFAULT_MODEL_ID, type DeviceProvider, EVENT_CAPACITY, type InnerSurfaceFactory, type InputChange, LIGHTS_BASE, LIGHTS_CAPACITY, LIGHT_STRIDE, type Light, type LightingBackend, type LightingFrameContext, LightingLayer, type LightingOptions, type LightingRenderer, type LightingScene, LitCanvasSurface, MAILBOX_TYPE_ACHIEVEMENT, MAILBOX_TYPE_PROGRESS, MAILBOX_TYPE_SCORE, MAILBOX_WORDS, MODELS, type MailboxEvent, type MailboxEventKind, type MailboxRead, type MaterialBuffer, type ModelId, NORMAL_DIRECTION_COUNT, NORMAL_VECTORS, POST_FX_EFFECTS, type PlayerHandle, type PlayerOptions, type PostFxEffectDef, type PostFxEffectId, type PostFxParamDef, PostFxPass, type PostFxSettings, type PostFxSource, PostFxSurface, type PostFxUniforms, REPLAY_VERSION, type RegisteredAchievement, type RenderCanvas, type Replay, ReplayError, ReplayRecorder, ReplaySource, type Rgb, type ScaleMode, type Vec3, type VerificationResult, WebgpuLightingLayer, anyPostFxEnabled, createConsole, createFlatMaterial, createLightingLayer, decodeLights, decodeMailbox, defaultPostFxSettings, extractScore, extractUnlocks, frameDurationMs, framebufferBytes, getModel, getWebgpuDevice, hashCart, hashEventId, hexToRgb01, injectSdk, loadEngineModule, mount, nearestDirection, normalVector, paramKey, parsePostFxSettings, parseReplay, randomSeed, readCartCode, resolveButton, resolveUnlockedAchievements, runReplayEvents, seedCartridge, serializeReplay, shade, uniformsFromSettings, verifyReplayScore };

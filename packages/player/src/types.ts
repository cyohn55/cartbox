import type { DecodedTexture, EncodedImage } from "@cartbox/editor";
import type { PhysicsBackend } from "./physics/physicsSession.js";
import type { QualityChoice, QualityLevel } from "./quality.js";
/**
 * Public and shared types for @cartbox/player.
 *
 * Kept free of DOM/engine imports so it can be consumed by any module without
 * pulling in browser or WASM dependencies.
 */

import type { NetSession } from "./net/NetSession.js";
import type { ControlSettings } from "./controls.js";
import type { ModelId } from "./models.js";
import type { Replay } from "./replay.js";
import type { MailboxEvent } from "./mailbox.js";
import type { LightingOptions } from "./lighting/types.js";
import type { PostFxSettings } from "./fx/postfx.js";
import type { SceneSpec } from "./scene/sceneModel.js";
import type { AnimSpec } from "./anim/animModel.js";
import type { ParticleSpec } from "./particles/particleModel.js";
import type { MeshScene } from "./mesh/meshScene.js";
import type { WorldScene } from "./world/worldScene.js";
import type { CollisionField } from "./collisionSdk.js";
import type { FlagsField } from "./flagsSdk.js";

/**
 * Which input methods the player wires up.
 * - "auto": keyboard on devices with a fine pointer, on-screen touch controls otherwise.
 * - "keyboard": keyboard only.
 * - "touch": on-screen controls only.
 */
export type ControlScheme = "auto" | "keyboard" | "touch";

/**
 * How the console image is sized inside its container.
 * - "fit": largest size that fits, preserving aspect ratio (may be fractional — smooth).
 * - "integer": largest whole-number multiple that fits (crisp, no pixel shimmer).
 * - number: an explicit scale multiplier (e.g. 3 renders at 3x native).
 */
export type ScaleMode = "fit" | "integer" | number;

/** The eight face/direction buttons of a TIC-80 gamepad. Values are bit positions. */
export enum ConsoleButton {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
  A = 4,
  B = 5,
  X = 6,
  Y = 7,
}

/** Options accepted by {@link mount}. Only `cartUrl` is required. */
export interface PlayerOptions {
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
   * Called with the message when the cart's Lua raises a runtime error mid-frame.
   * The core keeps running (it aborts only that frame's TIC), so this is a report
   * for the creator (e.g. the playtest HUD), not a fatal `onError`. Fires once per
   * new error; no-op on engines built before runtime-error capture.
   */
  onRuntimeError?: (message: string) => void;
  /**
   * Online multiplayer: a joined {@link NetSession} the player feeds before and
   * after every tick (the cart talks to it through pmem 0..118 via the SDK's
   * cartbox.net* functions). Omitted: the cart plays offline.
   */
  netplay?: NetSession;
  /**
   * Creates the physics engine for a cart whose scene objects have bodies
   * (ENGINE_ROADMAP.md, Phase 2). Supplied by the host so the engine (Rapier in
   * the web app) is only downloaded for carts that use it. Omitted, bodies stay
   * where they were placed and the cart's physics calls are no-ops.
   *
   * `deterministic` is set when the scene asks for deterministic physics: the
   * host should then supply an engine that computes the same result on every
   * platform (the player rounds its own inputs to match).
   */
  physics?: (options: { deterministic: boolean }) => Promise<PhysicsBackend>;
  /**
   * Loads a KTX2 (Basis Universal) texture decoder. Called only for a mesh scene
   * that has KTX2 textures; without it they render as their flat base colour.
   * The web app passes one that fetches the transcoder on demand.
   */
  ktx2?: () => Promise<(bytes: Uint8Array) => DecodedTexture | null>;
  /**
   * Graphics quality: "low" | "medium" | "high", or "auto" (the default) to pick
   * from the device — see quality.ts. High is everything as authored.
   */
  quality?: QualityChoice;
  /**
   * Control settings (aim inversion, look sensitivity, controller and keyboard
   * bindings, touch pad size/opacity). Change them live with
   * {@link PlayerHandle.setControlSettings}. Defaults: DEFAULT_CONTROL_SETTINGS.
   */
  controlSettings?: ControlSettings;
  /**
   * The player pressed Start (a controller's Start/Back, the touch pad's Start,
   * or Enter / P): the host opens its menu. Without it there is no Start button.
   */
  onStart?: () => void;
  /** Master volume, 0..1 (default 1). */
  volume?: number;
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
  /**
   * Rasterise a declared 3D mesh scene over each frame: imported triangle meshes
   * (OBJ/glTF/GLB) placed by transforms, drawn by a pure software rasteriser
   * (the runtime has no GPU triangle path). Composited over the cart frame with a
   * shared depth buffer, and — being a decorator — graded and bloomed through the
   * lighting + post-FX stack. The scene auto-orbits for now; a later draw mailbox
   * will let a cart drive the camera. Parse a cart's `mesh` sidecar into a
   * MeshScene with `parseMeshScene`.
   */
  mesh?: MeshScene;
  /**
   * Render a declared HD-2D {@link WorldScene}: a height-mapped 3D tile world with
   * the cart's own 2D character sprites standing in it as camera-facing billboards,
   * all sharing one depth buffer so terrain and characters occlude correctly. The
   * cart drives the camera with `cartbox.worldcam` and places characters with
   * `cartbox.billboard` (both reuse the mesh camera/pose mailbox channels). Parse a
   * cart's `world` sidecar into a WorldScene with `parseWorldScene`.
   */
  world?: WorldScene;
  /**
   * Expose the cart's authored collision layer to its own Lua as
   * `cartbox.solid(x, y)` (true when a map cell is solid) and `cartbox.mapsize()`.
   * The whole bitmap is injected once as cart data — collision never changes
   * during play — so the cart runs its own physics against it with no per-frame
   * protocol. Parse a cart's sidecar into a CollisionField with
   * `parseCollisionField`.
   */
  collision?: CollisionField;
  /**
   * Expose the cart's authored tile-flags layer to its own Lua as
   * `cartbox.flag(cx, cy, n)` (flag n, 0..7, on that map cell). Injected once as
   * static cart data alongside collision. Parse a cart's sidecar into a
   * FlagsField with `parseFlagsField`.
   */
  flags?: FlagsField;
  /**
   * Called once per presented frame (after blit), for lightweight instrumentation
   * — an editor playtest HUD counting these gets the cart's true 60Hz frame rate
   * rather than the browser's paint rate. Keep the handler cheap; it runs every
   * frame.
   */
  onFrame?: () => void;
}

/** Handle returned by {@link mount} for controlling a live player instance. */
export interface PlayerHandle {
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
  /** Apply new control settings at once (bindings, inversion, sensitivity, touch pad). */
  setControlSettings(settings: ControlSettings): void;
  /** Master volume, 0..1. */
  setVolume(volume: number): void;
  /** Hold the game's input neutral (false) while a host menu is open over it, or restore it. */
  setInputEnabled(enabled: boolean): void;
  /**
   * A snapshot of the cart's scene objects as they are this frame (live
   * inspection): where each one is, whether it's shown, and its physics state.
   * Empty when the cart has no 3D scene.
   */
  inspect(): InspectedObject[];
  /** Change the graphics preset live: "low" | "medium" | "high" | "auto" (see quality.ts). */
  setQuality(choice: QualityChoice): void;
  /**
   * Hand the running scene streamed textures, keyed by the `ref` of the
   * placeholder each fills (an asset-backed texture's content hash). Safe to
   * call before the scene is up (nothing changes then); resolves with how many
   * objects changed.
   */
  supplyTextures(images: ReadonlyMap<string, EncodedImage>): Promise<number>;
  /** The graphics preset in effect. */
  quality(): QualityLevel;
}

/** One scene object in a live inspection snapshot. */
export interface InspectedObject {
  readonly index: number;
  readonly name: string;
  readonly parent: number;
  /** World position this frame. */
  readonly position: readonly [number, number, number];
  /** Drawn this frame (false for hidden objects and prefab copies in reserve). */
  readonly visible: boolean;
  readonly tags: readonly string[];
  readonly props: Readonly<Record<string, number | string | boolean>>;
  /** The object's physics body, when it has one that moves. */
  readonly body?: { readonly kind: string; readonly velocity: readonly [number, number, number]; readonly grounded: boolean; readonly active: boolean };
  /** For a prefab copy: its prefab and whether it's spawned. */
  readonly prefab?: { readonly name: string; readonly spawned: boolean };
  /** For a skinned object: the clip playing (null at rest) and seconds into it. */
  readonly animation?: { readonly clip: string | null; readonly time: number };
}

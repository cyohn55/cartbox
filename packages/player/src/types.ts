/**
 * Public and shared types for @cartbox/player.
 *
 * Kept free of DOM/engine imports so it can be consumed by any module without
 * pulling in browser or WASM dependencies.
 */

import type { ModelId } from "./models.js";
import type { Replay } from "./replay.js";
import type { MailboxEvent } from "./mailbox.js";
import type { LightingOptions } from "./lighting/types.js";
import type { PostFxSettings } from "./fx/postfx.js";
import type { SceneSpec } from "./scene/sceneModel.js";
import type { AnimSpec } from "./anim/animModel.js";
import type { ParticleSpec } from "./particles/particleModel.js";

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
}

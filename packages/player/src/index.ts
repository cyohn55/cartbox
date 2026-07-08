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

import { Player } from "./player.js";
import type { PlayerHandle, PlayerOptions } from "./types.js";

export type {
  ControlScheme,
  PlayerHandle,
  PlayerOptions,
  ScaleMode,
} from "./types.js";
export { ConsoleButton } from "./types.js";
export { CartridgeLoadError } from "./cartridge.js";

// Keyboard binding table. Exposed so hosts that render their own physical
// controls (e.g. the handheld console shell) can synthesize key events that
// match the engine's expected layout instead of duplicating it.
export { DEFAULT_KEY_BINDINGS, resolveButton } from "./input.js";

// Deterministic replays. Exported for server-side use too (e.g. verifying a
// submitted score by re-running the replay headlessly).
export {
  ReplayError,
  ReplayRecorder,
  ReplaySource,
  REPLAY_VERSION,
  hashCart,
  parseReplay,
  randomSeed,
  serializeReplay,
} from "./replay.js";
export type { InputChange, Replay } from "./replay.js";
export { readCartCode, seedCartridge } from "./cartseed.js";

// Platform event mailbox (P2) + the cartbox SDK.
export {
  EVENT_CAPACITY,
  LIGHTS_BASE,
  LIGHTS_CAPACITY,
  LIGHT_STRIDE,
  MAILBOX_TYPE_ACHIEVEMENT,
  MAILBOX_TYPE_PROGRESS,
  MAILBOX_TYPE_SCORE,
  MAILBOX_WORDS,
  decodeLights,
  decodeMailbox,
  hashEventId,
} from "./mailbox.js";
export type { MailboxEvent, MailboxEventKind, MailboxRead } from "./mailbox.js";
export { CARTBOX_SDK_LUA, injectSdk } from "./sdk.js";

// Replay verification (P2): recompute a score by re-running the replay headlessly.
export { extractScore, extractUnlocks, runReplayEvents, verifyReplayScore } from "./verify.js";
export type { VerificationResult } from "./verify.js";

// Achievement resolution (P2): map mailbox unlock hashes to registered achievements.
export { resolveUnlockedAchievements } from "./achievements.js";
export type { RegisteredAchievement } from "./achievements.js";

// Console models and the low-level engine adapter. Exposed for server-side reuse
// (e.g. the headless thumbnail render worker), which drives the same WASM core
// without a DOM.
export {
  DEFAULT_MODEL_ID,
  MODELS,
  framebufferBytes,
  frameDurationMs,
  getModel,
} from "./models.js";
export type { ConsoleModel, ModelId } from "./models.js";
export { createConsole, loadEngineModule } from "./engine.js";
export type { ConsoleInstance } from "./engine.js";

// Dynamic lighting layer (optional): relight a running cart with coloured point
// lights, and — with a material buffer — full normals, specular, and shadows.
export {
  LightingLayer,
  LitCanvasSurface,
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  WebgpuLightingLayer,
  createFlatMaterial,
  createLightingLayer,
  getWebgpuDevice,
  nearestDirection,
  normalVector,
  shade,
} from "./lighting/index.js";
export type {
  BuiltLightingRenderer,
  DeviceProvider,
  Light,
  LightingBackend,
  LightingFrameContext,
  LightingOptions,
  LightingRenderer,
  LightingScene,
  MaterialBuffer,
  RenderCanvas,
  Rgb,
  Vec3,
} from "./lighting/index.js";

// Post-processing FX (optional): the shared effect model, the WebGL pass, and
// the surface decorator that applies a cart's effect stack while it runs.
export {
  POST_FX_EFFECTS,
  PostFxPass,
  PostFxSurface,
  anyPostFxEnabled,
  defaultPostFxSettings,
  hexToRgb01,
  paramKey,
  parsePostFxSettings,
  uniformsFromSettings,
} from "./fx/index.js";
export type {
  InnerSurfaceFactory,
  PostFxEffectDef,
  PostFxEffectId,
  PostFxParamDef,
  PostFxSettings,
  PostFxSource,
  PostFxUniforms,
} from "./fx/index.js";

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
export function mount(container: HTMLElement, options: PlayerOptions): PlayerHandle {
  const player = new Player(container, options);
  void player.start();

  return {
    pause: () => player.pause(),
    resume: () => void player.resume(),
    destroy: () => player.destroy(),
    getReplay: () => player.getReplay(),
    get running(): boolean {
      return player.running;
    },
  };
}

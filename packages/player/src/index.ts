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
  CAMERA_BASE,
  CAMERA_SCALE,
  MESH_CAM_BASE,
  MESH_CAM_STRIDE,
  MESH_CAM_ANGLE_SCALE,
  MESH_CAM_DIST_SCALE,
  MESH_POSE_BASE,
  MESH_POSE_CAPACITY,
  MESH_POSE_STRIDE,
  MESH_POSE_HIDDEN,
  decodeCamera,
  decodeLights,
  decodeMailbox,
  decodeMeshCamera,
  decodeMeshPoses,
  hashEventId,
} from "./mailbox.js";
export type { MailboxCamera, MailboxEvent, MailboxEventKind, MailboxMeshCamera, MailboxMeshPose, MailboxRead } from "./mailbox.js";
export { CARTBOX_SDK_LUA, injectSdk } from "./sdk.js";
// Collision: a cart's authored solidity layer, exposed to its own Lua as
// cartbox.solid(x, y) / cartbox.mapsize(). Injected as static cart data.
export { collisionSdkLua, parseCollisionField } from "./collisionSdk.js";
export type { CollisionField } from "./collisionSdk.js";
// Tile flags: a cart's per-cell gameplay properties, exposed to its own Lua as
// cartbox.flag(cx, cy, n). Injected as static cart data alongside collision.
export { flagsSdkLua, parseFlagsField } from "./flagsSdk.js";
export type { FlagsField } from "./flagsSdk.js";

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
  interpolateNormal,
  nearestDirection,
  normalVector,
  sampleNormalBilinear,
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
  BLOOM_KNEE,
  BloomPyramid,
  MAX_PYRAMID_LEVELS,
  MIN_PYRAMID_DIMENSION,
  POST_FX_EFFECTS,
  PostFxPass,
  PostFxSurface,
  acesFilmic,
  acesFilmicChannel,
  anyPostFxEnabled,
  defaultPostFxSettings,
  hexToRgb01,
  paramKey,
  parsePostFxSettings,
  pyramidLevelCount,
  pyramidLevelSize,
  softKneePrefilter,
  uniformsFromSettings,
  TILT_SHIFT_FEATHER,
  reflectionFade,
  reflectionSampleY,
  tiltShiftBlur,
} from "./fx/index.js";
export type {
  InnerSurfaceFactory,
  PostFxColorDef,
  PostFxEffectDef,
  PostFxEffectId,
  PostFxParamDef,
  PostFxSettings,
  PostFxSource,
  PostFxUniforms,
} from "./fx/index.js";

// Runtime parallax scene (optional): a cart declares a backdrop of depth layers
// (regions of its own sprite sheet) with aerial-perspective atmosphere; the
// player composites it behind the cart's frame, ahead of lighting + FX.
export {
  SceneBackdropSurface,
  compositeOverBackdrop,
  composeParallax,
  prehazeLayers,
  fillSky,
  cameraAt,
  createCartSpriteSource,
  parseScene,
  resolveSceneLayers,
  renderSceneBackdrop,
  DEFAULT_ATMOSPHERE,
} from "./scene/index.js";
export type {
  AtmosphereParams,
  CartSpriteSource,
  RegionImage,
  SceneSpec,
  SceneLayer,
  SceneCamera,
  SpriteRegion,
  SpriteRegionSource,
} from "./scene/index.js";

// Runtime animation (optional): a cart declares clips/tracks/placements; the
// player plays them host-side off the frame clock, driving scene-layer channels,
// post-FX values, and foreground set-dressing — no cart code needed.
export {
  AnimatedForegroundSurface,
  parseAnim,
  evaluate,
  sampleClipFrame,
  sampleTrack,
  pulse,
  sway,
  drift,
  flicker,
} from "./anim/index.js";
export type {
  AnimSpec,
  AnimClip,
  AnimTrack,
  AnimTarget,
  AnimPlacement,
  Keyframe,
  AnimMode,
  TrackMode,
  Ease,
  LayerChannel,
  PlacementChannel,
  AnimState,
  ResolvedPlacement,
  ClipSample,
  GeneratedTrack,
} from "./anim/index.js";

// Runtime particles (optional): a cart declares a weather system (rain/snow/
// embers/fog); the player composites it over each frame host-side off a stateless
// field — the atmosphere layer of the cinematic look, no cart code needed.
export {
  MAX_EMITTERS,
  MAX_PARTICLES_PER_EMITTER,
  PARTICLE_KINDS,
  ParticleOverlaySurface,
  emitterPreset,
  parseParticles,
  simulateEmitter,
} from "./particles/index.js";
export type {
  Particle,
  ParticleEmitter,
  ParticleKind,
  ParticleSpec,
} from "./particles/index.js";

// Runtime 3D meshes (optional): a cart declares a mesh sidecar (imported OBJ/glTF
// geometry with placement transforms); the player rasterises it over each frame
// with a pure software rasteriser — the runtime has no GPU triangle path — no cart
// code needed. Phase 2 of the mesh asset feature.
export { MeshOverlaySurface, parseMeshScene, buildOrbitCamera } from "./mesh/index.js";
export type { MeshScene, MeshInstance, SceneBounds, MeshSceneCamera } from "./mesh/index.js";

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

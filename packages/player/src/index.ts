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
  InspectedObject,
  PlayerHandle,
  PlayerOptions,
  ScaleMode,
} from "./types.js";
export { ConsoleButton } from "./types.js";
export { CartridgeLoadError } from "./cartridge.js";
export { EngineLoadError } from "./engine.js";

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
export { appendLuaCode, codeChunks, prependLuaCode, readCartCode, rewriteLuaCode, seedCartridge } from "./cartseed.js";
// The playtest console (ENGINE_ROADMAP.md, Phase 5): trace capture and cart-line errors.
export {
  DebugCommand,
  armDebugBlock,
  codeLineOffset,
  debugBlockAddress,
  debugPostlude,
  debugSdkLua,
  errorStack,
  parsePauseInfo,
  readPause,
  remapErrorLines,
  sendDebugCommand,
  writeBreakpoints,
  writeWatches,
} from "./debug/debugBlock.js";
export type { DebugStep, ErrorFrame, PauseInfo, TraceLine } from "./debug/debugBlock.js";
export { breakableLine, effectiveBreakpoints, instrumentLua, tokenizeLua } from "./debug/instrument.js";
export { PROFILE_SECTIONS, PROFILE_WINDOW, Profiler, estimateSceneBytes } from "./debug/profiler.js";
export type { ProfileSection, ProfileSnapshot, RenderStats, SectionStats } from "./debug/profiler.js";

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
  decodeWorldLights,
  hashEventId,
} from "./mailbox.js";
export type { MailboxCamera, MailboxEvent, MailboxEventKind, MailboxMeshCamera, MailboxMeshPose, MailboxRead, WorldLight } from "./mailbox.js";
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
  SOFTWARE_RASTER_CAPS,
  framebufferBytes,
  frameDurationMs,
  getModel,
} from "./models.js";
export type { ConsoleModel, ModelId, RenderCaps } from "./models.js";
// The 3D scene renderer: the seam that lets the player rasterise meshes on the
// GPU, with the software path as the fallback (see ERA_MODELS.md).
export { CappedSceneRenderer, SoftwareSceneRenderer, capsConstrainScene } from "./render/sceneRenderer.js";
export {
  applyRenderCaps,
  capTextures,
  capTriangles,
  createTextureBudgetCache,
  fitTextureToBudget,
  rasterStyleFor,
  webgpuCanHonour,
} from "./render/renderCaps.js";
export type { FrameState, SceneDraw, SceneRenderer } from "./render/sceneRenderer.js";
export { createSceneRenderer } from "./render/createSceneRenderer.js";
export { WebgpuSceneRenderer } from "./render/WebgpuSceneRenderer.js";
export { WEBGL_INSTANCES_PER_DRAW, WEBGL_MAX_LIGHTS, WebglSceneRenderer, type GlContextProvider } from "./render/WebglSceneRenderer.js";
export {
  DEFAULT_AMBIENT,
  DEFAULT_LIGHT,
  UNIFORM_BYTES_USED,
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  VERTEX_FLOATS,
  alignBytesPerRow,
  interleaveVertices,
  normalBasis3x3,
  packLights,
  LIGHT_FLOATS,
  resolveLight,
  resolvePbr,
  unpadRows,
  viewDirection,
  writeInstanceUniform,
  INSTANCE_FLOATS,
  writeInstanceTransform,
} from "./render/scenePacking.js";
export type { InstanceTransform, PackableLight, PbrMaterial, ResolvedPbr } from "./render/scenePacking.js";
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
  resolveSupersample,
  getWebgpuDevice,
  interpolateNormal,
  nearestDirection,
  normalVector,
  sampleNormalBilinear,
  sampleScalarBilinear,
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
  FLARE_GHOSTS,
  FLARE_GHOST_GAIN,
  FLARE_SPIKE_POWER,
  lensFlareAt,
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
  IMPORTED_LOOK,
  LUT_LOOKS,
  LUT_SIZE,
  MAX_LUT_SIZE,
  MIN_LUT_SIZE,
  applyLut,
  decodeLut,
  encodeLut,
  identityLut,
  lookLut,
  lutStrip,
  parseCubeLut,
} from "./fx/index.js";
export type {
  GradingLut,
  FlareGhost,
  FlareParams,
  InnerSurfaceFactory,
  ScreenSun,
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
  animClipsSdkLua,
  buildClipTable,
  clipFrameIndex,
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
  ClipTableEntry,
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
export { MeshOverlaySurface, TINT_PALETTE, smoothFrontEdges, parseMeshScene, buildOrbitCamera, orbitPitchAboveTerrain, streamGroups, sceneObjectsSdkLua } from "./mesh/index.js";
export { readSidecarUi, uiSdkLua } from "./uiSdk.js";
export { INPUT_SETTINGS, playLanguage, stringsSdkLua, writeInputSettings } from "./stringsSdk.js";
export { componentsSdkLua } from "./componentsSdk.js";
export { INPUT_BLOCK_BYTES, INPUT_MAGIC, actionsSdkLua, inputBlockAddress, readSidecarActions, writeInputBlock } from "./actionsSdk.js";
export { POINTER_AT, POINTER_MAGIC, PointerInput, toConsolePixel, writePointer, type PointerState } from "./pointer.js";
export { SAVE_MAGIC, armSaveBlock, saveBlockAddress, saveBlockBytes, saveCapacity, saveSdkLua, takeSave, validSave } from "./saveSdk.js";
export { SoundSystem, browserSpeaker, LOOP_SLOTS, MAX_VOICES, type SoundContext, type Speaker } from "./soundSystem.js";
export type { MeshScene, MeshInstance, SceneBounds, SceneVista, MeshSceneCamera } from "./mesh/index.js";

// Runtime HD-2D world (optional): a cart declares a height-mapped 3D tile world
// (the `world` sidecar) and stands its 2D character sprites in it as camera-facing
// billboards, all sharing one depth buffer so terrain and characters occlude each
// other correctly. This is what makes "3D world, 2D characters" shippable in a cart.
export {
  WorldOverlaySurface,
  parseWorldScene,
  buildTerrainInstances,
  buildBillboardInstance,
  buildShadowInstance,
  makeShadowTexture,
  buildWorldCamera,
  worldCenter,
  cellAt,
  CELL_WORLD,
  HEIGHT_WORLD,
} from "./world/index.js";
export type {
  WorldScene,
  WorldTileCell,
  WorldBillboard,
  WorldProp,
  WorldCameraSpec,
  WorldCamera,
  WorldBillboardPose,
  TextureLookup,
} from "./world/index.js";

// Netplay (online multiplayer): a host-page relay between browsers, reached by
// the cart through pmem 0..118 (the SDK's cartbox.net* functions).
export {
  NET_WORDS,
  NET_SLOTS,
  NET_MODE_OFFLINE,
  NET_MODE_CLIENT,
  NET_MODE_HOST,
  writeNetInbox,
  takeNetOutbox,
} from "./net/netplay.js";
export type { NetInbox, NetOutbox, NetState, NetEvent } from "./net/netplay.js";
export { NetSession, MemoryNetHub, BroadcastChannelTransport, SwitchableTransport, netSendInterval } from "./net/NetSession.js";
export type { NetMessage, NetPeer, NetRoomStatus, NetTransport } from "./net/NetSession.js";
export { SimulatedNetHub, runNetLab } from "./net/netLab.js";
export type { DriftStats, LabCart, LabProbe, LinkConditions, NetLabOptions, NetLabReport } from "./net/netLab.js";

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
    setControlSettings: (settings) => player.setControlSettings(settings),
    setVolume: (volume) => player.setVolume(volume),
    setColorFilter: (filter, kind) => player.setColorFilter(filter, kind),
    setAccessibility: (settings) => player.setAccessibility(settings),
    setLanguages: (preferred) => player.setLanguages(preferred),
    setInputEnabled: (enabled) => player.setInputEnabled(enabled),
    inspect: () => player.inspect(),
    setQuality: (choice) => player.setQuality(choice),
    supplyTextures: (textures) => player.supplyTextures(textures),
    setTimeScale: (scale) => player.setTimeScale(scale),
    timeScale: () => player.timeScale(),
    stepFrame: () => player.stepFrame(),
    frame: () => player.frame(),
    setBreakpoints: (lines) => player.setBreakpoints(lines),
    setWatches: (expressions) => player.setWatches(expressions),
    debugContinue: (step) => player.debugContinue(step),
    debugPaused: () => player.debugPaused(),
    breakableLines: () => player.breakableLines(),
    setProfiling: (on) => player.setProfiling(on),
    profile: () => player.profile(),
    quality: () => player.quality(),
    setEditorCamera: (camera) => player.setEditorCamera(camera),
    updateMeshScene: (scene) => player.updateMeshScene(scene),
  };
}

// Controls: controller / keyboard bindings, aim inversion, look sensitivity, the
// touch pad's size and opacity — what a game's Start menu edits.
export {
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_PAD_BINDINGS,
  PAD_BUTTONS,
  START_KEYS,
  applyLookSettings,
  deadZoned,
  parseControlSettings,
  readPad,
  standardizePad,
} from "./controls.js";
export type { ControlSettings, ControlTarget, PadButton, PadSnapshot } from "./controls.js";
export { GamepadInput } from "./input.js";

// Physics (ENGINE_ROADMAP.md, Phase 2): the session that runs a cart's bodies,
// the backend interface a host implements (the web app's is Rapier), and the
// shared-block protocol the cart's Lua reads and writes.
export {
  PHYSICS_DT,
  PhysicsSession,
  composeWorldMatrix,
  fitShape,
  jointFrames,
  physicsSlots,
  sceneHasPhysics,
  splitWorldMatrix,
  type CastHit,
  type CastShape,
  type PhysicsBackend,
  type PhysicsBodyDesc,
  type PhysicsJointDesc,
  type PhysicsShape,
  type Quat as PhysicsQuat,
  type Vec3 as PhysicsVec3,
} from "./physics/physicsSession.js";
export { physicsSdkLua, runtimeSdkLua, sceneNeedsRuntime } from "./physics/physicsSdk.js";
export { deterministicBackend, physicsStateHash } from "./physics/deterministic.js";
export { RuntimeChannel } from "./runtime/runtimeChannel.js";
export { AgentCrowd } from "./nav/agentCrowd.js";
export {
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  applyQualityToPostFx,
  browserDeviceHints,
  detectQuality,
  resolveQuality,
  type DeviceHints,
  type QualityChoice,
  type QualityLevel,
  type QualitySettings,
} from "./quality.js";
export { AnimationSession, animatedObjects, compileAnimator, sceneHasAnimation } from "./anim/animationSession.js";
export {
  PHYS_BLOCK_BYTES,
  PHYS_MAGIC,
  RAM_LAYOUTS,
  physicsBlockAddress,
  takePhysicsCommands,
  writePhysicsState,
  type RamLayout,
} from "./physics/protocol.js";
export { CMD_RING_BYTES, CMD_RING_MAX, commandRingAddress, commandRingBytes, commandRingMax, commandsPerTick, hasCommandRing, takeRingCommands } from "./runtime/commandRing.js";
export { createDirectConsole, directCoreModel, type DirectConsole } from "./directConsole.js";
export { DIRECT_CORE_URL } from "./player.js";

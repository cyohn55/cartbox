/**
 * Player orchestrator. Wires the cartridge, engine, display, input, and audio
 * together and drives a fixed-timestep run loop. This is the only module that
 * knows about all the others; each collaborator stays independent and testable.
 */

import { AudioController } from "./audio.js";
import { SoundSystem } from "./soundSystem.js";
import { uiSdkLua } from "./uiSdk.js";
import { playLanguage, stringsSdkLua } from "./stringsSdk.js";
import { INPUT_BLOCK_BYTES, actionsSdkLua, inputBlockAddress, writeInputBlock } from "./actionsSdk.js";
import { armSaveBlock, saveBlockAddress, saveBlockBytes, saveSdkLua, takeSave } from "./saveSdk.js";
import { fetchCartridge } from "./cartridge.js";
import { CanvasSurface, type DisplaySurface } from "./display.js";
import { LitCanvasSurface } from "./lighting/LitCanvasSurface.js";
import { PostFxSurface } from "./fx/PostFxSurface.js";
import { anyPostFxEnabled, type PostFxSettings } from "./fx/postfx.js";
import { QUALITY_PRESETS, applyQualityToPostFx, browserDeviceHints, resolveQuality, type QualityChoice, type QualityLevel, type QualitySettings } from "./quality.js";
import { createConsole, loadEngineModule, type ConsoleInstance } from "./engine.js";
import { GamepadInput, GamepadState, KeyboardInput, TouchInput, hasTouchSupport } from "./input.js";
import { frameDurationMs, getModel, type ConsoleModel } from "./models.js";
import { ReplayRecorder, ReplaySource, hashCart, randomSeed, type Replay } from "./replay.js";
import { seedCartridge, prependLuaCode, readCartCode, appendLuaCode, rewriteLuaCode } from "./cartseed.js";
import { STICK_OPTIN_MAGIC, STICK_OPTIN_WORD, STICK_WORD, packSticks } from "./sticks.js";
import { DEFAULT_CONTROL_SETTINGS, applyLookSettings, type ControlSettings } from "./controls.js";
import { injectSdk } from "./sdk.js";
import { componentsSdkLua } from "./componentsSdk.js";
import { sceneObjectsSdkLua } from "./mesh/sceneObjectsSdk.js";
import { streamGroups, type MeshScene } from "./mesh/meshScene.js";
import { runtimeSdkLua } from "./physics/physicsSdk.js";
import { PhysicsSession, sceneHasPhysics } from "./physics/physicsSession.js";
import { RuntimeChannel } from "./runtime/runtimeChannel.js";
import { PHYS_BLOCK_BYTES, RAM_LAYOUTS, physicsBlockAddress } from "./physics/protocol.js";
import { collisionSdkLua } from "./collisionSdk.js";
import { Profiler, type ProfileSnapshot } from "./debug/profiler.js";
import {
  DEBUG_BLOCK_BYTES,
  DebugCommand,
  armDebugBlock,
  codeLineOffset,
  debugBlockAddress,
  debugPostlude,
  debugSdkLua,
  drainTraces,
  readPause,
  remapErrorLines,
  sendDebugCommand,
  writeBreakpoints,
  writeWatches,
  type DebugStep,
  type PauseInfo,
} from "./debug/debugBlock.js";
import { effectiveBreakpoints, instrumentLua } from "./debug/instrument.js";
import { flagsSdkLua } from "./flagsSdk.js";
import { animClipsSdkLua } from "./anim/animClipsSdk.js";
import { decodeCamera, decodeLights, decodeMailbox, decodeMeshCamera, decodeMeshPoses, decodeWorldLights, type MailboxMeshCamera } from "./mailbox.js";
import { createCartSpriteSource, type CartSpriteSource } from "./scene/cartSpriteSource.js";
import { resolveSceneLayers } from "./scene/sceneRender.js";
import { SceneBackdropSurface } from "./scene/SceneBackdropSurface.js";
import { AnimatedForegroundSurface } from "./anim/AnimatedForegroundSurface.js";
import { evaluate } from "./anim/animPlayer.js";
import type { AnimSpec } from "./anim/animModel.js";
import { ParticleOverlaySurface } from "./particles/ParticleOverlaySurface.js";
import { MeshOverlaySurface } from "./mesh/MeshOverlaySurface.js";
import { WorldOverlaySurface } from "./world/WorldOverlaySurface.js";
import { createSceneRenderer } from "./render/createSceneRenderer.js";
import type { SceneRenderer } from "./render/sceneRenderer.js";
import type { TextureLookup } from "./world/worldScene.js";
import { SpatialLoader, actionMask, reboundActions, type DecodedTexture, type EncodedImage, type InputAction, type Mat4, colorFilterSvg, type ColorFilter } from "@cartbox/editor";
import type { ControlScheme, InspectedObject, PlayerOptions } from "./types.js";

/**
 * Decides whether to show the on-screen gamepad. "auto" shows it on any device
 * that can take touch at all -- not just ones whose *primary* pointer is coarse,
 * because an iPad in a keyboard/trackpad case reports a fine pointer but is still
 * a touchscreen with no gamepad. The keyboard is attached alongside it (see
 * attachInput), so a touch laptop or keyboard-case tablet can use either.
 */
function shouldUseTouch(scheme: ControlScheme, view: Window): boolean {
  if (scheme === "touch") return true;
  if (scheme === "keyboard") return false;
  const coarse = view.matchMedia?.("(pointer: coarse)").matches ?? false;
  return hasTouchSupport(view.navigator?.maxTouchPoints ?? 0, coarse);
}

/** No keys or controller buttons held (shared, so it allocates nothing per frame). */
const NO_HELD: ReadonlySet<string> = new Set();
/** Each player's colour filter gets its own SVG id, so two players on a page don't share one. */
let nextColorFilterId = 0;

/** No objects placed by physics or a timeline (shared, so it allocates nothing per frame). */
const NO_OVERRIDES: ReadonlyMap<number, Mat4> = new Map();

export class Player {
  private readonly gamepad = new GamepadState();
  private readonly view: Window;
  private surface?: DisplaySurface;
  private litSurface?: LitCanvasSurface;
  private sceneSurface?: SceneBackdropSurface;
  private meshSurface?: MeshOverlaySurface;
  /** The scene's sounds (EP12), once loaded. */
  private sounds: SoundSystem | null = null;
  private worldSurface?: WorldOverlaySurface;
  /**
   * The 3D renderer both overlays draw through — WebGPU when the device allows,
   * the software rasteriser otherwise. One per player, shared: a cart with both
   * a mesh scene and a world would otherwise probe the adapter and allocate a
   * second set of GPU targets for the same framebuffer.
   */
  private sceneRenderer?: SceneRenderer;
  private foregroundSurface?: AnimatedForegroundSurface;
  private postFxSurface?: PostFxSurface;
  /** The graphics preset in effect (resolved from the quality option once the renderer is known). */
  private qualitySettings: QualitySettings = QUALITY_PRESETS.high;
  private basePostFx?: PostFxSettings;
  private anim?: AnimSpec;
  /** Presented-frame clock for animation, kept in lockstep with the scene backdrop. */
  private presentFrame = 0;
  private audio?: AudioController;
  private keyboard?: KeyboardInput;
  private touch?: TouchInput;
  /** The cart reads analog sticks (it opted in via cartbox.stick). */
  private analogCart = false;
  /** Input actions (EP15): the cart's, with the player's rebinding, and the keys they claim. */
  private actions: InputAction[] = [];
  private actionKeys: ReadonlySet<string> = new Set();
  private actionPad: ReadonlySet<string> = new Set();
  /** Where the input block sits (bytes after pmem word 0), when the cart has actions; and last tick's mask. */
  private inputOffset: number | null = null;
  private lastActions = 0;
  /** Save data (EP15b): where the save block sits (bytes after pmem word 0), and its size. */
  private saveBlock: { offset: number; bytes: number } | null = null;
  private controllerInput?: GamepadInput;
  private controlSettings: ControlSettings = DEFAULT_CONTROL_SETTINGS;
  private volume = 1;
  /** False while a host menu is open: the game keeps running but sees no input. */
  private inputEnabled = true;
  private console?: ConsoleInstance;
  /**
   * The cart's runtime channel (physics bodies and/or spawnable prefabs), its
   * physics world if any, and where the shared block sits (bytes after pmem word 0).
   */
  private runtime: { channel: RuntimeChannel; physics: PhysicsSession | null; offset: number } | null = null;
  private cartSource?: CartSpriteSource;
  private readonly model: ConsoleModel;

  private recorder?: ReplayRecorder;
  private replaySource?: ReplaySource;
  private tickFrame = 0;
  private lastMailboxSeq = 0;
  /** Error-generation counter last seen from the engine; a rise means a new error. */
  private lastErrorSeq = 0;
  /** Lines of injected code above the cart's own: error line N is cart line N − this. */
  private lineOffset = 0;
  /** The debug block (bytes after pmem word 0), when the editor's console is on. */
  private debugOffset: number | null = null;
  /** Lines in the cart's own code (for telling its lines from the injected code after it). */
  private lineCount = 0;
  /** The debugger (options.debug): breakpoints and watches still to write, lines that can break, and where the cart is stopped. */
  private debugState: {
    breakpoints: readonly number[];
    watches: readonly string[];
    dirty: boolean;
    breakable: readonly number[];
    paused: PauseInfo | null;
  } | null = null;
  private speed = 1;
  /** The playtest profiler, while it's on (see setProfiling). */
  private profiler: Profiler | null = null;
  /** Recent netplay byte totals, for traffic per second. */
  private netSamples: { at: number; sent: number; received: number }[] = [];

  private frameHandle = 0;
  private lastFrameTime = 0;
  private frameAccumulatorMs = 0;
  private destroyed = false;
  private readonly abortController = new AbortController();

  running = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: PlayerOptions,
  ) {
    const view = container.ownerDocument.defaultView;
    if (!view) {
      throw new Error("Container is not attached to a window");
    }
    this.view = view;
    this.model = getModel(options.modelId);
    if (options.controlSettings) this.controlSettings = options.controlSettings;
  }

  /** The colour filter's SVG definition, while one is applied (EP19b). */
  private colorFilterNode: Element | null = null;
  private colorFilterBefore: string | null = null;

  /** Filter the finished frame (see PlayerHandle.setColorFilter): an SVG colour matrix on the container. */
  setColorFilter(filter: ColorFilter, kind: "correct" | "simulate" = "correct"): void {
    const style = this.container.style;
    this.colorFilterNode?.remove();
    this.colorFilterNode = null;
    const id = `cbx-color-filter-${(nextColorFilterId += 1)}`;
    const svg = colorFilterSvg(filter, kind, id);
    if (!svg) {
      if (this.colorFilterBefore !== null) style.filter = this.colorFilterBefore;
      this.colorFilterBefore = null;
      return;
    }
    const holder = this.container.ownerDocument.createElement("div");
    holder.innerHTML = svg;
    this.colorFilterNode = holder.firstElementChild;
    if (this.colorFilterNode) this.container.appendChild(this.colorFilterNode);
    if (this.colorFilterBefore === null) this.colorFilterBefore = style.filter;
    style.filter = `url(#${id})`;
  }

  /** Apply new control settings at once (see PlayerHandle.setControlSettings). */
  setControlSettings(settings: ControlSettings): void {
    this.controlSettings = settings;
    this.touch?.applySettings(settings);
    this.rebindActions();
  }

  /** The cart's actions with the player's rebinding applied (EP15). */
  private rebindActions(): void {
    this.actions = reboundActions(this.options.actions ?? [], this.controlSettings.actionBindings);
    this.actionKeys = new Set(this.actions.flatMap((a) => a.keys));
    this.actionPad = new Set(this.actions.flatMap((a) => a.pad));
  }

  /** The actions held now (bit i = action i), from every device. */
  private heldActions(): number {
    if (this.actions.length === 0) return 0;
    return actionMask(this.actions, { keys: this.keyboard?.held ?? NO_HELD, pad: this.controllerInput?.pressed ?? NO_HELD, buttons: this.gamepad.value });
  }

  /** Let the game see input (true) or hold it neutral (false) — e.g. under a menu. */
  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  /** Master volume, 0..1. */
  setVolume(volume: number): void {
    this.volume = volume;
    this.audio?.setVolume(volume);
  }

  /** Loads the cartridge and engine, then starts (or arms) playback. */
  async start(): Promise<void> {
    const filter = this.options.accessibility?.colorFilter;
    if (filter && filter !== "none") this.setColorFilter(filter);
    try {
      const engineUrl = this.options.engineUrl ?? this.model.engineUrl;
      const [bytes, module] = await Promise.all([
        fetchCartridge(this.options.cartUrl, this.abortController.signal),
        loadEngineModule(engineUrl, this.options.engineWasm),
      ]);
      if (this.destroyed) return;

      const sampleRate = this.options.sampleRate ?? this.model.sampleRate;
      // Prepare the cart: inject the cartbox SDK so carts can call cartbox.light/
      // score/unlock without bundling it, and seed the language RNG so randomness
      // is reproducible (a new recording gets a fresh seed; playback reuses the
      // replay's seed). Both no-op on non-Lua carts, and both are deterministic,
      // so replays still reproduce exactly. The cart identity hash is taken from
      // the original (unprepared) bytes.
      const seed = this.options.replay ? this.options.replay.seed : randomSeed();
      // Order matters: prepended code runs top-first, so the collision accessor
      // is prepended BEFORE the SDK — the SDK ends up above it and defines the
      // `cartbox` table first, then this overrides its solid/mapsize stubs with
      // the cart's real layer. A null/empty layer contributes nothing.
      const seeded = seedCartridge(bytes, seed);
      // Static cart-data accessors (collision + flags) are prepended BEFORE the
      // SDK so the SDK sits above them and defines `cartbox` first; each then
      // overrides its no-op stub. Empty layers contribute nothing.
      let prepared = seeded;
      // The editor's console and debugger (debugBlock.ts): trace capture and
      // cart-line tracebacks, and with the debugger, breakpoint hooks on the
      // cart's statement lines (instrument.ts) with TIC run through them.
      const layout = RAM_LAYOUTS[this.model.id];
      const debug = this.options.debug;
      const cartCode = readCartCode(bytes);
      let ownCode = cartCode;
      if ((this.options.onTrace || debug) && layout) {
        if (debug && cartCode !== null) {
          const instrumented = instrumentLua(cartCode);
          if (instrumented.lines.length > 0) {
            prepared = appendLuaCode(rewriteLuaCode(prepared, (code) => code.slice(0, code.length - cartCode.length) + instrumented.code), debugPostlude());
            ownCode = instrumented.code;
            this.debugState = {
              breakpoints: effectiveBreakpoints(debug.breakpoints ?? [], instrumented.lines),
              watches: debug.watches ?? [],
              dirty: true,
              breakable: instrumented.lines,
              paused: null,
            };
          }
        }
        prepared = prependLuaCode(prepared, debugSdkLua(debugBlockAddress(layout), { debugger: this.debugState !== null }));
        this.debugOffset = debugBlockAddress(layout) - layout.pmemAddress;
      }
      // Components (EP14): their scripts sit nearest the cart's code (after every
      // SDK they call), and their step runs ahead of the cart's TIC.
      const components = componentsSdkLua(this.options.mesh);
      if (components) prepared = appendLuaCode(prependLuaCode(prepared, components.prelude), components.postlude);
      const collisionLua = collisionSdkLua(this.options.collision);
      if (collisionLua) prepared = prependLuaCode(prepared, collisionLua);
      const flagsLua = flagsSdkLua(this.options.flags);
      if (flagsLua) prepared = prependLuaCode(prepared, flagsLua);
      // The Anim tab's authored sprite clips, exposed to the cart's own Lua as
      // cartbox.clip(name, tick) so gameplay entities animate without swapping
      // sprite ids by hand. Injected like collision/flags: after the base SDK.
      const animClipsLua = animClipsSdkLua(this.options.anim);
      if (animClipsLua) prepared = prependLuaCode(prepared, animClipsLua);
      // Save data (EP15b): the last save rides in as code; a new one comes back through a block.
      if (layout && this.options.onSave) {
        prepared = prependLuaCode(prepared, saveSdkLua(layout, this.options.saveData ?? null));
        this.saveBlock = { offset: saveBlockAddress(layout) - layout.pmemAddress, bytes: saveBlockBytes(layout) };
      }
      // Input actions (EP15): read from the input block the host fills before each tick.
      this.rebindActions();
      const actionsLua = layout ? actionsSdkLua(this.actions, layout) : "";
      if (actionsLua && layout) {
        prepared = prependLuaCode(prepared, actionsLua);
        this.inputOffset = inputBlockAddress(layout) - layout.pmemAddress;
      }
      // The string table and the player's accessibility settings (EP19b).
      const stringsLua = stringsSdkLua(this.options.strings, playLanguage(this.options.strings, this.options.languages), this.options.accessibility);
      if (stringsLua) prepared = prependLuaCode(prepared, stringsLua);
      // UI documents (EP13): laid out for this screen, driven with cartbox.ui.
      const uiLua = uiSdkLua(this.options.ui, this.model.width, this.model.height);
      if (uiLua) prepared = prependLuaCode(prepared, uiLua);
      // The placed meshes as scene objects (cartbox.find / prop / tagged ...).
      const sceneLua = sceneObjectsSdkLua(this.options.mesh);
      if (sceneLua) prepared = prependLuaCode(prepared, sceneLua);
      // Physics bodies on those objects (cartbox.body / impulse / move / ray ...),
      // simulated by the host's engine, and spawnable prefab copies
      // (cartbox.spawn), both through a block at the end of RAM.
      const mesh = this.options.mesh;
      const runtimeLua = layout && mesh ? runtimeSdkLua(mesh, layout, { physics: Boolean(this.options.physics) }) : "";
      if (runtimeLua && mesh && layout) {
        prepared = prependLuaCode(prepared, runtimeLua);
        let physics: PhysicsSession | null = null;
        if (sceneHasPhysics(mesh) && this.options.physics) {
          const deterministic = mesh.physicsWorld?.deterministic === true;
          const backend = await this.options.physics({ deterministic });
          if (this.destroyed) {
            backend.destroy();
            return;
          }
          physics = new PhysicsSession(mesh, backend, { deterministic });
        }
        this.runtime = {
          channel: new RuntimeChannel(mesh, physics),
          physics,
          offset: physicsBlockAddress(layout) - layout.pmemAddress,
        };
      }
      const preparedBytes = injectSdk(prepared);
      this.lineOffset = codeLineOffset(ownCode, readCartCode(preparedBytes));
      this.lineCount = cartCode === null ? 0 : cartCode.split("\n").length;

      this.console = createConsole(module, this.model, sampleRate);
      if (!this.console.loadCartridge(preparedBytes)) {
        throw new Error("Engine rejected the cartridge");
      }
      // Only pay for the per-pixel material G-buffer when a lit surface will use it.
      this.console.setMaterialCapture(Boolean(this.options.lighting));
      // Baseline the mailbox so any pre-existing persistent memory isn't
      // mistaken for freshly emitted events.
      this.lastMailboxSeq = this.console.readMailbox()[0] ?? 0;
      // Baseline the runtime-error counter so a pre-existing value from a prior
      // cart on this module isn't mistaken for a fresh error on the first frame.
      this.lastErrorSeq = this.console.readError()?.seq ?? 0;

      const scale = this.options.scale ?? "fit";
      // A declared parallax scene: read the cart's own sprite regions for the
      // backdrop layers once (their pixels are static), then wrap the base surface
      // so each frame composites the backdrop behind the cart's live frame. Reads
      // the cart from a separate cart object built from the same bytes; if that
      // fails the cart simply plays without a backdrop.
      const scene = this.options.scene;
      // Animation placements read the cart's sprite sheet too, so a cart source is
      // built when either a scene backdrop OR foreground placements need it.
      this.anim = this.options.anim;
      const wantsForeground = Boolean(this.anim && this.anim.placements.length > 0);
      // The HD-2D world layer textures its terrain and billboards from the cart's
      // own sprite sheet too, so it needs the same cart sprite source.
      const world = this.options.world;
      let backdrop: { layers: ReturnType<typeof resolveSceneLayers>; keyRgb: readonly [number, number, number] } | null = null;
      if (scene || wantsForeground || world) {
        this.cartSource = createCartSpriteSource(module, preparedBytes, this.model.paletteSize) ?? undefined;
      }
      if (scene && this.cartSource) {
        backdrop = {
          layers: resolveSceneLayers(scene, this.cartSource.source),
          keyRgb: this.cartSource.paletteRgb(scene.keyColor),
        };
      }
      // The base surface renders the cart (optionally relit). With an active FX
      // stack it draws offscreen and PostFxSurface presents it through the
      // effect chain; if FX can't run (no WebGL), the base surface mounts
      // directly, so post-processing never blocks playback.
      const makeBaseSurface = async (target: HTMLElement): Promise<DisplaySurface> => {
        let surface: DisplaySurface = this.options.lighting
          ? (this.litSurface = await LitCanvasSurface.create(target, scale, this.model, this.options.lighting))
          : new CanvasSurface(target, scale, this.model);
        // Weather overlay wraps the terminal FIRST (innermost decorator), so it is
        // drawn last into the framebuffer — in front of the cart, backdrop, and
        // foreground placements — and, with post-FX active, still passes through
        // the effect stack (graded/bloomed with the scene rather than pasted flat).
        const particles = this.options.particles;
        if (particles && particles.emitters.length > 0) {
          surface = new ParticleOverlaySurface(surface, this.model.width, this.model.height, particles);
        }
        // A declared 3D mesh scene rasterises over the cart frame. It wraps just
        // OUTSIDE the weather overlay, so the meshes sit in the scene (weather
        // still falls in front of them) but ahead of the cart, foreground, and
        // backdrop. Being a decorator, its output flows through lighting + FX.
        const mesh = this.options.mesh;
        // Built once, only when something 3D is actually declared, so a plain 2D
        // cart never touches WebGPU. `createSceneRenderer` always resolves — it
        // falls back to the software rasteriser rather than returning null.
        if (mesh || (world && this.cartSource)) {
          this.sceneRenderer = await createSceneRenderer(
            this.model.width,
            this.model.height,
            this.model.renderCaps,
          );
        }
        // "auto" quality weighs the device, including whether the GPU renderer came up.
        this.qualitySettings = resolveQuality(this.options.quality, browserDeviceHints(this.sceneRenderer ? this.sceneRenderer.backend !== "software" : undefined));
        if (mesh) {
          surface = this.meshSurface = await MeshOverlaySurface.create(
            surface,
            this.model.width,
            this.model.height,
            mesh,
            this.sceneRenderer,
            this.options.ktx2 ? { ktx2: this.options.ktx2 } : {},
          );
          this.meshSurface.setQuality(this.qualitySettings);
          this.meshSurface.setProfiler(this.profiler);
          // A scene with levels starts in its first; the others wait, hidden.
          if ((mesh.levels?.length ?? 0) > 0) this.activateLevel(0);
          // A scene that streams by distance loads what's near the focus each tick.
          if (mesh.streaming) {
            const groups = streamGroups(mesh);
            if (groups.length > 0) this.spatial = { loader: new SpatialLoader(groups, mesh.streaming), unloaded: new Set() };
          }
        }
        // The HD-2D world composites a 3D tile terrain plus the cart's 2D character
        // billboards over the frame, textured from the cart's sprite sheet and
        // sharing one depth buffer. It wraps like the mesh overlay, so its output
        // also flows through lighting + FX. Textures are decoded once per sprite.
        if (world && this.cartSource) {
          surface = this.worldSurface = new WorldOverlaySurface(
            surface,
            this.model.width,
            this.model.height,
            world,
            makeWorldTextureLookup(this.cartSource, world.tilesPerSide),
            this.sceneRenderer,
          );
        }
        // Foreground placements draw over the cart AND the backdrop, so they wrap
        // the base surface FIRST (innermost); the scene backdrop then wraps around
        // them, compositing behind the cart before placements land on top.
        if (wantsForeground && this.cartSource) {
          surface = this.foregroundSurface = new AnimatedForegroundSurface(
            surface,
            this.model.width,
            this.model.height,
            this.cartSource.source,
          );
        }
        if (scene && backdrop) {
          surface = this.sceneSurface = new SceneBackdropSurface(
            surface,
            this.model.width,
            this.model.height,
            backdrop.layers,
            scene,
            backdrop.keyRgb,
          );
        }
        return surface;
      };
      const postFx = this.options.postFx;
      this.basePostFx = postFx;
      const shownFx = postFx ? applyQualityToPostFx(postFx, this.qualitySettings) : undefined;
      if (shownFx && anyPostFxEnabled(shownFx)) {
        const fx = await PostFxSurface.create(this.container, scale, this.model, shownFx, makeBaseSurface);
        if (fx) this.postFxSurface = fx;
        // The lens flare follows the 3D scene's sun and fades as geometry covers it (H8).
        if (fx && this.meshSurface) this.meshSurface.onSun = (sun) => fx.setSun(sun);
        this.surface = fx ?? (await makeBaseSurface(this.container));
      } else {
        this.surface = await makeBaseSurface(this.container);
      }
      if (this.destroyed) {
        this.surface.destroy(); // torn down mid-load: don't leak the canvas
        return;
      }
      this.audio = new AudioController(sampleRate);
      this.audio.setVolume(this.options.volume ?? this.volume);
      // The scene's sounds (EP12) play on the same context, through the same volume.
      const sceneAudio = this.options.mesh?.audio;
      if (sceneAudio) {
        const mesh = this.options.mesh!;
        void SoundSystem.create(this.audio.audioContext, sceneAudio, this.audio.output, (id) => mesh.instances.findIndex((i) => i.id === id))
          .then((system) => {
            if (this.destroyed) system.dispose();
            else this.sounds = system;
          })
          .catch(() => {
            /* sound is optional: the game plays on silent */
          });
      }
      if (this.options.volume !== undefined) this.volume = this.options.volume;
      this.setupReplay(bytes, seed);

      this.renderSingleFrame(); // show frame 0 immediately, even before play
      this.options.onReady?.();

      if (this.options.autostart ?? false) {
        void this.resume();
      }
    } catch (error) {
      // A load cancelled by destroy() (e.g. React strict-mode's mount/unmount/
      // remount in dev, or navigating away mid-load) aborts the in-flight fetch.
      // That is deliberate teardown, not a load failure — don't surface onError.
      if (this.destroyed) return;
      this.fail(error);
    }
  }

  private attachInput(): void {
    const scheme = this.options.controls ?? "auto";
    // Keyboard unless the host forced touch-only; the on-screen pad whenever the
    // device can take touch. Both write the same GamepadState.
    const onStart = this.options.onStart;
    if (scheme !== "touch") {
      this.keyboard = new KeyboardInput(this.view, this.gamepad, () => this.controlSettings.keyBindings, onStart, () => this.actionKeys);
      // A physical controller (Xbox 360 / any standard-mapping gamepad), read each frame.
      this.controllerInput = new GamepadInput(this.view.navigator, this.gamepad, () => this.controlSettings, onStart, () => this.actionPad);
    }
    if (shouldUseTouch(scheme, this.view)) {
      this.touch = new TouchInput(this.container, this.gamepad, onStart);
      this.touch.applySettings(this.controlSettings);
    }
  }

  /**
   * Chooses the input source. In playback mode the console is driven by the
   * replay and no user input is attached; otherwise live input is attached and
   * (unless disabled) the session is recorded.
   */
  private setupReplay(cartBytes: Uint8Array, seed: number): void {
    if (this.options.replay) {
      this.replaySource = new ReplaySource(this.options.replay.inputs);
      return;
    }
    this.attachInput();
    if (this.options.record !== false) {
      this.recorder = new ReplayRecorder({
        modelId: this.model.id,
        cartHash: hashCart(cartBytes),
        seed,
      });
    }
  }

  /** The replay captured so far, or null when not recording. */
  getReplay(): Replay | null {
    return this.recorder ? this.recorder.finish() : null;
  }

  async resume(): Promise<void> {
    if (this.destroyed || !this.console) return;
    // Start the run loop immediately; audio is best-effort, so a blocked or
    // failed AudioContext can never prevent playback from starting.
    if (!this.running) {
      this.running = true;
      this.lastFrameTime = this.view.performance.now();
      this.frameAccumulatorMs = 0;
      this.frameHandle = this.view.requestAnimationFrame(this.loop);
    }
    // Attempted even when already running: a host can call resume() from a
    // real user gesture (e.g. a handheld button press) to unblock an
    // AudioContext the browser suspended when playback started automatically.
    try {
      await this.audio?.resume(); // resume within the user gesture on mobile
    } catch {
      /* audio is optional; playback continues without it */
    }
  }

  /** Run at `scale` × normal speed (clamped to 0.25 … 4). */
  setTimeScale(scale: number): void {
    this.speed = Number.isFinite(scale) ? Math.min(4, Math.max(0.25, scale)) : 1;
  }

  timeScale(): number {
    return this.speed;
  }

  /** While paused, advance one frame and show it (not while stopped at a breakpoint: use debugContinue). */
  stepFrame(): void {
    if (this.running || this.destroyed || !this.console || this.debugState?.paused) return;
    this.tickOnce(false);
    this.present();
  }

  frame(): number {
    return this.tickFrame;
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    this.view.cancelAnimationFrame(this.frameHandle);
    this.gamepad.reset(); // avoid a button appearing stuck across a pause
    void this.audio?.pause();
  }

  /**
   * Fixed-timestep loop: advance one console frame per 1/60s of elapsed time.
   * Decoupling console frames from the display refresh keeps game speed correct
   * on 120Hz+ screens and after the tab was backgrounded.
   */
  private readonly loop = (now: number): void => {
    if (!this.running) return;

    this.frameAccumulatorMs += (now - this.lastFrameTime) * this.speed;
    this.lastFrameTime = now;
    this.controllerInput?.poll();

    // Cap catch-up so a long stall doesn't trigger a burst of frames.
    const maxFramesPerRender = 4;
    const frameMs = frameDurationMs(this.model);
    let advanced = 0;
    // (A breakpoint stops the loop mid-burst: running goes false.)
    while (this.frameAccumulatorMs >= frameMs && advanced < maxFramesPerRender && this.running) {
      this.tickOnce(this.speed === 1);
      this.frameAccumulatorMs -= frameMs;
      advanced++;
    }
    if (advanced > 0) {
      this.present();
    }

    this.frameHandle = this.view.requestAnimationFrame(this.loop);
  };

  /** Turn the profiler on (it starts empty) or off. */
  /** An editor's camera, looking at the 3D scene instead of the cart's (see PlayerHandle.setEditorCamera). */
  private editorCamera: MailboxMeshCamera | null = null;

  setEditorCamera(camera: MailboxMeshCamera | null): void {
    this.editorCamera = camera;
  }

  /** Apply an editor's edits to the running 3D scene (see PlayerHandle.updateMeshScene). */
  async updateMeshScene(scene: MeshScene): Promise<boolean> {
    if (!this.meshSurface) return false;
    return this.meshSurface.applySceneEdits(scene);
  }

  setProfiling(on: boolean): void {
    if (on === (this.profiler !== null)) return;
    this.profiler = on ? new Profiler() : null;
    this.netSamples = [];
    this.meshSurface?.setProfiler(this.profiler);
  }

  /** Where the last second or so of frames spent their time, and what the scene drew; null while profiling is off. */
  profile(): ProfileSnapshot | null {
    const profiler = this.profiler;
    if (!profiler) return null;
    const { frames, sections, total } = profiler.sections();
    const stats = this.meshSurface?.renderStats() ?? null;
    const heap = (this.view.performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
    let net: ProfileSnapshot["net"] = null;
    const traffic = this.options.netplay?.traffic();
    if (traffic) {
      const at = this.view.performance.now();
      this.netSamples.push({ at, ...traffic });
      while (this.netSamples.length > 2 && at - this.netSamples[0]!.at > 2000) this.netSamples.shift();
      const first = this.netSamples[0]!;
      const seconds = (at - first.at) / 1000;
      net = {
        sent: traffic.sent,
        received: traffic.received,
        sentPerSecond: seconds > 0 ? (traffic.sent - first.sent) / seconds : 0,
        receivedPerSecond: seconds > 0 ? (traffic.received - first.received) / seconds : 0,
      };
    }
    return {
      frames,
      sections,
      total,
      render: stats && this.sceneRenderer ? { ...stats, backend: this.sceneRenderer.backend } : null,
      memory: {
        wasm: this.console?.memoryBytes() ?? 0,
        jsHeap: typeof heap === "number" ? heap : null,
        scene: this.meshSurface ? this.meshSurface.sceneBytes() : null,
      },
      net,
    };
  }

  /** Run one console frame. `withSound` false drops its audio (stepping, or off 1× speed). */
  private tickOnce(withSound = true): void {
    const profiler = this.profiler;
    profiler?.nextFrame();
    const clock = this.view.performance;
    let mark = profiler ? clock.now() : 0;
    /** Charge the time since the last mark to `section`. */
    const lap = (section: "cart" | "runtime" | "audio" | "net") => {
      if (!profiler) return;
      const now = clock.now();
      profiler.add(section, now - mark);
      mark = now;
    };
    // In playback the mask comes from the replay; otherwise from live input. The
    // console buttons are its low 8 bits, the input actions (EP15) the bits above.
    const input = (this.replaySource ? this.replaySource.maskForFrame(this.tickFrame) : this.inputEnabled ? this.gamepad.value | (this.heldActions() << 8) : 0) >>> 0;
    const mask = input & 0xff;
    this.feedActions(input >>> 8);
    const net = this.options.netplay;
    if (net && this.console) {
      const words = this.console.netWords();
      if (words) net.beforeTick(words);
    }
    lap("net");
    this.feedSticks();
    const runtimeBlock = this.runtimeBlock();
    if (runtimeBlock) this.runtime!.channel.beforeTick(runtimeBlock);
    const debugBlock = this.debugBlock();
    if (debugBlock) this.armDebug(debugBlock);
    lap("runtime");
    const frame = this.tickFrame + 1; // this tick's number, counting from 1 (as frame() will after it)
    this.console?.tick(mask);
    lap("cart");
    if (debugBlock) {
      this.drainDebug(frame);
      this.checkPause();
    }
    const afterBlock = runtimeBlock ? this.runtimeBlock() : null;
    if (afterBlock) {
      this.runtime!.channel.afterTick(afterBlock);
      this.pollLevelRequest();
      // Particle bursts the cart fired go to the 3D overlay to simulate and draw.
      for (const b of this.runtime!.channel.takeBursts()) this.meshSurface?.burst(b.effect, b.at, b.dir, b.scale);
      for (const d of this.runtime!.channel.takeDecals()) this.meshSurface?.decal(d.decal, d.at, d.normal, d.scale);
      for (const d of this.runtime!.channel.takeDebris()) this.meshSurface?.throwDebris(d.debris, d.at, d.velocity, d.scale);
      // Sounds the cart played (dropped when this frame is silent: stepping, or off 1× speed).
      for (const c of this.runtime!.channel.takeSounds()) {
        if (!this.sounds) continue;
        if (c.kind === "play") {
          if (withSound) this.sounds.play(c.sound, c.volume, c.pitch, c.at);
        } else if (c.kind === "loop") this.sounds.loop(c.slot, c.sound, c.volume, c.at);
        else this.sounds.mix(c.bus, c.volume);
      }
    }
    // A playing timeline's `bus:<name>` value tracks set those mixer buses (EP17).
    if (this.sounds && this.runtime) {
      for (const [name, v] of this.runtime.channel.timelineValues()) {
        if (!name.startsWith("bus:")) continue;
        const bus = this.sounds.busIndex(name.slice(4));
        if (bus >= 0) this.sounds.mix(bus, v);
      }
    }
    // The scene's sound hears from the camera; emitters on objects follow them.
    if (this.sounds && this.meshSurface) {
      const pose = this.meshSurface.listenerPose();
      if (pose) this.sounds.listen(pose.eye, pose.forward, pose.up);
      this.sounds.follow(this.meshSurface.placements());
    }
    this.updateSpatialLoading();
    lap("runtime");
    if (net && this.console) {
      const words = this.console.netWords();
      if (words) net.afterTick(words);
    }
    lap("net");
    this.recorder?.record(input);
    this.pollSave();
    this.tickFrame++;
    // Surface a Lua runtime error raised during this tick (once per new error).
    // The core aborts only this frame's TIC and keeps running, so this reports to
    // the creator rather than tearing the player down.
    if (this.console && this.options.onRuntimeError) {
      const error = this.console.readError();
      if (error && error.seq > this.lastErrorSeq) {
        this.lastErrorSeq = error.seq;
        if (error.message) this.options.onRuntimeError(remapErrorLines(error.message, this.lineOffset));
      }
    }

    this.pollEvents();

    const samples = this.console?.readAudioSamples();
    if (withSound && samples && samples.length > 0) {
      this.audio?.enqueue(samples);
    }
    lap("audio");
  }

  /**
   * Change the graphics preset live ("auto" re-detects). Shadows and the 3D
   * resolution follow at once; effects the preset turns off go off now, and ones
   * it turns back on need the post-effect stage to have been started with some
   * effect on.
   */
  setQuality(choice: QualityChoice): void {
    this.qualitySettings = resolveQuality(choice, browserDeviceHints(this.sceneRenderer ? this.sceneRenderer.backend !== "software" : undefined));
    this.meshSurface?.setQuality(this.qualitySettings);
    if (this.postFxSurface && this.basePostFx) this.postFxSurface.setSettings(applyQualityToPostFx(this.basePostFx, this.qualitySettings));
  }

  /**
   * Hand the running scene streamed textures, by the `ref` of the placeholder
   * each fills (for asset-backed textures, the asset's content hash): they
   * replace the flat colours their placeholders drew. Resolves with how many
   * objects changed (0 before the scene is up, or for no matching placeholder).
   */
  async supplyTextures(images: ReadonlyMap<string, EncodedImage>): Promise<number> {
    if (!this.meshSurface) return 0;
    return this.meshSurface.supplyImages(images);
  }

  /** Counts level loads, so a load overtaken by a newer switch doesn't activate. */
  private levelLoads = 0;

  /**
   * Start a level switch the cart asked for: load the level's assets through the
   * host (a published cart fetches its textures), then make it current.
   */
  private pollLevelRequest(): void {
    const channel = this.runtime?.channel;
    const scene = this.options.mesh;
    const request = channel?.takeLevelRequest() ?? -1;
    if (!channel || !scene?.levels || request < 0) return;
    const level = scene.levels[request]!;
    const load = this.options.levelAssets;
    if (!load) {
      this.activateLevel(request);
      return;
    }
    const token = ++this.levelLoads;
    const progress = (p: number) => {
      if (token !== this.levelLoads || this.destroyed) return;
      channel.setLevelLoading(request, p);
      this.options.onLevel?.({ level: scene.levels![channel.currentLevel()]?.name ?? "", loading: level.name, progress: p });
    };
    progress(0);
    const done = () => {
      if (token === this.levelLoads && !this.destroyed) this.activateLevel(request);
    };
    load(level, progress).then(done, done);
  }

  /** Objects out of the current level. */
  private levelInactive: ReadonlySet<number> = new Set();
  /** Spatial loading, when the scene streams by distance: the loader and what it has unloaded. */
  private spatial: { loader: SpatialLoader; unloaded: ReadonlySet<number> } | null = null;

  /** Hide (and take out of physics) everything a level or spatial loading has out. */
  private applyInactive(): void {
    const inactive = new Set([...this.levelInactive, ...(this.spatial?.unloaded ?? [])]);
    this.meshSurface?.setInactive(inactive);
    this.runtime?.physics?.setInactive(inactive);
  }

  /**
   * Spatial loading: load what's in range of the focus (where the cart put it,
   * else the camera) and unload what's out; ask the host for the assets of
   * objects coming near.
   */
  private updateSpatialLoading(): void {
    const spatial = this.spatial;
    const scene = this.options.mesh;
    if (!spatial || !scene) return;
    const focus = this.runtime?.channel.streamFocus() ?? this.meshSurface?.eyePosition() ?? scene.bounds.center;
    // Something the cart or physics moved is measured where it is now.
    const surface = this.meshSurface;
    const moved = (g: number): readonly [number, number, number] | null => {
      const root = spatial.loader.groups[g]!.members[0]!;
      const now = surface?.movedModel(root);
      if (!now) return null;
      const placed = scene.instances[root]!.model;
      return [now[12]! - placed[12]!, now[13]! - placed[13]!, now[14]! - placed[14]!];
    };
    const { changed, approached } = spatial.loader.update(focus, moved);
    if (changed) {
      spatial.unloaded = spatial.loader.unloaded();
      this.applyInactive();
    }
    if (approached.length > 0 && this.options.streamAssets) {
      this.options.streamAssets(approached.map((g) => scene.instances[spatial.loader.groups[g]!.members[0]!]!.id));
    }
  }

  /** Make a level current: its objects (and the always-loaded ones) show and simulate; the rest are hidden. */
  private activateLevel(level: number): void {
    const scene = this.options.mesh;
    if (!scene?.levels) return;
    const inactive = new Set<number>();
    scene.instances.forEach((inst, i) => {
      if (inst.level !== undefined && inst.level !== level) inactive.add(i);
    });
    this.levelInactive = inactive;
    this.applyInactive();
    this.runtime?.channel.setLevel(level);
    this.options.onLevel?.({ level: scene.levels[level]?.name ?? "", loading: null, progress: 1 });
  }

  /** The graphics preset in effect. */
  quality(): QualityLevel {
    return this.qualitySettings.level;
  }

  /** Live inspection: every scene object's placement and state this frame. */
  inspect(): InspectedObject[] {
    const scene = this.options.mesh;
    if (!scene) return [];
    const placements = this.meshSurface?.placements() ?? scene.instances.map((inst) => (inst.pooled ? null : inst.model));
    const bodies = this.runtime?.physics?.inspect() ?? new Map();
    const spawned = this.runtime?.channel.spawned() ?? new Map();
    const playback = new Map((this.runtime?.channel.animation?.state() ?? []).map((p) => [p.object, p]));
    return scene.instances.map((inst, index) => {
      const m = placements[index] ?? inst.model;
      const body = bodies.get(index);
      const anim = playback.get(index);
      return {
        index,
        name: inst.name,
        parent: inst.parent,
        position: [m[12]!, m[13]!, m[14]!] as const,
        visible: placements[index] !== null && placements[index] !== undefined,
        tags: inst.tags,
        props: inst.props,
        ...(body ? { body } : {}),
        ...(inst.pooled ? { prefab: { name: inst.pooled.prefab, spawned: spawned.has(inst.pooled.root) } } : {}),
        ...(anim ? { animation: { clip: anim.clip >= 0 ? (inst.mesh.clips?.[anim.clip]?.name ?? null) : null, time: anim.time } } : {}),
      };
    });
  }

  /** A DataView over the runtime block (re-fetched: WASM memory growth detaches views). */
  private runtimeBlock(): DataView | null {
    if (!this.runtime || !this.console) return null;
    const bytes = this.console.ramView(this.runtime.offset, PHYS_BLOCK_BYTES);
    return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  }

  /** A DataView over the debug block, when the console is on (re-fetched, like runtimeBlock). */
  private debugBlock(): DataView | null {
    if (this.debugOffset === null || !this.console) return null;
    const bytes = this.console.ramView(this.debugOffset, DEBUG_BLOCK_BYTES);
    return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  }

  /** Before a tick: the magic and line numbers, and any new breakpoints or watches. */
  private armDebug(block: DataView): void {
    armDebugBlock(block, this.lineOffset, this.lineCount);
    const state = this.debugState;
    if (state?.dirty) {
      writeBreakpoints(block, state.breakpoints);
      writeWatches(block, state.watches);
      state.dirty = false;
    }
  }

  /** After a tick: if the cart stopped at a breakpoint, stop the loop and say where. */
  private checkPause(): void {
    const state = this.debugState;
    const block = this.debugBlock();
    if (!state || !block) return;
    const pause = readPause(block, state.watches.length);
    state.paused = pause;
    if (!pause) return;
    this.pause();
    this.options.debug?.onPause?.(pause);
  }

  /** The debugger: which lines to stop at (moved on to the next line that can break, by the caller's choice). */
  setBreakpoints(lines: readonly number[]): void {
    if (!this.debugState) return;
    this.debugState.breakpoints = effectiveBreakpoints(lines, this.debugState.breakable);
    this.debugState.dirty = true;
    const block = this.debugBlock();
    if (block) this.armDebug(block);
  }

  /** The debugger: expressions to evaluate wherever the cart stops (re-evaluated now if it's stopped). */
  setWatches(expressions: readonly string[]): void {
    const state = this.debugState;
    if (!state) return;
    state.watches = [...expressions];
    state.dirty = true;
    const block = this.debugBlock();
    if (!block || !this.console) return;
    this.armDebug(block);
    if (state.paused) {
      // Re-read the stop without moving on: the Lua takes command 5 in place.
      sendDebugCommand(block, DebugCommand.refresh);
      this.console.tick(0);
      const pause = readPause(this.debugBlock()!, state.watches.length);
      state.paused = pause;
      if (pause) this.options.debug?.onPause?.(pause);
    }
  }

  /** The debugger: carry on from a stop — to the next breakpoint, or one statement (into, over, out). */
  debugContinue(step: DebugStep = "continue"): void {
    const state = this.debugState;
    const block = this.debugBlock();
    if (!state?.paused || !block) return;
    sendDebugCommand(block, DebugCommand[step]);
    state.paused = null;
    this.options.debug?.onPause?.(null);
    void this.resume();
  }

  /** Where the cart is stopped, or null. */
  debugPaused(): PauseInfo | null {
    return this.debugState?.paused ?? null;
  }

  /** Lines the debugger can stop at (ascending); empty without the debugger. */
  breakableLines(): readonly number[] {
    return this.debugState?.breakable ?? [];
  }

  /** Hand the console the traces the cart printed during `frame`. */
  private drainDebug(frame: number): void {
    const block = this.debugBlock();
    const onTrace = this.options.onTrace;
    if (!block || !onTrace) return;
    const { traces, dropped } = drainTraces(block);
    for (const trace of traces) onTrace(trace.text, trace.color, frame);
    if (dropped > 0) onTrace(`(${dropped} more trace${dropped === 1 ? "" : "s"} this frame didn't fit)`, 15, frame);
  }

  /** Reads any platform events the cart emitted this frame and dispatches them. */
  private pollEvents(): void {
    const onEvent = this.options.onEvent;
    if (!onEvent || !this.console) {
      return;
    }
    const { events, seq } = decodeMailbox(this.console.readMailbox(), this.lastMailboxSeq);
    this.lastMailboxSeq = seq;
    for (const event of events) {
      onEvent(event);
    }
  }

  private present(): void {
    const started = this.profiler ? this.view.performance.now() : 0;
    this.presentFrameNow();
    this.profiler?.add("render", this.view.performance.now() - started);
  }

  private presentFrameNow(): void {
    const framebuffer = this.console?.readFramebuffer();
    if (framebuffer) {
      // Relight from any lights the cart published this frame via cartbox.light(),
      // and feed the per-pixel material the core emitted for this frame's sprites.
      if (this.litSurface && this.console) {
        this.litSurface.setCartLights(decodeLights(this.console.readMailbox()));
        this.litSurface.setCartMaterial(this.console.readMaterial());
        this.litSurface.setCartEmissive(this.console.readEmissive());
      }
      // Let a scene cart pan its backdrop by publishing cartbox.camera(x, y).
      if (this.sceneSurface && this.console) {
        this.sceneSurface.setCameraBase(decodeCamera(this.console.readMailbox()));
      }
      // Let a mesh cart drive its 3D orbit camera via cartbox.meshcam(...); a null
      // decode (the cart isn't driving it) leaves the surface auto-orbiting. Its
      // per-instance poses (cartbox.meshpose) ride the same mailbox read.
      if (this.meshSurface && this.console) {
        const mailbox = this.console.readMailbox();
        const meshCamera = decodeMeshCamera(mailbox);
        this.meshSurface.setCameraOverride(meshCamera);
        // First-person carts ask (via cartbox.hud) for their 2D frame to composite
        // over the meshes instead of behind them.
        this.meshSurface.setHudMode(meshCamera?.hud ?? false);
        this.meshSurface.setPoseOverrides(decodeMeshPoses(mailbox));
        if (this.runtime) {
          // A playing timeline takes the camera, and places the objects it animates (over physics).
          const cutscene = this.runtime.channel.timelineCamera(meshCamera?.hud ?? false);
          if (cutscene) this.meshSurface.setCameraOverride(cutscene);
          // Over physics, objects the cart placed (cartbox.place); over both, a playing timeline.
          const scripted = this.runtime.channel.timelinePlacements();
          const put = this.runtime.channel.placements();
          const bodies = this.runtime.physics?.overrides();
          this.meshSurface.setBodyOverrides(scripted.size > 0 || put.size > 0 ? new Map([...(bodies ?? []), ...put, ...scripted]) : (bodies ?? NO_OVERRIDES));
          this.meshSurface.setSpawned(this.runtime.channel.spawned());
          this.meshSurface.setShields(this.runtime.channel.shields());
          // IK aims in world space: give it where each object is this frame.
          const placed = this.runtime.channel.needsWorld() ? this.meshSurface.currentPlacements() : null;
          this.meshSurface.setSkinning(placed ? this.runtime.channel.skinning((o) => placed[o] ?? null) : this.runtime.channel.skinning());
        }
        this.meshSurface.setCartLights(decodeWorldLights(mailbox));
        // An editor that has ejected from the game looks through its own camera.
        if (this.editorCamera) {
          this.meshSurface.setCameraOverride(this.editorCamera);
          this.meshSurface.setHudMode(false);
        }
      }
      // The HD-2D world reuses the same channels: cartbox.worldcam drives its
      // camera (decoded as a mesh camera) and cartbox.billboard places its 2D
      // characters (decoded as mesh poses — index + world position + scale).
      if (this.worldSurface && this.console) {
        const mailbox = this.console.readMailbox();
        this.worldSurface.setCameraOverride(decodeMeshCamera(mailbox));
        this.worldSurface.setBillboards(decodeMeshPoses(mailbox));
        // Shade the terrain by the cart's key light (cartbox.sun) so the 3D blocks
        // read as solid geometry lit from the scene's sun, not a flat top-down key.
        const sun = decodeLights(mailbox).find((light) => light.kind === "directional");
        this.worldSurface.setSun(sun?.direction ?? null);
      }
      // Play the declared animation for this frame: route the sampled state to the
      // scene layers, foreground placements, and post-FX before the frame is blit.
      this.applyAnimation();
      this.surface?.blit(framebuffer);
      this.presentFrame += 1; // advance in lockstep with the scene backdrop's own clock
      this.options.onFrame?.();
    }
  }

  /**
   * Sample the declared animation at the current presented frame and route it to
   * the surfaces that consume it. Feeds the scene backdrop's layer overrides, the
   * foreground placements, and (only when animated) the post-FX values. Runs before
   * blit so the composite reflects this frame; a no-op when no anim is declared.
   */
  private applyAnimation(): void {
    if (!this.anim) return;
    const state = evaluate(this.anim, this.presentFrame);

    if (this.sceneSurface) {
      const hasLayerOverrides = Object.keys(state.layers).length > 0;
      this.sceneSurface.setLayerOverrides(hasLayerOverrides ? state.layers : null);
    }
    this.foregroundSurface?.setPlacements(state.placements);

    if (this.postFxSurface && this.basePostFx && Object.keys(state.postfx).length > 0) {
      this.postFxSurface.setSettings(
        applyQualityToPostFx({ ...this.basePostFx, values: { ...this.basePostFx.values, ...state.postfx } }, this.qualitySettings),
      );
    }
  }

  private renderSingleFrame(): void {
    this.tickOnce();
    this.present();
  }

  /**
   * Analog sticks (see sticks.ts): once the cart has read a stick — the SDK marks
   * pmem with its opt-in — write the sticks before every tick, and show the
   * touch pad's right stick. Until then nothing is written, so a cart's own use
   * of those pmem words is left alone.
   */
  private feedSticks(): void {
    const words = this.console?.netWords();
    if (!words) return;
    if (!this.analogCart) {
      if (words[STICK_OPTIN_WORD] !== STICK_OPTIN_MAGIC) return;
      this.analogCart = true;
      this.touch?.setAnalog(true);
    }
    words[STICK_WORD] = this.replaySource || !this.inputEnabled ? 0 : packSticks(applyLookSettings(this.gamepad.axes, this.controlSettings));
  }

  /** Save data (EP15b): hand a save the cart made this tick to the host. */
  private pollSave(): void {
    if (!this.saveBlock || !this.console) return;
    const bytes = this.console.ramView(this.saveBlock.offset, this.saveBlock.bytes);
    if (!bytes) return;
    const block = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    armSaveBlock(block);
    const save = takeSave(block);
    if (save) this.options.onSave?.(save.data);
  }

  /** Input actions (EP15): this tick's mask and last tick's into the input block. */
  private feedActions(held: number): void {
    if (this.inputOffset === null || !this.console) return;
    const bytes = this.console.ramView(this.inputOffset, INPUT_BLOCK_BYTES);
    if (!bytes) return;
    writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), held, this.lastActions);
    this.lastActions = held;
  }

  private fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setColorFilter("none");
    this.running = false;
    this.abortController.abort();
    this.view.cancelAnimationFrame(this.frameHandle);
    this.keyboard?.destroy();
    this.touch?.destroy();
    this.runtime?.channel.destroy();
    this.runtime = null;
    this.sounds?.dispose();
    this.audio?.destroy();
    this.surface?.destroy();
    // After the surfaces: they draw through it, and the decorator chain's
    // destroy() cascades inward before anything here releases GPU resources.
    this.sceneRenderer?.dispose();
    this.cartSource?.dispose();
    this.console?.dispose();
  }
}

/**
 * A cached {@link TextureLookup} over a cart's sprite sheet for the world layer:
 * each distinct sprite id is read once as an N×N tile block (N = the world's
 * `tilesPerSide`) and decoded to a straight-alpha {@link DecodedTexture} (palette
 * index 0 → transparent, so a billboard shows its silhouette). Reads come from the
 * same `readRegion` the parallax backdrop uses, so no engine change is needed.
 */
function makeWorldTextureLookup(cartSource: CartSpriteSource, tilesPerSide: number): TextureLookup {
  const cache = new Map<number, DecodedTexture | null>();
  return (sprite: number): DecodedTexture | null => {
    const cached = cache.get(sprite);
    if (cached !== undefined) return cached;
    // Tiles page (0) holds the map/tile bank the world's sprite ids index into.
    const region = cartSource.source.readRegion(0, sprite, tilesPerSide, tilesPerSide);
    const texture: DecodedTexture | null =
      region.width > 0 && region.height > 0
        ? { width: region.width, height: region.height, data: region.pixels }
        : null;
    cache.set(sprite, texture);
    return texture;
  };
}

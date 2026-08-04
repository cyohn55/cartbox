/**
 * Player orchestrator. Wires the cartridge, engine, display, input, and audio
 * together and drives a fixed-timestep run loop. This is the only module that
 * knows about all the others; each collaborator stays independent and testable.
 */

import { AudioController } from "./audio.js";
import { fetchCartridge } from "./cartridge.js";
import { CanvasSurface, type DisplaySurface } from "./display.js";
import { LitCanvasSurface } from "./lighting/LitCanvasSurface.js";
import { PostFxSurface } from "./fx/PostFxSurface.js";
import { anyPostFxEnabled, type PostFxSettings } from "./fx/postfx.js";
import { createConsole, loadEngineModule, type ConsoleInstance } from "./engine.js";
import { GamepadState, KeyboardInput, TouchInput } from "./input.js";
import { frameDurationMs, getModel, type ConsoleModel } from "./models.js";
import { ReplayRecorder, ReplaySource, hashCart, randomSeed, type Replay } from "./replay.js";
import { seedCartridge, prependLuaCode } from "./cartseed.js";
import { injectSdk } from "./sdk.js";
import { collisionSdkLua } from "./collisionSdk.js";
import { decodeCamera, decodeLights, decodeMailbox } from "./mailbox.js";
import { createCartSpriteSource, type CartSpriteSource } from "./scene/cartSpriteSource.js";
import { resolveSceneLayers } from "./scene/sceneRender.js";
import { SceneBackdropSurface } from "./scene/SceneBackdropSurface.js";
import { AnimatedForegroundSurface } from "./anim/AnimatedForegroundSurface.js";
import { evaluate } from "./anim/animPlayer.js";
import type { AnimSpec } from "./anim/animModel.js";
import { ParticleOverlaySurface } from "./particles/ParticleOverlaySurface.js";
import type { ControlScheme, PlayerOptions } from "./types.js";

/**
 * Decides which input sources to attach. "auto" uses touch when the primary
 * pointer is coarse (phones/tablets) and keyboard otherwise.
 */
function shouldUseTouch(scheme: ControlScheme, view: Window): boolean {
  if (scheme === "touch") return true;
  if (scheme === "keyboard") return false;
  return view.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export class Player {
  private readonly gamepad = new GamepadState();
  private readonly view: Window;
  private surface?: DisplaySurface;
  private litSurface?: LitCanvasSurface;
  private sceneSurface?: SceneBackdropSurface;
  private foregroundSurface?: AnimatedForegroundSurface;
  private postFxSurface?: PostFxSurface;
  private basePostFx?: PostFxSettings;
  private anim?: AnimSpec;
  /** Presented-frame clock for animation, kept in lockstep with the scene backdrop. */
  private presentFrame = 0;
  private audio?: AudioController;
  private keyboard?: KeyboardInput;
  private touch?: TouchInput;
  private console?: ConsoleInstance;
  private cartSource?: CartSpriteSource;
  private readonly model: ConsoleModel;

  private recorder?: ReplayRecorder;
  private replaySource?: ReplaySource;
  private tickFrame = 0;
  private lastMailboxSeq = 0;

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
  }

  /** Loads the cartridge and engine, then starts (or arms) playback. */
  async start(): Promise<void> {
    try {
      const engineUrl = this.options.engineUrl ?? this.model.engineUrl;
      const [bytes, module] = await Promise.all([
        fetchCartridge(this.options.cartUrl, this.abortController.signal),
        loadEngineModule(engineUrl),
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
      const collisionLua = collisionSdkLua(this.options.collision);
      const withCollision = collisionLua ? prependLuaCode(seeded, collisionLua) : seeded;
      const preparedBytes = injectSdk(withCollision);

      this.console = createConsole(module, this.model, sampleRate);
      if (!this.console.loadCartridge(preparedBytes)) {
        throw new Error("Engine rejected the cartridge");
      }
      // Only pay for the per-pixel material G-buffer when a lit surface will use it.
      this.console.setMaterialCapture(Boolean(this.options.lighting));
      // Baseline the mailbox so any pre-existing persistent memory isn't
      // mistaken for freshly emitted events.
      this.lastMailboxSeq = this.console.readMailbox()[0] ?? 0;

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
      let backdrop: { layers: ReturnType<typeof resolveSceneLayers>; keyRgb: readonly [number, number, number] } | null = null;
      if (scene || wantsForeground) {
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
      if (postFx && anyPostFxEnabled(postFx)) {
        const fx = await PostFxSurface.create(this.container, scale, this.model, postFx, makeBaseSurface);
        if (fx) this.postFxSurface = fx;
        this.surface = fx ?? (await makeBaseSurface(this.container));
      } else {
        this.surface = await makeBaseSurface(this.container);
      }
      if (this.destroyed) {
        this.surface.destroy(); // torn down mid-load: don't leak the canvas
        return;
      }
      this.audio = new AudioController(sampleRate);
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
    if (shouldUseTouch(this.options.controls ?? "auto", this.view)) {
      this.touch = new TouchInput(this.container, this.gamepad);
    } else {
      this.keyboard = new KeyboardInput(this.view, this.gamepad);
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

    this.frameAccumulatorMs += now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Cap catch-up so a long stall doesn't trigger a burst of frames.
    const maxFramesPerRender = 4;
    const frameMs = frameDurationMs(this.model);
    let advanced = 0;
    while (this.frameAccumulatorMs >= frameMs && advanced < maxFramesPerRender) {
      this.tickOnce();
      this.frameAccumulatorMs -= frameMs;
      advanced++;
    }
    if (advanced > 0) {
      this.present();
    }

    this.frameHandle = this.view.requestAnimationFrame(this.loop);
  };

  private tickOnce(): void {
    // In playback the mask comes from the replay; otherwise from live input.
    const mask = this.replaySource ? this.replaySource.maskForFrame(this.tickFrame) : this.gamepad.value;
    this.console?.tick(mask);
    this.recorder?.record(mask);
    this.tickFrame++;

    this.pollEvents();

    const samples = this.console?.readAudioSamples();
    if (samples && samples.length > 0) {
      this.audio?.enqueue(samples);
    }
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
      // Play the declared animation for this frame: route the sampled state to the
      // scene layers, foreground placements, and post-FX before the frame is blit.
      this.applyAnimation();
      this.surface?.blit(framebuffer);
      this.presentFrame += 1; // advance in lockstep with the scene backdrop's own clock
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
      this.postFxSurface.setSettings({
        ...this.basePostFx,
        values: { ...this.basePostFx.values, ...state.postfx },
      });
    }
  }

  private renderSingleFrame(): void {
    this.tickOnce();
    this.present();
  }

  private fail(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    this.abortController.abort();
    this.view.cancelAnimationFrame(this.frameHandle);
    this.keyboard?.destroy();
    this.touch?.destroy();
    this.audio?.destroy();
    this.surface?.destroy();
    this.cartSource?.dispose();
    this.console?.dispose();
  }
}

/**
 * The `wasm-app` runtime: host side of the Cartbox Game ABI (games/README.md).
 *
 * Loads an Emscripten module, drives it a frame at a time, blits its framebuffer
 * to a canvas, and persists saves. Ported games differ enormously in what they
 * are internally; they are identical to this module, which only ever sees seven
 * exported functions and a block of RGBA bytes.
 *
 * The module factory is injected rather than imported, so the whole lifecycle is
 * exercised in tests against a real compiled binary without a bundler or a DOM.
 */

/** The Emscripten module surface this runtime relies on. */
export interface GameModule {
  HEAPU8: Uint8Array;
  _cartbox_init(width: number, height: number): number;
  _cartbox_set_input(buttons: number): void;
  _cartbox_tick(deltaSeconds: number): void;
  _cartbox_score(): number;
  _cartbox_save_size(): number;
  _cartbox_save(pointer: number): number;
  _cartbox_load(pointer: number, size: number): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
}

/** Produces an instantiated module. Emscripten's MODULARIZE export shape. */
export type GameModuleFactory = (options?: Record<string, unknown>) => Promise<GameModule>;

export interface GameDimensions {
  width: number;
  height: number;
}

/** Thrown when a module does not honour the ABI, rather than failing later. */
export class GameAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameAbiError";
  }
}

const REQUIRED_EXPORTS: readonly (keyof GameModule)[] = [
  "_cartbox_init",
  "_cartbox_set_input",
  "_cartbox_tick",
  "_cartbox_score",
  "_cartbox_save_size",
  "_cartbox_save",
  "_cartbox_load",
  "_malloc",
  "_free",
];

/**
 * Verifies a module implements the ABI before anything depends on it.
 *
 * A missing export surfaces here as a clear error naming the symbol, instead of
 * as an undefined-is-not-a-function three frames into the first tick.
 */
export function assertImplementsAbi(module: Partial<GameModule>): asserts module is GameModule {
  const missing = REQUIRED_EXPORTS.filter((name) => typeof module[name] !== "function");
  if (missing.length > 0) {
    throw new GameAbiError(`Module does not implement the Cartbox Game ABI: missing ${missing.join(", ")}`);
  }
  if (!(module.HEAPU8 instanceof Uint8Array)) {
    throw new GameAbiError("Module does not expose HEAPU8");
  }
}

/**
 * A loaded, running game. Owns the module's lifetime; `dispose` releases it.
 */
export class GameSession {
  #framePointer: number;
  #frameBytes: number;

  private constructor(
    private readonly module: GameModule,
    readonly dimensions: GameDimensions,
    framePointer: number,
  ) {
    this.#framePointer = framePointer;
    this.#frameBytes = dimensions.width * dimensions.height * 4;
  }

  /**
   * Instantiates a module and initialises the game.
   *
   * The framebuffer pointer is captured once, as the ABI requires it to stay
   * valid for the module's lifetime — but the *view* is rebuilt on every read,
   * because a growable heap detaches old typed-array views.
   */
  static async start(
    factory: GameModuleFactory,
    dimensions: GameDimensions,
    options?: Record<string, unknown>,
  ): Promise<GameSession> {
    if (dimensions.width <= 0 || dimensions.height <= 0) {
      throw new GameAbiError("Game dimensions must be positive");
    }
    const module = await factory(options);
    assertImplementsAbi(module);

    const framePointer = module._cartbox_init(dimensions.width, dimensions.height);
    if (!framePointer) {
      throw new GameAbiError("cartbox_init returned a null framebuffer");
    }
    return new GameSession(module, dimensions, framePointer);
  }

  /**
   * The current frame as RGBA bytes.
   *
   * Returns a fresh subarray each call rather than a cached one: with
   * ALLOW_MEMORY_GROWTH the module's heap can be replaced, which detaches any
   * view taken earlier and would otherwise yield an empty buffer mid-game.
   */
  frame(): Uint8Array {
    return this.module.HEAPU8.subarray(this.#framePointer, this.#framePointer + this.#frameBytes);
  }

  setInput(buttonMask: number): void {
    this.module._cartbox_set_input(buttonMask >>> 0);
  }

  /** Advances one frame. `deltaSeconds` is real elapsed time, not a fixed step. */
  tick(deltaSeconds: number): void {
    this.module._cartbox_tick(deltaSeconds);
  }

  score(): number {
    return this.module._cartbox_score();
  }

  /**
   * Serialises the game's save state, or null when the game has none.
   *
   * The scratch buffer is freed even if the game misbehaves, so a game that
   * reports a size and then writes nothing leaks nothing.
   */
  save(): Uint8Array | null {
    const size = this.module._cartbox_save_size();
    if (size <= 0) {
      return null;
    }
    const pointer = this.module._malloc(size);
    if (!pointer) {
      throw new GameAbiError("Could not allocate a save buffer");
    }
    try {
      const written = this.module._cartbox_save(pointer);
      if (written <= 0) {
        return null;
      }
      // Copy out of the heap: the caller keeps this past the next allocation.
      return Uint8Array.from(this.module.HEAPU8.subarray(pointer, pointer + written));
    } finally {
      this.module._free(pointer);
    }
  }

  /**
   * Restores a save. Returns false when the game rejects it — saves outlive game
   * updates, so a refusal is an expected outcome, not an error.
   */
  load(data: Uint8Array): boolean {
    if (data.byteLength === 0) {
      return false;
    }
    const pointer = this.module._malloc(data.byteLength);
    if (!pointer) {
      throw new GameAbiError("Could not allocate a load buffer");
    }
    try {
      this.module.HEAPU8.set(data, pointer);
      return this.module._cartbox_load(pointer, data.byteLength) !== 0;
    } finally {
      this.module._free(pointer);
    }
  }
}

/**
 * Paints a frame onto a canvas.
 *
 * Split from GameSession so the runtime stays testable without a DOM, and so the
 * handheld shell can composite frames its own way.
 */
export function paintFrame(
  context: CanvasRenderingContext2D,
  frame: Uint8Array,
  dimensions: GameDimensions,
): void {
  // ImageData needs its own buffer; the frame is a view into the WASM heap.
  const image = context.createImageData(dimensions.width, dimensions.height);
  image.data.set(frame);
  context.putImageData(image, 0, 0);
}

/**
 * Clamps a frame delta before it reaches the game.
 *
 * A backgrounded tab produces a multi-second gap on return; passing it through
 * would teleport everything the game simulates. Clamping here means every ported
 * game inherits the fix rather than each needing its own.
 */
export const MAX_FRAME_DELTA_SECONDS = 0.1;

export function clampDelta(deltaSeconds: number): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return 0;
  }
  return Math.min(deltaSeconds, MAX_FRAME_DELTA_SECONDS);
}

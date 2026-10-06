/**
 * The dedicated Modern core (ENGINE_PARITY_ROADMAP.md EP20b), from JavaScript:
 * start one, load a cart's Lua, tick it, and read its frame — while the cart's
 * calls into the engine arrive at the host as they're made.
 *
 *   const core = await createModernCore(factory, { width: 1280, height: 720, seed, host });
 *   core.load(code);           // runs the cart's top level
 *   core.tick(buttons);        // one frame: TIC() with these buttons held
 *   core.frame();              // its RGBA framebuffer (a live view)
 *   core.texts();              // what it printed this frame, for the host to draw
 *
 * `host.command(op, a, v1..v6)` receives every `_cbx_cmd` (cartbox.command)
 * call synchronously, in order and without a cap; `host.query(...)` answers a
 * `_cbx_query` (cartbox.query) with numbers, in the same call. The op numbers
 * are the runtime protocol's (packages/player/src/physics/protocol.ts), so the
 * same host code serves both cores.
 *
 * `factory` is the Emscripten module (dist/modern-core.js), passed in so the
 * caller decides how it's loaded (a URL in a page, a file in Node).
 */

export interface ModernCoreHost {
  command(op: number, a: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number): void;
  query(op: number, a: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number): readonly number[] | null;
  trace?(message: string): void;
}

export interface CoreText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly color: number;
  readonly scale: number;
  readonly small: boolean;
}

export interface ModernCore {
  readonly width: number;
  readonly height: number;
  /** Run the cart's code; false with the error (and traceback) in `error()`. */
  load(code: string): boolean;
  /** One frame with these buttons held (bit i = button i); false if TIC raised an error. */
  tick(buttons?: number): boolean;
  /** The last error's message. */
  error(): string;
  /** The framebuffer, RGBA, `width × height` (a view into the core's memory: copy it to keep it). */
  frame(): Uint8ClampedArray;
  /** What the cart printed since the last tick began. */
  texts(): readonly CoreText[];
  /** Lua's memory in use, KB. */
  memoryKb(): number;
}

/** The Emscripten module's shape (as much as this wrapper uses). */
interface CoreModule {
  cbxHost: unknown;
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  UTF8ToString(ptr: number): string;
  _cbx_core_init(width: number, height: number, seed: number): number;
  _cbx_core_load(ptr: number, len: number): number;
  _cbx_core_tick(buttons: number): number;
  _cbx_core_framebuffer(): number;
  _cbx_core_returns(): number;
  _cbx_core_error(): number;
  _cbx_core_memory(): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
}

export type ModernCoreFactory = (moduleArg?: object) => Promise<unknown>;

/** The SDK every cart starts with: the direct API under its cartbox names. */
export const MODERN_SDK_LUA = `cartbox = cartbox or {}
cartbox.command = _cbx_cmd
cartbox.query = _cbx_query
cartbox.palette = _cbx_palette
`;

const MAX_RETURNS = 32;

export async function createModernCore(
  factory: ModernCoreFactory,
  options: { width: number; height: number; seed?: number; host: ModernCoreHost; moduleArg?: object },
): Promise<ModernCore> {
  const texts: CoreText[] = [];
  const mod = (await factory(options.moduleArg)) as CoreModule;
  const host = options.host;
  mod.cbxHost = {
    command: host.command.bind(host),
    query: (op: number, a: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number) => {
      const answer = host.query(op, a, v1, v2, v3, v4, v5, v6);
      if (!answer || answer.length === 0) return 0;
      const n = Math.min(MAX_RETURNS, answer.length);
      const at = mod._cbx_core_returns() >> 3;
      for (let i = 0; i < n; i += 1) mod.HEAPF64[at + i] = answer[i]!;
      return n;
    },
    text: (text: string, x: number, y: number, color: number, scale: number, small: boolean) => texts.push({ text, x, y, color, scale, small }),
    trace: (message: string) => host.trace?.(message),
  };
  if (!mod._cbx_core_init(options.width, options.height, options.seed ?? 0)) throw new Error("The Modern core could not start");
  const run = (code: string) => {
    const bytes = new TextEncoder().encode(code);
    const ptr = mod._malloc(bytes.length + 1);
    mod.HEAPU8.set(bytes, ptr);
    const ok = mod._cbx_core_load(ptr, bytes.length) === 1;
    mod._free(ptr);
    return ok;
  };
  if (!run(MODERN_SDK_LUA)) throw new Error(`The Modern core's SDK failed: ${mod.UTF8ToString(mod._cbx_core_error())}`);
  return {
    width: options.width,
    height: options.height,
    load: run,
    tick: (buttons = 0) => {
      texts.length = 0;
      return mod._cbx_core_tick(buttons >>> 0) === 1;
    },
    error: () => mod.UTF8ToString(mod._cbx_core_error()),
    frame: () => new Uint8ClampedArray(mod.HEAPU8.buffer, mod._cbx_core_framebuffer(), options.width * options.height * 4),
    texts: () => texts,
    memoryKb: () => mod._cbx_core_memory(),
  };
}

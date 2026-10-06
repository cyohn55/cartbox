/**
 * The dedicated Modern core (ENGINE_PARITY_ROADMAP.md EP20b), from JavaScript:
 * start one, load a cart's Lua, tick it, and read its frame and RAM — while the
 * cart's calls into the engine arrive at the host as they're made.
 *
 *   const core = await createModernCore(factory, { width: 1280, height: 720, seed, host });
 *   core.cart(bytes);          // its banks: palette, sprites, map, sound (optional)
 *   core.load(code);           // runs the cart's top level
 *   core.tick(buttons);        // one frame: TIC() with these buttons held
 *   core.frame();              // its RGBA framebuffer (a live view)
 *   core.ram();                // its emulated TIC-80 RAM (a live view)
 *   core.samples();            // the frame's sound, interleaved stereo
 *
 * `host.command(op, a, v1..v6)` receives every `_cbx_cmd` (cartbox.command)
 * call synchronously, in order and without a cap; `host.query(...)` answers a
 * `_cbx_query` (cartbox.query) with numbers, in the same call. The op numbers
 * are the runtime protocol's (packages/player/src/physics/protocol.ts), so the
 * same host code serves both cores.
 *
 * Underneath is TIC-80 as a cart sees it (src/tic.c): the RAM in a
 * TIC-80–derived core's layout (`ram.size`, `ram.pmem`), the cartridge's banks,
 * the 2D API, input and sound. So carts, and the Lua SDK written for those
 * cores (its event mailbox in pmem, its blocks at the end of RAM), run
 * unchanged here.
 *
 * `factory` is the Emscripten module (dist/modern-core.js), passed in so the
 * caller decides how it's loaded (a URL in a page, a file in Node).
 */

export interface ModernCoreHost {
  command(op: number, a: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number): void;
  query(op: number, a: number, v1: number, v2: number, v3: number, v4: number, v5: number, v6: number): readonly number[] | null;
  trace?(message: string): void;
}

export interface ModernCore {
  readonly width: number;
  readonly height: number;
  /** Read a cartridge's banks (TIC-80's chunk format): palette, tiles, sprites, map, flags, sound, music. Call before `load`. */
  cart(bytes: Uint8Array): void;
  /** Run the cart's code; false with the error (and traceback) in `error()`. */
  load(code: string): boolean;
  /** One frame with these buttons held (bit i = button i); false if TIC raised an error. */
  tick(buttons?: number): boolean;
  /** The last error's message. */
  error(): string;
  /** The framebuffer, RGBA, `width × height` (a view into the core's memory: re-fetch after a tick). */
  frame(): Uint8Array;
  /** The emulated RAM (a live view: re-fetch after a tick, as memory can grow). */
  ram(): Uint8Array;
  /** This frame's sound: interleaved stereo 16-bit samples (a copy). */
  samples(): Int16Array;
  /** Lua's memory in use, KB. */
  memoryKb(): number;
  /** Bytes of the core's WebAssembly memory. */
  memoryBytes(): number;
}

/** The Emscripten module's shape (as much as this wrapper uses). */
interface CoreModule {
  cbxHost: unknown;
  HEAPU8: Uint8Array;
  HEAPF64: Float64Array;
  UTF8ToString(ptr: number): string;
  _cbx_core_init(width: number, height: number, seed: number, ramSize: number, pmemAddress: number, sampleRate: number): number;
  _cbx_core_cart(ptr: number, len: number): void;
  _cbx_core_load(ptr: number, len: number): number;
  _cbx_core_tick(buttons: number): number;
  _cbx_core_framebuffer(): number;
  _cbx_core_ram(): number;
  _cbx_core_samples(): number;
  _cbx_core_sample_count(): number;
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

/** The RAM of the HD core (Modern, Xbox 360): the default. */
export const HD_RAM = { size: 8388608, pmem: 3068512 } as const;

/** Start the core in an already-instantiated module (see createModernCore for loading one). */
export function wrapModernCore(
  module: unknown,
  options: { width: number; height: number; seed?: number; host: ModernCoreHost; ram?: { size: number; pmem: number }; sampleRate?: number },
): ModernCore {
  const mod = module as CoreModule;
  const host = options.host;
  const ram = options.ram ?? HD_RAM;
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
    trace: (message: string) => host.trace?.(message),
  };
  if (!mod._cbx_core_init(options.width, options.height, options.seed ?? 0, ram.size, ram.pmem, options.sampleRate ?? 44100)) throw new Error("The Modern core could not start");
  const withBytes = <T>(bytes: Uint8Array, use: (ptr: number) => T): T => {
    const ptr = mod._malloc(bytes.length + 1);
    mod.HEAPU8.set(bytes, ptr);
    try {
      return use(ptr);
    } finally {
      mod._free(ptr);
    }
  };
  const run = (code: string) => {
    const bytes = new TextEncoder().encode(code);
    return withBytes(bytes, (ptr) => mod._cbx_core_load(ptr, bytes.length) === 1);
  };
  if (!run(MODERN_SDK_LUA)) throw new Error(`The Modern core's SDK failed: ${mod.UTF8ToString(mod._cbx_core_error())}`);
  return {
    width: options.width,
    height: options.height,
    cart: (bytes) => withBytes(bytes, (ptr) => mod._cbx_core_cart(ptr, bytes.length)),
    load: run,
    tick: (buttons = 0) => mod._cbx_core_tick(buttons >>> 0) === 1,
    error: () => mod.UTF8ToString(mod._cbx_core_error()),
    frame: () => mod.HEAPU8.subarray(mod._cbx_core_framebuffer(), mod._cbx_core_framebuffer() + options.width * options.height * 4),
    ram: () => mod.HEAPU8.subarray(mod._cbx_core_ram(), mod._cbx_core_ram() + ram.size),
    samples: () => {
      const at = mod._cbx_core_samples();
      return new Int16Array(mod.HEAPU8.buffer.slice(at, at + mod._cbx_core_sample_count() * 2));
    },
    memoryKb: () => mod._cbx_core_memory(),
    memoryBytes: () => mod.HEAPU8.length,
  };
}

/** Load the core from its Emscripten factory and start it. */
export async function createModernCore(
  factory: ModernCoreFactory,
  options: { width: number; height: number; seed?: number; host: ModernCoreHost; ram?: { size: number; pmem: number }; sampleRate?: number; moduleArg?: object },
): Promise<ModernCore> {
  return wrapModernCore(await factory(options.moduleArg), options);
}

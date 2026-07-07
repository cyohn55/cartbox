/**
 * Engine adapter — the single seam between this player and the TIC-80 WASM core.
 *
 * `packages/engine` compiles the TIC-80 core plus a thin C shim to WASM via
 * Emscripten. The shim exports the stable C entry points below (prefixed `cbx_`);
 * keeping the shim contract narrow means struct layout changes in TIC-80 never
 * leak into the TypeScript. Everything WASM-specific lives here and nowhere else.
 *
 * Shim contract (implemented in packages/engine/shim.c, exported via
 * EXPORTED_FUNCTIONS):
 *   int  cbx_create(int sampleRate)                -> opaque console handle
 *   int  cbx_load(int handle, int ptr, int size)   -> 1 on success, 0 on failure
 *   void cbx_tick(int handle, int gamepadMask)      -> advance one 60Hz frame
 *   int  cbx_screen_ptr(int handle)                 -> ptr to RGBA framebuffer
 *   int  cbx_samples_ptr(int handle)                -> ptr to Int16 PCM for this frame
 *   int  cbx_samples_count(int handle)              -> sample count for this frame
 *   void cbx_delete(int handle)                     -> free the console
 */

import { framebufferBytes, type ConsoleModel } from "./models.js";

/** Minimal view of the Emscripten module we depend on. */
interface EmscriptenModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _cbx_create(sampleRate: number): number;
  _cbx_load(handle: number, ptr: number, size: number): number;
  _cbx_tick(handle: number, gamepadMask: number): void;
  _cbx_screen_ptr(handle: number): number;
  _cbx_samples_ptr(handle: number): number;
  _cbx_samples_count(handle: number): number;
  _cbx_mailbox_ptr(handle: number): number;
  _cbx_mailbox_words(handle: number): number;
  _cbx_delete(handle: number): void;
}

/** Signature of the Emscripten factory exported by the engine glue script. */
type EmscriptenFactory = () => Promise<EmscriptenModule>;

/** A loaded console ready to run a single cartridge. */
export interface ConsoleInstance {
  /** Loads cartridge bytes. Returns false if the core rejects the cartridge. */
  loadCartridge(bytes: Uint8Array): boolean;
  /** Advances exactly one frame using the given gamepad bitmask. */
  tick(gamepadMask: number): void;
  /** Returns a view of the current RGBA framebuffer (valid until the next tick). */
  readFramebuffer(): Uint8Array;
  /** Returns the PCM samples produced by the most recent tick. */
  readAudioSamples(): Int16Array;
  /** Returns a copy of the event-mailbox words (word[0] = sequence counter). */
  readMailbox(): Uint32Array;
  /** Frees the underlying WASM console. */
  dispose(): void;
}

/**
 * Loads the engine glue script and instantiates the WASM module.
 *
 * The module is cached per URL so a gallery page with many players pays the
 * download-and-compile cost only once.
 */
const moduleCache = new Map<string, Promise<EmscriptenModule>>();

export async function loadEngineModule(engineUrl: string): Promise<EmscriptenModule> {
  const cached = moduleCache.get(engineUrl);
  if (cached) {
    return cached;
  }

  const pending = import(/* @vite-ignore */ /* webpackIgnore: true */ engineUrl)
    .then((glue: { default: EmscriptenFactory }) => glue.default())
    .catch((error) => {
      moduleCache.delete(engineUrl); // let a later attempt retry a failed load
      throw error;
    });

  moduleCache.set(engineUrl, pending);
  return pending;
}

/** Wraps an Emscripten module as a {@link ConsoleInstance} for a given model. */
export function createConsole(
  module: EmscriptenModule,
  model: ConsoleModel,
  sampleRate: number = model.sampleRate,
): ConsoleInstance {
  const handle = module._cbx_create(sampleRate);
  if (handle === 0) {
    throw new Error("Engine failed to create a console instance");
  }
  const frameBytes = framebufferBytes(model);

  return {
    loadCartridge(bytes: Uint8Array): boolean {
      // Copy the cartridge into WASM memory, hand it to the core, then free it.
      const ptr = module._malloc(bytes.byteLength);
      try {
        module.HEAPU8.set(bytes, ptr);
        return module._cbx_load(handle, ptr, bytes.byteLength) === 1;
      } finally {
        module._free(ptr);
      }
    },

    tick(gamepadMask: number): void {
      module._cbx_tick(handle, gamepadMask);
    },

    readFramebuffer(): Uint8Array {
      const ptr = module._cbx_screen_ptr(handle);
      // Subarray is a view into WASM memory — copied by the display layer on blit.
      return module.HEAPU8.subarray(ptr, ptr + frameBytes);
    },

    readAudioSamples(): Int16Array {
      const count = module._cbx_samples_count(handle);
      if (count === 0) {
        return new Int16Array(0);
      }
      const ptr = module._cbx_samples_ptr(handle);
      const start = ptr / Int16Array.BYTES_PER_ELEMENT;
      // Copy out: the engine reuses this buffer on the next tick.
      return module.HEAP16.slice(start, start + count);
    },

    readMailbox(): Uint32Array {
      const ptr = module._cbx_mailbox_ptr(handle);
      const words = module._cbx_mailbox_words(handle);
      if (ptr === 0 || words === 0) {
        return new Uint32Array(0);
      }
      // Unsigned view over the current WASM memory (buffer may change on growth);
      // copy out so callers hold a stable snapshot.
      return new Uint32Array(module.HEAPU8.buffer, ptr, words).slice();
    },

    dispose(): void {
      module._cbx_delete(handle);
    },
  };
}

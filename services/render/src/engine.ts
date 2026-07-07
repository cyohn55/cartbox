/**
 * Headless engine access for the worker. Reuses the exact same TIC-80 WASM core
 * and adapter as the browser player (built with a node-capable ENVIRONMENT), so
 * a thumbnail is rendered by the same code that will later run the cartridge.
 */

import {
  createConsole,
  loadEngineModule,
  type ConsoleInstance,
  type ConsoleModel,
} from "@cartbox/player";

/** Loads (and caches) the WASM engine module from its URL/path. */
export async function loadEngine(engineUrl: string): Promise<Awaited<ReturnType<typeof loadEngineModule>>> {
  return loadEngineModule(engineUrl);
}

/**
 * Creates a console and loads a cartridge into it.
 *
 * @throws {Error} if the core rejects the cartridge; the console is disposed
 *         first so a bad cart cannot leak WASM memory.
 */
export function openConsole(
  module: Awaited<ReturnType<typeof loadEngineModule>>,
  model: ConsoleModel,
  cartBytes: Uint8Array,
  sampleRate: number = model.sampleRate,
): ConsoleInstance {
  const console = createConsole(module, model, sampleRate);
  if (!console.loadCartridge(cartBytes)) {
    console.dispose();
    throw new Error("Engine rejected the cartridge");
  }
  return console;
}

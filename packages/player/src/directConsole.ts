/**
 * The dedicated Modern core as a console (ENGINE_PARITY_ROADMAP.md EP20b): the
 * player drives it through the same ConsoleInstance interface as the
 * TIC-80–derived cores, so everything around the console — the Lua SDK and its
 * preludes, the event mailbox, the runtime block, physics, the 3D overlay,
 * saves, input actions — works unchanged.
 *
 * What differs is underneath. The core emulates the TIC-80 RAM layout of the
 * HD core (pmem, the mailbox, the runtime and other blocks sit at the same
 * addresses), and its Lua has `_cbx_cmd`: the runtime SDK sends its commands
 * through that, straight to the host as the cart makes them, instead of into
 * the RAM block's 64 slots. {@link DirectConsole.takeCommands} hands the
 * tick's commands to the runtime, which applies them after the block's.
 *
 * Sprites, the map and sound come in a later part (those calls do nothing
 * yet), so the console makes no audio.
 */

import { wrapModernCore, type ModernCore } from "@cartbox/modern-core";

import { readCartCode } from "./cartseed.js";
import type { ConsoleInstance } from "./engine.js";
import { MAILBOX_WORDS } from "./mailbox.js";
import type { ConsoleModel } from "./models.js";
import { NET_WORDS } from "./net/netplay.js";
import { RAM_LAYOUTS, type PhysicsCommand, type RamLayout } from "./physics/protocol.js";

export interface DirectConsole extends ConsoleInstance {
  readonly direct: true;
  /** The commands the cart sent through the direct API since the last take, in order. */
  takeCommands(): PhysicsCommand[];
}

/** The models the dedicated core runs (the HD core's tier). */
export function directCoreModel(model: ConsoleModel): boolean {
  return model.id === "modern" || model.id === "xbox360";
}

/** Wrap an instantiated modern-core module as a console for `model`. */
export function createDirectConsole(module: unknown, model: ConsoleModel, layout: RamLayout = RAM_LAYOUTS[model.id]): DirectConsole {
  let commands: PhysicsCommand[] = [];
  let errorSeq = 0;
  let errorMessage = "";
  const core: ModernCore = wrapModernCore(module, {
    width: model.width,
    height: model.height,
    ram: { size: layout.ramSize, pmem: layout.pmemAddress },
    host: {
      command: (op, a, v1, v2, v3, v4, v5, v6) => {
        commands.push({ op, a, v: [v1, v2, v3, v4, v5, v6] });
      },
      // Queries arrive with the direct SDK; until then the cart reads state from the RAM blocks.
      query: () => null,
    },
  });
  const fail = () => {
    errorSeq += 1;
    errorMessage = core.error();
  };
  const pmem = () => core.ram().subarray(layout.pmemAddress, layout.pmemAddress + 1024);
  const pixels = model.width * model.height;
  let material: Uint8Array | null = null;
  let emissive: Uint8Array | null = null;
  return {
    direct: true,
    takeCommands() {
      const taken = commands;
      commands = [];
      return taken;
    },
    loadCartridge(bytes) {
      const code = readCartCode(bytes);
      if (code === null) return false;
      if (core.load(code)) return true;
      fail();
      return false;
    },
    tick(mask) {
      if (!core.tick(mask)) fail();
    },
    readFramebuffer: () => core.frame(),
    readAudioSamples: () => new Int16Array(0),
    readMailbox() {
      const words = pmem();
      const view = new Uint32Array(words.buffer, words.byteOffset + NET_WORDS * 4, MAILBOX_WORDS);
      return view.slice();
    },
    netWords() {
      const words = pmem();
      return new Uint32Array(words.buffer, words.byteOffset, NET_WORDS);
    },
    ramView(offsetFromPmem, length) {
      const start = layout.pmemAddress + offsetFromPmem;
      if (start < 0 || start + length > layout.ramSize) return null;
      return core.ram().subarray(start, start + length);
    },
    setMaterialCapture() {
      // The 2D layer has no material planes yet: lit carts get flat (zeroed) ones.
    },
    readMaterial: () => (material ??= new Uint8Array(pixels * 4)),
    readEmissive: () => (emissive ??= new Uint8Array(pixels)),
    readError: () => ({ seq: errorSeq, message: errorMessage }),
    memoryBytes: () => core.memoryBytes(),
    dispose() {
      commands = [];
    },
  };
}

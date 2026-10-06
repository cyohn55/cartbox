/**
 * The overflow command ring (ENGINE_PARITY_ROADMAP.md EP20): lifting the
 * Modern tier's cap on what a cart can ask of the 3D engine in one tick.
 *
 * Every cartbox call that changes the scene (place, spawn, play, sound, burst,
 * a physics impulse…) is a command the cart's Lua writes for the host. The
 * runtime block (protocol.ts) holds 64 a tick — on every core, where its 8 KB
 * has to fit in the smallest free RAM. Cores with more free RAM continue
 * commands past the 64th into this ring below the save, input and debug
 * blocks: 128 KB on the HD core (Modern, Xbox 360) and the Pro core (Pro,
 * Portrait), another 4095 a tick (4159 in all); 64 KB on the era core (PS1,
 * N64), another 2047 (2111 in all). Classic has none. The cart sees no difference except that
 * its calls stop being dropped; the host reads the block's commands, then the
 * ring's, so their order is kept.
 *
 * A test writes over each core's region while drawing and checks the engine
 * never touches it (measured against the real builds).
 */

import { saveBlockAddress, saveBlockBytes } from "../saveSdk.js";
import { PHYS_CMD_BYTES, PHYS_MAX_CMDS, takeCommandsAt, type PhysicsCommand, type RamLayout } from "../physics/protocol.js";

/** The largest ring (the HD and Pro cores): 128 KB. */
export const CMD_RING_BYTES = 131072;
/** Commands the largest ring holds a tick (after its count word). */
export const CMD_RING_MAX = Math.floor((CMD_RING_BYTES - 4) / PHYS_CMD_BYTES);

/**
 * The ring's size on a core: what its free RAM affords above TIC-80's own
 * RAM (pmem, flags, font, mapping end 0x1020 past pmem) and below the save,
 * input and debug blocks. HD (Modern, Xbox 360) and Pro (Pro, Portrait): 128
 * KB; the era core (PS1, N64): 64 KB; Classic: none (its free RAM is the
 * runtime block's).
 */
export function commandRingBytes(layout: RamLayout): number {
  const free = saveBlockAddress(layout) - (layout.pmemAddress + 0x1020);
  for (const bytes of [CMD_RING_BYTES, 65536]) if (free >= bytes + 4096) return bytes;
  return 0;
}

/** Commands a core's ring holds a tick (0 without one). */
export function commandRingMax(layout: RamLayout): number {
  const bytes = commandRingBytes(layout);
  return bytes > 0 ? Math.floor((bytes - 4) / PHYS_CMD_BYTES) : 0;
}

/** Whether a core's free RAM holds a ring. */
export function hasCommandRing(layout: RamLayout): boolean {
  return commandRingBytes(layout) > 0 && saveBlockBytes(layout) > 0;
}

/** The ring's address in Lua's RAM address space (null on cores without one). */
export function commandRingAddress(layout: RamLayout): number | null {
  return hasCommandRing(layout) ? saveBlockAddress(layout) - commandRingBytes(layout) : null;
}

/** How many commands a cart can issue in one tick on a core. */
export function commandsPerTick(layout: RamLayout): number {
  return PHYS_MAX_CMDS + (hasCommandRing(layout) ? commandRingMax(layout) : 0);
}

/** Read (and clear) the ring's commands (`max`: the core's ring capacity). */
export function takeRingCommands(ring: DataView, max = Math.floor((ring.byteLength - 4) / PHYS_CMD_BYTES)): PhysicsCommand[] {
  return takeCommandsAt(ring, 0, max);
}

/** Empty the ring (at load, before the cart's first tick). */
export function resetCommandRing(ring: DataView): void {
  ring.setInt32(0, 0, true);
}

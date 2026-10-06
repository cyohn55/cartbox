/**
 * The overflow command ring (ENGINE_PARITY_ROADMAP.md EP20): lifting the
 * Modern tier's cap on what a cart can ask of the 3D engine in one tick.
 *
 * Every cartbox call that changes the scene (place, spawn, play, sound, burst,
 * a physics impulse…) is a command the cart's Lua writes for the host. The
 * runtime block (protocol.ts) holds 64 a tick — on every core, where its 8 KB
 * has to fit in the smallest free RAM. The HD core behind the Modern and Xbox
 * 360 models has megabytes of free RAM, so there commands past the 64th
 * continue into this ring: 128 KB below the save, input and debug blocks,
 * another 4095 a tick (4159 in all). The cart sees no difference except that
 * its calls stop being dropped; the host reads the block's commands, then the
 * ring's, so their order is kept.
 *
 * A test writes over the region while drawing and checks the engine never
 * touches it (its address is measured against the real HD build).
 */

import { saveBlockAddress, saveBlockBytes } from "../saveSdk.js";
import { PHYS_CMD_BYTES, PHYS_MAX_CMDS, takeCommandsAt, type PhysicsCommand, type RamLayout } from "../physics/protocol.js";

export const CMD_RING_BYTES = 131072;
/** Commands the ring holds a tick (after its count word). */
export const CMD_RING_MAX = Math.floor((CMD_RING_BYTES - 4) / PHYS_CMD_BYTES);

/** Whether a core's free RAM holds the ring: the HD core's 8 MB does. */
export function hasCommandRing(layout: RamLayout): boolean {
  return layout.ramSize >= 8 * 1024 * 1024 && saveBlockBytes(layout) > 0;
}

/** The ring's address in Lua's RAM address space (null on cores without one). */
export function commandRingAddress(layout: RamLayout): number | null {
  return hasCommandRing(layout) ? saveBlockAddress(layout) - CMD_RING_BYTES : null;
}

/** How many commands a cart can issue in one tick on a core. */
export function commandsPerTick(layout: RamLayout): number {
  return PHYS_MAX_CMDS + (hasCommandRing(layout) ? CMD_RING_MAX : 0);
}

/** Read (and clear) the ring's commands. */
export function takeRingCommands(ring: DataView): PhysicsCommand[] {
  return takeCommandsAt(ring, 0, CMD_RING_MAX);
}

/** Empty the ring (at load, before the cart's first tick). */
export function resetCommandRing(ring: DataView): void {
  ring.setInt32(0, 0, true);
}

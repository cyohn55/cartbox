/**
 * Pure input mapping for the `cavestory` catalog runtime.
 *
 * Cave Story runs on NXEngine — a clean-room, GPL reimplementation of Pixel's
 * engine (not a decompilation) — compiled to WebAssembly. Like the other engine
 * runtimes it owns its canvas, main loop and audio inside a same-origin iframe
 * (public/cavestory/cartbox-boot.html); the console only forwards buttons.
 *
 * NXEngine is keyboard-driven, so — like SuperTux and OpenTyrian — the console's
 * buttons map onto keys the engine already reads. NXEngine's defaults
 * (src/input.cpp): arrows move, Z jumps, X fires, A/S switch weapons, Q opens the
 * inventory, Escape pauses. The handheld exposes a d-pad and four face buttons to
 * a game, so this maps the essentials onto them: jump and fire on A/B, and — since
 * inventory is needed to equip items and weapons — inventory on X and weapon-cycle
 * on Y (the player still reaches every weapon by cycling). Keeping the map here,
 * DOM-free, lets it be unit-tested against NXEngine's real bindings.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/**
 * The `KeyboardEvent.code` NXEngine's SDL2 build expects for a given console
 * control, or null when the control is not forwarded to the game (the shell owns
 * Select for eject, and the shoulders/Start for the OS).
 */
const CONTROL_TO_KEY_CODE: Readonly<Record<ConsoleControl, string | null>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  // Jump — the platformer's primary verb — on the primary face button.
  a: "KeyZ",
  // Fire the current weapon.
  b: "KeyX",
  // Open the inventory (equip items, pick a weapon). Chosen over prev-weapon
  // because the player can still reach every weapon by cycling with Y.
  x: "KeyQ",
  // Cycle to the next weapon.
  y: "KeyS",
  // Select ejects the cartridge; Start and the shoulders are OS-owned.
  start: null,
  select: null,
  wheelUp: null,
  wheelDown: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

/**
 * Resolves the NXEngine key for a console control, or null when the control is
 * not forwarded to the game. Pure and total over ConsoleControl.
 */
export function cavestoryKeyForControl(control: ConsoleControl): string | null {
  return CONTROL_TO_KEY_CODE[control] ?? null;
}

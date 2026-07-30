/**
 * Pure input mapping for the `opentyrian` catalog runtime.
 *
 * OpenTyrian2000 is a whole SDL2 application — it owns its canvas, main loop and
 * audio — so it runs inside a same-origin iframe (public/opentyrian/cartbox-boot.html),
 * not the Cartbox Game ABI. Like SuperTux and unlike ScummVM (which needs a
 * virtual cursor), Tyrian is keyboard-driven, so the console's buttons map
 * one-to-one onto the keys the engine already listens for. Keeping that map here,
 * free of any DOM, lets it be unit-tested against the engine's documented defaults.
 *
 * Tyrian's default keyboard controls (README "Keyboard Controls"):
 *   arrow keys = ship movement / menu nav · Space = fire weapons ·
 *   Enter = toggle rear-weapon mode (and confirm menus) ·
 *   Left Ctrl = fire left sidekick · Left Alt = fire right sidekick ·
 *   Escape = pause / open menu / back.
 * Because Space (fire) also advances the intro and Enter confirms menus, binding
 * A to Space and B to Enter drives both gameplay and every menu screen.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/**
 * The `KeyboardEvent.code` OpenTyrian's SDL2 build expects for a given console
 * control, or null when the shell handles the control itself (Select ejects the
 * cartridge; the shoulders and wheel are not used by an arcade shooter).
 */
const CONTROL_TO_KEY_CODE: Readonly<Record<ConsoleControl, string | null>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  // Fire is the shooter's primary verb and also advances the intro/menus, so it
  // belongs on A — the console's primary face button.
  a: "Space",
  // Toggle rear-weapon fire mode; doubles as menu confirm.
  b: "Enter",
  // Left sidekick fire.
  x: "ControlLeft",
  // Right sidekick fire.
  y: "AltLeft",
  // Pause and open the in-game menu; also backs out of menus.
  start: "Escape",
  // Select ejects the cartridge — the OS owns it, never forwarded to the game.
  select: null,
  wheelUp: null,
  wheelDown: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

/**
 * Resolves the OpenTyrian key for a console control, or null when the control is
 * not forwarded to the game. Pure and total over ConsoleControl.
 */
export function opentyrianKeyForControl(control: ConsoleControl): string | null {
  return CONTROL_TO_KEY_CODE[control] ?? null;
}

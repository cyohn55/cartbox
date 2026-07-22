/**
 * Pure input mapping for the SuperTux catalog runtime.
 *
 * SuperTux is a whole SDL3/GLES2 application — it owns its canvas, main loop,
 * audio and (via IDBFS) its saves — so it runs inside a same-origin iframe, not
 * the Cartbox Game ABI. Unlike ScummVM (a point-and-click engine needing a
 * virtual cursor), SuperTux is keyboard-driven, so the console's buttons map
 * one-to-one onto the keys SuperTux already listens for. Keeping that map here,
 * free of any DOM, lets it be unit-tested against SuperTux's real defaults.
 *
 * SuperTux's default keyboard bindings (src/control/keyboard_config.cpp):
 *   arrows = move / menu nav · Space = JUMP · Left Ctrl = ACTION (run+fire) ·
 *   Left Shift = ITEM · Enter = MENU_SELECT · Escape = pause/menu/back.
 * Menus also accept JUMP to confirm (src/gui/menu_manager.cpp), so binding the
 * primary face button to Space operates both gameplay and every menu.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/**
 * The `KeyboardEvent.code` SuperTux's SDL3 build expects for a given console
 * control, or null when the shell handles the control itself (Select ejects the
 * cartridge; the shoulders are not used by a single-player platformer).
 */
const CONTROL_TO_KEY_CODE: Readonly<Record<ConsoleControl, string | null>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  // Jump is the platformer's primary verb and also confirms menus, so it belongs
  // on A — the console's primary face button.
  a: "Space",
  // Run and shoot fireballs.
  b: "ControlLeft",
  // Use / peek held item (kept distinct from run so speedrun tech works).
  x: "ShiftLeft",
  // A second menu-confirm for players who reach for it; harmless in gameplay.
  y: "Enter",
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
 * Resolves the SuperTux key for a console control, or null when the control is
 * not forwarded to the game. Pure and total over ConsoleControl.
 */
export function supertuxKeyForControl(control: ConsoleControl): string | null {
  return CONTROL_TO_KEY_CODE[control] ?? null;
}

/** The default target level set SuperTux boots into (its title-screen world). */
export const SUPERTUX_DEFAULT_TARGET = "";

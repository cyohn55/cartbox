/**
 * Pure input mapping for the `quake` catalog runtime.
 *
 * Quake runs on WebQuake — a pure-JavaScript WebGL reimplementation of the id
 * engine — inside a same-origin iframe (public/quake/cartbox-boot.html). Like the
 * ScummVM / SuperTux / DOS runtimes it owns its canvas, main loop, audio and
 * saves; the console only forwards buttons to it.
 *
 * WebQuake reads the *legacy* `KeyboardEvent.keyCode` (Sys.scantokey in the
 * engine), exactly like the DOS runtime — so each control resolves to a concrete
 * keyCode, and the player forces that keyCode onto the synthetic event. Keeping
 * the map here, free of any DOM, lets it be unit-tested against the keyCodes
 * WebQuake actually recognises.
 *
 * The console forwards only the d-pad and the four face buttons to a game
 * (shoulders, Start and Select are shell-owned and never reach it — Select
 * ejects). Quake needs *menu access* within those buttons or the player is stuck
 * in the boot demo loop, so the four faces are fire, jump, menu and confirm:
 *
 *   d-pad  = move forward/back + turn (Quake's default arrow bindings)
 *   A = fire (Ctrl, +attack)   B = jump (Space, +jump)
 *   X = menu / pause / back (Escape)   Y = confirm / accept (Enter)
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/** A key WebQuake recognises: the legacy `keyCode` it reads, plus a modern `code`. */
export interface QuakeKey {
  code: string;
  keyCode: number;
}

const ARROW_UP: QuakeKey = { code: "ArrowUp", keyCode: 38 };
const ARROW_DOWN: QuakeKey = { code: "ArrowDown", keyCode: 40 };
const ARROW_LEFT: QuakeKey = { code: "ArrowLeft", keyCode: 37 };
const ARROW_RIGHT: QuakeKey = { code: "ArrowRight", keyCode: 39 };
const CTRL: QuakeKey = { code: "ControlLeft", keyCode: 17 };
const SPACE: QuakeKey = { code: "Space", keyCode: 32 };
const ESCAPE: QuakeKey = { code: "Escape", keyCode: 27 };
const ENTER: QuakeKey = { code: "Enter", keyCode: 13 };

/**
 * Console control → the Quake key it drives, or null when the control is not
 * forwarded to the game (the shell owns the shoulders, Start and Select). Total
 * over ConsoleControl so the map is exhaustive and testable.
 */
const CONTROL_TO_KEY: Readonly<Record<ConsoleControl, QuakeKey | null>> = {
  up: ARROW_UP, // +forward
  down: ARROW_DOWN, // +back
  left: ARROW_LEFT, // turn left
  right: ARROW_RIGHT, // turn right
  a: CTRL, // fire
  b: SPACE, // jump / swim up
  x: ESCAPE, // open/close the menu, pause, back out
  y: ENTER, // confirm a menu selection
  l1: null,
  l2: null,
  r1: null,
  r2: null,
  start: null,
  select: null,
};

/**
 * Resolves the Quake key for a console control, or null when the control is not
 * forwarded to the game. Pure and total over ConsoleControl.
 */
export function quakeKeyForControl(control: ConsoleControl): QuakeKey | null {
  return CONTROL_TO_KEY[control] ?? null;
}

/** WebQuake boots to its own attract/menu, so there is no launch target. */
export const QUAKE_DEFAULT_TARGET = "";

/**
 * Pure input mapping for the `dos` catalog runtime (js-dos / DOSBox).
 *
 * A DOS title is a whole real-mode program running inside DOSBox compiled to
 * WebAssembly (js-dos 6.22). Like ScummVM and SuperTux it owns its own canvas
 * and main loop, so it runs in a same-origin iframe rather than the Cartbox
 * Game ABI. The shell forwards console buttons as synthetic key events; this
 * module says which DOS key each button becomes, free of any DOM so it can be
 * unit-tested against the game's real default bindings.
 *
 * DOSBox's Emscripten SDL 1.2 backend keys off the legacy `keyCode`/`which`
 * fields, not the modern `code` string (that is the difference from SuperTux's
 * SDL3 build, which reads `code`). So a mapping here is a *pair*: the `code` for
 * completeness and the numeric `keyCode` DOSBox actually reads. A `code`-only
 * synthetic event is silently ignored by DOSBox — the exact bug this pairing
 * exists to prevent.
 *
 * The bindings target the launch title, C-Dogs. Its Player 1 controls are bound
 * to WASD + Space + Enter by a shipped OPTIONS.CNF rather than to its arrow-key
 * defaults: C-Dogs reads raw scancodes through a custom INT9 handler that
 * mishandles the extended (0xE0-prefixed) codes of the arrow keys, so the arrows
 * come through scrambled, while these non-extended keys are delivered cleanly.
 * The two remappings must agree — see games/cdogs/OPTIONS.CNF. Space = Button 1
 * (fire / menu-select), Enter = Button 2 (weapon / cancel / menu-confirm), Esc =
 * pause. The console reserves Start and Select for the OS (the shell never
 * forwards them), so pause is surfaced on the Y face button instead.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/** A synthetic key: the modern `code` plus the legacy `keyCode` DOSBox reads. */
export interface DosKey {
  code: string;
  keyCode: number;
}

const KEY_W: DosKey = { code: "KeyW", keyCode: 87 };
const KEY_A: DosKey = { code: "KeyA", keyCode: 65 };
const KEY_S: DosKey = { code: "KeyS", keyCode: 83 };
const KEY_D: DosKey = { code: "KeyD", keyCode: 68 };
const SPACE: DosKey = { code: "Space", keyCode: 32 };
const ENTER: DosKey = { code: "Enter", keyCode: 13 };
const ESCAPE: DosKey = { code: "Escape", keyCode: 27 };

/**
 * The DOS key a console control produces, or null when the control is not
 * forwarded to the game. Pure and total over ConsoleControl. The movement and
 * button keys match Player 1's bindings in games/cdogs/OPTIONS.CNF.
 */
const CONTROL_TO_DOS_KEY: Readonly<Record<ConsoleControl, DosKey | null>> = {
  up: KEY_W,
  down: KEY_S,
  left: KEY_A,
  right: KEY_D,
  // Button 1: fire in game, select in menus — the primary verb, so it belongs
  // on A, the console's primary face button.
  a: SPACE,
  // Button 2: change weapon / slide, and cancel / confirm in menus.
  b: ENTER,
  // Automap is on Tab, which the browser reserves for focus traversal, so it is
  // not forwarded; X is left unbound rather than stealing focus from the frame.
  x: null,
  // Pause. Start is reserved by the OS shell (never forwarded), so exposing
  // pause here keeps it reachable from the handheld.
  y: ESCAPE,
  // Nominal pause; the shell reserves Start, so this documents intent more than
  // it fires. Kept so the map is complete over ConsoleControl.
  start: ESCAPE,
  // Select ejects the cartridge — the OS owns it, never forwarded to the game.
  select: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

/**
 * Resolves the DOS key for a console control, or null when the control is not
 * forwarded to the game.
 */
export function dosKeyForControl(control: ConsoleControl): DosKey | null {
  return CONTROL_TO_DOS_KEY[control] ?? null;
}

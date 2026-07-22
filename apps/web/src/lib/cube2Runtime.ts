/**
 * Pure input mapping for the `cube2` catalog runtime.
 *
 * Cube 2: Sauerbraten runs on BananaBread (a WASM+WebGL port of the Cube 2
 * engine) inside a same-origin iframe. Like the other engine runtimes it owns its
 * canvas and loop; the console only forwards buttons.
 *
 * The wrinkle that makes Cube 2 different from Quake: Sauerbraten is *mouse-look
 * only* — it has no keyboard-turn bind (its arrow keys strafe). So the d-pad's
 * left/right cannot be a key; they must synthesize mouse yaw. This map therefore
 * yields a small tagged action per control — a keyboard key, or a turn direction —
 * which Cube2Player realises against the iframe. Keeping it here, free of any DOM,
 * lets it be unit-tested against the engine's binds.
 *
 * The face-button keys line up with the engine's binds: W/S move and SPACE jumps
 * by Sauerbraten default; ESC opens the menu; F (fire) and Q (weapon) are bound at
 * load via BananaBread.execute (see cartbox-boot.html). Only the d-pad and the
 * four face buttons are forwarded — shoulders, Start and Select are shell-owned.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/** What a console control does in Cube 2: press a key, or turn the view. */
export type Cube2Action =
  | { kind: "key"; code: string; keyCode: number }
  | { kind: "turn"; direction: -1 | 1 };

const key = (code: string, keyCode: number): Cube2Action => ({ kind: "key", code, keyCode });

const CONTROL_TO_ACTION: Readonly<Record<ConsoleControl, Cube2Action | null>> = {
  up: key("KeyW", 87), // forward (engine default: bind W forward)
  down: key("KeyS", 83), // backward (bind S backward)
  left: { kind: "turn", direction: -1 }, // yaw left (synthetic mouse)
  right: { kind: "turn", direction: 1 }, // yaw right (synthetic mouse)
  a: key("KeyF", 70), // fire (bound: bind F attack)
  b: key("Space", 32), // jump (bind SPACE jump)
  x: key("Escape", 27), // menu / back
  y: key("KeyQ", 81), // cycle weapon (bound: bind Q weapon)
  l1: null,
  l2: null,
  r1: null,
  r2: null,
  start: null,
  select: null,
  wheelUp: null,
  wheelDown: null,
};

/**
 * Resolves the Cube 2 action for a console control, or null when the control is
 * not forwarded to the game. Pure and total over ConsoleControl.
 */
export function cube2ActionForControl(control: ConsoleControl): Cube2Action | null {
  return CONTROL_TO_ACTION[control] ?? null;
}

/**
 * Pixels of synthetic mouse motion per animation frame while a turn control is
 * held. Tuned for a readable turn speed at the engine's default sensitivity;
 * exported so the player and its test share one source of truth.
 */
export const CUBE2_TURN_PIXELS_PER_FRAME = 12;

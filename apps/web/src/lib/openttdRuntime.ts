/**
 * Pure input mapping for the `openttd` catalog runtime.
 *
 * OpenTTD is a whole SDL2 application — it owns its canvas, main loop and (via
 * IDBFS) its saves — so it runs inside a same-origin iframe
 * (public/openttd/cartbox-boot.html), not the Cartbox Game ABI.
 *
 * Unlike the keyboard-driven engines (SuperTux, OpenTyrian), OpenTTD is a
 * point-and-click transport tycoon with no usable keyboard-only mode: nearly every
 * verb is a mouse click, drag or right-drag on the map. So the console drives an
 * *emulated cursor* — the d-pad nudges a virtual pointer the player realises as
 * synthetic DOM mouse events, exactly the way BananaBread's d-pad synthesises
 * mouse-yaw for Cube 2. This module is the pure half of that: it says what each
 * console control *means* (move the cursor, press a mouse button, zoom, or a key),
 * free of any DOM, so it can be unit-tested. OpenTtdPlayer realises the actions.
 *
 * The scheme, tuned for a handheld:
 *   d-pad        → nudge the cursor (one axis each)
 *   A            → left mouse button (tap = click, hold = drag: lay track, drag-select)
 *   B            → right mouse button (tap = cancel/close, hold + move = scroll the map)
 *   X / wheel-up → zoom in     · Y / wheel-down → zoom out
 *   Start        → Escape (closes the top window)
 *   Select       → the shell ejects the cartridge; never forwarded.
 */

import type { ConsoleControl } from "@/app/console/consoleInput";

/** What a console control does in OpenTTD. */
export type OpenTtdAction =
  | { kind: "move"; axis: "x" | "y"; dir: -1 | 1 } // nudge the emulated cursor
  | { kind: "mouse"; button: 0 | 2 } // press/hold/release a mouse button at the cursor
  | { kind: "wheel"; dir: -1 | 1 } // -1 = zoom in (wheel up), 1 = zoom out (wheel down)
  | { kind: "key"; code: string; keyCode: number };

const CONTROL_TO_ACTION: Readonly<Record<ConsoleControl, OpenTtdAction | null>> = {
  up: { kind: "move", axis: "y", dir: -1 },
  down: { kind: "move", axis: "y", dir: 1 },
  left: { kind: "move", axis: "x", dir: -1 },
  right: { kind: "move", axis: "x", dir: 1 },
  // Left mouse: the primary verb. Held across a d-pad move it drags (track, canals,
  // area selects), so it must be press-on-down / release-on-up, not a synthetic tap.
  a: { kind: "mouse", button: 0 },
  // Right mouse: cancel/close, and right-drag scrolls the viewport.
  b: { kind: "mouse", button: 2 },
  // Zoom on the face buttons and, more naturally, on the physical scroll wheel.
  x: { kind: "wheel", dir: -1 },
  y: { kind: "wheel", dir: 1 },
  wheelUp: { kind: "wheel", dir: -1 },
  wheelDown: { kind: "wheel", dir: 1 },
  // Close the front-most window / abort the current tool.
  start: { kind: "key", code: "Escape", keyCode: 27 },
  // Select ejects the cartridge — the OS owns it, never forwarded to the game.
  select: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

/**
 * Resolves the OpenTTD action for a console control, or null when the control is
 * not forwarded to the game. Pure and total over ConsoleControl.
 */
export function openttdActionForControl(control: ConsoleControl): OpenTtdAction | null {
  return CONTROL_TO_ACTION[control] ?? null;
}

/**
 * Pixels of emulated-cursor motion per animation frame while a d-pad direction is
 * held. Tuned for a readable, controllable pointer on the handheld screen;
 * exported so the player and its test share one source of truth.
 */
export const OPENTTD_CURSOR_PIXELS_PER_FRAME = 7;

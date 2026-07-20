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
 * Bindings are per-bundle: most DOS titles keep their stock arrow-key layout, so
 * a shared default drives the arrow keys and the common shooter verbs; a game
 * gets a bespoke map only when its own bindings need it. C-Dogs does — its
 * Player 1 controls are remapped to WASD + Space + Enter by a shipped OPTIONS.CNF
 * because it reads raw scancodes through a custom INT9 handler that mishandles
 * the extended (0xE0-prefixed) arrow codes, so the arrows come through scrambled
 * while those non-extended keys arrive cleanly. The console reserves Start and
 * Select for the OS (the shell never forwards them), so pause is surfaced on the
 * Y face button instead.
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
const ARROW_UP: DosKey = { code: "ArrowUp", keyCode: 38 };
const ARROW_DOWN: DosKey = { code: "ArrowDown", keyCode: 40 };
const ARROW_LEFT: DosKey = { code: "ArrowLeft", keyCode: 37 };
const ARROW_RIGHT: DosKey = { code: "ArrowRight", keyCode: 39 };
const LEFT_CTRL: DosKey = { code: "ControlLeft", keyCode: 17 };

/** A console control's DOS key, or null when the control is not forwarded. */
type DosControlMap = Readonly<Record<ConsoleControl, DosKey | null>>;

/**
 * Controls the shell always keeps for the OS, never forwarded to any game:
 * Select ejects the cartridge and the analog shoulders are unused by DOS games.
 * Factored out because every per-game map shares it.
 */
const UNFORWARDED: Pick<DosControlMap, "select" | "l1" | "l2" | "r1" | "r2"> = {
  select: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

/**
 * C-Dogs' bindings: Player 1 is remapped to WASD + Space + Enter by a shipped
 * OPTIONS.CNF rather than to its arrow-key defaults, because C-Dogs reads raw
 * scancodes through a custom INT9 handler that mishandles the extended
 * (0xE0-prefixed) arrow codes — so the arrows come through scrambled while these
 * non-extended keys are delivered cleanly. See games/cdogs/OPTIONS.CNF.
 */
const CDOGS_MAP: DosControlMap = {
  up: KEY_W,
  down: KEY_S,
  left: KEY_A,
  right: KEY_D,
  a: SPACE, // Button 1: fire / menu-select
  b: ENTER, // Button 2: weapon / cancel
  x: null, // automap is on Tab, which the browser reserves; left unbound
  y: ESCAPE, // pause (Start is reserved by the shell)
  start: ESCAPE,
  ...UNFORWARDED,
};

/**
 * The default DOS bindings, used by every title that keeps its stock keyboard
 * layout — which is nearly all of them (Wolfenstein 3D and the rest of the id/
 * Apogee shareware). The d-pad drives the arrow keys those games use for both
 * menus and movement; the face buttons cover the common shooter verbs so a
 * single map plays the menu *and* the game:
 *   A = Ctrl (fire), B = Space (open/use), X = Enter (menu confirm), Y = Esc.
 */
const DEFAULT_MAP: DosControlMap = {
  up: ARROW_UP,
  down: ARROW_DOWN,
  left: ARROW_LEFT,
  right: ARROW_RIGHT,
  a: LEFT_CTRL, // primary action: fire
  b: SPACE, // open doors / use / secondary
  x: ENTER, // menu confirm / select
  y: ESCAPE, // menu / pause / back
  start: ESCAPE,
  ...UNFORWARDED,
};

/**
 * The bindings for a DOS bundle. Keyed by bundle id (the part of a dosTarget
 * before the ':'); anything without a bespoke entry gets DEFAULT_MAP. A game
 * earns an entry only when its in-game bindings cannot be driven by the arrow-
 * key default — C-Dogs does, because of its scancode handling.
 */
const CONTROL_MAPS: Readonly<Record<string, DosControlMap>> = {
  cdogs: CDOGS_MAP,
};

/** The DOS control map for a bundle id, falling back to the arrow-key default. */
export function dosControlMap(bundle: string): DosControlMap {
  return CONTROL_MAPS[bundle] ?? DEFAULT_MAP;
}

/**
 * Resolves the DOS key a console control produces for a given bundle, or null
 * when the control is not forwarded to that game.
 */
export function dosKeyForControl(bundle: string, control: ConsoleControl): DosKey | null {
  return dosControlMap(bundle)[control] ?? null;
}

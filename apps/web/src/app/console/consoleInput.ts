/**
 * Handheld input bus. The shell's physical controls (D-pad, A/B/X/Y, Start,
 * Select) publish press/release events here; two kinds of consumers listen:
 *
 *  - Console UI (menus, the feed, tab bar) subscribes for navigation.
 *  - A running cartridge is driven by forwarding controls as synthetic
 *    KeyboardEvents, because @cartbox/player's KeyboardInput listens on
 *    window by `KeyboardEvent.code` (arrows + Z/X/A/S).
 *
 * The bus itself is DOM-free — the key dispatcher is injected — so the mapping
 * and subscription behavior are unit-testable without a browser.
 */

/** The physical controls on the handheld shell. */
export type ConsoleControl =
  | "up"
  | "down"
  | "left"
  | "right"
  | "a"
  | "b"
  | "x"
  | "y"
  | "start"
  | "select";

export type ConsoleInputPhase = "press" | "release";

export interface ConsoleInputEvent {
  control: ConsoleControl;
  phase: ConsoleInputPhase;
}

export type ConsoleInputListener = (event: ConsoleInputEvent) => void;

/** Dispatches a synthetic key event to whatever the player listens on. */
export type KeyEventDispatcher = (type: "keydown" | "keyup", code: string) => void;

/**
 * Shell control → `KeyboardEvent.code` used by the engine's default bindings
 * (see @cartbox/player DEFAULT_KEY_BINDINGS). Start/Select are system controls
 * with no gamepad bit, so they never forward to a game.
 */
export const CONTROL_KEY_CODES: Readonly<Record<ConsoleControl, string | null>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "KeyZ",
  b: "KeyX",
  x: "KeyA",
  y: "KeyS",
  start: null,
  select: null,
};

/**
 * Default dispatcher: real KeyboardEvents on window (what the player hears).
 * `window` is dereferenced at dispatch time, not creation time, so the bus can
 * be constructed during server-side rendering of the client shell.
 */
export function createWindowKeyDispatcher(): KeyEventDispatcher {
  return (type, code) => {
    window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  };
}

export class ConsoleInputBus {
  private readonly listeners = new Set<ConsoleInputListener>();
  private forwardingToGame = false;

  constructor(private readonly dispatchKey: KeyEventDispatcher) {}

  /**
   * While true, gamepad-mapped controls are also emitted as key events so a
   * mounted cartridge responds. UI listeners still receive every event (the
   * game screen uses Start/Select to pause/exit).
   */
  setGameForwarding(enabled: boolean): void {
    this.forwardingToGame = enabled;
  }

  get isForwardingToGame(): boolean {
    return this.forwardingToGame;
  }

  press(control: ConsoleControl): void {
    this.emit(control, "press");
  }

  release(control: ConsoleControl): void {
    this.emit(control, "release");
  }

  /** Registers a listener; returns its unsubscribe function. */
  subscribe(listener: ConsoleInputListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(control: ConsoleControl, phase: ConsoleInputPhase): void {
    if (this.forwardingToGame) {
      const code = CONTROL_KEY_CODES[control];
      if (code) {
        this.dispatchKey(phase === "press" ? "keydown" : "keyup", code);
      }
    }
    for (const listener of [...this.listeners]) {
      listener({ control, phase });
    }
  }
}

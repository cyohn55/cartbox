/**
 * Input handling. Both sources (keyboard, touch) write into a shared
 * {@link GamepadState} that the run loop samples once per frame as a bitmask.
 *
 * The key-binding lookup is a pure function so it can be unit-tested without a DOM.
 */

import { ConsoleButton } from "./types.js";

/**
 * Default keyboard layout, matching TIC-80 conventions: arrows for the D-pad,
 * Z/X for A/B, A/S for X/Y. Keyed by `KeyboardEvent.code` so it is layout-independent.
 */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<string, ConsoleButton>> = {
  ArrowUp: ConsoleButton.Up,
  ArrowDown: ConsoleButton.Down,
  ArrowLeft: ConsoleButton.Left,
  ArrowRight: ConsoleButton.Right,
  KeyZ: ConsoleButton.A,
  KeyX: ConsoleButton.B,
  KeyA: ConsoleButton.X,
  KeyS: ConsoleButton.Y,
};

/**
 * Resolves a physical key to a console button, or undefined if unbound.
 * Pure — no DOM access — so callers and tests can use it freely.
 */
export function resolveButton(
  keyCode: string,
  bindings: Readonly<Record<string, ConsoleButton>> = DEFAULT_KEY_BINDINGS,
): ConsoleButton | undefined {
  return bindings[keyCode];
}

/**
 * Holds the current pressed/released state of every button as a bitmask.
 * Bit N (see {@link ConsoleButton}) is set while that button is held.
 */
export class GamepadState {
  private mask = 0;

  press(button: ConsoleButton): void {
    this.mask |= 1 << button;
  }

  release(button: ConsoleButton): void {
    this.mask &= ~(1 << button);
  }

  /** The engine-facing bitmask for player one. */
  get value(): number {
    return this.mask;
  }

  reset(): void {
    this.mask = 0;
  }
}

/** Translates keyboard events into {@link GamepadState} changes. */
export class KeyboardInput {
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onKeyUp: (event: KeyboardEvent) => void;

  constructor(
    private readonly target: Window,
    state: GamepadState,
    bindings: Readonly<Record<string, ConsoleButton>> = DEFAULT_KEY_BINDINGS,
  ) {
    this.onKeyDown = (event) => {
      const button = resolveButton(event.code, bindings);
      if (button !== undefined) {
        state.press(button);
        event.preventDefault(); // stop arrow keys from scrolling the page
      }
    };
    this.onKeyUp = (event) => {
      const button = resolveButton(event.code, bindings);
      if (button !== undefined) {
        state.release(button);
      }
    };

    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
  }

  destroy(): void {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
  }
}

/**
 * Renders an on-screen D-pad and face buttons for touch devices and maps
 * touches to {@link GamepadState}. Layout is intentionally minimal; styling is
 * left to the host via the `data-cbx-*` attributes on the generated elements.
 */
export class TouchInput {
  private readonly root: HTMLElement;

  constructor(container: HTMLElement, state: GamepadState) {
    const doc = container.ownerDocument;
    this.root = doc.createElement("div");
    this.root.setAttribute("data-cbx-touch", "");

    const directions: Array<[string, ConsoleButton]> = [
      ["↑", ConsoleButton.Up],
      ["↓", ConsoleButton.Down],
      ["←", ConsoleButton.Left],
      ["→", ConsoleButton.Right],
    ];
    const actions: Array<[string, ConsoleButton]> = [
      ["A", ConsoleButton.A],
      ["B", ConsoleButton.B],
    ];

    for (const [label, button] of [...directions, ...actions]) {
      this.root.appendChild(this.createButton(doc, label, button, state));
    }
    container.appendChild(this.root);
  }

  private createButton(
    doc: Document,
    label: string,
    button: ConsoleButton,
    state: GamepadState,
  ): HTMLButtonElement {
    const element = doc.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.setAttribute("data-cbx-button", ConsoleButton[button]);

    const press = (event: Event) => {
      event.preventDefault(); // suppress synthetic mouse events + scrolling
      state.press(button);
    };
    const release = (event: Event) => {
      event.preventDefault();
      state.release(button);
    };

    element.addEventListener("touchstart", press, { passive: false });
    element.addEventListener("touchend", release);
    element.addEventListener("touchcancel", release);
    return element;
  }

  destroy(): void {
    this.root.remove();
  }
}

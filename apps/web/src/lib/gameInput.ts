/**
 * Input mapping for the `wasm-app` runtime.
 *
 * The console's controls are a fixed set of buttons; a ported game receives them
 * as a bitmask through `cartbox_set_input`. Mapping lives here rather than in the
 * player component so it can be tested directly and reused by the handheld shell,
 * which feeds the same buttons from on-screen controls rather than a keyboard.
 *
 * The bit values must match the BUTTON_* defines in games/reference/main.c.
 */

export const BUTTON_BITS = {
  up: 0x01,
  down: 0x02,
  left: 0x04,
  right: 0x08,
  a: 0x10,
  b: 0x20,
  start: 0x40,
  select: 0x80,
  x: 0x100,
  y: 0x200,
} as const;

export type ButtonName = keyof typeof BUTTON_BITS;

export type KeyBindings = Readonly<Record<string, ButtonName>>;

/**
 * Desktop bindings. Arrows and WASD both drive the d-pad because players expect
 * either when a game is shown on a normal page.
 */
export const DESKTOP_KEY_BINDINGS: KeyBindings = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
  KeyZ: "a",
  KeyX: "b",
  Space: "a",
  Enter: "start",
  ShiftLeft: "select",
  ShiftRight: "select",
};

/**
 * Bindings for the handheld shell, which forwards its physical buttons as
 * synthetic key events using the player package's DEFAULT_KEY_BINDINGS.
 *
 * WASD is deliberately absent: the shell sends KeyA for its X button and KeyS
 * for Y, so honouring the desktop table here would make pressing X walk the
 * player left. Matching the shell's own table is what keeps the buttons meaning
 * what they are labelled.
 */
export const CONSOLE_KEY_BINDINGS: KeyBindings = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyZ: "a",
  KeyX: "b",
  KeyA: "x",
  KeyS: "y",
};

/** The button a physical key drives, or undefined when the key is unbound. */
export function buttonForKey(
  code: string,
  bindings: KeyBindings = DESKTOP_KEY_BINDINGS,
): ButtonName | undefined {
  return bindings[code];
}

/**
 * Keys the runtime consumes. The player component suppresses the browser's
 * default for exactly these — arrow keys scroll the page otherwise, which makes
 * a game unplayable — and leaves every other key alone so browser shortcuts and
 * assistive technology keep working.
 */
export function isBoundKey(code: string, bindings: KeyBindings = DESKTOP_KEY_BINDINGS): boolean {
  return code in bindings;
}

/**
 * A set of held buttons, kept as an explicit value rather than mutable state so
 * frames are reproducible and the mapping is testable without a DOM.
 */
export class ButtonState {
  #held = new Set<ButtonName>();

  press(button: ButtonName): void {
    this.#held.add(button);
  }

  release(button: ButtonName): void {
    this.#held.delete(button);
  }

  /** Clears everything — used on blur, so a held key does not stick. */
  releaseAll(): void {
    this.#held.clear();
  }

  isHeld(button: ButtonName): boolean {
    return this.#held.has(button);
  }

  /** The bitmask handed to `cartbox_set_input`. */
  mask(): number {
    let mask = 0;
    for (const button of this.#held) {
      mask |= BUTTON_BITS[button];
    }
    return mask;
  }
}

/** Decodes a mask back into button names. Used by tests and input debugging. */
export function buttonsFromMask(mask: number): ButtonName[] {
  return (Object.keys(BUTTON_BITS) as ButtonName[]).filter(
    (button) => (mask & BUTTON_BITS[button]) !== 0,
  );
}

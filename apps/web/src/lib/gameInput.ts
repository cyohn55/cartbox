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
} as const;

export type ButtonName = keyof typeof BUTTON_BITS;

/**
 * Keyboard bindings. Arrows and WASD both drive the d-pad because players expect
 * either, and neither is more "correct" on a console shell shown in a browser.
 */
const KEY_BINDINGS: Record<string, ButtonName> = {
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

/** The button a physical key drives, or undefined when the key is unbound. */
export function buttonForKey(code: string): ButtonName | undefined {
  return KEY_BINDINGS[code];
}

/**
 * Keys the runtime consumes. The player component suppresses the browser's
 * default for exactly these — arrow keys scroll the page otherwise, which makes
 * a game unplayable — and leaves every other key alone so browser shortcuts and
 * assistive technology keep working.
 */
export function isBoundKey(code: string): boolean {
  return code in KEY_BINDINGS;
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

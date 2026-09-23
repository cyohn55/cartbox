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

/** One on-screen control: which console button it drives and where it sits. */
export interface TouchControl {
  readonly button: ConsoleButton;
  /** Big glyph on the button. */
  readonly label: string;
  /** Small keyboard-equivalent hint under the glyph (empty for the D-pad). */
  readonly hint: string;
  readonly cluster: "dpad" | "face";
  /** Grid cell inside its cluster's 3x3 grid (1-based column/row). */
  readonly col: number;
  readonly row: number;
}

/**
 * The on-screen gamepad layout: a D-pad bottom-left and an Xbox-style diamond of
 * face buttons bottom-right. All eight console buttons are present, so a cart
 * that uses X/Y (strafe, swap, ...) is fully playable on a phone or tablet.
 * Pure data so it can be unit-tested without a DOM.
 */
export const TOUCH_LAYOUT: readonly TouchControl[] = [
  { button: ConsoleButton.Up, label: "\u25B2", hint: "", cluster: "dpad", col: 2, row: 1 },
  { button: ConsoleButton.Left, label: "\u25C0", hint: "", cluster: "dpad", col: 1, row: 2 },
  { button: ConsoleButton.Right, label: "\u25B6", hint: "", cluster: "dpad", col: 3, row: 2 },
  { button: ConsoleButton.Down, label: "\u25BC", hint: "", cluster: "dpad", col: 2, row: 3 },
  { button: ConsoleButton.Y, label: "Y", hint: "S", cluster: "face", col: 2, row: 1 },
  { button: ConsoleButton.X, label: "X", hint: "A", cluster: "face", col: 1, row: 2 },
  { button: ConsoleButton.B, label: "B", hint: "X", cluster: "face", col: 3, row: 2 },
  { button: ConsoleButton.A, label: "A", hint: "Z", cluster: "face", col: 2, row: 3 },
];

/**
 * Whether a device can take touch input at all. Deliberately broader than
 * "the primary pointer is coarse": an iPad in a keyboard/trackpad case reports a
 * *fine* primary pointer yet is still a touchscreen, and it has no gamepad -- it
 * must still get the on-screen controls.
 */
export function hasTouchSupport(maxTouchPoints: number, coarsePointer: boolean): boolean {
  return maxTouchPoints > 0 || coarsePointer;
}

/**
 * Renders an on-screen gamepad (D-pad + A/B/X/Y) over the player and maps presses
 * to {@link GamepadState}. Styled inline so it works in any host page without a
 * stylesheet, and driven by pointer events so fingers, pens, trackpad taps and
 * mouse clicks all work; each control tracks its own pointers, so multi-touch
 * (move while firing) behaves. The `data-cbx-*` attributes stay available for
 * hosts that want to restyle it.
 */
export class TouchInput {
  private readonly root: HTMLElement;
  private readonly restorePosition: (() => void) | null = null;

  constructor(container: HTMLElement, state: GamepadState) {
    const doc = container.ownerDocument;
    const view = doc.defaultView;

    // The pad is absolutely positioned over the game, so its container must be a
    // containing block. Only touch the style when it is not already one.
    if (view && view.getComputedStyle(container).position === "static") {
      const previous = container.style.position;
      container.style.position = "relative";
      this.restorePosition = () => {
        container.style.position = previous;
      };
    }

    this.root = doc.createElement("div");
    this.root.setAttribute("data-cbx-touch", "");
    Object.assign(this.root.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none", // only the buttons catch input; the game stays visible
      zIndex: "5",
      userSelect: "none",
      webkitUserSelect: "none",
    } satisfies Partial<CSSStyleDeclaration>);

    const cluster = (side: "left" | "right"): HTMLElement => {
      const el = doc.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        bottom: "4%",
        [side]: "3%",
        display: "grid",
        gridTemplateColumns: "repeat(3, clamp(40px, 8vmin, 68px))",
        gridTemplateRows: "repeat(3, clamp(40px, 8vmin, 68px))",
        gap: "4px",
      });
      this.root.appendChild(el);
      return el;
    };
    const dpad = cluster("left");
    const face = cluster("right");

    for (const control of TOUCH_LAYOUT) {
      (control.cluster === "dpad" ? dpad : face).appendChild(this.createButton(doc, control, state));
    }
    container.appendChild(this.root);
  }

  private createButton(doc: Document, control: TouchControl, state: GamepadState): HTMLButtonElement {
    const element = doc.createElement("button");
    element.type = "button";
    element.setAttribute("data-cbx-button", ConsoleButton[control.button]);
    element.setAttribute("aria-label", `${ConsoleButton[control.button]} button`);
    const round = control.cluster === "face";
    Object.assign(element.style, {
      gridColumn: String(control.col),
      gridRow: String(control.row),
      pointerEvents: "auto",
      touchAction: "none", // no scroll / zoom / double-tap-zoom while playing
      webkitTouchCallout: "none",
      webkitTapHighlightColor: "transparent",
      margin: "0",
      padding: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: round ? "50%" : "10px",
      border: "2px solid rgba(255,255,255,0.45)",
      background: "rgba(20,26,40,0.45)",
      color: "rgba(255,255,255,0.92)",
      font: "700 clamp(14px, 3vmin, 22px)/1 system-ui, sans-serif",
      cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    element.textContent = control.label;
    if (control.hint) {
      const hint = doc.createElement("span");
      hint.textContent = control.hint;
      Object.assign(hint.style, { font: "500 10px/1 system-ui, sans-serif", opacity: "0.6", marginTop: "2px" });
      element.appendChild(hint);
    }

    // Count the pointers holding this control so a second finger lifting off does
    // not release a button the first finger still holds.
    const held = new Set<number>();
    const setVisual = (down: boolean) => {
      element.style.background = down ? "rgba(92,208,255,0.55)" : "rgba(20,26,40,0.45)";
    };
    const press = (event: PointerEvent) => {
      event.preventDefault();
      held.add(event.pointerId);
      try {
        element.setPointerCapture(event.pointerId); // keep the press if the finger drifts
      } catch {
        // Synthetic/unsupported pointers: the plain press still works.
      }
      state.press(control.button);
      setVisual(true);
    };
    const release = (event: PointerEvent) => {
      if (!held.delete(event.pointerId)) return;
      if (held.size === 0) {
        state.release(control.button);
        setVisual(false);
      }
    };
    element.addEventListener("pointerdown", press);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
    element.addEventListener("contextmenu", (event) => event.preventDefault()); // iOS long-press callout
    return element;
  }

  destroy(): void {
    this.root.remove();
    this.restorePosition?.();
  }
}
